// p136 — JIT/DFG compilation detection
// Source tree has ENABLE_JIT=1 and ENABLE_DFG_JIT=1 for x86_64.
// PS5 device showed no JIT behavior in earlier tests (p99/p104/p105).
// This probe does a more thorough warmup with higher iteration counts
// and different function shapes to see if DFG/FTL ever kicks in.
// If JIT works: CVE-2024-23222 is exploitable (proven in-the-wild technique).
// Beacon prefix: V136J-
(function(){
var rid='v136j'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V136J-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V136J-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe136-start');

// Test 1: Simple arithmetic — classic DFG candidate
function addTest(a,b){return a+b|0;}
var batchSize=500000;
var rounds=20;
var results1=[];
beacon('T1-PRE','addTest');
for(var r=0;r<rounds;r++){
  var t0=performance.now?performance.now():Date.now();
  var s=0;
  for(var i=0;i<batchSize;i++)s=addTest(s,i);
  var elapsed=performance.now?performance.now()-t0:Date.now()-t0;
  results1.push(Math.round(elapsed*100)/100);
  if(r%5===4)beacon('T1-R'+(r+1),results1.slice(r-4,r+1).join(','));
}
beacon('T1',results1.join(','));

// Test 2: Property access — DFG optimizes IC chains
var obj={x:1,y:2,z:3};
function propTest(o){return o.x+o.y+o.z;}
var results2=[];
beacon('T2-PRE','propTest');
for(var r=0;r<rounds;r++){
  var t0=performance.now?performance.now():Date.now();
  var s=0;
  for(var i=0;i<batchSize;i++)s=propTest(obj);
  var elapsed=performance.now?performance.now()-t0:Date.now()-t0;
  results2.push(Math.round(elapsed*100)/100);
  if(r%5===4)beacon('T2-R'+(r+1),results2.slice(r-4,r+1).join(','));
}
beacon('T2',results2.join(','));

// Test 3: Array access — DFG CheckArray optimization
// This is the exact primitive CVE-2024-23222 exploits
var arr=[1.1,2.2,3.3,4.4,5.5];
function arrTest(a,i){return a[i%5];}
var results3=[];
beacon('T3-PRE','arrTest');
for(var r=0;r<rounds;r++){
  var t0=performance.now?performance.now()-0:Date.now();
  var s=0;
  for(var i=0;i<batchSize;i++)s+=arrTest(arr,i);
  var elapsed=performance.now?performance.now()-t0:Date.now()-t0;
  results3.push(Math.round(elapsed*100)/100);
  if(r%5===4)beacon('T3-R'+(r+1),results3.slice(r-4,r+1).join(','));
}
beacon('T3',results3.join(','));

// Test 4: Higher warmup — 50M total iterations in one shot
beacon('T4-PRE','highwarmup');
function hotFunc(n){var s=0;for(var i=0;i<n;i++)s=s+i|0;return s;}
var t4_0=Date.now();
var r4a=hotFunc(10000000); // 10M warmup
var t4_1=Date.now();
var r4b=hotFunc(10000000); // 10M repeat — should be faster if JIT kicked in
var t4_2=Date.now();
var r4c=hotFunc(10000000); // 10M more
var t4_3=Date.now();
var r4d=hotFunc(10000000); // 10M more
var t4_4=Date.now();
var r4e=hotFunc(10000000); // 10M more
var t4_5=Date.now();
beacon('T4','ms:['+(t4_1-t4_0)+','+(t4_2-t4_1)+','+(t4_3-t4_2)+','+(t4_4-t4_3)+','+(t4_5-t4_4)+'],res:['+r4a+','+r4b+','+r4c+','+r4d+','+r4e+']');

// Test 5: Check if Options::useJIT is accessible
// Some debug builds expose $vm or globalThis.$jsc
beacon('T5-PRE','runtime-check');
var jitInfo={};
try{jitInfo.dollarVM=typeof $vm;}catch(e){jitInfo.dollarVM='unavailable';}
try{jitInfo.dollarJSC=typeof $jsc;}catch(e){jitInfo.dollarJSC='unavailable';}
try{jitInfo.gc=typeof gc;}catch(e){jitInfo.gc='unavailable';}
try{jitInfo.drainMicrotasks=typeof drainMicrotasks;}catch(e){jitInfo.drainMicrotasks='unavailable';}
beacon('T5',JSON.stringify(jitInfo));

beacon('DONE','all-done');
})();
