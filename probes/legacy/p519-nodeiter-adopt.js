// p519 — NodeIterator/TreeWalker filter re-entrancy + adoptNode
//
// NodeIterator::acceptNode runs user-supplied filter synchronously.
// During the filter callback, JS can:
// 1. Remove the candidate node (nodeWillBeRemoved adjusts position)
// 2. adoptNode the iterator's root to another document
// 3. Move the iterator's reference node to another document
// 4. Create/destroy shadow roots changing the tree shape
//
// The nodeWillBeRemoved callback (NodeIterator.cpp) tries to adjust
// m_candidateNode and m_referenceNode, but cross-document adoption
// may not trigger this callback (different document's node removal hooks).
//
// Beacon prefix: V519-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V519-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  var testArea = document.createElement('div');
  testArea.id = 'v519-area';
  testArea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden';
  document.body.appendChild(testArea);

  // T1: Basic NodeIterator filter mutation
  try {
    B('T1-START', 'filter removes nodes ahead');
    var t1log = [];

    var container = document.createElement('div');
    var nodes = [];
    for (var i = 0; i < 30; i++) {
      var el = document.createElement('div');
      el.textContent = 'item-' + i;
      el.setAttribute('data-idx', i);
      container.appendChild(el);
      nodes.push(el);
    }
    testArea.appendChild(container);

    var filterCalls = 0;
    var iter = document.createNodeIterator(container, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function(node) {
        filterCalls++;
        var idx = parseInt(node.getAttribute('data-idx'));

        if (idx === 5) {
          // Remove nodes 10-19 while filter is running
          for (var r = 10; r < 20; r++) {
            if (nodes[r].parentNode) nodes[r].parentNode.removeChild(nodes[r]);
          }
          t1log.push('removed-10-thru-19');
        }

        if (idx === 20) {
          // This node was removed but might still be reachable
          t1log.push('reached-20:parent=' + (node.parentNode ? node.parentNode.tagName : 'null'));
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var visited = [];
    var n;
    while (n = iter.nextNode()) {
      visited.push(n.getAttribute('data-idx'));
    }
    t1log.push('visited:' + visited.join(','));
    t1log.push('filterCalls:' + filterCalls);
    B('T1-DONE', JSON.stringify(t1log));
  } catch(e) {
    B('T1-ERR', e.name + ': ' + e.message);
  }

  // T2: adoptNode root during filter — cross-document move
  setTimeout(function() {
    try {
      B('T2-START', 'adoptNode root during filter');
      var t2log = [];

      var iframe = document.createElement('iframe');
      iframe.srcdoc = '<html><body></body></html>';
      testArea.appendChild(iframe);

      setTimeout(function() {
        try {
          var iframeDoc = iframe.contentDocument;
          if (!iframeDoc) {
            B('T2-DEAD', 'no iframe access');
            return;
          }

          var root2 = document.createElement('div');
          root2.id = 'iter-root';
          for (var i = 0; i < 10; i++) {
            var child = document.createElement('span');
            child.textContent = 'C' + i;
            child.setAttribute('data-idx', i);
            root2.appendChild(child);
          }
          testArea.appendChild(root2);

          var adoptedDuringFilter = false;
          var iter2 = document.createNodeIterator(root2, NodeFilter.SHOW_ELEMENT, {
            acceptNode: function(node) {
              var idx = parseInt(node.getAttribute('data-idx') || '-1');
              if (idx === 3 && !adoptedDuringFilter) {
                adoptedDuringFilter = true;
                t2log.push('adopting-root-to-iframe');
                try {
                  iframeDoc.body.appendChild(iframeDoc.adoptNode(root2));
                  t2log.push('adopted:owner=' + (root2.ownerDocument === iframeDoc ? 'iframe' : 'main'));
                } catch(err) {
                  t2log.push('adopt-err:' + err.message);
                }
              }
              return NodeFilter.FILTER_ACCEPT;
            }
          });

          var visited = [];
          var n;
          try {
            while (n = iter2.nextNode()) {
              visited.push(n.textContent || n.id);
            }
          } catch(e) {
            t2log.push('iter-err:' + e.name + ':' + e.message);
          }

          t2log.push('visited:' + visited.length);
          t2log.push('root-doc:' + (root2.ownerDocument === document ? 'main' : 'iframe'));

          B('T2-DONE', JSON.stringify(t2log));
        } catch(e) {
          B('T2-ERR', e.name + ': ' + e.message);
        }
      }, 200);
    } catch(e) {
      B('T2-ERR', '' + e);
    }
  }, 500);

  // T3: TreeWalker — replace children during filter
  setTimeout(function() {
    try {
      B('T3-START', 'TreeWalker replaceChildren during filter');
      var t3log = [];

      var root3 = document.createElement('div');
      var originals = [];
      for (var i = 0; i < 10; i++) {
        var el = document.createElement('p');
        el.textContent = 'orig-' + i;
        el.setAttribute('data-idx', i);
        root3.appendChild(el);
        originals.push(el);
      }
      testArea.appendChild(root3);

      var replacedChildren = false;
      var walker = document.createTreeWalker(root3, NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(node) {
          var idx = parseInt(node.getAttribute('data-idx') || '-1');
          if (idx === 3 && !replacedChildren) {
            replacedChildren = true;
            // Replace ALL children while walker is mid-traversal
            var newChildren = [];
            for (var j = 0; j < 10; j++) {
              var ne = document.createElement('b');
              ne.textContent = 'new-' + j;
              ne.setAttribute('data-idx', 100 + j);
              newChildren.push(ne);
            }
            root3.replaceChildren.apply(root3, newChildren);
            t3log.push('replaced-all-children');

            // GC pressure
            var gc = [];
            for (var g = 0; g < 3000; g++) gc.push(new ArrayBuffer(128));
            gc = null;
            t3log.push('gc-done');
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      var visited = [];
      var n;
      try {
        while (n = walker.nextNode()) {
          visited.push(n.textContent);
        }
      } catch(e) {
        t3log.push('walk-err:' + e.message);
      }

      t3log.push('visited:' + visited.join(','));
      // Check if originals are detached
      t3log.push('orig3-parent:' + (originals[3].parentNode ? 'attached' : 'detached'));

      B('T3-DONE', JSON.stringify(t3log));
    } catch(e) {
      B('T3-ERR', e.name + ': ' + e.message);
    }
  }, 1200);

  // T4: NodeIterator — insert nodes during backward traversal
  setTimeout(function() {
    try {
      B('T4-START', 'previousNode + insert during filter');
      var t4log = [];

      var root4 = document.createElement('div');
      for (var i = 0; i < 10; i++) {
        var el = document.createElement('span');
        el.textContent = 'B' + i;
        el.setAttribute('data-idx', i);
        root4.appendChild(el);
      }
      testArea.appendChild(root4);

      // First traverse forward to the end
      var iter4 = document.createNodeIterator(root4, NodeFilter.SHOW_ELEMENT);
      while (iter4.nextNode()) {}

      // Now traverse backward with mutations during filter
      var insertedDuring = false;
      var origFilter = iter4.filter;
      // NodeIterator's filter is set at creation — we need a new one
      // Actually let's create a new iterator positioned at end

      var iter4b = document.createNodeIterator(root4, NodeFilter.SHOW_ELEMENT, {
        acceptNode: function(node) {
          var idx = parseInt(node.getAttribute('data-idx') || '-1');
          if (idx === 5 && !insertedDuring) {
            insertedDuring = true;
            // Insert nodes between current position and remaining
            for (var ins = 0; ins < 5; ins++) {
              var newNode = document.createElement('em');
              newNode.textContent = 'INS-' + ins;
              newNode.setAttribute('data-idx', 50 + ins);
              root4.insertBefore(newNode, node);
            }
            t4log.push('inserted-5-before-idx-5');
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      // Forward traverse then backward
      while (iter4b.nextNode()) {}
      var backVisited = [];
      var bn;
      while (bn = iter4b.previousNode()) {
        backVisited.push(bn.textContent);
      }

      t4log.push('back-visited:' + backVisited.length);
      t4log.push('children:' + root4.children.length);

      B('T4-DONE', JSON.stringify(t4log));
    } catch(e) {
      B('T4-ERR', e.name + ': ' + e.message);
    }
  }, 1900);

  // T5: WeakRef tracking of NodeIterator-held nodes
  setTimeout(function() {
    try {
      B('T5-START', 'WeakRef for iterator-held nodes');
      if (typeof WeakRef === 'undefined') {
        B('T5-DEAD', 'no WeakRef');
        return;
      }

      var t5log = [];
      var root5 = document.createElement('div');
      var refs = [];
      for (var i = 0; i < 10; i++) {
        var el = document.createElement('span');
        el.textContent = 'W' + i;
        root5.appendChild(el);
        refs.push(new WeakRef(el));
      }
      testArea.appendChild(root5);

      // Create iterator positioned at node 5
      var iter5 = document.createNodeIterator(root5, NodeFilter.SHOW_ELEMENT);
      for (var i = 0; i <= 5; i++) iter5.nextNode();

      // Remove all children — iterator should keep reference node alive
      root5.innerHTML = '';
      t5log.push('children-removed');

      // GC pressure
      for (var gc = 0; gc < 5; gc++) {
        var garbage = [];
        for (var g = 0; g < 5000; g++) garbage.push(new ArrayBuffer(256));
        garbage = null;
      }

      // Check which nodes survived GC
      var alive = 0;
      for (var i = 0; i < refs.length; i++) {
        if (refs[i].deref()) alive++;
      }
      t5log.push('alive-after-gc:' + alive + '/10');

      // Continue iterating — should the reference node still work?
      try {
        var next = iter5.nextNode();
        t5log.push('next-after-clear:' + (next ? next.textContent : 'null'));
        var prev = iter5.previousNode();
        t5log.push('prev-after-clear:' + (prev ? prev.textContent : 'null'));
      } catch(e) {
        t5log.push('iter-err:' + e.message);
      }

      B('T5-DONE', JSON.stringify(t5log));
    } catch(e) {
      B('T5-ERR', e.name + ': ' + e.message);
    }
  }, 2600);

  setTimeout(function() {
    B('COMPLETE', 'all tests done');
  }, 4000);
})();
