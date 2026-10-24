// p150k — Binary search for max working N (op_call count)
// Tests: 100, 10K, 100K, 1M, 5M, 10M, 20M, 30M, 38348816
// For N<=5M: eval(). For N>5M: Blob URL (async, sequential).
// Beacon prefix: V150K-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150K-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  var Ns = [100, 10000, 100000, 1000000, 5000000, 10000000, 20000000, 30000000, 38348816];
  var idx = 0;

  function buildSmall(n) {
    var src = 'window.__bfn=function(a){' + 'a();'.repeat(n) + '};window.__bok=1;';
    return src;
  }

  function testN(n, cb) {
    B('TEST-N-' + n + '-START');
    window.__bfn = null;
    window.__bok = 0;

    if (n <= 5000000) {
      // eval approach
      var t0 = Date.now();
      try {
        eval(buildSmall(n));
      } catch(e) {
        B('COMPILE-N-' + n + '-EVALERR');
        cb();
        return;
      }
      B('COMPILE-N-' + n + '-' + (Date.now() - t0) + 'ms');

      if (!window.__bok) {
        B('TEST-N-' + n + '-COMPILEFAIL');
        cb();
        return;
      }

      var cnt = 0;
      try {
        window.__bfn(function() {
          cnt++;
          if (cnt >= 10) throw 'bail';
        });
      } catch(e) {}
      if (cnt > 0) {
        B('TEST-N-' + n + '-OK-' + cnt);
      } else {
        B('TEST-N-' + n + '-CRASH');
      }
      cb();
    } else {
      // Blob URL approach for large N
      var CHUNK = 4000000;
      var chunksN = Math.floor(n / CHUNK);
      var rem = n - chunksN * CHUNK;
      var callChunk = 'a();'.repeat(CHUNK);
      var parts = new Array(chunksN + 3);
      parts[0] = 'window.__bfn=function(a){';
      for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
      parts[chunksN + 1] = 'a();'.repeat(rem);
      parts[chunksN + 2] = '};window.__bok=1;';
      callChunk = null;

      var blob = new Blob(parts, {type: 'application/javascript'});
      parts = null;

      var t0 = Date.now();
      var url = URL.createObjectURL(blob);
      var sc = document.createElement('script');
      sc.onerror = function() {
        B('COMPILE-N-' + n + '-SCRIPTERR');
        URL.revokeObjectURL(url);
        cb();
      };
      sc.onload = function() {
        blob = null;
        URL.revokeObjectURL(url);
        B('COMPILE-N-' + n + '-' + (Date.now() - t0) + 'ms');

        if (!window.__bok) {
          B('TEST-N-' + n + '-COMPILEFAIL');
          cb();
          return;
        }

        var cnt = 0;
        try {
          window.__bfn(function() {
            cnt++;
            if (cnt >= 10) throw 'bail';
          });
        } catch(e) {}
        if (cnt > 0) {
          B('TEST-N-' + n + '-OK-' + cnt);
        } else {
          B('TEST-N-' + n + '-CRASH');
        }
        cb();
      };
      document.head.appendChild(sc);
      sc.src = url;
    }
  }

  function runNext() {
    if (idx >= Ns.length) {
      B('DONE');
      return;
    }
    var n = Ns[idx];
    idx++;
    testN(n, runNext);
  }

  runNext();
})();
