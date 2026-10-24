// p228 — Test sequencer: run DOM battery first (fast), then MetadataTable (heavy)
//
// Loads p226+p227 first (DOM UAF tests, < 3 seconds total).
// After DOM tests complete, loads p150d (MetadataTable overflow, ~30 seconds).
// This maximizes data per PS5 refresh cycle.
//
// Beacon prefix: V228-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V228-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('SEQ-BOOT');

  // Phase 1: DOM tests already loaded (p226 + p227 scripts before this one)
  // They run synchronously in their IIFEs, so by the time we get here,
  // the sync portions are done. Async parts (setTimeout) are pending.

  // Wait for all async DOM tests to finish (longest is 1.5s in p227 test F)
  setTimeout(function() {
    BS('DOM-PHASE-DONE');

    // Phase 2: Load MetadataTable overflow test
    BS('META-PHASE-START');

    var sc = document.createElement('script');
    sc.onerror = function() { BS('META-LOAD-ERR'); };
    sc.onload = function() { BS('META-LOADED'); };
    sc.src = 'p150d-postcompile-zeroed.js?v=150d';
    document.head.appendChild(sc);
  }, 3000);
})();
