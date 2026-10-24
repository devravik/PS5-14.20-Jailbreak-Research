(function(){
  var log = [];
  function b(tag) {
    log.push(tag);
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V232-' + tag, true);
      x.send();
    } catch(e){}
  }

  b('START');

  // === TEST A: for-in enumeration + structure transition during iteration ===
  // Goal: force enumerator to use stale cached structure after GC + transition
  try {
    function testA() {
      var results = [];
      // Create object with known structure
      var obj = {};
      for (var i = 0; i < 64; i++) obj['prop' + i] = i;

      // Start enumerating
      var keys = [];
      var count = 0;
      for (var k in obj) {
        keys.push(k);
        count++;
        if (count === 32) {
          // Mid-enumeration: add properties to force structure transition
          for (var j = 64; j < 200; j++) obj['added' + j] = j;
          // Force GC to try to collect old structure
          var garbage = [];
          for (var g = 0; g < 5000; g++) {
            var tmp = {};
            tmp['unique_' + g] = g;
            garbage.push(tmp);
          }
          garbage = null;
          // Try to trigger GC
          if (typeof gc === 'function') gc();
          try { new ArrayBuffer(64 * 1024 * 1024); } catch(e){}
        }
      }
      b('A-KEYS-' + keys.length);
      // Check if we got more keys than original (saw added ones)
      var sawAdded = keys.filter(function(k){ return k.indexOf('added') === 0; }).length;
      b('A-ADDED-' + sawAdded);
      // Check if any keys are undefined or corrupted
      var badKeys = keys.filter(function(k){ return k === undefined || k === null || k === ''; }).length;
      b('A-BADKEYS-' + badKeys);
      return keys.length;
    }
    var aResult = testA();
    b('A-TOTAL-' + aResult);
  } catch(e) { b('A-ERR-' + e.message.substring(0,40)); }

  // === TEST B: Proxy as source for TypedArray.set() ===
  // Goal: Proxy get trap fires per-index during set, allowing reentrancy
  try {
    var ab = new ArrayBuffer(1024);
    var target = new Uint32Array(ab);
    var triggerCount = 0;
    var detachedDuringSet = false;

    var fakeSource = new Proxy(new Uint32Array(256), {
      get: function(t, prop) {
        if (prop === 'length') return 256;
        var idx = parseInt(prop);
        if (idx === 128 && !detachedDuringSet) {
          detachedDuringSet = true;
          triggerCount++;
          // Try to resize/transfer the target's buffer mid-set
          try {
            // Attempt structured clone transfer of the backing buffer
            structuredClone(ab, {transfer: [ab]});
            b('B-TRANSFER-OK');
          } catch(e2) {
            b('B-TRANSFER-FAIL-' + e2.message.substring(0,30));
          }
        }
        return 0xCAFEBABE;
      }
    });

    try {
      target.set(fakeSource);
      b('B-SET-OK');
    } catch(e) {
      b('B-SET-ERR-' + e.message.substring(0,40));
    }
    b('B-TRIGGER-' + triggerCount);

    // Check if target still accessible
    try {
      var val = target[0];
      b('B-POST-' + (val === 0xCAFEBABE ? 'CAFE' : val === 0 ? 'ZERO' : val.toString(16)));
    } catch(e) {
      b('B-POST-ERR-' + e.message.substring(0,30));
    }
  } catch(e) { b('B-ERR-' + e.message.substring(0,40)); }

  // === TEST C: Array.sort with Proxy comparator + length mutation ===
  // Goal: TimSort assumes stable array during comparison. Mutate mid-sort.
  try {
    var arr = [];
    for (var i = 0; i < 512; i++) arr.push({val: Math.random(), idx: i});

    var compCount = 0;
    var mutated = false;
    var sortCrashed = false;

    try {
      arr.sort(function(a, b) {
        compCount++;
        if (compCount === 200 && !mutated) {
          mutated = true;
          // Truncate array mid-sort
          arr.length = 10;
          // Then extend with different type objects
          for (var i = 0; i < 300; i++) arr.push(i);
          b('C-MUTATED-AT-200');
        }
        if (a === undefined || b === undefined) return 0;
        if (typeof a === 'number') return a - (typeof b === 'number' ? b : b.val);
        if (typeof b === 'number') return a.val - b;
        return a.val - b.val;
      });
      b('C-SORT-OK-LEN-' + arr.length);
    } catch(e) {
      b('C-SORT-ERR-' + e.message.substring(0,40));
    }
    b('C-COMPS-' + compCount);

    // Check array state
    var undefs = 0;
    for (var i = 0; i < Math.min(arr.length, 20); i++) {
      if (arr[i] === undefined) undefs++;
    }
    b('C-UNDEFS-' + undefs);
  } catch(e) { b('C-ERR-' + e.message.substring(0,40)); }

  // === TEST D: SharedArrayBuffer availability + race condition ===
  try {
    if (typeof SharedArrayBuffer !== 'undefined') {
      b('D-SAB-EXISTS');
      try {
        var sab = new SharedArrayBuffer(4096);
        b('D-SAB-CREATED');
        var view1 = new Int32Array(sab);
        var view2 = new Float64Array(sab);
        view1[0] = 0x41414141;
        // Read same memory as float64
        var asFloat = view2[0];
        b('D-TYPEPUN-' + (asFloat !== 0 ? 'OK' : 'ZERO'));

        // Check Atomics
        if (typeof Atomics !== 'undefined') {
          b('D-ATOMICS-YES');
          Atomics.store(view1, 0, 0xDEADBEEF);
          var loaded = Atomics.load(view1, 0);
          b('D-ATOMIC-' + (loaded === 0xDEADBEEF ? 'OK' : loaded.toString(16)));
        } else {
          b('D-ATOMICS-NO');
        }
      } catch(e) {
        b('D-SAB-ERR-' + e.message.substring(0,40));
      }
    } else {
      b('D-SAB-MISSING');
    }
  } catch(e) { b('D-ERR-' + e.message.substring(0,40)); }

  // === TEST E: Intl object stress - ICU buffer handling ===
  try {
    if (typeof Intl !== 'undefined') {
      b('E-INTL-EXISTS');

      // E1: Segmenter with extreme input
      try {
        if (typeof Intl.Segmenter !== 'undefined') {
          b('E-SEGMENTER-YES');
          var seg = new Intl.Segmenter('en', {granularity: 'grapheme'});
          // Build string with complex grapheme clusters (emoji ZWJ sequences)
          var complex = '';
          for (var i = 0; i < 500; i++) {
            complex += '👨‍👩‍👧‍👦';
          }
          var segments = seg.segment(complex);
          var sCount = 0;
          for (var s of segments) sCount++;
          b('E-SEG-COUNT-' + sCount);
        } else {
          b('E-SEGMENTER-NO');
        }
      } catch(e) { b('E-SEG-ERR-' + e.message.substring(0,30)); }

      // E2: NumberFormat with extreme values
      try {
        var nf = new Intl.NumberFormat('ar-SA', {
          style: 'currency',
          currency: 'SAR',
          notation: 'engineering',
          maximumSignificantDigits: 21
        });
        var result = nf.format(Number.MAX_VALUE);
        b('E-NUMFMT-LEN-' + result.length);
      } catch(e) { b('E-NUMFMT-ERR-' + e.message.substring(0,30)); }

      // E3: ListFormat with huge list
      try {
        if (typeof Intl.ListFormat !== 'undefined') {
          b('E-LISTFMT-YES');
          var bigList = [];
          for (var i = 0; i < 10000; i++) bigList.push('item' + i);
          var lf = new Intl.ListFormat('en', {style: 'long', type: 'conjunction'});
          var result = lf.format(bigList);
          b('E-LISTFMT-LEN-' + result.length);
        } else {
          b('E-LISTFMT-NO');
        }
      } catch(e) { b('E-LISTFMT-ERR-' + e.message.substring(0,30)); }

      // E4: Collator with special Unicode
      try {
        var col = new Intl.Collator('ja', {sensitivity: 'variant', numeric: true});
        // Mix of CJK, combining marks, surrogates
        var s1 = 'あ̀́̂̃̄̅̆̇̈';
        var s2 = s1.repeat(1000);
        var cmp = col.compare(s2, s2 + '̉');
        b('E-COLLATOR-' + (cmp < 0 ? 'LT' : cmp > 0 ? 'GT' : 'EQ'));
      } catch(e) { b('E-COLLATOR-ERR-' + e.message.substring(0,30)); }
    } else {
      b('E-INTL-MISSING');
    }
  } catch(e) { b('E-ERR-' + e.message.substring(0,40)); }

  // === TEST F: Canvas ImageData buffer manipulation ===
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    var ctx = canvas.getContext('2d');
    if (ctx) {
      b('F-CANVAS-OK');

      // Fill with known pattern
      ctx.fillStyle = '#FF0000';
      ctx.fillRect(0, 0, 256, 256);

      // Get ImageData - this creates a new ArrayBuffer
      var imgData = ctx.getImageData(0, 0, 256, 256);
      var buf = imgData.data.buffer;
      b('F-IMGDATA-LEN-' + imgData.data.length);
      b('F-BUF-LEN-' + buf.byteLength);

      // Verify it's a regular ArrayBuffer (not Gigacaged on PS5)
      var u32view = new Uint32Array(buf);
      b('F-U32-LEN-' + u32view.length);

      // Try to detach the backing buffer via transfer
      try {
        var cloned = structuredClone(buf, {transfer: [buf]});
        b('F-TRANSFER-OK-' + cloned.byteLength);
        // Now imgData.data should be detached
        try {
          var pixel = imgData.data[0];
          b('F-STALE-' + (pixel === undefined ? 'UNDEF' : pixel === 0 ? 'ZERO' : pixel));
        } catch(e3) {
          b('F-STALE-ERR-' + e3.message.substring(0,30));
        }
        // Write to cloned buffer - does it affect canvas?
        var clonedView = new Uint8Array(cloned);
        clonedView.fill(0x42);
        // Try putImageData with detached imgData
        try {
          ctx.putImageData(imgData, 0, 0);
          b('F-PUT-OK');
        } catch(e4) {
          b('F-PUT-ERR-' + e4.message.substring(0,30));
        }
      } catch(e2) {
        b('F-TRANSFER-ERR-' + e2.message.substring(0,30));
      }

      // Test 2: create ImageData, get multiple views, modify via different views
      var imgData2 = ctx.getImageData(0, 0, 128, 128);
      var buf2 = imgData2.data.buffer;
      var f64view = new Float64Array(buf2);
      var u8view = imgData2.data;
      // Write via float64 view
      f64view[0] = 1.99999999999999; // Known bit pattern
      // Read back via uint8
      var bytes = [];
      for (var i = 0; i < 8; i++) bytes.push(u8view[i].toString(16));
      b('F-TYPEPUN-' + bytes.join(','));
    } else {
      b('F-CANVAS-FAIL');
    }
  } catch(e) { b('F-ERR-' + e.message.substring(0,40)); }

  // === TEST G: Generator + Proxy interaction ===
  // Goal: generator yield during proxy trap creates complex control flow
  try {
    var proxyCallsDuringYield = 0;
    var generatorCorrupted = false;

    function* gen(proxyObj) {
      for (var i = 0; i < 100; i++) {
        var val = proxyObj[i]; // triggers proxy get
        yield val;
      }
    }

    var backingArray = new Array(100);
    for (var i = 0; i < 100; i++) backingArray[i] = i;

    var iterState = {gen: null, resumed: 0};

    var proxy = new Proxy(backingArray, {
      get: function(target, prop) {
        if (prop === 'length') return 100;
        var idx = parseInt(prop);
        if (!isNaN(idx)) {
          proxyCallsDuringYield++;
          if (idx === 50) {
            // Mid-iteration: delete properties from backing array
            for (var j = 60; j < 100; j++) delete target[j];
            target.length = 51;
            b('G-TRUNCATED-AT-50');
          }
        }
        return target[prop];
      }
    });

    var g = gen(proxy);
    iterState.gen = g;
    var values = [];
    var undefs = 0;
    for (var i = 0; i < 100; i++) {
      var result = g.next();
      if (result.done) break;
      if (result.value === undefined) undefs++;
      values.push(result.value);
    }
    b('G-VALUES-' + values.length);
    b('G-UNDEFS-' + undefs);
    b('G-PROXYCALLS-' + proxyCallsDuringYield);
  } catch(e) { b('G-ERR-' + e.message.substring(0,40)); }

  // === TEST H: WeakRef + FinalizationRegistry + structuredClone ===
  try {
    if (typeof WeakRef !== 'undefined' && typeof FinalizationRegistry !== 'undefined') {
      b('H-WEAKREF-YES');
      var freed = false;
      var staleRef = null;

      var registry = new FinalizationRegistry(function(held) {
        freed = true;
        b('H-CALLBACK-' + held);
      });

      (function() {
        var obj = {data: new ArrayBuffer(4096), marker: 0xBEEF};
        staleRef = new WeakRef(obj);
        registry.register(obj, 'target');
        // obj goes out of scope
      })();

      // Force GC attempts
      for (var round = 0; round < 5; round++) {
        var pressure = [];
        for (var i = 0; i < 10000; i++) pressure.push(new ArrayBuffer(1024));
        pressure = null;
        if (typeof gc === 'function') gc();
      }

      var deref = staleRef.deref();
      if (deref === undefined) {
        b('H-COLLECTED');
      } else {
        b('H-ALIVE-' + deref.marker.toString(16));
      }
      b('H-FREED-' + freed);
    } else {
      b('H-WEAKREF-NO');
    }
  } catch(e) { b('H-ERR-' + e.message.substring(0,40)); }

  b('DONE-8TESTS');
})();
