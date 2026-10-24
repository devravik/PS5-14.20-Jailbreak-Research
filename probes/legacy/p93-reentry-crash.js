/* p93-reentry-crash — Reproduce p90 crash via re-entrant layout + SVG
 *
 * p92 proved: SVG filters alone don't crash. The p90 crash was from
 * ResizeObserver infinite loop + Custom Element DOM mutation corrupting
 * layout state, then SVG rendering hitting that corrupted state.
 *
 * This probe reproduces the exact p90 sequence to confirm, then
 * systematically isolates which combination triggers the crash.
 *
 * Beacon prefix: V93E-
 */
(function(){
"use strict";
var RUN_ID = "v93e" + Math.random().toString(36).slice(2,12);
var PREFIX = "V93E-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press93-reentry-crash");

/* Helper: SVG via Image (from p92) */
function loadSVGImage(svg, timeout) {
  return new Promise(function(resolve) {
    var blob = new Blob([svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; URL.revokeObjectURL(url); resolve({TIMEOUT:true}); }
    }, timeout || 5000);
    img.onload = function() {
      if (done) return; done = true; clearTimeout(timer);
      try {
        var c = document.createElement('canvas');
        c.width = 200; c.height = 200;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        ctx.getImageData(0, 0, 10, 10);
        resolve({loaded:true, drawn:true, read:true});
      } catch(e) {
        resolve({loaded:true, drawn:true, readErr:e.name});
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = function() {
      if (done) return; done = true; clearTimeout(timer);
      URL.revokeObjectURL(url); resolve({error:true});
    };
    img.src = url;
  });
}

var complexSVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
  '<defs>' +
  '<filter id="f1" x="-100%" y="-100%" width="400%" height="400%">' +
  '<feGaussianBlur stdDeviation="50" result="blur"/>' +
  '<feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 20 -10" in="blur"/>' +
  '</filter>' +
  '<filter id="f2">' +
  '<feTurbulence type="fractalNoise" baseFrequency="0.0001" numOctaves="20"/>' +
  '<feDisplacementMap in="SourceGraphic" scale="9999"/>' +
  '</filter>' +
  '</defs>' +
  '<rect width="100" height="100" filter="url(#f1)" fill="blue"/>' +
  '<circle cx="50" cy="50" r="50" filter="url(#f2)" fill="green"/>' +
  '<path d="M -999999 -999999 L 999999 999999 Z" fill="red" opacity="0.1"/>' +
  '</svg>';

/* ====== E1: ResizeObserver infinite loop THEN SVG (exact p90 sequence) ====== */
function test_E1() {
  B("E1-START", "begin");
  var r = {};

  // Step 1: ResizeObserver infinite loop (p90 R1)
  var container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;width:100px;height:100px;';
  document.body.appendChild(container);
  var child = document.createElement('div');
  child.style.cssText = 'width:50px;height:50px;';
  container.appendChild(child);

  var callbackCount = 0;
  var observer = new ResizeObserver(function(entries) {
    callbackCount++;
    if (callbackCount > 20) {
      observer.disconnect();
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var target = entries[i].target;
      var w = entries[i].contentRect.width;
      target.style.width = (w + 10) + 'px';
      var tmp = document.createElement('span');
      tmp.textContent = 'x';
      target.appendChild(tmp);
      target.removeChild(tmp);
    }
  });
  observer.observe(child);
  child.style.width = '60px';
  child.offsetWidth;

  // Step 2: After ResizeObserver settles, load SVG via Image
  setTimeout(function() {
    observer.disconnect();
    r.roCallbacks = callbackCount;
    B("E1-RO-DONE", {callbacks: callbackCount});

    // Now trigger SVG rendering (p90 R4)
    loadSVGImage(complexSVG, 8000).then(function(svgR) {
      r.svg = svgR;
      r.SURVIVED = true;
      container.remove();
      B("E1-SVG-AFTER-RO", r);
    });
  }, 1500);
}

/* ====== E2: Custom Element upgrade + ResizeObserver + SVG ====== */
function test_E2() {
  B("E2-START", "begin");
  var r = {};

  // Step 1: Custom Element that mutates DOM during parse (p90 R2)
  var tagName = 'evil2-' + RUN_ID.slice(0,6);
  class Evil2 extends HTMLElement {
    constructor() {
      super();
      if (this.parentNode) {
        var sibs = this.parentNode.children;
        for (var i = sibs.length - 1; i >= 0; i--) {
          if (sibs[i] !== this && sibs[i].tagName === 'SPAN') {
            this.parentNode.removeChild(sibs[i]);
          }
        }
      }
    }
    connectedCallback() {
      var s = document.createElement('span');
      s.textContent = 'injected';
      if (this.parentNode) this.parentNode.appendChild(s);
    }
  }
  customElements.define(tagName, Evil2);

  var container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;width:200px;';
  document.body.appendChild(container);

  container.innerHTML = '<span>a</span><' + tagName + '></' + tagName +
    '><span>b</span><' + tagName + '></' + tagName + '><span>c</span>';
  r.ceChildren = container.children.length;

  // Step 2: ResizeObserver on the container
  var roCount = 0;
  var obs = new ResizeObserver(function(entries) {
    roCount++;
    if (roCount > 15) { obs.disconnect(); return; }
    entries[0].target.style.width = (parseInt(entries[0].target.style.width) + 5) + 'px';
  });
  obs.observe(container);
  container.style.width = '210px';
  container.offsetWidth;

  // Step 3: Load SVG
  setTimeout(function() {
    obs.disconnect();
    r.roCount = roCount;

    loadSVGImage(complexSVG, 8000).then(function(svgR) {
      r.svg = svgR;
      r.SURVIVED = true;
      container.remove();
      B("E2-CE-RO-SVG", r);
    });
  }, 1500);
}

/* ====== E3: MutationObserver + Range + SVG (p90 R3+R4 exact combo) ====== */
function test_E3() {
  B("E3-START", "begin");
  var r = {};

  var container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;';
  document.body.appendChild(container);
  container.innerHTML = '<p>initial <b>bold</b> text</p>';

  var mutations = [];
  var observer = new MutationObserver(function(records) {
    mutations.push(records.length);
    for (var i = 0; i < records.length; i++) {
      if (records[i].addedNodes.length > 0) {
        for (var j = 0; j < records[i].addedNodes.length; j++) {
          var node = records[i].addedNodes[j];
          if (node.nodeType === 1 && !node.getAttribute('data-mut')) {
            node.setAttribute('data-mut', '1');
            var s = document.createElement('i');
            s.textContent = 'mut';
            node.appendChild(s);
          }
        }
      }
    }
  });
  observer.observe(container, { childList:true, subtree:true, attributes:true });

  container.innerHTML = '<div>new <span>content</span></div><div>more</div>';

  // Range manipulation
  try {
    var range = document.createRange();
    range.selectNodeContents(container);
    var frag = range.extractContents();
    container.appendChild(frag);

    var range2 = document.createRange();
    if (container.firstChild && container.firstChild.firstChild) {
      range2.setStart(container.firstChild.firstChild, 0);
      if (container.firstChild.lastChild) {
        range2.setEnd(container.firstChild.lastChild,
          container.firstChild.lastChild.textContent ?
          container.firstChild.lastChild.textContent.length : 0);
      }
      var wrapper = document.createElement('mark');
      range2.surroundContents(wrapper);
      r.surround = "ok";
    }
  } catch(e) {
    r.rangeErr = e.message.slice(0, 40);
  }

  // NOW: Load SVG while MutationObserver is still active
  loadSVGImage(complexSVG, 8000).then(function(svgR) {
    observer.disconnect();
    r.mutations = mutations.length;
    r.svg = svgR;
    r.SURVIVED = true;
    container.remove();
    B("E3-MUT-RANGE-SVG", r);
  });
}

/* ====== E4: ALL THREE combined (p90 R1+R2+R3 then R4) ====== */
function test_E4() {
  B("E4-START", "begin");
  var r = {};

  // === R1: ResizeObserver infinite loop ===
  var roContainer = document.createElement('div');
  roContainer.style.cssText = 'position:absolute;left:-9999px;width:100px;height:100px;';
  document.body.appendChild(roContainer);
  var roChild = document.createElement('div');
  roChild.style.cssText = 'width:50px;height:50px;';
  roContainer.appendChild(roChild);

  var roCount = 0;
  var ro = new ResizeObserver(function(entries) {
    roCount++;
    if (roCount > 20) { ro.disconnect(); return; }
    entries[0].target.style.width = (entries[0].contentRect.width + 10) + 'px';
    var t = document.createElement('span');
    t.textContent = 'x';
    entries[0].target.appendChild(t);
    entries[0].target.removeChild(t);
  });
  ro.observe(roChild);
  roChild.style.width = '60px';

  // === R2: Custom Element during parse ===
  var ceTag = 'evil4-' + RUN_ID.slice(0,6);
  try {
    class Evil4 extends HTMLElement {
      constructor() {
        super();
        if (this.parentNode) {
          var sibs = this.parentNode.children;
          for (var i = sibs.length - 1; i >= 0; i--) {
            if (sibs[i] !== this && sibs[i].tagName === 'SPAN') {
              this.parentNode.removeChild(sibs[i]);
            }
          }
        }
      }
      connectedCallback() {
        var s = document.createElement('span');
        s.textContent = 'inj';
        if (this.parentNode) this.parentNode.appendChild(s);
      }
    }
    customElements.define(ceTag, Evil4);
  } catch(e) { /* tag might already be defined */ }

  var ceContainer = document.createElement('div');
  ceContainer.style.cssText = 'position:absolute;left:-9999px;';
  document.body.appendChild(ceContainer);
  ceContainer.innerHTML = '<span>a</span><' + ceTag + '></' + ceTag +
    '><span>b</span><' + ceTag + '></' + ceTag + '>';

  // === R3: MutationObserver + Range ===
  var mutContainer = document.createElement('div');
  mutContainer.style.cssText = 'position:absolute;left:-9999px;';
  document.body.appendChild(mutContainer);
  mutContainer.innerHTML = '<p>text <b>bold</b> more</p>';

  var mutCount = 0;
  var mo = new MutationObserver(function(records) {
    mutCount++;
    for (var i = 0; i < records.length; i++) {
      if (records[i].addedNodes.length > 0) {
        for (var j = 0; j < records[i].addedNodes.length; j++) {
          var n = records[i].addedNodes[j];
          if (n.nodeType === 1 && !n.getAttribute('d')) {
            n.setAttribute('d', '1');
            n.appendChild(document.createElement('i'));
          }
        }
      }
    }
  });
  mo.observe(mutContainer, { childList:true, subtree:true, attributes:true });
  mutContainer.innerHTML = '<div>new <span>s</span></div>';

  try {
    var range = document.createRange();
    range.selectNodeContents(mutContainer);
    var frag = range.extractContents();
    mutContainer.appendChild(frag);
  } catch(e) {}

  // Force layout with all three active
  roChild.offsetWidth;

  // === R4: SVG via Image ===
  setTimeout(function() {
    ro.disconnect();
    mo.disconnect();
    r.roCount = roCount;
    r.mutCount = mutCount;
    B("E4-STATE", {ro: roCount, mut: mutCount});

    loadSVGImage(complexSVG, 10000).then(function(svgR) {
      r.svg = svgR;
      r.SURVIVED = true;
      roContainer.remove();
      ceContainer.remove();
      mutContainer.remove();
      B("E4-FULL-COMBO", r);
    });
  }, 500); // SHORT delay — keep state hot
}

/* ====== E5: ResizeObserver infinite loop WITHOUT disconnect ====== */
function test_E5() {
  B("E5-START", "begin");
  var r = {};

  var container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;width:100px;height:100px;';
  document.body.appendChild(container);
  var child = document.createElement('div');
  child.style.cssText = 'width:50px;height:50px;';
  container.appendChild(child);

  var count = 0;
  var obs = new ResizeObserver(function(entries) {
    count++;
    if (count > 100) return; // stop mutating but DON'T disconnect
    entries[0].target.style.width = (entries[0].contentRect.width + 1) + 'px';
    // Also add children that stay (accumulate)
    var d = document.createElement('div');
    d.style.cssText = 'width:10px;height:5px;float:left;';
    entries[0].target.appendChild(d);
  });
  obs.observe(child);
  child.style.width = '51px';

  // Load SVG while ResizeObserver is STILL ACTIVE (not disconnected)
  setTimeout(function() {
    r.roCountBeforeSVG = count;
    // DON'T disconnect — keep observer active during SVG load
    loadSVGImage(complexSVG, 10000).then(function(svgR) {
      obs.disconnect();
      r.roCountAfter = count;
      r.svg = svgR;
      r.SURVIVED = true;
      r.childNodes = child.childNodes.length;
      container.remove();
      B("E5-RO-ACTIVE-SVG", r);
    });
  }, 300);
}

/* ====== E6: Deep nested ResizeObserver cascade + SVG ====== */
function test_E6() {
  B("E6-START", "begin");
  var r = {};

  var container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;width:200px;';
  document.body.appendChild(container);

  var levels = [];
  var parent = container;
  for (var i = 0; i < 10; i++) {
    var div = document.createElement('div');
    div.style.cssText = 'width:' + (180 - i*10) + 'px;height:50px;overflow:hidden;';
    parent.appendChild(div);
    levels.push(div);
    parent = div;
  }

  var obsCount = 0;
  var observers = [];
  for (var j = 0; j < levels.length - 1; j++) {
    (function(idx) {
      var o = new ResizeObserver(function(entries) {
        obsCount++;
        if (obsCount > 100) return;
        var next = levels[idx + 1];
        if (next) {
          next.style.width = (parseInt(next.style.width) + 3) + 'px';
          next.appendChild(document.createElement('span'));
        }
      });
      o.observe(levels[idx]);
      observers.push(o);
    })(j);
  }
  levels[0].style.width = '185px';
  levels[0].offsetWidth;

  // Load SVG with cascade still settling
  setTimeout(function() {
    r.obsCount = obsCount;
    // Disconnect all
    for (var k = 0; k < observers.length; k++) observers[k].disconnect();

    loadSVGImage(complexSVG, 10000).then(function(svgR) {
      r.svg = svgR;
      r.SURVIVED = true;
      container.remove();
      B("E6-CASCADE-SVG", r);
    });
  }, 1000);
}

/* ====== Run ====== */
try {
  test_E1();
  setTimeout(test_E2, 12000);
  setTimeout(test_E3, 24000);
  setTimeout(test_E4, 36000);
  setTimeout(test_E5, 50000);
  setTimeout(test_E6, 64000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe93-done"); }, 100000);
})();
