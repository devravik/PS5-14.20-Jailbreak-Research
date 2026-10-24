// p161a — FontFace API recon: edge cases and parser fuzzing
// Beacon prefix: V161A-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V161A-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  // Helper: build an ArrayBuffer from a hex string
  function hexBuf(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < hex.length; i += 2)
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    return bytes.buffer;
  }

  // Helper: build a DataView and write values
  function makeFont(opts) {
    var numTables = opts.numTables || 7;
    var headerSize = 12 + numTables * 16;
    var totalSize = opts.totalSize || (headerSize + 512);
    var buf = new ArrayBuffer(totalSize);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // Offset table
    dv.setUint32(0, opts.sfVersion || 0x00010000); // sfVersion (TrueType)
    dv.setUint16(4, numTables & 0xFFFF);
    dv.setUint16(6, 0); // searchRange
    dv.setUint16(8, 0); // entrySelector
    dv.setUint16(10, 0); // rangeShift

    var tags = ['cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp',
                'name', 'post', 'OS/2'];
    var dataOff = headerSize;

    for (var t = 0; t < Math.min(numTables, tags.length); t++) {
      var dirOff = 12 + t * 16;
      var tag = tags[t] || 'XXXX';
      for (var c = 0; c < 4; c++)
        u8[dirOff + c] = tag.charCodeAt(c) || 0x20;

      dv.setUint32(dirOff + 4, 0); // checksum
      var tblOffset = opts.tableOffset !== undefined ? opts.tableOffset : dataOff;
      var tblLength = opts.tableLength !== undefined ? opts.tableLength : 64;
      dv.setUint32(dirOff + 8, tblOffset);
      dv.setUint32(dirOff + 12, tblLength);
      dataOff += 64;
    }

    // Minimal head table data at expected offset
    if (numTables >= 3 && !opts.skipHead) {
      var headOff = 12 + numTables * 16 + 128; // after cmap, glyf
      if (headOff + 54 < totalSize) {
        dv.setUint32(headOff, 0x00010000); // version
        dv.setUint32(headOff + 4, 0x00010000); // fontRevision
        dv.setUint32(headOff + 8, opts.headChecksum || 0); // checksumAdjustment
        dv.setUint32(headOff + 12, 0x5F0F3CF5); // magicNumber
        dv.setUint16(headOff + 16, opts.headFlags || 0x000B);
        dv.setUint16(headOff + 18, opts.unitsPerEm || 1000);
      }
    }

    // Minimal maxp
    if (numTables >= 7 && !opts.skipMaxp) {
      var maxpOff = 12 + numTables * 16 + 384;
      if (maxpOff + 6 < totalSize) {
        dv.setUint32(maxpOff, 0x00010000); // version
        dv.setUint16(maxpOff + 4, opts.numGlyphs || 1);
      }
    }

    return buf;
  }

  // Convert ArrayBuffer to data URL for FontFace
  function bufToDataUrl(buf) {
    var u8 = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return 'data:font/ttf;base64,' + btoa(bin);
  }

  var tests = [];
  var testIdx = 0;

  // T0: FontFace constructor exists
  tests.push(['T0-API', function() {
    var has = typeof FontFace !== 'undefined';
    B('T0-FF-' + (has ? 'YES' : 'NO'));
    B('T0-DOCFONTS-' + (typeof document.fonts !== 'undefined' ? 'YES' : 'NO'));
    if (has) {
      var props = [];
      try { var f = new FontFace('x', 'url(x)'); props = Object.keys(f); } catch(e) {}
      B('T0-PROPS-' + props.length);
    }
  }]);

  // T1: Valid-ish font load
  tests.push(['T1-VALID', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024});
    var url = bufToDataUrl(buf);
    var f = new FontFace('TestT1', 'url(' + url + ')');
    f.load().then(function() {
      B('T1-LOADED-OK');
      try {
        document.fonts.add(f);
        B('T1-ADD-OK');
      } catch(e) { B('T1-ADD-ERR-' + e.name); }
    }).catch(function(e) {
      B('T1-LOAD-ERR-' + e.name);
    });
  }]);

  // T2: numTables = 0
  tests.push(['T2-ZERO-TABLES', function() {
    var buf = makeFont({numTables: 0, totalSize: 64});
    var f = new FontFace('TestT2', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T2-OK'); })
      .catch(function(e) { B('T2-ERR-' + e.name); });
  }]);

  // T3: numTables = 0xFFFF
  tests.push(['T3-MAXTABLES', function() {
    var buf = makeFont({numTables: 0xFFFF, totalSize: 256});
    var f = new FontFace('TestT3', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T3-OK'); })
      .catch(function(e) { B('T3-ERR-' + e.name); });
  }]);

  // T4: Table offset past EOF
  tests.push(['T4-OOB-OFFSET', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024, tableOffset: 0xFFFFF0});
    var f = new FontFace('TestT4', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T4-OK'); })
      .catch(function(e) { B('T4-ERR-' + e.name); });
  }]);

  // T5: Table length = 0
  tests.push(['T5-ZERO-LEN', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024, tableLength: 0});
    var f = new FontFace('TestT5', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T5-OK'); })
      .catch(function(e) { B('T5-ERR-' + e.name); });
  }]);

  // T6: Table length = 0xFFFFFFFF
  tests.push(['T6-MAX-LEN', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024, tableLength: 0xFFFFFFFF});
    var f = new FontFace('TestT6', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T6-OK'); })
      .catch(function(e) { B('T6-ERR-' + e.name); });
  }]);

  // T7: sfVersion = 'OTTO' (CFF font)
  tests.push(['T7-CFF', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024, sfVersion: 0x4F54544F});
    var f = new FontFace('TestT7', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T7-OK'); })
      .catch(function(e) { B('T7-ERR-' + e.name); });
  }]);

  // T8: WOFF signature with mismatched sizes
  tests.push(['T8-WOFF', function() {
    var buf = new ArrayBuffer(256);
    var dv = new DataView(buf);
    dv.setUint32(0, 0x774F4646); // 'wOFF' signature
    dv.setUint32(4, 0x00010000); // flavor (TrueType)
    dv.setUint32(8, 256); // WOFF length
    dv.setUint16(12, 1); // numTables
    dv.setUint16(14, 0); // reserved
    dv.setUint32(16, 0xFFFFFFFF); // totalSfntSize (overflow value)
    dv.setUint16(20, 1); // majorVersion
    dv.setUint16(22, 0); // minorVersion
    dv.setUint32(24, 0); // metaOffset
    dv.setUint32(28, 0); // metaLength
    dv.setUint32(32, 0); // metaOrigLength
    dv.setUint32(36, 0); // privOffset
    dv.setUint32(40, 0); // privLength
    // Table dir entry
    dv.setUint32(44, 0x68656164); // 'head'
    dv.setUint32(48, 64); // offset
    dv.setUint32(52, 54); // compLength
    dv.setUint32(56, 54); // origLength (uncompressed)
    dv.setUint32(60, 0); // origChecksum
    var f = new FontFace('TestT8', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T8-OK'); })
      .catch(function(e) { B('T8-ERR-' + e.name); });
  }]);

  // T9: WOFF numTables overflow
  tests.push(['T9-WOFF-MAXTBL', function() {
    var buf = new ArrayBuffer(256);
    var dv = new DataView(buf);
    dv.setUint32(0, 0x774F4646); // 'wOFF'
    dv.setUint32(4, 0x00010000);
    dv.setUint32(8, 256);
    dv.setUint16(12, 0x0FFF); // numTables = max allowed (0x0FFF)
    dv.setUint16(14, 0);
    dv.setUint32(16, 0x00100000); // totalSfntSize
    var f = new FontFace('TestT9', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T9-OK'); })
      .catch(function(e) { B('T9-ERR-' + e.name); });
  }]);

  // T10: Huge numGlyphs in maxp
  tests.push(['T10-MAXGLYPHS', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024, numGlyphs: 0xFFFF});
    var f = new FontFace('TestT10', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T10-OK'); })
      .catch(function(e) { B('T10-ERR-' + e.name); });
  }]);

  // T11: unitsPerEm = 0 (division by zero risk)
  tests.push(['T11-UPE0', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024, unitsPerEm: 0});
    var f = new FontFace('TestT11', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() {
      B('T11-OK');
      try {
        document.fonts.add(f);
        var c = document.createElement('canvas');
        c.width = 200; c.height = 50;
        var ctx = c.getContext('2d');
        ctx.font = '48px TestT11';
        ctx.fillText('ABCD', 10, 40);
        B('T11-DRAW-OK');
      } catch(e) { B('T11-DRAW-ERR-' + e.name); }
    }).catch(function(e) { B('T11-ERR-' + e.name); });
  }]);

  // T12: Canvas render with valid-ish font
  tests.push(['T12-CANVAS', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024});
    var f = new FontFace('TestT12', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() {
      document.fonts.add(f);
      var c = document.createElement('canvas');
      c.width = 200; c.height = 50;
      var ctx = c.getContext('2d');
      ctx.font = '24px TestT12';
      ctx.fillText('Test', 10, 30);
      var px = ctx.getImageData(0, 0, 200, 50).data;
      var nz = 0;
      for (var i = 0; i < px.length; i += 4) if (px[i+3] > 0) nz++;
      B('T12-PIXELS-' + nz);
    }).catch(function(e) { B('T12-ERR-' + e.name); });
  }]);

  // T13: ArrayBuffer source (not URL)
  tests.push(['T13-ARRAYBUF', function() {
    var buf = makeFont({numTables: 7, totalSize: 1024});
    var f = new FontFace('TestT13', buf);
    f.load().then(function() { B('T13-OK'); })
      .catch(function(e) { B('T13-ERR-' + e.name); });
  }]);

  // T14: 'wOF2' signature (WOFF2)
  tests.push(['T14-WOFF2', function() {
    var buf = new ArrayBuffer(256);
    var dv = new DataView(buf);
    dv.setUint32(0, 0x774F4632); // 'wOF2'
    dv.setUint32(4, 0x00010000);
    dv.setUint32(8, 256);
    dv.setUint16(12, 1);
    dv.setUint16(14, 0);
    dv.setUint32(16, 512); // totalSfntSize
    dv.setUint32(20, 200); // totalCompressedSize
    var f = new FontFace('TestT14', 'url(' + bufToDataUrl(buf) + ')');
    f.load().then(function() { B('T14-OK'); })
      .catch(function(e) { B('T14-ERR-' + e.name); });
  }]);

  // Run tests sequentially with delay
  function runNext() {
    if (testIdx >= tests.length) { B('ALL-DONE'); return; }
    var name = tests[testIdx][0];
    var fn = tests[testIdx][1];
    testIdx++;
    B(name + '-START');
    try { fn(); } catch(e) { B(name + '-THROW-' + e.name + '-' + String(e.message).substring(0, 30)); }
    setTimeout(runNext, 300);
  }

  setTimeout(runNext, 100);
})();
