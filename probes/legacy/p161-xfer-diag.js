// p161 — Diagnostic: does structuredClone transfer actually free backing stores?
// After transfer + GC, allocate new buffers of same size and check for reuse
// Beacon prefix: V161-
(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V161-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  var BUF_SZ = 100112;
  var N = 200;

  // Phase 1: Create buffers and fill with marker pattern
  var bufs = new Array(N);
  var markers = [];
  for (var i = 0; i < N; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
    var v = new Uint8Array(bufs[i]);
    // Fill with unique marker per buffer: 0xA0+i for first byte, 0xBB for rest
    v[0] = 0xA0 | (i & 0x0F);
    v[1] = (i >> 4) & 0xFF;
    for (var j = 2; j < 64; j++) v[j] = 0xBB;
    markers.push(v[0]);
  }
  B('SPRAY-' + N);

  // Phase 2: Transfer all buffers via structuredClone
  var xferred = 0;
  for (var i = 0; i < N; i++) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      xferred++;
    } catch(e) {
      B('XFER-ERR-' + e.message.substring(0, 30));
    }
    bufs[i] = null;
  }
  bufs = null;
  B('XFERRED-' + xferred);

  // Phase 3: setTimeout to unwind stack, then aggressive GC
  setTimeout(function() {
    // Aggressive GC: many rounds to ensure clones are collected
    for (var g = 0; g < 30; g++) {
      var junk = [];
      for (var j = 0; j < 100000; j++) junk.push({x: j, y: j * 2});
      junk = null;
    }
    B('GC-30R');

    // Phase 4: Allocate new buffers of same size, check for reuse
    var reused = 0;
    var fresh = 0;
    var reusedMarkers = '';
    for (var i = 0; i < N; i++) {
      var nb = new ArrayBuffer(BUF_SZ);
      var nv = new Uint8Array(nb);

      // Check if any bytes have the marker pattern (0xBB in bytes 2-63)
      var markerCount = 0;
      for (var j = 2; j < 64; j++) {
        if (nv[j] === 0xBB) markerCount++;
      }

      if (markerCount > 30) {
        // This buffer reused a freed backing store
        reused++;
        if (reused <= 5) {
          reusedMarkers += 'B' + i + ':' + nv[0].toString(16) + nv[1].toString(16) + '-M' + markerCount + ' ';
        }
      } else {
        fresh++;
      }
    }

    B('REUSED-' + reused + '-FRESH-' + fresh);
    if (reusedMarkers) B('MARKERS-' + reusedMarkers.trim());

    // Phase 5: Second test — more GC, then more allocations
    for (var g = 0; g < 20; g++) {
      var junk = [];
      for (var j = 0; j < 100000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC2-20R');

    var reused2 = 0;
    for (var i = 0; i < N; i++) {
      var nb = new ArrayBuffer(BUF_SZ);
      var nv = new Uint8Array(nb);
      var markerCount = 0;
      for (var j = 2; j < 64; j++) {
        if (nv[j] === 0xBB) markerCount++;
      }
      if (markerCount > 30) reused2++;
    }
    B('REUSED2-' + reused2);

    // Phase 6: Test with explicit null + WeakRef if available
    var weak = null;
    try {
      var testBuf = new ArrayBuffer(BUF_SZ);
      var testView = new Uint8Array(testBuf);
      for (var j = 0; j < 64; j++) testView[j] = 0xCC;
      var cloneResult = structuredClone(testBuf, {transfer: [testBuf]});
      weak = new WeakRef(cloneResult);
      cloneResult = null;
    } catch(e) {
      B('WEAK-ERR-' + e.message.substring(0, 30));
    }

    setTimeout(function() {
      for (var g = 0; g < 20; g++) {
        var junk = [];
        for (var j = 0; j < 100000; j++) junk.push({x: j});
        junk = null;
      }

      if (weak) {
        var alive = weak.deref() !== undefined;
        B('CLONE-' + (alive ? 'ALIVE' : 'DEAD'));
      }

      // Final: try fastCalloc detection
      var reused3 = 0;
      for (var i = 0; i < 50; i++) {
        var nb = new ArrayBuffer(BUF_SZ);
        var nv = new Uint8Array(nb);
        var anyNonZero = false;
        for (var j = 0; j < 128 && !anyNonZero; j++) {
          if (nv[j] !== 0) anyNonZero = true;
        }
        if (anyNonZero) reused3++;
      }
      B('REUSED3-' + reused3);
      B('DONE');
    }, 500);
  }, 500);
})();
