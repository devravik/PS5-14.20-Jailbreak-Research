/* press-64 — M1 full engine fingerprint.
   Pins JSC version via ES feature ladder, probes JIT, WASM, CSP, memory limits.
   All syntax tests use eval() so base script stays ES5. */
(function(){
"use strict";
if(window.__p64)return; window.__p64=1;
var RID="v64m"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,480)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V64M-HB","hb");},2000);
bk("V64M-L","press64-M1 full engine fingerprint");

/* ledger */
try{
  var prev=null;try{prev=JSON.parse(localStorage.getItem("p51-ledger")||"null");}catch(e){}
  var now=Date.now();
  var cur={uid:(prev&&prev.uid)||Math.random().toString(36).slice(2,12),n:((prev&&prev.n)||0)+1,first:(prev&&prev.first)||now,last:now};
  localStorage.setItem("p51-ledger",JSON.stringify(cur));
  var rs=parseInt(localStorage.getItem("p53-restores")||"0",10)+1;
  localStorage.setItem("p53-restores",String(rs));
  bk("V64M-Rled","ledger n="+(prev&&prev.n)+"->"+cur.n+" same-uid="+(prev?prev.uid===cur.uid:"n/a")+" restores="+rs);
}catch(e){bk("V64M-Rled","ledger-FAIL "+e);}

function t(code){try{return eval(code)!==void 0?true:true;}catch(e){return false;}}
function tv(code){try{return String(eval(code));}catch(e){return "ERR:"+e.name;}}

/* =========== GROUP A: ES VERSION LADDER =========== */

var esResults={};

/* ES2015 */
var es15=[];
es15.push("class:"+t("(function(){class X{} return new X()})()"));
es15.push("Symbol:"+t("Symbol('x')"));
es15.push("Promise:"+(typeof Promise==="function"));
es15.push("Map:"+(typeof Map==="function"));
es15.push("Set:"+(typeof Set==="function"));
es15.push("WeakMap:"+(typeof WeakMap==="function"));
es15.push("WeakSet:"+(typeof WeakSet==="function"));
es15.push("Proxy:"+(typeof Proxy==="function"));
es15.push("Reflect:"+(typeof Reflect==="object"));
es15.push("tlit:"+t("`${1+1}`"));
es15.push("arrow:"+t("(()=>1)()"));
es15.push("destr:"+t("var [a,b]=[1,2]; a+b"));
es15.push("for-of:"+t("var s=0;for(var x of [1,2])s+=x;s"));
es15.push("gen:"+t("(function*(){yield 1})().next().value"));
esResults["2015"]=es15.join(" ");
bk("V64M-A15",esResults["2015"]);

/* ES2016 */
var es16=[];
es16.push("includes:"+t("[1,2,3].includes(2)"));
es16.push("exp:"+t("2**3===8"));
esResults["2016"]=es16.join(" ");
bk("V64M-A16",esResults["2016"]);

/* ES2017 */
var es17=[];
es17.push("async:"+t("(async function(){})"));
es17.push("entries:"+(typeof Object.entries==="function"));
es17.push("values:"+(typeof Object.values==="function"));
es17.push("padStart:"+t("'x'.padStart(3,'0')==='00x'"));
es17.push("padEnd:"+t("'x'.padEnd(3,'0')==='x00'"));
es17.push("SAB:"+(typeof SharedArrayBuffer!=="undefined"));
es17.push("Atomics:"+(typeof Atomics!=="undefined"));
esResults["2017"]=es17.join(" ");
bk("V64M-A17",esResults["2017"]);

/* ES2018 */
var es18=[];
es18.push("asyncIter:"+t("(async function*(){})"));
es18.push("Pfinally:"+(typeof Promise.prototype.finally==="function"));
es18.push("lookbehind:"+t("/(?<=a)b/.test('ab')"));
es18.push("sflag:"+t("/./s.flags==='s'"));
es18.push("namedGrp:"+t("/(?<y>\\d+)/.exec('42').groups.y==='42'"));
es18.push("restObj:"+t("var {a,...r}={a:1,b:2}; r.b===2"));
esResults["2018"]=es18.join(" ");
bk("V64M-A18",esResults["2018"]);

/* ES2019 */
var es19=[];
es19.push("flat:"+t("[[1],2].flat().length===2"));
es19.push("flatMap:"+t("[1,2].flatMap(function(x){return [x,x]}).length===4"));
es19.push("fromEntries:"+(typeof Object.fromEntries==="function"));
es19.push("trimStart:"+t("' x'.trimStart()==='x'"));
es19.push("trimEnd:"+t("'x '.trimEnd()==='x'"));
es19.push("catchBind:"+t("try{throw 1}catch{1}"));
es19.push("stableSort:"+t("var a=[{k:1,v:'a'},{k:1,v:'b'},{k:0,v:'c'}];a.sort(function(x,y){return x.k-y.k});a[0].v==='c'&&a[1].v==='a'"));
esResults["2019"]=es19.join(" ");
bk("V64M-A19",esResults["2019"]);

/* ES2020 */
var es20=[];
es20.push("optChain:"+t("var o={a:{b:1}}; o?.a?.b===1"));
es20.push("nullish:"+t("(null??42)===42"));
es20.push("BigInt:"+t("BigInt(1)+BigInt(2)===BigInt(3)"));
es20.push("globalThis:"+(typeof globalThis!=="undefined"));
es20.push("PallSettled:"+(typeof Promise.allSettled==="function"));
es20.push("matchAll:"+t("typeof 'ab'.matchAll(/./g)==='object'"));
esResults["2020"]=es20.join(" ");
bk("V64M-A20",esResults["2020"]);

/* ES2021 */
var es21=[];
es21.push("replaceAll:"+t("'aab'.replaceAll('a','x')==='xxb'"));
es21.push("Pany:"+(typeof Promise.any==="function"));
es21.push("WeakRef:"+(typeof WeakRef==="function"));
es21.push("FinReg:"+(typeof FinalizationRegistry==="function"));
es21.push("logicAssign:"+t("var a=null; a??=5; a===5"));
es21.push("andAssign:"+t("var a=1; a&&=2; a===2"));
es21.push("orAssign:"+t("var a=0; a||=3; a===3"));
es21.push("numSep:"+t("1_000===1000"));
esResults["2021"]=es21.join(" ");
bk("V64M-A21",esResults["2021"]);

/* ES2022 */
var es22=[];
es22.push("at:"+t("[1,2,3].at(-1)===3"));
es22.push("hasOwn:"+(typeof Object.hasOwn==="function"));
es22.push("errCause:"+t("new Error('x',{cause:'y'}).cause==='y'"));
es22.push("dflag:"+t("/a/d.hasIndices!==undefined"));
es22.push("structClone:"+(typeof structuredClone==="function"));
es22.push("classField:"+t("(function(){class C{x=1} return new C().x===1})()"));
es22.push("privField:"+t("(function(){class C{#x=1;get(){return this.#x}} return new C().get()===1})()"));
es22.push("staticBlock:"+t("(function(){var v;class C{static{v=42}} return v===42})()"));
es22.push("topAwait:false");
esResults["2022"]=es22.join(" ");
bk("V64M-A22",esResults["2022"]);

/* ES2023 */
var es23=[];
es23.push("findLast:"+t("[1,2,3].findLast(function(x){return x<3})===2"));
es23.push("findLastIdx:"+t("[1,2,3].findLastIndex(function(x){return x<3})===1"));
es23.push("toReversed:"+t("[1,2,3].toReversed()[0]===3"));
es23.push("toSorted:"+t("[3,1,2].toSorted()[0]===1"));
es23.push("toSpliced:"+t("[1,2,3].toSpliced(1,1,9)[1]===9"));
es23.push("with:"+t("[1,2,3].with(1,9)[1]===9"));
esResults["2023"]=es23.join(" ");
bk("V64M-A23",esResults["2023"]);

/* ES2024 */
var es24=[];
es24.push("PwithResolvers:"+(typeof Promise.withResolvers==="function"));
es24.push("groupBy:"+(typeof Object.groupBy==="function"));
es24.push("MapGroupBy:"+(typeof Map.groupBy==="function"));
es24.push("ABresizable:"+t("new ArrayBuffer(8,{maxByteLength:16}).resizable===true"));
es24.push("ABtransfer:"+t("typeof new ArrayBuffer(8).transfer==='function'"));
esResults["2024"]=es24.join(" ");
bk("V64M-A24",esResults["2024"]);

/* Compute highest passing ES year */
var bestYear="pre2015";
var yearChecks={"2015":es15,"2016":es16,"2017":es17,"2018":es18,"2019":es19,"2020":es20,"2021":es21,"2022":es22,"2023":es23,"2024":es24};
for(var yr in yearChecks){
  var all=true;
  var arr=yearChecks[yr];
  for(var ci=0;ci<arr.length;ci++){
    if(arr[ci].indexOf(":false")!==-1||arr[ci].indexOf(":ERR")!==-1){all=false;break;}
  }
  if(all)bestYear=yr;
}
bk("V64M-Ayear","highest-full=ES"+bestYear);

/* =========== GROUP B: JSC-SPECIFIC =========== */

/* B1 — JIT detection: monomorphic vs polymorphic call site */
try{
  function monoObj(){return {x:1};}
  var monoA=monoObj(),monoB=monoObj(),monoC=monoObj();
  function readMono(o){return o.x;}
  var mt0=performance.now();
  for(var mi=0;mi<2000000;mi++){readMono(monoA);readMono(monoB);readMono(monoC);}
  var mt1=performance.now();
  var monoTime=mt1-mt0;

  function polyA(){this.x=1;this.a=0;}
  function polyB(){this.b=0;this.x=2;}
  function polyC(){this.c=0;this.d=0;this.x=3;}
  var pa=new polyA(),pb=new polyB(),pc=new polyC();
  function readPoly(o){return o.x;}
  var pt0=performance.now();
  for(var pi=0;pi<2000000;pi++){readPoly(pa);readPoly(pb);readPoly(pc);}
  var pt1=performance.now();
  var polyTime=pt1-pt0;

  var jitRatio=(polyTime/monoTime).toFixed(3);
  bk("V64M-B1jit","mono="+monoTime.toFixed(1)+"ms poly="+polyTime.toFixed(1)+"ms ratio="+jitRatio+(parseFloat(jitRatio)>1.5?" JIT-LIKELY":" JIT-UNCLEAR"));
}catch(e){bk("V64M-B1jit","EXC "+e.name);}

/* B2 — WebAssembly */
try{
  var wasmParts=[];
  wasmParts.push("typeof="+(typeof WebAssembly));
  if(typeof WebAssembly==="object"){
    wasmParts.push("validate="+(typeof WebAssembly.validate==="function"));
    wasmParts.push("compile="+(typeof WebAssembly.compile==="function"));
    wasmParts.push("instantiate="+(typeof WebAssembly.instantiate==="function"));
    wasmParts.push("stream="+(typeof WebAssembly.compileStreaming==="function"));
    wasmParts.push("Module="+(typeof WebAssembly.Module==="function"));
    wasmParts.push("Memory="+(typeof WebAssembly.Memory==="function"));
    wasmParts.push("Table="+(typeof WebAssembly.Table==="function"));
    try{
      var minWasm=new Uint8Array([0,97,115,109,1,0,0,0]);
      wasmParts.push("validMin="+WebAssembly.validate(minWasm));
    }catch(e){wasmParts.push("validMin=EXC:"+e.name);}
    try{
      var mem=new WebAssembly.Memory({initial:1,maximum:1,shared:true});
      wasmParts.push("sharedMem=Y");
    }catch(e){wasmParts.push("sharedMem="+e.name);}
  }
  bk("V64M-B2wasm",wasmParts.join(" "));
}catch(e){bk("V64M-B2wasm","EXC "+e.name);}

/* B3 — Temporal */
bk("V64M-B3temporal","Temporal="+(typeof Temporal!=="undefined"));

/* B4 — Intl features */
try{
  var intlP=[];
  intlP.push("Segmenter="+(typeof Intl.Segmenter==="function"));
  intlP.push("DisplayNames="+(typeof Intl.DisplayNames==="function"));
  intlP.push("ListFormat="+(typeof Intl.ListFormat==="function"));
  intlP.push("RelTimeFormat="+(typeof Intl.RelativeTimeFormat==="function"));
  intlP.push("Locale="+(typeof Intl.Locale==="function"));
  intlP.push("PluralRules="+(typeof Intl.PluralRules==="function"));
  bk("V64M-B4intl",intlP.join(" "));
}catch(e){bk("V64M-B4intl","EXC "+e.name);}

/* B5 — Atomics details */
try{
  var atomP=[];
  atomP.push("Atomics="+(typeof Atomics));
  if(typeof Atomics==="object"){
    atomP.push("wait="+(typeof Atomics.wait==="function"));
    atomP.push("waitAsync="+(typeof Atomics.waitAsync==="function"));
    atomP.push("notify="+(typeof Atomics.notify==="function"));
  }
  bk("V64M-B5atomics",atomP.join(" "));
}catch(e){bk("V64M-B5atomics","EXC "+e.name);}

/* =========== GROUP C: SECURITY-RELEVANT =========== */

/* C1 — CSP detection via SecurityPolicyViolationEvent */
try{
  var cspInfo="none";
  var cspDone=false;
  document.addEventListener("securitypolicyviolation",function(e){
    if(!cspDone){
      cspDone=true;
      cspInfo="violated="+e.violatedDirective+" effective="+e.effectiveDirective+" blocked="+String(e.blockedURI).slice(0,40);
      bk("V64M-C1csp",cspInfo);
    }
  });
  var scr=document.createElement("script");
  scr.textContent="window.__cspInlineTest=1;";
  (document.head||document.documentElement).appendChild(scr);
  setTimeout(function(){
    if(!cspDone){
      bk("V64M-C1csp","inline-exec="+(window.__cspInlineTest===1?"ALLOWED":"BLOCKED-SILENT"));
    }
  },500);
}catch(e){bk("V64M-C1csp","EXC "+e.name);}

/* C2 — eval status */
try{
  var evalResult=eval("1+1");
  bk("V64M-C2eval","eval=OK result="+evalResult);
}catch(e){bk("V64M-C2eval","eval=BLOCKED "+e.name);}

/* C3 — Function constructor */
try{
  var fnResult=new Function("return 1+2")();
  bk("V64M-C3func","Function=OK result="+fnResult);
}catch(e){bk("V64M-C3func","Function=BLOCKED "+e.name);}

/* C4 — dynamic import */
try{
  eval("import('data:text/javascript,export default 42').then(function(m){bk('V64M-C4import','OK val='+m.default)}).catch(function(e){bk('V64M-C4import','FAIL '+e.name)})");
}catch(e){bk("V64M-C4import","syntax-ERR "+e.name);}

/* C5 — Worker from Blob */
try{
  var wb=new Blob(["postMessage('blobW-ok')"],{type:"text/javascript"});
  var wu=URL.createObjectURL(wb);
  var ww=new Worker(wu);
  ww.onmessage=function(e){bk("V64M-C5blobW","OK msg="+e.data);ww.terminate();};
  ww.onerror=function(e){bk("V64M-C5blobW","ERR "+String(e.message).slice(0,60));};
  setTimeout(function(){ww.terminate();},3000);
}catch(e){bk("V64M-C5blobW","EXC "+e.name);}

/* C6 — Worker from data: URL */
try{
  var dw=new Worker("data:text/javascript,postMessage('dataW-ok')");
  dw.onmessage=function(e){bk("V64M-C6dataW","OK msg="+e.data);dw.terminate();};
  dw.onerror=function(e){bk("V64M-C6dataW","ERR "+String(e.message).slice(0,60));};
  setTimeout(function(){dw.terminate();},3000);
}catch(e){bk("V64M-C6dataW","EXC "+e.name);}

/* C7 — ServiceWorker */
bk("V64M-C7sw","navigator.sw="+(typeof navigator.serviceWorker));

/* C8 — WebSocket */
try{
  var wsUrl="ws://"+location.hostname+":9091/ws-probe";
  bk("V64M-C8ws","attempting "+wsUrl);
  var ws=new WebSocket(wsUrl);
  ws.onopen=function(){bk("V64M-C8ws","OPEN");ws.send("m1-probe");ws.close();};
  ws.onerror=function(){bk("V64M-C8ws","ERR-connect");};
  ws.onclose=function(e){bk("V64M-C8ws","CLOSE code="+e.code);};
  setTimeout(function(){try{ws.close();}catch(e){}},4000);
}catch(e){bk("V64M-C8ws","EXC "+e.name);}

/* C9 — crypto.subtle */
try{
  var cryptoP=[];
  cryptoP.push("crypto="+(typeof crypto));
  cryptoP.push("subtle="+(typeof crypto.subtle));
  cryptoP.push("getRandomValues="+(typeof crypto.getRandomValues==="function"));
  if(crypto.subtle){
    cryptoP.push("digest="+(typeof crypto.subtle.digest==="function"));
    cryptoP.push("generateKey="+(typeof crypto.subtle.generateKey==="function"));
    cryptoP.push("encrypt="+(typeof crypto.subtle.encrypt==="function"));
  }
  bk("V64M-C9crypto",cryptoP.join(" "));
}catch(e){bk("V64M-C9crypto","EXC "+e.name);}

/* C10 — Performance.now() resolution */
try{
  var minDelta=999;
  var samples=0;
  var lastP=performance.now();
  for(var ri=0;ri<10000;ri++){
    var nowP=performance.now();
    if(nowP!==lastP){
      var d=nowP-lastP;
      if(d<minDelta)minDelta=d;
      samples++;
      lastP=nowP;
    }
  }
  bk("V64M-C10perf","minDelta="+minDelta.toFixed(4)+"ms samples="+samples+" (reduced="+(minDelta>=0.1?"YES-reduced":"NO-full")+")");
}catch(e){bk("V64M-C10perf","EXC "+e.name);}

/* =========== GROUP D: MEMORY/LIMITS =========== */

/* D1 — Max ArrayBuffer size (binary search) */
try{
  var abLo=1,abHi=2147483648,abMax=0;
  while(abLo<=abHi){
    var abMid=Math.floor((abLo+abHi)/2);
    try{
      var tbuf=new ArrayBuffer(abMid);
      if(tbuf.byteLength===abMid){abMax=abMid;abLo=abMid+1;}else{abHi=abMid-1;}
      tbuf=null;
    }catch(e){abHi=abMid-1;}
  }
  var abMB=(abMax/1048576).toFixed(1);
  bk("V64M-D1ab","maxAB="+abMax+"("+abMB+"MB)");
}catch(e){bk("V64M-D1ab","EXC "+e.name);}

/* D2 — Max string length (binary search, uses Array.join) */
try{
  var sLo=1,sHi=536870912,sMax=0;
  while(sLo<=sHi){
    var sMid=Math.floor((sLo+sHi)/2);
    try{
      var ts="";
      if(sMid<=1048576){
        ts=new Array(sMid+1).join("x");
      }else{
        var chunk=new Array(1048577).join("x");
        var reps=Math.ceil(sMid/1048576);
        var parts=[];
        for(var sr=0;sr<reps;sr++)parts.push(chunk);
        ts=parts.join("").slice(0,sMid);
      }
      if(ts.length===sMid){sMax=sMid;sLo=sMid+1;}else{sHi=sMid-1;}
      ts=null;
    }catch(e){sHi=sMid-1;}
  }
  var sMB=(sMax/1048576).toFixed(1);
  bk("V64M-D2str","maxStr="+sMax+"("+sMB+"MB)");
}catch(e){bk("V64M-D2str","EXC "+e.name);}

/* D3 — Max Worker count */
try{
  var workers=[];
  var wBlob=new Blob([""],{type:"text/javascript"});
  var wUrl=URL.createObjectURL(wBlob);
  var wMax=0;
  for(var wi=0;wi<200;wi++){
    try{
      var tw=new Worker(wUrl);
      workers.push(tw);
      wMax=wi+1;
    }catch(e){break;}
  }
  for(var wk=0;wk<workers.length;wk++){try{workers[wk].terminate();}catch(e){}}
  URL.revokeObjectURL(wUrl);
  bk("V64M-D3workers","maxWorkers="+wMax);
}catch(e){bk("V64M-D3workers","EXC "+e.name);}

/* D4 — Recursion limit */
try{
  var recDepth=0;
  function recTest(){recDepth++;recTest();}
  try{recTest();}catch(e){}
  bk("V64M-D4recurse","maxDepth="+recDepth);
}catch(e){bk("V64M-D4recurse","EXC "+e.name);}

/* =========== SUMMARY =========== */
setTimeout(function(){
  bk("V64M-END","press64-M1 done bestES="+bestYear);
  setTimeout(function(){clearInterval(HB);bk("V64M-Z2","late-z");},20000);
},2000);

})();
