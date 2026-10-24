/* p92-svg-crash — Reproduce and isolate p90 SVG crash
 *
 * p90 R4 crashed the WebView. p91 shows individual filters work at
 * small sizes. The crash is in SVG-via-Image rasterization at larger
 * sizes with extreme filter parameters.
 *
 * Isolate: which parameter/combination kills the renderer?
 * 1. numOctaves=20 via Image (p90 had this, p91 only tested 10)
 * 2. baseFrequency=0.0001 (very fine noise → huge work)
 * 3. 200x200 vs 50x50 size (16x more pixels)
 * 4. Multiple filters active simultaneously
 * 5. Path with extreme coordinates
 *
 * Each test loads SVG via Image (the p90 crash path).
 * Tests ordered from least to most dangerous.
 *
 * Beacon prefix: V92X-
 */
(function(){
"use strict";
var RUN_ID = "v92x" + Math.random().toString(36).slice(2,12);
var PREFIX = "V92X-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press92-svg-crash-isolate");

function loadSVGviaImage(svg, timeout) {
  return new Promise(function(resolve) {
    var blob = new Blob([svg], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    var done = false;

    var timer = setTimeout(function() {
      if (!done) { done = true; URL.revokeObjectURL(url); resolve({TIMEOUT:true}); }
    }, timeout || 5000);

    img.onload = function() {
      if (done) return;
      done = true; clearTimeout(timer);
      var r = {loaded:true, w:img.width, h:img.height};
      // Try drawing to canvas
      try {
        var c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, Math.min(img.width,10), Math.min(img.height,10));
        r.pixel0 = data.data[0];
        r.drawn = true;
      } catch(e) {
        r.drawErr = e.name + ":" + e.message.slice(0,40);
      }
      URL.revokeObjectURL(url);
      resolve(r);
    };
    img.onerror = function() {
      if (done) return;
      done = true; clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve({error:true});
    };
    img.src = url;
  });
}

/* ====== X1: Baseline — simple SVG via Image, 200x200 ====== */
function test_X1() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<rect width="200" height="200" fill="blue"/></svg>';
  loadSVGviaImage(svg, 3000).then(function(r) { B("X1-BASELINE", r); });
}

/* ====== X2: feTurbulence numOctaves=20, baseFreq=0.0001, 200x200 ====== */
function test_X2() {
  // This is the EXACT feTurbulence from p90
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<defs><filter id="f"><feTurbulence type="fractalNoise" baseFrequency="0.0001" numOctaves="20" seed="42"/></filter></defs>' +
    '<rect width="200" height="200" filter="url(#f)"/></svg>';
  loadSVGviaImage(svg, 8000).then(function(r) { B("X2-TURB20", r); });
}

/* ====== X3: feDisplacementMap scale=9999 via Image, 200x200 ====== */
function test_X3() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<defs><filter id="f">' +
    '<feTurbulence baseFrequency="0.05" numOctaves="3" result="turb"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="turb" scale="9999"/>' +
    '</filter></defs>' +
    '<rect width="200" height="200" filter="url(#f)" fill="green"/></svg>';
  loadSVGviaImage(svg, 5000).then(function(r) { B("X3-DISP9999", r); });
}

/* ====== X4: Path with extreme coordinates via Image ====== */
function test_X4() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<path d="M -999999 -999999 L 999999 999999 L 999999 -999999 Z" fill="red" opacity="0.5"/></svg>';
  loadSVGviaImage(svg, 3000).then(function(r) { B("X4-EXTREME-PATH", r); });
}

/* ====== X5: foreignObject via Image ====== */
function test_X5() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<foreignObject x="0" y="0" width="200" height="200">' +
    '<div xmlns="http://www.w3.org/1999/xhtml" style="color:red">HTML in SVG image</div>' +
    '</foreignObject></svg>';
  loadSVGviaImage(svg, 3000).then(function(r) { B("X5-FOREIGN-IMG", r); });
}

