// p139-noop — CONTROL: is the telemetry pipe / tab healthy, and is the CB1 machinery sound?
// Answers two questions with ONE press:
//   Q1: do 2s heartbeats stream FOREVER when nothing else runs? (previous runs died at hb#2 = 4s)
//   Q2: does the mini-ladder (2M param call) complete CB1 -> STOPA -> DONE end-to-end?
// Design notes vs p138:
//   - ALL beacons via navigator.sendBeacon ONLY (no keepalive fetch) -> kills the shared-pool
//     theory cleanly: if heartbeats still freeze, the freeze is not the fetch-keepalive pipe.
//   - Spawns NOTHING for the first 30s: heartbeats alone must survive past hb#15 to prove the
//     pipe + tab are healthy in this very browser.
//   - At +30s: spawn ONE 2M param worker (2M*96B = 192MB records -- well under every model),
//     TextDecoder build. Expect CB1 within milliseconds, STOPA (3 sites), DONE.
//   - If heartbeat dies EXACTLY at P2M CALLA: param-call fatal boundary <= 2M (huge shift).
//   - If heartbeat dies during the 30s: pipe itself is broken -> rebuild telemetry before any call.
// Beacon prefix: V139N-
(function(){
var rid='v139n'+Math.random().toString(36).slice(2,12);
var T0=Date.now();
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V139N-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
}
var hbN=0;
function startHb(){ setInterval(function(){ hbN++; beacon('HB',{n:hbN,ms:Date.now()-T0}); },2000); }
startHb();
beacon('L','noop-start; hb=2s; quiet30; then P2M');

// ---- P2M worker: param call at 2,000,000 repeats ----
function mkP2m(){
  var L=[];
  L.push('(function(){');
  L.push('var T0=Date.now(),PH="boot",built=false,started=false;');
  L.push('function wb(t,d){try{self.postMessage({t:t,d:d,ph:PH,ms:Date.now()-T0});}catch(e){}}');
  L.push('function wf(t,d){try{fetch("/beacon/V139N-P2M-W-"+t,{method:"POST",body:JSON.stringify({ph:PH,w:Date.now(),d:d})}).catch(function(){});}catch(e){}}');
  L.push('function ev(t,d){wb(t,d);wf(t,d);}');
  L.push('function build(){');
  L.push('  if(built)return;built=true;PH="fill";');
  L.push('  var N=2000000,PRE="self.__v139b(0);",len=PRE.length+N*4,t=Date.now();');
  L.push('  var buf=new Uint8Array(len);');
  L.push('  for(var j=0;j<PRE.length;j++)buf[j]=PRE.charCodeAt(j);');
  L.push('  for(var i=PRE.length;i<len;i+=4){buf[i]=97;buf[i+1]=40;buf[i+2]=41;buf[i+3]=59;}');
  L.push('  var fillT=Date.now()-t;ev("FILL",{b:len,ms:fillT,pre:PRE.length});');
  L.push('  PH="str";t=Date.now();');
  L.push('  var src=new TextDecoder().decode(buf);buf=null;');
  L.push('  ev("STR",{len:src.length,ms:Date.now()-t});');
  L.push('  PH="cmp";t=Date.now();var fn;');
  L.push('  try{fn=new Function("a",src);}catch(e){ev("ERR",{w:"cmp",e:String(e&&e.message||e).slice(0,80)});setTimeout(function(){self.close();},300);return;}');
  L.push('  ev("CMP",{ms:Date.now()-t,n:N,param:true});');
  L.push('  PH="call";ev("CALLA",{n:N});var tA=Date.now(),cc=0,f=1;');
  L.push('  self.a=function(){if(f){f=0;ev("CB1",{site:1,ms:Date.now()-tA});}cc++;if(cc>=3)throw new Error("PSTOP");};');
  L.push('  try{fn(self.a);ev("RETA",{cc:cc});}');
  L.push('  catch(e){if(e&&e.message==="PSTOP"){ev("STOPA",{cc:cc,ms:Date.now()-tA});}else{ev("ERR",{w:"call",e:String(e&&e.message||e).slice(0,80)});}}');
  L.push('  PH="done";ev("DONE",{n:N,cc:cc,callMs:Date.now()-tA,fillMs:fillT});');
  L.push('  setTimeout(function(){self.close();},300);');
  L.push('}');
  L.push('wt=setTimeout(function(){ev("WTO",{ph:PH,ms:Date.now()-T0});},60000);');
  L.push('self.onmessage=function(e){if(e&&e.data&&e.data.g==="build")build();};');
  L.push('setTimeout(function(){if(!built)build();},150);');
  L.push('})();');
  return L.join('\n');
}

setTimeout(function(){
  try{
    var blob=new Blob([mkP2m()],{type:'application/javascript'});
    var url=URL.createObjectURL(blob);
    var w=new Worker(url);
    w.onmessage=function(e){
      var d=e.data||{};
      beacon('P2M-'+(d.t||'?'),{ph:d.ph,ms:d.ms,d:d.d});
      if(d.t==='DONE'){URL.revokeObjectURL(url);}
    };
    w.onerror=function(e){beacon('P2M-ONERR',{msg:e&&e.message?String(e.message).slice(0,90):'?',line:e&&e.lineno});};
    beacon('P2M-SPAWN',{n:2000000,at:Date.now()-T0});
    w.postMessage({g:'build'});
  }catch(e){ beacon('P2M-SETUP-ERR',{e:String(e&&e.message||e).slice(0,90)}); }
},30000);

setTimeout(function(){ beacon('ALLCLEAR',{ms:Date.now()-T0,hb:hbN,note:'30s quiet survived; 2M test armed'}); },29500);
})();
