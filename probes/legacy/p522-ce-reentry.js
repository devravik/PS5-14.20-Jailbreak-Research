// p522-ce-reentry.js — Custom Element constructor re-entrancy during innerHTML parsing
// Tests: CE constructor fires mid-parse, MutationObserver during microtask checkpoint,
// adoptNode/removeChild during CE constructor affecting parser state
(function(){
var B = function(p,b){ try { navigator.sendBeacon('/beacon/V522-'+p, '['+Math.round(performance.now())+'ms] '+b); } catch(e){} };

B('BOOT', navigator.userAgent);

// T1: CE constructor modifies partially-parsed siblings during innerHTML
(function T1(){
  try {
    B('T1-START', 'CE constructor sibling mutation');
    var container = document.createElement('div');
    document.body.appendChild(container);

    var constructorCalls = 0;
    var siblingsSeen = [];
    var mutations = [];

    class MyEl extends HTMLElement {
      constructor() {
        super();
        constructorCalls++;
        // During constructor, check what siblings exist
        var parent = this.parentNode;
        var sibs = parent ? parent.children.length : -1;
        siblingsSeen.push(sibs);

        if (constructorCalls === 2 && parent) {
          // Second CE: try to remove the first CE (already parsed)
          var first = parent.querySelector('my-el');
          if (first && first !== this) {
            try {
              parent.removeChild(first);
              mutations.push('removed-first');
            } catch(e) {
              mutations.push('remove-err:' + e.message.slice(0,30));
            }
          }
        }
      }
    }
    customElements.define('my-el', MyEl);

    // innerHTML with multiple custom elements — parser creates them sequentially
    container.innerHTML = '<div><my-el id="a"></my-el><span>mid</span><my-el id="b"></my-el></div>';

    var aAlive = !!container.querySelector('#a');
    var bAlive = !!container.querySelector('#b');
    B('T1-DONE', 'calls='+constructorCalls+' sibs='+JSON.stringify(siblingsSeen)+' mut='+JSON.stringify(mutations)+' a='+aAlive+' b='+bAlive);
    container.remove();
  } catch(e) { B('T1-ERR', e.message); }
})();

// T2: MutationObserver fires during CE constructor (via microtask checkpoint)
setTimeout(function T2(){
  try {
    B('T2-START', 'MO during CE constructor microtask');
    var container = document.createElement('div');
    document.body.appendChild(container);
    var target = document.createElement('div');
    target.id = 'mo-target';
    container.appendChild(target);

    var moFired = false;
    var moContext = '';
    var mo = new MutationObserver(function(records) {
      moFired = true;
      moContext = 'records='+records.length;
      // During MO callback (which fires during CE constructor microtask checkpoint):
      // Try to modify the container that's being innerHTML'd
      try {
        var victim = document.getElementById('inner-container');
        if (victim) {
          victim.textContent = ''; // clear children during parse
          moContext += ' cleared-inner';
        }
      } catch(e) {
        moContext += ' mo-err:'+e.message.slice(0,30);
      }
    });
    mo.observe(target, { childList: true, subtree: true });

    // Trigger a mutation that MO will observe
    target.appendChild(document.createTextNode('trigger'));

    // Now do innerHTML with a CE — microtask checkpoint during CE construction
    // should deliver the MO callback
    var ceConstructed = false;
    var moWasFiredDuringConstruct = false;

    if (!customElements.get('mo-el')) {
      class MoEl extends HTMLElement {
        constructor() {
          super();
          ceConstructed = true;
          moWasFiredDuringConstruct = moFired;
        }
      }
      customElements.define('mo-el', MoEl);
    }

    var innerContainer = document.createElement('div');
    innerContainer.id = 'inner-container';
    container.appendChild(innerContainer);

    innerContainer.innerHTML = '<mo-el></mo-el><div>after</div>';

    B('T2-DONE', 'ce='+ceConstructed+' moFired='+moFired+' duringCE='+moWasFiredDuringConstruct+' ctx='+moContext);
    mo.disconnect();
    container.remove();
  } catch(e) { B('T2-ERR', e.message); }
}, 500);

// T3: adoptNode during CE constructor — steal element from parser's fragment
setTimeout(function T3(){
  try {
    B('T3-START', 'adoptNode during CE construct');
    var container = document.createElement('div');
    document.body.appendChild(container);
    var otherDoc = document.implementation.createHTMLDocument('other');

    var adopted = null;
    var adoptErr = '';

    if (!customElements.get('adopt-el')) {
      class AdoptEl extends HTMLElement {
        constructor() {
          super();
          // Try to adopt ourselves into another document during construction
          try {
            adopted = otherDoc.adoptNode(this);
            adoptErr = 'adopted-self';
          } catch(e) {
            adoptErr = e.message.slice(0,40);
          }
        }
      }
      customElements.define('adopt-el', AdoptEl);
    }

    container.innerHTML = '<adopt-el></adopt-el><div id="post-adopt">after</div>';

    var postAdopt = container.querySelector('#post-adopt');
    var adoptElInContainer = container.querySelector('adopt-el');
    var adoptElInOther = otherDoc.querySelector('adopt-el');

    B('T3-DONE', 'err='+adoptErr+' adopted='+!!adopted+' inContainer='+!!adoptElInContainer+' inOther='+!!adoptElInOther+' post='+!!postAdopt);
    container.remove();
  } catch(e) { B('T3-ERR', e.message); }
}, 1200);

// T4: setAttribute during CE attributeChangedCallback triggers re-entrant parse
setTimeout(function T4(){
  try {
    B('T4-START', 'attributeChanged reentry');
    var container = document.createElement('div');
    document.body.appendChild(container);

    var callbackCount = 0;
    var callbackOrder = [];

    if (!customElements.get('attr-el')) {
      class AttrEl extends HTMLElement {
        static get observedAttributes() { return ['data-x', 'data-y']; }
        attributeChangedCallback(name, old, val) {
          callbackCount++;
          callbackOrder.push(name + '=' + val);
          if (name === 'data-x' && callbackCount < 5) {
            // Re-entrant: setting data-y during data-x callback
            this.setAttribute('data-y', 'from-x-' + callbackCount);
          }
        }
      }
      customElements.define('attr-el', AttrEl);
    }

    container.innerHTML = '<attr-el data-x="1" data-y="2"></attr-el>';

    B('T4-DONE', 'callbacks='+callbackCount+' order='+JSON.stringify(callbackOrder));
    container.remove();
  } catch(e) { B('T4-ERR', e.message); }
}, 2000);

// T5: CE constructor + WeakRef + FinalizationRegistry — check if parser intermediate
// objects can be collected during constructor
setTimeout(function T5(){
  try {
    B('T5-START', 'CE constructor GC probe');
    var container = document.createElement('div');
    document.body.appendChild(container);

    var refs = [];
    var collected = 0;
    var fr = new FinalizationRegistry(function(val) { collected++; });

    if (!customElements.get('gc-el')) {
      class GcEl extends HTMLElement {
        constructor() {
          super();
          // Create many objects and register them with FR
          for (var i = 0; i < 50; i++) {
            var obj = { idx: i };
            refs.push(new WeakRef(obj));
            fr.register(obj, i);
          }
          // Force GC pressure during constructor
          var pressure = [];
          for (var j = 0; j < 1000; j++) {
            pressure.push(new ArrayBuffer(1024));
          }
          // Check how many WeakRefs are still alive
          var alive = 0;
          for (var k = 0; k < refs.length; k++) {
            if (refs[k].deref()) alive++;
          }
          B('T5-MID', 'alive='+alive+'/'+refs.length+' collected='+collected);
        }
      }
      customElements.define('gc-el', GcEl);
    }

    container.innerHTML = '<gc-el></gc-el>';

    // Check after parse
    setTimeout(function() {
      var aliveAfter = 0;
      for (var k = 0; k < refs.length; k++) {
        if (refs[k].deref()) aliveAfter++;
      }
      B('T5-DONE', 'aliveAfter='+aliveAfter+' collected='+collected);
      container.remove();
    }, 500);
  } catch(e) { B('T5-ERR', e.message); }
}, 3000);

// T6: Range spanning custom element during construction
setTimeout(function T6(){
  try {
    B('T6-START', 'Range across CE construction');
    var container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = '<div id="range-parent"><span id="before">A</span></div>';

    var rangeParent = container.querySelector('#range-parent');
    var range = document.createRange();
    range.selectNodeContents(rangeParent);

    var rangeState = '';

    if (!customElements.get('range-el')) {
      class RangeEl extends HTMLElement {
        constructor() {
          super();
          // During constructor, modify the range's parent
          try {
            rangeState = 'startC='+range.startContainer.id+' endC='+range.endContainer.id+' sc='+range.startOffset+' ec='+range.endOffset;
            // Insert nodes that should shift the range
            var newNode = document.createElement('b');
            newNode.textContent = 'injected';
            rangeParent.insertBefore(newNode, rangeParent.firstChild);
            rangeState += ' | after-insert: sc='+range.startOffset+' ec='+range.endOffset+' children='+rangeParent.children.length;
          } catch(e) {
            rangeState = 'err:' + e.message.slice(0,30);
          }
        }
      }
      customElements.define('range-el', RangeEl);
    }

    // Now innerHTML to add a range-el as a child
    rangeParent.innerHTML = '<span>X</span><range-el></range-el><span>Y</span>';

    var finalState = 'sc='+range.startOffset+' ec='+range.endOffset+' children='+rangeParent.children.length;
    B('T6-DONE', 'during=['+rangeState+'] final=['+finalState+']');
    container.remove();
  } catch(e) { B('T6-ERR', e.message); }
}, 4000);

// T7: TreeWalker with custom element that modifies tree during walk
setTimeout(function T7(){
  try {
    B('T7-START', 'TreeWalker + CE mutation');
    var container = document.createElement('div');
    document.body.appendChild(container);

    var walkResults = [];
    var mutationsDone = [];

    // Build initial tree
    container.innerHTML = '<div id="tw-root"><span>1</span><span>2</span><span>3</span></div>';
    var root = container.querySelector('#tw-root');

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function(node) {
        walkResults.push(node.tagName + ':' + (node.textContent||'').slice(0,5));

        // When we see the second span, innerHTML the root with a custom element
        if (walkResults.length === 2) {
          try {
            root.innerHTML = '<tw-el></tw-el><span>new</span>';
            mutationsDone.push('replaced-children');
          } catch(e) {
            mutationsDone.push('err:'+e.message.slice(0,20));
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    if (!customElements.get('tw-el')) {
      class TwEl extends HTMLElement {
        constructor() {
          super();
          mutationsDone.push('tw-el-constructed');
        }
      }
      customElements.define('tw-el', TwEl);
    }

    // Walk all nodes
    var count = 0;
    while (walker.nextNode() && count < 20) count++;

    B('T7-DONE', 'walked='+count+' results='+JSON.stringify(walkResults)+' muts='+JSON.stringify(mutationsDone));
    container.remove();
  } catch(e) { B('T7-ERR', e.message); }
}, 5500);

// T8: Redefine existing element tag during innerHTML parse (should fail but test)
setTimeout(function T8(){
  try {
    B('T8-START', 'createElement during parse callback');
    var container = document.createElement('div');
    document.body.appendChild(container);

    var createdDuringParse = [];

    if (!customElements.get('parse-el')) {
      class ParseEl extends HTMLElement {
        constructor() {
          super();
          // During parser CE construction: create more elements dynamically
          try {
            var d = document.createElement('div');
            d.className = 'dynamic';
            createdDuringParse.push(d.tagName);

            // Try to create another custom element instance
            var ce = document.createElement('parse-el');
            createdDuringParse.push('CE:' + (ce instanceof ParseEl));

            // Try document.createDocumentFragment + innerHTML
            var frag = document.createDocumentFragment();
            var wrapper = document.createElement('div');
            frag.appendChild(wrapper);
            wrapper.innerHTML = '<b>nested</b>';
            createdDuringParse.push('frag:' + wrapper.innerHTML);
          } catch(e) {
            createdDuringParse.push('err:' + e.message.slice(0,30));
          }
        }
      }
      customElements.define('parse-el', ParseEl);
    }

    container.innerHTML = '<parse-el></parse-el>';

    B('T8-DONE', 'created='+JSON.stringify(createdDuringParse));
    container.remove();
  } catch(e) { B('T8-ERR', e.message); }
}, 7000);

})();
