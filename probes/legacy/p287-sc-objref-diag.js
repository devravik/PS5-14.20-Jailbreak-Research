// p287 — structuredClone ObjectReference diagnostic
// Tests whether structuredClone uses ObjectReference for shared ArrayBuffers
// and whether BigInt deserialization shifts gcBuffer indices
// Beacon prefix: V287-

(function() {
  var BQ = 0;
  function B(tag, body) {
    var url = '/beacon/V287-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
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

  B('BOOT');

  // Test 1: Do two views on the same buffer share the buffer after clone?
  // If ObjectReference works, they should share the same cloned buffer.
  // If not (buffer cloned twice), they'll have independent copies.
  try {
    var shared = new ArrayBuffer(16);
    var dv = new DataView(shared);
    dv.setUint32(0, 0xDEADBEEF, true);
    var v1 = new Uint8Array(shared);
    var v2 = new Float64Array(shared);

    var c = structuredClone({v1: v1, v2: v2});

    // Write to c.v1 and check if c.v2 sees the change
    c.v1[8] = 0x42;
    var seenByV2 = new Uint8Array(c.v2.buffer)[8];
    var sameBuf = (c.v1.buffer === c.v2.buffer);
    B('T1-SAMEBUF-' + sameBuf);
    B('T1-CROSSWRITE-' + (seenByV2 === 0x42));
    B('T1-V1BUFLEN-' + c.v1.buffer.byteLength);
    B('T1-V2BUFLEN-' + c.v2.buffer.byteLength);
  } catch(e) {
    B('T1-ERR-' + e.message.substring(0, 40));
  }

  // Test 2: Same but with the buffer also as a direct property
  // {buf: ab, view: Float64Array(ab)}
  try {
    var ab = new ArrayBuffer(64);
    new Float64Array(ab)[0] = 1.5;
    var view = new Float64Array(ab);

    var c2 = structuredClone({buf: ab, view: view});
    var sameBuf2 = (c2.buf === c2.view.buffer);
    B('T2-SAMEBUF-' + sameBuf2);
    B('T2-BUFLEN-' + c2.buf.byteLength);
    B('T2-VIEWBUFLEN-' + c2.view.buffer.byteLength);

    // Write to buf, check view
    new Uint8Array(c2.buf)[0] = 0xFF;
    var viewSees = new Uint8Array(c2.view.buffer)[0];
    B('T2-CROSSWRITE-' + (viewSees === 0xFF));
  } catch(e) {
    B('T2-ERR-' + e.message.substring(0, 40));
  }

  // Test 3: Same as test 2 but with ResizableArrayBuffer
  try {
    var rab = new ArrayBuffer(64, {maxByteLength: 1024});
    new Float64Array(rab)[0] = 2.5;
    var rview = new Float64Array(rab);

    var c3 = structuredClone({buf: rab, view: rview});
    var sameBuf3 = (c3.buf === c3.view.buffer);
    B('T3-RAB-SAMEBUF-' + sameBuf3);
    B('T3-RAB-BUFLEN-' + c3.buf.byteLength);
    B('T3-RAB-VIEWBUFLEN-' + c3.view.buffer.byteLength);
    B('T3-RAB-MAXLEN-' + c3.buf.maxByteLength);

    new Uint8Array(c3.buf)[0] = 0xAA;
    var rviewSees = new Uint8Array(c3.view.buffer)[0];
    B('T3-RAB-CROSSWRITE-' + (rviewSees === 0xAA));
  } catch(e) {
    B('T3-ERR-' + e.message.substring(0, 40));
  }

  // Test 4: With BigInt inserted before the buffer
  // If BigInt shifts indices, ObjectRef will resolve to wrong object
  try {
    var ab4 = new ArrayBuffer(32);
    new Float64Array(ab4)[0] = 3.5;
    var v4 = new Float64Array(ab4);

    var c4 = structuredClone({bi: 0n, buf: ab4, view: v4});
    var sameBuf4 = (c4.buf === c4.view.buffer);
    B('T4-BI-SAMEBUF-' + sameBuf4);
    B('T4-BI-BUFLEN-' + c4.buf.byteLength);
    B('T4-BI-VIEWBUFLEN-' + c4.view.buffer.byteLength);

    new Uint8Array(c4.buf)[0] = 0xBB;
    var v4sees = new Uint8Array(c4.view.buffer)[0];
    B('T4-BI-CROSSWRITE-' + (v4sees === 0xBB));

    // Did view data match?
    B('T4-BI-V0-' + c4.view[0]);
  } catch(e) {
    B('T4-ERR-' + e.message.substring(0, 40));
  }

  // Test 5: With BigInt + RAB
  try {
    var ab5s = new ArrayBuffer(8, {maxByteLength: 4096});
    var ab5l = new ArrayBuffer(4096, {maxByteLength: 8192});
    var v5 = new Float64Array(ab5l);
    for (var i = 0; i < v5.length; i++) v5[i] = i + 100;

    var c5 = structuredClone({
      bi: 0n,
      small: ab5s,
      large: ab5l,
      view: v5
    });

    B('T5-VIEW-BUF-' + c5.view.buffer.byteLength);
    B('T5-VIEW-LEN-' + c5.view.length);
    B('T5-VIEW0-' + c5.view[0]);
    B('T5-VIEW1-' + c5.view[1]);

    // The definitive test: is the view backed by 'small' or 'large'?
    var viewIsSame = (c5.view.buffer === c5.large);
    var viewIsSmall = (c5.view.buffer === c5.small);
    B('T5-IS-LARGE-' + viewIsSame);
    B('T5-IS-SMALL-' + viewIsSmall);

    // Cross-write test with both buffers
    new Uint8Array(c5.large)[0] = 0xCC;
    new Uint8Array(c5.small)[0] = 0xDD;
    var viewByteViaLarge = new Uint8Array(c5.view.buffer)[0];
    B('T5-VIEWBYTE-' + viewByteViaLarge.toString(16));
  } catch(e) {
    B('T5-ERR-' + e.message.substring(0, 40));
  }

  // Test 6: Two BigInts + explicit ObjectReference test
  // Use 3 buffers and 2 views on the last buffer
  try {
    var b6a = new ArrayBuffer(8, {maxByteLength: 4096});
    var b6b = new ArrayBuffer(256, {maxByteLength: 4096});
    var b6c = new ArrayBuffer(2048, {maxByteLength: 4096});
    var v6a = new Float64Array(b6c);
    var v6b = new Uint8Array(b6c);

    var c6 = structuredClone({
      n1: 1n,
      n2: 2n,
      a: b6a,
      b: b6b,
      c: b6c,
      va: v6a,
      vb: v6b
    });

    B('T6-VA-BUFLEN-' + c6.va.buffer.byteLength);
    B('T6-VB-BUFLEN-' + c6.vb.buffer.byteLength);
    B('T6-VA-SAME-C-' + (c6.va.buffer === c6.c));
    B('T6-VB-SAME-C-' + (c6.vb.buffer === c6.c));
    B('T6-VA-SAME-B-' + (c6.va.buffer === c6.b));
    B('T6-VA-SAME-A-' + (c6.va.buffer === c6.a));
  } catch(e) {
    B('T6-ERR-' + e.message.substring(0, 40));
  }

  B('DONE');
})();
