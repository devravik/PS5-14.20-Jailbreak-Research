/*
 * p437 -- Canvas 2D info leak probes
 *
 * Canvas pixel buffers are heap-allocated. If any operation returns
 * uninitialized memory through getImageData, we get a heap info leak.
 *
 * Tests:
 *   T1: Fresh canvas getImageData (should be all zeros)
 *   T2: Canvas resize then getImageData (new area might be uninit)
 *   T3: putImageData with negative offsets / partial overwrite
 *   T4: createImageBitmap + drawImage cycle (transfer might leak)
 *   T5: Canvas pattern with transform (read outside pattern bounds)
 *   T6: drawImage from cross-origin SVG (taint check bypass?)
 *   T7: getImageData after clearRect (freed backing store?)
 *   T8: ImageData constructor with SharedArrayBuffer (if supported)
 *   T9: Canvas with many resize/draw cycles (reuse freed buffers)
 *
 * Beacon prefix: V437-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V437-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

function nonZeroPixels(imageData) {
  var d = imageData.data;
  var count = 0;
  var first = -1;
  var vals = [];
  for (var i = 0; i < d.length; i++) {
    if (d[i] !== 0) {
      count++;
      if (first === -1) first = i;
      if (vals.length < 32) vals.push(i + ":" + d[i]);
    }
  }
  return {count: count, first: first, total: d.length, samples: vals.join(",")};
}

// T1: Fresh canvas, no drawing, read pixels
function T1() {
  B("T1-START");
  try {
    var c = document.createElement("canvas");
    c.width = 256; c.height = 256;
    var ctx = c.getContext("2d");
    if (!ctx) { B("T1-NO-CTX"); return; }
    var id = ctx.getImageData(0, 0, 256, 256);
    var nz = nonZeroPixels(id);
    B("T1-RESULT", nz);
    if (nz.count > 0) B("T1-LEAK!!!", nz);
  } catch(e) { B("T1-ERR", e.message.slice(0, 60)); }
}

// T2: Resize canvas, check new area
function T2() {
  B("T2-START");
  try {
    var c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 64, 64);
    // Resize larger -- new backing buffer allocated
    c.width = 512; c.height = 512;
    // After resize, canvas should be cleared. But is it?
    var id = ctx.getImageData(0, 0, 512, 512);
    var nz = nonZeroPixels(id);
    B("T2-RESULT", nz);
    if (nz.count > 0) B("T2-LEAK!!!", nz);
  } catch(e) { B("T2-ERR", e.message.slice(0, 60)); }
}

// T3: putImageData with dirty rect partially outside canvas
function T3() {
  B("T3-START");
  try {
    var c = document.createElement("canvas");
    c.width = 128; c.height = 128;
    var ctx = c.getContext("2d");
    // Create ImageData larger than canvas
    var id = ctx.createImageData(256, 256);
    // Fill with pattern
    for (var i = 0; i < id.data.length; i += 4) {
      id.data[i] = 0xAA; id.data[i+1] = 0xBB;
      id.data[i+2] = 0xCC; id.data[i+3] = 0xFF;
    }
    // Put with negative offset (partial clip)
    ctx.putImageData(id, -64, -64);
    // Read back -- should only have the visible portion
    var readback = ctx.getImageData(0, 0, 128, 128);
    // Check if any pixels outside the putImageData region have unexpected values
    var cornerPixel = ctx.getImageData(127, 127, 1, 1);
    B("T3-CORNER", {
      r: cornerPixel.data[0], g: cornerPixel.data[1],
      b: cornerPixel.data[2], a: cornerPixel.data[3]
    });
    // The last pixel at (127,127) maps to source (191,191) which is within our 256x256 data
    // So it should be 0xAA,0xBB,0xCC,0xFF
    B("T3-OK");
  } catch(e) { B("T3-ERR", e.message.slice(0, 60)); }
}

// T4: createImageBitmap resize and draw
function T4() {
  B("T4-START");
  try {
    var c = document.createElement("canvas");
    c.width = 64; c.height = 64;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(0, 0, 64, 64);

    // createImageBitmap with resize
    createImageBitmap(c, {resizeWidth: 256, resizeHeight: 256}).then(function(bmp) {
      B("T4-BMP-OK", {w: bmp.width, h: bmp.height});
      // Draw resized bitmap onto new canvas
      var c2 = document.createElement("canvas");
      c2.width = 256; c2.height = 256;
      var ctx2 = c2.getContext("2d");
      ctx2.drawImage(bmp, 0, 0);
      var id = ctx2.getImageData(0, 0, 256, 256);
      // All pixels should be green (0,255,0,255)
      var unexpected = 0;
      for (var i = 0; i < id.data.length; i += 4) {
        if (id.data[i] !== 0 || id.data[i+1] !== 255 || id.data[i+2] !== 0 || id.data[i+3] !== 255) {
          unexpected++;
          if (unexpected <= 4) {
            B("T4-UNEXPECTED-" + (i/4), {
              r: id.data[i], g: id.data[i+1],
              b: id.data[i+2], a: id.data[i+3]
            });
          }
        }
      }
      B("T4-RESULT", {unexpected: unexpected, total: id.data.length / 4});
      if (unexpected > 0 && id.data[0] !== 0) B("T4-POSSIBLE-LEAK");
    }).catch(function(e) { B("T4-BMP-ERR", e.message.slice(0, 60)); });
  } catch(e) { B("T4-ERR", e.message.slice(0, 60)); }
}

// T5: Canvas pattern with large scale transform
function T5() {
  B("T5-START");
  try {
    var patternCanvas = document.createElement("canvas");
    patternCanvas.width = 4; patternCanvas.height = 4;
    var pctx = patternCanvas.getContext("2d");
    pctx.fillStyle = "#0000ff";
    pctx.fillRect(0, 0, 4, 4);

    var c = document.createElement("canvas");
    c.width = 256; c.height = 256;
    var ctx = c.getContext("2d");
    var pattern = ctx.createPattern(patternCanvas, "repeat");
    ctx.setTransform(100, 0, 0, 100, 0, 0);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, 2.56, 2.56);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var id = ctx.getImageData(0, 0, 256, 256);
    // All pixels should be blue (0,0,255,255)
    var notBlue = 0;
    for (var i = 0; i < id.data.length; i += 4) {
      if (id.data[i+2] !== 255 || id.data[i+3] !== 255) {
        notBlue++;
      }
    }
    B("T5-RESULT", {notBlue: notBlue});
  } catch(e) { B("T5-ERR", e.message.slice(0, 60)); }
}

// T6: getImageData race -- draw, immediately resize, read
function T6() {
  B("T6-START");
  try {
    var c = document.createElement("canvas");
    c.width = 128; c.height = 128;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(0, 0, 128, 128);

    // Rapid resize cycle
    for (var r = 0; r < 50; r++) {
      c.width = 64 + (r * 8);
      c.height = 64 + (r * 8);
      var id = ctx.getImageData(0, 0, c.width, c.height);
      var nz = nonZeroPixels(id);
      if (nz.count > 0) {
        B("T6-CYCLE-" + r + "-LEAK!!!", nz);
        break;
      }
    }
    B("T6-DONE");
  } catch(e) { B("T6-ERR", e.message.slice(0, 60)); }
}

// T7: Large canvas allocation/deallocation cycle
function T7() {
  B("T7-START");
  try {
    // Allocate and free many canvas backing stores
    for (var i = 0; i < 20; i++) {
      var c = document.createElement("canvas");
      c.width = 1024; c.height = 1024;
      var ctx = c.getContext("2d");
      // Fill with identifiable pattern
      ctx.fillStyle = "rgba(" + (i*12) + "," + (i*12) + "," + (i*12) + ",1)";
      ctx.fillRect(0, 0, 1024, 1024);
      // Destroy by overwriting
      c.width = 1; c.height = 1;
    }
    // Now create a new large canvas and check if stale data leaks
    var c2 = document.createElement("canvas");
    c2.width = 1024; c2.height = 1024;
    var ctx2 = c2.getContext("2d");
    var id = ctx2.getImageData(0, 0, 1024, 1024);
    var nz = nonZeroPixels(id);
    B("T7-RESULT", nz);
    if (nz.count > 0) B("T7-LEAK!!!", nz);
  } catch(e) { B("T7-ERR", e.message.slice(0, 60)); }
}

// T8: ImageData from existing buffer
function T8() {
  B("T8-START");
  try {
    // Create Uint8ClampedArray with known data
    var buf = new Uint8ClampedArray(256 * 4);
    for (var i = 0; i < buf.length; i++) buf[i] = 0x42;
    var id = new ImageData(buf, 16, 16); // 16x16
    B("T8-CREATED", {w: id.width, h: id.height});
    // Modify the buffer after creating ImageData
    buf[0] = 0xFF;
    // Check if ImageData sees the modification (shared buffer?)
    B("T8-SHARED", id.data[0] === 0xFF ? "YES" : "NO");
  } catch(e) { B("T8-ERR", e.message.slice(0, 60)); }
}

// T9: toDataURL parsing roundtrip
function T9() {
  B("T9-START");
  try {
    var c = document.createElement("canvas");
    c.width = 128; c.height = 128;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 128, 128);
    // Export as data URL
    var url = c.toDataURL("image/png");
    B("T9-URL-LEN", url.length);
    // Import back via Image
    var img = new Image();
    img.onload = function() {
      var c2 = document.createElement("canvas");
      c2.width = img.width; c2.height = img.height;
      var ctx2 = c2.getContext("2d");
      ctx2.drawImage(img, 0, 0);
      var id = ctx2.getImageData(0, 0, c2.width, c2.height);
      // All pixels should be (0x12, 0x34, 0x56, 0xFF)
      var wrong = 0;
      for (var i = 0; i < id.data.length; i += 4) {
        if (id.data[i] !== 0x12 || id.data[i+1] !== 0x34 || id.data[i+2] !== 0x56) {
          wrong++;
        }
      }
      B("T9-RESULT", {wrong: wrong, total: id.data.length / 4});
    };
    img.onerror = function() { B("T9-IMG-ERR"); };
    img.src = url;
  } catch(e) { B("T9-ERR", e.message.slice(0, 60)); }
}

// Run all tests
T1();
T2();
T3();
T4();
T5();
T6();
T7();
T8();
T9();

setTimeout(function() { B("DONE"); }, 3000);
setInterval(function() { B("HB"); }, 15000);
})();
