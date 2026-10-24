/* press-53 EXTERNO — Pro-Max R3.1 dual-heartbeat + createObjectURL classification + attach retry. */
(function(){
"use strict";
if(window.__p53)return; window.__p53=1;
var RID="v53x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,300)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V53-HB","hb");},2000);
bk("V53-L","press53-EXT dual-heartbeat + URL-clf");
function fmt(e){return String((e&&e.name)||e).slice(0,44);}

/* ledger + restore-counter C + entropy snapshot */
try{
  var prev=null;try{prev=JSON.parse(localStorage.getItem("p51-ledger")||"null");}catch(e){}
  var now=Date.now();
  var cur={uid:(prev&&prev.uid)||Math.random().toString(36).slice(2,12),n:((prev&&prev.n)||0)+1,first:(prev&&prev.first)||now,last:now};
  localStorage.setItem("p51-ledger",JSON.stringify(cur));
  var c=parseInt(localStorage.getItem("p53-restores")||"0",10)+1;
  localStorage.setItem("p53-restores",String(c));
  bk("V53-Rled","ledger n="+(prev&&prev.n)+"->"+cur.n+" same-uid="+(prev?prev.uid===cur.uid:"n/a")+" restores="+c);
  var ent={now:Date.now(),mr:[Math.random().toFixed(8),Math.random().toFixed(8)],to:(performance.timeOrigin||-1)};
  localStorage.setItem("p53-entropy",JSON.stringify(ent));
  var pe=null;try{pe=JSON.parse(localStorage.getItem("p53-entropy-verify")||"null");}catch(e){}
  bk("V53-Rent","entropy dumped mr="+ent.mr[0]+","+ent.mr[1]+" to="+ent.to);
}catch(e){bk("V53-Rled","ledger-FAIL "+e);}

/* URL classification */
try{
  var tt="typeof createObjectURL="+(typeof URL.createObjectURL)+" typeof Blob="+(typeof Blob)+" typeof File="+(typeof File)+" typeof FileReader="+(typeof FileReader)+" revoke="+(typeof URL.revokeObjectURL);
  bk("V53-Furl",tt);
  try{
    var b=new Blob(["x"]);
    var ob=URL.createObjectURL(b);
    bk("V53-Rblob","blob-URL=OK len="+String(ob.length));
  }catch(e){bk("V53-Rblob","blob-URL-EXC "+fmt(e));}
  try{
    var msx=new MediaSource();
    var om=URL.createObjectURL(msx);
    bk("V53-Rms","ms-URL=OK len="+String(om.length));
  }catch(e){bk("V53-Rms","ms-URL-EXC "+fmt(e));}
}catch(e){bk("V53-Furl","clf-FAIL "+e);}

/* worker: born + LS probe + beats funnel */
try{
  var wk=new Worker("p53-worker.js?t="+Date.now().toString(36));
  var beats=0,lastBeat=0;
  wk.onmessage=function(ev){
    try{
      var d=ev&&ev.data||{};var t=String(d.t||"");
      if(t==="hbx"){beats++;lastBeat=Date.now();if(beats===1||beats===12||beats===36)bk("V53-Rw","worker beat#"+beats);}
      else bk("V53-Rw",t+" "+d.b);
    }catch(e){/*console*/}
  };
  wk.onerror=function(ev){bk("V53-Rw","worker-ERROR "+String((ev&&ev.message)||"").slice(0,60));};
  try{wk.postMessage({echo:"p53"});}catch(e){bk("V53-Rw","mpost-EXC "+fmt(e));}
  /* main heartbeat key A @400ms + worker-proxy time checkpoint */
  var an=0;
  var AHB=setInterval(function(){an++;try{localStorage.setItem("p53-A",String(Date.now()));}catch(e){}if(an===1||an===40)bk("V53-RA","A#"+an);},400);
}catch(e){bk("V53-Rw","worker-FAIL "+e);}

/* pagehide/visibility instrumentation */
try{
  addEventListener("pagehide",function(){try{localStorage.setItem("p53-exit",String(Date.now()));bk("V53-Rexit","pagehide");}catch(e){}});
  addEventListener("visibilitychange",function(){try{if(document.visibilityState==="hidden")bk("V53-Rvis","visibility=hidden");}catch(e){}});
}catch(e){}

setTimeout(function(){clearInterval(HB);bk("V53-Z2","late-z");},17000);
})();
