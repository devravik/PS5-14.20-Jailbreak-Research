// p138 — CALL-TIME metadata ladder, worker-isolated.  Beacon prefix: V138C-
// (worker-direct copies: V138C-W-<TAG>-<TAG>)
//
// THEORY. p136-B2 compiled `function(a){a();a();...}` (30M sites, 120MB, script tag, MAIN thread),
// then called it with a callback that throws on the 3rd call. B2-CALLING fired, then TOTAL SILENCE
// for 390s+, twice, deterministically. Because that callback aborts at call site #3, the wedge CANNOT
// be "iterating 30M call sites": it is in the FIRST-CALL PROLOGUE - CodeBlock::create / link /
// MetadataTable sizing - before the third `a();` retires (or in sites 1-3 themselves).
//
// p138 isolates that prologue in WORKERS (the page never builds the big string, so it stays light and
// keeps beaconing), and ladders N and form so the byte cost is bracketed:
//   P10M   param,    10M sites   control. Must pass. Yields ns/site for the body walk.
//   P22M5  param,  22.5M sites   knife edge: 22.5M*96B = 2.16GB, just ABOVE 2^31 (2.147GB), below 2^32.
//   F22M5  free-var,22.5M sites  22.5M*215B = 4.84GB, 13% ABOVE 2^32 (4.295GB) => must fail if model holds.
//   F25M   free-var, 25M sites   5.38GB modeled (25% past 2^32).
//   F27M   free-var, 27M sites   5.81GB modeled (35% past 2^32).
//
// DISCRIMINATOR. Each worker beacons BODY (first statement *inside* the generated function: bytecode
// entered) and CB1 (first statement of the callback: call site #1 retired). BODY without CB1 = wedge
// inside the call instruction / scope lookup. Neither = wedge in CodeBlock create/link. Both + RETB =
// call machinery healthy at that N, so p136 is N-specific or main-thread-specific. A main-page
// HEARTBEAT every 2s answers the question p136 could not: is the event loop alive?
//
// LAYOUT. Workers are spawned 3s apart, as specified, but build+call is paced through a single slot:
// five concurrent 90-108MB source strings (~500MB retained) would confound the very cap we measure.
// Pacing keeps ambient at ~one worker, so 2.16GB means 2.16GB. Every test still beacons its own result.
// TOTAL RUN: FINAL at t+210s, CUTOFF at t+235s (< 4 min).
(function(){
var rid='v138c'+Math.random().toString(36).slice(2,12);
var T0=Date.now();
var LAD=[
  {tag:'P10M', n:10000000, param:true,  budget:15000},
  {tag:'P22M5',n:22500000, param:true,  budget:32000},
  {tag:'F22M5',n:22500000, param:false, budget:32000},
  {tag:'F25M', n:25000000, param:false, budget:35000},
  {tag:'F27M', n:27000000, param:false, budget:38000}
];
for(var i=0;i<LAD.length;i++){
  var t=LAD[i];
  t.i=i; t.ph='-'; t.last='-';
  t.spawned=false; t.need=false; t.ready=false; t.called=false; t.done=false; t.dead=false;
}
var slot=-1, slotStage='', hb=0;
function en(e){try{return (e&&e.constructor?e.constructor.name:'?')+':'+String((e&&e.message)||e).slice(0,120);}catch(x){return '?';}}
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V138C-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V138C-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
function snap(){
  var s=[];
  for(var k=0;k<LAD.length;k++){
    var t=LAD[k];
    s.push(t.tag+'='+(t.dead?'X':t.done?'D':t.called?'C':t.ready?'R':t.spawned?'s':'-')+t.last);
  }
  return s.join(' ');
}
beacon('L','p138-start');
beacon('PLAN','P10M=0.96GB@96B | P22M5=2.16GB@96B | F22M5=4.84GB@215B | F25M=5.38GB | F27M=5.81GB | caps 2^31=2.147GB 2^32=4.295GB | p136 P30M=2.88GB');
setInterval(function(){
  hb++;
  beacon('HB',{ms:Date.now()-T0,hb:hb,v:(document.visibilityState||'?'),slot:slot,stg:slotStage,cur:slot>=0?LAD[slot].tag:'-',st:snap()});
},2000);

// ======== worker source template ========
// The whole worker body is one IIFE. No bare top-level `return` anywhere (p135 lesson: a top-level
// return is a SyntaxError and silently voided every call test). `return` appears only inside build().
function mkSrc(t){
  var L=[];
  L.push('(function(){');
  L.push('var RID="'+rid+'",TAG="'+t.tag+'",N='+t.n+',PARAM='+t.param+',STOPA=3,BUDGET='+t.budget+',AUTOB='+(60000+t.i*15000)+';');
  L.push('var T0=Date.now(),PH="boot",built=false,started=false,bodyMs=-1,stopAMs=-1,fillMs=0,strMs=0,compMs=0,wt=0,cto=0;');
  L.push('function en(e){try{return (e&&e.constructor?e.constructor.name:"?")+":"+String((e&&e.message)||e).slice(0,120);}catch(x){return "?";}}');
  L.push('function wb(tag,d){try{self.postMessage({t:tag,d:d,ph:PH,ms:Date.now()-T0});}catch(e){}}');
  L.push('function wf(tag,d){try{fetch("/beacon/V138C-W-"+TAG+"-"+tag,{method:"POST",body:JSON.stringify({r:RID,tag:TAG,ph:PH,w:Date.now(),d:d}),keepalive:true}).catch(function(){});}catch(e){}}');
  L.push('function ev(tag,d){wb(tag,d);wf(tag,d);}');
  L.push('self.__v138b=function(k){var d=Date.now()-self.__v138T;if(PH==="callA")bodyMs=d;ev("BODY",{k:k,ms:d});};');
  L.push('function build(){');
  L.push('  if(built)return;built=true;PH="fill";');
  L.push('  var PRE="self.__v138b(0);",len=PRE.length+N*4,t=Date.now();');
  L.push('  var buf=new Uint8Array(len);');
  L.push('  for(var j=0;j<PRE.length;j++)buf[j]=PRE.charCodeAt(j);');
  L.push('  for(var i=PRE.length;i<len;i+=4){buf[i]=97;buf[i+1]=40;buf[i+2]=41;buf[i+3]=59;}');
  L.push('  fillMs=Date.now()-t;ev("FILL",{b:len,ms:fillMs,pre:PRE.length});');
  L.push('  PH="str";t=Date.now();');
  L.push('  var src=new TextDecoder().decode(buf);buf=null;');
  L.push('  strMs=Date.now()-t;ev("STR",{len:src.length,ms:strMs});');
  L.push('  PH="cmp";t=Date.now();');
  L.push('  var fn;');
  L.push('  try{fn=PARAM?new Function("a",src):new Function(src);}');
  L.push('  catch(e){ev("ERR",{w:"cmp",e:en(e),n:N,param:PARAM});setTimeout(function(){self.close();},400);return;}');
  L.push('  compMs=Date.now()-t;src=null;');
  L.push('  ev("CMP",{ms:compMs,n:N,param:PARAM,fillMs:fillMs,strMs:strMs});');
  L.push('  PH="gate";ev("GATE",{n:N,param:PARAM});');
  L.push('  self.onmessage=function(e){if(e&&e.data&&e.data.g==="go"&&!started){started=true;run(fn);}};');
  L.push('  setTimeout(function(){if(!started){started=true;ev("AUTOGO",{});run(fn);}},30000);');
  L.push('}');
  L.push('function run(fn){');
  L.push('  var tA=Date.now();self.__v138T=tA;PH="callA";bodyMs=-1;');
  L.push('  cto=setTimeout(function(){ev("WTO",{ph:PH,ms:Date.now()-T0,since:Date.now()-tA});},BUDGET-4000);');
  L.push('  var ccA=0,fA=1,okA=true;');
  L.push('  self.a=function(){if(fA){fA=0;ev("CB1",{site:1,ms:Date.now()-tA});}ccA++;if(ccA>=STOPA)throw new Error("PSTOPA");};');
  L.push('  ev("CALLA",{n:N,param:PARAM});');
  L.push('  try{if(PARAM)fn(self.a);else fn();}');
  L.push('  catch(e){if(e&&e.message==="PSTOPA"){stopAMs=Date.now()-tA;ev("STOPA",{cc:ccA,ms:stopAMs});}else{okA=false;ev("ERR",{w:"callA",e:en(e),cc:ccA,ms:Date.now()-tA});}}');
  L.push('  if(!okA){PH="done";ev("DONE",{n:N,param:PARAM,skipB:1,ccA:ccA,bodyA:bodyMs,stopA:stopAMs,fillMs:fillMs,strMs:strMs,compMs:compMs});clearTimeout(wt);clearTimeout(cto);setTimeout(function(){self.close();},400);return;}');
  L.push('  PH="callB";var tB=Date.now();self.__v138T=tB;');
  L.push('  var ccB=0,fB=1,MS=[1000000,5000000,10000000,15000000,20000000,25000000],mi=0;');
  L.push('  self.a=function(){if(fB){fB=0;ev("CB1B",{ms:Date.now()-tB});}ccB++;if(mi<MS.length&&ccB===MS[mi]){var m=MS[mi];mi++;ev("CBP",{cc:ccB,m:m,ms:Date.now()-tB});}};');
  L.push('  ev("CALLB",{n:N});');
  L.push('  try{if(PARAM)fn(self.a);else fn();ev("RETB",{cc:ccB,ms:Date.now()-tB,ns:Math.round((Date.now()-tB)*1e6/(ccB||1))});}');
  L.push('  catch(e2){ev("ERR",{w:"callB",e:en(e2),cc:ccB,ms:Date.now()-tB});}');
  L.push('  PH="done";');
  L.push('  ev("DONE",{n:N,param:PARAM,ccA:ccA,bodyA:bodyMs,stopA:stopAMs,ccB:ccB,walk:Date.now()-tB,fillMs:fillMs,strMs:strMs,compMs:compMs});');
  L.push('  clearTimeout(wt);clearTimeout(cto);');
  L.push('  setTimeout(function(){self.close();},400);');
  L.push('}');
  L.push('wt=setTimeout(function(){ev("WTO",{ph:PH,ms:Date.now()-T0,built:built});},170000);');
  L.push('setTimeout(function(){if(!built&&!started){ev("AUTOB",{});build();}},AUTOB);');
  L.push('self.onmessage=function(e){if(e&&e.data&&e.data.g==="build"){build();}};');
  L.push('ev("NEED",{n:N,param:PARAM});');
  L.push('})();');
  return L.join('\n');
}

// ======== main-side scheduler: one build+call slot at a time ========
function rel(i){
  var t=LAD[i];
  clearTimeout(t.bwd); clearTimeout(t.wd);
  try{if(t.w){t.w.terminate();}}catch(e){}
  try{if(t.url)URL.revokeObjectURL(t.url);}catch(e){}
}
function freeSlot(i){
  if(slot===i){slot=-1;slotStage='';}
  setTimeout(pump,1200);
}
function fail(i,why){
  var t=LAD[i];
  if(t.done||t.dead)return;
  t.dead=true;
  beacon(t.tag+'-FAIL',{why:why,last:t.last,ms:Date.now()-(t.spawnAt||T0)});
  rel(i); freeSlot(i);
}
function onW(i,d){
  var t=LAD[i];
  if(!d||!d.t)return;
  t.last=d.t; t.ph=d.ph;
  if(d.t==='NEED')t.need=true;
  if(d.t==='GATE'){t.ready=true;t.readyAt=Date.now();}
  beacon(t.tag+'-'+d.t,{w:d.ms,ph:d.ph,r:Date.now()-T0,d:d.d});
  if(slot===i&&slotStage==='build'){
    if(d.t==='GATE'){clearTimeout(t.bwd);goCall(i);}
    else if(d.t==='ERR'){fail(i,'build-err');}
  }else if(slot===i&&slotStage==='call'){
    if(d.t==='DONE'){
      t.done=true;
      beacon(t.tag+'-FIN',{total:Date.now()-(t.spawnAt||T0)});
      rel(i); freeSlot(i);
    }
  }
}
function grantBuild(i){
  var t=LAD[i];
  slot=i; slotStage='build';
  beacon(t.tag+'-BUILD',{n:t.n,param:t.param,srcB:t.n*4+16});
  try{t.w.postMessage({g:'build'});}catch(e){fail(i,'bfail');return;}
  t.bwd=setTimeout(function(){beacon(t.tag+'-BWD',{ms:45000,last:t.last});fail(i,'build-wd');},45000);
}
function goCall(i){
  var t=LAD[i];
  slot=i; slotStage='call'; t.called=true; t.callT=Date.now();
  beacon(t.tag+'-GO',{n:t.n,param:t.param,gb96:Math.round(t.n*96/1e7)/100});
  try{t.w.postMessage({g:'go'});}catch(e){fail(i,'gofail');return;}
  t.wd=setTimeout(function(){onWD(i);},t.budget);
}
function onWD(i){
  var t=LAD[i];
  if(t.done||t.dead)return;
  beacon(t.tag+'-MWD',{ms:Date.now()-t.callT,last:t.last,ph:t.ph,n:t.n,param:t.param,hb:hb});
  // A hard-wedged worker must NOT be terminate()'d: WebKit's Worker::terminate() can wait for the
  // worker run loop, i.e. block the PAGE. Only reclaim if the worker's own timer ran (last=WTO),
  // which proves its thread is between tasks. Otherwise abandon it and keep the page alive.
  if(t.last==='WTO'){
    beacon(t.tag+'-KILL',{});
    try{t.w.terminate();}catch(e){}
    beacon(t.tag+'-KILLED',{});
  }else{
    beacon(t.tag+'-ABANDON',{why:'no-worker-WTO'});
  }
  t.dead=true;
  clearTimeout(t.bwd); clearTimeout(t.wd);
  try{if(t.url)URL.revokeObjectURL(t.url);}catch(e){}
  freeSlot(i);
}
function pump(){
  if(slot>=0)return;
  for(var k=0;k<LAD.length;k++){
    var t=LAD[k];
    if(t.dead||t.done||t.called||t.ready)continue;
    if(t.need){grantBuild(k);return;}
    if(t.spawned&&Date.now()-(t.spawnAt||T0)>45000){
      t.dead=true;
      beacon(t.tag+'-NONEED',{ms:Date.now()-T0});
      return;
    }
  }
}
function spawnTest(i){
  var t=LAD[i];
  if(t.spawned)return;
  t.spawned=true; t.spawnAt=Date.now(); t.ph='spawn';
  try{
    var blob=new Blob([mkSrc(t)],{type:'application/javascript'});
    t.url=URL.createObjectURL(blob);
    t.w=new Worker(t.url);
    t.w.onmessage=function(e){try{onW(i,e.data);}catch(x){beacon(t.tag+'-HERR',en(x));}};
    t.w.onerror=function(e){
      if(t.done||t.dead)return;
      beacon(t.tag+'-WERR',{m:(e&&e.message)?String(e.message).slice(0,160):'unknown',l:e?e.lineno:0});
      t.dead=true;
      if(slot===i){slot=-1;slotStage='';}
      setTimeout(pump,800);
    };
    beacon(t.tag+'-SPAWN',{n:t.n,param:t.param,at:Date.now()-T0});
  }catch(e){t.dead=true;beacon(t.tag+'-SPAWNERR',en(e));}
}

// ======== boot: 3s spacing, per spec ========
for(var s=0;s<LAD.length;s++){(function(k){setTimeout(function(){spawnTest(k);},k*3000);})(s);}
setInterval(pump,700);
setTimeout(function(){beacon('FINAL',{ms:Date.now()-T0,hb:hb,st:snap(),slot:slot});},210000);
setTimeout(function(){beacon('CUTOFF',{ms:Date.now()-T0,hb:hb,st:snap()});},235000);
try{addEventListener('pagehide',function(){beacon('BYE',{ms:Date.now()-T0,hb:hb,st:snap()});});}catch(e){}
})();
