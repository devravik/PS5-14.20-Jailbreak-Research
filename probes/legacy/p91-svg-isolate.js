/* p91-svg-isolate — Isolate SVG crash + missed tests from p90
 *
 * p90 R4 (SVG filter chain) KILLED the WebView. R5/R6 never ran.
 * This probe:
 * 1. Runs the missed tests FIRST (Error.stack, CSS layout)
 * 2. Then isolates WHICH SVG filter element caused the crash
 * 3. Deeper Custom Element + ResizeObserver re-entrancy probes
 *
 * Beacon prefix: V91S-
 */
(function(){
"use strict";
var RUN_ID = "v91s" + Math.random().toString(36).slice(2,12);
var PREFIX = "V91S-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press91-svg-isolate");

/* ====== S1: Error.stack info leak (was R5) ====== */
function test_S1() {
  var r = {};
  try {
    var e1 = new Error("test");
    r.stack = e1.stack ? e1.stack.slice(0, 400) : "none";

    // Deep recursion stack
    function deep(n) { if (n <= 0) throw new Error("bottom"); return deep(n-1); }
    try { deep(100); } catch(e) {
      r.deepStack = e.stack ? e.stack.slice(0, 400) : "none";
      r.deepLines = e.stack ? e.stack.split('\n').length : 0;
    }

    // Eval stack
    try { eval("throw new Error('eval')"); } catch(e) {
      r.evalStack = e.stack ? e.stack.slice(0, 200) : "none";
    }

    // Function constructor stack
    try { new Function("throw new Error('fn')")(); } catch(e) {
      r.fnStack = e.stack ? e.stack.slice(0, 200) : "none";
    }

    // Check for hex addresses in stack traces
    var all = [r.stack, r.deepStack, r.evalStack, r.fnStack].join(" ");
    var hex = all.match(/0x[0-9a-fA-F]{6,}/g);
    r.hexAddrs = hex ? hex.slice(0,5) : [];
    r.ADDR_LEAK = hex && hex.length > 0;

    // Check for file paths (info leak)
    var paths = all.match(/\/[a-zA-Z][\w\/\-\.]+/g);
    r.pathLeak = paths ? paths.slice(0, 3) : [];

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S1-STACK", r);
}

/* ====== S2: CSS layout (was R6) ====== */
function test_S2() {
  var r = {};
  try {
    var c = document.createElement('div');
    c.style.cssText = 'position:absolute;left:-9999px;width:300px;';
    document.body.appendChild(c);

    c.innerHTML = [
      '<style>',
      '.flex{display:flex;flex-wrap:wrap}',
      '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(50px,1fr))}',
      '.col{column-count:3;column-gap:10px}',
      '</style>',
      '<div class="flex">',
      '<div class="grid" style="width:200px">',
      '<div class="col"><p>a</p><p>b</p><p>c</p></div>',
      '</div>',
      '<div style="flex:1;min-width:0">',
      '<div style="display:table"><div style="display:table-row">',
      '<div style="display:table-cell;width:50%">c1</div>',
      '<div style="display:table-cell">c2</div>',
      '</div></div></div></div>'
    ].join('');

    r.h1 = c.offsetHeight;
    c.style.writingMode = 'vertical-rl';
    r.h2 = c.offsetHeight;
    c.style.writingMode = 'horizontal-tb';
    c.style.direction = 'rtl';
    r.h3 = c.offsetHeight;
    r.LAYOUT_OK = true;
    c.remove();
  } catch(e) { r.err = e.message.slice(0,80); }
  B("S2-CSS", r);
}

/* ====== S3: Isolated SVG — just feTurbulence ====== */
function test_S3() {
  var r = {};
  try {
    var c = document.createElement('div');
    c.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c);
    c.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">' +
      '<defs><filter id="t1"><feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="3"/></filter></defs>' +
      '<rect width="50" height="50" filter="url(#t1)"/></svg>';
    r.turb_basic = "ok";
    c.remove();
  } catch(e) { r.turb_basic = e.message.slice(0,40); }

  // Higher octaves
  try {
    var c2 = document.createElement('div');
    c2.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c2);
    c2.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">' +
      '<defs><filter id="t2"><feTurbulence type="fractalNoise" baseFrequency="0.001" numOctaves="10"/></filter></defs>' +
      '<rect width="50" height="50" filter="url(#t2)"/></svg>';
    c2.querySelector('rect').getBoundingClientRect(); // force render
    r.turb_10oct = "ok";
    c2.remove();
  } catch(e) { r.turb_10oct = e.message.slice(0,40); }

  B("S3-TURB", r);
}

