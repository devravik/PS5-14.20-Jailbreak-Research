/* press-47 EXTERNO — layout determinístico Sol round-6: control/charset/encoding/bbox/matrix-sent-last.
   Discriminador: filas 4-5 ref-ACCEPT upstream; si el device rechaza -> capa-CFF-wrapper confirmada. */
(function(){
"use strict";
if(window.__p47)return; window.__p47=1;
var RID="v47x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,400)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V47-HB","hb");},2000);
bk("V47-L","press47-EXT Sol-layout; ctrl->charset->encoding->bbox->matrix");
function Trnd(){return Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36);}
var done={};
function doLoad(id,f,label){
  if(done[id])return;done[id]=1;
  bk("V47-E"+id,"enter-load "+id+" ("+f+") "+label);
  try{
    var ff=new FontFace("v47-"+id,"url(/document/al/ps5/"+f+"?t="+Trnd()+")");
    document.fonts.add(ff);
    ff.load().then(function(){bk("V47-R"+id,id+" load=OK status="+ff.status);},
                    function(err){bk("V47-R"+id,id+" rechaza:"+String((err&&err.name)+" "+((err&&err.message)||"")).slice(0,70));});
  }catch(e){bk("V47-R"+id,id+" E:"+String((e&&e.message)||e).slice(0,50));}
}
setTimeout(function(){doLoad("r1","p47-01-control.otf","P47-01 CFF control");},300);
setTimeout(function(){doLoad("r2","p47-02-charset.otf","P47-02 charset offset 0x2000");},1300);
setTimeout(function(){doLoad("r3","p47-03-encoding.otf","P47-03 Encoding offset 0x2000");},2300);
setTimeout(function(){doLoad("r4","p47-04-bbox.otf","P47-04 FontBBox reserved-real nibble D");},3300);
setTimeout(function(){bk("V47-Z","pre-sent-last");},4300);
setTimeout(function(){doLoad("r5","p47-05-matrix.otf","P47-05 FontMatrix long-mantissa sent-last");},4800);  /* sent-last */
setTimeout(function(){clearInterval(HB);bk("V47-Z2","late-z");},10000);
})();
