// p340 - DOM re-entrancy probe: MutationObserver + Custom Elements + editing
// Tests complex interaction patterns that historically cause UAFs in WebKit
// Beacon prefix: V340-

(function() {
  var BQ = 0;
  function B(tag) {
    try { new Image().src = '/beacon/V340-' + tag + '?t=' + Date.now() + '&q=' + (BQ++); } catch(e) {}
  }

  B('BOOT');

  // Test 1: MutationObserver fires during innerHTML set
  // Observer callback modifies the node being parsed
  try {
    var div1 = document.createElement('div');
    document.body.appendChild(div1);
    var obs1Fired = 0;

    var obs1 = new MutationObserver(function(mutations) {
      obs1Fired++;
      if (obs1Fired <= 3) {
        // Modify the target during parse
        try {
          div1.setAttribute('data-x', 'mut' + obs1Fired);
          if (obs1Fired === 1) {
            // Remove a child that was just added by innerHTML
            if (div1.firstChild) div1.removeChild(div1.firstChild);
          }
        } catch(e) {}
      }
    });
    obs1.observe(div1, {childList: true, subtree: true, attributes: true});

    div1.innerHTML = '<b>A</b><i>B</i><u>C</u><span>D</span><em>E</em>';
    B('T1-FIRED-' + obs1Fired + '-CHILDREN-' + div1.childNodes.length);

    obs1.disconnect();
    div1.remove();
    B('T1-OK');
  } catch(e) { B('T1-ERR-' + e.message.substring(0, 30)); }

  // Test 2: Custom element constructor during innerHTML
  try {
    var ce2State = [];
    var MyEl2 = class extends HTMLElement {
      constructor() {
        super();
        ce2State.push('ctor');
        // Try to access host document during construction
        try {
          var r = document.createRange();
          r.selectNodeContents(document.body);
          ce2State.push('range-ok');
        } catch(e) { ce2State.push('range-err'); }
      }
      connectedCallback() {
        ce2State.push('connected');
        // Mutate sibling during connected callback
        try {
          if (this.nextSibling) {
            this.nextSibling.remove();
            ce2State.push('sibling-removed');
          }
        } catch(e) { ce2State.push('sibling-err'); }
      }
    };
    customElements.define('my-el-2', MyEl2);

    var container2 = document.createElement('div');
    document.body.appendChild(container2);
    container2.innerHTML = '<my-el-2></my-el-2><span>victim1</span><my-el-2></my-el-2><span>victim2</span>';
    B('T2-STATE-' + ce2State.join(','));
    B('T2-CHILDREN-' + container2.childNodes.length);
    container2.remove();
    B('T2-OK');
  } catch(e) { B('T2-ERR-' + e.message.substring(0, 40)); }

  // Test 3: Range manipulation during node removal via MutationObserver
  try {
    var div3 = document.createElement('div');
    document.body.appendChild(div3);
    div3.innerHTML = '<p id="p3a">AAA</p><p id="p3b">BBB</p><p id="p3c">CCC</p>';

    var range3 = document.createRange();
    range3.setStart(div3.childNodes[0].firstChild, 1);
    range3.setEnd(div3.childNodes[2].firstChild, 2);

    var obs3 = new MutationObserver(function() {
      try {
        // Try to use the range that spans the removed node
        var s = range3.toString();
        B('T3-RANGE-IN-OBS-' + s.length);
      } catch(e) { B('T3-RANGE-ERR-' + e.message.substring(0, 30)); }
    });
    obs3.observe(div3, {childList: true, subtree: true});

    // Remove the middle node - range should adjust
    div3.removeChild(div3.childNodes[1]);
    B('T3-AFTER-REMOVE-' + range3.toString().length);

    obs3.disconnect();
    div3.remove();
    B('T3-OK');
  } catch(e) { B('T3-ERR-' + e.message.substring(0, 30)); }

  // Test 4: adoptNode during MutationObserver callback
  try {
    var iframe4 = document.createElement('iframe');
    document.body.appendChild(iframe4);

    var div4 = document.createElement('div');
    document.body.appendChild(div4);
    div4.innerHTML = '<span id="s4a">A</span><span id="s4b">B</span>';

    var obs4 = new MutationObserver(function(mutations) {
      try {
        // Adopt a node into the iframe's document during observation
        var target = div4.firstChild;
        if (target) {
          iframe4.contentDocument.adoptNode(target);
          B('T4-ADOPTED');
        }
      } catch(e) { B('T4-ADOPT-ERR-' + e.message.substring(0, 30)); }
    });
    obs4.observe(div4, {childList: true});

    // Trigger mutation - the callback will adopt a sibling
    div4.appendChild(document.createElement('em'));
    B('T4-CHILDREN-' + div4.childNodes.length);

    obs4.disconnect();
    iframe4.remove();
    div4.remove();
    B('T4-OK');
  } catch(e) { B('T4-ERR-' + e.message.substring(0, 30)); }

  // Test 5: document.execCommand with MutationObserver
  try {
    var div5 = document.createElement('div');
    div5.contentEditable = true;
    document.body.appendChild(div5);
    div5.innerHTML = '<p>Line1</p><p>Line2</p><p>Line3</p>';
    div5.focus();

    var obs5Fired = 0;
    var obs5 = new MutationObserver(function() {
      obs5Fired++;
      if (obs5Fired === 1) {
        try {
          // During the delete command, modify the content
          div5.innerHTML = '<p>Replaced</p>';
          B('T5-REPLACED');
        } catch(e) { B('T5-REPLACE-ERR'); }
      }
    });
    obs5.observe(div5, {childList: true, subtree: true, characterData: true});

    // Select all and delete
    var sel5 = window.getSelection();
    sel5.selectAllChildren(div5);
    try {
      document.execCommand('delete');
      B('T5-DELETE-OK-' + div5.childNodes.length);
    } catch(e) { B('T5-DELETE-ERR-' + e.message.substring(0, 30)); }

    B('T5-OBS-FIRED-' + obs5Fired);
    obs5.disconnect();
    div5.remove();
    B('T5-OK');
  } catch(e) { B('T5-ERR-' + e.message.substring(0, 30)); }

  // Test 6: Custom element with Shadow DOM + slotchange during removal
  try {
    var MySlot6 = class extends HTMLElement {
      constructor() {
        super();
        var shadow = this.attachShadow({mode: 'open'});
        shadow.innerHTML = '<slot></slot>';
        shadow.querySelector('slot').addEventListener('slotchange', function() {
          B('T6-SLOTCHANGE');
          // Try to access the host during slotchange
          try {
            var h = shadow.host;
            if (h && h.parentNode) {
              h.parentNode.insertBefore(document.createElement('hr'), h);
              B('T6-INSERT-DURING-SLOTCHANGE');
            }
          } catch(e) { B('T6-SLOT-ERR-' + e.message.substring(0, 30)); }
        });
      }
    };
    customElements.define('my-slot-6', MySlot6);

    var container6 = document.createElement('div');
    document.body.appendChild(container6);
    container6.innerHTML = '<my-slot-6><span>slotted</span></my-slot-6>';
    B('T6-CREATED-' + container6.childNodes.length);

    // Remove the slotted content to trigger slotchange
    var slotHost = container6.querySelector('my-slot-6');
    if (slotHost && slotHost.firstChild) {
      slotHost.removeChild(slotHost.firstChild);
    }
    B('T6-AFTER-REMOVE-' + container6.childNodes.length);

    container6.remove();
    B('T6-OK');
  } catch(e) { B('T6-ERR-' + e.message.substring(0, 30)); }

  // Test 7: TreeWalker with live DOM modification
  try {
    var div7 = document.createElement('div');
    document.body.appendChild(div7);
    for (var i = 0; i < 20; i++) {
      var p = document.createElement('p');
      p.textContent = 'P' + i;
      div7.appendChild(p);
    }

    var walker = document.createTreeWalker(div7, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function(node) {
        // During filter, remove a sibling
        var idx = parseInt(node.textContent.substring(1));
        if (idx === 5 && node.nextSibling) {
          node.nextSibling.remove();
          B('T7-REMOVED-DURING-FILTER');
        }
        if (idx === 10 && node.parentNode) {
          // More aggressive: remove the walker's current node's parent children
          while (node.parentNode.lastChild !== node) {
            node.parentNode.lastChild.remove();
          }
          B('T7-MASS-REMOVE');
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var count7 = 0;
    try {
      while (walker.nextNode()) count7++;
    } catch(e) { B('T7-WALK-ERR-' + e.message.substring(0, 30)); }
    B('T7-WALKED-' + count7);

    div7.remove();
    B('T7-OK');
  } catch(e) { B('T7-ERR-' + e.message.substring(0, 30)); }

  // Test 8: Proxy as event target with DOM manipulation in handlers
  try {
    var div8 = document.createElement('div');
    document.body.appendChild(div8);
    div8.innerHTML = '<button id="btn8">Click</button>';

    var handler8 = {
      handleEvent: function(e) {
        B('T8-HANDLER');
        // Remove the event target during dispatch
        if (e.target && e.target.parentNode) {
          e.target.parentNode.removeChild(e.target);
          B('T8-TARGET-REMOVED');
        }
        // Try to access event properties after target removal
        try {
          B('T8-PHASE-' + e.eventPhase);
          B('T8-TARGET-' + (e.target ? 'alive' : 'null'));
        } catch(ex) { B('T8-ACCESS-ERR'); }
      }
    };

    div8.addEventListener('click', handler8);
    var btn8 = div8.querySelector('#btn8');
    btn8.addEventListener('click', handler8);

    var ev8 = new MouseEvent('click', {bubbles: true});
    btn8.dispatchEvent(ev8);
    B('T8-AFTER-DISPATCH-' + div8.childNodes.length);
    div8.remove();
    B('T8-OK');
  } catch(e) { B('T8-ERR-' + e.message.substring(0, 30)); }

  B('DONE');
  setTimeout(function() { B('TIMEOUT'); }, 20000);
})();
