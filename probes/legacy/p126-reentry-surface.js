// p126 — Re-entrancy surface probes
// Tests C++ code paths where raw pointers may be cached across JS callbacks
// Focus: Canvas2D, adoptNode+CustomElements, RAB+TypedArray, TransformStream window
// Beacon prefix: V126S-
(function(){
var rid='v126s'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V126S-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V126S-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe126-start');

// ======== S1: Canvas putImageData with mid-operation detach ========
// Does putImageData cache the ImageData backing buffer pointer before writing to canvas?
// If so, transferring the buffer mid-operation could leave a stale pointer
function testS1(){
  var r={};
  try{
    var c=document.createElement('canvas');
    c.width=64;c.height=64;
    var ctx=c.getContext('2d');
    if(!ctx){r.err='no 2d context';return r;}
    r.ctxOK=true;

    // Create ImageData, confirm buffer is transferable
    var id=ctx.createImageData(64,64);
    var buf=id.data.buffer;
    r.bufLen=buf.byteLength;
    r.transferable=(buf.byteLength>0);

    // Fill with pattern
    for(var i=0;i<id.data.length;i++) id.data[i]=(i&0xFF);

    // Now: can we transfer the buffer WHILE putImageData uses it?
    // putImageData is synchronous so we can't interrupt it directly.
    // But: what if we create a Proxy-wrapped ImageData-like object?
    // Test 1: putImageData after transfer
    var clone=structuredClone(buf,{transfer:[buf]});
    r.origDetached=(buf.byteLength===0);
    r.cloneLen=clone.byteLength;

    // Now putImageData with the detached-buffer ImageData
    try{
      ctx.putImageData(id,0,0);
      r.putAfterDetach='no-error';
      // Read back pixels to see if stale data was written
      var readback=ctx.getImageData(0,0,64,64);
      var nonZero=0;
      for(var j=0;j<readback.data.length;j++) if(readback.data[j]!==0) nonZero++;
      r.readbackNonZero=nonZero;
    }catch(e){
      r.putErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    // Test 2: getImageData into a view whose buffer we then transfer
    var id2=ctx.getImageData(0,0,32,32);
    var buf2=id2.data.buffer;
    r.getImgBufLen=buf2.byteLength;
    var clone2=structuredClone(buf2,{transfer:[buf2]});
    r.getImgDetached=(buf2.byteLength===0);
    // Can we still read id2.data after detach?
    try{
      r.id2AfterDetach_0=id2.data[0];
      r.id2AfterDetach_len=id2.data.length;
    }catch(e){
      r.id2ReadErr=e.constructor.name;
    }
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== S2: adoptNode + Custom Elements lifecycle ========
// Can adoptedCallback fire while DOM internals hold stale node pointers?
function testS2(){
  var r={};
  try{
    // Check Custom Elements support
    if(typeof customElements==='undefined'){r.err='no customElements';return r;}
    r.ceOK=true;

    var callLog=[];
    var adopted=0;
    var connected=0;
    var disconnected=0;

    // Define a custom element that does DOM mutations in its callbacks
    var tag='test-adopt-'+Date.now();
    var ElClass=function(){
      var el=Reflect.construct(HTMLElement,[],ElClass);
      return el;
    };
    ElClass.prototype=Object.create(HTMLElement.prototype);
    ElClass.prototype.constructor=ElClass;
    ElClass.prototype.connectedCallback=function(){
      connected++;
      callLog.push('connected-'+connected);
    };
    ElClass.prototype.disconnectedCallback=function(){
      disconnected++;
      callLog.push('disconnected-'+disconnected);
      // Mutate DOM during disconnectedCallback — does this cause re-entrancy?
      if(disconnected===1){
        try{
          // Try to remove another element during our disconnect
          var sibling=this.parentNode?this.parentNode.querySelector('.sacrifice'):null;
          if(sibling) sibling.remove();
          callLog.push('removed-sibling');
        }catch(e){
          callLog.push('remove-err:'+e.constructor.name);
        }
      }
    };
    ElClass.prototype.adoptedCallback=function(){
      adopted++;
      callLog.push('adopted-'+adopted);
      // Create and adopt MORE elements during adoptedCallback
      if(adopted===1){
        try{
          var child=document.createElement(tag);
          this.appendChild(child);
          callLog.push('appended-child-in-adopted');
        }catch(e){
          callLog.push('append-err:'+e.constructor.name);
        }
      }
    };
    customElements.define(tag,ElClass);

    // Create elements in current doc
    var el1=document.createElement(tag);
    var sacrifice=document.createElement('div');
    sacrifice.className='sacrifice';
    var container=document.createElement('div');
    container.appendChild(el1);
    container.appendChild(sacrifice);
    document.body.appendChild(container);

    r.preAdoptConnected=connected;
    r.preAdoptDisconnected=disconnected;
    r.preAdoptAdopted=adopted;

    // Create a new document and adopt
    var doc2=document.implementation.createHTMLDocument('test');
    try{
      var adoptedEl=doc2.adoptNode(el1);
      r.adoptOK=true;
      r.adoptedOwner=(adoptedEl.ownerDocument===doc2);
    }catch(e){
      r.adoptErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }

    r.postAdoptConnected=connected;
    r.postAdoptDisconnected=disconnected;
    r.postAdoptAdopted=adopted;
    r.callLog=callLog.join('|');

    // Cleanup
    container.remove();
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== S3: ResizableArrayBuffer + TypedArray during valueOf ========
// Shrink a RAB during a valueOf callback to a TypedArray operation
function testS3(){
  var r={};
  try{
    // Check RAB support
    try{
      var testRab=new ArrayBuffer(256,{maxByteLength:1024});
      r.rabOK=(testRab.resizable===true);
      r.rabMaxLen=testRab.maxByteLength;
    }catch(e){
      r.rabErr=e.constructor.name;
      return r;
    }

    // Create a RAB and a view
    var rab=new ArrayBuffer(1024,{maxByteLength:4096});
    var ta=new Uint32Array(rab);
    for(var i=0;i<ta.length;i++) ta[i]=0xDEADBEEF;
    r.initialLen=ta.length;
    r.initialBufLen=rab.byteLength;

    // S3a: TypedArray.set() with valueOf that shrinks the RAB
    var shrinkCount=0;
    var src=new Array(128);
    for(var j=0;j<128;j++){
      src[j]={
        valueOf:function(){
          shrinkCount++;
          if(shrinkCount===64){
            try{
              rab.resize(32); // Shrink from 1024 to 32 bytes
            }catch(e){
              r.resizeErr=e.constructor.name;
            }
          }
          return 0x41414141;
        }
      };
    }
    try{
      ta.set(src);
      r.setOK=true;
    }catch(e){
      r.setErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.shrinkCount=shrinkCount;
    r.postShrinkBufLen=rab.byteLength;
    r.postShrinkTaLen=ta.length;

    // Check if any writes landed past the shrunk boundary
    var oobDetected=false;
    try{
      // Read past the new boundary via a new view
      var checkView=new Uint8Array(rab);
      r.checkViewLen=checkView.length;
      // Resize back up to see if data leaked past boundary
      rab.resize(1024);
      var bigView=new Uint32Array(rab);
      r.restoredLen=bigView.length;
      // Check if 0x41414141 exists past byte 32
      var oobWrites=0;
      for(var k=8;k<bigView.length;k++){
        if(bigView[k]===0x41414141) oobWrites++;
      }
      r.oobWrites=oobWrites;
      // Check if original DEADBEEF survived past shrink point
      var deadBeefs=0;
      for(var m=8;m<bigView.length;m++){
        if(bigView[m]===0xDEADBEEF) deadBeefs++;
      }
      r.deadBeefsAfterShrink=deadBeefs;
    }catch(e){
      r.postCheckErr=e.constructor.name;
    }

    // S3b: TypedArray.fill() with valueOf that shrinks
    var rab2=new ArrayBuffer(512,{maxByteLength:2048});
    var ta2=new Int32Array(rab2);
    var fillShrunk=false;
    var fillObj={valueOf:function(){
      if(!fillShrunk){
        fillShrunk=true;
        try{rab2.resize(16);}catch(e){r.fillResizeErr=e.constructor.name;}
      }
      return 0x42424242;
    }};
    try{
      ta2.fill(fillObj);
      r.fillOK=true;
    }catch(e){
      r.fillErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.fillBufLen=rab2.byteLength;
    r.fillTaLen=ta2.length;

    // S3c: TypedArray.copyWithin on RAB — shrink between src read and dst write?
    // copyWithin has no JS callbacks so this tests if C++ checks length mid-copy
    var rab3=new ArrayBuffer(256,{maxByteLength:1024});
    var ta3=new Uint32Array(rab3);
    for(var p=0;p<ta3.length;p++) ta3[p]=p;
    r.preCopy=ta3[60]; // should be 60
    // We can't shrink during copyWithin (no callback), but we can
    // check if the spec's length re-validation works
    rab3.resize(64); // shrink to 64 bytes = 16 Uint32s
    try{
      ta3.copyWithin(0,8,16); // should only work within 16 elements now
      r.copyOK=true;
      r.copyTaLen=ta3.length;
      r.copyResult0=ta3[0]; // should be 8
    }catch(e){
      r.copyErr=e.constructor.name;
    }
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== S4: TransformStream re-entrancy deep probe ========
// R4 showed iterator is called BEFORE type validation
// Can we do something useful in that window?
function testS4(){
  var r={};
  try{
    // The TransformStream constructor reads [Symbol.iterator] on the returned
    // array from createInternalTransformStreamFromTransformer
    // R4 showed: our injected objects ARE iterated, then type-checked
    // Q: What if our iterator modifies global state or other objects?

    var iterCalls=0;
    var gotThis=[];
    var sideEffects=[];

    // Test: Can we get the stream's internal writable/readable during construction?
    var capturedStream=null;
    var writableCaptured=null;
    var readableCaptured=null;

    // Patch Array.prototype[Symbol.iterator] to intercept
    var origIter=Array.prototype[Symbol.iterator];
    var interceptActive=false;

    Array.prototype[Symbol.iterator]=function(){
      if(!interceptActive) return origIter.call(this);
      iterCalls++;
      var arr=this;
      sideEffects.push('iter-called-len-'+arr.length);

      // Check what's in the array at this point
      for(var i=0;i<arr.length;i++){
        var item=arr[i];
        var t=typeof item;
        sideEffects.push('item-'+i+'-'+t);
        if(item&&typeof item==='object'){
          var keys=Object.getOwnPropertyNames(item).slice(0,5);
          sideEffects.push('keys-'+i+'-'+keys.join(','));
        }
      }

      return origIter.call(this);
    };

    interceptActive=true;
    try{
      var ts=new TransformStream({
        transform:function(chunk,controller){controller.enqueue(chunk);}
      });
      r.tsOK=true;
      capturedStream=ts;
    }catch(e){
      r.tsErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    interceptActive=false;
    Array.prototype[Symbol.iterator]=origIter;

    r.iterCalls=iterCalls;
    r.sideEffects=sideEffects.join('|');

    // Test: override Symbol.iterator on Object.prototype to catch non-array iterables
    var objIterCalls=0;
    var origObjIter=Object.prototype[Symbol.iterator];
    Object.prototype[Symbol.iterator]=function(){
      objIterCalls++;
      var self=this;
      var keys=Object.keys(self);
      var idx=0;
      return {next:function(){
        if(idx>=keys.length) return {done:true};
        return {done:false,value:self[keys[idx++]]};
      }};
    };
    try{
      var ts2=new TransformStream();
      r.ts2OK=true;
    }catch(e){
      r.ts2Err=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }
    if(origObjIter) Object.prototype[Symbol.iterator]=origObjIter;
    else delete Object.prototype[Symbol.iterator];
    r.objIterCalls=objIterCalls;

  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== S5: structuredClone with Proxy-wrapped transferable ========
// Does the serializer invoke Proxy traps on transfer-list items?
function testS5(){
  var r={};
  try{
    var trapLog=[];
    var buf=new ArrayBuffer(256);
    for(var i=0;i<256;i++) new Uint8Array(buf)[i]=i;

    // Wrap the ArrayBuffer in a Proxy
    var proxy=new Proxy(buf,{
      get:function(target,prop){
        trapLog.push('get:'+String(prop));
        return Reflect.get(target,prop);
      },
      getPrototypeOf:function(target){
        trapLog.push('getPrototypeOf');
        return Reflect.getPrototypeOf(target);
      },
      has:function(target,prop){
        trapLog.push('has:'+String(prop));
        return Reflect.has(target,prop);
      }
    });

    // Try structuredClone with Proxy in transfer list
    try{
      var result=structuredClone(proxy,{transfer:[proxy]});
      r.cloneOK=true;
      r.resultType=Object.prototype.toString.call(result);
      r.resultLen=result.byteLength;
      r.origLen=buf.byteLength;
      r.origDetached=(buf.byteLength===0);
    }catch(e){
      r.cloneErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.trapLog=trapLog.join('|');
    r.trapCount=trapLog.length;

    // Try transfer list as Proxy array
    var buf2=new ArrayBuffer(128);
    var listTraps=[];
    var proxyList=new Proxy([buf2],{
      get:function(target,prop){
        listTraps.push('list-get:'+String(prop));
        return Reflect.get(target,prop);
      },
      has:function(target,prop){
        listTraps.push('list-has:'+String(prop));
        return Reflect.has(target,prop);
      }
    });
    try{
      var result2=structuredClone(buf2,{transfer:proxyList});
      r.listCloneOK=true;
      r.buf2Detached=(buf2.byteLength===0);
    }catch(e){
      r.listCloneErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
    }
    r.listTraps=listTraps.join('|');
    r.listTrapCount=listTraps.length;

  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== S6: CSS .animate() element removal during animation ========
function testS6(){
  var r={};
  try{
    var el=document.createElement('div');
    el.style.cssText='width:100px;height:100px;background:red;position:absolute;';
    document.body.appendChild(el);

    if(typeof el.animate!=='function'){
      r.err='no animate API';
      el.remove();
      return r;
    }
    r.animateOK=true;

    var finishFired=false;
    var cancelFired=false;
    var removeFired=false;

    var anim=el.animate([
      {transform:'translateX(0px)'},
      {transform:'translateX(100px)'}
    ],{duration:50,fill:'forwards'});

    anim.onfinish=function(){
      finishFired=true;
      // Remove the element during finish callback
      try{
        el.remove();
        r.removeDuringFinish=true;
      }catch(e){
        r.removeErr=e.constructor.name;
      }
      // Try to start another animation on the removed element
      try{
        var anim2=el.animate([{opacity:1},{opacity:0}],{duration:10});
        r.animOnRemoved=true;
        r.anim2State=anim2.playState;
      }catch(e){
        r.animOnRemovedErr=e.constructor.name;
      }
    };

    anim.oncancel=function(){cancelFired=true;};
    anim.onremove=function(){removeFired=true;};

    // Wait for animation to finish
    return new Promise(function(resolve){
      setTimeout(function(){
        r.finishFired=finishFired;
        r.cancelFired=cancelFired;
        r.removeFired=removeFired;
        r.animState=anim.playState;
        r.elParent=(el.parentNode?el.parentNode.nodeName:'null');
        resolve(r);
      },200);
    });
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== S7: DOMParser script execution during parse ========
function testS7(){
  var r={};
  try{
    var parser=new DOMParser();

    // Does DOMParser execute inline scripts?
    var htmlWithScript='<html><body><div id="t1">before</div><script>document.getElementById("t1").textContent="executed";<\/script><div id="t2">after</div></body></html>';
    var doc=parser.parseFromString(htmlWithScript,'text/html');
    var t1=doc.getElementById('t1');
    r.scriptExec=(t1&&t1.textContent==='executed');
    r.t1Text=t1?t1.textContent:'null';

    // Does DOMParser execute event handlers?
    var htmlWithHandler='<html><body><img src="x" onerror="document.title=\'fired\'"></body></html>';
    var doc2=parser.parseFromString(htmlWithHandler,'text/html');
    r.handlerTitle=doc2.title;
    r.handlerExec=(doc2.title==='fired');

    // SVG with script
    var svgWithScript='<svg xmlns="http://www.w3.org/2000/svg"><script>var x=1;<\/script><rect width="10" height="10"/></svg>';
    try{
      var svgDoc=parser.parseFromString(svgWithScript,'image/svg+xml');
      r.svgParseOK=true;
      r.svgScriptTag=!!(svgDoc.querySelector('script'));
    }catch(e){
      r.svgErr=e.constructor.name;
    }

    // innerHTML on live document — does THIS execute?
    var container=document.createElement('div');
    document.body.appendChild(container);
    var executed=false;
    window.__p126_test=function(){executed=true;};
    container.innerHTML='<img src="x" onerror="window.__p126_test()">';
    // Wait briefly for error handler
    return new Promise(function(resolve){
      setTimeout(function(){
        r.innerHTMLExec=executed;
        container.remove();
        delete window.__p126_test;
        resolve(r);
      },100);
    });
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== S8: FontFace ArrayBuffer handling ========
function testS8(){
  var r={};
  try{
    if(typeof FontFace==='undefined'){r.err='no FontFace';return r;}
    r.fontFaceOK=true;

    // Create a minimal font-like ArrayBuffer (doesn't need to be valid font)
    var buf=new ArrayBuffer(1024);
    var view=new Uint8Array(buf);
    // Write minimal TrueType header
    view[0]=0;view[1]=1;view[2]=0;view[3]=0; // sfVersion
    r.bufLen=buf.byteLength;

    // Create FontFace with ArrayBuffer source
    try{
      var ff=new FontFace('TestFont',buf);
      r.ffCreated=true;
      r.ffStatus=ff.status;

      // Transfer the buffer after creating FontFace
      var clone=structuredClone(buf,{transfer:[buf]});
      r.bufDetached=(buf.byteLength===0);

      // Now try to load the font — does it use the now-detached buffer?
      ff.load().then(function(){
        r.loadOK=true;
      }).catch(function(e){
        r.loadErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
      });
    }catch(e){
      r.ffErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    // Test with ArrayBufferView source
    var buf2=new ArrayBuffer(512);
    try{
      var ff2=new FontFace('TestFont2',new Uint8Array(buf2));
      r.ff2Created=true;
      // Transfer underlying buffer
      structuredClone(buf2,{transfer:[buf2]});
      r.buf2Detached=(buf2.byteLength===0);
      ff2.load().catch(function(e){
        r.ff2LoadErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
      });
    }catch(e){
      r.ff2Err=e.constructor.name;
    }

    return new Promise(function(resolve){
      setTimeout(function(){resolve(r);},300);
    });
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== Run all tests sequentially ========
async function runAll(){
  var tests=[
    {name:'S1-CANVAS-DETACH',fn:testS1},
    {name:'S2-ADOPT-CE',fn:testS2},
    {name:'S3-RAB-SHRINK',fn:testS3},
    {name:'S4-TS-REENTRY',fn:testS4},
    {name:'S5-CLONE-PROXY',fn:testS5},
    {name:'S6-ANIM-REMOVE',fn:testS6},
    {name:'S7-DOMPARSER',fn:testS7},
    {name:'S8-FONTFACE',fn:testS8}
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
