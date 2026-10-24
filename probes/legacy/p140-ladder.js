// p140 — freeze-pinning ladder: param calls at 4M/6M/8M/10M, sequential, page heartbeats forever.
// Build from p139 lessons:
//   - NO body-level instrument hooks (p139 bug: self.__v139b never defined -> body aborted at stmt 1)
//   - CB1 done RIGHT: self.a is defined as a function BEFORE the call; first site execution posts CB1
//   - every worker IIFE-wrapped, no bare top-level returns (p135 lesson)
//   - channel split kept: page=sendBeacon(A), worker=fetch(B) (Astra's review)
//   - 30s quiet proven; ladder starts immediately and runs 4/6/8/10M sequentially (10s pacing)
// Expected outcomes: freeze somewhere; CB1 missing + heartbeat dies at CALLA = pre-first-site freeze.
// Beacon prefix: V140Q-
(function(){
var rid='v140q'+Math.random().toString(36).slice(2,12);
var T0=Date.now();
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V140Q-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
}
var hbN=0;
setInterval(function(){ hbN++; beacon('HB',{n:hbN,ms:Date.now()-T0}); },2000);
beacon('L','ladder140: 4M,6M,8M,10M param sequential');

function mkWorker(){
  var L=[];
  L.push('(function(){');
  L.push('var T0=Date.now(),PH="boot",built=false;');
  L.push('function wb(t,d){try{self.postMessage({t:t,d:d,ph:PH,ms:Date.now()-T0});}catch(e){}}');
  L.push('function wf(t,d){try{fetch("/beacon/V140Q-W/"+t,{method:"POST",body:JSON.stringify({ph:PH,w:Date.now(),d:d})}).catch(function(){});}catch(e){}}');
  L.push('function ev(t,d){wb(t,d);wf(t,d);}');
  L.push('self.onmessage=function(e){if(e&&e.data&&e.data.g==="build"){build();}};');
  L.push('function build(){');
  L.push('  if(built)return;built=true;PH="fill";');
  L.push('  var N=GNUM,PARAM=true,t=Date.now();');
  L.push('  var buf=new Uint8Array(N*4);');
  L.push('  for(var i=0;i<buf.length;i+=4){buf[i]=97;buf[i+1]=40;buf[i+2]=41;buf[i+3]=59;}');
  L.push('  var fillMs=Date.now()-t;ev("FILL",{b:buf.length,ms:fillMs,pre:0});');
  L.push('  PH="str";t=Date.now();');
  L.push('  var src=new TextDecoder().decode(buf);buf=null;');
  L.push('  ev("STR",{len:src.length,ms:Date.now()-t});');
  L.push('  PH="cmp";t=Date.now();var fn;');
  L.push('  try{fn=new Function("a",src);}catch(e){ev("ERR",{w:"cmp",e:String(e&&e.message||e).slice(0,80)});return;}');
  L.push('  ev("CMP",{ms:Date.now()-t,n:N});');
  L.push('  PH="call";ev("CALLA",{n:N});var tA=Date.now(),cc=0,f=1;');
  L.push('  self.a=function(){if(f){f=0;ev("CB1",{ms:Date.now()-tA});}cc++;if(cc>=3)throw new Error("PSTOP");};');
  L.push('  try{fn(self.a);ev("RETA",{cc:cc,ms:Date.now()-tA});}');
  L.push('  catch(e){if(e&&e.message==="PSTOP"){ev("STOPA",{cc:cc,ms:Date.now()-tA});}else{ev("ERR",{w:"call",e:String(e&&e.message||e).slice(0,80),cc:cc});}}');
  L.push('  ev("DONE",{n:N,cc:cc,callMs:Date.now()-tA,fillMs:fillMs});');
  L.push('  setTimeout(function(){self.close();},250);');
  L.push('}');
  L.push('var wt=setTimeout(function(){ev("WTO",{ph:PH,ms:Date.now()-T0,built:built});},40000);');
  L.push('setTimeout(function(){if(!built)build();},200);');
  L.push('})();');
  return L.join('\n');
}
// NOTE: worker body uses GNUM global injected below via blob prelude; avoids template substitution pitfalls.
function spawnP(n){
  // GNUM injected as a front var before the IIFE (avoids template-substitution pitfalls inside the body)
  var workerSrc='var GNUM='+n+';\n'+mkWorker();
  try{
    var url=URL.createObjectURL(new Blob([workerSrc],{type:'application/javascript'}));
    var w=new Worker(url);
    w.onerror=function(e){ beacon(n+'-ONERR',{msg:e&&e.message?String(e.message).slice(0,90):'?',line:e&&e.lineno}); };
    w.onmessage=function(e){ var d=e.data||{}; beacon(n+'-'+(d.t||'?'),{ph:d.ph,ms:d.ms,d:d.d}); if(d.t==='DONE'){try{w.terminate();}catch(x){} URL.revokeObjectURL(url);} };
    beacon(n+'-SPAWN',{n:n,at:Date.now()-T0});
    w.postMessage({g:'build'});
  }catch(e){ beacon(n+'-SETUP-ERR',{e:String(e&&e.message||e).slice(0,90)}); }
}

setTimeout(function(){beacon('Q4-ARM',{ms:Date.now()-T0});},500);
setTimeout(function(){spawnP(4000000);},3000);
setTimeout(function(){spawnP(6000000);},13000);
setTimeout(function(){spawnP(8000000);},23000);
setTimeout(function(){spawnP(10000000);},33000);
setTimeout(function(){beacon('LAD-END',{ms:Date.now()-T0,note:'all spawns scheduled; heartbeats continue'});},45000);
})();
