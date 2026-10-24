/* p53-worker — dedicated worker: LS-probe + heartbeat + echo lens */
(function(){
"active";
var alive=true;
function post(t,b){try{postMessage({t:String(t).slice(0,40),b:String(b).slice(0,180)});}catch(e){}}
try{
  var has=typeof localStorage;var w=null;
  try{w=localStorage.getItem("p53-worker-ls-probe")==null?"empty":"pre";}
  catch(e){w="EXC:"+String((e&&e.name)||e).slice(0,40);}
  post("wls","worker-localStorage="+has+" state="+w);
}catch(e){post("wls","wprobe-FAIL "+e);}
var n=0;
setInterval(function(){
  n++;post("hbx","beat"+n);
},500);
onmessage=function(ev){
  try{
    var d=ev&&ev.data||{};
    post("mecho","m:"+(d&&d.echo?d.echo:"-"));
  }catch(e){post("mecho","m-FAIL");}
};
post("wboot","worker-boot ts");
})();
