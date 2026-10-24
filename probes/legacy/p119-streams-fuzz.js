// p119 — Streams API deep fuzzing
// CompressionStream, DecompressionStream, TextDecoderStream, ReadableStream piping
// These use native C++ implementations (zlib/brotli/ICU) — less hardened than DOM
(function(){
  var rid = 'v119s' + Math.random().toString(36).slice(2,15);
  function beacon(tag, data) {
    var body = typeof data === 'object' ? JSON.stringify(data) : String(data);
    try { navigator.sendBeacon('/beacon/V119S-' + tag, JSON.stringify({r:rid,b:body})); } catch(e){}
    try { fetch('/beacon/V119S-' + tag, {method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){}); } catch(e2){}
  }
  beacon('L', 'probe119-start');

  var tests = [];
  var testIdx = 0;

  function addTest(name, fn) {
    tests.push({name: name, fn: fn});
  }

  async function runAll() {
    for (var i = 0; i < tests.length; i++) {
      testIdx = i;
      var t = tests[i];
      try {
        var result = await t.fn();
        beacon(t.name, result);
      } catch(e) {
        beacon(t.name, {error: e.constructor.name + ':' + e.message.slice(0,200)});
      }
    }
    beacon('Z', 'probe119-done');
  }

  // S1: CompressionStream — compress then decompress, verify round-trip
  addTest('S1-COMPRESS', async function() {
    var r = {};
    // Test which algorithms are supported
    var algos = ['gzip', 'deflate', 'deflate-raw'];
    for (var i = 0; i < algos.length; i++) {
      try {
        var cs = new CompressionStream(algos[i]);
        r[algos[i]] = 'supported';
      } catch(e) {
        r[algos[i]] = e.message.slice(0,60);
      }
    }
    // Try brotli (non-standard, some engines support it)
    try {
      var cs = new CompressionStream('br');
      r.brotli = 'supported';
    } catch(e) {
      r.brotli = e.message.slice(0,60);
    }
    // Round-trip test with gzip
    try {
      var input = new TextEncoder().encode('AAAA'.repeat(10000));
      var cs = new CompressionStream('gzip');
      var writer = cs.writable.getWriter();
      var reader = cs.readable.getReader();
      writer.write(input);
      writer.close();
      var chunks = [];
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      var totalLen = 0;
      for (var j = 0; j < chunks.length; j++) totalLen += chunks[j].length;
      r.compressedLen = totalLen;
      r.ratio = (totalLen / input.length).toFixed(4);
      r.roundTrip = 'compressed';
    } catch(e) {
      r.roundTrip = 'ERR:' + e.message.slice(0,80);
    }
    return r;
  });

  // S2: DecompressionStream — feed MALFORMED compressed data
  addTest('S2-MALDECOMP', async function() {
    var r = {};

    // 2a: Truncated gzip — valid header, truncated body
    // Minimal gzip header: 1f 8b 08 00 00 00 00 00 00 03
    try {
      var truncGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
        0xcb, 0x48, 0xcd, 0xc9]); // truncated deflate data
      var ds = new DecompressionStream('gzip');
      var writer = ds.writable.getWriter();
      var reader = ds.readable.getReader();
      writer.write(truncGzip);
      writer.close();
      var out = [];
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        out.push(chunk.value.length);
      }
      r.truncGzip = 'NO_ERROR:chunks=' + out.join(',');
    } catch(e) {
      r.truncGzip = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 2b: Corrupted deflate — valid header, garbage body
    try {
      var garbage = new Uint8Array(1024);
      for (var i = 0; i < 1024; i++) garbage[i] = (i * 137 + 42) & 0xff;
      // Set gzip magic bytes
      garbage[0] = 0x1f; garbage[1] = 0x8b; garbage[2] = 0x08; garbage[3] = 0x00;
      garbage[4] = 0x00; garbage[5] = 0x00; garbage[6] = 0x00; garbage[7] = 0x00;
      garbage[8] = 0x00; garbage[9] = 0x03;
      var ds2 = new DecompressionStream('gzip');
      var w2 = ds2.writable.getWriter();
      var r2 = ds2.readable.getReader();
      w2.write(garbage);
      w2.close();
      var out2 = [];
      while (true) {
        var chunk2 = await r2.read();
        if (chunk2.done) break;
        out2.push(chunk2.value.length);
      }
      r.garbageGzip = 'NO_ERROR:chunks=' + out2.join(',');
    } catch(e) {
      r.garbageGzip = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 2c: Zero-length decompression
    try {
      var ds3 = new DecompressionStream('deflate');
      var w3 = ds3.writable.getWriter();
      var r3 = ds3.readable.getReader();
      w3.write(new Uint8Array(0));
      w3.close();
      var out3 = [];
      while (true) {
        var chunk3 = await r3.read();
        if (chunk3.done) break;
        out3.push(chunk3.value.length);
      }
      r.emptyDeflate = 'NO_ERROR:' + out3.length;
    } catch(e) {
      r.emptyDeflate = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 2d: Decompression bomb — small input that expands massively
    // Deflate stream of 1M zeros compresses to ~1KB
    try {
      var bombHeader = new Uint8Array([0x78, 0x01]); // deflate header (low compression)
      // Create a valid deflate stream that encodes many zeros
      // Stored block: BFINAL=0, BTYPE=00 (no compression), LEN=0xFFFF, NLEN=0x0000, then 65535 zeros
      var blocks = [];
      for (var b = 0; b < 5; b++) {
        var block = new Uint8Array(5 + 65535);
        block[0] = (b === 4) ? 0x01 : 0x00; // BFINAL on last block
        block[1] = 0xFF; block[2] = 0xFF; // LEN = 65535
        block[3] = 0x00; block[4] = 0x00; // NLEN = ~65535
        // data is already zeros
        blocks.push(block);
      }
      var ds4 = new DecompressionStream('deflate');
      var w4 = ds4.writable.getWriter();
      var r4 = ds4.readable.getReader();
      for (var bi = 0; bi < blocks.length; bi++) {
        w4.write(blocks[bi]);
      }
      w4.close();
      var totalOut = 0;
      var readCount = 0;
      while (true) {
        var chunk4 = await r4.read();
        if (chunk4.done) break;
        totalOut += chunk4.value.length;
        readCount++;
        if (readCount > 100) break; // safety limit
      }
      r.decompBomb = 'expanded:' + totalOut + ',chunks:' + readCount;
    } catch(e) {
      r.decompBomb = e.constructor.name + ':' + e.message.slice(0,80);
    }

    return r;
  });

  // S3: TextDecoderStream — invalid UTF-8, surrogates, fatal mode
  addTest('S3-TXTDECODE', async function() {
    var r = {};

    // 3a: Invalid UTF-8 continuation bytes
    try {
      var tds = new TextDecoderStream('utf-8', {fatal: true});
      var w = tds.writable.getWriter();
      var rd = tds.readable.getReader();
      // Invalid: continuation byte without start byte
      w.write(new Uint8Array([0x80, 0x81, 0x82]));
      w.close();
      var txt = '';
      while (true) {
        var c = await rd.read();
        if (c.done) break;
        txt += c.value;
      }
      r.invalidCont = 'NO_ERROR:len=' + txt.length;
    } catch(e) {
      r.invalidCont = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 3b: Overlong encoding (security-relevant: used in path traversal)
    try {
      var tds2 = new TextDecoderStream('utf-8', {fatal: false});
      var w2 = tds2.writable.getWriter();
      var rd2 = tds2.readable.getReader();
      // Overlong encoding of '/' (0x2F): C0 AF
      w2.write(new Uint8Array([0xC0, 0xAF]));
      // Overlong encoding of '.' (0x2E): C0 AE
      w2.write(new Uint8Array([0xC0, 0xAE]));
      w2.close();
      var txt2 = '';
      while (true) {
        var c2 = await rd2.read();
        if (c2.done) break;
        txt2 += c2.value;
      }
      var codes = [];
      for (var ci = 0; ci < txt2.length; ci++) codes.push(txt2.charCodeAt(ci));
      r.overlong = 'len=' + txt2.length + ',codes=' + codes.join(',');
    } catch(e) {
      r.overlong = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 3c: Split multi-byte sequence across chunks
    try {
      var tds3 = new TextDecoderStream('utf-8');
      var w3 = tds3.writable.getWriter();
      var rd3 = tds3.readable.getReader();
      // U+1F600 (grinning face) = F0 9F 98 80
      // Split across 4 separate writes
      w3.write(new Uint8Array([0xF0]));
      w3.write(new Uint8Array([0x9F]));
      w3.write(new Uint8Array([0x98]));
      w3.write(new Uint8Array([0x80]));
      w3.close();
      var txt3 = '';
      while (true) {
        var c3 = await rd3.read();
        if (c3.done) break;
        txt3 += c3.value;
      }
      r.splitMultibyte = 'len=' + txt3.length + ',cp=' + txt3.codePointAt(0);
    } catch(e) {
      r.splitMultibyte = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 3d: Lone surrogates via Shift_JIS decoder (if available)
    try {
      var tds4 = new TextDecoderStream('shift_jis');
      r.shiftJIS = 'supported';
      var w4 = tds4.writable.getWriter();
      var rd4 = tds4.readable.getReader();
      // Feed bytes that produce edge-case code points
      w4.write(new Uint8Array([0x81, 0x40, 0x82, 0x4F, 0x83, 0x9F, 0xEE, 0xFC]));
      w4.close();
      var txt4 = '';
      while (true) {
        var c4 = await rd4.read();
        if (c4.done) break;
        txt4 += c4.value;
      }
      r.shiftJISLen = txt4.length;
      var cp4 = [];
      for (var si = 0; si < Math.min(txt4.length, 10); si++) cp4.push(txt4.charCodeAt(si));
      r.shiftJISCodes = cp4.join(',');
    } catch(e) {
      r.shiftJIS = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 3e: ISO-2022-JP state machine abuse
    try {
      var tds5 = new TextDecoderStream('iso-2022-jp');
      r.iso2022jp = 'supported';
      var w5 = tds5.writable.getWriter();
      var rd5 = tds5.readable.getReader();
      // ESC sequences to switch between ASCII, JIS X 0201, JIS X 0208
      // Rapidly switch states with incomplete sequences
      var escSeqs = new Uint8Array([
        0x1B, 0x28, 0x42, // ESC ( B = ASCII
        0x41,             // 'A'
        0x1B, 0x24, 0x42, // ESC $ B = JIS X 0208
        0x30, 0x21,       // Some kanji
        0x1B, 0x28, 0x4A, // ESC ( J = JIS X 0201 Roman
        0x5C,             // yen sign in JIS X 0201
        0x1B, 0x28, 0x49, // ESC ( I = half-width katakana
        0xB1,             // katakana 'a'
        0x1B, 0x28, 0x42, // back to ASCII
      ]);
      w5.write(escSeqs);
      w5.close();
      var txt5 = '';
      while (true) {
        var c5 = await rd5.read();
        if (c5.done) break;
        txt5 += c5.value;
      }
      r.iso2022jpLen = txt5.length;
    } catch(e) {
      r.iso2022jp = e.constructor.name + ':' + e.message.slice(0,80);
    }

    return r;
  });

  // S4: Stream piping with error injection — cancel/abort during active pipe
  addTest('S4-PIPERACES', async function() {
    var r = {};

    // 4a: pipeTo with abort signal during transfer
    try {
      var chunks = 0;
      var rs = new ReadableStream({
        start: function(ctrl) {
          for (var i = 0; i < 100; i++) {
            ctrl.enqueue(new Uint8Array(1024).fill(i & 0xff));
          }
          ctrl.close();
        }
      });
      var collected = 0;
      var ws = new WritableStream({
        write: function(chunk) {
          collected += chunk.length;
          chunks++;
        }
      });
      var ac = new AbortController();
      // Abort after a microtask
      Promise.resolve().then(function() { ac.abort(); });
      try {
        await rs.pipeTo(ws, {signal: ac.signal});
        r.abortPipe = 'completed:' + chunks;
      } catch(e) {
        r.abortPipe = 'aborted_at:' + chunks + ',collected:' + collected;
      }
    } catch(e) {
      r.abortPipe = 'ERR:' + e.message.slice(0,80);
    }

    // 4b: pipeTo where source errors mid-stream
    try {
      var errChunks = 0;
      var rs2 = new ReadableStream({
        pull: function(ctrl) {
          errChunks++;
          if (errChunks > 5) {
            ctrl.error(new Error('injected'));
            return;
          }
          ctrl.enqueue(new Uint8Array(512));
        }
      });
      var ws2Chunks = 0;
      var ws2 = new WritableStream({
        write: function() { ws2Chunks++; }
      });
      try {
        await rs2.pipeTo(ws2);
        r.srcError = 'completed:' + ws2Chunks;
      } catch(e) {
        r.srcError = 'caught:' + ws2Chunks + ',' + e.message.slice(0,40);
      }
    } catch(e) {
      r.srcError = 'ERR:' + e.message.slice(0,80);
    }

    // 4c: pipeThrough with TransformStream that errors on specific input
    try {
      var xformCount = 0;
      var ts = new TransformStream({
        transform: function(chunk, ctrl) {
          xformCount++;
          if (xformCount === 3) {
            ctrl.error(new TypeError('type_confused'));
            return;
          }
          ctrl.enqueue(chunk);
        }
      });
      var rs3 = new ReadableStream({
        start: function(ctrl) {
          for (var i = 0; i < 10; i++) ctrl.enqueue(new Uint8Array([i]));
          ctrl.close();
        }
      });
      var outChunks = 0;
      var piped = rs3.pipeThrough(ts);
      var rd = piped.getReader();
      try {
        while (true) {
          var c = await rd.read();
          if (c.done) break;
          outChunks++;
        }
        r.xformError = 'completed:' + outChunks;
      } catch(e) {
        r.xformError = 'caught_at:' + outChunks + ',xforms:' + xformCount;
      }
    } catch(e) {
      r.xformError = 'ERR:' + e.message.slice(0,80);
    }

    return r;
  });

  // S5: ReadableStream tee — cancel one branch during read of other
  addTest('S5-TEE', async function() {
    var r = {};

    try {
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

      // Read 3 chunks from branch 1
      var b1Chunks = 0;
      for (var i = 0; i < 3; i++) {
        var c = await r1.read();
        if (!c.done) b1Chunks++;
      }

      // Cancel branch 1 while branch 2 hasn't been read
      r1.releaseLock();
      await branches[0].cancel('testing');

      // Now read all of branch 2
      var b2Chunks = 0;
      while (true) {
        var c2 = await r2.read();
        if (c2.done) break;
        b2Chunks++;
        if (b2Chunks > 30) break;
      }

      r.b1Read = b1Chunks;
      r.b2Read = b2Chunks;
      r.totalPulls = pullCount;
      r.survived = true;
    } catch(e) {
      r.teeCancel = e.constructor.name + ':' + e.message.slice(0,80);
    }

    return r;
  });

  // S6: CompressionStream + DecompressionStream pipeline — compress->decompress with
  // mutation during transfer (detach ArrayBuffer between stages)
  addTest('S6-COMPDETACH', async function() {
    var r = {};

    try {
      // Create a compress->decompress pipeline
      var cs = new CompressionStream('gzip');
      var ds = new DecompressionStream('gzip');

      // Pipe compressed output into decompressor
      var input = new TextEncoder().encode('Hello World! '.repeat(5000));
      var originalLen = input.length;

      var csWriter = cs.writable.getWriter();
      var csReader = cs.readable.getReader();

      // Write input, but try to detach the buffer during compression
      var buf = new ArrayBuffer(1024);
      var view = new Uint8Array(buf);
      for (var i = 0; i < 1024; i++) view[i] = i & 0xff;

      csWriter.write(view);
      // Try to transfer the underlying buffer
      try {
        var mc = new MessageChannel();
        mc.port1.postMessage(buf, [buf]);
        r.detachDuringWrite = 'transferred,detached=' + (buf.byteLength === 0);
      } catch(e) {
        r.detachDuringWrite = e.message.slice(0,60);
      }

      // Write more data and close
      csWriter.write(input);
      csWriter.close();

      // Read compressed output
      var compressed = [];
      while (true) {
        var chunk = await csReader.read();
        if (chunk.done) break;
        compressed.push(chunk.value);
      }
      var compLen = compressed.reduce(function(a, c) { return a + c.length; }, 0);
      r.compressedOK = true;
      r.compLen = compLen;

      // Feed compressed into decompressor
      var dsWriter = ds.writable.getWriter();
      var dsReader = ds.readable.getReader();
      for (var ci = 0; ci < compressed.length; ci++) {
        dsWriter.write(compressed[ci]);
      }
      dsWriter.close();

      var decompLen = 0;
      while (true) {
        var dc = await dsReader.read();
        if (dc.done) break;
        decompLen += dc.value.length;
      }
      r.decompLen = decompLen;
      r.roundTrip = decompLen >= originalLen;
    } catch(e) {
      r.compDetach = e.constructor.name + ':' + e.message.slice(0,100);
    }

    return r;
  });

  // S7: WritableStream abort during active write — race between write completion and abort
  addTest('S7-WABORT', async function() {
    var r = {};

    try {
      var writeCount = 0;
      var abortCalled = false;
      var ws = new WritableStream({
        write: function(chunk) {
          writeCount++;
          // Simulate slow write
          return new Promise(function(resolve) {
            setTimeout(resolve, 10);
          });
        },
        abort: function(reason) {
          abortCalled = true;
          r.abortReason = String(reason).slice(0,40);
        }
      });

      var writer = ws.getWriter();

      // Fire multiple writes
      var p1 = writer.write(new Uint8Array(100));
      var p2 = writer.write(new Uint8Array(200));
      var p3 = writer.write(new Uint8Array(300));

      // Abort while writes are pending
      var pAbort = writer.abort('race_test');

      try { await p1; } catch(e) { r.w1 = e.constructor.name; }
      try { await p2; } catch(e) { r.w2 = e.constructor.name; }
      try { await p3; } catch(e) { r.w3 = e.constructor.name; }
      try { await pAbort; } catch(e) { r.abort = e.constructor.name; }

      r.writeCount = writeCount;
      r.abortCalled = abortCalled;
    } catch(e) {
      r.wAbort = e.constructor.name + ':' + e.message.slice(0,80);
    }

    return r;
  });

  // S8: ResizableArrayBuffer + streams interaction
  addTest('S8-RESIZABLE', async function() {
    var r = {};

    // 8a: Write ResizableArrayBuffer to stream, then resize during read
    try {
      var rab = new ArrayBuffer(256, {maxByteLength: 4096});
      var view = new Uint8Array(rab);
      for (var i = 0; i < 256; i++) view[i] = i;
      r.rabCreated = true;
      r.rabLen = rab.byteLength;
      r.rabMax = rab.maxByteLength;

      var chunks = [];
      var rs = new ReadableStream({
        start: function(ctrl) {
          ctrl.enqueue(new Uint8Array(rab));
          // Resize AFTER enqueue — does it affect the enqueued chunk?
          try {
            rab.resize(512);
            r.resizeAfterEnqueue = 'resized_to_' + rab.byteLength;
          } catch(e) {
            r.resizeAfterEnqueue = e.message.slice(0,60);
          }
          // Enqueue again after resize
          var view2 = new Uint8Array(rab);
          for (var j = 256; j < 512; j++) view2[j] = j & 0xff;
          ctrl.enqueue(new Uint8Array(rab));
          ctrl.close();
        }
      });
      var reader = rs.getReader();
      while (true) {
        var c = await reader.read();
        if (c.done) break;
        chunks.push({len: c.value.length, first: c.value[0], last: c.value[c.value.length-1]});
      }
      r.chunks = chunks;
    } catch(e) {
      r.rab = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 8b: structuredClone of ResizableArrayBuffer
    try {
      var rab2 = new ArrayBuffer(128, {maxByteLength: 1024});
      new Uint8Array(rab2).fill(0xAA);
      var cloned = structuredClone(rab2);
      r.cloneLen = cloned.byteLength;
      r.cloneMax = cloned.maxByteLength;
      r.cloneResizable = cloned.resizable;
      // Resize cloned, check original
      cloned.resize(256);
      r.clonedResized = cloned.byteLength;
      r.originalUnchanged = rab2.byteLength === 128;
    } catch(e) {
      r.cloneRAB = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 8c: Transfer ResizableArrayBuffer
    try {
      var rab3 = new ArrayBuffer(64, {maxByteLength: 512});
      new Uint8Array(rab3).fill(0xBB);
      var transferred = structuredClone(rab3, {transfer: [rab3]});
      r.transferLen = transferred.byteLength;
      r.transferMax = transferred.maxByteLength;
      r.transferResizable = transferred.resizable;
      r.srcDetached = rab3.byteLength === 0;
      // Resize transferred copy
      transferred.resize(256);
      r.transferResized = transferred.byteLength;
    } catch(e) {
      r.transferRAB = e.constructor.name + ':' + e.message.slice(0,80);
    }

    return r;
  });

  // S9: Stream reader/writer release lock races
  addTest('S9-LOCKRACE', async function() {
    var r = {};

    // 9a: Release reader lock during pending read
    try {
      var rs = new ReadableStream({
        pull: function(ctrl) {
          return new Promise(function(resolve) {
            setTimeout(function() {
              ctrl.enqueue(new Uint8Array([1,2,3]));
              resolve();
            }, 50);
          });
        }
      });
      var reader = rs.getReader();
      var readPromise = reader.read();
      // Release lock while read is pending
      try {
        reader.releaseLock();
        r.releaseDuringRead = 'released';
      } catch(e) {
        r.releaseDuringRead = e.constructor.name + ':' + e.message.slice(0,60);
      }
      try {
        var result = await readPromise;
        r.pendingRead = 'resolved:done=' + result.done;
      } catch(e) {
        r.pendingRead = e.constructor.name + ':' + e.message.slice(0,60);
      }
    } catch(e) {
      r.lockRace = e.message.slice(0,80);
    }

    // 9b: Get multiple readers via releaseLock race
    try {
      var rs2 = new ReadableStream({
        start: function(ctrl) {
          for (var i = 0; i < 10; i++) ctrl.enqueue(new Uint8Array([i]));
          ctrl.close();
        }
      });
      var r1 = rs2.getReader();
      var c1 = await r1.read();
      r1.releaseLock();
      var r2 = rs2.getReader();
      var c2 = await r2.read();
      r.multiReader = 'c1=' + c1.value[0] + ',c2=' + c2.value[0];
    } catch(e) {
      r.multiReader = e.message.slice(0,60);
    }

    // 9c: Writer close + write race
    try {
      var ws = new WritableStream({
        write: function(chunk) {
          return new Promise(function(res) { setTimeout(res, 10); });
        }
      });
      var writer = ws.getWriter();
      var closeP = writer.close();
      try {
        await writer.write(new Uint8Array([99]));
        r.writeAfterClose = 'accepted';
      } catch(e) {
        r.writeAfterClose = e.constructor.name;
      }
      try { await closeP; } catch(e) {}
    } catch(e) {
      r.writerRace = e.message.slice(0,60);
    }

    return r;
  });

  // S10: CompressionStream/DecompressionStream with custom queuing + backpressure abuse
  addTest('S10-BACKPRESSURE', async function() {
    var r = {};

    // 10a: Custom queuing strategy with negative/Infinity sizes
    try {
      var negStrategy = new CountQueuingStrategy({highWaterMark: -1});
      r.negHWM = negStrategy.highWaterMark;
      var ts = new TransformStream({}, negStrategy);
      r.negTransform = 'created';
    } catch(e) {
      r.negTransform = e.constructor.name + ':' + e.message.slice(0,60);
    }

    try {
      var infStrategy = new CountQueuingStrategy({highWaterMark: Infinity});
      r.infHWM = infStrategy.highWaterMark;
      var ts2 = new TransformStream({}, infStrategy);
      r.infTransform = 'created';
    } catch(e) {
      r.infTransform = e.constructor.name + ':' + e.message.slice(0,60);
    }

    // 10b: ByteLength strategy with object that has custom .size()
    try {
      var sizeCallCount = 0;
      var customStrategy = {
        highWaterMark: 1,
        size: function(chunk) {
          sizeCallCount++;
          if (sizeCallCount === 3) return -999;
          if (sizeCallCount === 5) return Infinity;
          if (sizeCallCount === 7) return NaN;
          return chunk.length || 1;
        }
      };
      var ts3 = new TransformStream({
        transform: function(chunk, ctrl) { ctrl.enqueue(chunk); }
      }, undefined, customStrategy);
      var w = ts3.writable.getWriter();
      var rd = ts3.readable.getReader();
      var writeErrors = [];
      for (var i = 0; i < 10; i++) {
        try {
          await w.write(new Uint8Array([i]));
        } catch(e) {
          writeErrors.push(i + ':' + e.constructor.name);
        }
      }
      r.customSize = 'calls=' + sizeCallCount + ',errors=' + writeErrors.join(';');
      // Drain remaining
      try { w.close(); } catch(e) {}
      var drained = 0;
      try {
        while (true) {
          var c = await rd.read();
          if (c.done) break;
          drained++;
          if (drained > 20) break;
        }
      } catch(e) {}
      r.drained = drained;
    } catch(e) {
      r.customStrategy = e.constructor.name + ':' + e.message.slice(0,80);
    }

    // 10c: Rapidly create/destroy compression streams (stress allocator)
    try {
      var created = 0;
      for (var j = 0; j < 200; j++) {
        var cs = new CompressionStream('gzip');
        var w2 = cs.writable.getWriter();
        w2.write(new Uint8Array(64));
        w2.close();
        created++;
      }
      r.rapidCreate = 'created=' + created;
    } catch(e) {
      r.rapidCreate = e.constructor.name + ':' + e.message.slice(0,60);
    }

    return r;
  });

  runAll();
})();
