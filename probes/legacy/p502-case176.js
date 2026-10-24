// p502 — case 176 / BZ 272488 (RenderBlockFlow floating-object rebuild).
// Exact upstream test:
// fast/block/crash-when-style-and-renderer-invalidated-for-floating-object-element.html
// Pre-fix WK-1400 has RendererToFloatInfoMap + markLinesDirtyInBlockRange
// (commit 7edad1b0d5e5 removes them); dangling float/line state across the
// writing-mode/display class flip.
// Variants (p502var):
//   0 exact upstream mutations
//   1 no inner.scrollLeft before the class removals
//   2 extra layout (container.offsetWidth) before the removals
//   3 repeat the class flip + layout 6 times
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','BUILT','TRIGGER','POST','DONE','ERR','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V502-' + n);
      staged.push([n, x]);
    });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now() - T0) + 'ms] ' + (body || '')); return; }
    } catch (e) {}
  }

  var VARIANTS = ['exact', 'noscroll', 'extralayout', 'loop'];
  var vi = 0;
  try {
    vi = parseInt(localStorage.getItem('p502var') || '0', 10);
    if (isNaN(vi) || vi < 0) vi = 0;
    if (vi >= VARIANTS.length) vi = 0;
    localStorage.setItem('p502var', String((vi + 1) % VARIANTS.length));
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

  S('TRIGGER', 'mutations');
  try {
    if (variant === 'exact' || variant === 'extralayout' || variant === 'loop') {
      inner.append(div.cloneNode());
      if (variant !== 'extralayout' && variant !== 'loop') inner.scrollLeft;
      if (variant === 'extralayout' || variant === 'loop') container.offsetWidth;
      outer.classList.remove('flow');
      container.classList.remove('vrl');
      if (variant === 'extralayout') container.offsetWidth;
      if (variant === 'loop') {
        for (var i = 0; i < 6; i++) {
          outer.classList.toggle('flow');
          container.classList.toggle('vrl');
          inner.scrollLeft;
          container.offsetWidth;
        }
      }
    } else {
      inner.append(div.cloneNode());
      outer.classList.remove('flow');
      container.classList.remove('vrl');
      container.offsetWidth;
    }
  } catch (e) {
    S('ERR', String(e && e.message).substring(0, 70));
    return;
  }

  requestAnimationFrame(function () {
    S('POST', 'survived-frame');
    S('DONE', '');
  });
})();
