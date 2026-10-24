// p183 — API surface enumeration for PS5 14.20
// Comprehensive check of which WebKit APIs are available
// to narrow down exploitable attack surfaces
// Beacon prefix: V183-

(function() {
  "use strict";

  var BASE = location.protocol + '//' + location.host;

  function syncB(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', BASE + '/beacon/V183-' + tag + '?t=' + Date.now(), false);
      x.send();
    } catch(e) {}
  }

  syncB('BOOT');

  // Test each API and report Y/N
  function test(name, fn) {
    var result;
    try {
      result = fn() ? 'Y' : 'N';
    } catch(e) {
      result = 'E';
    }
    syncB(name + '-' + result);
  }

  // === Media / DRM ===
  test('EME', function() { return typeof navigator.requestMediaKeySystemAccess === 'function'; });
  test('MediaSource', function() { return typeof MediaSource !== 'undefined'; });
  test('MediaStream', function() { return typeof MediaStream !== 'undefined'; });
  test('MediaRecorder', function() { return typeof MediaRecorder !== 'undefined'; });
  test('WebAudio', function() { return typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined'; });
  test('SpeechSynth', function() { return typeof speechSynthesis !== 'undefined'; });

  // === Graphics ===
  test('Canvas2D', function() { var c = document.createElement('canvas'); return !!c.getContext('2d'); });
  test('WebGL1', function() { var c = document.createElement('canvas'); return !!c.getContext('webgl'); });
  test('WebGL2', function() { var c = document.createElement('canvas'); return !!c.getContext('webgl2'); });
  test('OffscreenCanvas', function() { return typeof OffscreenCanvas !== 'undefined'; });
  test('ImageBitmap', function() { return typeof createImageBitmap === 'function'; });

  // === Font ===
  test('FontFace', function() { return typeof FontFace !== 'undefined'; });
  test('FontFaceSet', function() { return typeof document.fonts !== 'undefined'; });

  // === SVG ===
  test('SVGFilter', function() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    var filter = document.createElementNS(ns, 'filter');
    svg.appendChild(filter);
    return filter instanceof SVGFilterElement;
  });
  test('SVGAnim', function() { return typeof SVGAnimationElement !== 'undefined'; });

  // === Storage ===
  test('IndexedDB', function() { return typeof indexedDB !== 'undefined'; });
  test('localStorage', function() { return typeof localStorage !== 'undefined' && localStorage !== null; });
  test('CacheAPI', function() { return typeof caches !== 'undefined'; });

  // === Workers ===
  test('Worker', function() { return typeof Worker !== 'undefined'; });
  test('SharedWorker', function() { return typeof SharedWorker !== 'undefined'; });
  test('ServiceWorker', function() { return typeof navigator.serviceWorker !== 'undefined'; });

  // === Crypto ===
  test('SubtleCrypto', function() { return typeof crypto.subtle !== 'undefined'; });
  test('CryptoGetRandom', function() { return typeof crypto.getRandomValues === 'function'; });

  // === Network ===
  test('Fetch', function() { return typeof fetch === 'function'; });
  test('WebSocket', function() { return typeof WebSocket !== 'undefined'; });
  test('EventSource', function() { return typeof EventSource !== 'undefined'; });
  test('WebTransport', function() { return typeof WebTransport !== 'undefined'; });

  // === DOM APIs ===
  test('MutObs', function() { return typeof MutationObserver !== 'undefined'; });
  test('IntersectObs', function() { return typeof IntersectionObserver !== 'undefined'; });
  test('ResizeObs', function() { return typeof ResizeObserver !== 'undefined'; });
  test('CustomEl', function() { return typeof customElements !== 'undefined'; });
  test('ShadowDOM', function() { return typeof Element.prototype.attachShadow === 'function'; });
  test('Template', function() { return typeof HTMLTemplateElement !== 'undefined'; });
  test('Slot', function() { return typeof HTMLSlotElement !== 'undefined'; });
  test('Dialog', function() { return typeof HTMLDialogElement !== 'undefined'; });

  // === JS Runtime ===
  test('WASM', function() { return typeof WebAssembly !== 'undefined'; });
  test('SharedAB', function() { return typeof SharedArrayBuffer !== 'undefined'; });
  test('Atomics', function() { return typeof Atomics !== 'undefined'; });
  test('ResizableAB', function() { var ab = new ArrayBuffer(8, { maxByteLength: 16 }); return ab.resizable === true; });
  test('BigInt', function() { return typeof BigInt !== 'undefined'; });
  test('WeakRef', function() { return typeof WeakRef !== 'undefined'; });
  test('FinReg', function() { return typeof FinalizationRegistry !== 'undefined'; });
  test('Proxy', function() { return typeof Proxy !== 'undefined'; });
  test('Reflect', function() { return typeof Reflect !== 'undefined'; });
  test('Iterator', function() { return typeof Iterator !== 'undefined'; });
  test('AsyncIt', function() { return typeof Symbol.asyncIterator !== 'undefined'; });

  // === Streams ===
  test('ReadableStream', function() { return typeof ReadableStream !== 'undefined'; });
  test('WritableStream', function() { return typeof WritableStream !== 'undefined'; });
  test('TransformStream', function() { return typeof TransformStream !== 'undefined'; });

  // === Misc ===
  test('StructClone', function() { return typeof structuredClone === 'function'; });
  test('MsgChannel', function() { return typeof MessageChannel !== 'undefined'; });
  test('BroadcastCh', function() { return typeof BroadcastChannel !== 'undefined'; });
  test('Blob', function() { return typeof Blob !== 'undefined'; });
  test('File', function() { return typeof File !== 'undefined'; });
  test('FileReader', function() { return typeof FileReader !== 'undefined'; });
  test('URL', function() { return typeof URL !== 'undefined'; });
  test('URLPattern', function() { return typeof URLPattern !== 'undefined'; });
  test('AbortCtrl', function() { return typeof AbortController !== 'undefined'; });
  test('Perf', function() { return typeof performance !== 'undefined' && typeof performance.now === 'function'; });
  test('PerfObs', function() { return typeof PerformanceObserver !== 'undefined'; });
  test('Navigation', function() { return typeof navigation !== 'undefined'; });
  test('Clipboard', function() { return typeof navigator.clipboard !== 'undefined'; });
  test('Notif', function() { return typeof Notification !== 'undefined'; });
  test('Gamepad', function() { return typeof navigator.getGamepads === 'function'; });

  // === Image decoding ===
  test('ImageDecoder', function() { return typeof ImageDecoder !== 'undefined'; });
  test('WebP', function() {
    var c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  });
  test('AVIF', function() {
    var c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    return c.toDataURL('image/avif').indexOf('data:image/avif') === 0;
  });

  // === CSS APIs ===
  test('CSSHighlights', function() { return typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined'; });
  test('CSSTypedOM', function() { return typeof CSSStyleValue !== 'undefined'; });
  test('Houdini', function() { return typeof CSS !== 'undefined' && typeof CSS.paintWorklet !== 'undefined'; });
  test('ContainerQ', function() { return typeof CSSContainerRule !== 'undefined'; });
  test('CSSNesting', function() {
    try { document.querySelector('& div'); return true; } catch(e) { return false; }
  });

  syncB('COMPLETE');
})();
