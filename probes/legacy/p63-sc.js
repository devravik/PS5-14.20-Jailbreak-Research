/* press-63 — V63: structuredClone / postMessage serialization probes.
   Targets JSC type confusion in the Relapse exploit class:
   structuredClone object-pool mismatch → typed array corruption → addrof/fakeobj.
   Safe probes only — detect anomalies, not trigger overflows. */
(function(){
"use strict";
if(window.__p63)return; window.__p63=1;
var RID="v63s"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,300)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V63S-HB","hb");},2000);
bk("V63S-L","press63-structuredClone Relapse-class probes");

/* ledger */
try{
  var prev=null;try{prev=JSON.parse(localStorage.getItem("p51-ledger")||"null");}catch(e){}
  var now=Date.now();
  var cur={uid:(prev&&prev.uid)||Math.random().toString(36).slice(2,12),n:((prev&&prev.n)||0)+1,first:(prev&&prev.first)||now,last:now};
  localStorage.setItem("p51-ledger",JSON.stringify(cur));
  var rs=parseInt(localStorage.getItem("p53-restores")||"0",10)+1;
  localStorage.setItem("p53-restores",String(rs));
  bk("V63S-Rled","ledger n="+(prev&&prev.n)+"->"+cur.n+" same-uid="+(prev?prev.uid===cur.uid:"n/a")+" restores="+rs);
}catch(e){bk("V63S-Rled","ledger-FAIL "+e);}

/* ---- structuredClone polyfill via MessageChannel ---- */
var HAS_SC = typeof structuredClone === "function";
bk("V63S-Renv","globalSC="+HAS_SC+" MC="+(typeof MessageChannel)+" Worker="+(typeof Worker)+" SAB="+(typeof SharedArrayBuffer)+" BigInt="+(typeof BigInt)+" RAB="+(typeof ArrayBuffer.prototype.resize));

function scClone(obj, transfer) {
  if (HAS_SC) {
    return structuredClone(obj, transfer ? {transfer: transfer} : undefined);
  }
  /* MessageChannel sync clone — blocks, but works on old WebKit */
  var ch = new MessageChannel();
  var result;
  var done = false;
  ch.port2.onmessage = function(ev) { result = ev.data; done = true; };
  if (transfer) {
    ch.port1.postMessage(obj, transfer);
  } else {
    ch.port1.postMessage(obj);
  }
  /* spin-wait briefly (MessageChannel is microtask-dispatched in WebKit) */
  return result; /* may be undefined if async — we handle that */
}

/* Async clone via MessageChannel with callback */
function scCloneAsync(obj, transfer, cb) {
  if (HAS_SC) {
    try {
      var r = structuredClone(obj, transfer ? {transfer: transfer} : undefined);
      cb(null, r);
    } catch(e) { cb(e, null); }
    return;
  }
  var ch = new MessageChannel();
  var to = setTimeout(function(){ cb(new Error("MC-timeout"), null); }, 2000);
  ch.port2.onmessage = function(ev) {
    clearTimeout(to);
    cb(null, ev.data);
  };
  try {
    if (transfer) {
      ch.port1.postMessage(obj, transfer);
    } else {
      ch.port1.postMessage(obj);
    }
  } catch(e) { clearTimeout(to); cb(e, null); }
}

/* ---- Test queue (async chain) ---- */
var tests = [];
var tIdx = 0;
var results = {};

function addTest(name, fn) { tests.push({name: name, fn: fn}); }
function runNext() {
  if (tIdx >= tests.length) { doFinish(); return; }
  var t = tests[tIdx]; tIdx++;
  var t0 = performance.now();
  try {
    t.fn(function(res) {
      var d = (performance.now() - t0).toFixed(1);
      results[t.name] = res;
      bk("V63S-R" + t.name, res + " d=" + d + "ms");
      setTimeout(runNext, 5);
    });
  } catch(e) {
    results[t.name] = "EXC:" + e.name;
    bk("V63S-R" + t.name, "EXC:" + (e.name || e));
    setTimeout(runNext, 5);
  }
}

/* ---- Helper: describe TypedArray state ---- */
function taState(ta) {
  try {
    var cn = ta.constructor.name || "?";
    var len = ta.length;
    var bl = ta.byteLength;
    var bo = ta.byteOffset;
    var v0 = len > 0 ? ta[0] : "empty";
    var vN = len > 1 ? ta[len - 1] : v0;
    return cn + "[" + len + "]bl=" + bl + ",bo=" + bo + ",v0=" + v0 + ",vN=" + vN;
  } catch(e) { return "state-EXC:" + e.name; }
}

/* ================================================================
   GROUP A — Basic serialization boundaries
   ================================================================ */

/* SC1: ArrayBuffer size boundaries */
addTest("SC1-ab", function(done) {
  var sizes = [0, 1, 4096, 65536];
  var out = [];
  var i = 0;
  function next() {
    if (i >= sizes.length) { done(out.join("|")); return; }
    var sz = sizes[i]; i++;
    var ab = new ArrayBuffer(sz);
    if (sz > 0) { new Uint8Array(ab)[0] = 0xAA; if(sz>1) new Uint8Array(ab)[sz-1] = 0xBB; }
    scCloneAsync(ab, null, function(err, clone) {
      if (err) { out.push(sz + ":ERR:" + err.name); next(); return; }
      if (!clone) { out.push(sz + ":NULL"); next(); return; }
      var ok = clone.byteLength === sz;
      if (sz > 0) {
        var u = new Uint8Array(clone);
        ok = ok && u[0] === 0xAA;
        if (sz > 1) ok = ok && u[sz-1] === 0xBB;
      }
      out.push(sz + ":" + (ok ? "OK" : "MISMATCH:bl=" + clone.byteLength));
      next();
    });
  }
  next();
});

/* SC2: Every TypedArray type */
addTest("SC2-ta", function(done) {
  var types = [
    {C: Int8Array, v: -42},
    {C: Uint8Array, v: 200},
    {C: Uint8ClampedArray, v: 128},
    {C: Int16Array, v: -1234},
    {C: Uint16Array, v: 60000},
    {C: Int32Array, v: -100000},
    {C: Uint32Array, v: 3000000000},
    {C: Float32Array, v: 3.14},
    {C: Float64Array, v: 2.718281828}
  ];
  /* BigInt types */
  try { types.push({C: BigInt64Array, v: BigInt("-9007199254740991"), big: true}); } catch(e) {}
  try { types.push({C: BigUint64Array, v: BigInt("9007199254740991"), big: true}); } catch(e) {}

  var out = [];
  var i = 0;
  function next() {
    if (i >= types.length) { done(out.join("|")); return; }
    var t = types[i]; i++;
    var name = t.C.name || "?";
    try {
      var ta = new t.C(4);
      ta[0] = t.v; ta[3] = t.v;
      var before = taState(ta);
      scCloneAsync(ta, null, function(err, clone) {
        if (err) { out.push(name + ":ERR:" + err.name); next(); return; }
        if (!clone) { out.push(name + ":NULL"); next(); return; }
        var after = taState(clone);
        var typeOK = clone.constructor === t.C;
        var lenOK = clone.length === 4;
        var v0OK = t.big ? clone[0] === t.v : Math.abs(clone[0] - t.v) < 0.01;
        var v3OK = t.big ? clone[3] === t.v : Math.abs(clone[3] - t.v) < 0.01;
        var ok = typeOK && lenOK && v0OK && v3OK;
        out.push(name + ":" + (ok ? "OK" : "BAD(" + after + ")"));
        next();
      });
    } catch(e) { out.push(name + ":SKIP:" + e.name); next(); }
  }
  next();
});

/* SC3: DataView clone */
addTest("SC3-dv", function(done) {
  var ab = new ArrayBuffer(32);
  var dv = new DataView(ab, 8, 16);
  dv.setFloat64(0, 1.23456789);
  dv.setUint32(8, 0xDEADBEEF);
  scCloneAsync(dv, null, function(err, clone) {
    if (err) { done("ERR:" + err.name); return; }
    if (!clone) { done("NULL-async"); return; }
    try {
      var ok = clone instanceof DataView;
      ok = ok && clone.byteOffset === 0; /* clone gets fresh buffer, offset resets to 0 in some impls */
      var f = clone.getFloat64(0);
      var u = clone.getUint32(8);
      done("dv=" + ok + " f64=" + f.toFixed(6) + " u32=0x" + u.toString(16) + " bo=" + clone.byteOffset + " bl=" + clone.byteLength);
    } catch(e) { done("read-EXC:" + e.name); }
  });
});

/* SC4: Transfer (ArrayBuffer neutering) */
addTest("SC4-xfer", function(done) {
  var ab = new ArrayBuffer(256);
  new Uint8Array(ab).fill(0x42);
  var srcBL = ab.byteLength;
  scCloneAsync(ab, [ab], function(err, clone) {
    if (err) { done("ERR:" + err.name); return; }
    var srcAfter = ab.byteLength;
    var neutered = srcAfter === 0;
    var dstOK = clone && clone.byteLength === 256;
    var valOK = false;
    if (dstOK) { var u = new Uint8Array(clone); valOK = u[0] === 0x42 && u[255] === 0x42; }
    done("neutered=" + neutered + " srcBL=" + srcBL + "->" + srcAfter + " dst=" + (dstOK ? "256B" : "BAD") + " val=" + valOK);
  });
});

/* ================================================================
   GROUP B — Type confusion triggers (Relapse-class)
   ================================================================ */

/* SC5: Clone TypedArray then detach its buffer via transfer */
addTest("SC5-detach", function(done) {
  var ab = new ArrayBuffer(64);
  var ta = new Uint32Array(ab);
  ta[0] = 0xCAFEBABE; ta[15] = 0xDEADC0DE;

  /* Clone the TypedArray (should snapshot the data) */
  scCloneAsync(ta, null, function(err, clone1) {
    if (err) { done("clone1-ERR:" + err.name); return; }
    /* Now transfer (detach) the original buffer */
    scCloneAsync(ab, [ab], function(err2, clone2) {
      if (err2) { done("xfer-ERR:" + err2.name); return; }
      var srcDetached = ab.byteLength === 0;
      /* Check if clone1 still has valid data */
      var c1ok = "?";
      try {
        c1ok = clone1[0] === 0xCAFEBABE && clone1[15] === 0xDEADC0DE;
        c1ok = "data=" + c1ok + " len=" + clone1.length + " bl=" + clone1.byteLength;
      } catch(e) { c1ok = "EXC:" + e.name; }
      /* Check original TA state (should be detached) */
      var origTA = "?";
      try { origTA = "len=" + ta.length + " bl=" + ta.byteLength; } catch(e) { origTA = "EXC:" + e.name; }
      done("srcDet=" + srcDetached + " c1=" + c1ok + " origTA=" + origTA);
    });
  });
});

/* SC6: Resizable ArrayBuffer (if available) */
addTest("SC6-rab", function(done) {
  try {
    var rab = new ArrayBuffer(64, {maxByteLength: 256});
    var ta = new Uint8Array(rab);
    ta[0] = 0xAA;
    var preLen = ta.length;
    scCloneAsync(ta, null, function(err, clone) {
      if (err) { done("RAB-clone-ERR:" + err.name); return; }
      /* resize original after clone */
      try { rab.resize(128); } catch(e) { done("resize-EXC:" + e.name); return; }
      var postLen = new Uint8Array(rab).length;
      var cloneLen = clone ? clone.length : "null";
      var cloneBL = clone ? clone.byteLength : "null";
      var cloneV0 = clone ? clone[0] : "null";
      done("RAB pre=" + preLen + " post=" + postLen + " clone.len=" + cloneLen + " clone.bl=" + cloneBL + " v0=" + cloneV0);
    });
  } catch(e) {
    done("NO-RAB:" + e.name);
  }
});

/* SC7: Mixed TypedArrays on same ArrayBuffer at overlapping offsets */
addTest("SC7-mixed", function(done) {
  var ab = new ArrayBuffer(64);
  new Uint8Array(ab).fill(0xFF);
  var u8 = new Uint8Array(ab, 0, 32);
  var u32 = new Uint32Array(ab, 0, 8);
  var f64 = new Float64Array(ab, 0, 4);
  var obj = {a: u8, b: u32, c: f64, marker: "overlap-test"};
  scCloneAsync(obj, null, function(err, clone) {
    if (err) { done("ERR:" + err.name); return; }
    if (!clone) { done("NULL"); return; }
    /* Check: do cloned arrays share a backing store or get independent copies? */
    try {
      var ca = clone.a; var cb = clone.b; var cc = clone.c;
      /* Write via u8 clone, check if u32 clone sees it */
      ca[0] = 0x42;
      var shared = (new Uint8Array(cb.buffer))[0] === 0x42;
      var aOK = ca.constructor === Uint8Array && ca.length === 32;
      var bOK = cb.constructor === Uint32Array && cb.length === 8;
      var cOK = cc.constructor === Float64Array && cc.length === 4;
      done("shared=" + shared + " a=" + aOK + " b=" + bOK + " c=" + cOK + " marker=" + clone.marker);
    } catch(e) { done("check-EXC:" + e.name); }
  });
});

/* SC8: Deep nesting (stack pressure) */
addTest("SC8-nest", function(done) {
  var depth = 200;
  var obj = {v: 42};
  for (var d = 0; d < depth; d++) { obj = {a: obj}; }
  scCloneAsync(obj, null, function(err, clone) {
    if (err) { done("ERR:" + err.name + " depth=" + depth); return; }
    /* Walk to the bottom */
    var c = clone; var actual = 0;
    while (c && c.a) { c = c.a; actual++; }
    var vOK = c && c.v === 42;
    done("depth=" + actual + " v=" + vOK);
  });
});

/* SC9: Circular references */
addTest("SC9-cycle", function(done) {
  var a = {name: "a"};
  var b = {name: "b"};
  a.ref = b; b.ref = a; /* cycle: a -> b -> a */
  scCloneAsync(a, null, function(err, clone) {
    if (err) { done("ERR:" + err.name); return; }
    try {
      var cycle = clone.ref.ref === clone;
      done("cycle=" + cycle + " a=" + clone.name + " b=" + clone.ref.name);
    } catch(e) { done("walk-EXC:" + e.name); }
  });
});

/* SC10: Modified prototypes / getters */
addTest("SC10-proto", function(done) {
  var out = [];

  /* A: TypedArray with extra own properties */
  try {
    var ta = new Uint8Array(8);
    ta[0] = 99;
    ta.customProp = "sneaky";
    scCloneAsync(ta, null, function(err, clone) {
      if (err) { out.push("extra-ERR:" + err.name); } else {
        out.push("extra:cp=" + (clone.customProp === "sneaky") + " v0=" + clone[0] + " len=" + clone.length);
      }
      /* B: Object with getter on 'length' */
      try {
        var evil = {};
        var callCount = 0;
        Object.defineProperty(evil, "length", {get: function(){ callCount++; return callCount > 1 ? 999 : 1; }});
        evil[0] = "test";
        scCloneAsync(evil, null, function(err2, clone2) {
          if (err2) { out.push("getter-ERR:" + err2.name); } else {
            out.push("getter:calls=" + callCount + " cl=" + JSON.stringify(clone2).slice(0,60));
          }
          /* C: Object with Symbol.toPrimitive */
          try {
            var sym = {};
            sym[Symbol.toPrimitive] = function(hint) { return hint === "number" ? 1337 : "evil"; };
            sym.val = 42;
            scCloneAsync(sym, null, function(err3, clone3) {
              if (err3) { out.push("sym-ERR:" + err3.name); } else {
                out.push("sym:val=" + (clone3 && clone3.val) + " hasSym=" + (!!clone3[Symbol.toPrimitive]));
              }
              done(out.join("|"));
            });
          } catch(e) { out.push("sym-SKIP:" + e.name); done(out.join("|")); }
        });
      } catch(e) { out.push("getter-SKIP:" + e.name); done(out.join("|")); }
    });
  } catch(e) { out.push("extra-SKIP:" + e.name); done(out.join("|")); }
});

/* ================================================================
   GROUP C — postMessage cross-context (Worker)
   ================================================================ */

/* Worker inline code */
var WORKER_SRC = [
  "self.onmessage = function(ev) {",
  "  var d = ev.data;",
  "  if (d.cmd === 'echo') {",
  "    self.postMessage({cmd:'echo-back', ta: d.ta, id: d.id});",
  "  } else if (d.cmd === 'echo-xfer') {",
  "    var buf = d.ta.buffer;",
  "    self.postMessage({cmd:'xfer-back', ta: d.ta, id: d.id}, [buf]);",
  "  } else if (d.cmd === 'multi') {",
  "    for (var i = 0; i < d.arr.length; i++) {",
  "      self.postMessage({cmd:'multi-back', idx: i, ta: d.arr[i], id: d.id});",
  "    }",
  "    self.postMessage({cmd:'multi-done', count: d.arr.length, id: d.id});",
  "  }",
  "};"
].join("\n");

var worker = null;
try {
  var blob = new Blob([WORKER_SRC], {type: "application/javascript"});
  var url = URL.createObjectURL(blob);
  worker = new Worker(url);
  bk("V63S-Rwk", "worker-created");
} catch(e) {
  bk("V63S-Rwk", "worker-FAIL:" + e.name);
}

/* PM1: postMessage TypedArray roundtrip */
addTest("PM1-echo", function(done) {
  if (!worker) { done("NO-WORKER"); return; }
  var ta = new Float32Array(4);
  ta[0] = 1.5; ta[1] = 2.5; ta[2] = 3.5; ta[3] = 4.5;
  var to = setTimeout(function(){ done("TIMEOUT"); }, 3000);
  var handler = function(ev) {
    if (ev.data.cmd === "echo-back" && ev.data.id === "pm1") {
      clearTimeout(to);
      worker.removeEventListener("message", handler);
      var r = ev.data.ta;
      var ok = r instanceof Float32Array && r.length === 4 && Math.abs(r[0] - 1.5) < 0.01 && Math.abs(r[3] - 4.5) < 0.01;
      done("echo=" + ok + " type=" + r.constructor.name + " len=" + r.length + " v0=" + r[0] + " v3=" + r[3]);
    }
  };
  worker.addEventListener("message", handler);
  worker.postMessage({cmd: "echo", ta: ta, id: "pm1"});
});

/* PM2: Double transfer (main→worker→main) */
addTest("PM2-dblxfer", function(done) {
  if (!worker) { done("NO-WORKER"); return; }
  var ab = new ArrayBuffer(128);
  new Uint8Array(ab).fill(0x77);
  var ta = new Uint8Array(ab);
  var preBL = ab.byteLength;
  var to = setTimeout(function(){ done("TIMEOUT"); }, 3000);
  var handler = function(ev) {
    if (ev.data.cmd === "xfer-back" && ev.data.id === "pm2") {
      clearTimeout(to);
      worker.removeEventListener("message", handler);
      var r = ev.data.ta;
      var srcAfter = ab.byteLength;
      var ok = r instanceof Uint8Array && r.length === 128 && r[0] === 0x77 && r[127] === 0x77;
      done("xfer=" + ok + " srcBL=" + preBL + "->" + srcAfter + " dst.len=" + r.length + " v0=0x" + r[0].toString(16));
    }
  };
  worker.addEventListener("message", handler);
  worker.postMessage({cmd: "echo-xfer", ta: ta, id: "pm2"}, [ab]);
});

/* PM3: Rapid multi-postMessage (50 TypedArrays in tight loop) */
addTest("PM3-multi", function(done) {
  if (!worker) { done("NO-WORKER"); return; }
  var N = 50;
  var arr = [];
  for (var m = 0; m < N; m++) {
    var ta = new Uint8Array(64);
    ta[0] = m & 0xFF;
    ta[63] = (m * 7) & 0xFF;
    arr.push(ta);
  }
  var received = 0;
  var mismatches = 0;
  var to = setTimeout(function(){ done("TIMEOUT recv=" + received + "/" + N); }, 5000);
  var handler = function(ev) {
    if (ev.data.id !== "pm3") return;
    if (ev.data.cmd === "multi-back") {
      var idx = ev.data.idx;
      var r = ev.data.ta;
      if (r[0] !== (idx & 0xFF) || r[63] !== ((idx * 7) & 0xFF)) { mismatches++; }
      received++;
    } else if (ev.data.cmd === "multi-done") {
      clearTimeout(to);
      worker.removeEventListener("message", handler);
      done("recv=" + received + "/" + N + " mismatches=" + mismatches);
    }
  };
  worker.addEventListener("message", handler);
  worker.postMessage({cmd: "multi", arr: arr, id: "pm3"});
});

/* ================================================================
   CANARY CHECK — after all stress, verify integrity
   ================================================================ */
addTest("CANARY", function(done) {
  var pattern = new Uint32Array(16);
  for (var c = 0; c < 16; c++) pattern[c] = 0xCAFE0000 + c;
  scCloneAsync(pattern, null, function(err, clone) {
    if (err) { done("ERR:" + err.name); return; }
    var ok = true;
    for (var c2 = 0; c2 < 16; c2++) {
      if (clone[c2] !== (0xCAFE0000 + c2)) { ok = false; break; }
    }
    done("intact=" + ok + " len=" + clone.length + " v0=0x" + clone[0].toString(16) + " v15=0x" + clone[15].toString(16));
  });
});

/* ---- Kick off ---- */
function doFinish() {
  /* Summary beacon */
  var summary = [];
  for (var k in results) {
    var v = String(results[k]);
    var status = "?";
    if (v.indexOf("ERR") >= 0 || v.indexOf("EXC") >= 0) status = "E";
    else if (v.indexOf("MISMATCH") >= 0 || v.indexOf("BAD") >= 0 || v.indexOf("false") >= 0) status = "!";
    else if (v.indexOf("OK") >= 0 || v.indexOf("true") >= 0 || v.indexOf("intact=true") >= 0) status = "+";
    else status = "~";
    summary.push(k + ":" + status);
  }
  bk("V63S-Rsum", summary.join(" "));
  bk("V63S-END", "press63-done tests=" + tests.length);
  if (worker) { try { worker.terminate(); } catch(e) {} }
  setTimeout(function(){ clearInterval(HB); bk("V63S-Z2","late-z"); }, 20000);
}

function boot() { runNext(); }
if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}else{boot();}
})();
