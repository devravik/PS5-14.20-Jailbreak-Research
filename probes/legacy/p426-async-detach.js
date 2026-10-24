/*
 * p426 -- Async WebCore paths + detached ArrayBuffer
 *
 * Tests whether async WebCore APIs hold references to freed data
 * after the source ArrayBuffer is transferred away.
 *
 * Test A: TextDecoder streaming mode + detach between chunks
 * Test B: Response constructed from AB, then AB transferred
 * Test C: Blob from AB, FileReader read after AB transfer
 * Test D: CompressionStream / DecompressionStream + detach
 * Test E: createImageBitmap from ImageData with detached buffer
 * Test F: crypto.subtle.encrypt with large buffer + detach race
 *
 * Beacon prefix: V426-
 */
(function(){
"use strict";
var BQ = 0;
function B(tag, data) {
  try {
    var x = new XMLHttpRequest();
    x.open("POST", "/beacon/V426-" + tag + "?q=" + (BQ++), false);
    x.setRequestHeader("Content-Type", "text/plain");
    x.send(typeof data === "object" ? JSON.stringify(data) : String(data || ""));
  } catch(e) {}
}

B("BOOT");

// ================================================================
// Test A: TextDecoder streaming + detach between decode calls
// ================================================================
function testA() {
  B("A-START");
  try {
    var dec = new TextDecoder("utf-8", {fatal: false});

    // First chunk: valid start of multi-byte UTF-8
    var ab1 = new ArrayBuffer(16);
    var u1 = new Uint8Array(ab1);
    // Write "Hello " in ASCII
    var hello = [72,101,108,108,111,32];
    for (var i = 0; i < hello.length; i++) u1[i] = hello[i];
    // Write start of 3-byte UTF-8 sequence (incomplete)
    u1[6] = 0xE2; u1[7] = 0x9C;
    // Remaining bytes are padding

    // Decode chunk 1 with stream:true
    var part1 = dec.decode(new Uint8Array(ab1, 0, 8), {stream: true});
    B("A-PART1", {len: part1.length, val: part1});

    // Now transfer AB1
    var cloned1;
    try {
      cloned1 = structuredClone(ab1, {transfer: [ab1]});
      B("A-TRANSFERRED", "true");
    } catch(e) {
      B("A-TRANSFER-ERR", e.message);
    }

    // Overwrite cloned buffer with 0xFF
    if (cloned1) {
      var uc = new Uint8Array(cloned1);
      for (var i = 0; i < uc.length; i++) uc[i] = 0xFF;
    }

    // Decode chunk 2: completes the UTF-8 sequence
    var ab2 = new ArrayBuffer(8);
    var u2 = new Uint8Array(ab2);
    u2[0] = 0x93; // Completes E2 9C 93 = checkmark
    u2[1] = 0x21; // '!'

    var part2 = dec.decode(new Uint8Array(ab2, 0, 2), {stream: false});
    B("A-PART2", {len: part2.length, val: part2, code0: part2.charCodeAt(0)});

    // If TextDecoder held a reference to AB1's old data and we corrupted it,
    // part2 would decode garbage instead of the checkmark
    var expectedCheckmark = 0x2713; // Unicode checkmark
    B("A-RESULT", {
      isCheckmark: part2.charCodeAt(0) === expectedCheckmark,
      code: part2.charCodeAt(0),
      expected: expectedCheckmark
    });

  } catch(e) {
    B("A-ERR", e.message);
  }
}

// ================================================================
// Test B: Response from ArrayBuffer, then transfer AB
// ================================================================
function testB() {
  return new Promise(function(resolve) {
    B("B-START");
    try {
      var ab = new ArrayBuffer(256);
      var u8 = new Uint8Array(ab);
      for (var i = 0; i < 256; i++) u8[i] = 0x42; // All 'B'

      // Create Response from the ArrayBuffer
      var resp = new Response(ab.slice(0)); // slice makes a copy
      B("B-RESP-CREATED");

      // Also create a Response directly from the original AB
      var resp2 = new Response(ab);
      B("B-RESP2-CREATED");

      // Transfer the AB
      var cloned;
      try {
        cloned = structuredClone(ab, {transfer: [ab]});
        // Overwrite cloned data
        var uc = new Uint8Array(cloned);
        for (var i = 0; i < uc.length; i++) uc[i] = 0xDD;
        B("B-TRANSFERRED");
      } catch(e) {
        B("B-TRANSFER-ERR", e.message);
      }

      // Read resp (copy) -- should still have 0x42
      resp.arrayBuffer().then(function(buf) {
        var v = new Uint8Array(buf);
        B("B-RESP1-DATA", {len: v.length, first: v[0], last: v[255]});

        // Read resp2 (direct from original AB) -- might have stale/freed data
        return resp2.arrayBuffer();
      }).then(function(buf2) {
        var v2 = new Uint8Array(buf2);
        var firstNon42 = -1;
        var firstDD = -1;
        for (var i = 0; i < v2.length; i++) {
          if (v2[i] !== 0x42 && firstNon42 < 0) firstNon42 = i;
          if (v2[i] === 0xDD && firstDD < 0) firstDD = i;
        }
        B("B-RESP2-DATA", {
          len: v2.length,
          first: v2[0],
          last: v2[255],
          firstNon42: firstNon42,
          firstDD: firstDD,
          allB: firstNon42 === -1
        });
        resolve();
      }).catch(function(e) {
        B("B-READ-ERR", e.message);
        resolve();
      });

    } catch(e) {
      B("B-ERR", e.message);
      resolve();
    }
  });
}

// ================================================================
// Test C: Blob from AB + FileReader after transfer
// ================================================================
function testC() {
  return new Promise(function(resolve) {
    B("C-START");
    try {
      var ab = new ArrayBuffer(512);
      var u8 = new Uint8Array(ab);
      for (var i = 0; i < 512; i++) u8[i] = 0x43; // All 'C'

      // Create Blob from ArrayBuffer view
      var blob = new Blob([u8], {type: "application/octet-stream"});
      B("C-BLOB-CREATED", {size: blob.size});

      // Transfer the AB
      try {
        var cloned = structuredClone(ab, {transfer: [ab]});
        var uc = new Uint8Array(cloned);
        for (var i = 0; i < uc.length; i++) uc[i] = 0xEE;
        B("C-TRANSFERRED");
      } catch(e) {
        B("C-TRANSFER-ERR", e.message);
      }

      // Read blob with FileReader
      var fr = new FileReader();
      fr.onload = function() {
        var result = new Uint8Array(fr.result);
        var firstNon43 = -1;
        var firstEE = -1;
        for (var i = 0; i < result.length; i++) {
          if (result[i] !== 0x43 && firstNon43 < 0) firstNon43 = i;
          if (result[i] === 0xEE && firstEE < 0) firstEE = i;
        }
        B("C-BLOB-DATA", {
          len: result.length,
          first: result[0],
          last: result[511],
          firstNon43: firstNon43,
          firstEE: firstEE,
          allC: firstNon43 === -1
        });
        resolve();
      };
      fr.onerror = function() {
        B("C-READER-ERR", fr.error.message);
        resolve();
      };
      fr.readAsArrayBuffer(blob);

    } catch(e) {
      B("C-ERR", e.message);
      resolve();
    }
  });
}

// ================================================================
// Test D: CompressionStream + detach source mid-pipe
// ================================================================
function testD() {
  return new Promise(function(resolve) {
    B("D-START");
    try {
      if (typeof CompressionStream === "undefined") {
        B("D-NO-COMPRESSION");
        resolve();
        return;
      }

      var ab = new ArrayBuffer(4096);
      var u8 = new Uint8Array(ab);
      for (var i = 0; i < 4096; i++) u8[i] = 0x44;

      var cs = new CompressionStream("deflate");
      var writer = cs.writable.getWriter();
      var reader = cs.readable.getReader();

      // Write the chunk
      writer.write(u8).then(function() {
        B("D-WRITTEN");

        // Transfer the AB (source of the view we just wrote)
        try {
          var cloned = structuredClone(ab, {transfer: [ab]});
          var uc = new Uint8Array(cloned);
          for (var i = 0; i < uc.length; i++) uc[i] = 0xFF;
          B("D-TRANSFERRED-AFTER-WRITE");
        } catch(e) {
          B("D-TRANSFER-ERR", e.message);
        }

        // Write another chunk from a fresh buffer
        var ab2 = new ArrayBuffer(4096);
        var u82 = new Uint8Array(ab2);
        for (var i = 0; i < 4096; i++) u82[i] = 0x55;
        return writer.write(u82);
      }).then(function() {
        return writer.close();
      }).then(function() {
        // Read all compressed output
        var chunks = [];
        function pump() {
          return reader.read().then(function(result) {
            if (result.done) {
              var total = 0;
              for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
              B("D-COMPRESSED", {chunks: chunks.length, totalBytes: total});

              // Now decompress and check if the original 0x44 data is intact
              var ds = new DecompressionStream("deflate");
              var dWriter = ds.writable.getWriter();
              var dReader = ds.readable.getReader();

              var writeChain = Promise.resolve();
              for (var i = 0; i < chunks.length; i++) {
                (function(chunk) {
                  writeChain = writeChain.then(function() {
                    return dWriter.write(chunk);
                  });
                })(chunks[i]);
              }
              writeChain.then(function() { return dWriter.close(); });

              var decompressed = [];
              function dpump() {
                return dReader.read().then(function(r) {
                  if (r.done) {
                    var dtotal = 0;
                    for (var i = 0; i < decompressed.length; i++) dtotal += decompressed[i].length;
                    // Check first 4096 bytes (should be 0x44)
                    var first = decompressed[0];
                    var firstNon44 = -1;
                    var firstFF = -1;
                    for (var i = 0; i < Math.min(first.length, 4096); i++) {
                      if (first[i] !== 0x44 && firstNon44 < 0) firstNon44 = i;
                      if (first[i] === 0xFF && firstFF < 0) firstFF = i;
                    }
                    B("D-DECOMPRESSED", {
                      totalBytes: dtotal,
                      first: first[0],
                      firstNon44: firstNon44,
                      firstFF: firstFF,
                      dataIntact: firstNon44 === -1 || firstNon44 >= 4096
                    });
                    resolve();
                    return;
                  }
                  decompressed.push(r.value);
                  return dpump();
                });
              }
              return dpump();
            }
            chunks.push(result.value);
            return pump();
          });
        }
        return pump();
      }).catch(function(e) {
        B("D-PIPE-ERR", e.message);
        resolve();
      });

    } catch(e) {
      B("D-ERR", e.message);
      resolve();
    }
  });
}

// ================================================================
// Test E: crypto.subtle.encrypt with immediate detach
// Race: does the crypto implementation copy the plaintext before
// the JS microtask queue drains?
// ================================================================
function testE() {
  return new Promise(function(resolve) {
    B("E-START");

    var ab = new ArrayBuffer(65536); // 64KB
    var u8 = new Uint8Array(ab);
    for (var i = 0; i < u8.length; i++) u8[i] = 0x45; // 'E'

    // Generate AES key
    crypto.subtle.generateKey(
      {name: "AES-CBC", length: 256},
      true,
      ["encrypt", "decrypt"]
    ).then(function(key) {
      var iv = new Uint8Array(16);

      // Start encryption (async)
      var encPromise = crypto.subtle.encrypt(
        {name: "AES-CBC", iv: iv},
        key,
        ab // Pass the original AB
      );

      // Immediately transfer the AB
      var cloned;
      try {
        cloned = structuredClone(ab, {transfer: [ab]});
        var uc = new Uint8Array(cloned);
        for (var i = 0; i < uc.length; i++) uc[i] = 0x00; // Zero it out
        B("E-DETACHED-AND-ZEROED");
      } catch(e) {
        B("E-DETACH-ERR", e.message);
      }

      return encPromise.then(function(encrypted) {
        B("E-ENCRYPTED", {len: encrypted.byteLength});

        // Now compute reference: encrypt the same 0x45 data
        var refAB = new ArrayBuffer(65536);
        var refU8 = new Uint8Array(refAB);
        for (var i = 0; i < refU8.length; i++) refU8[i] = 0x45;

        return crypto.subtle.encrypt(
          {name: "AES-CBC", iv: iv},
          key,
          refAB
        ).then(function(refEnc) {
          var enc1 = new Uint8Array(encrypted);
          var enc2 = new Uint8Array(refEnc);

          // Compare: if crypto used stale/freed data, outputs differ
          var match = true;
          var firstDiff = -1;
          for (var i = 0; i < enc1.length; i++) {
            if (enc1[i] !== enc2[i]) {
              match = false;
              if (firstDiff < 0) firstDiff = i;
            }
          }
          B("E-COMPARE", {
            match: match,
            firstDiff: firstDiff,
            enc1Head: Array.from(enc1.subarray(0, 8)),
            enc2Head: Array.from(enc2.subarray(0, 8))
          });
          resolve();
        });
      });
    }).catch(function(e) {
      B("E-ERR", e.message);
      resolve();
    });
  });
}

// ================================================================
// Test F: createImageBitmap from canvas with detached backing
// ================================================================
function testF() {
  return new Promise(function(resolve) {
    B("F-START");
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      var ctx = canvas.getContext("2d");

      // Draw red rectangle
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 64, 64);

      // Get ImageData
      var imgData = ctx.getImageData(0, 0, 64, 64);
      var abBacking = imgData.data.buffer;
      B("F-IMAGEDATA", {len: imgData.data.length, first4: [imgData.data[0], imgData.data[1], imgData.data[2], imgData.data[3]]});

      // Transfer the backing buffer
      try {
        var cloned = structuredClone(abBacking, {transfer: [abBacking]});
        // Fill with blue pixels
        var uc = new Uint8Array(cloned);
        for (var i = 0; i < uc.length; i += 4) {
          uc[i] = 0; uc[i+1] = 0; uc[i+2] = 255; uc[i+3] = 255;
        }
        B("F-TRANSFERRED");
      } catch(e) {
        B("F-TRANSFER-ERR", e.message);
      }

      // Try to use the detached ImageData
      try {
        ctx.putImageData(imgData, 0, 0);
        var check = ctx.getImageData(0, 0, 1, 1);
        B("F-AFTER-PUT", {
          pixel: [check.data[0], check.data[1], check.data[2], check.data[3]],
          isRed: check.data[0] === 255 && check.data[1] === 0 && check.data[2] === 0,
          isBlue: check.data[0] === 0 && check.data[1] === 0 && check.data[2] === 255,
          isZero: check.data[0] === 0 && check.data[1] === 0 && check.data[2] === 0
        });
      } catch(e) {
        B("F-PUT-ERR", e.message);
      }

      // Try createImageBitmap from the detached ImageData
      if (typeof createImageBitmap !== "undefined") {
        createImageBitmap(imgData).then(function(bmp) {
          B("F-BITMAP-OK", {w: bmp.width, h: bmp.height});

          // Draw bitmap and read pixels
          ctx.drawImage(bmp, 0, 0);
          var check2 = ctx.getImageData(0, 0, 1, 1);
          B("F-BITMAP-PIXEL", {
            pixel: [check2.data[0], check2.data[1], check2.data[2], check2.data[3]],
            isRed: check2.data[0] === 255,
            isBlue: check2.data[2] === 255 && check2.data[0] === 0
          });
          resolve();
        }).catch(function(e) {
          B("F-BITMAP-ERR", e.message);
          resolve();
        });
      } else {
        B("F-NO-BITMAP");
        resolve();
      }

    } catch(e) {
      B("F-ERR", e.message);
      resolve();
    }
  });
}

// Run all tests sequentially
testA();
testB().then(function() {
  return testC();
}).then(function() {
  return testD();
}).then(function() {
  return testE();
}).then(function() {
  return testF();
}).then(function() {
  B("DONE");
}).catch(function(e) {
  B("FATAL", e.message);
});

})();
