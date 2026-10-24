/* p90-yarr-dom — YARR regex JIT + DOM re-entrancy + SVG filters
 *
 * UNTESTED attack surfaces:
 * 1. YARR regex JIT — separate JIT pipeline from DFG, compiles regex
 *    to native code. Known bug class: backreference + lookahead confusion,
 *    capture group overflow, unicode property class bugs.
 * 2. DOM mutation during layout — IntersectionObserver/ResizeObserver/
 *    MutationObserver callbacks fire during layout. If callback modifies
 *    the tree being laid out → re-entrant layout → UAF.
 * 3. Custom Element upgrade during innerHTML parsing — upgrade callback
 *    can modify the DOM tree while parser is building it.
 * 4. SVG filter chains — complex SVG filters use internal pixel buffers,
 *    different code paths from Canvas.
 *
 * Beacon prefix: V90R-
 */
(function(){
"use strict";
var RUN_ID = "v90r" + Math.random().toString(36).slice(2,12);
var PREFIX = "V90R-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press90-yarr-dom");

/* ====== Y1: YARR regex — massive capture groups ====== */
function test_Y1() {
  var r = {};
  try {
    // YARR allocates capture group storage. Massive groups may overflow.
    var parts = [];
    for (var i = 0; i < 500; i++) parts.push("(a)");
    var bigRegex = new RegExp(parts.join(""));
    r.groups = bigRegex.source.length;

    var input = "";
    for (var j = 0; j < 500; j++) input += "a";

    var match = bigRegex.exec(input);
    r.matched = !!match;
    r.matchLen = match ? match.length : 0;
    r.group499 = match ? match[499] : null;

    // Named groups — YARR handles these differently
    var namedParts = [];
    for (var k = 0; k < 200; k++) namedParts.push("(?<g" + k + ">a)");
    try {
      var namedRegex = new RegExp(namedParts.join(""));
      var nm = namedRegex.exec(input.slice(0, 200));
      r.namedMatch = !!nm;
      r.namedGroups = nm && nm.groups ? Object.keys(nm.groups).length : 0;
      r.g199 = nm && nm.groups ? nm.groups.g199 : null;
    } catch(e) {
      r.namedErr = e.message.slice(0, 40);
    }

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); }
  B("Y1-CAPTURE", r);
}

/* ====== Y2: YARR catastrophic backtracking + Symbol.replace ====== */
function test_Y2() {
  var r = {};
  try {
    // Catastrophic backtracking can cause YARR to run for a long time
    // or exhaust stack space. JSC has a backtracking limit but...
    var evilRegex = /^(a+)+$/;
    var input = "a".repeat(25) + "b"; // triggers exponential backtracking

    var start = Date.now();
    var match = evilRegex.test(input);
    var elapsed = Date.now() - start;
    r.backtrackMs = elapsed;
    r.matched = match;
    r.CATASTROPHIC = elapsed > 1000;

    // Symbol.replace override — can we hook into regex engine internals?
    var customReplacer = {
      [Symbol.replace]: function(str) {
        r.replaceHooked = true;
        // Return crafted value
        return "HOOKED";
      }
    };
    var replaced = "test".replace(customReplacer, "x");
    r.replaced = replaced;

    // RegExp.prototype.exec override
    var origExec = RegExp.prototype.exec;
    var execCount = 0;
    RegExp.prototype.exec = function(str) {
      execCount++;
      if (execCount > 100) {
        RegExp.prototype.exec = origExec;
        return null;
      }
      // During exec override, modify the regex
      this.lastIndex = 999;
      return origExec.call(this, str);
    };

    try {
      var hackRegex = /a/g;
      var hackResult = "aaa".match(hackRegex);
      r.hackExecCount = execCount;
      r.hackResult = hackResult ? hackResult.length : -1;
    } finally {
      RegExp.prototype.exec = origExec;
    }

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); }
  B("Y2-BACKTRACK", r);
}

