// p185a — SVG font support + FontFace API fuzzing combined probe
// Tests: 1) Does PS5 support SVG <font> elements? 2) FontFace API with corrupted TTF
// Beacon prefix: V185A-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V185A-' + tag + '?t=' + Date.now();
      navigator.sendBeacon(url, body || '');
    } catch(e) {
      try { new Image().src = url; } catch(e2) {}
    }
  }

  B('BOOT');

  // ==================== PART 1: SVG Font Support Test ====================

  try {
    // Create inline SVG with <font> element
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');

    // Check if SVGFontElement exists
    var fontEl = document.createElementNS(svgNS, 'font');
    var tagName = fontEl.constructor.name || fontEl.toString();
    B('SVG-FONT-TAG', tagName);

    if (fontEl instanceof SVGElement) {
      B('SVG-FONT-IS-SVG');
    }
    // Check if it has font-specific properties
    if ('glyphs' in fontEl || fontEl.externalResourcesRequired !== undefined) {
      B('SVG-FONT-HAS-PROPS');
    }

    // Try a full SVG font with glyphs
    var fontFaceEl = document.createElementNS(svgNS, 'font-face');
    fontFaceEl.setAttribute('font-family', 'TestSVGFont');
    fontFaceEl.setAttribute('units-per-em', '1000');

    var glyphEl = document.createElementNS(svgNS, 'glyph');
    glyphEl.setAttribute('unicode', 'A');
    glyphEl.setAttribute('horiz-adv-x', '500');
    glyphEl.setAttribute('d', 'M100 0L250 700L400 0L300 0L250 200L200 0Z');

    var missingEl = document.createElementNS(svgNS, 'missing-glyph');
    missingEl.setAttribute('horiz-adv-x', '500');
    missingEl.setAttribute('d', 'M100 0L100 700L400 700L400 0Z');

    fontEl.setAttribute('horiz-adv-x', '500');
    fontEl.appendChild(fontFaceEl);
    fontEl.appendChild(missingEl);
    fontEl.appendChild(glyphEl);

    var defsEl = document.createElementNS(svgNS, 'defs');
    defsEl.appendChild(fontEl);
    svg.appendChild(defsEl);
    document.body.appendChild(svg);
    B('SVG-FONT-INSERTED');

    // Try using the SVG font via CSS
    var style = document.createElement('style');
    style.textContent = '@font-face { font-family: "TestSVGFont"; src: local("TestSVGFont"); }';
    document.head.appendChild(style);

    var testSpan = document.createElement('span');
    testSpan.style.fontFamily = 'TestSVGFont, serif';
    testSpan.style.fontSize = '48px';
    testSpan.textContent = 'ABCDEF';
    document.body.appendChild(testSpan);
    var w = testSpan.offsetWidth;
    B('SVG-FONT-RENDER', 'w=' + w);

    // Also try via SVG <text> directly
    var textEl = document.createElementNS(svgNS, 'text');
    textEl.setAttribute('font-family', 'TestSVGFont');
    textEl.setAttribute('font-size', '100');
    textEl.setAttribute('x', '10');
    textEl.setAttribute('y', '100');
    textEl.textContent = 'AB';
    svg.setAttribute('width', '400');
    svg.setAttribute('height', '200');
    svg.appendChild(textEl);
    var bbox = textEl.getBBox ? textEl.getBBox() : null;
    B('SVG-TEXT-BBOX', bbox ? 'w=' + Math.round(bbox.width) + ' h=' + Math.round(bbox.height) : 'none');

  } catch(e) {
    B('SVG-FONT-ERR', String(e).substring(0, 100));
  }

  // ==================== PART 2: FontFace API Fuzzing ====================

  if (typeof FontFace === 'undefined') { B('NO-FONTFACE'); return; }
  B('FONTFACE-OK');

  function push16(arr, val) {
    arr.push((val >> 8) & 0xFF, val & 0xFF);
  }
  function push32(arr, val) {
    arr.push((val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF);
  }
  function tag2u32(s) {
    return (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);
  }

  function buildMinimalTTF() {
    // Build a minimal valid TTF as a byte array
    var bytes = [];

    // We'll build tables first, then assemble with proper offsets
    var tables = {};

    // head (54 bytes)
    var head = [];
    push32(head, 0x00010000);  // version
    push32(head, 0x00005000);  // fontRevision
    push32(head, 0);           // checksumAdj
    push32(head, 0x5F0F3CF5); // magic
    push16(head, 0x000B);     // flags
    push16(head, 1000);       // unitsPerEm
    for (var i = 0; i < 16; i++) head.push(0); // created + modified
    push16(head, 0); push16(head, 0); push16(head, 1000); push16(head, 1000); // bbox
    push16(head, 0);  // macStyle
    push16(head, 8);  // lowestRecPPEM
    push16(head, 2);  // fontDirectionHint
    push16(head, 1);  // indexToLocFormat (long)
    push16(head, 0);  // glyphDataFormat
    tables.head = head;

    // maxp (32 bytes)
    var maxp = [];
    push32(maxp, 0x00010000);
    push16(maxp, 2);  // numGlyphs
    for (var i = 0; i < 13; i++) push16(maxp, 0);
    tables.maxp = maxp;

    // hhea (36 bytes)
    var hhea = [];
    push32(hhea, 0x00010000);
    push16(hhea, 800);  push16(hhea, 0xFE38 & 0xFFFF); push16(hhea, 0);
    push16(hhea, 500); // advanceWidthMax
    for (var i = 0; i < 5; i++) push16(hhea, 0);
    for (var i = 0; i < 4; i++) push16(hhea, 0); // reserved
    push16(hhea, 0);   // metricDataFormat
    push16(hhea, 2);   // numberOfHMetrics
    tables.hhea = hhea;

    // hmtx (8 bytes)
    var hmtx = [];
    push16(hmtx, 500); push16(hmtx, 0);
    push16(hmtx, 500); push16(hmtx, 0);
    tables.hmtx = hmtx;

    // cmap: format 4
    var cmap = [];
    push16(cmap, 0); push16(cmap, 1); // version, numTables
    push16(cmap, 3); push16(cmap, 1); push32(cmap, 12); // platform 3, encoding 1, offset 12
    push16(cmap, 4);  // format
    push16(cmap, 32); // length
    push16(cmap, 0);  // language
    push16(cmap, 4);  // segCountX2
    push16(cmap, 4);  // searchRange
    push16(cmap, 1);  // entrySelector
    push16(cmap, 0);  // rangeShift
    push16(cmap, 0x0041); push16(cmap, 0xFFFF); // endCode
    push16(cmap, 0);      // reserved
    push16(cmap, 0x0041); push16(cmap, 0xFFFF); // startCode
    push16(cmap, 0xFFFF & (-64)); push16(cmap, 1); // idDelta
    push16(cmap, 0); push16(cmap, 0); // idRangeOffset
    tables.cmap = cmap;

    // loca (long format, 3 entries)
    var loca = [];
    push32(loca, 0); push32(loca, 0); push32(loca, 0);
    tables.loca = loca;

    // glyf (empty)
    tables.glyf = [];

    // post (format 3.0, 32 bytes)
    var post = [];
    push32(post, 0x00030000);
    push32(post, 0); // italicAngle
    push16(post, 0xFF9C & 0xFFFF); push16(post, 50);
    push32(post, 0); push32(post, 0); push32(post, 0); push32(post, 0);
    tables.post = post;

    // name table
    var nameStr = [0,70,0,117,0,122,0,122]; // "Fuzz" in UTF-16BE
    var name = [];
    push16(name, 0); push16(name, 4); // format, count
    push16(name, 6 + 4 * 12);         // stringOffset
    var nids = [1, 2, 4, 6];
    for (var n = 0; n < 4; n++) {
      push16(name, 3); push16(name, 1); push16(name, 0x0409);
      push16(name, nids[n]); push16(name, nameStr.length); push16(name, 0);
    }
    for (var i = 0; i < nameStr.length; i++) name.push(nameStr[i]);
    tables.name = name;

    return tables;
  }

  function assembleTTF(tables, mutations) {
    var tagOrder = ['cmap','glyf','head','hhea','hmtx','loca','maxp','name','post'];
    tagOrder.sort();
    var nt = tagOrder.length;
    var headerSz = 12 + nt * 16;

    // Pad each table to 4 bytes
    var padded = {};
    var off = headerSz;
    var offsets = {};
    for (var i = 0; i < nt; i++) {
      var t = tables[tagOrder[i]];
      var pad = (4 - (t.length % 4)) % 4;
      padded[tagOrder[i]] = t.concat(new Array(pad).fill(0));
      offsets[tagOrder[i]] = off;
      off += padded[tagOrder[i]].length;
    }
    var total = off;
    var buf = new ArrayBuffer(total);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // sfnt header
    dv.setUint32(0, 0x00010000);
    dv.setUint16(4, nt);
    var sr = 16; while (sr * 2 <= nt * 16) sr *= 2;
    dv.setUint16(6, sr);
    dv.setUint16(8, Math.log2(sr / 16));
    dv.setUint16(10, nt * 16 - sr);

    // Table directory
    for (var i = 0; i < nt; i++) {
      var dirOff = 12 + i * 16;
      dv.setUint32(dirOff, tag2u32(tagOrder[i]));
      dv.setUint32(dirOff + 4, 0); // checksum (skip)
      dv.setUint32(dirOff + 8, offsets[tagOrder[i]]);
      dv.setUint32(dirOff + 12, tables[tagOrder[i]].length);
    }

    // Table data
    for (var i = 0; i < nt; i++) {
      var data = padded[tagOrder[i]];
      var o = offsets[tagOrder[i]];
      for (var j = 0; j < data.length; j++) u8[o + j] = data[j];
    }

    // Apply mutations
    if (mutations) mutations(dv, u8, buf, tagOrder, offsets, total);

    return buf;
  }

  var baseTables = buildMinimalTTF();
  B('TTF-BUILT');

  var tests = [
    { name: 'VALID', mut: null },
    { name: 'MAXP-FFFF', mut: function(dv,u8,buf,tags,offs) {
      dv.setUint16(offs.maxp + 4, 0xFFFF);
    }},
    { name: 'HHEA-HMETRICS-FFFF', mut: function(dv,u8,buf,tags,offs) {
      dv.setUint16(offs.hhea + 34, 0xFFFF);
    }},
    { name: 'HEAD-LOCA-FMT-FF', mut: function(dv,u8,buf,tags,offs) {
      dv.setInt16(offs.head + 50, 0xFF);
    }},
    { name: 'LOCA-OOB', mut: function(dv,u8,buf,tags,offs) {
      dv.setUint32(offs.loca, 0x7FFFFFFF);
    }},
    { name: 'CMAP-HUGE-SEG', mut: function(dv,u8,buf,tags,offs) {
      dv.setUint16(offs.cmap + 12 + 6, 0xFFFE);
    }},
    { name: 'HEAD-UPEM-0', mut: function(dv,u8,buf,tags,offs) {
      dv.setUint16(offs.head + 18, 0);
    }},
    { name: 'DIR-LEN-HUGE', mut: function(dv,u8,buf,tags,offs) {
      // Corrupt head table length in directory to huge value
      for (var i = 0; i < tags.length; i++) {
        if (tags[i] === 'head') { dv.setUint32(12 + i * 16 + 12, 0xFFFFFFFF); break; }
      }
    }},
    { name: 'DIR-OFF-OOB', mut: function(dv,u8,buf,tags,offs) {
      for (var i = 0; i < tags.length; i++) {
        if (tags[i] === 'maxp') { dv.setUint32(12 + i * 16 + 8, buf.byteLength + 0x10000); break; }
      }
    }},
    { name: 'SFNT-OTTO', mut: function(dv,u8,buf,tags,offs) {
      // Switch to CFF mode sfnt tag — no CFF table, should confuse parser
      dv.setUint32(0, 0x4F54544F); // 'OTTO'
    }},
    { name: 'MAXP-0', mut: function(dv,u8,buf,tags,offs) {
      dv.setUint16(offs.maxp + 4, 0);
    }},
    { name: 'NUMTABLES-0', mut: function(dv,u8,buf,tags,offs) {
      dv.setUint16(4, 0);
    }}
  ];

  var tidx = 0;
  function nextTest() {
    if (tidx >= tests.length) { B('ALL-DONE', tests.length + ' tests'); return; }
    var test = tests[tidx];
    var idx = tidx++;
    B('T' + idx + '-' + test.name);

    try {
      var fontBuf = assembleTTF(baseTables, test.mut);
      var face = new FontFace('FF' + idx, fontBuf);

      face.load().then(function(loaded) {
        B('T' + idx + '-LOADED');
        document.fonts.add(loaded);

        // Render to trigger glyph loading
        var el = document.createElement('span');
        el.style.fontFamily = 'FF' + idx + ', serif';
        el.style.fontSize = '48px';
        el.textContent = 'ABCDEFGHIJ';
        document.body.appendChild(el);
        var w = el.offsetWidth;
        B('T' + idx + '-RENDER', w + 'px');

        // Canvas render
        try {
          var c = document.createElement('canvas');
          c.width = 300; c.height = 80;
          var ctx = c.getContext('2d');
          ctx.font = '48px FF' + idx;
          ctx.fillText('Test ABC', 10, 60);
          B('T' + idx + '-CANVAS-OK');
        } catch(ce) {
          B('T' + idx + '-CANVAS-ERR', String(ce).substring(0, 60));
        }

        document.body.removeChild(el);
        try { document.fonts.delete(loaded); } catch(e) {}
        setTimeout(nextTest, 30);
      }).catch(function(err) {
        B('T' + idx + '-REJECT', String(err).substring(0, 60));
        setTimeout(nextTest, 30);
      });
    } catch(e) {
      B('T' + idx + '-ERR', String(e).substring(0, 60));
      setTimeout(nextTest, 30);
    }
  }

  // Start tests after SVG font test settles
  setTimeout(nextTest, 200);
})();
