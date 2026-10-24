// Inner script for XHTML iframe tests T3 and T5
// Sets window flags that parent can check
window.t3ok = true;
window.t5ok = true;
try { new Image().src = '/beacon/V413-INNER-JS-OK?t=' + Date.now(); } catch(e) {}