/* ====== Y3: YARR lookbehind + backreference confusion ====== */
function test_Y3() {
  var r = {};
  try {
    // Lookbehind with backreferences can confuse YARR's offset calculations
    // The lookbehind engine runs backwards while backreferences run forwards

    // Test 1: Lookbehind referencing a forward capture group
    try {
      var re1 = /(?<=\1(a))x/;
      var m1 = re1.exec("aax");
      r.lb1 = m1 ? m1[0] : "nomatch";
    } catch(e) { r.lb1Err = e.message.slice(0,30); }

    // Test 2: Nested lookbehind + lookahead
    try {
      var re2 = /(?<=(?=a).)b/;
      var m2 = re2.exec("ab");
      r.lb2 = m2 ? m2[0] : "nomatch";
    } catch(e) { r.lb2Err = e.message.slice(0,30); }

    // Test 3: Lookbehind with quantifier + capture
    try {
      var re3 = /(?<=(a{2,4}))x/;
      var m3 = re3.exec("aaaax");
      r.lb3 = m3 ? m3[1] : "nomatch";
      r.lb3Len = m3 ? m3[1].length : 0;
    } catch(e) { r.lb3Err = e.message.slice(0,30); }

    // Test 4: Lookbehind with alternation of different lengths
    try {
      var re4 = /(?<=abc|xy)z/;
      var m4a = re4.exec("abcz");
      var m4b = re4.exec("xyz");
      r.lb4a = m4a ? "match" : "no";
      r.lb4b = m4b ? "match" : "no";
    } catch(e) { r.lb4Err = e.message.slice(0,30); }

    // Test 5: Very deep nesting in lookbehind
    var nested = "(?<=";
    for (var i = 0; i < 50; i++) nested += "(?:a";
    nested += "x";
    for (var j = 0; j < 50; j++) nested += ")";
    nested += ")y";
    try {
      var re5 = new RegExp(nested);
      var input5 = "a".repeat(50) + "xy";
      var m5 = re5.exec(input5);
      r.lb5 = m5 ? "match" : "no";
    } catch(e) { r.lb5Err = e.message.slice(0,30); }

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); }
  B("Y3-LOOKBEHIND", r);
}

/* ====== Y4: YARR unicode property escapes + surrogate handling ====== */
function test_Y4() {
  var r = {};
  try {
    // Unicode property escapes trigger ICU code paths
    var re1 = /\p{Script=Han}/u;
    r.han = re1.test("世"); // 世

    // Surrogate pair handling
    var re2 = /(.)\1/u; // backreference to surrogate pair
    var emoji = "😀"; // 😀
    r.emojiMatch = re2.test(emoji + emoji);

    // Unpaired surrogates
    var re3 = /./u;
    try {
      r.unpairedHigh = re3.test("\uD800"); // lone high surrogate
    } catch(e) { r.unpairedErr = e.message.slice(0,30); }

    // Very long unicode string with property escapes
    var longStr = "世".repeat(10000);
    var re4 = /\p{Script=Han}+/u;
    var m4 = re4.exec(longStr);
    r.longHanLen = m4 ? m4[0].length : 0;

    // Mixed scripts crossing category boundaries
    var re5 = /[\p{L}\p{N}]+/gu;
    var mixed = "abc123世丗丘def456";
    var matches = mixed.match(re5);
    r.mixedMatches = matches ? matches.length : 0;

    // Regex with \p{} in character class with range
    try {
      var re6 = /[\p{Ll}a-z]/u;
      r.classRange = re6.test("a");
    } catch(e) { r.classRangeErr = e.message.slice(0,30); }

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); }
  B("Y4-UNICODE", r);
}

/* ====== R1: DOM mutation during ResizeObserver callback ====== */
function test_R1() {
  var r = {};
  try {
    r.hasRO = typeof ResizeObserver !== 'undefined';
    if (!r.hasRO) { B("R1-RESIZE-OBS", r); return; }

    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;width:100px;height:100px;';
    document.body.appendChild(container);

    var child = document.createElement('div');
    child.style.cssText = 'width:50px;height:50px;background:red;';
    container.appendChild(child);

    var callbackCount = 0;
    var observer = new ResizeObserver(function(entries) {
      callbackCount++;
      if (callbackCount > 20) {
        observer.disconnect();
        r.callbackCount = callbackCount;
        r.INFINITE_LOOP = callbackCount > 20;
        container.remove();
        B("R1-RESIZE-OBS", r);
        return;
      }

      // DURING resize callback, mutate the observed element
      // This should trigger re-entrant layout
      for (var i = 0; i < entries.length; i++) {
        var target = entries[i].target;
        var w = entries[i].contentRect.width;
        // Resize the element — triggers another resize observation!
        target.style.width = (w + 10) + 'px';
        // Also add/remove children during layout callback
        var tmp = document.createElement('span');
        tmp.textContent = 'x';
        target.appendChild(tmp);
        target.removeChild(tmp);
      }
    });

    observer.observe(child);
    // Force layout
    child.style.width = '60px';
    child.offsetWidth; // force layout

    // Give ResizeObserver time to fire
    setTimeout(function() {
      observer.disconnect();
      r.callbackCount = callbackCount;
      r.REENTRANT = callbackCount > 1;
      container.remove();
      B("R1-RESIZE-OBS", r);
    }, 2000);

  } catch(e) { r.err = e.message.slice(0,80); B("R1-RESIZE-OBS", r); }
}

