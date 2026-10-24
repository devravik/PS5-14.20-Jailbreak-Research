// p398 - MEMORY LIMIT TEST: find WebContent process allocation ceiling
//
// Allocates ArrayBuffers in increasing amounts until allocation fails.
// Reports maximum achievable allocation via beacons.
// Also tests: string allocation limit, total combined limit.
//
// Beacon prefix: V398-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V398-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  // Test 1: ArrayBuffer allocation limit (100KB chunks = same size as MetadataTable)
  var abs = [];
  var abTotal = 0;
  var AB_SIZE = 100112;
  var abFail = false;

  while (!abFail) {
    try {
      // Allocate batch of 100 (10MB)
      for (var i = 0; i < 100; i++) {
        abs.push(new ArrayBuffer(AB_SIZE));
        abTotal += AB_SIZE;
      }
      // Report every 50MB
      if (abTotal % (50 * 1048576) < AB_SIZE * 100) {
        B('AB-' + Math.round(abTotal / 1048576) + 'MB');
      }
    } catch(e) {
      abFail = true;
      B('AB-LIMIT-' + Math.round(abTotal / 1048576) + 'MB-' + abs.length + 'BUFS');
    }
  }

  // Free all ABs
  var abMax = abTotal;
  for (var i = 0; i < abs.length; i++) abs[i] = null;
  abs = null;
  B('AB-FREED');

  // GC
  for (var i = 0; i < 50; i++) {
    for (var j = 0; j < 500; j++) new ArrayBuffer(8192);
  }
  B('GC-DONE');

  // Test 2: Large single ArrayBuffer allocation
  var sizes = [256, 512, 768, 1024, 1536, 2048, 3072, 4096];
  for (var si = 0; si < sizes.length; si++) {
    var mb = sizes[si];
    try {
      var big = new ArrayBuffer(mb * 1048576);
      B('BIG-' + mb + 'MB-OK');
      big = null;
    } catch(e) {
      B('BIG-' + mb + 'MB-FAIL');
      break;
    }
  }

  // GC again
  for (var i = 0; i < 50; i++) {
    for (var j = 0; j < 500; j++) new ArrayBuffer(8192);
  }

  // Test 3: Allocate-and-free cycling (how much can we MAP)
  // Allocate 100 * 100KB = 10MB, free, repeat. Pages stay mapped.
  var mapped = 0;
  var cycleFail = false;
  var cycles = 0;

  while (!cycleFail && cycles < 500) {
    try {
      var batch = [];
      for (var i = 0; i < 100; i++) {
        batch.push(new ArrayBuffer(AB_SIZE));
      }
      mapped += 100 * AB_SIZE;
      for (var i = 0; i < 100; i++) batch[i] = null;
      batch = null;
      cycles++;
      if (cycles % 50 === 0) {
        B('CYCLE-' + cycles + '-MAPPED-' + Math.round(mapped / 1048576) + 'MB');
      }
    } catch(e) {
      cycleFail = true;
      B('CYCLE-FAIL-' + cycles + '-MAPPED-' + Math.round(mapped / 1048576) + 'MB');
    }
  }

  B('DONE-ABMAX-' + Math.round(abMax / 1048576) + 'MB-MAPPED-' + Math.round(mapped / 1048576) + 'MB');
})();
