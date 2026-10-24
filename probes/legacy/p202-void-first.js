// p202 — void a(); vs a(); comparison at SAFE scale
// 4M crashes, 3M works. Run comparisons at 3M to see if void changes anything.
//
// If void uses op_call_ignore_result (no ValueProfile):
//   3M void = 336MB metadata + 0 VP = 336MB
//   3M plain = 336MB metadata + 72MB VP = 408MB
//   → void should have MORE room
//
// Test: void at 3.5M (between 3M OK and 4M crash)
//   If void 3.5M works but plain 3.5M crashes → void IS different
//   If both crash → void makes no difference → need different approach
//
// Beacon prefix: V202-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V202-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // Test 1: void a(); at 3.5M (between threshold)
  function test1() {
    B('VOID35-BUILD');
    var CHUNK = 1000000;
    var chunkStr = 'void a();'.repeat(CHUNK);
    var parts = ['window.__v35=function(a){'];
    for (var i = 0; i < 3; i++) parts.push(chunkStr);
    parts.push('void a();'.repeat(500000));
    parts.push('};window.__v35ok=1;');
    chunkStr = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('VOID35-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onload = function() {
      B('VOID35-COMPILED-' + (window.__v35ok ? 'OK' : 'FAIL'));
      if (!window.__v35ok) { setTimeout(test2, 200); return; }

      setTimeout(function() {
        var c = 0;
        B('VOID35-CALLING');
        try {
          window.__v35(function() { c++; if (c === 1) B('VOID35-CB-1'); if (c > 50) throw 'S'; });
          B('VOID35-RET-' + c);
        } catch (e) { B('VOID35-THREW-' + c); }
        window.__v35 = null;
        setTimeout(test2, 500);
      }, 100);
    };
    sc.onerror = function() { B('VOID35-ERR'); setTimeout(test2, 200); };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  // Test 2: plain a(); at 3.5M (control — should this crash?)
  function test2() {
    B('PLAIN35-BUILD');
    var CHUNK = 1000000;
    var chunkStr = 'a();'.repeat(CHUNK);
    var parts = ['window.__p35=function(a){'];
    for (var i = 0; i < 3; i++) parts.push(chunkStr);
    parts.push('a();'.repeat(500000));
    parts.push('};window.__p35ok=1;');
    chunkStr = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('PLAIN35-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onload = function() {
      B('PLAIN35-COMPILED-' + (window.__p35ok ? 'OK' : 'FAIL'));
      if (!window.__p35ok) { setTimeout(test3, 200); return; }

      setTimeout(function() {
        var c = 0;
        B('PLAIN35-CALLING');
        try {
          window.__p35(function() { c++; if (c === 1) B('PLAIN35-CB-1'); if (c > 50) throw 'S'; });
          B('PLAIN35-RET-' + c);
        } catch (e) { B('PLAIN35-THREW-' + c); }
        window.__p35 = null;
        setTimeout(test3, 500);
      }, 100);
    };
    sc.onerror = function() { B('PLAIN35-ERR'); setTimeout(test3, 200); };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  // Test 3: void a(); at 4M (plain 4M crashes — does void survive?)
  function test3() {
    B('VOID4M-BUILD');
    var CHUNK = 1000000;
    var chunkStr = 'void a();'.repeat(CHUNK);
    var parts = ['window.__v4=function(a){'];
    for (var i = 0; i < 4; i++) parts.push(chunkStr);
    parts.push('};window.__v4ok=1;');
    chunkStr = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('VOID4M-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onload = function() {
      B('VOID4M-COMPILED-' + (window.__v4ok ? 'OK' : 'FAIL'));
      if (!window.__v4ok) { setTimeout(test4, 200); return; }

      setTimeout(function() {
        var c = 0;
        B('VOID4M-CALLING');
        try {
          window.__v4(function() { c++; if (c === 1) B('VOID4M-CB-1'); if (c > 50) throw 'S'; });
          B('VOID4M-RET-' + c);
        } catch (e) { B('VOID4M-THREW-' + c); }
        window.__v4 = null;
        setTimeout(test4, 500);
      }, 100);
    };
    sc.onerror = function() { B('VOID4M-ERR'); setTimeout(test4, 200); };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  // Test 4: void a(); at 5M (if void4M worked, push further)
  function test4() {
    B('VOID5M-BUILD');
    var CHUNK = 1000000;
    var chunkStr = 'void a();'.repeat(CHUNK);
    var parts = ['window.__v5=function(a){'];
    for (var i = 0; i < 5; i++) parts.push(chunkStr);
    parts.push('};window.__v5ok=1;');
    chunkStr = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('VOID5M-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onload = function() {
      B('VOID5M-COMPILED-' + (window.__v5ok ? 'OK' : 'FAIL'));
      if (!window.__v5ok) { B('ALL-DONE'); return; }

      setTimeout(function() {
        var c = 0;
        B('VOID5M-CALLING');
        try {
          window.__v5(function() { c++; if (c === 1) B('VOID5M-CB-1'); if (c > 50) throw 'S'; });
          B('VOID5M-RET-' + c);
        } catch (e) { B('VOID5M-THREW-' + c); }
        B('ALL-DONE');
      }, 100);
    };
    sc.onerror = function() { B('VOID5M-ERR'); B('ALL-DONE'); };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  test1();
})();
