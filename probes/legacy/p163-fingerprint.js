// p163 — PS5 WebView deep fingerprint
// Extract everything the browser exposes about the console
// No heap grooming, no overflow — pure recon
// Beacon prefix: V163-

(function() {
  var BASE = location.protocol + '//' + location.host;
  function B(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V163-' + encodeURIComponent(tag) + '?t=' + Date.now(), true);
      x.send();
    } catch(e) {}
  }

  B('BOOT');

  // ── NAVIGATOR PROPERTIES ──
  try { B('UA=' + navigator.userAgent); } catch(e) { B('UA-ERR'); }
  try { B('PLATFORM=' + navigator.platform); } catch(e) { B('PLATFORM-ERR'); }
  try { B('VENDOR=' + navigator.vendor); } catch(e) { B('VENDOR-ERR'); }
  try { B('PRODUCT=' + navigator.product); } catch(e) { B('PRODUCT-ERR'); }
  try { B('APPNAME=' + navigator.appName); } catch(e) { B('APPNAME-ERR'); }
  try { B('APPVER=' + navigator.appVersion); } catch(e) { B('APPVER-ERR'); }
  try { B('OSCPU=' + navigator.oscpu); } catch(e) { B('OSCPU-ERR'); }
  try { B('LANG=' + navigator.language); } catch(e) { B('LANG-ERR'); }
  try { B('LANGS=' + (navigator.languages || []).join(',')); } catch(e) { B('LANGS-ERR'); }
  try { B('CORES=' + navigator.hardwareConcurrency); } catch(e) { B('CORES-ERR'); }
  try { B('DEVMEM=' + navigator.deviceMemory); } catch(e) { B('DEVMEM-ERR'); }
  try { B('TOUCH=' + navigator.maxTouchPoints); } catch(e) { B('TOUCH-ERR'); }
  try { B('COOKIEENABLED=' + navigator.cookieEnabled); } catch(e) {}
  try { B('ONLINE=' + navigator.onLine); } catch(e) {}
  try { B('JAVAENABLED=' + navigator.javaEnabled()); } catch(e) { B('JAVA-ERR'); }
  try { B('PDFVIEWER=' + navigator.pdfViewerEnabled); } catch(e) {}
  try { B('BUILDID=' + navigator.buildID); } catch(e) { B('BUILDID-ERR'); }

  // ── SCREEN INFO ──
  try { B('SCREEN=' + screen.width + 'x' + screen.height); } catch(e) {}
  try { B('AVAIL=' + screen.availWidth + 'x' + screen.availHeight); } catch(e) {}
  try { B('DEPTH=' + screen.colorDepth + '-' + screen.pixelDepth); } catch(e) {}
  try { B('DPR=' + window.devicePixelRatio); } catch(e) {}
  try { B('INNERSIZE=' + window.innerWidth + 'x' + window.innerHeight); } catch(e) {}
  try { B('OUTERSIZE=' + window.outerWidth + 'x' + window.outerHeight); } catch(e) {}

  // ── PERFORMANCE / TIMING ──
  try {
    var t1 = performance.now();
    var t2 = performance.now();
    var t3 = performance.now();
    B('PERFNOW-res=' + (t2 - t1) + '-' + (t3 - t2));
  } catch(e) { B('PERFNOW-ERR'); }
  try {
    if (performance.memory) {
      B('HEAPLIMIT=' + performance.memory.jsHeapSizeLimit);
      B('HEAPUSED=' + performance.memory.usedJSHeapSize);
      B('HEAPTOTAL=' + performance.memory.totalJSHeapSize);
    } else {
      B('HEAPINFO=none');
    }
  } catch(e) { B('HEAP-ERR'); }
  try { B('TIMEORIGIN=' + performance.timeOrigin); } catch(e) {}

  // ── API AVAILABILITY ──
  var apis = {
    'WASM': typeof WebAssembly,
    'SAB': typeof SharedArrayBuffer,
    'WORKER': typeof Worker,
    'SW': typeof navigator.serviceWorker,
    'IDB': typeof indexedDB,
    'WS': typeof WebSocket,
    'FETCH': typeof fetch,
    'CRYPTO': typeof crypto,
    'SUBTLE': typeof (crypto && crypto.subtle),
    'CANVAS': typeof HTMLCanvasElement,
    'WEBGL': (function() {
      try {
        var c = document.createElement('canvas');
        return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
      } catch(e) { return false; }
    })(),
    'WEBGL2': (function() {
      try { return !!document.createElement('canvas').getContext('webgl2'); }
      catch(e) { return false; }
    })(),
    'OFFSCREEN': typeof OffscreenCanvas,
    'WEBAUDIO': typeof (window.AudioContext || window.webkitAudioContext),
    'MEDIA': typeof navigator.mediaDevices,
    'GAMEPAD': typeof navigator.getGamepads,
    'VIBRATE': typeof navigator.vibrate,
    'BATT': typeof navigator.getBattery,
    'STREAM': typeof ReadableStream,
    'RESIZABLEBUF': (function() {
      try { new ArrayBuffer(8, { maxByteLength: 16 }); return true; }
      catch(e) { return false; }
    })(),
    'WEAKREF': typeof WeakRef,
    'FINREG': typeof FinalizationRegistry,
    'PROXY': typeof Proxy,
    'BIGINT': typeof BigInt,
    'INTL': typeof Intl,
    'STRUCTCLONE': typeof structuredClone,
    'MSGCHAN': typeof MessageChannel,
    'BLOB': typeof Blob,
    'URLOBJ': typeof URL,
    'TEXTENCODE': typeof TextEncoder,
    'TEXTDECODE': typeof TextDecoder
  };
  var apiStr = '';
  for (var k in apis) {
    if (apis.hasOwnProperty(k)) {
      var v = apis[k];
      if (v === true || v === 'function' || v === 'object') apiStr += k + '+,';
      else apiStr += k + '-,';
    }
  }
  B('APIS-A=' + apiStr.substring(0, 200));
  if (apiStr.length > 200) B('APIS-B=' + apiStr.substring(200, 400));

  // ── WEBGL RENDERER (GPU INFO) ──
  try {
    var c = document.createElement('canvas');
    var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        B('GLVENDOR=' + gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
        B('GLRENDER=' + gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      }
      B('GLVER=' + gl.getParameter(gl.VERSION));
      B('GLSLVER=' + gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
      B('GLMAX-TEX=' + gl.getParameter(gl.MAX_TEXTURE_SIZE));
    } else {
      B('GL=none');
    }
  } catch(e) { B('GL-ERR=' + e.message.substring(0, 40)); }

  // ── CSS / MEDIA QUERIES (OS hints) ──
  var mqs = [
    ['prefers-color-scheme: dark', 'DARKMODE'],
    ['prefers-reduced-motion: reduce', 'REDUCEMOTION'],
    ['display-mode: fullscreen', 'FULLSCREEN'],
    ['display-mode: standalone', 'STANDALONE'],
    ['pointer: fine', 'POINTER-FINE'],
    ['pointer: coarse', 'POINTER-COARSE'],
    ['hover: hover', 'HOVER-YES'],
    ['hover: none', 'HOVER-NO'],
    ['any-pointer: fine', 'ANYPTR-FINE'],
    ['any-pointer: coarse', 'ANYPTR-COARSE']
  ];
  var mqStr = '';
  for (var i = 0; i < mqs.length; i++) {
    try {
      var match = window.matchMedia('(' + mqs[i][0] + ')').matches;
      mqStr += mqs[i][1] + '=' + (match ? '1' : '0') + ',';
    } catch(e) {}
  }
  B('MQ=' + mqStr);

  // ── DATE/TIMEZONE ──
  try { B('TZ=' + Intl.DateTimeFormat().resolvedOptions().timeZone); } catch(e) {}
  try { B('TZOFF=' + new Date().getTimezoneOffset()); } catch(e) {}
  try { B('LOCALE=' + Intl.DateTimeFormat().resolvedOptions().locale); } catch(e) {}

  // ── MEMORY DETECTION: page size inference ──
  try {
    var sizes = [4096, 8192, 16384, 32768, 65536];
    var alignResults = '';
    for (var i = 0; i < sizes.length; i++) {
      var bufs = [];
      for (var j = 0; j < 10; j++) bufs.push(new ArrayBuffer(sizes[i]));
      alignResults += sizes[i] + ':ok,';
    }
    B('ABSIZES=' + alignResults);
  } catch(e) { B('ABSIZES-ERR'); }

  // ── ArrayBuffer max size test ──
  try {
    var maxAB = 0;
    var testSizes = [1<<20, 1<<22, 1<<24, 1<<26, 1<<28, 1<<29, 1<<30];
    for (var i = 0; i < testSizes.length; i++) {
      try {
        var ab = new ArrayBuffer(testSizes[i]);
        if (ab.byteLength === testSizes[i]) maxAB = testSizes[i];
        ab = null;
      } catch(e) { break; }
    }
    B('MAXAB=' + maxAB);
  } catch(e) { B('MAXAB-ERR'); }

  // ── ERROR TYPES (engine fingerprint) ──
  try { eval('let x = class {}'); B('CLASS=ok'); } catch(e) { B('CLASS-ERR'); }
  try { eval('async function f(){}'); B('ASYNC=ok'); } catch(e) { B('ASYNC-ERR'); }
  try { eval('function* g(){}'); B('GENERATOR=ok'); } catch(e) { B('GENERATOR-ERR'); }
  try { eval('for(let x of [1]){}'); B('FOROF=ok'); } catch(e) { B('FOROF-ERR'); }
  try { eval('let [...a] = [1,2,3]'); B('DESTRUCT=ok'); } catch(e) { B('DESTRUCT-ERR'); }
  try { eval('let t = `hi`'); B('TEMPLATE=ok'); } catch(e) { B('TEMPLATE-ERR'); }
  try { eval('let a = x => x'); B('ARROW=ok'); } catch(e) { B('ARROW-ERR'); }
  try { eval('let {a, ...b} = {a:1,b:2,c:3}'); B('OBJSPREAD=ok'); } catch(e) { B('OBJSPREAD-ERR'); }
  try { eval('let x = 0n'); B('BIGINTLIT=ok'); } catch(e) { B('BIGINTLIT-ERR'); }
  try { eval('globalThis'); B('GLOBALTHIS=ok'); } catch(e) { B('GLOBALTHIS-ERR'); }
  try { eval('let x = a?.b'); B('OPTCHAIN=ok'); } catch(e) { B('OPTCHAIN-ERR'); }
  try { eval('let x = a ?? b'); B('NULLCOAL=ok'); } catch(e) { B('NULLCOAL-ERR'); }
  try { eval('let x = import.meta'); B('IMPORTMETA=ok'); } catch(e) { B('IMPORTMETA-ERR=' + e.message.substring(0, 30)); }

  // ── DOCUMENT / LOCATION INFO ──
  try { B('HREF=' + location.href); } catch(e) {}
  try { B('PROTO=' + location.protocol); } catch(e) {}
  try { B('HOST=' + location.host); } catch(e) {}
  try { B('DOCTYPE=' + document.doctype); } catch(e) {}
  try { B('COMPAT=' + document.compatMode); } catch(e) {}
  try { B('CHARSET=' + document.characterSet); } catch(e) {}

  // ── PLUGIN/MIMETYPE ENUMERATION ──
  try {
    var plugs = '';
    for (var i = 0; i < Math.min(navigator.plugins.length, 10); i++) {
      plugs += navigator.plugins[i].name + ',';
    }
    B('PLUGINS=' + (plugs || 'none'));
  } catch(e) { B('PLUGINS-ERR'); }
  try {
    var mimes = '';
    for (var i = 0; i < Math.min(navigator.mimeTypes.length, 10); i++) {
      mimes += navigator.mimeTypes[i].type + ',';
    }
    B('MIMETYPES=' + (mimes || 'none'));
  } catch(e) { B('MIMETYPES-ERR'); }

  B('DONE');
})();
