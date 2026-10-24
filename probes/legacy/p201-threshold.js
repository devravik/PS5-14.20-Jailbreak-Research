// p201 — Find exact call count threshold + void comparison
// Known: 2M works, 5M crashes. Find the cutoff.
// Also: compare void a(); vs a(); at 1M to see if void changes behavior.
//
// Beacon prefix: V201-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V201-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var testQueue = [];
  var currentTest = 0;

  // Each test: {name, count, prefix}
  // Run ONE at a time. If it crashes, the page dies and we know the threshold.
  // Run from smallest to largest so we get maximum data before crash.

  testQueue.push({name: '3M', count: 3000000});
  testQueue.push({name: '4M', count: 4000000});
  // If 4M works, try 4.5M
  testQueue.push({name: '4500K', count: 4500000});
  // void comparison at safe size
  testQueue.push({name: 'VOID-1M', count: 1000000, useVoid: true});

  function runNext() {
    if (currentTest >= testQueue.length) {
      B('ALL-DONE');
      return;
    }

    var t = testQueue[currentTest];
    currentTest++;

    B(t.name + '-BUILD');

    var callStr = t.useVoid ? 'void a();' : 'a();';
    var fnName = '__t' + currentTest;
    var okName = '__ok' + currentTest;

    // Build source
    var CHUNK = 1000000;
    var chunks = Math.floor(t.count / CHUNK);
    var rem = t.count - chunks * CHUNK;
    var chunkStr = callStr.repeat(CHUNK);
    var parts = ['window.' + fnName + '=function(a){'];
    for (var i = 0; i < chunks; i++) parts.push(chunkStr);
    if (rem > 0) parts.push(callStr.repeat(rem));
    parts.push('};window.' + okName + '=1;');
    chunkStr = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B(t.name + '-BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onload = function() {
      var ok = window[okName] ? 'OK' : 'FAIL';
      B(t.name + '-COMPILED-' + ok);
      if (ok !== 'OK') { setTimeout(runNext, 200); return; }

      var fn = window[fnName];
      var c = 0;

      // Small delay before call
      setTimeout(function() {
        B(t.name + '-CALLING');
        try {
          fn(function() {
            c++;
            if (c === 1) B(t.name + '-CB-1');
            if (c > 50) throw 'S';
          });
          B(t.name + '-RET-' + c);
        } catch (e) {
          B(t.name + '-THREW-' + c);
        }

        // Cleanup to free memory for next test
        window[fnName] = null;
        window[okName] = null;
        fn = null;

        // GC pressure to free the old function
        for (var g = 0; g < 100; g++) { var tmp = new ArrayBuffer(65536); tmp = null; }

        setTimeout(runNext, 500);
      }, 100);
    };
    sc.onerror = function() {
      B(t.name + '-SCRIPT-ERR');
      setTimeout(runNext, 200);
    };
    sc.src = URL.createObjectURL(blob);
    document.head.appendChild(sc);
  }

  runNext();
})();
