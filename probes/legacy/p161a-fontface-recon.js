// p161a — FontFace API recon probe
// Tests: FontFace(name, ArrayBuffer) → FreeType parsing on PS5
// Goal: Confirm binary font loading works, test error handling,
//       find what corruptions cause crashes vs clean rejections
// Beacon prefix: V161A-

(function() {
  var T0 = Date.now();
  function B(tag) {
    try { new Image().src = '/BEACON?V161A-' + tag + '&t=' + (Date.now() - T0); } catch(e) {}
  }

  B('BOOT');

  // Minimal TrueType font structure
  // This creates a bare-minimum valid .ttf with one empty glyph
  function buildMinimalTTF() {
    // We need: head, hhea, maxp, OS/2, name, cmap, post, glyf, loca, hmtx
    // For minimal: just enough structure that FreeType accepts it

    var buf = [];
    function w16(v) { buf.push((v >> 8) & 0xFF, v & 0xFF); }
    function w32(v) { buf.push((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF); }
    function wStr(s) { for (var i = 0; i < s.length; i++) buf.push(s.charCodeAt(i)); }
    function pad4() { while (buf.length % 4) buf.push(0); }

    var numTables = 9;
    // Offset table
    w32(0x00010000); // sfVersion (TrueType)
    w16(numTables);
    var sr = 1; while (sr * 2 <= numTables) sr *= 2; sr *= 16;
    w16(sr); // searchRange
    w16(Math.log2 ? Math.floor(Math.log(sr/16)/Math.log(2)) : 3); // entrySelector
    w16(numTables * 16 - sr); // rangeShift

    // Table directory placeholder — we'll fill offsets later
    var dirStart = buf.length;
    var tables = ['cmap','glyf','head','hhea','hmtx','loca','maxp','name','post'];
    for (var t = 0; t < tables.length; t++) {
      wStr(tables[t]);
      w32(0); // checksum placeholder
      w32(0); // offset placeholder
      w32(0); // length placeholder
    }

    function setTableEntry(idx, offset, length) {
      var pos = dirStart + idx * 16 + 8;
      buf[pos] = (offset >> 24) & 0xFF;
      buf[pos+1] = (offset >> 16) & 0xFF;
      buf[pos+2] = (offset >> 8) & 0xFF;
      buf[pos+3] = offset & 0xFF;
      buf[pos+4] = (length >> 24) & 0xFF;
      buf[pos+5] = (length >> 16) & 0xFF;
      buf[pos+6] = (length >> 8) & 0xFF;
      buf[pos+7] = length & 0xFF;
    }

    // head table (54 bytes)
    var headOff = buf.length;
    w32(0x00010000); // version
    w32(0x00005000); // fontRevision
    w32(0); // checksumAdjust
    w32(0x5F0F3CF5); // magicNumber
    w16(0x000B); // flags
    w16(1000); // unitsPerEm
    w32(0); w32(0); // created
    w32(0); w32(0); // modified
    w16(0); // xMin
    w16(0); // yMin
    w16(1000); // xMax
    w16(1000); // yMax
    w16(0); // macStyle
    w16(8); // lowestRecPPEM
    w16(2); // fontDirectionHint
    w16(1); // indexToLocFormat (long)
    w16(0); // glyphDataFormat
    pad4();
    setTableEntry(2, headOff, buf.length - headOff);

    // hhea table (36 bytes)
    var hheaOff = buf.length;
    w32(0x00010000); // version
    w16(800); // ascent
    w16((-200) & 0xFFFF); // descent (signed)
    w16(0); // lineGap
    w16(1000); // advanceWidthMax
    w16(0); // minLeftSideBearing
    w16(0); // minRightSideBearing
    w16(1000); // xMaxExtent
    w16(1); // caretSlopeRise
    w16(0); // caretSlopeRun
    w16(0); // caretOffset
    w16(0); w16(0); w16(0); w16(0); // reserved
    w16(0); // metricDataFormat
    w16(2); // numOfLongHorMetrics
    pad4();
    setTableEntry(3, hheaOff, buf.length - hheaOff);

    // maxp table (32 bytes for TrueType)
    var maxpOff = buf.length;
    w32(0x00010000); // version
    w16(2); // numGlyphs (notdef + space)
    w16(0); // maxPoints
    w16(0); // maxContours
    w16(0); // maxCompositePoints
    w16(0); // maxCompositeContours
    w16(1); // maxZones
    w16(0); // maxTwilightPoints
    w16(0); // maxStorage
    w16(0); // maxFunctionDefs
    w16(0); // maxInstructionDefs
    w16(0); // maxStackElements
    w16(0); // maxSizeOfInstructions
    w16(0); // maxComponentElements
    w16(0); // maxComponentDepth
    pad4();
    setTableEntry(6, maxpOff, buf.length - maxpOff);

    // hmtx table (8 bytes: 2 metrics × 4 bytes)
    var hmtxOff = buf.length;
    w16(500); w16(0); // glyph 0: advanceWidth, lsb
    w16(500); w16(0); // glyph 1: advanceWidth, lsb
    pad4();
    setTableEntry(4, hmtxOff, buf.length - hmtxOff);

    // loca table (long format: 3 entries × 4 bytes = 12 bytes)
    var locaOff = buf.length;
    var glyfOff = buf.length + 12; // glyf starts right after loca
    // We'll fix these after writing glyf
    w32(0); // glyph 0 offset
    w32(0); // glyph 1 offset (same as 0, empty)
    w32(0); // end offset
    pad4();
    setTableEntry(5, locaOff, 12);

    // glyf table (empty glyphs)
    var glyfStart = buf.length;
    // Fix loca to point here
    var go = glyfStart;
    buf[locaOff] = (0 >> 24) & 0xFF; buf[locaOff+1] = 0; buf[locaOff+2] = 0; buf[locaOff+3] = 0;
    buf[locaOff+4] = 0; buf[locaOff+5] = 0; buf[locaOff+6] = 0; buf[locaOff+7] = 0;
    buf[locaOff+8] = 0; buf[locaOff+9] = 0; buf[locaOff+10] = 0; buf[locaOff+11] = 0;
    pad4();
    setTableEntry(1, glyfStart, buf.length - glyfStart);

    // cmap table
    var cmapOff = buf.length;
    w16(0); // version
    w16(1); // numTables
    w16(3); // platformID (Windows)
    w16(1); // encodingID (Unicode BMP)
    w32(12); // offset to subtable
    // Format 4 subtable
    w16(4); // format
    w16(32); // length
    w16(0); // language
    w16(4); // segCountX2
    w16(2); // searchRange
    w16(0); // entrySelector
    w16(2); // rangeShift
    w16(0x0020); // endCode[0] = space
    w16(0xFFFF); // endCode[1] = sentinel
    w16(0); // reservedPad
    w16(0x0020); // startCode[0] = space
    w16(0xFFFF); // startCode[1]
    w16((-0x0020 + 1) & 0xFFFF); // idDelta[0] → maps space to glyph 1
    w16(1); // idDelta[1]
    w16(0); // idRangeOffset[0]
    w16(0); // idRangeOffset[1]
    pad4();
    setTableEntry(0, cmapOff, buf.length - cmapOff);

    // name table (minimal)
    var nameOff = buf.length;
    w16(0); // format
    w16(1); // count
    w16(6 + 12); // stringOffset
    // name record 0: font family
    w16(3); // platformID
    w16(1); // encodingID
    w16(0x0409); // languageID
    w16(1); // nameID (font family)
    w16(8); // length
    w16(0); // offset
    // String data: "Test" in UTF-16BE
    w16(0x0054); w16(0x0065); w16(0x0073); w16(0x0074);
    pad4();
    setTableEntry(7, nameOff, buf.length - nameOff);

    // post table (minimal, format 3)
    var postOff = buf.length;
    w32(0x00030000); // format 3.0
    w32(0); // italicAngle
    w16((-100) & 0xFFFF); // underlinePosition
    w16(50); // underlineThickness
    w32(0); // isFixedPitch
    w32(0); // minMemType42
    w32(0); // maxMemType42
    w32(0); // minMemType1
    w32(0); // maxMemType1
    pad4();
    setTableEntry(8, postOff, buf.length - postOff);

    return new Uint8Array(buf).buffer;
  }

  // Phase 1: Test with valid minimal font
  B('PHASE1-BUILD');
  var validFont;
  try {
    validFont = buildMinimalTTF();
    B('BUILT-' + validFont.byteLength + 'B');
  } catch(e) {
    B('BUILD-ERR-' + String(e).substring(0, 40));
    return;
  }

  B('PHASE1-LOAD');
  try {
    var face1 = new FontFace('P161Test', validFont);
    B('CREATED-' + face1.status);

    face1.load().then(function(loaded) {
      B('LOADED-OK-' + loaded.status);

      // Add to document fonts
      document.fonts.add(loaded);
      B('ADDED');

      // Try rendering
      var el = document.createElement('span');
      el.style.fontFamily = 'P161Test';
      el.style.fontSize = '48px';
      el.textContent = '    '; // spaces (our only mapped glyph)
      document.body.appendChild(el);
      B('RENDERED');

      // Phase 2: Test corrupted fonts
      setTimeout(phase2, 200);
    }).catch(function(err) {
      B('LOAD-REJECT-' + String(err).substring(0, 50));
      // Even if valid font fails, try corrupted ones
      setTimeout(phase2, 200);
    });
  } catch(e) {
    B('FONTFACE-ERR-' + String(e).substring(0, 50));
    setTimeout(phase2, 200);
  }

  function phase2() {
    B('PHASE2-CORRUPT');

    // Test 1: Completely invalid data
    var tests = [];

    // Test A: Random garbage
    var garbage = new ArrayBuffer(256);
    var gv = new Uint8Array(garbage);
    for (var i = 0; i < 256; i++) gv[i] = (i * 7 + 13) & 0xFF;
    tests.push({name: 'GARBAGE', data: garbage});

    // Test B: Valid header, corrupted table offsets (offsets point past end)
    var corruptOff = buildCorruptFont('offset');
    if (corruptOff) tests.push({name: 'BAD-OFFSET', data: corruptOff});

    // Test C: Valid header, table size overflow (size > actual data)
    var corruptSz = buildCorruptFont('size');
    if (corruptSz) tests.push({name: 'BAD-SIZE', data: corruptSz});

    // Test D: Valid header, numTables = 0xFFFF
    var corruptNum = buildCorruptFont('numtables');
    if (corruptNum) tests.push({name: 'BAD-NUMTBL', data: corruptNum});

    // Test E: Valid TrueType magic, 0 length
    var tinyBuf = new ArrayBuffer(12);
    var tv = new Uint8Array(tinyBuf);
    tv[0] = 0; tv[1] = 1; tv[2] = 0; tv[3] = 0; // TrueType magic
    tests.push({name: 'TINY-12B', data: tinyBuf});

    // Test F: CFF font magic (OTTO)
    var ottoMagic = new ArrayBuffer(64);
    var ov = new Uint8Array(ottoMagic);
    ov[0] = 0x4F; ov[1] = 0x54; ov[2] = 0x54; ov[3] = 0x4F; // "OTTO"
    ov[4] = 0; ov[5] = 1; // 1 table
    tests.push({name: 'OTTO-STUB', data: ottoMagic});

    // Test G: WOFF magic
    var woffBuf = new ArrayBuffer(64);
    var wv = new Uint8Array(woffBuf);
    wv[0] = 0x77; wv[1] = 0x4F; wv[2] = 0x46; wv[3] = 0x46; // "wOFF"
    tests.push({name: 'WOFF-STUB', data: woffBuf});

    // Test H: WOFF2 magic
    var woff2Buf = new ArrayBuffer(64);
    var w2v = new Uint8Array(woff2Buf);
    w2v[0] = 0x77; w2v[1] = 0x4F; w2v[2] = 0x46; w2v[3] = 0x32; // "wOF2"
    tests.push({name: 'WOFF2-STUB', data: woff2Buf});

    B('TESTS-' + tests.length);
    runCorruptTests(tests, 0);
  }

  function buildCorruptFont(type) {
    try {
      var base = new Uint8Array(validFont.slice(0));
      var view = new DataView(base.buffer);

      if (type === 'offset') {
        // Corrupt first table's offset to point way past end
        view.setUint32(20, 0x7FFFFFFF); // table[0].offset
      } else if (type === 'size') {
        // Set first table's length to huge value
        view.setUint32(24, 0x7FFFFFFF); // table[0].length
      } else if (type === 'numtables') {
        // Set numTables to max
        view.setUint16(4, 0xFFFF); // numTables
      }
      return base.buffer;
    } catch(e) {
      B('CORRUPT-BUILD-ERR-' + type);
      return null;
    }
  }

  function runCorruptTests(tests, idx) {
    if (idx >= tests.length) {
      B('PHASE2-DONE');
      phase3();
      return;
    }

    var test = tests[idx];
    B('TEST-' + test.name);

    try {
      var face = new FontFace('P161T' + idx, test.data);
      face.load().then(function(ok) {
        B('T-' + test.name + '-OK-' + ok.status);
        setTimeout(function() { runCorruptTests(tests, idx + 1); }, 100);
      }).catch(function(err) {
        var msg = String(err).substring(0, 40);
        B('T-' + test.name + '-REJECT-' + msg);
        setTimeout(function() { runCorruptTests(tests, idx + 1); }, 100);
      });
    } catch(e) {
      B('T-' + test.name + '-THROW-' + String(e).substring(0, 40));
      setTimeout(function() { runCorruptTests(tests, idx + 1); }, 100);
    }
  }

  function phase3() {
    B('PHASE3-LARGE');
    // Phase 3: Test large font to see FreeType memory behavior
    // Build a font with many tables and large data sections
    try {
      var largeBuf = new ArrayBuffer(65536);
      var lv = new Uint8Array(largeBuf);
      var dv = new DataView(largeBuf);

      // Valid TrueType header
      dv.setUint32(0, 0x00010000);
      dv.setUint16(4, 20); // 20 tables
      dv.setUint16(6, 256); // searchRange
      dv.setUint16(8, 4); // entrySelector
      dv.setUint16(10, 64); // rangeShift

      // Fill table directory entries pointing to overlapping regions
      var fakeNames = ['cmap','glyf','head','hhea','hmtx','kern','loca','maxp','name','post',
                       'GDEF','GPOS','GSUB','OS/2','cvt ','fpgm','gasp','prep','DSIG','LTSH'];
      for (var t = 0; t < 20; t++) {
        var off = 12 + t * 16;
        for (var c = 0; c < 4; c++) lv[off + c] = fakeNames[t].charCodeAt(c);
        dv.setUint32(off + 4, 0); // checksum
        dv.setUint32(off + 8, 332 + t * 2048); // offset into data region
        dv.setUint32(off + 12, 2048); // length
      }

      // Fill data region with patterned data
      for (var i = 332; i < 65536; i++) lv[i] = (i & 0xFF);

      var face = new FontFace('P161Large', largeBuf);
      face.load().then(function() {
        B('LARGE-OK');
        B('DONE');
      }).catch(function(err) {
        B('LARGE-REJECT-' + String(err).substring(0, 40));
        B('DONE');
      });
    } catch(e) {
      B('LARGE-ERR-' + String(e).substring(0, 40));
      B('DONE');
    }
  }
})();