/* ====== S4: Isolated SVG — feDisplacementMap with extreme scale ====== */
function test_S4() {
  var r = {};
  try {
    var c = document.createElement('div');
    c.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c);
    c.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">' +
      '<defs><filter id="d1"><feDisplacementMap scale="100"/></filter></defs>' +
      '<rect width="50" height="50" filter="url(#d1)" fill="blue"/></svg>';
    c.querySelector('rect').getBoundingClientRect();
    r.disp_100 = "ok";
    c.remove();
  } catch(e) { r.disp_100 = e.message.slice(0,40); }

  try {
    var c2 = document.createElement('div');
    c2.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c2);
    c2.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">' +
      '<defs><filter id="d2"><feDisplacementMap scale="9999"/></filter></defs>' +
      '<rect width="50" height="50" filter="url(#d2)" fill="blue"/></svg>';
    c2.querySelector('rect').getBoundingClientRect();
    r.disp_9999 = "ok";
    c2.remove();
  } catch(e) { r.disp_9999 = e.message.slice(0,40); }

  B("S4-DISPLACE", r);
}

/* ====== S5: Isolated SVG — filter chain + large area ====== */
function test_S5() {
  var r = {};
  try {
    var c = document.createElement('div');
    c.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c);
    // Filter with large area percentages (the x/y/width/height from p90)
    c.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">' +
      '<defs><filter id="f1" x="-100%" y="-100%" width="400%" height="400%">' +
      '<feGaussianBlur stdDeviation="50"/>' +
      '</filter></defs>' +
      '<rect width="50" height="50" filter="url(#f1)" fill="red"/></svg>';
    c.querySelector('rect').getBoundingClientRect();
    r.blur_large = "ok";
    c.remove();
  } catch(e) { r.blur_large = e.message.slice(0,40); }

  // Combined chain: turbulence + displacement
  try {
    var c2 = document.createElement('div');
    c2.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c2);
    c2.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">' +
      '<defs><filter id="f2">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="3" result="turb"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="turb" scale="50"/>' +
      '</filter></defs>' +
      '<rect width="50" height="50" filter="url(#f2)" fill="green"/></svg>';
    c2.querySelector('rect').getBoundingClientRect();
    r.chain_basic = "ok";
    c2.remove();
  } catch(e) { r.chain_basic = e.message.slice(0,40); }

  B("S5-CHAIN", r);
}

/* ====== S6: SVG foreignObject isolation ====== */
function test_S6() {
  var r = {};
  try {
    var c = document.createElement('div');
    c.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c);
    c.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<foreignObject x="0" y="0" width="100" height="100">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">HTML inside SVG</div>' +
      '</foreignObject></svg>';
    r.foreignObj = "ok";
    var fo = c.querySelector('foreignObject');
    r.foChildren = fo ? fo.children.length : -1;
    c.remove();
  } catch(e) { r.foreignObj = e.message.slice(0,40); }

  // foreignObject with script (should NOT execute)
  try {
    var c2 = document.createElement('div');
    c2.style.cssText = 'position:absolute;left:-9999px;';
    document.body.appendChild(c2);
    var scriptRan = false;
    window.__svgScriptTest = function() { scriptRan = true; };
    c2.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<foreignObject x="0" y="0" width="100" height="100">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' +
      '<script>window.__svgScriptTest()</scr' + 'ipt></div>' +
      '</foreignObject></svg>';
    r.scriptInFO = scriptRan ? "EXECUTED" : "blocked";
    delete window.__svgScriptTest;
    c2.remove();
  } catch(e) { r.scriptInFO = e.message.slice(0,40); }

  B("S6-FOREIGN", r);
}

