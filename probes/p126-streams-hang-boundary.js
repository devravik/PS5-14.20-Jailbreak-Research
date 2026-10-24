/* p126-streams-hang-boundary — boundary tests for the two reported Streams hangs.
 *
 * Purpose: distinguish
 *   (A) a spec-mandated liveness wait (composite tee cancel promise; TransformStream
 *       backpressure with no reader), from
 *   (B) an actual wedged state machine / memory-safety bug.
 *
 * Every await is bounded by Promise.race and every test logs a begin/end marker,
 * so a single-shot beacon tells us the exact await that never settled.
 *
 * Expected on WebKit 7616.1.27 (the streams JS in the 14.20 WK1200 tree is
 * byte-identical to that tag):
 *   H1A cancel=PENDING, read=resolved, cancel2=resolved, cancelAfterBoth=resolved
 *   H1B reads resolve while the composite cancel is still pending
 *   H1C both cancel promises resolve only after the second cancel
 *   H1D/H1E source close/error resolves the pending cancel
 *   H1F structuredClone/history/replaceState/transfer throw DataCloneError
 *   H2A write1=resolved, write2/write3=PENDING, sizeCalls=1  (backpressure)
 *   H2B write3/read3=rejected RangeError, sizeCalls=3        (the -999 path)
 *   H2C NaN/-1/-Infinity reject; 0/1e308 accept
 *   H2D huge finite size poisons queue.size to +Infinity (desiredSize -Infinity)
 *
 * Beacon prefix: P126S-
 */
