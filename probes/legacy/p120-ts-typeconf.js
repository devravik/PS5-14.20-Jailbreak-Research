/*
 * p119 — Streams API deep probe for PS5 14.20
 * Focus: TransformStream iterator type confusion (CVE-2026-43705 pattern),
 *        CompressionStream/DecompressionStream malformed input,
 *        TextDecoderStream encoding edge cases,
 *        Regex surrogate OOB
 * Beacon prefix: V120T-
 */
(function () {
  "use strict";
  var RUN = "v120t" + Math.random().toString(36).slice(2, 16);

  function beacon(tag, data) {
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/beacon/V120T-" + tag, false);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify({ r: RUN, b: typeof data === "string" ? data : JSON.stringify(data) }));
    } catch (e) {}
  }

  function tryCall(fn) {
    try { return { v: fn(), e: null }; }
    catch (ex) { return { v: null, e: ex.constructor.name + ":" + String(ex.message).slice(0, 150) }; }
  }

  function schedule(tests) {
    var i = 0;
    function next() {
      if (i >= tests.length) {
        beacon("Z", "probe120-done");
        return;
      }
      var t = tests[i++];
      try { t(); } catch (e) { beacon("ERR", t.name + ":" + e.message.slice(0, 200)); }
      setTimeout(next, 300);
    }
    beacon("L", "probe120-start");
    setTimeout(next, 100);
  }

  setInterval(function () { beacon("HB", "hb"); }, 8000);

  // ================================================================
  // S1: TransformStream — determine the EXACT number of values expected
  // p118 R4 showed iterCalls=2 with 1 yielded value. Try 2, 3, 4 values.
  // ================================================================
  function S1_TS_COUNT() {
    var result = {};
    var origIter = Array.prototype[Symbol.iterator];

    for (var count = 0; count <= 5; count++) {
      (function(c) {
        var key = "yield" + c;
        try {
          Array.prototype[Symbol.iterator] = function () {
            var arr = this;
            var idx = 0;
            return {
              next: function () {
                if (idx >= c) return { done: true };
                var val = idx < arr.length ? arr[idx] : undefined;
                idx++;
                return { value: val, done: false };
              }
            };
          };
          var ts = new TransformStream();
          result[key] = "OK";
          if (ts.readable) result[key] += ":readable=" + ts.readable.constructor.name;
        } catch (e) {
          result[key] = e.constructor.name + ":" + e.message.slice(0, 100);
        } finally {
          Array.prototype[Symbol.iterator] = origIter;
        }
      })(count);
    }
    beacon("S1-TSCOUNT", result);
  }

  // ================================================================
  // S2: TransformStream — type confusion with correct count
  // Once we know the count, substitute objects of wrong type
  // ================================================================
  function S2_TS_TYPECONFUSE() {
    var result = {};
    var origIter = Array.prototype[Symbol.iterator];

    // Test A: Yield 3 values: first is real transformer, next two are TypedArrays
    var viewBuf = new ArrayBuffer(256);
    var u8 = new Uint8Array(viewBuf);
    var f64 = new Float64Array(viewBuf);

    try {
      Array.prototype[Symbol.iterator] = function () {
        var arr = this;
        var idx = 0;
        var fakes = [arr[0], u8, f64];
        return {
          next: function () {
            if (idx >= 3) return { done: true };
            return { value: fakes[idx++], done: false };
          }
        };
      };
      var ts = new TransformStream();
      result.ta3 = "OK:readable=" + (ts.readable ? ts.readable.constructor.name : "null");
    } catch (e) {
      result.ta3 = e.constructor.name + ":" + e.message.slice(0, 120);
    } finally {
      Array.prototype[Symbol.iterator] = origIter;
    }

    // Test B: Yield 3 ArrayBuffers
    try {
      Array.prototype[Symbol.iterator] = function () {
        var idx = 0;
        var bufs = [new ArrayBuffer(4096), new ArrayBuffer(4096), new ArrayBuffer(4096)];
        return {
          next: function () {
            if (idx >= 3) return { done: true };
            return { value: bufs[idx++], done: false };
          }
        };
      };
      var ts2 = new TransformStream();
      result.ab3 = "OK";
    } catch (e) {
      result.ab3 = e.constructor.name + ":" + e.message.slice(0, 120);
    } finally {
      Array.prototype[Symbol.iterator] = origIter;
    }

    // Test C: Yield 3 Proxy-wrapped objects to see what properties are accessed
    var propLog = [];
    try {
      var handler = {
        get: function (t, p) {
          propLog.push("get:" + String(p));
          if (p === Symbol.toPrimitive || p === "valueOf" || p === "toString")
            return function() { return 0; };
          return t[p];
        },
        set: function (t, p, v) {
          propLog.push("set:" + String(p) + "=" + typeof v);
          t[p] = v;
          return true;
        },
        has: function (t, p) {
          propLog.push("has:" + String(p));
          return p in t;
        }
      };

      Array.prototype[Symbol.iterator] = function () {
        var idx = 0;
        return {
          next: function () {
            if (idx >= 3) return { done: true };
            return { value: new Proxy({}, handler), done: false };
          }
        };
      };
      var ts3 = new TransformStream();
      result.proxy3 = "OK";
    } catch (e) {
      result.proxy3 = e.constructor.name + ":" + e.message.slice(0, 120);
    } finally {
      Array.prototype[Symbol.iterator] = origIter;
    }
    result.proxyLog = propLog.slice(0, 40).join("|");
    result.proxyLogLen = propLog.length;

    beacon("S2-TSTYPECONF", result);
  }

  // ================================================================
  // S3: TransformStream — override on prototype chain, not Array.prototype
  // Try to catch internal uses of @@iterator on non-Array objects
  // ================================================================
  function S3_TS_PROTOHOOK() {
    var result = {};
    var origIter = Array.prototype[Symbol.iterator];

    // Test A: Patch Object.prototype[Symbol.iterator]
    var objIterCalls = 0;
    try {
      Object.prototype[Symbol.iterator] = function () {
        objIterCalls++;
        var self = this;
        var keys = Object.keys(self);
        var i = 0;
        return {
          next: function () {
            if (i >= keys.length) return { done: true };
            return { value: self[keys[i++]], done: false };
          }
        };
      };
      var ts = new TransformStream();
      result.objIter = "OK:calls=" + objIterCalls;
    } catch (e) {
      result.objIter = e.constructor.name + ":" + e.message.slice(0, 120) + ":calls=" + objIterCalls;
    } finally {
      delete Object.prototype[Symbol.iterator];
    }

    // Test B: Patch Promise.prototype to trap internal promise operations
    var promiseTraps = [];
    var origThen = Promise.prototype.then;
    try {
      Promise.prototype.then = function (onFulfilled, onRejected) {
        promiseTraps.push("then");
        return origThen.call(this, onFulfilled, onRejected);
      };
      var ts2 = new TransformStream();
      result.promiseHook = "OK:traps=" + promiseTraps.length;
    } catch (e) {
      result.promiseHook = e.constructor.name + ":" + e.message.slice(0, 80) + ":traps=" + promiseTraps.length;
    } finally {
      Promise.prototype.then = origThen;
    }

    // Test C: Hook Array.from during TransformStream
    var origFrom = Array.from;
    var fromLog = [];
    try {
      Array.from = function () {
        fromLog.push("len=" + (arguments[0] ? arguments[0].length : "?"));
        return origFrom.apply(this, arguments);
      };
      var ts3 = new TransformStream();
      result.arrayFrom = "OK:calls=" + fromLog.length;
      result.fromLog = fromLog.join("|");
    } catch (e) {
      result.arrayFrom = e.constructor.name + ":" + e.message.slice(0, 80);
    } finally {
      Array.from = origFrom;
    }

    beacon("S3-TSPROTO", result);
  }

  // ================================================================
  // S4: TransformStream — type confusion via getter on argument
  // The transformer argument might have properties read that we can trap
  // ================================================================
  function S4_TS_GETTER() {
    var result = {};
    var trapLog = [];

    // Test A: Transformer with getter traps on all standard properties
    try {
      var evilTransformer = {};
      ["start", "transform", "flush", "cancel", "readableType", "writableType"].forEach(function(prop) {
        Object.defineProperty(evilTransformer, prop, {
          get: function () {
            trapLog.push("get:" + prop);
            if (prop === "readableType" || prop === "writableType") return undefined;
            if (prop === "start") return function (controller) {
              trapLog.push("start:called");
              result.controllerType = controller ? controller.constructor.name : "null";
              result.controllerProto = controller ? Object.getPrototypeOf(controller).constructor.name : "null";
            };
            if (prop === "transform") return function (chunk, controller) {
              trapLog.push("transform:called");
              controller.enqueue(chunk);
            };
            return undefined;
          },
          enumerable: true,
          configurable: true
        });
      });

      var ts = new TransformStream(evilTransformer);
      result.getterTS = "OK";
    } catch (e) {
      result.getterTS = e.constructor.name + ":" + e.message.slice(0, 120);
    }
    result.getterLog = trapLog.slice(0, 30).join("|");

    // Test B: Transformer that changes type during property access
    trapLog = [];
    try {
      var mutatingTransformer = {};
      var accessCount = 0;
      var stolenController = null;
      Object.defineProperty(mutatingTransformer, "start", {
        get: function () {
          accessCount++;
          if (accessCount > 1) {
            return 42;
          }
          return function (controller) {
            stolenController = controller;
            trapLog.push("start:gotController");
          };
        }
      });
      Object.defineProperty(mutatingTransformer, "transform", {
        get: function () {
          return function (chunk, controller) {
            trapLog.push("transform:" + typeof chunk);
          };
        }
      });

      var ts2 = new TransformStream(mutatingTransformer);
      result.mutatingTS = "OK:accesses=" + accessCount;

      // Try to use stolen controller after construction
      if (stolenController) {
        result.hasController = true;
        var r1 = tryCall(function () {
          stolenController.enqueue("test");
          return "enqueued";
        });
        result.controllerEnqueue = r1.e ? r1.e : r1.v;

        var r2 = tryCall(function () {
          stolenController.error(new Error("test"));
          return "errored";
        });
        result.controllerError = r2.e ? r2.e : r2.v;

        var r3 = tryCall(function () {
          stolenController.terminate();
          return "terminated";
        });
        result.controllerTerminate = r3.e ? r3.e : r3.v;
      }
    } catch (e) {
      result.mutatingTS = e.constructor.name + ":" + e.message.slice(0, 120);
    }
    result.mutLog = trapLog.join("|");

    beacon("S4-TSGETTER", result);
  }

  // ================================================================
  // S5: CompressionStream — malformed data and edge cases
  // C++ zlib code processing attacker-controlled binary data
  // ================================================================
  function S5_COMPRESSION() {
    var result = {};

    // Test A: Basic compression works
    try {
      var cs = new CompressionStream("gzip");
      result.gzipCreate = "OK";
    } catch (e) {
      result.gzipCreate = e.constructor.name + ":" + e.message.slice(0, 80);
    }

    try {
      var cs2 = new CompressionStream("deflate");
      result.deflateCreate = "OK";
    } catch (e) {
      result.deflateCreate = e.constructor.name + ":" + e.message.slice(0, 80);
    }

    try {
      var cs3 = new CompressionStream("deflate-raw");
      result.deflateRawCreate = "OK";
    } catch (e) {
      result.deflateRawCreate = e.constructor.name + ":" + e.message.slice(0, 80);
    }

    // Test B: DecompressionStream with malformed gzip headers
    var malformedTests = [
      { name: "empty", data: new Uint8Array(0) },
      { name: "zeros", data: new Uint8Array(1024) },
      { name: "badMagic", data: new Uint8Array([0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]) },
      { name: "truncGzip", data: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]) },
      { name: "hugeSize", data: (function() {
        var d = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
          0x03, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
        return d;
      })() },
      { name: "badDeflate", data: new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff]) },
    ];

    var pending = malformedTests.length;
    malformedTests.forEach(function (test) {
      try {
        var ds = new DecompressionStream("gzip");
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();

        var readResult = { name: test.name, status: "pending" };

        writer.write(test.data).then(function () {
          readResult.writeOK = true;
        }).catch(function (e) {
          readResult.writeErr = e.constructor.name + ":" + String(e.message).slice(0, 60);
        });

        writer.close().catch(function () {});

        reader.read().then(function (chunk) {
          readResult.status = "read:" + (chunk.done ? "done" : "data:" + chunk.value.length);
        }).catch(function (e) {
          readResult.status = "readErr:" + e.constructor.name;
        }).finally(function () {
          pending--;
          result["decomp_" + test.name] = readResult.status + (readResult.writeErr ? "|w:" + readResult.writeErr : "");
          if (pending === 0) beacon("S5-COMPRESS", result);
        });
      } catch (e) {
        result["decomp_" + test.name] = "createErr:" + e.constructor.name + ":" + e.message.slice(0, 60);
        pending--;
        if (pending === 0) beacon("S5-COMPRESS", result);
      }
    });

    // In case no promises resolve, beacon after timeout
    setTimeout(function () {
      if (pending > 0) {
        result.timeout = "pending=" + pending;
        beacon("S5-COMPRESS", result);
      }
    }, 5000);
  }

  // ================================================================
  // S6: DecompressionStream — crafted deflate bombs and boundary cases
  // ================================================================
  function S6_DECOMP_EDGE() {
    var result = {};

    // Test A: Recursive/nested gzip (gzip inside gzip)
    // This tests if the decompressor handles re-entrant decompression

    // Test B: Deflate stream with back-reference pointing before buffer start
    // Crafted deflate with invalid distance code
    var badDistance = new Uint8Array([
      0x78, 0x9c,
      0x63, 0x60, 0x60, 0x60,
      0xe0, 0xff, 0xff,
      0x01, 0x00, 0x00, 0x05, 0x00, 0x01
    ]);

    // Test C: Deflate with 0-length block followed by huge claimed length
    var zeroBlock = new Uint8Array([
      0x78, 0x9c,
      0x00, 0x00, 0x00, 0xff, 0xff,
      0x01, 0xff, 0xff, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x01
    ]);

    var tests = [
      { name: "badDist", data: badDistance, fmt: "deflate" },
      { name: "zeroBlock", data: zeroBlock, fmt: "deflate" },
    ];

    var pending = tests.length;
    tests.forEach(function (test) {
      try {
        var ds = new DecompressionStream(test.fmt);
        var writer = ds.writable.getWriter();
        var reader = ds.readable.getReader();
        var chunks = [];
        var totalBytes = 0;

        function pump() {
          reader.read().then(function (r) {
            if (r.done) {
              result[test.name] = "done:bytes=" + totalBytes + ":chunks=" + chunks.length;
              pending--;
              if (pending === 0) beacon("S6-DECOMPEDGE", result);
              return;
            }
            totalBytes += r.value.length;
            chunks.push(r.value.length);
            if (totalBytes > 1000000) {
              reader.cancel("too large");
              result[test.name] = "cancelled:bytes=" + totalBytes;
              pending--;
              if (pending === 0) beacon("S6-DECOMPEDGE", result);
              return;
            }
            pump();
          }).catch(function (e) {
            result[test.name] = "readErr:" + e.constructor.name + ":" + String(e.message).slice(0, 80);
            pending--;
            if (pending === 0) beacon("S6-DECOMPEDGE", result);
          });
        }

        writer.write(test.data).then(function () {
          writer.close().catch(function () {});
          pump();
        }).catch(function (e) {
          result[test.name] = "writeErr:" + e.constructor.name + ":" + String(e.message).slice(0, 80);
          pending--;
          if (pending === 0) beacon("S6-DECOMPEDGE", result);
        });
      } catch (e) {
        result[test.name] = "createErr:" + e.constructor.name + ":" + e.message.slice(0, 80);
        pending--;
        if (pending === 0) beacon("S6-DECOMPEDGE", result);
      }
    });

    setTimeout(function () {
      if (pending > 0) {
        result.timeout = "pending=" + pending;
        beacon("S6-DECOMPEDGE", result);
      }
    }, 5000);
  }

  // ================================================================
  // S7: TextDecoderStream — encoding edge cases
  // TextDecoder with streaming=true has had historical buffer bugs
  // ================================================================
  function S7_TEXTDECODER() {
    var result = {};

    // Test A: Available encodings
    var encodings = ["utf-8", "utf-16le", "utf-16be", "windows-1252", "iso-8859-1",
                     "ascii", "euc-jp", "shift_jis", "gb2312", "gbk", "big5"];
    encodings.forEach(function (enc) {
      try {
        var td = new TextDecoder(enc);
        result["enc_" + enc.replace(/-/g, "")] = "OK";
      } catch (e) {
        result["enc_" + enc.replace(/-/g, "")] = e.constructor.name;
      }
    });

    // Test B: TextDecoderStream with split UTF-8 sequences
    try {
      var tds = new TextDecoderStream("utf-8");
      var writer = tds.writable.getWriter();
      var reader = tds.readable.getReader();
      var output = "";

      // 4-byte UTF-8 sequence for U+1F600 split across 2 writes
      var firstHalf = new Uint8Array([0xF0, 0x9F]);
      var secondHalf = new Uint8Array([0x98, 0x80]);

      writer.write(firstHalf);
      writer.write(secondHalf);
      writer.close();

      reader.read().then(function (r1) {
        if (!r1.done) output += r1.value;
        reader.read().then(function (r2) {
          if (!r2.done) output += r2.value;
          result.splitUtf8 = "OK:out=" + output.length + ":" + output.codePointAt(0);
          beacon("S7-TEXTDEC", result);
        });
      }).catch(function (e) {
        result.splitUtf8 = "ERR:" + e.constructor.name;
        beacon("S7-TEXTDEC", result);
      });
    } catch (e) {
      result.splitUtf8 = "createErr:" + e.constructor.name;
      beacon("S7-TEXTDEC", result);
    }

    // Test C: Invalid continuation bytes
    try {
      var td2 = new TextDecoder("utf-8", { fatal: true });
      var badSeqs = [
        new Uint8Array([0x80]),
        new Uint8Array([0xC0, 0x80]),
        new Uint8Array([0xF8, 0x80, 0x80, 0x80, 0x80]),
        new Uint8Array([0xFE, 0xFF]),
        new Uint8Array([0xED, 0xA0, 0x80]),
      ];
      badSeqs.forEach(function (seq, i) {
        var r = tryCall(function () {
          return td2.decode(seq);
        });
        result["badUtf8_" + i] = r.e ? "threw" : "OK:" + r.v.length;
      });
    } catch (e) {
      result.badUtf8 = "createErr:" + e.constructor.name;
    }

    // Test D: Huge buffer decode
    try {
      var hugeBuf = new ArrayBuffer(16 * 1024 * 1024);
      var hugeView = new Uint8Array(hugeBuf);
      for (var i = 0; i < hugeView.length; i++) hugeView[i] = 0x41 + (i % 26);
      var td3 = new TextDecoder("utf-8");
      var hugeStr = td3.decode(hugeView);
      result.hugeDecode = "OK:len=" + hugeStr.length;
    } catch (e) {
      result.hugeDecode = e.constructor.name + ":" + e.message.slice(0, 80);
    }
  }

  // ================================================================
  // S8: TransformStream piping with controller manipulation
  // Test if we can corrupt stream state by manipulating controller
  // during piping between readable and writable
  // ================================================================
  function S8_TS_PIPE() {
    var result = {};

    // Test A: pipeTo with abort during transform
    try {
      var abortController = new AbortController();
      var transformCount = 0;

      var ts = new TransformStream({
        transform: function (chunk, controller) {
          transformCount++;
          if (transformCount === 3) {
            abortController.abort();
            controller.enqueue(chunk);
            controller.enqueue(chunk);
          } else {
            controller.enqueue(chunk);
          }
        }
      });

      var collected = [];
      var ws = new WritableStream({
        write: function (chunk) {
          collected.push(chunk);
        }
      });

      var writer = ts.writable.getWriter();
      for (var w = 0; w < 5; w++) writer.write("chunk" + w);
      writer.close();

      ts.readable.pipeTo(ws, { signal: abortController.signal }).then(function () {
        result.pipeAbort = "done:chunks=" + collected.length + ":transforms=" + transformCount;
      }).catch(function (e) {
        result.pipeAbort = "err:" + e.constructor.name + ":chunks=" + collected.length + ":transforms=" + transformCount;
      });
    } catch (e) {
      result.pipeAbort = "setupErr:" + e.constructor.name;
    }

    // Test B: Multiple enqueue in single transform call
    try {
      var ts2 = new TransformStream({
        transform: function (chunk, controller) {
          for (var m = 0; m < 1000; m++) controller.enqueue(chunk);
        }
      });

      var writer2 = ts2.writable.getWriter();
      writer2.write("x");
      writer2.close();

      var readCount = 0;
      var reader2 = ts2.readable.getReader();
      function pumpB() {
        reader2.read().then(function (r) {
          if (r.done) {
            result.multiEnqueue = "done:read=" + readCount;
            return;
          }
          readCount++;
          if (readCount > 1100) {
            reader2.cancel();
            result.multiEnqueue = "cancelled:read=" + readCount;
            return;
          }
          pumpB();
        }).catch(function (e) {
          result.multiEnqueue = "readErr:" + e.constructor.name + ":read=" + readCount;
        });
      }
      pumpB();
    } catch (e) {
      result.multiEnqueue = "setupErr:" + e.constructor.name;
    }

    // Test C: Enqueue after terminate
    try {
      var stolenCtrl = null;
      var ts3 = new TransformStream({
        start: function (controller) { stolenCtrl = controller; },
        transform: function () {}
      });

      if (stolenCtrl) {
        stolenCtrl.terminate();
        var r1 = tryCall(function () {
          stolenCtrl.enqueue("after_terminate");
          return "OK";
        });
        result.enqueueAfterTerm = r1.e ? r1.e : r1.v;

        var r2 = tryCall(function () {
          stolenCtrl.error(new Error("after_terminate"));
          return "OK";
        });
        result.errorAfterTerm = r2.e ? r2.e : r2.v;
      }
    } catch (e) {
      result.terminateTest = "setupErr:" + e.constructor.name;
    }

    setTimeout(function () { beacon("S8-TSPIPE", result); }, 3000);
  }

  // ================================================================
  // S9: TransformStream — re-entrant callbacks during transform
  // Can we trigger GC or state changes during a transform callback?
  // ================================================================
  function S9_TS_REENTRANT() {
    var result = {};

    // Test A: Create new TransformStream during transform callback
    try {
      var innerCreated = 0;
      var ts = new TransformStream({
        transform: function (chunk, controller) {
          var inner = new TransformStream();
          innerCreated++;
          controller.enqueue(chunk);
        }
      });

      var writer = ts.writable.getWriter();
      for (var i = 0; i < 100; i++) writer.write("x");
      writer.close();

      var outCount = 0;
      var reader = ts.readable.getReader();
      function pump() {
        reader.read().then(function (r) {
          if (r.done) {
            result.innerCreate = "done:inner=" + innerCreated + ":out=" + outCount;
            return;
          }
          outCount++;
          pump();
        }).catch(function (e) {
          result.innerCreate = "err:" + e.constructor.name + ":inner=" + innerCreated;
        });
      }
      pump();
    } catch (e) {
      result.innerCreate = "setupErr:" + e.constructor.name;
    }

    // Test B: Transfer ArrayBuffer during transform
    try {
      var transferLog = [];
      var ts2 = new TransformStream({
        transform: function (chunk, controller) {
          var buf = new ArrayBuffer(4096);
          var view = new Uint8Array(buf);
          view[0] = 0xDE;
          view[1] = 0xAD;

          var ch = new MessageChannel();
          ch.port1.postMessage(null, [buf]);
          transferLog.push(buf.byteLength);

          controller.enqueue(view[0]);
        }
      });

      var writer2 = ts2.writable.getWriter();
      for (var j = 0; j < 20; j++) writer2.write(j);
      writer2.close();

      var readCount2 = 0;
      var reader2 = ts2.readable.getReader();
      function pump2() {
        reader2.read().then(function (r) {
          if (r.done) {
            result.bufTransfer = "done:transfers=" + transferLog.length +
              ":detached=" + transferLog.filter(function(x) { return x === 0; }).length;
            return;
          }
          readCount2++;
          pump2();
        }).catch(function (e) {
          result.bufTransfer = "err:" + e.constructor.name;
        });
      }
      pump2();
    } catch (e) {
      result.bufTransfer = "setupErr:" + e.constructor.name;
    }

    // Test C: structuredClone with transfer during transform
    try {
      var cloneLog = [];
      var ts3 = new TransformStream({
        transform: function (chunk, controller) {
          var buf = new ArrayBuffer(256);
          var cloned = structuredClone(buf, { transfer: [buf] });
          cloneLog.push("orig=" + buf.byteLength + ":clone=" + cloned.byteLength);
          controller.enqueue(cloned.byteLength);
        }
      });

      var writer3 = ts3.writable.getWriter();
      for (var k = 0; k < 10; k++) writer3.write(k);
      writer3.close();

      setTimeout(function () {
        result.cloneTransfer = "done:ops=" + cloneLog.length;
        if (cloneLog.length > 0) result.cloneSample = cloneLog[0];
      }, 1000);
    } catch (e) {
      result.cloneTransfer = "setupErr:" + e.constructor.name;
    }

    setTimeout(function () { beacon("S9-TSREENTER", result); }, 4000);
  }

  // ================================================================
  // S10: Regex engine — deep surrogate and capture group probing
  // Focus on the namedSurrogate: no_match finding from p118
  // ================================================================
  function S10_REGEX_DEEP() {
    var result = {};

    // Test A: Named capture with emoji — does it work at all?
    var r1 = tryCall(function () {
      var m = "hello 🐀 world".match(/(?<emoji>🐀)/u);
      return m ? "match:groups=" + JSON.stringify(m.groups) : "no_match";
    });
    result.namedEmoji = r1.e ? r1.e : r1.v;

    // Test B: Named capture with lone surrogate in pattern
    var r2 = tryCall(function () {
      var re = new RegExp("(?<s>\\ud83d[\\udc00-\\udfff])", "u");
      var m = "🐀".match(re);
      return m ? "match:len=" + m[1].length + ":cp=" + m[1].codePointAt(0) : "no_match";
    });
    result.namedSurrPair = r2.e ? r2.e : r2.v;

    // Test C: Match indices with surrogates (if supported)
    var r3 = tryCall(function () {
      var re = /(?<emoji>🐀)/du;
      var m = "ab🐀cd".match(re);
      if (!m || !m.indices) return "no_indices";
      return "idx=" + JSON.stringify(m.indices.groups);
    });
    result.matchIndices = r3.e ? r3.e : r3.v;

    // Test D: String.prototype.matchAll with surrogates
    var r4 = tryCall(function () {
      var re = /[\ud800-\udfff]/gu;
      var str = "𐀀🐀\ud800";
      var matches = [];
      for (var m of str.matchAll(re)) {
        matches.push("idx=" + m.index + ":val=" + m[0].codePointAt(0).toString(16));
      }
      return "found=" + matches.length + ":" + matches.join("|");
    });
    result.matchAllSurr = r4.e ? r4.e : r4.v;

    // Test E: Replace with callback — check index values for surrogate strings
    var r5 = tryCall(function () {
      var indices = [];
      "🐀x🐁y🐂".replace(/./gu, function (m, idx) {
        indices.push(idx + ":" + m.codePointAt(0).toString(16));
        return m;
      });
      return indices.join("|");
    });
    result.replaceIndices = r5.e ? r5.e : r5.v;

    // Test F: RegExp.prototype[Symbol.split] with surrogate boundary
    var r6 = tryCall(function () {
      var parts = "a𐀀b🐀c".split(/[\ud800-\udbff]/u);
      return "parts=" + parts.length + ":" + parts.map(function(p) { return p.length; }).join(",");
    });
    result.splitSurrBoundary = r6.e ? r6.e : r6.v;

    // Test G: Catastrophic backtracking with surrogate quantifiers
    var r7 = tryCall(function () {
      var t0 = performance.now();
      var re = /(\ud83d[\udc00-\udfff])+$/u;
      var input = "🐀".repeat(1000) + "x";
      var matched = re.test(input);
      var elapsed = performance.now() - t0;
      return "time=" + Math.round(elapsed) + "ms:match=" + matched;
    });
    result.surrBacktrack = r7.e ? r7.e : r7.v;

    // Test H: Very large capture group count with surrogates
    var r8 = tryCall(function () {
      var pattern = "";
      for (var i = 0; i < 50; i++) pattern += "(.)";
      pattern += "\\50";
      var re = new RegExp(pattern, "u");
      var input = "🐀".repeat(25) + "🐀".repeat(25);
      return re.test(input.slice(0, 51)) ? "match" : "no_match";
    });
    result.manyCaptures = r8.e ? r8.e : r8.v;

    beacon("S10-REGEXDEEP", result);
  }

  // ================================================================
  // S11: ReadableStream BYOB / Byte source controller
  // p118 R9 showed ReadableStreamBYOBReader: false
  // But ReadableByteStreamController: false — test if we can force it
  // ================================================================
  function S11_RS_BYOB() {
    var result = {};

    // Test A: Try to create a byte stream (type: "bytes")
    var r1 = tryCall(function () {
      var rs = new ReadableStream({
        type: "bytes",
        start: function (controller) {
          result.byteCtrlType = controller.constructor.name;
          var view = new Uint8Array(new ArrayBuffer(10));
          view[0] = 42;
          controller.enqueue(view);
          controller.close();
        }
      });
      return "created";
    });
    result.byteStream = r1.e ? r1.e : r1.v;

    // Test B: ReadableStream with pull that returns detached buffer
    var r2 = tryCall(function () {
      var pullCount = 0;
      var rs = new ReadableStream({
        pull: function (controller) {
          pullCount++;
          var buf = new ArrayBuffer(256);
          var view = new Uint8Array(buf);
          view.fill(0x41);

          var ch = new MessageChannel();
          ch.port1.postMessage(null, [buf]);

          try {
            controller.enqueue(view);
            return "enqueued_detached";
          } catch (e) {
            controller.close();
            return "threw:" + e.constructor.name;
          }
        }
      });

      var reader = rs.getReader();
      return reader.read().then(function (r) {
        return "read:" + (r.done ? "done" : "data:" + r.value.length) + ":pulls=" + pullCount;
      }).catch(function (e) {
        return "readErr:" + e.constructor.name + ":" + e.message.slice(0, 60) + ":pulls=" + pullCount;
      });
    });
    if (r2.e) {
      result.detachedPull = r2.e;
    } else if (r2.v && r2.v.then) {
      r2.v.then(function (v) { result.detachedPull = v; });
    } else {
      result.detachedPull = String(r2.v);
    }

    // Test C: WritableStream with detached buffer in write
    var r3 = tryCall(function () {
      var ws = new WritableStream({
        write: function (chunk) {
          result.writeChunkType = typeof chunk;
          if (chunk instanceof ArrayBuffer) {
            result.writeChunkLen = chunk.byteLength;
          }
        }
      });

      var writer = ws.getWriter();
      var buf = new ArrayBuffer(256);
      var ch = new MessageChannel();
      ch.port1.postMessage(null, [buf]);

      return writer.write(buf).then(function () {
        return "wrote_detached:len=" + buf.byteLength;
      }).catch(function (e) {
        return "writeErr:" + e.constructor.name;
      });
    });
    if (r3.e) result.detachedWrite = r3.e;
    else if (r3.v && r3.v.then) r3.v.then(function (v) { result.detachedWrite = v; });
    else result.detachedWrite = String(r3.v);

    setTimeout(function () { beacon("S11-BYOB", result); }, 2000);
  }

  // ================================================================
  // S12: Image decoder via Canvas — serve malformed images from HTTP
  // Test if we can trigger bugs in image decoders by drawing to canvas
  // ================================================================
  function S12_IMAGE_DECODE() {
    var result = {};

    // Test A: What image formats are supported?
    var canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    var ctx = canvas.getContext("2d");

    if (!ctx) {
      result.canvasErr = "no_2d_context";
      beacon("S12-IMGDECODE", result);
      return;
    }

    result.canvas2d = "OK";

    // Test B: toDataURL format support
    var formats = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"];
    formats.forEach(function (fmt) {
      try {
        var url = canvas.toDataURL(fmt);
        result["fmt_" + fmt.split("/")[1]] = url.startsWith("data:" + fmt) ? "native" : "fallback:" + url.slice(5, 30);
      } catch (e) {
        result["fmt_" + fmt.split("/")[1]] = "err:" + e.constructor.name;
      }
    });

    // Test C: createImageBitmap support
    result.hasCreateImageBitmap = typeof createImageBitmap === "function";

    // Test D: Try loading crafted 1-pixel images with malformed headers
    // Create a minimal valid PNG, then corrupt specific bytes
    var validPNG = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x36, 0x28, 0x19,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82
    ]);

    // Corrupt width to massive value
    var badWidth = new Uint8Array(validPNG);
    badWidth[16] = 0x7F; badWidth[17] = 0xFF; badWidth[18] = 0xFF; badWidth[19] = 0xFF;

    // Corrupt height to massive value
    var badHeight = new Uint8Array(validPNG);
    badHeight[20] = 0x7F; badHeight[21] = 0xFF; badHeight[22] = 0xFF; badHeight[23] = 0xFF;

    // Corrupt bit depth
    var badDepth = new Uint8Array(validPNG);
    badDepth[24] = 0x20;

    // Corrupt color type
    var badColor = new Uint8Array(validPNG);
    badColor[25] = 0x07;

    var imgTests = [
      { name: "validPNG", data: validPNG },
      { name: "badWidth", data: badWidth },
      { name: "badHeight", data: badHeight },
      { name: "badDepth", data: badDepth },
      { name: "badColor", data: badColor },
    ];

    var pending = imgTests.length;
    imgTests.forEach(function (test) {
      var blob = new Blob([test.data], { type: "image/png" });
      var url = URL.createObjectURL(blob);
      var img = new Image();

      img.onload = function () {
        result["img_" + test.name] = "loaded:" + img.width + "x" + img.height;
        try {
          ctx.drawImage(img, 0, 0);
          result["draw_" + test.name] = "OK";
        } catch (e) {
          result["draw_" + test.name] = e.constructor.name;
        }
        URL.revokeObjectURL(url);
        pending--;
        if (pending === 0) beacon("S12-IMGDECODE", result);
      };
      img.onerror = function () {
        result["img_" + test.name] = "error";
        URL.revokeObjectURL(url);
        pending--;
        if (pending === 0) beacon("S12-IMGDECODE", result);
      };
      img.src = url;
    });

    setTimeout(function () {
      if (pending > 0) {
        result.timeout = "pending=" + pending;
        beacon("S12-IMGDECODE", result);
      }
    }, 5000);
  }

  schedule([
    S1_TS_COUNT,
    S2_TS_TYPECONFUSE,
    S3_TS_PROTOHOOK,
    S4_TS_GETTER,
    S5_COMPRESSION,
    S6_DECOMP_EDGE,
    S7_TEXTDECODER,
    S8_TS_PIPE,
    S9_TS_REENTRANT,
    S10_REGEX_DEEP,
    S11_RS_BYOB,
    S12_IMAGE_DECODE,
  ]);
})();