/* ====== R2: Custom Element upgrade during innerHTML ====== */
function test_R2() {
  var r = {};
  try {
    var upgradeCount = 0;
    var upgradeDuringParse = false;

    // Define custom element whose constructor modifies the DOM
    class EvilElement extends HTMLElement {
      constructor() {
        super();
        upgradeCount++;
        // During upgrade (which happens during parsing), modify the tree
        if (this.parentNode) {
          // Remove sibling elements during parse
          var sibs = this.parentNode.children;
          for (var i = sibs.length - 1; i >= 0; i--) {
            if (sibs[i] !== this && sibs[i].tagName === 'SPAN') {
              this.parentNode.removeChild(sibs[i]);
              upgradeDuringParse = true;
            }
          }
        }
      }
      connectedCallback() {
        // Add more elements during connection
        var s = document.createElement('span');
        s.textContent = 'injected';
        if (this.parentNode) this.parentNode.appendChild(s);
      }
    }

    var tagName = 'evil-el-' + RUN_ID.slice(0,6);
    customElements.define(tagName, EvilElement);

    // innerHTML with custom element interleaved with regular elements
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);

    var html = '<span>before</span>';
    html += '<' + tagName + '></' + tagName + '>';
    html += '<span>between</span>';
    html += '<' + tagName + '></' + tagName + '>';
    html += '<span>after</span>';

    container.innerHTML = html;

    r.upgradeCount = upgradeCount;
    r.upgradeDuringParse = upgradeDuringParse;
    r.childCount = container.children.length;
    r.innerHTML = container.innerHTML.slice(0, 200);

    // Nested innerHTML during custom element construction
    class NestingElement extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.innerHTML = '<div><span>shadow</span></div>';
      }
    }
    var nestTag = 'nest-el-' + RUN_ID.slice(0,6);
    customElements.define(nestTag, NestingElement);

    var c2 = document.createElement('div');
    c2.innerHTML = '<' + nestTag + '></' + nestTag + '>';
    r.nestShadow = c2.firstChild && c2.firstChild.shadowRoot
      ? c2.firstChild.shadowRoot.innerHTML.slice(0,50) : 'none';

    container.remove();

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); }
  B("R2-CUSTOM-EL", r);
}

/* ====== R3: MutationObserver during innerHTML + Range manipulation ====== */
function test_R3() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);
    container.innerHTML = '<p>initial <b>bold</b> text</p>';

    var mutations = [];
    var observer = new MutationObserver(function(records) {
      mutations.push(records.length);
      // During mutation callback, modify the tree further
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes.length > 0) {
          for (var j = 0; j < records[i].addedNodes.length; j++) {
            var node = records[i].addedNodes[j];
            if (node.nodeType === 1 && !node.getAttribute('data-mutated')) {
              node.setAttribute('data-mutated', 'true');
              // Add child during mutation callback
              var s = document.createElement('i');
              s.textContent = 'mut';
              node.appendChild(s);
            }
          }
        }
      }
    });

    observer.observe(container, {
      childList: true, subtree: true, attributes: true
    });

    // Trigger complex mutations
    container.innerHTML = '<div>new <span>content</span></div><div>more</div>';

    // Range manipulation while mutation observer is pending
    var range = document.createRange();
    range.selectNodeContents(container);

    // Extract and reinsert while mutation might be pending
    var fragment = range.extractContents();
    container.appendChild(fragment);

    // surroundContents with complex range
    var range2 = document.createRange();
    if (container.firstChild && container.firstChild.firstChild) {
      range2.setStart(container.firstChild.firstChild, 0);
      if (container.firstChild.lastChild) {
        range2.setEnd(container.firstChild.lastChild,
          container.firstChild.lastChild.textContent ?
          container.firstChild.lastChild.textContent.length : 0);
      }
      try {
        var wrapper = document.createElement('mark');
        range2.surroundContents(wrapper);
        r.surroundOK = true;
      } catch(e) {
        r.surroundErr = e.message.slice(0, 40);
      }
    }

    setTimeout(function() {
      observer.disconnect();
      r.mutationBatches = mutations.length;
      r.totalMutations = mutations.reduce(function(a,b){return a+b;}, 0);
      r.finalChildren = container.children.length;
      r.finalHTML = container.innerHTML.slice(0, 200);
      container.remove();
      B("R3-MUTATION-RANGE", r);
    }, 500);

  } catch(e) { r.err = e.message.slice(0,80); B("R3-MUTATION-RANGE", r); }
}

