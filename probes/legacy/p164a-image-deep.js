// p164a — Deep image decoder probes: truncated data, createImageBitmap edge cases
// Focus: uninitialized memory via truncated decode, integer overflow via crop rects
// Beacon prefix: V164A-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V164A-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  function u32be(v) { return [(v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff]; }

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
    chunks = chunks.concat(pngChunk('IEND'));
    return new Uint8Array(chunks);
  }

  B('BOOT');

  var tests = [];
  var idx = 0;

  function next() {
    if (idx >= tests.length) { B('ALLDONE-' + tests.length); return; }
    var name = tests[idx][0];
    var fn = tests[idx][1];
    idx++;
    B(name + '-S');
    try { fn(); } catch(e) { B(name + '-THROW-' + e.name); }
    setTimeout(next, 200);
  }

  // === SECTION 1: TRUNCATED PNG MEMORY LEAK TESTS ===

  // T1: 10x10 RGB PNG with empty IDAT — draw to canvas, read pixels
  tests.push(['T1-EMPTY-IDAT', function() {
    var p = makePNG(10, 10, 2, 8, [0x78, 0x01, 0x01, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x01]);
    var blob = new Blob([p], {type:'image/png'});
    var img = new Image();
    img.onload = function() {
      B('T1-LOAD-' + img.width + 'x' + img.height);
      var c = document.createElement('canvas');
      c.width = 10; c.height = 10;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, 10, 10).data;
      var nz = 0;
      var sample = '';
      for (var i = 0; i < data.length; i++) {
        if (data[i] !== 0) nz++;
      }
      for (var i = 0; i < Math.min(32, data.length); i++) {
        sample += (data[i] < 16 ? '0' : '') + data[i].toString(16);
      }
      B('T1-NZ-' + nz + '-S-' + sample);
    };
    img.onerror = function() { B('T1-FAIL'); };
    img.src = URL.createObjectURL(blob);
  }]);

  // T2: 100x100 RGB PNG with 2-byte truncated zlib — bigger surface for leak
  tests.push(['T2-TRUNC100', function() {
    var p = makePNG(100, 100, 2, 8, [0x78, 0x01]);
    var blob = new Blob([p], {type:'image/png'});
    var img = new Image();
    img.onload = function() {
      B('T2-LOAD-' + img.width + 'x' + img.height);
      var c = document.createElement('canvas');
      c.width = 100; c.height = 100;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, 100, 100).data;
      var nz = 0;
      var unique = {};
      for (var i = 0; i < data.length; i += 4) {
        var r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (r || g || b || a) nz++;
        var key = r + ',' + g + ',' + b;
        unique[key] = (unique[key] || 0) + 1;
      }
      var ukeys = Object.keys(unique);
      B('T2-NZ-' + nz + '-U-' + ukeys.length);
      if (nz > 0) {
        var first8 = '';
        for (var i = 0; i < Math.min(64, data.length); i++) {
          first8 += (data[i] < 16 ? '0' : '') + data[i].toString(16);
        }
        B('T2-PIX-' + first8);
      }
    };
    img.onerror = function() { B('T2-FAIL'); };
    img.src = URL.createObjectURL(blob);
  }]);

  // T3: Same but RGBA (colorType=6) — alpha channel might reveal more
  tests.push(['T3-RGBA-TRUNC', function() {
    var p = makePNG(50, 50, 6, 8, [0x78, 0x01]);
    var blob = new Blob([p], {type:'image/png'});
    var img = new Image();
    img.onload = function() {
      B('T3-LOAD-' + img.width + 'x' + img.height);
      var c = document.createElement('canvas');
      c.width = 50; c.height = 50;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var data = ctx.getImageData(0, 0, 50, 50).data;
      var nz = 0, nzAlpha = 0;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i] || data[i+1] || data[i+2]) nz++;
        if (data[i+3] !== 0) nzAlpha++;
      }
      B('T3-NZ-' + nz + '-A-' + nzAlpha);
      if (nz > 0 || nzAlpha > 0) {
        var s = '';
        for (var i = 0; i < Math.min(64, data.length); i++) {
          s += (data[i] < 16 ? '0' : '') + data[i].toString(16);
        }
        B('T3-PIX-' + s);
      }
    };
    img.onerror = function() { B('T3-FAIL'); };
    img.src = URL.createObjectURL(blob);
  }]);

  // T4: createImageBitmap with truncated PNG — different code path
  tests.push(['T4-CIB-TRUNC', function() {
    if (typeof createImageBitmap !== 'function') { B('T4-NOCIB'); return; }
    var p = makePNG(100, 100, 2, 8, [0x78, 0x01]);
    var blob = new Blob([p], {type:'image/png'});
    createImageBitmap(blob).then(function(bmp) {
      B('T4-BMP-' + bmp.width + 'x' + bmp.height);
      var c = document.createElement('canvas');
      c.width = 100; c.height = 100;
      var ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data = ctx.getImageData(0, 0, 100, 100).data;
      var nz = 0;
      for (var i = 0; i < data.length; i++) if (data[i]) nz++;
      B('T4-NZ-' + nz);
      if (nz > 0) {
        var s = '';
        for (var i = 0; i < Math.min(64, data.length); i++) {
          s += (data[i] < 16 ? '0' : '') + data[i].toString(16);
        }
        B('T4-PIX-' + s);
      }
    }).catch(function(e) { B('T4-ERR-' + e.name); });
  }]);

  // === SECTION 2: createImageBitmap CROP RECT EDGE CASES ===

  // Build a valid small PNG for crop tests
  // 4x4 RGB with known pixel data
  var validPng4x4;
  (function() {
    var raw = [];
    for (var y = 0; y < 4; y++) {
      raw.push(0); // filter byte
      for (var x = 0; x < 4; x++) {
        raw.push((x * 64) & 0xFF); // R
        raw.push((y * 64) & 0xFF); // G
        raw.push(((x + y) * 32) & 0xFF); // B
      }
    }
    // Compress with deflate (minimal: store block)
    var deflated = [0x78, 0x01];
    var len = raw.length;
    deflated.push(0x01); // BFINAL=1, BTYPE=00 (no compression)
    deflated.push(len & 0xFF, (len >> 8) & 0xFF);
    deflated.push((~len) & 0xFF, ((~len) >> 8) & 0xFF);
    for (var i = 0; i < raw.length; i++) deflated.push(raw[i]);
    // Adler32
    var a = 1, b = 0;
    for (var i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    var adler = ((b << 16) | a) >>> 0;
    deflated.push((adler >> 24) & 0xFF, (adler >> 16) & 0xFF, (adler >> 8) & 0xFF, adler & 0xFF);
    validPng4x4 = makePNG(4, 4, 2, 8, deflated);
  })();

  // T5: Negative x,y crop
  tests.push(['T5-NEG-XY', function() {
    if (typeof createImageBitmap !== 'function') { B('T5-NOCIB'); return; }
    var blob = new Blob([validPng4x4], {type:'image/png'});
    createImageBitmap(blob, -2, -2, 4, 4).then(function(bmp) {
      B('T5-OK-' + bmp.width + 'x' + bmp.height);
      var c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      var ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      var data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      var nz = 0;
      for (var i = 0; i < data.length; i++) if (data[i]) nz++;
      var s = '';
      for (var i = 0; i < Math.min(64, data.length); i++) {
        s += (data[i] < 16 ? '0' : '') + data[i].toString(16);
      }
      B('T5-NZ-' + nz + '-' + s);
    }).catch(function(e) { B('T5-ERR-' + e.name); });
  }]);

  // T6: Very large negative x (-2147483648)
  tests.push(['T6-INTMIN', function() {
    if (typeof createImageBitmap !== 'function') { B('T6-NOCIB'); return; }
    var blob = new Blob([validPng4x4], {type:'image/png'});
    createImageBitmap(blob, -2147483648, 0, 4, 4).then(function(bmp) {
      B('T6-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) { B('T6-ERR-' + e.name); });
  }]);

  // T7: Crop width = 0
  tests.push(['T7-W0', function() {
    if (typeof createImageBitmap !== 'function') { B('T7-NOCIB'); return; }
    var blob = new Blob([validPng4x4], {type:'image/png'});
    createImageBitmap(blob, 0, 0, 0, 4).then(function(bmp) {
      B('T7-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) { B('T7-ERR-' + e.name); });
  }]);

  // T8: Crop width = -1 (negative dimension)
  tests.push(['T8-WNEG', function() {
    if (typeof createImageBitmap !== 'function') { B('T8-NOCIB'); return; }
    var blob = new Blob([validPng4x4], {type:'image/png'});
    createImageBitmap(blob, 0, 0, -1, 4).then(function(bmp) {
      B('T8-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) { B('T8-ERR-' + e.name); });
  }]);

  // T9: Crop x+w overflows int32 (x=2147483646, w=4)
  tests.push(['T9-OVERFLOW', function() {
    if (typeof createImageBitmap !== 'function') { B('T9-NOCIB'); return; }
    var blob = new Blob([validPng4x4], {type:'image/png'});
    createImageBitmap(blob, 2147483646, 0, 4, 4).then(function(bmp) {
      B('T9-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) { B('T9-ERR-' + e.name); });
  }]);

  // T10: Crop both dimensions max int
  tests.push(['T10-MAXDIM', function() {
    if (typeof createImageBitmap !== 'function') { B('T10-NOCIB'); return; }
    var blob = new Blob([validPng4x4], {type:'image/png'});
    createImageBitmap(blob, 0, 0, 2147483647, 2147483647).then(function(bmp) {
      B('T10-OK-' + bmp.width + 'x' + bmp.height);
    }).catch(function(e) { B('T10-ERR-' + e.name); });
  }]);

  // === SECTION 3: MULTIPLE DECODE / GC INTERACTION ===

  // T11: Decode many truncated PNGs rapidly — stress decoder cleanup
  tests.push(['T11-MASS-TRUNC', function() {
    var count = 0;
    var loaded = 0;
    var failed = 0;
    for (var i = 0; i < 50; i++) {
      var sz = 10 + i;
      var p = makePNG(sz, sz, 2, 8, [0x78, 0x01]);
      var img = new Image();
      img.onload = function() { loaded++; check(); };
      img.onerror = function() { failed++; check(); };
      img.src = URL.createObjectURL(new Blob([p], {type:'image/png'}));
    }
    function check() {
      count++;
      if (count >= 50) B('T11-L' + loaded + '-F' + failed);
    }
  }]);

  // T12: createImageBitmap then close() — test cleanup
  tests.push(['T12-CIB-CLOSE', function() {
    if (typeof createImageBitmap !== 'function') { B('T12-NOCIB'); return; }
    var p = makePNG(10, 10, 2, 8);
    var blob = new Blob([p], {type:'image/png'});
    createImageBitmap(blob).then(function(bmp) {
      B('T12-PRE-' + bmp.width + 'x' + bmp.height);
      bmp.close();
      try {
        var c = document.createElement('canvas');
        c.width = 10; c.height = 10;
        var ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        var data = ctx.getImageData(0, 0, 10, 10).data;
        var nz = 0;
        for (var i = 0; i < data.length; i++) if (data[i]) nz++;
        B('T12-AFTER-CLOSE-NZ-' + nz);
      } catch(e) {
        B('T12-CLOSE-ERR-' + e.name);
      }
    }).catch(function(e) { B('T12-ERR-' + e.name); });
  }]);

  // T13: Rapid create-close-create to stress allocator
  tests.push(['T13-RAPID-ALLOC', function() {
    if (typeof createImageBitmap !== 'function') { B('T13-NOCIB'); return; }
    var p = makePNG(100, 100, 2, 8);
    var blob = new Blob([p], {type:'image/png'});
    var round = 0;
    function doRound() {
      createImageBitmap(blob).then(function(bmp) {
        bmp.close();
        round++;
        if (round < 100) doRound();
        else B('T13-DONE-' + round);
      }).catch(function(e) { B('T13-ERR-R' + round + '-' + e.name); });
    }
    doRound();
  }]);

  // T14: structuredClone of ImageBitmap
  tests.push(['T14-CLONE-BMP', function() {
    if (typeof createImageBitmap !== 'function') { B('T14-NOCIB'); return; }
    var p = makePNG(10, 10, 2, 8);
    var blob = new Blob([p], {type:'image/png'});
    createImageBitmap(blob).then(function(bmp) {
      try {
        var clone = structuredClone(bmp, {transfer: [bmp]});
        B('T14-XFER-' + clone.width + 'x' + clone.height);
        try {
          var w2 = bmp.width;
          B('T14-ORIG-ALIVE-' + w2);
        } catch(e) {
          B('T14-ORIG-DEAD');
        }
      } catch(e) {
        B('T14-ERR-' + e.name + '-' + String(e.message).substring(0, 40));
      }
    }).catch(function(e) { B('T14-LOAD-ERR-' + e.name); });
  }]);

  // T15: Double transfer of same ImageBitmap
  tests.push(['T15-DOUBLE-XFER', function() {
    if (typeof createImageBitmap !== 'function') { B('T15-NOCIB'); return; }
    var p = makePNG(10, 10, 2, 8);
    var blob = new Blob([p], {type:'image/png'});
    createImageBitmap(blob).then(function(bmp) {
      try {
        var ch = new MessageChannel();
        ch.port1.postMessage(bmp, [bmp]);
        try {
          ch.port1.postMessage(bmp, [bmp]);
          B('T15-DOUBLE-OK');
        } catch(e2) {
          B('T15-SECOND-ERR-' + e2.name);
        }
      } catch(e) {
        B('T15-FIRST-ERR-' + e.name);
      }
    }).catch(function(e) { B('T15-LOAD-ERR-' + e.name); });
  }]);

  setTimeout(next, 100);
})();
