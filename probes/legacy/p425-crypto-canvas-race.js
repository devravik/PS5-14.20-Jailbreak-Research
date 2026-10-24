/*
 * p425 -- SubtleCrypto race + Canvas ImageData detach + WeakRef GC timing
 *
 * V423-E showed SubtleCrypto.importKey succeeds after buffer transfer.
 * This probe tests whether crypto operations read freed/stale data
 * by checking if the crypto output changes based on post-transfer mutations.
 *
 * Also tests Canvas 2D putImageData from a detached ArrayBuffer,
 * and WeakRef/FinalizationRegistry for GC timing primitives.
 *
 * Beacon prefix: V425-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V425-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

var chain = Promise.resolve();

// ================================================================
// Test A: SubtleCrypto digest on transferred buffer
// Checks if crypto reads stale data or a proper copy
// ================================================================

function testA() {
  B("A-START");

  var ab = new ArrayBuffer(256);
  var u8 = new Uint8Array(ab);
  for (var i = 0; i < 256; i++) u8[i] = 0x41; // All 'A'

  // Compute reference hash
  var refHash;
  chain = chain.then(function() {
    return crypto.subtle.digest("SHA-256", new Uint8Array(u8).buffer);
  }).then(function(ref) {
    refHash = new Uint8Array(ref);

    // Now create another buffer, start digest, transfer mid-flight
    var ab2 = new ArrayBuffer(256);
    var u8b = new Uint8Array(ab2);
    for (var i = 0; i < 256; i++) u8b[i] = 0x41;

    // Start digest (async)
    var digestPromise = crypto.subtle.digest("SHA-256", ab2);

    // Transfer the buffer immediately
    try {
      var cloned = structuredClone(ab2, {transfer: [ab2]});
      // Overwrite the cloned buffer with different data
      var u8c = new Uint8Array(cloned);
      for (var i = 0; i < 256; i++) u8c[i] = 0x42; // All 'B'
      B("A-TRANSFERRED-AND-MODIFIED");
    } catch(e) {
      B("A-TRANSFER-ERR", e.message.slice(0, 60));
    }

    return digestPromise;
  }).then(function(hash) {
    var result = new Uint8Array(hash);
    // Compare with reference
    var match = true;
    for (var i = 0; i < 32; i++) {
      if (result[i] !== refHash[i]) { match = false; break; }
    }
    B("A-RESULT", {
      matchesOriginal: match,
      first4: [result[0], result[1], result[2], result[3]],
      ref4: [refHash[0], refHash[1], refHash[2], refHash[3]]
    });
  }).catch(function(e) {
    B("A-ERR", e.message.slice(0, 60));
  });
}

// ================================================================
// Test B: SubtleCrypto encrypt with large buffer + transfer race
// Larger buffer = more time for race window
// ================================================================

function testB() {
  chain = chain.then(function() {
    B("B-START");

    var SIZE = 1024 * 1024; // 1MB
    var ab = new ArrayBuffer(SIZE);
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < SIZE; i++) u8[i] = i & 0xFF;

    // Generate key
    return crypto.subtle.generateKey(
      {name: "AES-GCM", length: 256}, true, ["encrypt"]
    ).then(function(key) {
      var iv = new Uint8Array(12);
      for (var i = 0; i < 12; i++) iv[i] = i;

      // Start encryption (async, should take longer with 1MB)
      var encPromise = crypto.subtle.encrypt(
        {name: "AES-GCM", iv: iv}, key, ab
      );

      // Transfer immediately
      try {
        var cloned = structuredClone(ab, {transfer: [ab]});
        // Overwrite cloned data
        new Uint8Array(cloned).fill(0xFF);
        B("B-TRANSFERRED", cloned.byteLength);
      } catch(e) {
        B("B-TRANSFER-ERR", e.message.slice(0, 60));
      }

      return encPromise;
    });
  }).then(function(encrypted) {
    B("B-ENCRYPTED", {size: encrypted.byteLength});

    // Check first bytes of ciphertext
    var ct = new Uint8Array(encrypted);
    B("B-CIPHER-HEAD", [ct[0], ct[1], ct[2], ct[3], ct[4], ct[5], ct[6], ct[7]]);
  }).catch(function(e) {
    B("B-ERR", e.message.slice(0, 60));
  });
}

// ================================================================
// Test C: Canvas putImageData from detached buffer
// ================================================================

function testC() {
  chain = chain.then(function() {
    B("C-START");

    var canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    var ctx = canvas.getContext("2d");

    // Create ImageData from an ArrayBuffer
    var ab = new ArrayBuffer(64 * 64 * 4); // RGBA
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < u8.length; i += 4) {
      u8[i] = 0xFF;     // R
      u8[i+1] = 0x00;   // G
      u8[i+2] = 0x00;   // B
      u8[i+3] = 0xFF;   // A
    }

    var imgData;
    try {
      imgData = new ImageData(new Uint8ClampedArray(ab), 64, 64);
      B("C-IMAGEDATA-OK");
    } catch(e) {
      B("C-IMAGEDATA-ERR", e.message.slice(0, 60));
      return;
    }

    // Put it on canvas first (should work)
    ctx.putImageData(imgData, 0, 0);
    var px1 = ctx.getImageData(0, 0, 1, 1).data;
    B("C-BEFORE-DETACH", [px1[0], px1[1], px1[2], px1[3]]);

    // Now detach the underlying buffer
    try {
      structuredClone(ab, {transfer: [ab]});
      B("C-DETACHED-AB");
    } catch(e) {
      B("C-DETACH-ERR", e.message.slice(0, 60));
    }

    // Try putImageData again with detached backing
    try {
      ctx.clearRect(0, 0, 64, 64);
      ctx.putImageData(imgData, 0, 0);
      var px2 = ctx.getImageData(0, 0, 1, 1).data;
      B("C-AFTER-DETACH", [px2[0], px2[1], px2[2], px2[3]]);
    } catch(e) {
      B("C-PUT-ERR", e.message.slice(0, 60));
    }

    // Also try creating new ImageData from the detached buffer
    try {
      var u8d = new Uint8ClampedArray(ab);
      var imgData2 = new ImageData(u8d, 64, 64);
      B("C-NEW-IMAGEDATA-DETACHED", "created");
    } catch(e) {
      B("C-NEW-ERR", e.message.slice(0, 60));
    }
  });
}

// ================================================================
// Test D: WeakRef + FinalizationRegistry GC oracle
// ================================================================

function testD() {
  chain = chain.then(function() {
    B("D-START");

    if (typeof WeakRef === "undefined" || typeof FinalizationRegistry === "undefined") {
      B("D-NO-WEAKREF");
      return;
    }

    var collected = [];
    var registry = new FinalizationRegistry(function(tag) {
      collected.push(tag);
    });

    // Create objects, register them, then release
    var refs = [];
    for (var i = 0; i < 20; i++) {
      var obj = {idx: i, pad: new ArrayBuffer(65536)};
      refs.push(new WeakRef(obj));
      registry.register(obj, "obj-" + i);
      obj = null;
    }

    B("D-REGISTERED", 20);

    // Force GC pressure
    for (var j = 0; j < 50; j++) {
      var tmp = new ArrayBuffer(1024 * 1024);
      tmp = null;
    }

    // Check which refs are still alive
    var alive = 0;
    var dead = 0;
    for (var i = 0; i < refs.length; i++) {
      if (refs[i].deref() !== undefined) alive++;
      else dead++;
    }

    B("D-AFTER-GC", {alive: alive, dead: dead, collected: collected.length});

    // Return a promise that checks again after a delay
    return new Promise(function(resolve) {
      setTimeout(function() {
        var alive2 = 0, dead2 = 0;
        for (var i = 0; i < refs.length; i++) {
          if (refs[i].deref() !== undefined) alive2++;
          else dead2++;
        }
        B("D-DELAYED", {alive: alive2, dead: dead2, collected: collected.length, tags: collected.slice(0, 5)});
        resolve();
      }, 3000);
    });
  });
}

// ================================================================
// Test E: MessageChannel + large structured clone stress
// ================================================================

function testE() {
  chain = chain.then(function() {
    B("E-START");

    return new Promise(function(resolve) {
      var mc = new MessageChannel();
      var port1 = mc.port1;
      var port2 = mc.port2;

      // Create a complex object graph with typed arrays
      var ab1 = new ArrayBuffer(4096);
      var u32 = new Uint32Array(ab1);
      for (var i = 0; i < u32.length; i++) u32[i] = 0xDEAD0000 | i;

      var ab2 = new ArrayBuffer(4096);
      new Uint8Array(ab2).fill(0xBE);

      port2.onmessage = function(e) {
        var msg = e.data;
        B("E-RECEIVED", {
          type: typeof msg,
          hasAB: msg.ab instanceof ArrayBuffer,
          abSize: msg.ab ? msg.ab.byteLength : -1,
          first4: msg.ab ? Array.from(new Uint32Array(msg.ab, 0, 4)) : []
        });
        port1.close();
        port2.close();
        resolve();
      };

      // Transfer both buffers through MessageChannel
      try {
        port1.postMessage({ab: ab1, other: ab2}, [ab1, ab2]);
        B("E-POSTED", {
          ab1detached: ab1.byteLength === 0,
          ab2detached: ab2.byteLength === 0
        });
      } catch(e) {
        B("E-POST-ERR", e.message.slice(0, 60));
        resolve();
      }
    });
  });
}

// ================================================================
// Test F: Worker blob URL + SharedArrayBuffer check
// ================================================================

function testF() {
  chain = chain.then(function() {
    B("F-START");

    // Check if SharedArrayBuffer is available
    try {
      var sab = new SharedArrayBuffer(64);
      B("F-SAB-OK", sab.byteLength);
    } catch(e) {
      B("F-SAB-ERR", e.message.slice(0, 60));
    }

    // Try to create a Worker
    var code = 'self.onmessage=function(e){var ab=e.data;var u8=new Uint8Array(ab);self.postMessage({len:ab.byteLength,first:u8[0],last:u8[u8.length-1]});};';
    var blob;
    try {
      blob = new Blob([code], {type: "application/javascript"});
      var url = URL.createObjectURL(blob);
      B("F-BLOB-URL", url.slice(0, 30));

      return new Promise(function(resolve) {
        try {
          var w = new Worker(url);
          var ab = new ArrayBuffer(1024);
          new Uint8Array(ab).fill(0xCC);

          w.onmessage = function(e) {
            B("F-WORKER-REPLY", e.data);
            w.terminate();
            resolve();
          };
          w.onerror = function(e) {
            B("F-WORKER-ERR", e.message ? e.message.slice(0, 60) : "no message");
            resolve();
          };

          // Transfer buffer to worker
          w.postMessage(ab, [ab]);
          B("F-SENT", {detached: ab.byteLength === 0});
        } catch(e2) {
          B("F-WORKER-CREATE-ERR", e2.message.slice(0, 60));
          resolve();
        }
      });
    } catch(e) {
      B("F-BLOB-ERR", e.message.slice(0, 60));
    }
  });
}

testA();
testB();
testC();
testD();
testE();
testF();

chain.then(function() {
  setTimeout(function() { B("DONE"); }, 1000);
});
})();