/* ====== R4: SVG filter chain + foreignObject ====== */
function test_R4() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(container);

    // SVG with complex filter chain
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">';
    svg += '<defs>';
    // Chain of filters referencing each other
    svg += '<filter id="f1" x="-100%" y="-100%" width="400%" height="400%">';
    svg += '<feGaussianBlur stdDeviation="50" result="blur"/>';
    svg += '<feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 20 -10" in="blur" result="cm"/>';
    svg += '<feComposite in="SourceGraphic" in2="cm" operator="atop"/>';
    svg += '</filter>';
    // Turbulence with extreme values
    svg += '<filter id="f2">';
    svg += '<feTurbulence type="fractalNoise" baseFrequency="0.0001" numOctaves="20" seed="42"/>';
    svg += '<feDisplacementMap in="SourceGraphic" scale="9999"/>';
    svg += '</filter>';
    // Recursive-looking filter (references own result)
    svg += '<filter id="f3">';
    svg += '<feFlood flood-color="red" result="flood"/>';
    svg += '<feMerge><feMergeNode in="flood"/><feMergeNode in="SourceGraphic"/></feMerge>';
    svg += '</filter>';
    svg += '</defs>';
    // foreignObject — embeds HTML inside SVG
    svg += '<foreignObject x="0" y="0" width="200" height="200">';
    svg += '<div xmlns="http://www.w3.org/1999/xhtml" style="color:red">HTML inside SVG</div>';
    svg += '</foreignObject>';
    // Shapes with filters
    svg += '<rect width="100" height="100" filter="url(#f1)" fill="blue"/>';
    svg += '<circle cx="50" cy="50" r="50" filter="url(#f2)" fill="green"/>';
    // Path with extreme coordinates
    svg += '<path d="M -999999 -999999 L 999999 999999 L 999999 -999999 Z" fill="red" opacity="0.1"/>';
    svg += '</svg>';

    container.innerHTML = svg;

    var svgEl = container.querySelector('svg');
    r.svgExists = !!svgEl;

    // Try to read pixel data from SVG via canvas
    var canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 200;
    var ctx = canvas.getContext('2d');

    // Draw SVG to canvas via Image
    var svgBlob = new Blob([svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(svgBlob);
    var img = new Image();
    img.onload = function() {
      try {
        ctx.drawImage(img, 0, 0);
        var imgData = ctx.getImageData(0, 0, 200, 200);
        var nonZero = 0;
        for (var i = 0; i < imgData.data.length; i += 4) {
          if (imgData.data[i] + imgData.data[i+1] + imgData.data[i+2] > 0) nonZero++;
        }
        r.svgPixels = nonZero;
        r.SVG_RENDERED = nonZero > 0;
      } catch(e) {
        r.canvasErr = e.message.slice(0,40);
        // Tainted canvas from SVG = security restriction
        r.TAINTED = e.name === 'SecurityError';
      }
      URL.revokeObjectURL(url);
      container.remove();
      B("R4-SVG-FILTER", r);
    };
    img.onerror = function() {
      r.imgErr = "failed to load SVG";
      URL.revokeObjectURL(url);
      container.remove();
      B("R4-SVG-FILTER", r);
    };
    img.src = url;

    setTimeout(function() {
      if (!r.svgPixels && !r.canvasErr && !r.imgErr) {
        r.TIMEOUT = true;
        container.remove();
        B("R4-SVG-FILTER", r);
      }
    }, 3000);

  } catch(e) { r.err = e.message.slice(0,80); B("R4-SVG-FILTER", r); }
}

