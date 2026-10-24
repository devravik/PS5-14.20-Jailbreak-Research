/* p124-reentrancy — C++ builtins that call back into JS mid-operation.
 *
 * The binding layer (jsDynamicCast) checks argument types ONCE, at entry. It
 * cannot protect an invariant that JS invalidates *during* the call. This is
 * the largest remaining JIT-free corruption class.
 *
 * Star test: TypedArray.prototype.sort(comparator). WebKit sorts in place over
 * the backing store in C++ and calls the comparator in a loop. If the
 * comparator detaches the buffer, the sort loop keeps writing through a raw
 * pointer. No JIT required.
 *
 * Beacon prefix: P124R-
 */
(function () {
"use strict";

var PREFIX = "P124R";
var RUN = "p124r" + Math.random().toString(36).slice(2, 12);

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

function detach(ab) {
  try { if (typeof ab.transfer === "function") { ab.transfer(); return "transfer()"; } } catch (e) {}
  try { structuredClone(ab, { transfer: [ab] }); return "structuredClone"; } catch (e) {}
  try {
    var ch = new MessageChannel();
    ch.port1.postMessage(null, [ab]); ch.port1.close(); ch.port2.close();
    return "postMessage";
  } catch (e) {}
  return "FAILED";
}

var CAN = new Uint32Array(512);
for (var ci = 0; ci < CAN.length; ci++) CAN[ci] = (0xE0000000 + ci) >>> 0;
function canaryOK() {
  for (var i = 0; i < CAN.length; i++) if (CAN[i] !== ((0xE0000000 + i) >>> 0)) return false;
  return true;
}

/* Guard arrays around the victim: detect silent OOB writes into neighbours. */
function makeGuards(n) {
  var g = [];
  for (var i = 0; i < n; i++) {
    var a = new Uint32Array(4096);
    for (var j = 0; j < a.length; j++) a[j] = (0x600D0000 + i * 7 + j) >>> 0;
    g.push(a);
  }
  return g;
}
function checkGuards(g) {
  for (var i = 0; i < g.length; i++) {
    for (var j = 0; j < g[i].length; j++) {
      if (g[i][j] !== ((0x600D0000 + i * 7 + j) >>> 0)) {
        return { ok: false, guard: i, at: j, val: g[i][j] };
      }
    }
  }
  return { ok: true };
}

var TESTS = [];
function T(name, fn) { TESTS.push([name, fn]); }

/* ============ A. TypedArray sort vs detach/resize ============ */

function taSortDetach(Ctor, mode) {
  var rab = new ArrayBuffer(1 << 16, { maxByteLength: 1 << 16 });
  var ta = new Ctor(rab);
  for (var i = 0; i < ta.length; i++) ta[i] = ta.length - i;
  var guards = makeGuards(4);
  var out = { ctor: Ctor.name, mode: mode, calls: 0, detachAt: -1, detachHow: null };
  try {
    ta.sort(function (a, b) {
      out.calls++;
      if (out.calls === 8) {
        out.detachAt = out.calls;
        if (mode === "detach") out.detachHow = detach(rab);
        else rab.resize(0);
      }
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    out.sortReturned = true;
  } catch (e) {
    out.err = en(e);
  }
  out.taLength = ta.length;
  out.taByteLength = ta.byteLength;
  out.detached = ta.byteLength === 0;
  out.guards = checkGuards(guards);
  // force a read of the (possibly dangling) view
  try { out.first = ta.length ? ta[0] : null; } catch (e) { out.readErr = en(e); }
  return out;
}

T("A1-float64-sort-detach", function () { return taSortDetach(Float64Array, "detach"); });
T("A2-int32-sort-detach", function () { return taSortDetach(Int32Array, "detach"); });
T("A3-uint8-sort-detach", function () { return taSortDetach(Uint8Array, "detach"); });
T("A4-float64-sort-shrink", function () { return taSortDetach(Float64Array, "shrink"); });
T("A5-int32-sort-shrink", function () { return taSortDetach(Int32Array, "shrink"); });

T("A6-tosorted-detach", function () {
  var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
  var ta = new Float64Array(rab);
  for (var i = 0; i < ta.length; i++) ta[i] = ta.length - i;
  var out = { calls: 0 };
  try {
    var r = ta.toSorted(function (a, b) {
      if (out.calls++ === 4) detach(rab);
      return a - b;
    });
    out.len = r.length;
  } catch (e) { out.err = en(e); }
  return out;
});

/* ============ B. Array.prototype.sort vs mutation ============ */

T("B1-sort-length-zero", function () {
  var a = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  var guard = makeGuards(2);
  var out = { calls: 0 };
  try {
    a.sort(function (x, y) {
      if (out.calls++ === 3) a.length = 0;
      return x - y;
    });
  } catch (e) { out.err = en(e); }
  out.len = a.length;
  out.contents = a.slice(0, 20);
  out.guards = checkGuards(guard);
  return out;
});

T("B2-sort-push", function () {
  var a = [5, 4, 3, 2, 1];
  var out = { calls: 0 };
  try {
    a.sort(function (x, y) {
      if (out.calls++ < 50) a.push((out.calls * 13) & 0xff);
      return x - y;
    });
  } catch (e) { out.err = en(e); }
  out.len = a.length;
  return out;
});

T("B3-sort-proxy", function () {
  var target = [5, 4, 3, 2, 1];
  var out = { get: 0, set: 0, del: 0 };
  var p = new Proxy(target, {
    get: function (t, k, r) {
      out.get++;
      if (k === "length") { return t.length; }
      return t[k];
    },
    set: function (t, k, v) {
      out.set++;
      t[k] = v; return true;
    },
    deleteProperty: function (t, k) { out.del++; delete t[k]; return true; },
    has: function (t, k) { return k in t; }
  });
  try { Array.prototype.sort.call(p, function (x, y) { return x - y; }); }
  catch (e) { out.err = en(e); }
  out.target = target.slice();
  return out;
});

T("B4-sort-comparator-throws", function () {
  var a = [3, 1, 2];
  var out = {};
  try {
    a.sort(function () { throw new Error("cmp"); });
  } catch (e) { out.err = en(e); }
  out.arr = a.slice();
  return out;
});

/* ============ C. other builtins with callbacks ============ */

T("C1-join-element-tostring-detach", function () {
  var rab = new ArrayBuffer(4096);
  var ta = new Uint8Array(rab); ta.fill(0x11);
  var a = [1, 2, {
    toString: function () { detach(rab); return "x"; }
  }, 4];
  var out = { joined: a.join(",") };
  out.taLen = ta.length;
  return out;
});

T("C2-concat-spread-getter", function () {
  var out = {};
  var src = [1, 2, 3];
  var obj = {};
  Object.defineProperty(obj, Symbol.isConcatSpreadable, {
    get: function () { src.length = 0; return true; }
  });
  obj.length = 3; obj[0] = 7; obj[1] = 8; obj[2] = 9;
  try { out.res = [].concat(obj).length; } catch (e) { out.err = en(e); }
  out.srcLen = src.length;
  return out;
});

T("C3-json-tojson-mutates", function () {
  var out = {};
  var o = {
    a: 1,
    toJSON: function () { o.b = 2; delete o.a; return { x: 1 }; }
  };
  try { out.s = JSON.stringify(o); } catch (e) { out.err = en(e); }
  return out;
});

T("C4-regex-exec-override", function () {
  var re = /a/g;
  var out = { calls: 0 };
  re.exec = function () {
    out.calls++;
    re.lastIndex = out.calls > 2 ? 0x7fffffff : re.lastIndex;
    return null;
  };
  try { out.res = "aaaa".replace(re, "X"); } catch (e) { out.err = en(e); }
  return out;
});

T("C5-regex-split-override", function () {
  var re = /,/g;
  var out = { calls: 0 };
  re[Symbol.split] = function () {
    out.calls++;
    re.lastIndex = 0x7fffffff;
    return ["a", "b"];
  };
  try { out.res = "a,b,c".split(re); } catch (e) { out.err = en(e); }
  return out;
});

/* ============ D. DOM: custom elements / animations ============ */

T("D1-ce-connected-removes-self", function () {
  if (typeof customElements === "undefined") return { skip: "no customElements" };
  var out = { calls: 0 };
  try {
    var name = "p124-x-" + (Math.random() * 1e9 | 0);
    customElements.define(name, class extends HTMLElement {
      connectedCallback() {
        out.calls++;
        try { this.remove(); } catch (e) { out.removeErr = en(e); }
        try { if (this.parentNode) this.parentNode.insertBefore(document.createElement("b"), this); }
        catch (e) { out.insErr = en(e); }
      }
    });
    var d = document.createElement("div");
    d.innerHTML = "<" + name + "></" + name + "><i>after</i>";
    out.html = d.innerHTML;
    out.children = d.children.length;
  } catch (e) { out.err = en(e); }
  return out;
});

T("D2-ce-attribute-changed-reentrant", function () {
  if (typeof customElements === "undefined") return { skip: "no customElements" };
  var out = { calls: 0 };
  try {
    var name = "p124-y-" + (Math.random() * 1e9 | 0);
    customElements.define(name, class extends HTMLElement {
      static get observedAttributes() { return ["data-a"]; }
      attributeChangedCallback(n, o, v) {
        out.calls++;
        if (out.calls < 6 && v !== "z") this.setAttribute("data-a", "z");
      }
    });
    var el = document.createElement(name);
    document.body.appendChild(el);
    el.setAttribute("data-a", "1");
    out.value = el.getAttribute("data-a");
    out.callsFinal = out.calls;
    el.remove();
  } catch (e) { out.err = en(e); }
  return out;
});

T("D3-ce-adopted-callback", function () {
  if (typeof customElements === "undefined") return { skip: "no customElements" };
  var out = { adopted: 0 };
  try {
    var name = "p124-z-" + (Math.random() * 1e9 | 0);
    customElements.define(name, class extends HTMLElement {
      adoptedCallback() { out.adopted++; }
    });
    var el = document.createElement(name);
    var doc = document.implementation.createHTMLDocument("t");
    doc.body.appendChild(el);
    document.adoptNode(el);
    out.root = el.ownerDocument === document;
  } catch (e) { out.err = en(e); }
  return out;
});

T("D4-animate-keyframe-getter", function () {
  if (typeof Element === "undefined" || !Element.prototype.animate) return { skip: "no animate" };
  var out = {};
  try {
    var el = document.createElement("div");
    document.body.appendChild(el);
    var kf = {};
    Object.defineProperty(kf, "transform", {
      enumerable: true,
      get: function () { el.remove(); return "translateX(10px)"; }
    });
    var anim;
    try { anim = el.animate([kf, { transform: "translateX(20px)" }], 1000); out.anim = "ok"; }
    catch (e) { out.anim = en(e); }
    if (anim) { try { anim.finish(); out.finish = "ok"; } catch (e) { out.finishErr = en(e); } }
  } catch (e) { out.err = en(e); }
  return out;
});

T("D5-range-surroundContents", function () {
  var out = {};
  try {
    var d = document.createElement("div");
    d.innerHTML = "<span>a</span><span>b</span>";
    document.body.appendChild(d);
    var r = document.createRange();
    r.setStart(d, 0); r.setEnd(d, 1);
    var frag = document.createDocumentFragment();
    frag.appendChild(document.createElement("em"));
    r.surroundContents(frag);
    out.html = d.innerHTML;
    d.remove();
  } catch (e) { out.err = en(e); }
  return out;
});

/* ============ runner ============ */
function run() {
  post("L", "p124 start");
  var i = 0;
  function step() {
    if (i >= TESTS.length) { post("Z", "p124 done"); return; }
    var name = TESTS[i][0], fn = TESTS[i][1]; i++;
    mark(name);
    var t0 = Date.now(), done = false;
    var timer = setTimeout(function () { fin({ TIMEOUT: true }); }, 9000);
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
