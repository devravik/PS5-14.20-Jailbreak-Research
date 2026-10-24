// p523-observer-reentry.js — Observer callback re-entrancy probes
// Tests: ResizeObserver during style recalc, IntersectionObserver during layout,
// CSS animation events + DOM mutation, Selection during input
(function(){
var B = function(p,b){ try { navigator.sendBeacon('/beacon/V523-'+p, '['+Math.round(performance.now())+'ms] '+b); } catch(e){} };

B('BOOT', 'observer re-entrancy probes');

// T1: ResizeObserver callback tries to cause infinite loop / stale pointer
(function T1(){
  try {
    B('T1-START', 'ResizeObserver mutation loop');
    var container = document.createElement('div');
    container.style.cssText = 'width:100px;height:100px;position:absolute;top:0;left:0;';
    document.body.appendChild(container);

    var resizeCount = 0;
    var maxResize = 20;
    var sizeLog = [];

    var ro = new ResizeObserver(function(entries) {
      resizeCount++;
      var entry = entries[0];
      var w = entry.contentRect.width;
      sizeLog.push(Math.round(w));

      if (resizeCount < maxResize) {
        // Trigger another resize during callback — should this loop?
        container.style.width = (w + 10) + 'px';
      }
    });
    ro.observe(container);

    // Trigger first resize
    container.style.width = '200px';

    setTimeout(function() {
      B('T1-DONE', 'resizes='+resizeCount+' sizes='+JSON.stringify(sizeLog.slice(0,10)));
      ro.disconnect();
      container.remove();
    }, 2000);
  } catch(e) { B('T1-ERR', e.message); }
})();

// T2: IntersectionObserver during adoptNode
setTimeout(function T2(){
  try {
    B('T2-START', 'IO + adoptNode');
    var container = document.createElement('div');
    container.style.cssText = 'width:100px;height:100px;overflow:auto;';
    document.body.appendChild(container);

    var target = document.createElement('div');
    target.style.cssText = 'width:50px;height:50px;background:red;';
    target.id = 'io-target';
    container.appendChild(target);

    var otherDoc = document.implementation.createHTMLDocument('other');
    var ioCallbacks = [];

    var io = new IntersectionObserver(function(entries) {
      ioCallbacks.push('intersecting='+entries[0].isIntersecting);

      if (ioCallbacks.length === 1) {
        // During first IO callback: adopt the target into another document
        try {
          otherDoc.body.appendChild(otherDoc.adoptNode(target));
          ioCallbacks.push('adopted');
        } catch(e) {
          ioCallbacks.push('adopt-err:'+e.message.slice(0,20));
        }
      }
    });
    io.observe(target);

    setTimeout(function() {
      B('T2-DONE', 'callbacks='+JSON.stringify(ioCallbacks)+' targetDoc='+(target.ownerDocument===document?'main':'other'));
      io.disconnect();
      container.remove();
    }, 2000);
  } catch(e) { B('T2-ERR', e.message); }
}, 3000);

// T3: CSS animation + MutationObserver + custom element — triple re-entrancy
setTimeout(function T3(){
  try {
    B('T3-START', 'animation + MO + CE triple');
    var container = document.createElement('div');
    document.body.appendChild(container);

    // Add animation keyframes
    var style = document.createElement('style');
    style.textContent = '@keyframes pulse { from { opacity: 1; } to { opacity: 0; } }';
    document.head.appendChild(style);

    var events = [];

    if (!customElements.get('anim-el')) {
      class AnimEl extends HTMLElement {
        connectedCallback() {
          events.push('connected');
          this.style.animation = 'pulse 0.01s forwards';
          this.addEventListener('animationend', function(e) {
            events.push('animend');
            // During animation end: modify DOM
            try {
              var newChild = document.createElement('span');
              newChild.textContent = 'injected-during-anim';
              this.appendChild(newChild);
              events.push('injected');
            } catch(e) {
              events.push('inject-err:'+e.message.slice(0,20));
            }
          });
        }
      }
      customElements.define('anim-el', AnimEl);
    }

    // Set up MO on container
    var moRecords = [];
    var mo = new MutationObserver(function(records) {
      for (var r of records) {
        moRecords.push(r.type+':'+r.addedNodes.length+'a/'+r.removedNodes.length+'r');
      }
    });
    mo.observe(container, { childList: true, subtree: true });

    container.innerHTML = '<anim-el></anim-el>';

    setTimeout(function() {
      B('T3-DONE', 'events='+JSON.stringify(events)+' mo='+JSON.stringify(moRecords)+' children='+container.querySelector('anim-el').children.length);
      mo.disconnect();
      style.remove();
      container.remove();
    }, 1000);
  } catch(e) { B('T3-ERR', e.message); }
}, 6000);

// T4: Selection + contenteditable + MutationObserver
setTimeout(function T4(){
  try {
    B('T4-START', 'Selection + MO during execCommand');
    var container = document.createElement('div');
    container.contentEditable = 'true';
    container.innerHTML = '<p id="p1">Hello</p><p id="p2">World</p>';
    document.body.appendChild(container);
    container.focus();

    var moEvents = [];
    var selEvents = [];

    // Watch for mutations
    var mo = new MutationObserver(function(records) {
      for (var r of records) {
        moEvents.push(r.type + ':' + (r.target.id || r.target.nodeName));
        // During MO callback: try to modify selection
        try {
          var sel = window.getSelection();
          selEvents.push('sel:' + sel.rangeCount + ' ' + (sel.anchorNode ? sel.anchorNode.nodeName : 'null'));
        } catch(e) {
          selEvents.push('sel-err:'+e.message.slice(0,20));
        }
      }
    });
    mo.observe(container, { childList: true, subtree: true, characterData: true });

    // Select all text
    var range = document.createRange();
    range.selectNodeContents(container);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // execCommand — synchronous DOM modification
    var result = document.execCommand('bold', false, null);

    B('T4-DONE', 'cmd='+result+' moEvents='+JSON.stringify(moEvents.slice(0,5))+' selEvents='+JSON.stringify(selEvents.slice(0,3))+' html='+container.innerHTML.slice(0,80));
    mo.disconnect();
    container.remove();
  } catch(e) { B('T4-ERR', e.message); }
}, 9000);

// T5: Ranges that survive tree mutations — check for stale boundary points
setTimeout(function T5(){
  try {
    B('T5-START', 'Range stale boundary');
    var container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = '<div id="rp"><span id="s1">A</span><span id="s2">B</span><span id="s3">C</span></div>';

    var rp = container.querySelector('#rp');
    var s2 = container.querySelector('#s2');

    // Create range around s2
    var range = document.createRange();
    range.setStartBefore(s2);
    range.setEndAfter(s2);

    var before = 'sc='+range.startContainer.id+' so='+range.startOffset+' ec='+range.endContainer.id+' eo='+range.endOffset;

    // Remove s2 — range should adjust
    rp.removeChild(s2);
    var afterRemove = 'sc='+range.startContainer.id+' so='+range.startOffset+' ec='+range.endContainer.id+' eo='+range.endOffset+' collapsed='+range.collapsed;

    // Now try to use range.extractContents on the adjusted range
    var extracted = '';
    try {
      var frag = range.extractContents();
      extracted = 'ok:' + frag.childNodes.length;
    } catch(e) {
      extracted = 'err:' + e.message.slice(0,30);
    }

    B('T5-DONE', 'before=['+before+'] afterRemove=['+afterRemove+'] extract='+extracted);
    container.remove();
  } catch(e) { B('T5-ERR', e.message); }
}, 11000);

// T6: createTreeWalker + connectedCallback removing nodes during walk
setTimeout(function T6(){
  try {
    B('T6-START', 'CE connectedCallback during appendChild');
    var container = document.createElement('div');
    document.body.appendChild(container);

    var events = [];

    if (!customElements.get('hook-el')) {
      class HookEl extends HTMLElement {
        connectedCallback() {
          events.push('connected:' + this.id);
          // Remove all previous siblings when connected
          var prev = this.previousElementSibling;
          while (prev) {
            var toRemove = prev;
            prev = prev.previousElementSibling;
            toRemove.remove();
            events.push('removed:' + toRemove.id);
          }
        }
        disconnectedCallback() {
          events.push('disconnected:' + this.id);
        }
      }
      customElements.define('hook-el', HookEl);
    }

    // Build fragment with multiple hook-els
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 5; i++) {
      var el = document.createElement('hook-el');
      el.id = 'h' + i;
      frag.appendChild(el);
    }

    // Append all at once — connectedCallback fires for each
    container.appendChild(frag);

    B('T6-DONE', 'events='+JSON.stringify(events)+' children='+container.children.length);
    container.remove();
  } catch(e) { B('T6-ERR', e.message); }
}, 13000);

})();
