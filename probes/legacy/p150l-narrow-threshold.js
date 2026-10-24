// p150l — Narrow down the exact N threshold between 1M and 5M
// Also test: can we compile TWO functions sequentially? (memory freed between?)
// Beacon prefix: V150L-

(function() {
  function B(tag) {
    try { new Image().src = '/BEACON?V150L-' + tag + '&t=' + Date.now(); } catch(e) {}
  }

  B('BOOT');

  // Phase 1: Binary search between 1M and 5M
  var Ns = [2000000, 3000000, 4000000];
  var idx = 0;

  function testEval(n, cb) {
    B('T-' + (n/1000000) + 'M-START');
    window.__bfn = null;
    window.__bok = 0;

    // Build source in chunks to avoid single huge string
    var t0 = Date.now();
    try {
      var CHUNK = 500000;
      var src = 'window.__bfn=function(a){';
      for (var c = 0; c < n; c += CHUNK) {
        var thisChunk = Math.min(CHUNK, n - c);
        src += 'a();'.repeat(thisChunk);
      }
      src += '};window.__bok=1;';
      eval(src);
      src = null;
    } catch(e) {
      B('T-' + (n/1000000) + 'M-EVALERR-' + e.message.substring(0, 30));
      cb();
      return;
    }
    var compileMs = Date.now() - t0;
    B('T-' + (n/1000000) + 'M-COMPILED-' + compileMs + 'ms');

    if (!window.__bok) {
      B('T-' + (n/1000000) + 'M-FAIL');
      cb();
      return;
    }

    // Call with throw-at-10
    var cnt = 0;
    try {
      window.__bfn(function() {
        cnt++;
        if (cnt >= 10) throw 'bail';
      });
    } catch(e) {}

    if (cnt > 0) {
      B('T-' + (n/1000000) + 'M-OK-' + cnt);
    } else {
      B('T-' + (n/1000000) + 'M-CRASH-0');
    }

    // Free the function to reclaim memory
    window.__bfn = null;
    window.__bok = 0;
    cb();
  }

  function runNext() {
    if (idx >= Ns.length) {
      // Phase 2: Test cumulative effect — compile 10 x 1M functions
      B('PHASE2-CUMUL');
      var passed = 0;
      for (var r = 0; r < 10; r++) {
        window.__bfn = null;
        window.__bok = 0;
        try {
          eval('window.__bfn=function(a){' + 'a();'.repeat(1000000) + '};window.__bok=1;');
        } catch(e) {
          B('CUMUL-R' + r + '-EVALERR');
          break;
        }
        if (!window.__bok) { B('CUMUL-R' + r + '-FAIL'); break; }
        var cnt = 0;
        try {
          window.__bfn(function() { cnt++; if (cnt >= 10) throw 'bail'; });
        } catch(e) {}
        if (cnt > 0) {
          passed++;
        } else {
          B('CUMUL-R' + r + '-EXEC-CRASH');
          break;
        }
      }
      B('PHASE2-PASSED-' + passed + '-OF-10');

      // Phase 3: Can we get total metadata > 2^32 by accumulating across functions
      // sharing an UnlinkedCodeBlock? (Probably not, each gets its own)
      // Instead test: what's the max SINGLE function we can run?
      // Finer granularity between max-working and min-failing
      B('DONE');
      return;
    }
    var n = Ns[idx];
    idx++;
    testEval(n, runNext);
  }

  runNext();
})();
