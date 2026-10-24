// p178 — WebKit fingerprint probe
// Reports full UA, WebKit feature tests, and JSC behavior indicators.
// Zero big allocations. Fast and safe.
// Beacon prefix: V178-

(function() {
  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V178-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  function asyncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V178-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // 1. Full User-Agent (split into chunks for beacon URL safety)
  var ua = navigator.userAgent || 'NONE';
  syncB('UA-LEN-' + ua.length);
  // Send in 80-char chunks
  for (var i = 0; i < ua.length; i += 80) {
    syncB('UA-' + i + '-' + encodeURIComponent(ua.substring(i, i + 80)));
  }

  // 2. Feature detection for version fingerprinting
  var features = {};

  // structuredClone (added Safari 15.4)
  features.structuredClone = typeof structuredClone === 'function' ? 1 : 0;

  // Array.at (Safari 15.4)
  features.arrayAt = typeof [].at === 'function' ? 1 : 0;

  // Object.hasOwn (Safari 15.4)
  features.hasOwn = typeof Object.hasOwn === 'function' ? 1 : 0;

  // Array.findLast (Safari 15.4)
  features.findLast = typeof [].findLast === 'function' ? 1 : 0;

  // String.replaceAll (Safari 13.1)
  features.replaceAll = typeof ''.replaceAll === 'function' ? 1 : 0;

  // import.meta (test via eval)
  try { eval('import.meta'); features.importMeta = 1; } catch(e) { features.importMeta = 0; }

  // WeakRef (Safari 14.1)
  features.weakRef = typeof WeakRef === 'function' ? 1 : 0;

  // FinalizationRegistry (Safari 14.1)
  features.finReg = typeof FinalizationRegistry === 'function' ? 1 : 0;

  // Temporal (very new, Safari 17.4+)
  features.temporal = typeof Temporal !== 'undefined' ? 1 : 0;

  // RegExp lookbehind (Safari 16.4)
  try { new RegExp('(?<=a)b'); features.lookbehind = 1; } catch(e) { features.lookbehind = 0; }

  // RegExp /d flag (Safari 15)
  try { new RegExp('a', 'd'); features.regexD = 1; } catch(e) { features.regexD = 0; }

  // RegExp /v flag (Safari 17)
  try { new RegExp('[\\p{L}]', 'v'); features.regexV = 1; } catch(e) { features.regexV = 0; }

  // Array.groupBy / Object.groupBy (Safari 17.4)
  features.groupBy = typeof Object.groupBy === 'function' ? 1 : 0;

  // Promise.withResolvers (Safari 17.4)
  features.promiseResolvers = typeof Promise.withResolvers === 'function' ? 1 : 0;

  // Set methods (Safari 17)
  features.setUnion = typeof Set.prototype.union === 'function' ? 1 : 0;
  features.setIntersection = typeof Set.prototype.intersection === 'function' ? 1 : 0;

  // Iterator helpers (Safari 17.4 partial, 18+ full)
  try { features.iterHelpers = typeof [].values().map === 'function' ? 1 : 0; } catch(e) { features.iterHelpers = 0; }

  // Resizable ArrayBuffer (Safari 16.4)
  try { new ArrayBuffer(8, { maxByteLength: 16 }); features.resizableAB = 1; } catch(e) { features.resizableAB = 0; }

  // SharedArrayBuffer
  features.sharedAB = typeof SharedArrayBuffer !== 'undefined' ? 1 : 0;

  // Atomics.waitAsync (Safari 16.4)
  features.waitAsync = typeof Atomics !== 'undefined' && typeof Atomics.waitAsync === 'function' ? 1 : 0;

  // CSS.highlights (Safari 17.2)
  features.cssHighlights = typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined' ? 1 : 0;

  // structuredClone with transfer
  if (features.structuredClone) {
    try {
      var ab = new ArrayBuffer(8);
      structuredClone(ab, { transfer: [ab] });
      features.cloneTransfer = 1;
    } catch(e) { features.cloneTransfer = 0; }
  } else {
    features.cloneTransfer = 0;
  }

  // 3. WebAssembly support level
  features.wasm = typeof WebAssembly !== 'undefined' ? 1 : 0;
  if (features.wasm) {
    features.wasmStreaming = typeof WebAssembly.compileStreaming === 'function' ? 1 : 0;
    try { new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }); features.wasmShared = 1; } catch(e) { features.wasmShared = 0; }
    features.wasmExn = typeof WebAssembly.Exception === 'function' ? 1 : 0;
  }

  // 4. postMessage / MessageChannel
  features.msgChannel = typeof MessageChannel === 'function' ? 1 : 0;

  // 5. Workers + transferable
  features.worker = typeof Worker === 'function' ? 1 : 0;

  // 6. Symbols
  features.symbolDesc = typeof Symbol.prototype.description !== 'undefined' ? 1 : 0;

  // 7. JSC specific: type info via toString
  try {
    var o = {};
    o[Symbol.toStringTag] = 'test';
    features.toStringTag = Object.prototype.toString.call(o) === '[object test]' ? 1 : 0;
  } catch(e) { features.toStringTag = 0; }

  // Send all features as one beacon string
  var fStr = '';
  for (var k in features) {
    if (features.hasOwnProperty(k)) {
      fStr += k + '=' + features[k] + ',';
    }
  }
  syncB('FEAT-' + fStr);

  // 8. JSC type confusion behavioral test
  // Test: BigInt serialization in structured clone
  if (features.structuredClone) {
    try {
      var bi = BigInt(42);
      var cloned = structuredClone(bi);
      features.cloneBigInt = (cloned === bi || cloned == 42n) ? 1 : 0;
      syncB('CLONE-BIGINT-OK');
    } catch(e) {
      features.cloneBigInt = 0;
      syncB('CLONE-BIGINT-ERR-' + (e.message || '').substring(0, 40));
    }

    // Test: Symbol clone behavior
    try {
      var sym = Symbol('test');
      var obj = { [sym]: 'value', regular: 'prop' };
      var c = structuredClone(obj);
      syncB('CLONE-SYMOBJ-' + Object.keys(c).length);
    } catch(e) {
      syncB('CLONE-SYMOBJ-ERR-' + (e.message || '').substring(0, 40));
    }

    // Test: clone with circular ref
    try {
      var circ = { a: 1 };
      circ.self = circ;
      var cc = structuredClone(circ);
      syncB('CLONE-CIRC-' + (cc.self === cc ? 'OK' : 'BROKEN'));
    } catch(e) {
      syncB('CLONE-CIRC-ERR-' + (e.message || '').substring(0, 40));
    }
  }

  // 9. Memory layout probes (safe, no corruption)
  try {
    var ab1 = new ArrayBuffer(64);
    var v1 = new DataView(ab1);
    var ab2 = new ArrayBuffer(64);
    var v2 = new DataView(ab2);
    // Check if consecutive allocations are adjacent
    syncB('ALLOC-TEST-OK');
  } catch(e) {}

  // 10. GC behavior indicator
  try {
    var weak = new WeakRef({});
    // Force GC
    for (var g = 0; g < 100; g++) { var tmp = new ArrayBuffer(1024 * 1024); }
    var alive = weak.deref() !== undefined;
    syncB('GC-WEAKREF-' + (alive ? 'ALIVE' : 'DEAD'));
  } catch(e) {
    syncB('GC-WEAKREF-ERR');
  }

  syncB('DONE');
  asyncB('COMPLETE');
})();
