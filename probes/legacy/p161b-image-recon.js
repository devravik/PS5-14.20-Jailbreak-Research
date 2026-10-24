// p161b — Image decoder recon: format support, edge cases, createImageBitmap
// Beacon prefix: V161B-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V161B-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  function toB64(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }

  function u32be(v) { return [(v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff]; }
  function u16be(v) { return [(v>>>8)&0xff,v&0xff]; }
  function u32le(v) { return [v&0xff,(v>>>8)&0xff,(v>>>16)&0xff,(v>>>24)&0xff]; }
  function u16le(v) { return [v&0xff,(v>>>8)&0xff]; }

  function crc32(buf) {
    var c, table = [];
    for (var n = 0; n < 256; n++) {
      c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function pngChunk(type, data) {
    var t = [];
    for (var i = 0; i < type.length; i++) t.push(type.charCodeAt(i));
    var body = t.concat(data || []);
    var crc = crc32(body);
    return [].concat(u32be(data ? data.length : 0), body, u32be(crc));
  }

  function makePNG(w, h, colorType, bitDepth, idatData) {
    var sig = [137,80,78,71,13,10,26,10];
    var ihdr = [].concat(u32be(w), u32be(h), [bitDepth || 8, colorType || 2, 0, 0, 0]);
    var chunks = sig.concat(pngChunk('IHDR', ihdr));
    if (idatData) chunks = chunks.concat(pngChunk('IDAT', idatData));
    else {
      var raw = [0x78, 0x01, 0x63, 0x60, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01];
      chunks = chunks.concat(pngChunk('IDAT', raw));
    }
    chunks = chunks.concat(pngChunk('IEND'));
    return new Uint8Array(chunks);
  }

  B('BOOT');

  var tests = [];
  var idx = 0;

  function next() {
    if (idx >= tests.length) { B('ALLDONE-' + tests.length); return; }
    var t = tests[idx++];
    try { t(); } catch(e) { B('ERR-' + idx + '-' + String(e).substring(0,30)); }
    setTimeout(next, 50);
  }

  // === 1. FORMAT SUPPORT ===

  // PNG 1x1 red pixel
  var png1x1 = makePNG(1, 1, 2, 8);
  tests.push(function() {
    var img = new Image();
    img.onload = function() { B('FMT-PNG-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('FMT-PNG-FAIL'); };
    img.src = 'data:image/png;base64,' + toB64(png1x1);
  });

  // JPEG minimal
  var jpegMin = new Uint8Array([
    0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,
    0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,
    0x07,0x07,0x07,0x09,0x09,0x08,0x0A,0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,
    0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,0x24,0x2E,0x27,0x20,
    0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,0x1F,0x27,
    0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,
    0x00,0x01,0x01,0x01,0x11,0x00,0xFF,0xC4,0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,
    0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,
    0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,0x00,0x3F,
    0x00,0x7B,0x40,0x1B,0xFF,0xD9
  ]);
  tests.push(function() {
    var img = new Image();
    img.onload = function() { B('FMT-JPEG-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('FMT-JPEG-FAIL'); };
    img.src = 'data:image/jpeg;base64,' + toB64(jpegMin);
  });

  // GIF 1x1
  var gif1x1 = new Uint8Array([
    0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0xFF,0x00,0x00,
    0x00,0x00,0x00,0x2C,0x00,0x00,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,
    0x01,0x00,0x3B
  ]);
  tests.push(function() {
    var img = new Image();
    img.onload = function() { B('FMT-GIF-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('FMT-GIF-FAIL'); };
    img.src = 'data:image/gif;base64,' + toB64(gif1x1);
  });

  // WebP minimal (VP8 lossy)
  var webpMin = new Uint8Array([
    0x52,0x49,0x46,0x46,0x1A,0x00,0x00,0x00,0x57,0x45,0x42,0x50,0x56,0x50,0x38,0x20,
    0x0E,0x00,0x00,0x00,0x30,0x01,0x00,0x9D,0x01,0x2A,0x01,0x00,0x01,0x00,0x01,0x40,
    0x25,0xA4,0x00,0x03,0x70,0x00
  ]);
  tests.push(function() {
    var img = new Image();
    img.onload = function() { B('FMT-WEBP-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('FMT-WEBP-FAIL'); };
    img.src = 'data:image/webp;base64,' + toB64(webpMin);
  });

  // BMP 1x1
  var bmpData = [].concat(
    [0x42,0x4D], u32le(70), [0,0,0,0], u32le(54),
    u32le(40), u32le(1), u32le(1), u16le(1), u16le(24), u32le(0),
    u32le(4), u32le(2835), u32le(2835), u32le(0), u32le(0),
    [0xFF, 0x00, 0x00, 0x00]
  );
  tests.push(function() {
    var img = new Image();
    img.onload = function() { B('FMT-BMP-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('FMT-BMP-FAIL'); };
    img.src = 'data:image/bmp;base64,' + toB64(new Uint8Array(bmpData));
  });

  // SVG
  tests.push(function() {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect fill="red" width="1" height="1"/></svg>';
    var img = new Image();
    img.onload = function() { B('FMT-SVG-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('FMT-SVG-FAIL'); };
    img.src = 'data:image/svg+xml;base64,' + btoa(svg);
  });

  // ICO minimal
  var icoData = [].concat(
    u16le(0), u16le(1), u16le(1),
    [1, 1, 0, 0], u16le(1), u16le(32), u32le(40+4), u32le(22)
  );
  var icoBmp = [].concat(u32le(40), u32le(1), u32le(2), u16le(1), u16le(32), u32le(0), u32le(4), u32le(0), u32le(0), u32le(0), u32le(0), [0xFF,0x00,0x00,0xFF]);
  icoData = icoData.concat(icoBmp);
  tests.push(function() {
    var img = new Image();
    img.onload = function() { B('FMT-ICO-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('FMT-ICO-FAIL'); };
    img.src = 'data:image/x-icon;base64,' + toB64(new Uint8Array(icoData));
  });

  // === 2. createImageBitmap AVAILABILITY ===
  tests.push(function() {
    B('CIB-CHECK-' + (typeof createImageBitmap));
    if (typeof createImageBitmap === 'function') {
      var blob = new Blob([png1x1], {type:'image/png'});
      createImageBitmap(blob).then(function(bmp) {
        B('CIB-OK-' + bmp.width + 'x' + bmp.height);
      }).catch(function(e) {
        B('CIB-ERR-' + String(e).substring(0,30));
      });
    }
  });

  // === 3. EDGE CASE PNG ===

  // Zero dimensions
  tests.push(function() {
    var p = makePNG(0, 0, 2, 8);
    var img = new Image();
    img.onload = function() { B('PNG-0x0-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('PNG-0x0-FAIL'); };
    img.src = 'data:image/png;base64,' + toB64(p);
  });

  // Large dimensions (65535x65535) — just IHDR, see if parser chokes
  tests.push(function() {
    var p = makePNG(65535, 65535, 2, 8);
    var img = new Image();
    img.onload = function() { B('PNG-HUGE-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('PNG-HUGE-FAIL'); };
    img.src = 'data:image/png;base64,' + toB64(p);
  });

  // Invalid color type (7)
  tests.push(function() {
    var p = makePNG(1, 1, 7, 8);
    var img = new Image();
    img.onload = function() { B('PNG-BADCLR-OK'); };
    img.onerror = function() { B('PNG-BADCLR-FAIL'); };
    img.src = 'data:image/png;base64,' + toB64(p);
  });

  // Truncated IDAT — just IHDR + partial IDAT
  tests.push(function() {
    var sig = [137,80,78,71,13,10,26,10];
    var ihdr = [].concat(u32be(1), u32be(1), [8, 2, 0, 0, 0]);
    var chunks = sig.concat(pngChunk('IHDR', ihdr));
    chunks = chunks.concat(u32be(100)); // IDAT length=100 but no data
    var t = [0x49,0x44,0x41,0x54];
    chunks = chunks.concat(t);
    chunks = chunks.concat([0x78, 0x01]); // just 2 bytes of zlib
    var p = new Uint8Array(chunks);
    var img = new Image();
    img.onload = function() { B('PNG-TRUNC-OK'); };
    img.onerror = function() { B('PNG-TRUNC-FAIL'); };
    img.src = 'data:image/png;base64,' + toB64(p);
  });

  // === 4. DIMENSION EDGE CASES ===

  // 32768x32768 PNG
  tests.push(function() {
    var p = makePNG(32768, 32768, 2, 8);
    var img = new Image();
    img.onload = function() { B('PNG-32K-OK-' + img.width + 'x' + img.height); };
    img.onerror = function() { B('PNG-32K-FAIL'); };
    img.src = 'data:image/png;base64,' + toB64(p);
  });

  // Width overflow: 2147483647 x 2
  tests.push(function() {
    var p = makePNG(2147483647, 2, 2, 8);
    var img = new Image();
    img.onload = function() { B('PNG-INTMAX-OK-' + img.width); };
    img.onerror = function() { B('PNG-INTMAX-FAIL'); };
    img.src = 'data:image/png;base64,' + toB64(p);
  });

  // === 5. CANVAS INTERACTION ===
  tests.push(function() {
    var img = new Image();
    img.onload = function() {
      try {
        var c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        var data = ctx.getImageData(0, 0, 1, 1);
        B('CANVAS-OK-rgba' + data.data[0] + ',' + data.data[1] + ',' + data.data[2] + ',' + data.data[3]);
      } catch(e) {
        B('CANVAS-ERR-' + String(e).substring(0,30));
      }
    };
    img.onerror = function() { B('CANVAS-IMGFAIL'); };
    img.src = 'data:image/png;base64,' + toB64(png1x1);
  });

  // Canvas with createImageBitmap
  tests.push(function() {
    if (typeof createImageBitmap !== 'function') { B('CANVAS-CIB-NOCIB'); return; }
    var blob = new Blob([png1x1], {type:'image/png'});
    createImageBitmap(blob).then(function(bmp) {
      var c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      var ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data = ctx.getImageData(0, 0, 1, 1);
      B('CANVAS-CIB-OK-rgba' + data.data[0] + ',' + data.data[1] + ',' + data.data[2] + ',' + data.data[3]);
    }).catch(function(e) {
      B('CANVAS-CIB-ERR-' + String(e).substring(0,30));
    });
  });

  // createImageBitmap with WebP
  tests.push(function() {
    if (typeof createImageBitmap !== 'function') { B('CIB-WEBP-NOCIB'); return; }
    var blob = new Blob([webpMin], {type:'image/webp'});
    createImageBitmap(blob).then(function(bmp) {
      B('CIB-WEBP-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) {
      B('CIB-WEBP-ERR-' + String(e).substring(0,30));
    });
  });

  // createImageBitmap with cropping rect
  tests.push(function() {
    if (typeof createImageBitmap !== 'function') { B('CIB-CROP-NOCIB'); return; }
    var blob = new Blob([png1x1], {type:'image/png'});
    createImageBitmap(blob, -1, -1, 3, 3).then(function(bmp) {
      B('CIB-CROP-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) {
      B('CIB-CROP-ERR-' + String(e).substring(0,30));
    });
  });

  // createImageBitmap with huge crop
  tests.push(function() {
    if (typeof createImageBitmap !== 'function') { B('CIB-HUGECROP-NOCIB'); return; }
    var blob = new Blob([png1x1], {type:'image/png'});
    createImageBitmap(blob, 0, 0, 100000, 100000).then(function(bmp) {
      B('CIB-HUGECROP-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) {
      B('CIB-HUGECROP-ERR-' + String(e).substring(0,30));
    });
  });

  next();
})();
