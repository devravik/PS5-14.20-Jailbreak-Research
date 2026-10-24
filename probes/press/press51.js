/* press-51 EXTERNO — DS-ProMax-lane: E1 ledger localStorage + E2 context typeof + E5 clock + WebGL2 real-ctx + MSE-stage0 + sc-deep. Zero media bytes, zero SharedWorker build. */
(function(){
"use strict";
if(window.__p51)return; window.__p51=1;
var RID="v51x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,400)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V51-HB","hb");},2000);
bk("V51-L","press51-EXT ds-lane ledger+ctxt+gl2+MSE0+sc");
function Trnd(){return Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36);}

/* E1 — run ledger */
try{
  var prev=null;
  try{prev=JSON.parse(localStorage.getItem("p51-ledger")||"null");}catch(e){}
  var now=Date.now();
  var cur={uid:(prev&&prev.uid)||Math.random().toString(36).slice(2,12),n:((prev&&prev.n)||0)+1,first:(prev&&prev.first)||now,last:now};
  try{localStorage.setItem("p51-ledger",JSON.stringify(cur));}catch(e){bk("V51-Ed1w","ledger-write-err:"+e);}
  bk("V51-Rd1","ledger prev_n="+(prev&&prev.n)+" prev_uid="+(prev&&prev.uid)+" now_n="+cur.n+" uid="+cur.uid+(prev?(prev.uid===cur.uid?" SAME-UID":" NEW-UID"):""));
}catch(e){bk("V51-Rd1","ledger-FAIL "+e);}

/* E2 — context avatars (typeof only; NO construct of SharedWorker/SW) */
bk("V51-Fctyp","typeof SharedWorker="+(typeof SharedWorker)+" serviceWorker="+(typeof navigator.serviceWorker)+" caches="+(typeof caches)+" BroadcastChannel="+(typeof BroadcastChannel)+" OfflineAudioContext="+(typeof OfflineAudioContext)+" DecompressionStream="+(typeof DecompressionStream)+" XSLTProcessor="+(typeof XSLTProcessor)+" DOMParser="+(typeof DOMParser));
try{
  var bc=null,t0=Date.now();
  bc=new BroadcastChannel("p51");
  var pong=false; bc.onmessage=function(ev){if(ev&&ev.data==="ping"){pong=true;bc.postMessage("pong");bk("V51-Rbc","BC-echo="+(Date.now()-t0)+"ms");}};
  bc.postMessage("ping");
  setTimeout(function(){try{if(bc)bc.close();}catch(e){} bk("V51-Rbc2","BC-late pong="+pong);},1500);
}catch(e){bk("V51-Rbc","BC-FAIL "+e);}

/* E5 — clock identity */
try{ bk("V51-Fclk","timeOrigin="+(performance.timeOrigin||-1)+" drift(date-perf)="+(Date.now()-(performance.timeOrigin||Date.now()))+" tz="+Intl.DateTimeFormat().resolvedOptions().timeZone); }catch(e){bk("V51-Fclk","clk-ERR "+e);}

/* WebGL2 real context — in or out verdict */
try{
  var cn=document.createElement("canvas");
  var gl=cn.getContext("webgl2");
  if(!gl){bk("V51-Rgl2","webgl2-ctx=NULL lane-OUT");}
  else{
    var v="?";try{v=gl.getParameter(gl.VERSION);}catch(e){v="ERR:"+e;}
    var ext="?";try{ext=gl.getSupportedExtensions?String(gl.getSupportedExtensions().length):"no-getExt";}catch(e){ext="ERR";}
    bk("V51-Rgl2","webgl2-ctx=ALIVE VERSION="+String(v).slice(0,60)+" nExt="+ext+" lane-IN");
  }
}catch(e){bk("V51-Rgl2","gl2-EXC "+e);}

/* sc-deep — structuredClone graph oracle */
try{
  function mk(d){var o={};for(var i=0;i<d;i++){o={a:o,b:o};}return o;}
  var t0=performance.now();
  var deep=mk(64);
  var cl=structuredClone(deep);
  var t1=performance.now();
  var cy={x:{p:1}};cy.x.q=cy;
  var cl2=structuredClone(cy);
  var held=(cl2&&cl2.x&&cl2.x.q===cl2.x);
  var m=new Map([["a",1]]);var s=new Set([1,2]);var dd=new DataView(new ArrayBuffer(7),0,7);
  dd.setInt32(0,0x41424344);
  var cl3=structuredClone({m:m,s:s,d:dd});
  bk("V51-Rsc","sc-deep=OK depth64="+(!!cl)+" t="+(t1-t0).toFixed(1)+"ms cyc="+(held?"held":"-")+" dview="+(cl3.d.getInt32(0,0)===0x41424344?"preserved":"MUTATED"));
}catch(e){bk("V51-Rsc","sc-deep-EXC "+String(e).slice(0,80));}

/* MSE stage-0 — constructors + addSourceBuffer, ZERO bytes */
try{
  var has=typeof MediaSource;
  bk("V51-Fmse2","MSE-typeof="+has+" SRCB-typeof="+(typeof SourceBuffer)+" ctor="+(!!(window.MediaSource&&MediaSource.sourceBuffer?1:0)));
  var ms=new MediaSource();
  bk("V51-Rmse","MSE-ctor=OK readyState="+ms.readyState+" srcbufs="+ms.sourceBuffers.length);
  try{
    var sb=ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    bk("V51-Rmse2","addSourceBuffer(mp4-avc1-high)=OK updating="+sb.updating);
    try{ ms.removeSourceBuffer(sb);}catch(e){}
  }catch(e){bk("V51-Rmse2","addSourceBuffer-EXC "+String(e).slice(0,70));}
  try{
    var sb2=ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    bk("V51-Rmse3","addSourceBuffer(aac)=OK updating="+sb2.updating);
    try{ ms.removeSourceBuffer(sb2);}catch(e){}
  }catch(e){bk("V51-Rmse3","addSourceBuffer-aac-EXC "+String(e).slice(0,70));}
  bk("V51-Rmse4","MSE-supportsType avc1="+(window.MediaSource&&MediaSource.isTypeSupported&&MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"'))+" hvc1="+(window.MediaSource&&MediaSource.isTypeSupported&&MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')));
}catch(e){bk("V51-Rmse","MSE-ctor-EXC "+String(e).slice(0,70));}

setTimeout(function(){clearInterval(HB);bk("V51-Z2","late-z");},9000);
})();