(function () {
"use strict";

var PREFIX = "P126S";
var RUN = "p126s" + Math.random().toString(36).slice(2, 12);

function post(tag, body) {
  var s = typeof body === "string" ? body : JSON.stringify(body);
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/" + PREFIX + "-" + tag, false);
    x.setRequestHeader("Content-Type", "application/json");
    x.send(JSON.stringify({ r: RUN, b: s }));
  } catch (e) {}
}
function mark(s) { post("M", s); }

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* race(p, ms, label) -> {s:"resolved"|"rejected"|"PENDING", v?, e?, label?} */
function race(p, ms, label) {
  return Promise.race([
    Promise.resolve(p).then(
      function (v) { return { s: "resolved", v: v }; },
      function (e) { return { s: "rejected", e: (e && e.name) + ":" + String((e && e.message) || "").slice(0, 90) }; }
    ),
    delay(ms).then(function () { return { s: "PENDING", label: label }; })
  ]);
}
function rs(x) { return x.s + (x.e ? ":" + x.e : ""); }
function rd(x) {
  if (x.s !== "resolved") return rs(x);
  var v = x.v;
  if (v && typeof v === "object" && "done" in v) return v.done ? "done" : "chunk";
  return "resolved";
}

var TESTS = [];
function T(name, fn) { TESTS.push([name, fn]); }

/* ------------------------------------------------------------------ */
/* HANG 1: tee + one-branch cancel                                     */
/* ------------------------------------------------------------------ */

T("H1A-CANCEL-BOUNDARY", async function () {
  var ctrl;
  var rs0 = new ReadableStream({
    start: function (c) { ctrl = c; },
    pull: function (c) { c.enqueue(new Uint8Array(8)); }
  });
  var br = rs0.tee(), b0 = br[0], b1 = br[1];
  var r1 = b0.getReader();
  for (var i = 0; i < 3; i++) await r1.read();
  r1.releaseLock();

  var pc = b0.cancel("test");
  var c = await race(pc, 400, "cancel");
  var r2 = b1.getReader();
  var read = await race(r2.read(), 400, "read");
  r2.releaseLock();
  var pc2 = b1.cancel("test2");
  var c2 = await race(pc2, 400, "cancel2");
  var c1b = await race(pc, 300, "cancel-after-both");

  return { cancel: rs(c), read: rd(read), cancel2: rs(c2), cancelAfterBoth: rs(c1b) };
});

T("H1B-READ-WITHOUT-AWAIT", async function () {
  var rs0 = new ReadableStream({ pull: function (c) { c.enqueue(new Uint8Array([1])); } });
  var br = rs0.tee(), b0 = br[0], b1 = br[1];
  var r1 = b0.getReader();
  for (var i = 0; i < 3; i++) await r1.read();
  r1.releaseLock();

  var pc = b0.cancel("test");           /* deliberately not awaited */
  var r2 = b1.getReader();
  var reads = [];
  for (var j = 0; j < 2; j++) reads.push(rd(await race(r2.read(), 400, "read" + j)));
  var still = await race(pc, 150, "pc");
  r2.releaseLock();
  b1.cancel("cleanup");
  var after = await race(pc, 400, "pc-after");
  return { reads: reads, cancelBefore: rs(still), cancelAfter: rs(after) };
});

T("H1C-BOTH-CANCEL", async function () {
  var rs0 = new ReadableStream({ pull: function (c) { c.enqueue(1); } });
  var br = rs0.tee();
  var p0 = br[0].cancel("a");
  var first = await race(p0, 250, "p0-before");
  var p1 = br[1].cancel("b");
  var r0 = await race(p0, 400, "p0");
  var r1 = await race(p1, 400, "p1");
  return { beforeSecond: rs(first), p0: rs(r0), p1: rs(r1) };
});

T("H1D-UNBLOCK-CLOSE", async function () {
  var ctrl, n = 0;
  var rs0 = new ReadableStream({
    start: function (c) { ctrl = c; },
    pull: function (c) { if (++n > 4) c.close(); else c.enqueue(n); }
  }, { highWaterMark: 0 });
  var br = rs0.tee(), b0 = br[0], b1 = br[1];
  var r1 = b0.getReader();
  await r1.read();
  r1.releaseLock();
  var pc = b0.cancel("x");
  var before = await race(pc, 200, "pc-before");
  var closeErr = "ok";
  try { ctrl.close(); } catch (e) { closeErr = e.name; }
  var after = await race(pc, 400, "pc-after");
  var r2 = b1.getReader();
  var read = await race(r2.read(), 300, "r2");
  return { before: rs(before), closeErr: closeErr, after: rs(after), read: rd(read) };
});

T("H1E-UNBLOCK-ERROR", async function () {
  var ctrl;
  var rs0 = new ReadableStream({
    start: function (c) { ctrl = c; },
    pull: function (c) { c.enqueue(1); }
  });
  var br = rs0.tee(), b0 = br[0], b1 = br[1];
  var r1 = b0.getReader();
  await r1.read();
  r1.releaseLock();
  var pc = b0.cancel("x");
  var before = await race(pc, 200, "pc-before");
  var err = new Error("boom");
  ctrl.error(err);
  var after = await race(pc, 400, "pc-after");
  var r2 = b1.getReader();
  var read = await race(r2.read(), 300, "r2");
  return { before: rs(before), after: rs(after), read: rs(read) };
});

T("H1F-SERIALIZE-TRANSFER", async function () {
  var out = {};
  var base = new ReadableStream({ pull: function (c) { c.enqueue(1); } });
  var b = base.tee()[0];

  try { structuredClone(b); out.clone = "ok"; } catch (e) { out.clone = e.name; }
  try { history.replaceState(b, ""); out.history = "ok"; } catch (e) { out.history = e.name; }

  var r = b.getReader();
  try { window.postMessage(b, "*", [b]); out.transferLocked = "ok"; } catch (e) { out.transferLocked = e.name; }
  r.releaseLock();
  try { window.postMessage(b, "*", [b]); out.transferUnlocked = "ok"; } catch (e) { out.transferUnlocked = e.name; }

  var b2 = new ReadableStream({ pull: function (c) { c.enqueue(1); } }).tee()[0];
  b2.cancel("x");
  try { window.postMessage(b2, "*", [b2]); out.transferDisturbed = "ok"; } catch (e) { out.transferDisturbed = e.name; }
  return out;
});

T("H1G-OPS-ON-STUCK", async function () {
  var out = {};
  var mk = function () { return new ReadableStream({ pull: function (c) { c.enqueue(1); } }).tee()[0]; };

  var a = mk(), ra = a.getReader();
  try { a.getReader(); out.getLocked = "ok"; } catch (e) { out.getLocked = e.name; }
  try { a.tee(); out.teeLocked = "ok"; } catch (e) { out.teeLocked = e.name; }
  var ca = await race(a.cancel("x"), 200, "cancelLocked");
  out.cancelLocked = rs(ca);
  ra.releaseLock();

  var b = mk(), rb = b.getReader(); rb.releaseLock();
  try { var r2 = b.getReader(); out.getUnlocked = "ok"; r2.releaseLock(); } catch (e) { out.getUnlocked = e.name; }
  try { var pair = b.tee(); out.teeUnlocked = pair.length; } catch (e) { out.teeUnlocked = e.name; }
  return out;
});

/* ------------------------------------------------------------------ */
/* HANG 2: TransformStream custom readable size                        */
/* ------------------------------------------------------------------ */

T("H2A-NO-READER-BACKPRESSURE", async function () {
  var calls = 0;
  var ts = new TransformStream(
    { transform: function (c, ctrl) { ctrl.enqueue(c); } },
    undefined,
    { highWaterMark: 1, size: function () { calls++; return calls === 3 ? -999 : 1; } }
  );
  var w = ts.writable.getWriter();
  var p1 = w.write(new Uint8Array([0]));
  var p2 = w.write(new Uint8Array([1]));
  var p3 = w.write(new Uint8Array([2]));
  var w1 = await race(p1, 400, "w1");
  var w2 = await race(p2, 400, "w2");
  var w3 = await race(p3, 400, "w3");
  return { w1: rs(w1), w2: rs(w2), w3: rs(w3), calls: calls };
});

T("H2B-READER-PACED", async function () {
  var calls = 0;
  var ts = new TransformStream(
    { transform: function (c, ctrl) { ctrl.enqueue(c); } },
    undefined,
    { highWaterMark: 1, size: function () { calls++; return calls === 3 ? -999 : 1; } }
  );
  var w = ts.writable.getWriter();
  var r = ts.readable.getReader();
  var seq = [];
  for (var i = 0; i < 3; i++) {
    var wp = w.write(new Uint8Array([i]));
    var rp = r.read();
    var wr = await race(wp, 400, "w" + i);
    var rr = await race(rp, 400, "r" + i);
    seq.push([rs(wr), rd(rr)]);
  }
  return { seq: seq, calls: calls };
});

T("H2C-SIZE-VARIANTS", async function () {
  var vals = [NaN, -1, -Infinity, -999, 0, 1e308];
  var keys = ["NaN", "neg1", "negInf", "neg999", "zero", "huge"];
  var out = {};
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    var ts = new TransformStream(
      { transform: function (c, ctrl) { ctrl.enqueue(c); } },
      undefined,
      { highWaterMark: 1, size: function () { return v; } }
    );
    var w = ts.writable.getWriter();
    var r = ts.readable.getReader();
    var wp = w.write(new Uint8Array([0]));
    var rp = r.read();
    var wr = await race(wp, 250, "w");
    var rr = await race(rp, 250, "r");
    out[keys[i]] = rs(wr) + "|" + rd(rr);
  }
  return out;
});

