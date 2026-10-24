// p181 — Definitive JIT detection for PS5 14.20
// Multiple independent signals to determine if DFG/FTL/Baseline JIT is active
// Beacon prefix: V181-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V181-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // High-resolution timing helper (falls back to Date.now)
  var hasPerf = (typeof performance !== 'undefined' && typeof performance.now === 'function');
  function now() {
    return hasPerf ? performance.now() : Date.now();
  }
  syncB('PERF-' + (hasPerf ? 'YES' : 'NO'));

  // ================================================================
  // TEST 1: Timing discontinuity — the gold standard JIT detection
  //
  // Run a simple function at increasing iteration counts.
  // Sample the per-iteration cost at each checkpoint.
  // JIT: sharp speedup after ~1000 (Baseline) or ~5000 (DFG) iterations
  // LLInt-only: flat or gradually improving (IC caches warm, no cliff)
  // ================================================================

  try {
    syncB('T1-START');

    function arith(a, b) {
      return (a * b + a - b) | 0;
    }

    var checkpoints = [100, 500, 1000, 2000, 5000, 10000, 50000, 100000, 200000, 500000];
    var SAMPLE = 200; // iterations to time at each checkpoint
    var totalIter = 0;
    var dummy = 0;

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var target = checkpoints[ci];

      // Run up to the checkpoint
      while (totalIter < target) {
        dummy = arith(totalIter, 7);
        totalIter++;
      }

      // Now time SAMPLE iterations
      var t0 = now();
      for (var s = 0; s < SAMPLE; s++) {
        dummy = arith(totalIter + s, 13);
      }
      var t1 = now();

      // Report: microseconds per iteration (multiply by 1000 if using ms)
      var usPerIter = ((t1 - t0) / SAMPLE * 1000).toFixed(0); // nanoseconds
      syncB('T1-' + target + '-' + usPerIter + 'ns');
    }

    syncB('T1-DONE');
  } catch(e) {
    syncB('T1-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // TEST 2: Type speculation deopt
  //
  // Warm a function on integers, then pass a string.
  // JIT: speculates int, deoptimizes on string → measurably slower
  // LLInt: handles both types at the same speed (no speculation)
  // ================================================================

  try {
    syncB('T2-START');

    function addTwo(a, b) {
      return a + b;
    }

    // Warm on integers
    var d2 = 0;
    for (var i = 0; i < 100000; i++) {
      d2 = addTwo(i, i + 1);
    }

    // Time 1000 integer calls (hot)
    var t2a = now();
    for (var i = 0; i < 1000; i++) {
      d2 = addTwo(i, i + 1);
    }
    var t2b = now();
    var intTime = ((t2b - t2a) * 1000).toFixed(0); // total ns for 1000 calls

    // Now pass strings — forces deopt if JIT is active
    var t2c = now();
    for (var i = 0; i < 1000; i++) {
      d2 = addTwo("hello", "world");
    }
    var t2d = now();
    var strTime = ((t2d - t2c) * 1000).toFixed(0);

    // Ratio > 3x suggests JIT deopt happened
    var ratio = (t2d - t2c) / Math.max(t2b - t2a, 0.001);
    syncB('T2-INT-' + intTime + 'ns-STR-' + strTime + 'ns-RATIO-' + ratio.toFixed(1));

    syncB('T2-DONE');
  } catch(e) {
    syncB('T2-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // TEST 3: WASM availability
  //
  // JIT and WASM are usually coupled. If WASM is off, JIT is almost
  // certainly off too (they share the executable allocator).
  // ================================================================

  try {
    syncB('T3-START');

    var hasWasm = (typeof WebAssembly !== 'undefined');
    syncB('T3-WASM-' + (hasWasm ? 'YES' : 'NO'));

    if (hasWasm) {
      // Try to compile a minimal module
      try {
        var wasmBytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,6,1,2,102,110,0,0,10,6,1,4,0,65,42,11]);
        var wasmMod = new WebAssembly.Module(wasmBytes);
        var wasmInst = new WebAssembly.Instance(wasmMod);
        var wasmResult = wasmInst.exports.fn();
        syncB('T3-WASM-EXEC-' + wasmResult); // should be 42
      } catch(e2) {
        syncB('T3-WASM-COMPILE-FAIL-' + (e2.message || '').substring(0, 40));
      }
    }

    syncB('T3-DONE');
  } catch(e) {
    syncB('T3-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // TEST 4: Property access IC behavior
  //
  // Inline caches (ICs) exist in both LLInt and JIT, but JIT ICs are
  // much faster. Monomorphic vs polymorphic access timing reveals
  // whether compiled ICs are in use.
  //
  // Mono: always same shape → fast IC hit
  // Poly: rotating shapes → IC misses, slow path
  // JIT: mono/poly ratio > 3x
  // LLInt: ratio ~1-2x (LLInt ICs are simpler)
  // ================================================================

  try {
    syncB('T4-START');

    // Create objects with same shape
    var monoObjs = [];
    for (var i = 0; i < 100; i++) {
      monoObjs[i] = { x: i, y: i * 2 };
    }

    // Create objects with DIFFERENT shapes
    var polyObjs = [];
    for (var i = 0; i < 100; i++) {
      var o = {};
      // Add properties in different orders to create different structures
      if (i % 4 === 0) { o.x = i; o.y = i * 2; }
      else if (i % 4 === 1) { o.y = i * 2; o.x = i; }
      else if (i % 4 === 2) { o.x = i; o.z = 0; o.y = i * 2; }
      else { o.w = 0; o.x = i; o.y = i * 2; }
      polyObjs[i] = o;
    }

    function readProp(obj) {
      return obj.x + obj.y;
    }

    // Warm up on monomorphic
    var d4 = 0;
    for (var i = 0; i < 50000; i++) {
      d4 = readProp(monoObjs[i % 100]);
    }

    // Time monomorphic
    var t4a = now();
    for (var i = 0; i < 100000; i++) {
      d4 = readProp(monoObjs[i % 100]);
    }
    var t4b = now();
    var monoNs = ((t4b - t4a) * 1000).toFixed(0);

    // Time polymorphic (fresh function to avoid JIT seeing previous types)
    function readProp2(obj) {
      return obj.x + obj.y;
    }
    for (var i = 0; i < 50000; i++) {
      d4 = readProp2(polyObjs[i % 100]);
    }
    var t4c = now();
    for (var i = 0; i < 100000; i++) {
      d4 = readProp2(polyObjs[i % 100]);
    }
    var t4d = now();
    var polyNs = ((t4d - t4c) * 1000).toFixed(0);

    var icRatio = (t4d - t4c) / Math.max(t4b - t4a, 0.001);
    syncB('T4-MONO-' + monoNs + 'ns-POLY-' + polyNs + 'ns-RATIO-' + icRatio.toFixed(1));

    syncB('T4-DONE');
  } catch(e) {
    syncB('T4-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // TEST 5: Worker JIT availability
  //
  // Workers may have different JIT settings than the main thread.
  // Run the timing test inside a Worker and compare.
  // ================================================================

  try {
    syncB('T5-START');

    var workerSrc = [
      '"use strict";',
      'var sum = 0;',
      'function hot(a, b) { return (a * b + a - b) | 0; }',
      '',
      'var hasP = (typeof performance !== "undefined" && typeof performance.now === "function");',
      'function now2() { return hasP ? performance.now() : Date.now(); }',
      '',
      '// Run 500K iterations, sample at checkpoints',
      'var cps = [1000, 10000, 100000, 500000];',
      'var results = [];',
      'var total = 0;',
      'for (var ci = 0; ci < cps.length; ci++) {',
      '  var tgt = cps[ci];',
      '  while (total < tgt) { sum = hot(total, 7); total++; }',
      '  var s0 = now2();',
      '  for (var s = 0; s < 200; s++) sum = hot(total + s, 13);',
      '  var s1 = now2();',
      '  results.push(tgt + "=" + ((s1 - s0) / 200 * 1000000).toFixed(0) + "ns");',
      '}',
      'self.postMessage(results.join(","));'
    ].join('\n');

    var blob = new Blob([workerSrc], { type: 'text/javascript' });
    var url = URL.createObjectURL(blob);
    var worker = new Worker(url);

    worker.onmessage = function(e) {
      syncB('T5-WORKER-' + e.data);
      syncB('T5-DONE');
      URL.revokeObjectURL(url);
    };

    worker.onerror = function(e) {
      syncB('T5-WORKER-ERR-' + (e.message || '').substring(0, 40));
      syncB('T5-DONE');
      URL.revokeObjectURL(url);
    };

    // Timeout fallback
    setTimeout(function() {
      try { worker.terminate(); } catch(e3) {}
      // T5-DONE may or may not have fired
    }, 8000);

  } catch(e) {
    syncB('T5-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // TEST 6: Large function first-call latency
  //
  // Define a function with ~2000 simple statements.
  // With Baseline JIT: first call compiles it → noticeable delay
  // Without JIT: first call = subsequent calls
  // ================================================================

  try {
    syncB('T6-START');

    // Build a large function body via array join
    var parts = ['var r = 0;'];
    for (var i = 0; i < 2000; i++) {
      parts.push('r = r + ' + (i % 100) + ';');
    }
    parts.push('return r;');

    var bigFn = new Function(parts.join('\n'));

    // Time first call
    var t6a = now();
    var r6 = bigFn();
    var t6b = now();
    var firstCallUs = ((t6b - t6a) * 1000).toFixed(0);

    // Time second call
    var t6c = now();
    r6 = bigFn();
    var t6d = now();
    var secondCallUs = ((t6d - t6c) * 1000).toFixed(0);

    // Time after 100 calls
    for (var i = 0; i < 100; i++) r6 = bigFn();
    var t6e = now();
    r6 = bigFn();
    var t6f = now();
    var hotCallUs = ((t6f - t6e) * 1000).toFixed(0);

    syncB('T6-FIRST-' + firstCallUs + 'ns-SECOND-' + secondCallUs + 'ns-HOT-' + hotCallUs + 'ns');

    syncB('T6-DONE');
  } catch(e) {
    syncB('T6-ERR-' + (e.message || '').substring(0, 40));
  }

  // ================================================================
  // TEST 7: RegExp JIT
  //
  // JSC has a separate RegExp JIT (YARR JIT). Test if regex execution
  // shows the speedup characteristic of compiled regexes.
  // ================================================================

  try {
    syncB('T7-START');

    var testStr = '';
    for (var i = 0; i < 1000; i++) testStr += 'abcdefghij';
    var re = /[a-f]{3,5}[g-j]+/g;

    // First run (cold regex)
    var t7a = now();
    var m7 = testStr.match(re);
    var t7b = now();
    var coldNs = ((t7b - t7a) * 1000).toFixed(0);

    // Subsequent runs (regex JIT should have compiled)
    var t7c = now();
    for (var i = 0; i < 100; i++) {
      re.lastIndex = 0;
      m7 = testStr.match(re);
    }
    var t7d = now();
    var hotNs = (((t7d - t7c) / 100) * 1000).toFixed(0);

    syncB('T7-COLD-' + coldNs + 'ns-HOT-' + hotNs + 'ns-MATCHES-' + (m7 ? m7.length : 0));

    syncB('T7-DONE');
  } catch(e) {
    syncB('T7-ERR-' + (e.message || '').substring(0, 40));
  }

  syncB('COMPLETE');
})();
