/* p123-deflate-malformed — zlib/brotli wrapper state machine, not zlib itself.
 *
 * zlib's inflate is heavily fuzzed; the soft target is WebKit's ZStream /
 * DecompressionStream wrapper: Z_NEED_DICT, Z_BUF_ERROR, Z_STREAM_END with
 * trailing bytes, abort()/close() while a write is queued, and writes after
 * the stream has errored.
 *
 * Public WebKit fixes in this exact file:
 *   - "ZStream::~ZStream() should call inflateEnd() for decompression mode"
 *   - bug 307952 "DecompressionStream should output valid data before throwing
 *     for extra trailing bytes"
 * Both are recent; assume your fork predates them.
 *
 * Beacon prefix: P123D-
 */
(function () {
"use strict";

var PREFIX = "P123D";
var RUN = "p123d" + Math.random().toString(36).slice(2, 12);

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

var CAN = new Uint32Array(512);
for (var ci = 0; ci < CAN.length; ci++) CAN[ci] = (0xD0000000 + ci) >>> 0;
function canaryOK() {
  for (var i = 0; i < CAN.length; i++) if (CAN[i] !== ((0xD0000000 + i) >>> 0)) return false;
  return true;
}

/* ---------- byte builders ---------- */
function bytes() {
  var a = Array.prototype.slice.call(arguments), out = [];
  for (var i = 0; i < a.length; i++) {
    var v = a[i];
    if (Array.isArray(v)) out = out.concat(v); else out.push(v & 0xff);
  }
  return new Uint8Array(out);
}
function utf8(s) {
  var e = unescape(encodeURIComponent(s)), u = new Uint8Array(e.length);
  for (var i = 0; i < e.length; i++) u[i] = e.charCodeAt(i);
  return u;
}
function concat(list) {
  var n = 0, i;
  for (i = 0; i < list.length; i++) n += list[i].length;
  var out = new Uint8Array(n), o = 0;
  for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
  return out;
}
function rand(n, seed) {
  var u = new Uint8Array(n), x = seed || 0x12345678;
  for (var i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; u[i] = (x >>> 16) & 0xff; }
  return u;
}

var MALFORMED = {
  /* zlib CMF/FLG with FDICT=1 + DICTID -> inflate returns Z_NEED_DICT */
  "zlib-fdict": bytes(0x78, 0x20, 0, 0, 0, 0),
  /* BTYPE=3 is reserved */
  "zlib-reserved-block": bytes(0x78, 0x9c, 0x07, 0xde, 0xad),
  /* stored block with LEN=5 but NLEN=0 */
  "zlib-stored-badnlen": bytes(0x78, 0x9c, 0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5),
  /* dynamic Huffman header truncated mid-tree */
  "zlib-trunc-dynamic": bytes(0x78, 0x9c, 0x05, 0x00, 0x00, 0x00, 0x00),
  /* HLIT=286/HDIST=30/HCLEN=15 then zeros -> incomplete code */
  "zlib-empty-tree": bytes(0x78, 0x9c, 0x05, 0xfe, 0xff, 0xff, 0x0f, 0, 0, 0, 0),
  /* back-reference beyond window */
  "zlib-far-dist": bytes(0x78, 0x9c, 0x63, 0x00, 0x02, 0x00),
  /* raw deflate random */
  "raw-random": rand(64, 0xdeadbeef),
  /* gzip: FEXTRA declared XLEN=1, no payload */
  "gzip-fextra-trunc": bytes(0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0xff, 0x01, 0x00),
  /* gzip: FNAME with no NUL terminator */
  "gzip-fname-trunc": bytes(0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 0xff, 0x41, 0x42, 0x43),
  /* gzip: FHCRC set, header CRC absent */
  "gzip-fhcrc-trunc": bytes(0x1f, 0x8b, 0x08, 0x02, 0, 0, 0, 0, 0, 0xff),
  /* gzip: valid 10-byte header, then nothing */
  "gzip-empty": bytes(0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff)
};

/* Compress with the platform itself so the bytes are definitely valid. */
function compress(fmt, data) {
  var cs = new CompressionStream(fmt);
  var w = cs.writable.getWriter();
  var r = cs.readable.getReader();
  var parts = [], total = 0;
  var reading = (function loop() {
    return r.read().then(function (x) {
      if (x.done) return;
      parts.push(x.value); total += x.value.byteLength;
      return loop();
    });
  })();
  return w.write(data).then(function () { return w.close(); })
    .then(function () { return reading; })
    .then(function () { return concat(parts); });
}

/* Feed chunks into a DecompressionStream; cap output to avoid OOM. */
function feed(fmt, chunks, opts) {
  opts = opts || {};
  var out = { fmt: fmt, inChunks: chunks.length, outChunks: 0, outBytes: 0 };
  var ds;
  try { ds = new DecompressionStream(fmt); }
  catch (e) { out.ctorErr = en(e); return Promise.resolve(out); }

  var w = ds.writable.getWriter();
  var r = ds.readable.getReader();
  var cap = opts.cap || (64 << 20);

  var reading = (function loop() {
    return r.read().then(function (x) {
      if (x.done) { out.done = true; return; }
      out.outChunks++; out.outBytes += x.value.byteLength;
      if (out.outBytes > cap) { out.CAP = true; return r.cancel(); }
      return loop();
    });
  })();

  var writing = (function wloop(i) {
    if (i >= chunks.length) {
      if (opts.abortAtEnd) return w.abort("end-abort");
      return w.close();
    }
    if (opts.abortAt === i) return w.abort("mid-abort");
    return w.write(chunks[i]).then(function () { return wloop(i + 1); },
                                   function (e) { out.writeErr = en(e); });
  })(0);

  return Promise.race([
    Promise.all([reading["catch"](function (e) { out.readErr = en(e); }),
                 writing["catch"](function (e) { out.writeErr = out.writeErr || en(e); })]),
    delay(opts.timeout || 6000)
  ]).then(function () { return out; });
}

function fmtFor(name) {
  if (name.indexOf("gzip") === 0) return "gzip";
  if (name.indexOf("raw") === 0) return "deflate-raw";
  return "deflate";
}

var TESTS = [], VALID = {};
function T(name, fn) { TESTS.push([name, fn]); }

/* ---- A. malformed corpus, one chunk ---- */
T("A1-corpus-single-chunk", function () {
  var fmtList = ["deflate", "gzip", "deflate-raw"];
  var names = Object.keys(MALFORMED);
  var i = 0, out = {};
  function next() {
    if (i >= names.length) return Promise.resolve(out);
    var nm = names[i++];
    return feed(fmtFor(nm), [MALFORMED[nm]], { timeout: 2500 }).then(function (r) {
      out[nm] = { err: r.writeErr || r.readErr || r.ctorErr || null, bytes: r.outBytes, cap: !!r.CAP };
      return next();
    });
  }
  return next();
});

/* ---- B. same bytes, 1 byte at a time (state machine stress) ---- */
T("B1-fdict-bytewise", function () {
  var b = MALFORMED["zlib-fdict"];
  var chunks = [];
  for (var i = 0; i < b.length; i++) chunks.push(b.subarray(i, i + 1));
  return feed("deflate", chunks, { timeout: 4000 });
});

T("B2-gzip-bytewise", function () {
  var b = MALFORMED["gzip-fextra-trunc"];
  var chunks = [];
  for (var i = 0; i < b.length; i++) chunks.push(b.subarray(i, i + 1));
  return feed("gzip", chunks, { timeout: 4000 });
});

/* ---- C. valid stream, truncated at every offset ---- */
T("C1-truncate-valid-stream", function () {
  if (typeof CompressionStream !== "function") return { skip: "no CompressionStream" };
  return compress("deflate", utf8("the quick brown fox jumps over the lazy dog"))
    .then(function (z) {
      var i = 0, out = { total: z.length, results: [] };
      function next() {
        if (i > z.length) return Promise.resolve(out);
        var cut = z.subarray(0, i);
        return feed("deflate", [cut], { timeout: 1200 }).then(function (r) {
          out.results.push({ at: i, err: r.writeErr || r.readErr || null, bytes: r.outBytes });
          i++;
          return next();
        });
      }
      return next();
    });
});

/* ---- D. concatenated members + trailing garbage ---- */
T("D1-gzip-concat", function () {
  return Promise.all([compress("gzip", utf8("AAA")), compress("gzip", utf8("BBB"))])
    .then(function (p) {
      return feed("gzip", [concat([p[0], p[1]])], { timeout: 3000 });
    }).then(function (r) { return { outBytes: r.outBytes, err: r.writeErr || r.readErr }; });
});

T("D2-gzip-trailing-garbage", function () {
  return compress("gzip", utf8("AAA")).then(function (g) {
    return feed("gzip", [concat([g, rand(32, 7)])], { timeout: 3000 });
  }).then(function (r) {
    return { outBytes: r.outBytes, err: r.writeErr || r.readErr, cap: !!r.CAP };
  });
});

/* ---- E. decompression bomb: output growth / queue pressure ---- */
T("E1-bomb-16mb-zeros", function () {
  if (typeof CompressionStream !== "function") return { skip: "no CompressionStream" };
  var big = new Uint8Array(16 << 20);
  return compress("deflate", big).then(function (z) {
    return feed("deflate", [z], { timeout: 12000, cap: 256 << 20 }).then(function (r) {
      return { compressed: z.length, outBytes: r.outBytes, cap: !!r.CAP, err: r.readErr || r.writeErr };
    });
  });
});

/* ---- F. abort / close races ---- */
T("F1-abort-mid-stream", function () {
  return compress("deflate", utf8("hello world hello world")).then(function (z) {
    return feed("deflate", [z.subarray(0, 4), z.subarray(4, 8), z.subarray(8)],
                { abortAt: 1, timeout: 3000 });
  }).then(function (r) { return { err: r.writeErr || r.readErr, bytes: r.outBytes }; });
});

T("F2-abort-at-end", function () {
  return compress("deflate", utf8("xyz")).then(function (z) {
    return feed("deflate", [z], { abortAtEnd: true, timeout: 3000 });
  }).then(function (r) { return { err: r.writeErr || r.readErr, bytes: r.outBytes }; });
});

T("F3-write-after-error", function () {
  var ds = new DecompressionStream("deflate");
  var w = ds.writable.getWriter();
  var r = ds.readable.getReader();
  var out = {};
  // consume so the writer queue drains
  (function loop() { r.read().then(function (x) { if (!x.done) loop(); }, function () {}); })();
  return w.write(MALFORMED["zlib-reserved-block"]).then(function () {
    return w.write(MALFORMED["zlib-fdict"]).then(function () { out.w2 = "ok"; },
                                                  function (e) { out.w2 = en(e); });
  }, function (e) { out.w1 = en(e); }).then(function () {
    return w.write(new Uint8Array([1, 2, 3])).then(function () { out.w3 = "ok"; },
                                                    function (e) { out.w3 = en(e); });
  }).then(function () { return out; });
});

T("F4-close-then-write", function () {
  var ds = new DecompressionStream("gzip");
  var w = ds.writable.getWriter();
  var r = ds.readable.getReader();
  (function loop() { r.read().then(function (x) { if (!x.done) loop(); }, function () {}); })();
  var out = {};
  return w.close().then(function () {
    return w.write(new Uint8Array([1, 2, 3])).then(function () { out.write = "NO-THROW"; },
                                                    function (e) { out.write = en(e); });
  }).then(function () { return out; });
});

/* ---- G. pipeThrough + cancel mid-flight ---- */
T("G1-pipeThrough-cancel", function () {
  if (typeof CompressionStream !== "function") return { skip: "no CompressionStream" };
  return compress("deflate", new Uint8Array(1 << 20)).then(function (z) {
    var src = new ReadableStream({
      start: function (c) { c.enqueue(z.subarray(0, 64)); }
    });
    var ds = new DecompressionStream("deflate");
    var piped = src.pipeThrough(ds);
    var r = piped.getReader();
    var p = r.read();
    var c = r.cancel("cancel-mid");
    return Promise.race([
      Promise.all([p.then(function (x) { return "read:" + (x.done ? "done" : "value"); },
                          function (e) { return "readErr:" + en(e); }),
                   c.then(function () { return "cancel-ok"; }, function (e) { return "cancelErr:" + en(e); })]),
      delay(2500).then(function () { return ["TIMEOUT"]; })
    ]);
  });
});

/* ---- runner ---- */
function run() {
  post("L", "p123 start");
  var i = 0;
  function step() {
    if (i >= TESTS.length) { post("Z", "p123 done"); return; }
    var name = TESTS[i][0], fn = TESTS[i][1]; i++;
    mark(name);
    var t0 = Date.now(), done = false;
    var timer = setTimeout(function () { fin({ TIMEOUT: true }); }, 20000);
    function fin(res) {
      if (done) return; done = true; clearTimeout(timer);
      res = res || {}; res.ms = Date.now() - t0; res.canary = canaryOK();
      post(name, res);
      setTimeout(step, 150);
    }
    try {
      var r = fn();
      if (r && typeof r.then === "function") {
        var raced = Promise.race([r, new Promise(function (res) { setTimeout(function () { res({ RACE_TIMEOUT: true }); }, 8000); })]);
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
