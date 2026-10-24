// p399 - FINGERPRINT: test WebKit attack surfaces and feature availability
// Beacon prefix: V399-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V399-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  // 1. WebAssembly
  try {
    var t = typeof WebAssembly;
    B('FEAT-WASM-' + t);
    if (t !== 'undefined') {
      B('FEAT-WASM-COMPILE-' + (typeof WebAssembly.compile));
      B('FEAT-WASM-INSTANCE-' + (typeof WebAssembly.instantiate));
      B('FEAT-WASM-VALIDATE-' + (typeof WebAssembly.validate));
    }
  } catch(e) { B('FEAT-WASM-ERR-' + e.name); }

  // 2. SharedArrayBuffer
  try {
    var sab = new SharedArrayBuffer(16);
    B('FEAT-SAB-YES-' + sab.byteLength);
  } catch(e) { B('FEAT-SAB-NO-' + e.name); }

  // 3. structuredClone
  try {
    var t3 = typeof structuredClone;
    B('FEAT-SCLONE-' + t3);
    if (t3 === 'function') {
      var c1 = structuredClone({a: 1, b: [2,3]});
      B('FEAT-SCLONE-OBJ-' + (c1.a === 1 ? 'OK' : 'BAD'));
      var ab = new ArrayBuffer(8);
      var c2 = structuredClone(ab);
      B('FEAT-SCLONE-AB-' + c2.byteLength);
      try {
        var c3 = structuredClone(ab, {transfer: [ab]});
        B('FEAT-SCLONE-TRANSFER-YES-NEUTERED-' + (ab.byteLength === 0));
      } catch(e2) { B('FEAT-SCLONE-TRANSFER-NO-' + e2.name); }
    }
  } catch(e) { B('FEAT-SCLONE-ERR-' + e.name); }

  // 4. ResizableArrayBuffer
  try {
    var rab = new ArrayBuffer(8, {maxByteLength: 64});
    B('FEAT-RAB-YES-MAX' + rab.maxByteLength);
    B('FEAT-RAB-RESIZABLE-' + rab.resizable);
    try { rab.resize(32); B('FEAT-RAB-RESIZE-YES-' + rab.byteLength); }
    catch(e2) { B('FEAT-RAB-RESIZE-NO-' + e2.name); }
  } catch(e) { B('FEAT-RAB-NO-' + e.name); }

  // 4b. ArrayBuffer.transfer()
  try {
    var ab2 = new ArrayBuffer(16);
    if (typeof ab2.transfer === 'function') {
      var ab3 = ab2.transfer();
      B('FEAT-ABTRANSFER-YES-OLD' + ab2.byteLength + '-NEW' + ab3.byteLength);
    } else if (typeof ab2.transfer === 'undefined') {
      B('FEAT-ABTRANSFER-NO');
    } else {
      B('FEAT-ABTRANSFER-TYPE-' + typeof ab2.transfer);
    }
  } catch(e) { B('FEAT-ABTRANSFER-ERR-' + e.name); }

  // 5. Iterator helpers (Array.from, generators, Symbol.iterator)
  try {
    var gen = (function*() { yield 1; yield 2; })();
    var arr = Array.from(gen);
    B('FEAT-GENITER-' + (arr.length === 2 ? 'YES' : 'NO'));
    // Check iterator helpers (map/filter/take on iterators - newer spec)
    var g2 = (function*() { yield 1; yield 2; yield 3; })();
    if (typeof g2.map === 'function') {
      B('FEAT-ITERHELPERS-YES');
    } else {
      B('FEAT-ITERHELPERS-NO');
    }
  } catch(e) { B('FEAT-GENITER-ERR-' + e.name); }

  // 6. CSS Font Loading API
  try {
    if (typeof FontFace === 'function') {
      B('FEAT-FONTFACE-YES');
      if (document.fonts && typeof document.fonts.add === 'function') {
        B('FEAT-FONTSADD-YES');
      } else {
        B('FEAT-FONTSADD-NO');
      }
      if (document.fonts && document.fonts.ready) {
        B('FEAT-FONTSREADY-YES');
      } else {
        B('FEAT-FONTSREADY-NO');
      }
    } else {
      B('FEAT-FONTFACE-NO');
    }
  } catch(e) { B('FEAT-FONTFACE-ERR-' + e.name); }

  // 7. ReadableStream type:'bytes' (BYOB)
  try {
    if (typeof ReadableStream === 'function') {
      B('FEAT-RSTREAM-YES');
      try {
        var bs = new ReadableStream({ type: 'bytes', pull: function(c) { c.close(); } });
        B('FEAT-BYOB-YES');
        try {
          var reader = bs.getReader({ mode: 'byob' });
          B('FEAT-BYOBREADER-YES');
        } catch(e3) { B('FEAT-BYOBREADER-NO-' + e3.name); }
      } catch(e2) { B('FEAT-BYOB-NO-' + e2.name); }
    } else {
      B('FEAT-RSTREAM-NO');
    }
  } catch(e) { B('FEAT-RSTREAM-ERR-' + e.name); }

  // 8. Temporal API
  try {
    if (typeof Temporal !== 'undefined') {
      B('FEAT-TEMPORAL-YES');
      B('FEAT-TEMPORAL-NOW-' + (typeof Temporal.Now));
    } else {
      B('FEAT-TEMPORAL-NO');
    }
  } catch(e) { B('FEAT-TEMPORAL-NO-' + e.name); }

  // 9. Set methods (intersection, union, difference)
  try {
    var s1 = new Set([1,2,3]);
    if (typeof s1.intersection === 'function') {
      var s2 = new Set([2,3,4]);
      var s3 = s1.intersection(s2);
      B('FEAT-SETMETHODS-YES-' + s3.size);
    } else {
      B('FEAT-SETMETHODS-NO');
    }
  } catch(e) { B('FEAT-SETMETHODS-ERR-' + e.name); }

  // 10. Promise.withResolvers
  try {
    if (typeof Promise.withResolvers === 'function') {
      var pr = Promise.withResolvers();
      B('FEAT-PWRESOLVERS-YES');
    } else {
      B('FEAT-PWRESOLVERS-NO');
    }
  } catch(e) { B('FEAT-PWRESOLVERS-ERR-' + e.name); }

  // 11. Atomics (without SharedArrayBuffer)
  try {
    if (typeof Atomics !== 'undefined') {
      B('FEAT-ATOMICS-YES');
      B('FEAT-ATOMICS-WAIT-' + (typeof Atomics.wait));
      B('FEAT-ATOMICS-NOTIFY-' + (typeof Atomics.notify));
    } else {
      B('FEAT-ATOMICS-NO');
    }
  } catch(e) { B('FEAT-ATOMICS-ERR-' + e.name); }

  // 12. Web Locks API
  try {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      B('FEAT-WEBLOCKS-YES');
    } else {
      B('FEAT-WEBLOCKS-NO');
    }
  } catch(e) { B('FEAT-WEBLOCKS-ERR-' + e.name); }

  // 13. Compression Streams
  try {
    if (typeof CompressionStream === 'function') {
      B('FEAT-COMPSTREAM-YES');
    } else {
      B('FEAT-COMPSTREAM-NO');
    }
    if (typeof DecompressionStream === 'function') {
      B('FEAT-DECOMPSTREAM-YES');
    } else {
      B('FEAT-DECOMPSTREAM-NO');
    }
  } catch(e) { B('FEAT-COMPSTREAM-ERR-' + e.name); }

  // 14. WebGPU
  try {
    if (navigator.gpu) {
      B('FEAT-WEBGPU-YES');
    } else {
      B('FEAT-WEBGPU-NO');
    }
  } catch(e) { B('FEAT-WEBGPU-ERR-' + e.name); }

  // 15. OffscreenCanvas
  try {
    if (typeof OffscreenCanvas === 'function') {
      var oc = new OffscreenCanvas(1, 1);
      B('FEAT-OFFCANVAS-YES');
    } else {
      B('FEAT-OFFCANVAS-NO');
    }
  } catch(e) { B('FEAT-OFFCANVAS-ERR-' + e.name); }

  // 16. Performance.measureUserAgentSpecificMemory
  try {
    if (performance && typeof performance.measureUserAgentSpecificMemory === 'function') {
      B('FEAT-PERFMEM-YES');
    } else {
      B('FEAT-PERFMEM-NO');
    }
  } catch(e) { B('FEAT-PERFMEM-ERR-' + e.name); }

  // 17. ArrayBuffer.prototype.transfer (already tested in 4b, now test detachedness)
  try {
    var ab4 = new ArrayBuffer(8);
    var v4 = new Uint8Array(ab4);
    v4[0] = 0xAA;
    if (typeof ab4.transfer === 'function') {
      var ab5 = ab4.transfer(16);
      var v5 = new Uint8Array(ab5);
      B('FEAT-TRANSFER-DETACH-OLD' + ab4.byteLength + '-NEW' + ab5.byteLength + '-VAL' + v5[0].toString(16));
    } else {
      B('FEAT-TRANSFER-ABSENT');
    }
  } catch(e) { B('FEAT-TRANSFER-ERR-' + e.name); }

  // 18. eval() in Worker
  try {
    var wEvalCode = function() {
      var baseUrl = '';
      function beacon(tag) {
        try {
          var x = new XMLHttpRequest();
          x.open('POST', baseUrl + '/beacon/V399-' + tag + '?t=' + Date.now(), false);
          x.send('');
        } catch(e) {}
      }
      self.onmessage = function(e) {
        if (e.data.cmd === 'init') {
          baseUrl = e.data.baseUrl;
          // Test eval
          try {
            var r = eval('1+2');
            beacon('FEAT-WEVAL-YES-' + r);
          } catch(ex) { beacon('FEAT-WEVAL-NO-' + ex.name); }
          // Test new Function
          try {
            var fn = new Function('return 42');
            beacon('FEAT-WNEWFUNC-YES-' + fn());
          } catch(ex) { beacon('FEAT-WNEWFUNC-NO-' + ex.name); }
          // Test importScripts
          beacon('FEAT-WIMPORTSCRIPTS-' + (typeof importScripts));
          self.postMessage({done: true});
        }
      };
    };
    var wBlob = new Blob(['(' + wEvalCode.toString() + ')()'], {type: 'application/javascript'});
    var w = new Worker(URL.createObjectURL(wBlob));
    w.postMessage({cmd: 'init', baseUrl: location.protocol + '//' + location.host});
    w.onmessage = function(e) {
      if (e.data.done) {
        B('FEAT-WORKERTEST-DONE');
        w.terminate();
      }
    };
  } catch(e) { B('FEAT-WORKER-ERR-' + e.name); }

  // 20. Proxy handler traps
  try {
    var traps = ['get','set','has','deleteProperty','ownKeys','getOwnPropertyDescriptor',
                 'defineProperty','getPrototypeOf','setPrototypeOf','isExtensible',
                 'preventExtensions','apply','construct'];
    var target = {};
    var supported = [];
    for (var ti = 0; ti < traps.length; ti++) {
      var trap = traps[ti];
      var handler = {};
      handler[trap] = function() { return true; };
      try {
        var p = new Proxy(trap === 'apply' || trap === 'construct' ? function(){} : {}, handler);
        supported.push(trap.charAt(0));
      } catch(e2) {}
    }
    B('FEAT-PROXY-TRAPS-' + supported.length + 'OF' + traps.length);
  } catch(e) { B('FEAT-PROXY-ERR-' + e.name); }

  // 21. FinalizationRegistry callback timing
  try {
    if (typeof FinalizationRegistry === 'function') {
      B('FEAT-FINREG-YES');
      var frStart = Date.now();
      var frFired = false;
      var fr = new FinalizationRegistry(function(val) {
        if (!frFired) {
          frFired = true;
          var elapsed = Date.now() - frStart;
          B('FEAT-FINREG-CALLBACK-' + elapsed + 'MS');
        }
      });
      (function() {
        var obj = {x: 1};
        fr.register(obj, 'test');
      })();
      // Trigger GC
      for (var gi = 0; gi < 100; gi++) {
        for (var gj = 0; gj < 500; gj++) new ArrayBuffer(8192);
      }
      // Check after a delay
      setTimeout(function() {
        if (!frFired) B('FEAT-FINREG-NOTFIRED-' + (Date.now() - frStart) + 'MS');
      }, 3000);
    } else {
      B('FEAT-FINREG-NO');
    }
  } catch(e) { B('FEAT-FINREG-ERR-' + e.name); }

  // 22. WeakRef deref timing
  try {
    if (typeof WeakRef === 'function') {
      B('FEAT-WEAKREF-YES');
      var wrRef;
      (function() {
        var obj = {y: 2};
        wrRef = new WeakRef(obj);
      })();
      var beforeGC = wrRef.deref() ? 'ALIVE' : 'DEAD';
      B('FEAT-WEAKREF-BEFOREGC-' + beforeGC);
      for (var gi = 0; gi < 100; gi++) {
        for (var gj = 0; gj < 500; gj++) new ArrayBuffer(8192);
      }
      var afterGC = wrRef.deref() ? 'ALIVE' : 'DEAD';
      B('FEAT-WEAKREF-AFTERGC-' + afterGC);
      setTimeout(function() {
        var later = wrRef.deref() ? 'ALIVE' : 'DEAD';
        B('FEAT-WEAKREF-3SLATER-' + later);
      }, 3000);
    } else {
      B('FEAT-WEAKREF-NO');
    }
  } catch(e) { B('FEAT-WEAKREF-ERR-' + e.name); }

  // Bonus: UA string
  B('UA-' + navigator.userAgent.replace(/[^a-zA-Z0-9\/\.\(\); ]/g, '_').substring(0, 180));

  // Bonus: memory info
  try {
    if (performance && performance.memory) {
      B('FEAT-PERFMEMORY-HEAP-' + performance.memory.jsHeapSizeLimit);
    } else {
      B('FEAT-PERFMEMORY-ABSENT');
    }
  } catch(e) { B('FEAT-PERFMEMORY-ERR'); }

  // Bonus: Test process.memoryUsage (Node-style, won't exist)
  try {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      B('FEAT-PROCMEM-YES');
    } else {
      B('FEAT-PROCMEM-NO');
    }
  } catch(e) { B('FEAT-PROCMEM-NO'); }

  B('COMPLETE');
})();
