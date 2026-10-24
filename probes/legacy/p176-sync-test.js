// p176 — Sync XHR self-test. Zero big allocations. 10 seconds max.
// Tests whether synchronous XMLHttpRequest works on PS5 WebKit.
// Beacon prefix: V176-

(function() {
  var BASE = location.protocol + '//' + location.host;

  function asyncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V176-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V176-' + tag + '?t=' + Date.now(), false);
      x.send();
      return 'ok';
    } catch(e) {
      return 'err-' + (e.message || e.name || '').substring(0, 30);
    }
  }

  asyncB('BOOT');

  // Test 1: sync XHR from top-level
  var r1 = syncB('SYNC1-TOP');
  asyncB('R1-' + r1);

  // Test 2: sync XHR from setTimeout
  setTimeout(function() {
    var r2 = syncB('SYNC2-TIMER');
    asyncB('R2-' + r2);

    // Test 3: sync XHR from inside a tight loop (simulates callback)
    var sum = 0;
    for (var i = 0; i < 1000; i++) sum += i;
    var r3 = syncB('SYNC3-LOOP-' + sum);
    asyncB('R3-' + r3);

    // Test 4: sync XHR from inside a function call chain
    function inner() {
      return syncB('SYNC4-INNER');
    }
    function outer() {
      return inner();
    }
    var r4 = outer();
    asyncB('R4-' + r4);

    asyncB('DONE');
  }, 100);
})();