T("H2D-SIZE-OVERFLOW", async function () {
  var ctrl;
  var stream = new ReadableStream(
    { start: function (c) { ctrl = c; }, pull: function () {} },
    { highWaterMark: 1, size: function () { return 1e308; } }
  );
  ctrl.enqueue("a");
  ctrl.enqueue("b");                 /* queue.size = 1e308 + 1e308 = Infinity */
  var d1 = String(ctrl.desiredSize);
  var r = stream.getReader();
  var a = await race(r.read(), 250, "r1");
  var b = await race(r.read(), 250, "r2");
  var d2 = String(ctrl.desiredSize); /* Infinity - 1e308 is still Infinity */
  return { desiredAfterEnqueue: d1, desiredAfterDrain: d2, r1: rd(a), r2: rd(b) };
});

/* ------------------------------------------------------------------ */

async function run() {
  mark("start");
  for (var i = 0; i < TESTS.length; i++) {
    var name = TESTS[i][0], fn = TESTS[i][1];
    mark("begin:" + name);
    var res;
    try {
      res = await race(fn(), 6000, name);
    } catch (e) {
      res = { s: "threw", e: String(e && e.message) };
    }
    post("R-" + name, res);
    mark("end:" + name);
    await delay(40);
  }
  mark("done");
}

setInterval(function () { post("HB", "hb"); }, 2000);
setTimeout(run, 200);
})();