/* ====== X6: Gaussian blur with huge stdDeviation via Image ====== */
function test_X6() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<defs><filter id="f" x="-100%" y="-100%" width="400%" height="400%">' +
    '<feGaussianBlur stdDeviation="50" result="blur"/>' +
    '<feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 20 -10" in="blur" result="cm"/>' +
    '<feComposite in="SourceGraphic" in2="cm" operator="atop"/>' +
    '</filter></defs>' +
    '<rect width="100" height="100" filter="url(#f)" fill="blue"/></svg>';
  loadSVGviaImage(svg, 5000).then(function(r) { B("X6-BLUR-CHAIN", r); });
}

/* ====== X7: ALL filters + foreignObject + extreme path (exact p90 SVG) ====== */
function test_X7() {
  // EXACT reproduction of p90 R4 SVG
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">';
  svg += '<defs>';
  svg += '<filter id="f1" x="-100%" y="-100%" width="400%" height="400%">';
  svg += '<feGaussianBlur stdDeviation="50" result="blur"/>';
  svg += '<feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 20 -10" in="blur" result="cm"/>';
  svg += '<feComposite in="SourceGraphic" in2="cm" operator="atop"/>';
  svg += '</filter>';
  svg += '<filter id="f2">';
  svg += '<feTurbulence type="fractalNoise" baseFrequency="0.0001" numOctaves="20" seed="42"/>';
  svg += '<feDisplacementMap in="SourceGraphic" scale="9999"/>';
  svg += '</filter>';
  svg += '<filter id="f3">';
  svg += '<feFlood flood-color="red" result="flood"/>';
  svg += '<feMerge><feMergeNode in="flood"/><feMergeNode in="SourceGraphic"/></feMerge>';
  svg += '</filter>';
  svg += '</defs>';
  svg += '<foreignObject x="0" y="0" width="200" height="200">';
  svg += '<div xmlns="http://www.w3.org/1999/xhtml" style="color:red">HTML inside SVG</div>';
  svg += '</foreignObject>';
  svg += '<rect width="100" height="100" filter="url(#f1)" fill="blue"/>';
  svg += '<circle cx="50" cy="50" r="50" filter="url(#f2)" fill="green"/>';
  svg += '<path d="M -999999 -999999 L 999999 999999 L 999999 -999999 Z" fill="red" opacity="0.1"/>';
  svg += '</svg>';
  loadSVGviaImage(svg, 10000).then(function(r) { B("X7-FULL-REPRO", r); });
}

/* ====== X8: feTurbulence numOctaves escalation ====== */
function test_X8() {
  // Test numOctaves: 10, 15, 20, 30 — find the crash threshold
  var octaves = [10, 15, 20, 30];
  var results = [];
  var idx = 0;

  function nextOctave() {
    if (idx >= octaves.length) {
      B("X8-OCTAVE-ESCALATE", {results: results.join("|")});
      return;
    }
    var n = octaves[idx];
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<defs><filter id="f"><feTurbulence type="fractalNoise" baseFrequency="0.0001" numOctaves="' + n + '"/></filter></defs>' +
      '<rect width="100" height="100" filter="url(#f)"/></svg>';
    loadSVGviaImage(svg, 6000).then(function(r) {
      results.push("oct" + n + ":" + (r.loaded ? "ok" : r.TIMEOUT ? "TIMEOUT" : "err"));
      idx++;
      nextOctave();
    });
  }
  nextOctave();
}

/* ====== Run — sequential with generous timeouts ====== */
try {
  test_X1(); // 0ms — baseline
  setTimeout(test_X2, 3500);  // feTurbulence (most likely crash source)
  setTimeout(test_X3, 12000); // displacement
  setTimeout(test_X4, 17500); // extreme path
  setTimeout(test_X5, 21000); // foreignObject
  setTimeout(test_X6, 24500); // blur chain
  setTimeout(test_X7, 30000); // full repro (LAST — most likely to crash)
  setTimeout(test_X8, 41000); // octave escalation (LAST-LAST)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe92-done"); }, 80000);
})();
