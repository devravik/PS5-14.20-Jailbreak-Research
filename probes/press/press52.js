/* press-52 EXTERNO — MSE stage-1: attach + append taxonomy (garbage + INIT A..E). Ledger continues. sc-cycle fix. */
(function(){
"use strict";
if(window.__p52)return; window.__p52=1;
var RID="v52x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,320)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V52-HB","hb");},2000);
bk("V52-L","press52-EXT MSE-stage1");
function fmt(e){return String((e&&e.name)||e).slice(0,48);}

/* ledger continuity */
try{
  var prev=null;
  try{prev=JSON.parse(localStorage.getItem("p51-ledger")||"null");}catch(e){}
  var now=Date.now();
  var cur={uid:(prev&&prev.uid)||Math.random().toString(36).slice(2,12),n:((prev&&prev.n)||0)+1,first:(prev&&prev.first)||now,last:now};
  try{localStorage.setItem("p51-ledger",JSON.stringify(cur));}catch(e){}
  bk("V52-Rled","ledger prev_n="+(prev&&prev.n)+" now_n="+cur.n+" same-uid="+(prev?prev.uid===cur.uid:"n/a"));
}catch(e){bk("V52-Rled","ledger-FAIL "+e);}

var P52_INIT = {
  "A-valid": "AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkFtb292AAAAcG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAcl0cmFrAAAAYHRraGQAAAAHAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAFAAAAA8AAAAAABYW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAABX5AAAAAAVcQAAAAAAC5oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAELbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAANNzdGJsAAAAh3N0c2QAAAAAAAAAAQAAAHdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAA8ABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAIWF2Y0MBZAAo/wABAAhnZAAorNnABQABAARo6+yyAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAA=",
  "B-stsd-entry-lie": "AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkFtb292AAAAcG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAcl0cmFrAAAAYHRraGQAAAAHAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAFAAAAA8AAAAAABYW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAABX5AAAAAAVcQAAAAAAC5oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAELbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAANNzdGJsAAAAh3N0c2QAAAAAAAAAAQAAAI9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAA8ABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAIWF2Y0MBZAAo/wABAAhnZAAorNnABQABAARo6+yyAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAA=",
  "C-stco-overshoot": "AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkVtb292AAAAcG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAc10cmFrAAAAYHRraGQAAAAHAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAFAAAAA8AAAAAABZW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAABX5AAAAAAVcQAAAAAAC5oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAEPbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAANdzdGJsAAAAh3N0c2QAAAAAAAAAAQAAAHdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAA8ABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAIWF2Y0MBZAAo/wABAAhnZAAorNnABQABAARo6+yyAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RjbwAAAAAAAAAB/////wAAABRzdHN6AAAAAAAAAAAAAAAA",
  "D-mvhd-ts-zero": "AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkFtb292AAAAcG12aGQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAcl0cmFrAAAAYHRraGQAAAAHAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAFAAAAA8AAAAAABYW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAABX5AAAAAAVcQAAAAAAC5oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAELbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAANNzdGJsAAAAh3N0c2QAAAAAAAAAAQAAAHdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAA8ABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAIWF2Y0MBZAAo/wABAAhnZAAorNnABQABAARo6+yyAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAA=",
  "E-tkhd-wid-huge": "AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkFtb292AAAAcG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAcl0cmFrAAAAYHRraGQAAAAHAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAP////8A8AAAAAABYW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAABX5AAAAAAVcQAAAAAAC5oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAELbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAANNzdGJsAAAAh3N0c2QAAAAAAAAAAQAAAHdhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAA8ABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAIWF2Y0MBZAAo/wABAAhnZAAorNnABQABAARo6+yyAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAA="
};

var P52_DATA={};
function bufFrom(s){var raw=atob(s);var a=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a.buffer;}
try{
  var garbage=new Uint8Array(8);for(var g2=0;g2<8;g2++)garbage[g2]=0xAA;
  P52_DATA["GARBU8"]=garbage.buffer;
  for(var kk in P52_INIT)P52_DATA[kk]=bufFrom(P52_INIT[kk]);
  bk("V52-Fsz","sizes "+Object.keys(P52_DATA).map(function(k){return k+":"+P52_DATA[k].byteLength;}).join(","));
}catch(e){bk("V52-Fsz","buf-FAIL "+e);}

var vid=null,ms=null,sb=null,opened=false;
var MIME='video/mp4; codecs="avc1.640028"';
var seq=Object.keys(P52_DATA);
var idx=0,busy=false,wdog=null,t0=0;
try{
  vid=document.createElement("video");vid.muted=true;document.body.appendChild(vid);
  ms=new MediaSource();
  vid.src=URL.createObjectURL(ms);
  bk("V52-Fatt","src-attach ms.readyState="+ms.readyState);
  ms.addEventListener("sourceopen",onOpen);
}catch(e){bk("V52-Fatt","attach-EXC "+fmt(e));}

function freshSB(){
  try{
    if(sb){try{ms.removeSourceBuffer(sb);}catch(e){}sb=null;}
    sb=ms.addSourceBuffer(MIME);
  }catch(e){bk("V52-Rx","sb-EXC "+fmt(e));return null;}
  sb.addEventListener("updateend",onDone);
  sb.addEventListener("error",onErr);
  return sb;
}
function onErr(){finish("SB-error");}
function onDone(){
  if(!busy)return;busy=false;
  if(wdog){clearTimeout(wdog);wdog=null;}
  finish("updateend d="+(performance.now()-t0).toFixed(1)+"ms");
}
function finish(how){
  if(!busy){/*console*/}
  try{bk("V52-R"+seq[idx-1],how);}catch(e){}
  next();
}
function next(){
  idx++;
  if(idx<=seq.length)runOne(seq[idx-1],true);
  else{try{ms.removeEventListener("sourceopen",onOpen);}catch(e){}bk("V52-END","stage1-done n="+seq.length);}
}
function runOne(name){
  busy=true;
  if(!freshSB()){busy=false;bk("V52-R"+name,"no-sb-closed");setTimeout(next,120);return;}
  t0=performance.now();
  try{
    sb.appendBuffer(P52_DATA[name]);
    bk("V52-E"+name,"sent "+P52_DATA[name].byteLength+"B");
    wdog=setTimeout(function(){busy=false;bk("V52-R"+name,"NO-EVENT-1.8s");next();},1800);
  }catch(e){
    busy=false;bk("V52-R"+name,"append-EXC "+fmt(e));setTimeout(next,100);
  }
}
function onOpen(){
  if(opened)return;opened=true;
  if(wdog){clearTimeout(wdog);wdog=null;}
  if(idx>0)return;
  bk("V52-Ropen","sourceopen readyState="+ms.readyState);
  idx=0;runOne(seq[0]);
}
setTimeout(function(){
  if(!opened){
    bk("V52-Ropen","sourceopen TIMEOUT 3.2s");
    if(idx===0){busy=false;idx=0;runOne(seq[0]);}
  }
},3200);

/* sc-cycle 1-hop-inner re-check (V51 test had wrong identity target) */
try{
  var cy={x:{p:1}};cy.x.q=cy.x;
  var cl2=structuredClone(cy);
  bk("V52-Rsc","sc-cyc1="+(cl2&&cl2.x&&cl2.x.q===cl2.x?"held":"not-held"));
}catch(e){bk("V52-Rsc","sc-EXC "+String(e).slice(0,60));}

setTimeout(function(){clearInterval(HB);bk("V52-Z2","late-z");},16000);
})();