/* ====== S7: SVG → Canvas pixel read (isolated, small) ====== */
function test_S7() {
  var r = {};
  try {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<rect width="10" height="10" fill="red"/></svg>';
    var blob = new Blob([svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function() {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = 10; canvas.height = 10;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, 10, 10);
        r.pixel0_R = data.data[0]; // should be 255 (red)
        r.pixel0_A = data.data[3]; // should be 255 (opaque)
        r.SVG_CANVAS_OK = true;
      } catch(e) {
        r.canvasErr = e.name + ":" + e.message.slice(0,40);
        r.TAINTED = e.name === "SecurityError";
      }
      URL.revokeObjectURL(url);
      B("S7-SVG-CANVAS", r);
    };
    img.onerror = function() {
      r.imgErr = true;
      URL.revokeObjectURL(url);
      B("S7-SVG-CANVAS", r);
    };
    img.src = url;

    setTimeout(function() {
      if (!r.SVG_CANVAS_OK && !r.canvasErr && !r.imgErr) {
        r.TIMEOUT = true;
        B("S7-SVG-CANVAS", r);
      }
    }, 3000);
  } catch(e) { r.err = e.message.slice(0,80); B("S7-SVG-CANVAS", r); }
}

/* ====== S8: ResizeObserver deep re-entrancy with tree mutation ====== */
function test_S8() {
  var r = {};
  try {
    var container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;width:200px;';
    document.body.appendChild(container);

    // Create nested structure
    var levels = [];
    var parent = container;
    for (var i = 0; i < 10; i++) {
      var div = document.createElement('div');
      div.style.cssText = 'width:' + (180 - i*10) + 'px;height:50px;overflow:hidden;';
      div.className = 'level-' + i;
      parent.appendChild(div);
      levels.push(div);
      parent = div;
    }

    var observations = [];
    var observers = [];
    var maxDepth = 0;

    // Each level has its own ResizeObserver that mutates the NEXT level
    for (var j = 0; j < levels.length - 1; j++) {
      (function(idx) {
        var obs = new ResizeObserver(function(entries) {
          observations.push(idx);
          if (observations.length > 50) return; // safety
          maxDepth = Math.max(maxDepth, idx);

          // Mutate the next level during this callback
          var next = levels[idx + 1];
          if (next && next.parentNode) {
            var newW = parseInt(next.style.width) + 5;
            next.style.width = newW + 'px';

            // Also: add and remove a child (tree mutation during layout)
            var tmp = document.createElement('span');
            tmp.textContent = 'depth' + idx;
            next.appendChild(tmp);
            // Don't remove — let children accumulate
          }
        });
        obs.observe(levels[idx]);
        observers.push(obs);
      })(j);
    }

    // Trigger cascade
    levels[0].style.width = '190px';
    levels[0].offsetWidth; // force layout

    setTimeout(function() {
      for (var k = 0; k < observers.length; k++) observers[k].disconnect();
      r.observations = observations.length;
      r.maxDepth = maxDepth;
      r.depthSequence = observations.slice(0, 20).join(",");
      r.lastLevelChildren = levels[levels.length-1].children.length;
      r.DEEP_REENTRY = maxDepth > 5;
      r.CASCADE = observations.length > 10;
      container.remove();
      B("S8-DEEP-RESIZE", r);
    }, 2000);

  } catch(e) { r.err = e.message.slice(0,80); B("S8-DEEP-RESIZE", r); }
}

/* ====== Run — SAFE tests first, then isolated SVG ====== */
try {
  test_S1(); // Error.stack — instant, safe
  test_S2(); // CSS layout — instant, safe
  setTimeout(test_S3, 400);   // feTurbulence only
  setTimeout(test_S4, 1000);  // feDisplacementMap only
  setTimeout(test_S5, 1600);  // filter chain (small)
  setTimeout(test_S6, 2200);  // foreignObject
  setTimeout(test_S7, 2800);  // SVG → canvas (small, safe)
  setTimeout(test_S8, 4000);  // deep ResizeObserver re-entrancy
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe91-done"); }, 20000);
})();
