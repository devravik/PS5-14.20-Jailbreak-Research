// p130 — Fine-grained MetadataTable overflow bracketing
// p124 R6: 20M compiles OK (~7s). p129: 22M crashes (no result beacon).
// This probe brackets 20M-22M in 500K steps to find exact threshold.
// Each step: build string → beacon → compile → beacon → test call → beacon
// More defensive beaconing to identify crash point precisely.
// Beacon prefix: V130B-
(function(){
var rid='v130b'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V130B-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V130B-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe130-start');

function gcFlush(){
  for(var g=0;g<20;g++){var t=new ArrayBuffer(4194304);t=null;}
}

var tests=[
  {name:'B1-20500K',n:20500000},
  {name:'B2-21000K',n:21000000},
  {name:'B3-21250K',n:21250000},
  {name:'B4-21500K',n:21500000},
  {name:'B5-21750K',n:21750000},
  {name:'B6-22000K',n:22000000}
];

async function runAll(){
  for(var t=0;t<tests.length;t++){
    var test=tests[t];
    var r={n:test.n,bytes:test.n*4};
    beacon(test.name+'-PRE','attempt-'+test.n);

    var t0=Date.now();
    try{
      // Step 1: Build string
      beacon(test.name+'-STR','building');
      var src='a();'.repeat(test.n);
      r.srcLen=src.length;
      r.srcTime=Date.now()-t0;
      beacon(test.name+'-STR-OK','len='+src.length+',ms='+(Date.now()-t0));

      // Step 2: Compile
      beacon(test.name+'-CMP','compiling');
      var t1=Date.now();
      try{
        var fn=new Function('a',src);
        r.compileTime=Date.now()-t1;
        r.compiled=true;
        beacon(test.name+'-CMP-OK','ms='+r.compileTime);

        // Step 3: Try calling — detect corrupted bytecode
        beacon(test.name+'-CALL','calling');
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
        beacon(test.name+'-CALL-OK','cc='+callCount+',ok='+r.callsOK+',err='+(r.callErr||'none'));
        fn=null;
      }catch(e){
        r.compileTime=Date.now()-t1;
        r.compileErr=e.constructor.name+':'+String(e.message||'').slice(0,100);
        beacon(test.name+'-CMP-ERR',r.compileErr);
      }
      src=null;
    }catch(e){
      r.srcErr=e.constructor.name+':'+String(e.message||'').slice(0,100);
      beacon(test.name+'-STR-ERR',r.srcErr);
    }
    r.totalTime=Date.now()-t0;
    beacon(test.name,r);

    // GC between tests + pause
    gcFlush();
    await new Promise(function(resolve){setTimeout(resolve,5000);});
    gcFlush();
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
