// p199 — Test op_call_ignore_result vs op_call for 38M calls
//
// THEORY (from source analysis):
// op_call allocates ValueProfile (24 bytes per call = 920MB for 38M → OOM)
// op_call_ignore_result has NO ValueProfile → no OOM
// void a(); should emit op_call_ignore_result
//
// Test A: void a(); × 38M (should survive if theory correct)
// Test B: a(),0; × 38M (comma operator, another way to discard result)
// Test C: plain a(); × 38M (known to crash — control)
//
// Also: binary search between 1M (works) and 10M (crashes)
//
// Beacon prefix: V199-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V199-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var N = 38348816;
  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  // ── TEST A: void a(); ──
  B('A-BUILD');
  var callChunkA = 'void a();'.repeat(CHUNK);
  var partsA = new Array(chunksN + 3);
  partsA[0] = 'window.__fnA=function(a){';
  for (var c = 0; c < chunksN; c++) partsA[1 + c] = callChunkA;
  partsA[chunksN + 1] = 'void a();'.repeat(rem);
  partsA[chunksN + 2] = '};window.__okA=1;';
  callChunkA = null;

  var blobA = new Blob(partsA, { type: 'application/javascript' });
  B('A-BLOB-' + Math.round(blobA.size / 1048576) + 'MB');
  partsA = null;

  var urlA = URL.createObjectURL(blobA);
  var scA = document.createElement('script');
  scA.onerror = function() { B('A-SCRIPT-ERR'); runBinarySearch(); };
  scA.onload = function() {
    B('A-COMPILED-' + (window.__okA ? 'OK' : 'FAIL'));
    if (!window.__okA) { runBinarySearch(); return; }

    setTimeout(function() {
      var countA = 0;
      B('A-CALLING');

      function cbA() {
        countA++;
        if (countA === 1) B('A-CB-1');
        else if (countA === 10) B('A-CB-10');
        else if (countA === 100) B('A-CB-100');
        else if (countA === 893) B('A-CB-893');
        else if (countA === 894) B('A-CB-894');
        else if (countA === 1000) B('A-CB-1K');
        else if (countA === 10000) B('A-CB-10K');
        else if (countA === 100000) B('A-CB-100K');
        if (countA > 2000) throw 'STOP';
      }

      try {
        window.__fnA(cbA);
        B('A-RET-' + countA);
      } catch (e) {
        B('A-THREW-' + countA);
      }

      setTimeout(runBinarySearch, 500);
    }, 200);
  };
  document.head.appendChild(scA);
  scA.src = urlA;

  // ── BINARY SEARCH: find threshold between 1M and 10M ──
  function runBinarySearch() {
    B('BIN-START');
    var sizes = [2000000, 5000000, 3000000, 7000000];
    var idx = 0;

    function testSize() {
      if (idx >= sizes.length) { B('BIN-DONE'); return; }
      var sz = sizes[idx];
      idx++;

      B('BIN-' + sz + '-BUILD');
      var src = 'window.__binFn=function(a){' + 'a();'.repeat(sz) + '};window.__binOk=1;';
      try {
        var binBlob = new Blob([src], { type: 'application/javascript' });
        src = null;
        var binUrl = URL.createObjectURL(binBlob);
        var binSc = document.createElement('script');
        binSc.onerror = function() {
          B('BIN-' + sz + '-SCRIPT-ERR');
          setTimeout(testSize, 200);
        };
        binSc.onload = function() {
          B('BIN-' + sz + '-COMPILED');
          var cnt = 0;
          try {
            window.__binFn(function() {
              cnt++;
              if (cnt === 1) B('BIN-' + sz + '-CB-1');
              if (cnt > 100) throw 'STOP';
            });
            B('BIN-' + sz + '-RET-' + cnt);
          } catch (e) {
            B('BIN-' + sz + '-THREW-' + cnt);
          }
          window.__binFn = null;
          window.__binOk = null;
          setTimeout(testSize, 200);
        };
        document.head.appendChild(binSc);
        binSc.src = binUrl;
      } catch (e) {
        B('BIN-' + sz + '-ERR');
        setTimeout(testSize, 200);
      }
    }
    testSize();
  }
})();
