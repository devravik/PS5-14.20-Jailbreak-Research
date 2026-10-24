// p521 — Structure transition table stress + StructureID spray
//
// PS5 StructureID: pure mask+offset decode, no validation in release.
// Config is UNFROZEN (writable). Gigacage DISABLED.
// If we can predict/control StructureID values, we get type confusion.
//
// This probe:
// T1: Measure StructureID entropy by creating many objects with known shapes
// T2: Check if structure IDs are sequential/predictable via typeof timing
// T3: Stress structure transition table with rapid property additions
// T4: Test Object.create(null) + defineProperty for inline storage overflow
// T5: Megamorphic property access pattern to stress lookup caches
// T6: Probe structure compaction behavior under memory pressure
//
// Beacon prefix: V521-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V521-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  // T1: Create objects with different shapes and measure allocation patterns
  try {
    B('T1-START', 'structure shape diversity');
    var shapes = [];
    var constructors = [];

    // Create 500 different object shapes
    for (var i = 0; i < 500; i++) {
      var obj = {};
      // Each object gets a unique set of properties
      for (var j = 0; j <= i % 20; j++) {
        obj['prop_' + i + '_' + j] = j;
      }
      shapes.push(obj);
    }

    // Check if objects with same shape share structure
    var sameShape1 = { x: 1, y: 2 };
    var sameShape2 = { x: 3, y: 4 };
    var diffShape = { a: 1, b: 2, c: 3 };

    // Use typeof and property enumeration to probe structure sharing
    var keys1 = Object.keys(sameShape1).join(',');
    var keys2 = Object.keys(sameShape2).join(',');
    var keysD = Object.keys(diffShape).join(',');

    B('T1-DONE', 'shapes=' + shapes.length +
      ' same=' + (keys1 === keys2) +
      ' keys1=' + keys1 + ' keysD=' + keysD);
  } catch(e) {
    B('T1-ERR', '' + e);
  }

  // T2: Rapid structure transitions — can we cause transition table overflow?
  try {
    B('T2-START', 'rapid structure transitions');
    var transObj = {};
    var t2log = [];

    // Add many properties rapidly
    for (var i = 0; i < 10000; i++) {
      transObj['p' + i] = i;
    }
    t2log.push('added:' + Object.keys(transObj).length);

    // Delete half of them
    for (var i = 0; i < 5000; i++) {
      delete transObj['p' + i];
    }
    t2log.push('afterDelete:' + Object.keys(transObj).length);

    // Re-add with different order
    for (var i = 0; i < 5000; i++) {
      transObj['q' + i] = i;
    }
    t2log.push('reAdded:' + Object.keys(transObj).length);

    // Check property access works correctly
    var testVals = [];
    testVals.push(transObj.p5000);
    testVals.push(transObj.p9999);
    testVals.push(transObj.q0);
    testVals.push(transObj.q4999);
    t2log.push('vals=' + testVals.join(','));

    B('T2-DONE', t2log.join(' | '));
  } catch(e) {
    B('T2-ERR', '' + e);
  }

  // T3: Object.create(null) + defineProperty stress
  setTimeout(function() {
    try {
      B('T3-START', 'null proto + defineProperty');
      var nullObj = Object.create(null);
      var t3log = [];

      // Rapidly define and reconfigure properties
      for (var i = 0; i < 1000; i++) {
        Object.defineProperty(nullObj, 'x' + i, {
          value: i,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
      t3log.push('defined:1000');

      // Reconfigure all to non-writable then back
      for (var i = 0; i < 100; i++) {
        Object.defineProperty(nullObj, 'x' + i, { writable: false });
        Object.defineProperty(nullObj, 'x' + i, { writable: true }); // reconfigure
      }
      t3log.push('reconfigured:100');

      // Seal, then try to add
      Object.seal(nullObj);
      try {
        nullObj.newProp = 'test';
        t3log.push('seal-bypass:true'); // THIS WOULD BE A BUG
      } catch(e) {
        t3log.push('seal-holds:' + e.name);
      }

      B('T3-DONE', t3log.join(' | '));
    } catch(e) {
      B('T3-ERR', '' + e);
    }
  }, 500);

  // T4: Butterfly reallocation stress
  setTimeout(function() {
    try {
      B('T4-START', 'butterfly realloc stress');
      var t4log = [];

      // Create array, rapidly grow and shrink butterfly
      var arr = [];
      for (var i = 0; i < 10000; i++) arr.push(i);
      t4log.push('grew:' + arr.length);

      // Shrink
      arr.length = 10;
      t4log.push('shrunk:' + arr.length);

      // Grow with holes
      arr[9999] = 'end';
      t4log.push('holed:' + arr.length + ' sparse=' + (9999 in arr));

      // Convert to dictionary mode
      for (var i = 0; i < 100; i++) {
        arr[Math.floor(Math.random() * 100000)] = i;
      }
      t4log.push('dict-keys:' + Object.keys(arr).length);

      // Now try to use it as a normal array
      var sum = 0;
      for (var i = 0; i < arr.length && i < 100; i++) {
        if (arr[i] !== undefined) sum += Number(arr[i]) || 0;
      }
      t4log.push('sum:' + sum);

      B('T4-DONE', t4log.join(' | '));
    } catch(e) {
      B('T4-ERR', '' + e);
    }
  }, 1000);

  // T5: Megamorphic access to stress inline caches
  setTimeout(function() {
    try {
      B('T5-START', 'megamorphic IC stress');
      var t5log = [];

      // Create many objects with the same property name but different structures
      var objects = [];
      for (var i = 0; i < 200; i++) {
        var obj = {};
        // Add i random properties first to make structure unique
        for (var j = 0; j < i % 30; j++) {
          obj['pad_' + j] = j;
        }
        obj.target = i; // Same property name, different offset in each structure
        objects.push(obj);
      }

      // Access .target on all of them in a tight loop
      // This stresses the polymorphic inline cache
      var total = 0;
      for (var round = 0; round < 10; round++) {
        for (var k = 0; k < objects.length; k++) {
          total += objects[k].target;
        }
      }
      t5log.push('total:' + total);

      // Now delete .target from half and re-add it
      for (var i = 0; i < 100; i++) {
        delete objects[i].target;
        objects[i].target = i * 2; // Different structure transition
      }

      // Access again — does the cache handle the structure change?
      var total2 = 0;
      for (var k = 0; k < objects.length; k++) {
        total2 += objects[k].target;
      }
      t5log.push('total2:' + total2);

      B('T5-DONE', t5log.join(' | '));
    } catch(e) {
      B('T5-ERR', '' + e);
    }
  }, 1500);

  // T6: Probe GC behavior with WeakRef + structure watching
  setTimeout(function() {
    try {
      B('T6-START', 'GC + structure probe');
      if (typeof WeakRef === 'undefined') {
        B('T6-DEAD', 'no WeakRef');
        return;
      }

      var t6log = [];
      var refs = [];

      // Create objects, take WeakRefs, drop strong refs
      for (var i = 0; i < 100; i++) {
        var obj = { id: i, data: new ArrayBuffer(4096) };
        refs.push(new WeakRef(obj));
      }
      // Strong refs are out of scope after this loop

      // Apply GC pressure
      var pressure = [];
      for (var g = 0; g < 50000; g++) pressure.push(new ArrayBuffer(256));
      pressure = null;

      // Check how many were collected
      var alive = 0, dead = 0;
      for (var i = 0; i < refs.length; i++) {
        if (refs[i].deref()) alive++;
        else dead++;
      }
      t6log.push('alive:' + alive + ' dead:' + dead);

      // Now create objects in the SAME size class as the dead ones
      // and check if we can get their memory
      var replacements = [];
      for (var i = 0; i < 200; i++) {
        replacements.push({ id: 'replace-' + i, data: new ArrayBuffer(4096) });
      }

      // Re-check WeakRefs — can we distinguish replacement from original?
      alive = 0; dead = 0;
      for (var i = 0; i < refs.length; i++) {
        var d = refs[i].deref();
        if (d) {
          alive++;
          if (typeof d.id === 'string' && d.id.indexOf('replace') !== -1) {
            t6log.push('CONFUSION:' + i); // This would be a HUGE bug
          }
        } else {
          dead++;
        }
      }
      t6log.push('after-replace: alive:' + alive + ' dead:' + dead);

      B('T6-DONE', t6log.join(' | '));
    } catch(e) {
      B('T6-ERR', '' + e);
    }
  }, 2500);

  // Final
  setTimeout(function() {
    B('COMPLETE', 'all tests done');
  }, 4000);

})();
