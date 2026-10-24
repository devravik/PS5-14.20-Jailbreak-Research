/* p122-streams-state — stream state machines: re-entrancy + GC liveness.
 *
 * Two bug classes:
 *   (1) RE-ENTRANCY: a user callback (size/pull/transform/write) runs while a
 *       C++ controller is mid-mutation. Nested controller calls corrupt the
 *       queue/list invariants.
 *   (2) GC LIVENESS: a reader is dropped while a NATIVE source has a pending
 *       read. WebKit bug 303460 ("ReadableStream readers should not be GCed if
 *       having pending read requests for native sources", fixed 2025-12) is
 *       exactly this and post-dates your build.
 *
 * Controlled ordering for (2): use a CompressionStream/TransformStream, take a
 * read(), DROP the reader, force GC, and only THEN push data through the
 * writable side. That makes "reader freed before delivery" deterministic.
 *
 * Beacon prefix: P122S-
 */
(function () {
"use strict";

var PREFIX = "P122S";
var RUN = "p122s" + Math.random().toString(36).slice(2, 12);

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
function en(e) { return e && (e.name + ":" + String(e.message).slice(0, 90)); }

var CAN = new Uint32Array(512);
for (var ci = 0; ci < CAN.length; ci++) CAN[ci] = (0xB0000000 + ci) >>> 0;
function canaryOK() {
  for (var i = 0; i < CAN.length; i++) if (CAN[i] !== ((0xB0000000 + i) >>> 0)) return false;
  return true;
}

/* Async best-effort full GC. A WeakRef target cannot be collected inside the
 * job that created it, so the churn has to cross macrotask boundaries. */
function forceGC(rounds) {
  if (typeof gc === "function") { try { gc(); return Promise.resolve("gc()"); } catch (e) {} }
  var probe = { p: 1 };
  var wr = (typeof WeakRef === "function") ? new WeakRef(probe) : null;
  probe = null;
  var n = 0, max = rounds || 14;
  function round() {
    if (n++ >= max) return Promise.resolve(wr ? "weakref-alive" : "best-effort");
    var junk = new Array(30000);
    for (var i = 0; i < junk.length; i++) junk[i] = { i: i, s: "j" + i };
    junk = null;
    for (var b = 0; b < 8; b++) new ArrayBuffer(1 << 20);
    return delay(15).then(function () {
      if (wr && !wr.deref()) return "weakref-cleared@" + n;
      return round();
    });
  }
  return Promise.resolve().then(round);
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var TESTS = [];
function T(name, fn) { TESTS.push([name, fn]); }

/* ================= (1) re-entrancy ================= */

T("R1-size-reenters-enqueue", function () {
  var ctrl = null, nested = 0, seen = [];
  var rs = new ReadableStream({
    start: function (c) { ctrl = c; },
    pull: function () {}
  }, {
    highWaterMark: 8,
    size: function (chunk) {
      if (nested < 1) { nested++; try { ctrl.enqueue("nested"); } catch (e) { seen.push("nest:" + en(e)); } }
      return 1;
    }
  });
  ctrl.enqueue("outer");
  var r = rs.getReader();
  var out = { nested: nested, size: rs.desiredSize, notes: seen };
  return r.read().then(function (a) {
    out.c1 = a.value;
    return r.read();
  }).then(function (b) { out.c2 = b.value; return out; },
          function (e) { out.readErr = en(e); return out; });
});

T("R2-size-throws", function () {
  var ctrl = null;
  var rs = new ReadableStream({ start: function (c) { ctrl = c; } },
    { highWaterMark: 4, size: function () { throw new Error("size-boom"); } });
  var r = rs.getReader();
  var out = {};
  try { ctrl.enqueue(1); out.enqueue = "no-throw"; } catch (e) { out.enqueue = en(e); }
  return r.read().then(function (x) { out.read = x; return out; },
                       function (e) { out.readErr = en(e); return out; });
});

T("R3-pull-reenters-close-enqueue", function () {
  var notes = [];
  var rs = new ReadableStream({
    pull: function (c) {
      try { c.enqueue("a"); } catch (e) { notes.push("enq1:" + en(e)); }
      try { c.close(); } catch (e) { notes.push("close:" + en(e)); }
      try { c.enqueue("b"); notes.push("ENQ-AFTER-CLOSE-DID-NOT-THROW"); }
      catch (e) { notes.push("enq2:" + en(e)); }
    }
  });
  var r = rs.getReader();
  return r.read().then(function (x) {
    return r.read().then(function (y) {
      return { first: x.value, done2: y.done, notes: notes };
    }, function (e) { return { first: x.value, err2: en(e), notes: notes }; });
  });
});

T("R4-two-pending-reads-then-error", function () {
  var ctrl = null;
  var rs = new ReadableStream({ start: function (c) { ctrl = c; } });
  var r = rs.getReader();
  var p1 = r.read(), p2 = r.read();
  ctrl.error(new Error("boom"));
  return Promise.all([
    p1.then(function (x) { return "res:" + x.value; }, function (e) { return "rej:" + en(e); }),
    p2.then(function (x) { return "res:" + x.value; }, function (e) { return "rej:" + en(e); })
  ]).then(function (a) { return { p1: a[0], p2: a[1] }; });
});

T("R5-cancel-during-pending-read", function () {
  var cancelled = 0;
  var rs = new ReadableStream({
    pull: function () { return new Promise(function () {}); },  // never settles
    cancel: function (r) { cancelled++; }
  });
  var r = rs.getReader();
  var p = r.read();
  var pc = r.cancel("stop");
  return Promise.race([p.then(function (x) { return { read: x.done ? "done" : "value" }; },
                              function (e) { return { readErr: en(e) }; }),
                       delay(1500).then(function () { return { read: "PENDING" }; })])
    .then(function (a) {
      return Promise.race([pc.then(function () { return "cancelled"; }, function (e) { return "cancelErr:" + en(e); }),
                           delay(1500).then(function () { return "CANCEL-PENDING"; })])
        .then(function (b) { return { read: a, cancel: b, cancelled: cancelled }; });
    });
});

T("R6-releaseLock-with-pending-read", function () {
  var rs = new ReadableStream({ pull: function () { return new Promise(function () {}); } });
  var r = rs.getReader();
  var p = r.read();
  var out = {};
  try { r.releaseLock(); out.release = "ok"; } catch (e) { out.release = en(e); }
  return Promise.race([p.then(function (x) { return { read: x.done ? "done" : "value" }; },
                              function (e) { return { readErr: en(e) }; }),
                       delay(1500).then(function () { return { read: "PENDING-AFTER-RELEASE" }; })])
    .then(function (a) { out.read = a; return out; });
});

T("R7-tee-cancel-both-during-pull", function () {
  var pulls = 0;
  var rs = new ReadableStream({
    pull: function (c) { pulls++; if (pulls < 3) c.enqueue(pulls); }
  });
  var pair = rs.tee();
  var a = pair[0], b = pair[1];
  var ra = a.getReader(), rb = b.getReader();
  var p1 = ra.read(), p2 = rb.read();
  var out = { pulls: 0 };
  return Promise.all([
    ra.cancel("a").then(function () { return "a-cancelled"; }, function (e) { return "aErr:" + en(e); }),
    rb.cancel("b").then(function () { return "b-cancelled"; }, function (e) { return "bErr:" + en(e); })
  ]).then(function (c) {
    out.cancels = c; out.pulls = pulls;
    return Promise.all([
      Promise.race([p1, delay(800).then(function () { return "a-pending"; })]),
      Promise.race([p2, delay(800).then(function () { return "b-pending"; })])
    ]);
  }).then(function (r) { out.reads = r; return out; });
});

/* ================= TransformStream ================= */

T("T1-terminate-then-enqueue", function () {
  var out = {};
  var ts = new TransformStream({
    transform: function (chunk, c) {
      try { c.enqueue(chunk); out.enq1 = "ok"; } catch (e) { out.enq1 = en(e); }
      try { c.terminate(); out.term = "ok"; } catch (e) { out.term = en(e); }
      try { c.enqueue("after-terminate"); out.ENQ_AFTER_TERM = "NO-THROW"; }
      catch (e) { out.enq2 = en(e); }
    }
  });
  var w = ts.writable.getWriter();
  var r = ts.readable.getReader();
  return w.write("x").then(function () {
    return Promise.race([r.read().then(function (a) { return a.value; }),
                         delay(1000).then(function () { return "PENDING"; })]);
  }).then(function (v) { out.read = v; return out; },
          function (e) { out.err = en(e); return out; });
});

T("T2-abort-inside-transform", function () {
  var out = { order: [] };
  var ts = new TransformStream({
    transform: function (chunk, c) {
      out.order.push("transform");
      c.enqueue(chunk);
      return w.abort("abort-from-transform").then(function () { out.order.push("abort-ok"); },
                                                  function (e) { out.order.push("abort-err:" + en(e)); });
    }
  });
  var w = ts.writable.getWriter();
  var r = ts.readable.getReader();
  var pw = w.write("a");
  return Promise.race([
    Promise.all([
      pw.then(function () { return "write-ok"; }, function (e) { return "write-err:" + en(e); }),
      r.read().then(function (x) { return "read:" + x.value; }, function (e) { return "read-err:" + en(e); })
    ]),
    delay(2000).then(function () { return ["TIMEOUT"]; })
  ]).then(function (a) { out.res = a; return out; });
});

T("T3-error-in-flush", function () {
  var out = {};
  var ts = new TransformStream({
    flush: function (c) { c.error(new Error("flush-boom")); }
  });
  var w = ts.writable.getWriter();
  var r = ts.readable.getReader();
  return w.write("a").then(function () { return w.close(); }).then(function () {
    return Promise.race([r.read().then(function (x) { return { v: x.value, done: x.done }; },
                                      function (e) { return { readErr: en(e) }; }),
                         delay(1200).then(function () { return { read: "PENDING" }; })]);
  }).then(function (x) { out.read = x; return out; },
          function (e) { out.err = en(e); return out; });
});

T("T4-transform-enqueues-after-error", function () {
  var out = {};
  var ts = new TransformStream({
    transform: function (chunk, c) {
      c.error(new Error("te"));
      try { c.enqueue("after-error"); out.ENQ = "NO-THROW"; } catch (e) { out.enq = en(e); }
      try { c.terminate(); out.TERM = "NO-THROW"; } catch (e) { out.term = en(e); }
    }
  });
  var w = ts.writable.getWriter();
  return w.write("a").then(function () { out.write = "ok"; }, function (e) { out.write = en(e); })
    .then(function () { return out; });
});

/* ================= WritableStream ================= */

T("W1-abort-during-inflight-write", function () {
  var out = { events: [] };
  var resolveWrite = null;
  var ws = new WritableStream({
    write: function (chunk) {
      out.events.push("write:" + chunk);
      return new Promise(function (res) { resolveWrite = res; });
    },
    abort: function (reason) { out.events.push("abort:" + reason); }
  });
  var w = ws.getWriter();
  var pw = w.write("a");
  var pa = w.abort("stop");
  out.events.push("abort-called");
  setTimeout(function () { if (resolveWrite) resolveWrite(); }, 100);
  return Promise.race([
    Promise.all([
      pw.then(function () { return "write-ok"; }, function (e) { return "write-err:" + en(e); }),
      pa.then(function () { return "abort-ok"; }, function (e) { return "abort-err:" + en(e); })
    ]),
    delay(2000).then(function () { return ["TIMEOUT"]; })
  ]).then(function (r) { out.res = r; return out; });
});

T("W2-write-after-close", function () {
  var out = {};
  var ws = new WritableStream({ write: function () {} });
  var w = ws.getWriter();
  return w.close().then(function () {
    return w.write("x").then(function () { out.write = "NO-THROW"; },
                              function (e) { out.write = en(e); });
  }).then(function () {
    try { w.releaseLock(); out.release = "ok"; } catch (e) { out.release = en(e); }
    return out;
  });
});

T("W3-weird-highwatermark", function () {
  var out = {};
  var vals = [NaN, Infinity, -Infinity, 1e308, -1];
  for (var i = 0; i < vals.length; i++) {
    try {
      var rs = new ReadableStream({ start: function (c) { c.enqueue(1); } },
                                  { highWaterMark: vals[i] });
      out["hwm" + i] = String(rs.desiredSize);
    } catch (e) { out["hwm" + i] = en(e); }
  }
  return out;
});

T("W4-size-negative-infinity", function () {
  var ctrl = null;
  var rs = new ReadableStream({ start: function (c) { ctrl = c; } },
                              { highWaterMark: 1, size: function () { return -Infinity; } });
  var out = {};
  for (var i = 0; i < 16; i++) {
    try { ctrl.enqueue(i); } catch (e) { out.err = en(e); break; }
  }
  out.desired = String(rs.desiredSize);
  out.len = i;
  return out;
});

/* ================= (2) GC liveness ================= */

T("G1-compression-reader-gc-pending", function () {
  if (typeof CompressionStream !== "function") return { skip: "no CompressionStream" };
  var cs = new CompressionStream("deflate");
  var w = cs.writable.getWriter();
  var r = cs.readable.getReader();
  var p = r.read();                 // pending
  r = null;                         // drop the reader wrapper
  return forceGC(16).then(function (how) {   // collect BEFORE any data exists
    var payload = new Uint8Array(4096); payload.fill(0x41);
    return w.write(payload).then(function () { return w.close(); }).then(function () {
      return Promise.race([p.then(function (x) { return { got: x.value ? x.value.byteLength : 0, done: x.done }; },
                                  function (e) { return { rej: en(e) }; }),
                           delay(3000).then(function () { return { state: "PENDING" }; })]);
    }).then(function (x) { return { gc: how, read: x }; },
            function (e) { return { gc: how, writeErr: en(e) }; });
  });
});

T("G2-blob-stream-reader-gc", function () {
  var blob = new Blob([new Uint8Array(1 << 20)]);
  var s = blob.stream();
  var r = s.getReader();
  var p = r.read();
  r = null; s = null;
  return forceGC(16).then(function (how) {
    return Promise.race([p.then(function (x) { return { len: x.value ? x.value.byteLength : 0 }; },
                                function (e) { return { rej: en(e) }; }),
                         delay(3000).then(function () { return { state: "PENDING" }; })])
      .then(function (x) { return { gc: how, read: x }; });
  });
});

T("G3-transform-reader-gc-pending", function () {
  var ts = new TransformStream();
  var w = ts.writable.getWriter();
  var r = ts.readable.getReader();
  var p = r.read();
  r = null;
  return forceGC(16).then(function (how) {
    return w.write("x").then(function () {
      return Promise.race([p.then(function (x) { return { v: x.value }; },
                                  function (e) { return { rej: en(e) }; }),
                           delay(3000).then(function () { return { state: "PENDING" }; })]);
    }).then(function (x) { return { gc: how, read: x }; },
            function (e) { return { gc: how, err: en(e) }; });
  });
});

T("G4-writer-gc-with-pending-write", function () {
  var resolveW = null;
  var ws = new WritableStream({
    write: function () { return new Promise(function (res) { resolveW = res; }); }
  });
  var w = ws.getWriter();
  var p = w.write("a");
  w = null; ws = null;
  return forceGC(16).then(function (how) {
    if (resolveW) resolveW();
    return Promise.race([p.then(function () { return "resolved"; }, function (e) { return "rej:" + en(e); }),
                         delay(2000).then(function () { return "PENDING"; })])
      .then(function (x) { return { gc: how, write: x }; });
  });
});

/* ================= runner ================= */
function run() {
  post("L", "p122 start");
  var i = 0;
  function step() {
    if (i >= TESTS.length) { post("Z", "p122 done"); return; }
    var name = TESTS[i][0], fn = TESTS[i][1]; i++;
    mark(name);
    var t0 = Date.now(), done = false;
    var timer = setTimeout(function () { fin({ TIMEOUT: true }); }, 12000);
    function fin(res) {
      if (done) return; done = true; clearTimeout(timer);
      res = res || {}; res.ms = Date.now() - t0; res.canary = canaryOK();
      post(name, res);
      setTimeout(step, 150);
    }
    try {
      var r = fn();
      if (r && typeof r.then === "function") {
        var raced = Promise.race([r, new Promise(function (res) { setTimeout(function () { res({ RACE_TIMEOUT: true }); }, 5500); })]);
        raced.then(function (v) { fin({ ok: true, v: v }); },
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
