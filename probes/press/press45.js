/* press-45 EXTERNO — GATE CFF: ¿existe el driver CFF en face-init de esta build? Sin row letal. */
(function(){
"use strict";
if(window.__p45)return; window.__p45=1;
var RID="v45x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,500)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V45-HB","hb");},2000);
var dr="-",rt="-";
try{dr=typeof window.deriveRuntime;rt=(dr==="object"&&window.deriveRuntime)?typeof window.deriveRuntime.run:"-";}catch(e){}
bk("V45-L","press45-EXT gate-CFF; dr="+dr+"; rt="+rt);
function Trnd(){return Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36);}
var done={};
function doLoad(id,f,label){
  if(done[id])return;done[id]=1;
  bk("V45-E"+id,"enter-load "+id+" ("+f+") "+label);
  try{
    var ff=new FontFace("v45-"+id,"url(/document/al/ps5/"+f+"?t="+Trnd()+")");
    document.fonts.add(ff);
    ff.load().then(function(){bk("V45-R"+id,id+" load=OK status="+ff.status);},
                    function(err){bk("V45-R"+id,id+" rechaza:"+String((err&&err.name)+" "+((err&&err.message)||"")).slice(0,70));});
  }catch(e){bk("V45-R"+id,id+" E:"+String((e&&e.message)||e).slice(0,50));}
}
/* 0: PUERTA — OTTO+CFF Top DICT + CharStrings INDEX + Private DICT, maxp v0.5 */
setTimeout(function(){doLoad("g0","f21.ttf","GATE CFF maxp0.5");},300);
/* 1: variante maxp v1.0 */
setTimeout(function(){doLoad("g1","f20.ttf","CFF maxp1.0");},1300);
/* 2-4: mapa fatal-si-falta: hhea / hmtx / head */
setTimeout(function(){doLoad("g2","f21a.ttf","CFF no-hhea");},2300);
setTimeout(function(){doLoad("g3","f21b.ttf","CFF no-hmtx");},3300);
setTimeout(function(){doLoad("g4","f21c.ttf","CFF no-head");},4300);
/* 5-6: censo de clamps en opcionales (SVG/COLR lies) */
setTimeout(function(){doLoad("o5","f22.ttf","TTF+svg lie");},5300);
setTimeout(function(){doLoad("o6","f23.ttf","TTF+colr v1 lie");},6300);
setTimeout(function(){bk("V45-Z","fin-filas");},7600);
setTimeout(function(){clearInterval(HB);bk("V45-Z2","late-z");},12000);
})();