/* ====== R5: Error.stack information leak ====== */
function test_R5() {
  var r = {};
  try {
    // Error.stack might leak address information or internal paths
    var e1 = new Error("test");
    r.stack = e1.stack ? e1.stack.slice(0, 300) : "none";

    // Stack from deep recursion
    function deepRecurse(n) {
      if (n <= 0) throw new Error("bottom");
      return deepRecurse(n - 1);
    }
    try {
      deepRecurse(100);
    } catch(e) {
      r.deepStack = e.stack ? e.stack.slice(0, 300) : "none";
      r.deepStackLines = e.stack ? e.stack.split('\n').length : 0;
    }

    // Stack from eval
    try {
      eval("throw new Error('eval-err')");
    } catch(e) {
      r.evalStack = e.stack ? e.stack.slice(0, 200) : "none";
    }

    // Stack from Function constructor
    try {
      var fn = new Function("throw new Error('fn-err')");
      fn();
    } catch(e) {
      r.fnStack = e.stack ? e.stack.slice(0, 200) : "none";
    }

    // Check if stack contains addresses (hex patterns)
    var allStacks = [r.stack, r.deepStack, r.evalStack, r.fnStack].join(" ");
    var hexPattern = /0x[0-9a-fA-F]{8,}/g;
    var hexMatches = allStacks.match(hexPattern);
    r.hexAddrs = hexMatches ? hexMatches.slice(0, 5) : [];
    r.ADDR_LEAK = hexMatches && hexMatches.length > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("R5-ERROR-STACK", r);
}

/* ====== R6: CSS layout re-entrancy ====== */
function test_R6() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;width:300px;';
    document.body.appendChild(container);

    // Complex CSS that triggers many layout passes
    container.innerHTML = [
      '<style>',
      '.flex { display:flex; flex-wrap:wrap; }',
      '.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(50px,1fr)); }',
      '.col { column-count:3; column-gap:10px; }',
      '.nest { contain:layout style; }',
      '@container (min-width:100px) { .cq { color: red; } }',
      '</style>',
      '<div class="flex">',
      '  <div class="grid" style="width:200px">',
      '    <div class="col"><p>a</p><p>b</p><p>c</p></div>',
      '    <div class="nest"><div class="cq">q</div></div>',
      '  </div>',
      '  <div style="flex:1;min-width:0">',
      '    <div style="display:table">',
      '      <div style="display:table-row">',
      '        <div style="display:table-cell;width:50%">cell1</div>',
      '        <div style="display:table-cell">cell2</div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('\n');

    // Force layout
    var height = container.offsetHeight;
    r.layoutHeight = height;

    // getComputedStyle during layout (force style recalc)
    var flexDiv = container.querySelector('.flex');
    var cs = getComputedStyle(flexDiv);
    r.flexDisplay = cs.display;

    // Mutate during getComputedStyle
    var gridDiv = container.querySelector('.grid');
    gridDiv.style.width = '300px'; // trigger relayout
    var gridCS = getComputedStyle(gridDiv);
    r.gridW = gridCS.width;

    // Writing mode change (triggers full relayout)
    container.style.writingMode = 'vertical-rl';
    var vertHeight = container.offsetHeight;
    r.vertHeight = vertHeight;

    container.style.writingMode = 'horizontal-tb';
    container.style.direction = 'rtl';
    var rtlHeight = container.offsetHeight;
    r.rtlHeight = rtlHeight;

    r.LAYOUT_OK = true;
    container.remove();

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); }
  B("R6-CSS-LAYOUT", r);
}

/* ====== Run ====== */
try {
  test_Y1();
  setTimeout(test_Y2, 300);
  setTimeout(test_Y3, 800);
  setTimeout(test_Y4, 1200);
  setTimeout(test_R1, 1600);
  setTimeout(test_R2, 2000);
  setTimeout(test_R3, 2500);
  setTimeout(test_R4, 3500);
  setTimeout(test_R5, 4000);
  setTimeout(test_R6, 4500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe90-done"); }, 25000);
})();
