// V401 - Exact virtual address space mapping limit via alloc-free cycling
// Allocates batches of ArrayBuffers then frees them immediately.
// Physical RAM: only ~20MB at a time. Virtual mappings persist (MADV_FREE).
// Reports exact cumulative bytes mapped before OOM.

(function() {
  'use strict';
  var qc = 0;
  function B(m) {
    new Image().src = '/beacon/V401-' + encodeURIComponent(m) + '?t=' + Date.now() + '&q=' + (qc++);
  }

  B('START');

  var AB_SIZE = 100112; // Match MetadataTable allocation size exactly
  var BATCH = 200;      // 200 ABs per batch = ~20MB
  var totalMapped = 0;
  var batchCount = 0;
  var failed = false;

  // Phase 1: Cycle until OOM -- map as much virtual space as possible
  while (!failed) {
    var batch = [];
    try {
      for (var i = 0; i < BATCH; i++) {
        batch.push(new ArrayBuffer(AB_SIZE));
      }
      totalMapped += BATCH * AB_SIZE;
      batchCount++;
      // Free the batch -- physical RAM released, virtual mappings kept
      for (var i = 0; i < batch.length; i++) batch[i] = null;
      batch = null;

      // Report every 50 batches (~1GB)
      if (batchCount % 50 === 0) {
        B('CYCLE-' + Math.round(totalMapped / 1048576) + 'MB-B' + batchCount);
      }
    } catch(e) {
      // OOM hit -- free what we got
      for (var i = 0; i < batch.length; i++) batch[i] = null;
      batch = null;
      failed = true;
      B('CYCLE-OOM-' + Math.round(totalMapped / 1048576) + 'MB-B' + batchCount + '-' + e.message);
    }
  }

  B('CYCLE-TOTAL-' + Math.round(totalMapped / 1048576) + 'MB');

  // Phase 2: After cycling, test how much we can HOLD simultaneously
  // This tells us how much physical RAM is actually free after cycling
  var held = [];
  var heldTotal = 0;
  var holdFail = false;
  while (!holdFail) {
    try {
      for (var i = 0; i < 10; i++) {
        held.push(new ArrayBuffer(AB_SIZE));
        heldTotal += AB_SIZE;
      }
    } catch(e) {
      holdFail = true;
    }
  }
  B('HOLD-AFTER-CYCLE-' + Math.round(heldTotal / 1048576) + 'MB-' + held.length + 'BUFS');

  // Free held buffers
  for (var i = 0; i < held.length; i++) held[i] = null;
  held = null;

  // Phase 3: Single large allocation test (how big can one AB be?)
  var sizes = [256, 512, 768, 1024, 1536, 2048, 3072, 4096];
  for (var si = 0; si < sizes.length; si++) {
    var sz = sizes[si] * 1048576;
    try {
      var big = new ArrayBuffer(sz);
      B('BIG-' + sizes[si] + 'MB-OK');
      big = null;
    } catch(e) {
      B('BIG-' + sizes[si] + 'MB-FAIL');
      break;
    }
  }

  B('DONE');
})();
