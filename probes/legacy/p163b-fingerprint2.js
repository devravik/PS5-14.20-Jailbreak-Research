// p163b — PS5 WebView fingerprint part 2
// Catches what p163 dropped: JS features, max AB size, plugins, doc info
// Staggers sends to avoid connection throttling
// Beacon prefix: V163B-

(function() {
  var BASE = location.protocol + '//' + location.host;
  var queue = [];

  function B(tag) {
    queue.push(tag);
  }

  function flush() {
    if (queue.length === 0) return;
    var tag = queue.shift();
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V163B-' + encodeURIComponent(tag) + '?t=' + Date.now(), true);
      x.onloadend = function() { setTimeout(flush, 50); };
      x.send();
    } catch(e) { setTimeout(flush, 50); }
  }

  B('BOOT');

  // ── JS SYNTAX FEATURES ──
  var feats = '';
  function test(name, code) {
    try { eval(code); feats += name + '+,'; }
    catch(e) { feats += name + '-,'; }
  }
  test('CLASS', 'class X{}');
  test('ASYNC', 'async function f(){}');
  test('GENERATOR', 'function* g(){ yield 1; }');
  test('FOROF', 'for(let x of [1]){}');
  test('DESTRUCT', 'let [a,...b] = [1,2,3]');
  test('TEMPLATE', 'let t = `hi`');
  test('ARROW', 'let a = x => x');
  test('OBJSPREAD', 'let {a, ...b} = {a:1,b:2,c:3}');
  test('BIGINTLIT', 'let x = 0n');
  test('GLOBALTHIS', 'globalThis');
  test('OPTCHAIN', 'let o={}; o?.x');
  test('NULLCOAL', 'let o=null; o ?? 1');
  test('PRIVFIELD', 'class C { #x = 1; }');
  test('TOPAWAIT', 'void 0');
  test('LOGICASSIGN', 'let a=1; a &&= 2');
  test('STATICBLOCK', 'class C { static {} }');
  test('ARRAYAT', '[1].at(0)');
  test('STRUCTCLONE', 'structuredClone(1)');
  test('HASOWN', 'Object.hasOwn({a:1},"a")');
  test('FINDLAST', '[1,2].findLast(x=>x)');
  test('CAUSE', 'new Error("x",{cause:"y"})');
  test('REGEXP_D', '/a/d');
  B('JSFEATS-A=' + feats.substring(0, 200));
  if (feats.length > 200) B('JSFEATS-B=' + feats.substring(200));

  // ── MAX ARRAYBUFFER SIZE ──
  var maxAB = 0;
  var testSizes = [
    1048576, 4194304, 16777216, 67108864,
    134217728, 268435456, 536870912, 1073741824
  ];
  for (var i = 0; i < testSizes.length; i++) {
    try {
      var ab = new ArrayBuffer(testSizes[i]);
      if (ab.byteLength === testSizes[i]) maxAB = testSizes[i];
      ab = null;
    } catch(e) { break; }
  }
  B('MAXAB=' + maxAB + '-' + (maxAB / 1048576) + 'MB');

  // ── TYPED ARRAY VARIANTS ──
  var types = '';
  try { new Int8Array(1); types += 'I8+,'; } catch(e) { types += 'I8-,'; }
  try { new Uint8ClampedArray(1); types += 'U8C+,'; } catch(e) { types += 'U8C-,'; }
  try { new Int16Array(1); types += 'I16+,'; } catch(e) { types += 'I16-,'; }
  try { new Float32Array(1); types += 'F32+,'; } catch(e) { types += 'F32-,'; }
  try { new Float64Array(1); types += 'F64+,'; } catch(e) { types += 'F64-,'; }
  try { new BigInt64Array(1); types += 'BI64+,'; } catch(e) { types += 'BI64-,'; }
  try { new BigUint64Array(1); types += 'BU64+,'; } catch(e) { types += 'BU64-,'; }
  try { new DataView(new ArrayBuffer(8)); types += 'DV+,'; } catch(e) { types += 'DV-,'; }
  B('TYPED=' + types);

  // ── DOCUMENT INFO ──
  try { B('HREF=' + location.href); } catch(e) {}
  try { B('PROTO=' + location.protocol); } catch(e) {}
  try { B('HOST=' + location.host); } catch(e) {}
  try { B('COMPAT=' + document.compatMode); } catch(e) {}
  try { B('CHARSET=' + document.characterSet); } catch(e) {}
  try { B('TITLE=' + document.title); } catch(e) {}
  try { B('HIDDEN=' + document.hidden); } catch(e) {}
  try { B('VSTATE=' + document.visibilityState); } catch(e) {}

  // ── PLUGINS + MIMETYPES ──
  try {
    var plugs = '';
    for (var i = 0; i < Math.min(navigator.plugins.length, 10); i++)
      plugs += navigator.plugins[i].name + ',';
    B('PLUGINS=' + (plugs || 'none'));
  } catch(e) { B('PLUGINS-ERR'); }
  try {
    var mimes = '';
    for (var i = 0; i < Math.min(navigator.mimeTypes.length, 10); i++)
      mimes += navigator.mimeTypes[i].type + ',';
    B('MIMES=' + (mimes || 'none'));
  } catch(e) { B('MIMES-ERR'); }

  // ── STORAGE APIS ──
  var storage = '';
  try { localStorage.setItem('_t', '1'); localStorage.removeItem('_t'); storage += 'LS+,'; }
  catch(e) { storage += 'LS-,'; }
  try { sessionStorage.setItem('_t', '1'); sessionStorage.removeItem('_t'); storage += 'SS+,'; }
  catch(e) { storage += 'SS-,'; }
  try { if (window.caches) storage += 'CACHE+,'; else storage += 'CACHE-,'; }
  catch(e) { storage += 'CACHE-,'; }
  B('STORAGE=' + storage);

  // ── SECURITY FEATURES ──
  try { B('CSP=' + (document.securityPolicy ? 'yes' : 'no')); } catch(e) {}
  try {
    var c = document.createElement('canvas');
    var ctx = c.getContext('2d');
    ctx.fillText('test', 0, 10);
    c.toDataURL();
    B('CANVAS-TAINT=clean');
  } catch(e) { B('CANVAS-TAINT=dirty'); }

  // ── ERROR OBJECT DETAILS ──
  try {
    try { null.x; } catch(e) {
      B('ERRSTACK=' + (typeof e.stack !== 'undefined' ? 'yes' : 'no'));
      if (e.stack) {
        var lines = e.stack.split('\n');
        B('STACKLINES=' + lines.length);
        B('STACK0=' + (lines[0] || '').substring(0, 80));
      }
    }
  } catch(e) {}

  // ── TIMING CHANNELS ──
  try {
    var entries = performance.getEntriesByType('resource');
    B('RESTIMING=' + entries.length + '-entries');
  } catch(e) { B('RESTIMING-ERR'); }
  try {
    var navEntry = performance.getEntriesByType('navigation');
    B('NAVTIMING=' + (navEntry.length > 0 ? 'yes' : 'no'));
  } catch(e) { B('NAVTIMING-ERR'); }

  // ── CONCURRENCY TEST ──
  try {
    if (typeof Atomics !== 'undefined') B('ATOMICS=yes');
    else B('ATOMICS=no');
  } catch(e) { B('ATOMICS-ERR'); }

  B('DONE');

  // Start flushing with 50ms gaps
  flush();
})();
