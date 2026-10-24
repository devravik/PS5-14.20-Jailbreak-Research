// p193 — Refined iframe crash isolation
// p192 crashed after R-1-START — the iframe with ResizeObserver +
// MutationObserver + setInterval caused a crash. This probe isolates
// which component is responsible.
//
// Test order (each in isolation):
// A: Plain iframe create + destroy (baseline)
// B: Iframe with setInterval only
// C: Iframe with MutationObserver only
// D: Iframe with ResizeObserver only
// E: Iframe with MutationObserver + setInterval (mutation storm)
// F: Iframe with ResizeObserver + MutationObserver (observer fight)
// G: All three combined (original crash trigger)
//
// Beacon prefix: V193-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V193-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  var tests = [
    {
      name: 'A-PLAIN',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:red;"></div></body></html>'
    },
    {
      name: 'B-INTERVAL',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:red;"></div><script>' +
        'setInterval(function(){document.getElementById("t").setAttribute("data-x",Math.random());},1);' +
        '</script></body></html>'
    },
    {
      name: 'C-MUTOBS',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:red;"></div><script>' +
        'var mo = new MutationObserver(function(muts){' +
        '  for(var m of muts){m.target.style.height=(Math.random()*200)+"px";}' +
        '});' +
        'mo.observe(document.getElementById("t"),{attributes:true});' +
        'document.getElementById("t").setAttribute("data-x","1");' +
        '</script></body></html>'
    },
    {
      name: 'D-RESOBS',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:red;"></div><script>' +
        'var ro = new ResizeObserver(function(entries){' +
        '  for(var e of entries){e.target.style.width=(Math.random()*200)+"px";}' +
        '});' +
        'ro.observe(document.getElementById("t"));' +
        '</script></body></html>'
    },
    {
      name: 'E-MUT-INT',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:red;"></div><script>' +
        'var mo = new MutationObserver(function(muts){' +
        '  for(var m of muts){m.target.style.height=(Math.random()*200)+"px";}' +
        '});' +
        'mo.observe(document.getElementById("t"),{attributes:true});' +
        'setInterval(function(){document.getElementById("t").setAttribute("data-x",Math.random());},1);' +
        '</script></body></html>'
    },
    {
      name: 'F-RES-MUT',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:red;"></div><script>' +
        'var ro = new ResizeObserver(function(entries){' +
        '  for(var e of entries){e.target.style.width=(Math.random()*200)+"px";}' +
        '});' +
        'ro.observe(document.getElementById("t"));' +
        'var mo = new MutationObserver(function(muts){' +
        '  for(var m of muts){m.target.style.height=(Math.random()*200)+"px";}' +
        '});' +
        'mo.observe(document.getElementById("t"),{attributes:true});' +
        '</script></body></html>'
    },
    {
      name: 'G-ALL',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:red;"></div><script>' +
        'var ro = new ResizeObserver(function(entries){' +
        '  for(var e of entries){e.target.style.width=(Math.random()*200)+"px";}' +
        '});' +
        'ro.observe(document.getElementById("t"));' +
        'var mo = new MutationObserver(function(muts){' +
        '  for(var m of muts){m.target.style.height=(Math.random()*200)+"px";}' +
        '});' +
        'mo.observe(document.getElementById("t"),{attributes:true});' +
        'setInterval(function(){document.getElementById("t").setAttribute("data-x",Math.random());},1);' +
        '</script></body></html>'
    }
  ];

  var currentTest = 0;

  function runTest() {
    if (currentTest >= tests.length) {
      syncB('ALL-DONE');
      return;
    }

    var test = tests[currentTest];
    syncB(test.name + '-CREATE');

    var f = document.createElement('iframe');
    f.srcdoc = test.srcdoc;
    document.body.appendChild(f);

    syncB(test.name + '-APPENDED');

    // Wait for iframe to load and scripts to run
    setTimeout(function() {
      syncB(test.name + '-PRE-NAV');

      // Navigate iframe (triggers cleanup)
      try {
        f.srcdoc = '';
      } catch(e) {}

      syncB(test.name + '-POST-NAV');

      // Remove iframe
      setTimeout(function() {
        syncB(test.name + '-PRE-REMOVE');
        f.remove();
        f = null;
        syncB(test.name + '-REMOVED');

        // GC pressure
        for (var g = 0; g < 5000; g++) {
          var t = new ArrayBuffer(64);
        }

        syncB(test.name + '-DONE');

        currentTest++;
        setTimeout(runTest, 100);
      }, 20);
    }, 100);
  }

  runTest();
})();
