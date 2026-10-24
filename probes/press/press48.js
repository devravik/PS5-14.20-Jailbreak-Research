/* press-48 EXTERNO — FINGERPRINT del build (DS endgame Move-1): APIs, codecs, decoders, workers. Todo catch-safe, zero-brick. */
(function(){
"use strict";
if(window.__p48)return; window.__p48=1;
var RID="v48x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,400)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V48-HB","hb");},2000);
bk("V48-L","fp-begin "+navigator.userAgent);
function pr(k,fn){
  var v;
  try{ v=fn(); }catch(e){ v="E:"+(e&&(e.name+": "+e.message)||e).slice(0,60); }
  bk("V48-F"+String(k).toLowerCase(), k+"="+String(v).slice(0,220));
}
pr("plat",function(){return navigator.platform;});
pr("lang",function(){return navigator.language+"|"+(navigator.languages||[]).join(",");});
pr("conc",function(){return navigator.hardwareConcurrency;});
pr("core",function(){return navigator.hardwareConcurrency|navigator.deviceMemory|navigator.onLine;});
pr("nline",function(){return navigator.onLine;});
pr("stack",function(){var e;try{null.x}catch(err){e=err;}return e.stack?e.stack.split("\n")[0].slice(0,110):"no-stack";});
pr("fnstr",function(){return (function fprobe(){return 1;}).toString().slice(0,60);});
pr("imgdec",function(){return typeof ImageDecoder;});
pr("cib",function(){return typeof createImageBitmap;});
pr("canv",function(){var c=document.createElement("canvas");var g=c.getContext("2d");return g?"ctx2-ok":"ctx2-null";});
pr("webgl",function(){var c=document.createElement("canvas");var g=c.getContext("webgl")||c.getContext("experimental-webgl");if(!g)return "no-webgl";return g.getParameter(g.VERSION)+"|sl:"+g.getParameter(g.SHADING_LANGUAGE_VERSION)+"|ext:"+(g.getSupportedExtensions()||[]).length;});
pr("webgl2",function(){return typeof (document.createElement("canvas").getContext("webgl2"));});
pr("gpu",function(){return navigator.gpu?"present":"none";});
pr("wasm",function(){return (typeof WebAssembly!=="undefined")?(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0]))?"magic-ok":"magic-reject"):"no-wasm";});
pr("wasmmod",function(){return typeof (window.WebAssembly&&WebAssembly.Module);});
pr("sab",function(){return typeof SharedArrayBuffer;});
pr("offc",function(){return typeof OffscreenCanvas;});
pr("sc",function(){try{var v=structuredClone({a:new Uint8Array(4),d:new DataView(new ArrayBuffer(4))});return "sc-ok:"+typeof v.a;}catch(e){return "sc-err";} });
pr("bigint",function(){return typeof BigInt;});
pr("atomics",function(){return typeof Atomics;});
pr("abort",function(){return typeof AbortController;});
pr("mse",function(){if(typeof MediaSource==="undefined")return "no-MSE";var ok=[],x=["video/mp4;codecs=avc1.42E01E","audio/webm;codecs=opus","video/webm;codecs=vp8","audio/aac","video/mp2t"];for(var i=0;i<x.length;i++)ok.push(String(MediaSource.isTypeSupported(x[i])));return "MSE:"+ok.join("|");});
pr("vid",function(){var v=document.createElement("video");return "mp4:"+v.canPlayType("video/mp4")+"|webm:"+v.canPlayType("video/webm")+"|h264:"+v.canPlayType("video/mp4; codecs=avc1.42E01E");});
pr("aud",function(){var A=window.AudioContext||window.webkitAudioContext;return typeof A+(A?"|off:"+typeof OfflineAudioContext:"");});
pr("wsock",function(){return typeof WebSocket;});
pr("evtsr",function(){return typeof EventSource;});
pr("rtc",function(){return typeof RTCPeerConnection;});
pr("md",function(){return (navigator.mediaDevices)?"md-ok":"no-md";});
pr("ls",function(){try{localStorage.setItem("q48","1");var v=localStorage.getItem("q48");localStorage.removeItem("q48");return v==="1"?"ls-ok":"ls-fail:"+v;}catch(e){return "ls-block";}});
pr("ss",function(){return typeof sessionStorage;});
pr("ff",function(){return document.fonts?("ff-ok s="+document.fonts.status+" n="+document.fonts.size):"no-ff";});
pr("touch",function(){return navigator.maxTouchPoints;});
pr("scrn",function(){return screen.width+"x"+screen.height+"@"+screen.colorDepth+" dpr="+(window.devicePixelRatio||0);});
pr("css",function(){return (window.CSS&&CSS.supports)?String(CSS.supports("display","grid")):"no-cssapi";});
pr("perf",function(){return performance&&performance.now?("p-ok "+performance.timeOrigin):"no-perf";});
pr("xp",function(){return typeof XMLHttpRequest+"|sync:"+(function(){try{var x=new XMLHttpRequest();return "ok";}catch(e){return "err";}})();});
pr("shb",function(){return typeof navigator.sendBeacon;});
pr("docm",function(){return document.documentMode!==undefined?"ie-mode-quirk":"docmode-none";});
pr("wk",function(){
  if(typeof Worker!=="function")return "no-worker";
  try{
    var url=URL.createObjectURL(new Blob(['postMessage("wk-ok");'],{type:"text/javascript"}));
    var w=new Worker(url);var got=false;
    w.onmessage=function(){got=true;bk("V48-Fwkmsg","worker-msg=OK");try{w.terminate();}catch(e){}};
    setTimeout(function(){if(!got)bk("V48-Fwkmsg","worker-no-response");try{w.terminate();}catch(e){}},900);
    return "worker-created";
  }catch(e){return "worker-err:"+(e&&e.message||"").slice(0,40);}
});
pr("fld",function(){return typeof (window.XSLTProcessor||0)+"|"+typeof (window.DOMParser);});
pr("srcs",function(){return Object.keys(window).slice(0,60).join(",");},);
/* PNG decoder ping por createImageBitmap path (decode sin canvas render) */
setTimeout(function(){
  try{
    var b64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    var bin=atob(b64);var u8=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
    var blob=new Blob([u8],{type:"image/png"});
    if(typeof createImageBitmap==="function"){
      createImageBitmap(blob).then(function(bmp){bk("V48-Endimg","png-decode=OK "+(bmp&&bmp.width)+"x"+(bmp&&bmp.height));},function(e){bk("V48-Endimg","png-reject:"+(e&&e.message||"").slice(0,50));});
    }else{bk("V48-Endimg","no-createImageBitmap");}
  }catch(e){bk("V48-Endimg","E:"+(e&&e.message||"").slice(0,50));}
},1500);
setTimeout(function(){clearInterval(HB);bk("V48-END","fp-digest complete");},7000);
})();
