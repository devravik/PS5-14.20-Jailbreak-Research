// p517 — Proxy trap re-entrancy during JSC internal operations
//
// Proxy traps fire SYNCHRONOUSLY during property access. When JSC internal
// operations iterate over object properties through a Proxy, each property
// access invokes the trap, which can:
// - Modify the target object (add/remove properties)
// - Modify the handler object
// - Trigger GC
// - Throw exceptions
// - Detach ArrayBuffers
//
// Attack surfaces:
// T1: Object.keys() with Proxy — ownKeys trap returns stale property list
// T2: JSON.stringify() with Proxy — get trap modifies object during serialization
// T3: Object.assign() with Proxy source — get trap modifies target during copy
// T4: Array.from() with Proxy iterator — next() modifies the array
// T5: Spread operator with Proxy — modifying length during spread
// T6: for-in with Proxy — modifying prototype chain during iteration
// T7: Proxy as constructor argument — trap during internal slot access
//
// Beacon prefix: V517-

(function() {
  var T0 = Date.now();
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V517-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send('[' + (Date.now() - T0) + 'ms] ' + (body || ''));
    } catch(e) {}
  }

  B('BOOT', navigator.userAgent);

  var results = {};

  // T1: Object.keys() with ownKeys trap returning changing set
  try {
    B('T1-START', 'Object.keys + mutating ownKeys');
    var callCount = 0;
    var target1 = { a: 1, b: 2, c: 3 };
    var handler1 = {
      ownKeys: function(t) {
        callCount++;
        if (callCount === 1) {
          // First call: return normal keys
          return ['a', 'b', 'c', 'd', 'e'];
        }
        // Second call: return different set
        return ['x', 'y'];
      },
      getOwnPropertyDescriptor: function(t, prop) {
        // Must return descriptors for all keys reported by ownKeys
        return { value: prop, writable: true, enumerable: true, configurable: true };
      }
    };
    var proxy1 = new Proxy(target1, handler1);
    var keys = Object.keys(proxy1);
    results.T1 = { keys: keys, callCount: callCount };
    B('T1-DONE', JSON.stringify(results.T1));
  } catch(e) {
    results.T1 = { error: e.name + ': ' + e.message };
    B('T1-ERR', '' + e);
  }

  // T2: JSON.stringify with Proxy — get trap modifies object during serialization
  try {
    B('T2-START', 'JSON.stringify + mutating get trap');
    var t2log = [];
    var target2 = { a: 1, b: 2, c: 3 };
    var handler2 = {
      get: function(t, prop) {
        t2log.push('get:' + String(prop));
        if (prop === 'b') {
          // During serialization of property 'b', modify the target
          t.d = 4;
          delete t.c;
          t2log.push('mutated-during-b');
        }
        if (prop === 'toJSON') return undefined;
        return t[prop];
      },
      ownKeys: function(t) {
        t2log.push('ownKeys');
        return Object.keys(t);
      },
      getOwnPropertyDescriptor: function(t, prop) {
        return Object.getOwnPropertyDescriptor(t, prop);
      }
    };
    var proxy2 = new Proxy(target2, handler2);
    var json = JSON.stringify(proxy2);
    results.T2 = { json: json, log: t2log };
    B('T2-DONE', JSON.stringify(results.T2));
  } catch(e) {
    results.T2 = { error: e.name + ': ' + e.message };
    B('T2-ERR', '' + e);
  }

  // T3: Object.assign with Proxy source — get trap modifies target during copy
  try {
    B('T3-START', 'Object.assign + mutating source get');
    var t3log = [];
    var dest3 = {};
    var target3 = { x: 1, y: 2, z: 3 };
    var handler3 = {
      get: function(t, prop) {
        t3log.push('get:' + String(prop));
        if (prop === 'y') {
          // During copy of 'y', modify the destination
          // This can cause Object.assign's internal list to be stale
          Object.defineProperty(dest3, 'x', { value: 'modified', writable: false });
          t3log.push('dest-modified');
        }
        return t[prop];
      },
      ownKeys: function(t) { return ['x', 'y', 'z']; },
      getOwnPropertyDescriptor: function(t, prop) {
        return { value: t[prop], writable: true, enumerable: true, configurable: true };
      }
    };
    var proxy3 = new Proxy(target3, handler3);
    try {
      Object.assign(dest3, proxy3);
    } catch(e2) {
      t3log.push('assign-threw:' + e2.name);
    }
    results.T3 = { dest: JSON.stringify(dest3), log: t3log };
    B('T3-DONE', JSON.stringify(results.T3));
  } catch(e) {
    results.T3 = { error: e.name + ': ' + e.message };
    B('T3-ERR', '' + e);
  }

  // T4: Proxy as iterable — Symbol.iterator trap + re-entrancy
  try {
    B('T4-START', 'Proxy iterable with AB detach in next()');
    var t4log = [];
    var sharedAB = new ArrayBuffer(1024);
    var view = new Uint8Array(sharedAB);
    view[0] = 0x41;

    var iterCount = 0;
    var proxyIterable = new Proxy({}, {
      get: function(t, prop) {
        if (prop === Symbol.iterator) {
          return function() {
            return {
              next: function() {
                iterCount++;
                t4log.push('next-' + iterCount);
                if (iterCount === 3) {
                  // During iteration, detach the shared ArrayBuffer
                  try {
                    var mc = new MessageChannel();
                    mc.port1.postMessage('', [sharedAB]);
                    t4log.push('ab-detached:' + (sharedAB.byteLength === 0));
                  } catch(e) {
                    t4log.push('detach-err:' + e.message.slice(0, 50));
                  }
                }
                if (iterCount > 5) return { done: true };
                return { value: iterCount, done: false };
              }
            };
          };
        }
        return t[prop];
      }
    });

    var arr4 = Array.from(proxyIterable);
    results.T4 = {
      arr: arr4,
      abDetached: sharedAB.byteLength === 0,
      log: t4log
    };
    B('T4-DONE', JSON.stringify(results.T4));
  } catch(e) {
    results.T4 = { error: e.name + ': ' + e.message };
    B('T4-ERR', '' + e);
  }

  // T5: Proxy with has/get traps during `in` operator and property access in tight loop
  // Tests JSC's inline cache invalidation through Proxy
  try {
    B('T5-START', 'Proxy IC invalidation');
    var t5log = [];
    var structureChanges = 0;

    // Create a Proxy that changes its shape on every access
    var target5 = { prop: 42 };
    var handler5 = {
      get: function(t, prop) {
        structureChanges++;
        // Add a new property each time — this should defeat structure caching
        t['dyn_' + structureChanges] = structureChanges;
        return t[prop];
      },
      has: function(t, prop) {
        // Modify target during 'in' check
        if (structureChanges > 100 && structureChanges < 105) {
          // Change prototype chain
          Object.setPrototypeOf(t, { hidden: 'surprise' });
          t5log.push('proto-changed-at-' + structureChanges);
        }
        return prop in t;
      }
    };
    var proxy5 = new Proxy(target5, handler5);

    // Access through the proxy many times to test IC handling
    var sum = 0;
    for (var i = 0; i < 200; i++) {
      sum += proxy5.prop;
      if (i === 100) {
        // Mid-loop, check if 'hidden' is accessible
        var hasHidden = ('hidden' in proxy5);
        t5log.push('hidden-at-100:' + hasHidden);
      }
    }

    results.T5 = {
      sum: sum,
      structureChanges: structureChanges,
      log: t5log
    };
    B('T5-DONE', JSON.stringify(results.T5));
  } catch(e) {
    results.T5 = { error: e.name + ': ' + e.message };
    B('T5-ERR', '' + e);
  }

  // T6: Proxy handler that replaces itself during defineProperty
  try {
    B('T6-START', 'handler self-replacement in defineProperty');
    var t6log = [];
    var target6 = {};
    var handler6 = {
      defineProperty: function(t, prop, desc) {
        t6log.push('define:' + prop);
        if (prop === 'b') {
          // During defineProperty for 'b', swap the handler
          // This tests if JSC caches the handler reference
          handler6.get = function(t2, p) {
            t6log.push('newGet:' + p);
            return 'intercepted';
          };
          t6log.push('handler-swapped');
        }
        return Reflect.defineProperty(t, prop, desc);
      }
    };
    var proxy6 = new Proxy(target6, handler6);

    Object.defineProperties(proxy6, {
      a: { value: 1, writable: true, configurable: true, enumerable: true },
      b: { value: 2, writable: true, configurable: true, enumerable: true },
      c: { value: 3, writable: true, configurable: true, enumerable: true }
    });

    // After handler swap, does get use the new handler?
    var valC = proxy6.c;
    t6log.push('c=' + valC);

    results.T6 = { target: JSON.stringify(target6), log: t6log };
    B('T6-DONE', JSON.stringify(results.T6));
  } catch(e) {
    results.T6 = { error: e.name + ': ' + e.message };
    B('T6-ERR', '' + e);
  }

  // T7: Proxy as Map/Set constructor argument — traps during internal iteration
  try {
    B('T7-START', 'Proxy as Map constructor iterable');
    var t7log = [];
    var poisonCount = 0;

    // Create a Proxy array that modifies itself when iterated
    var entries = [[1, 'a'], [2, 'b'], [3, 'c']];
    var proxyEntries = new Proxy(entries, {
      get: function(t, prop) {
        if (prop === 'length') {
          t7log.push('length:' + t.length);
          return t.length;
        }
        if (prop === Symbol.iterator) {
          return function() {
            var idx = 0;
            return {
              next: function() {
                if (idx >= entries.length) return { done: true };
                var pair = entries[idx];
                t7log.push('yield-' + idx);
                idx++;
                if (idx === 2) {
                  // During iteration, push more entries
                  entries.push([4, 'd']);
                  entries.push([5, 'e']);
                  t7log.push('entries-extended');
                }
                return { value: pair, done: false };
              }
            };
          };
        }
        return t[prop];
      }
    });

    var map = new Map(proxyEntries);
    results.T7 = {
      mapSize: map.size,
      entries: Array.from(map),
      log: t7log
    };
    B('T7-DONE', JSON.stringify(results.T7));
  } catch(e) {
    results.T7 = { error: e.name + ': ' + e.message };
    B('T7-ERR', '' + e);
  }

  // Final summary
  setTimeout(function() {
    B('SUMMARY', JSON.stringify(results).slice(0, 1000));
    B('COMPLETE', 'all tests done');
  }, 500);

})();
